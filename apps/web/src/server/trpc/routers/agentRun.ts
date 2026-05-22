import { z } from "zod";
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  AgentRunStatus,
  CredentialRequestStatus,
  Prisma,
} from "@prisma/client";

import { createRouter, protectedProcedure } from "../trpc";
import {
  assertAssessmentAccess,
  assertCanMutateAssessment,
} from "@/server/authz";
import { PLANS } from "@/server/services/agent";
import { putAgentCredential } from "@/server/services/agent/credentials";
import { enqueueAgentHarness } from "@/server/queue/queue";
import { log } from "@/server/lib/logger";
import {
  WORKFLOW_STEP_SPECS,
  applyDependencies,
  combineExplicitAndSoftStatus,
  loadStatusSnapshot,
  type WorkflowPlan,
  type WorkflowStepStatus,
} from "@/server/services/agent/workflow";
import { planWorkflow } from "@/server/services/agent/workflow-planner";
import { WorkflowStepExplicitStatus } from "@prisma/client";
import {
  isKnownCredentialScope,
  getCredentialScope,
} from "@/server/services/agent/credential-scopes";
import { isAgentEnabled } from "@/server/services/agent/feature-flag";

/**
 * tRPC surface for the agent harness — ADR-0014.
 *
 * Endpoints:
 *   - `draft` — create a PROPOSED `AgentRun` for an assessment with a
 *     static task list (v1 has no LLM planner; the user / a higher-
 *     level orchestrator passes the tool sequence in).
 *   - `start` — flip a PROPOSED run to APPROVED and dispatch the
 *     harness in-process (synchronous; the run pauses on the first
 *     missing credential, so the call returns quickly).
 *   - `getByAssessment` — list runs for an assessment.
 *   - `get` — single run with steps + tool calls + pending credential
 *     requests; powers the run timeline UI.
 *   - `pendingCredentials` — open `AgentCredentialRequest` rows for an
 *     assessment, used by the credential modal poll.
 *   - `submitCredential` — encrypt + store a PAT, mark the request
 *     FULFILLED, resume the run.
 *   - `cancel` — cooperative cancel; transitions any non-terminal run
 *     to CANCELLED.
 *
 * Feature flag: every procedure first reads `isAgentEnabled` and throws
 * NOT_FOUND when off. The flag is admin-toggled at
 * `/admin/settings?tab=ai-router`.
 */

// Two draft shapes share one router endpoint. Static tasks let the
// caller pre-bake a sequence (used by the v1 "Probe a file" form);
// goal-only drafts hand control to the LLM planner. Both flow through
// the same `runAgent` loop — the harness keys off the envelope shape.
const taskStep = z.object({
  tool: z.string().min(1).max(120),
  args: z.unknown().optional(),
});

// Repository the planner is allowed to look at. Required for planner-
// driven runs because, without it, the planner has nothing concrete to
// query and falls back to guessing — which produces 404s and a stop
// signal with no useful evidence (the symptom that prompted this).
const repositoryRef = z.object({
  owner: z.string().trim().min(1).max(80),
  repo: z.string().trim().min(1).max(120),
  ref: z.string().trim().min(1).max(255).optional(),
});

/**
 * Three accepted shapes:
 *   - `task: [...]`                    — static tool-call sequence ("Probe a file")
 *   - `goal + repository`              — autonomous tool-call planner (existing
 *                                        "Inspect repository")
 *   - `mode: "workflow" + goal +
 *      repositories?: [...]`           — NEW workflow planner: emits a graph
 *                                        of human-driven steps that the
 *                                        assessment surface renders as an
 *                                        interactive React-Flow diagram.
 */
const draftInput = z
  .object({
    assessmentId: z.string().cuid(),
    planName: z
      .enum([PLANS.GITHUB_EVIDENCE])
      .default(PLANS.GITHUB_EVIDENCE),
    task: z.array(taskStep).min(1).max(50).optional(),
    // Trim + non-empty; we used to enforce a 10-char floor but the
    // count-towards-the-limit hint felt policing, and the agent
    // handles short goals fine (it just retrieves broadly).
    goal: z.string().trim().min(1).max(2000).optional(),
    /** Tool-call planner: required pinned target. */
    repository: repositoryRef.optional(),
    /** Workflow planner: optional initial repo set; user can add more in CONNECT_REPOSITORY. */
    repositories: z.array(repositoryRef).max(20).optional(),
    /** Defaults to autonomous tool-call planner when goal is set. */
    mode: z.enum(["tool", "workflow"]).optional(),
  })
  .refine(
    (v) => Boolean(v.task) !== Boolean(v.goal),
    {
      message:
        "Provide exactly one of `task` (static) or `goal` (planner-driven).",
    },
  )
  .refine(
    (v) => !v.goal || v.mode === "workflow" || v.repository,
    {
      message:
        "Tool-call planner runs require a `repository`. (Set `mode: \"workflow\"` if you want the workflow planner instead.)",
      path: ["repository"],
    },
  );

const submitCredentialInput = z.object({
  requestId: z.string().cuid(),
  secret: z.string().trim().min(10).max(2048),
  /** Optional non-secret hints — e.g. `{ org: "acme" }`. Never the PAT. */
  metadata: z.record(z.unknown()).optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────

async function requireFlagOr404(
  db: Parameters<typeof isAgentEnabled>[0],
): Promise<void> {
  if (!(await isAgentEnabled(db))) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Agent harness is disabled",
    });
  }
}

function defaultBudget() {
  return {
    maxSteps: 32,
    maxTokens: 200_000,
    maxToolCalls: 50,
    maxDurationMs: 5 * 60_000,
    maxSandboxSeconds: 0,
    maxEvidenceRows: 200,
  };
}

// ─── Router ─────────────────────────────────────────────────────────

export const agentRunRouter = createRouter({
  draft: protectedProcedure
    .input(draftInput)
    .mutation(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const { engagementId } = await assertCanMutateAssessment(
        ctx.db,
        ctx.session,
        input.assessmentId,
      );

      // Three-way envelope:
      //   - static task list
      //   - workflow planner (mode: "workflow")
      //   - tool-call planner (default when goal+repository are set)
      const envelope = input.task
        ? { task: input.task }
        : input.mode === "workflow"
          ? {
              mode: "workflow" as const,
              goal: input.goal,
              repositories: input.repositories ?? [],
            }
          : { goal: input.goal, repository: input.repository };
      const taskJson = JSON.stringify(envelope);
      const sha = createHash("sha256").update(taskJson).digest("hex");
      const run = await ctx.db.agentRun.create({
        data: {
          assessmentId: input.assessmentId,
          engagementId,
          planName: input.planName,
          status: AgentRunStatus.PROPOSED,
          budget: defaultBudget() as Prisma.InputJsonValue,
          systemPrompt: taskJson,
          systemPromptSha: sha,
          // Static tasks bypass the AI router; planner runs go
          // through `agent.planner` or `agent.workflow_planner`
          // which the registry resolves at call time. The model
          // column carries a stable identifier either way so audit
          // reads can distinguish the three paths.
          model: input.task
            ? "agent.harness.v1.static-task"
            : input.mode === "workflow"
              ? "agent.harness.v1.workflow"
              : "agent.harness.v1.planner",
        },
        select: { id: true },
      });

      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "AGENT_RUN_DRAFTED",
          entityType: "AgentRun",
          entityId: run.id,
          details: {
            assessmentId: input.assessmentId,
            engagementId,
            planName: input.planName,
            mode: input.task ? "static" : "planner",
            stepCount: input.task?.length ?? null,
            goal: input.goal ?? null,
          },
        },
      });

      return { id: run.id };
    }),

  start: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const run = await ctx.db.agentRun.findUnique({
        where: { id: input.id },
        select: { id: true, assessmentId: true, status: true },
      });
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      await assertCanMutateAssessment(ctx.db, ctx.session, run.assessmentId);
      if (run.status !== AgentRunStatus.PROPOSED) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Run is in status ${run.status}; only PROPOSED runs may be started`,
        });
      }
      await ctx.db.agentRun.update({
        where: { id: run.id },
        data: {
          status: AgentRunStatus.APPROVED,
          approvedById: ctx.session.user.id,
          approvedAt: new Date(),
        },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "AGENT_RUN_STARTED",
          entityType: "AgentRun",
          entityId: run.id,
          details: { assessmentId: run.assessmentId },
        },
      });
      // Enqueue on the document-processing queue. Stamped jobId so
      // resumes never collide with the original (see queue.ts comment).
      // If the BullMQ worker process is not running, this enqueue
      // succeeds but no log line will land in `agent harness start`
      // until you start it: `pnpm --filter @copilot/web worker`.
      const jobId = await enqueueAgentHarness(run.id);
      log.info("agent run enqueued", {
        worker: "agentRun.start",
        runId: run.id,
        assessmentId: run.assessmentId,
        jobId,
      });
      return { id: run.id, queued: true, jobId };
    }),

  /**
   * Force a re-dispatch of an AWAITING_USER (or otherwise stuck) run.
   *
   * Use cases:
   *   - The harness paused on a credential, the user supplied it, but
   *     the resume enqueue didn't fire (e.g. worker was offline at
   *     the time, or the previous bug with stable jobIds — fixed but
   *     manual rescue still useful).
   *   - The worker was restarted while a run was active and Prisma
   *     thinks it's RUNNING but no job is queued.
   *
   * Idempotent: if the run is already terminal, returns its status
   * without enqueueing.
   */
  resume: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const run = await ctx.db.agentRun.findUnique({
        where: { id: input.id },
        select: { id: true, assessmentId: true, status: true },
      });
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      await assertCanMutateAssessment(ctx.db, ctx.session, run.assessmentId);
      if (
        run.status === AgentRunStatus.COMPLETED ||
        run.status === AgentRunStatus.CANCELLED ||
        run.status === AgentRunStatus.FAILED ||
        run.status === AgentRunStatus.BUDGET_EXHAUSTED
      ) {
        return { id: run.id, status: run.status, queued: false };
      }
      const jobId = await enqueueAgentHarness(run.id);
      log.info("agent run manually resumed", {
        worker: "agentRun.resume",
        runId: run.id,
        priorStatus: run.status,
        jobId,
      });
      return { id: run.id, status: run.status, queued: true, jobId };
    }),

  /**
   * Soft-archive a run. Hides it from default lists (`getByAssessment`
   * with no flag) and removes it as a candidate for the workflow
   * snapshot — the diagram falls back to the next most-recent
   * non-archived workflow run, or to "no plan yet" if none. Child
   * rows (steps, credentials, workflow status) stay intact so a
   * restore is loss-free.
   */
  archive: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const run = await ctx.db.agentRun.findUnique({
        where: { id: input.id },
        select: { id: true, assessmentId: true, archivedAt: true },
      });
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      await assertCanMutateAssessment(ctx.db, ctx.session, run.assessmentId);
      if (run.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Run is already archived",
        });
      }
      await ctx.db.agentRun.update({
        where: { id: run.id },
        data: {
          archivedAt: new Date(),
          archivedById: ctx.session.user.id,
        },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "AGENT_RUN_ARCHIVED",
          entityType: "AgentRun",
          entityId: run.id,
          details: { assessmentId: run.assessmentId },
        },
      });
      return { id: run.id };
    }),

  /** Un-archive — clear the timestamp so the run shows up again. */
  restore: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const run = await ctx.db.agentRun.findUnique({
        where: { id: input.id },
        select: { id: true, assessmentId: true, archivedAt: true },
      });
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      await assertCanMutateAssessment(ctx.db, ctx.session, run.assessmentId);
      if (!run.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Run is not archived",
        });
      }
      await ctx.db.agentRun.update({
        where: { id: run.id },
        data: { archivedAt: null, archivedById: null },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "AGENT_RUN_RESTORED",
          entityType: "AgentRun",
          entityId: run.id,
          details: { assessmentId: run.assessmentId },
        },
      });
      return { id: run.id };
    }),

  /**
   * Hard-delete a run + cascade all child rows. Two-step rule: must
   * be archived first. Same discipline as Assessment delete — protects
   * users from a single-click accident on data they can't recover.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const run = await ctx.db.agentRun.findUnique({
        where: { id: input.id },
        select: { id: true, assessmentId: true, archivedAt: true },
      });
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      await assertCanMutateAssessment(ctx.db, ctx.session, run.assessmentId);
      if (!run.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Archive the run before deleting it.",
        });
      }
      await ctx.db.agentRun.delete({ where: { id: run.id } });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "AGENT_RUN_DELETED",
          entityType: "AgentRun",
          entityId: run.id,
          details: { assessmentId: run.assessmentId },
        },
      });
      return { id: run.id };
    }),

  cancel: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const run = await ctx.db.agentRun.findUnique({
        where: { id: input.id },
        select: { id: true, assessmentId: true, status: true },
      });
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      await assertCanMutateAssessment(ctx.db, ctx.session, run.assessmentId);
      if (
        run.status === AgentRunStatus.COMPLETED ||
        run.status === AgentRunStatus.CANCELLED ||
        run.status === AgentRunStatus.FAILED ||
        run.status === AgentRunStatus.BUDGET_EXHAUSTED
      ) {
        return { id: run.id, status: run.status };
      }
      const updated = await ctx.db.agentRun.update({
        where: { id: run.id },
        data: {
          status: AgentRunStatus.CANCELLED,
          endedAt: new Date(),
          endReason: "user cancelled",
        },
        select: { id: true, status: true },
      });
      // Auto-deny outstanding credential requests so the modal closes.
      await ctx.db.agentCredentialRequest.updateMany({
        where: { runId: run.id, status: CredentialRequestStatus.PENDING },
        data: {
          status: CredentialRequestStatus.SUPERSEDED,
        },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "AGENT_RUN_CANCELLED",
          entityType: "AgentRun",
          entityId: run.id,
          details: { assessmentId: run.assessmentId },
        },
      });
      return updated;
    }),

  getByAssessment: protectedProcedure
    .input(
      z.object({
        assessmentId: z.string().cuid(),
        /** Default: archived runs are hidden. Pass `true` to see them
         *  in the list (e.g. for a "Show archived" toggle). */
        includeArchived: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const runs = await ctx.db.agentRun.findMany({
        where: {
          assessmentId: input.assessmentId,
          ...(input.includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          planName: true,
          status: true,
          createdAt: true,
          startedAt: true,
          endedAt: true,
          endReason: true,
          model: true,
          archivedAt: true,
          _count: { select: { steps: true, credentialRequests: true } },
        },
      });
      return runs;
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const run = await ctx.db.agentRun.findUnique({
        where: { id: input.id },
        include: {
          steps: {
            orderBy: { idx: "asc" },
            include: {
              toolCalls: true,
              annotations: { orderBy: { createdAt: "asc" } },
            },
          },
          credentialRequests: { orderBy: { createdAt: "desc" } },
        },
      });
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      await assertAssessmentAccess(ctx.db, ctx.session, run.assessmentId);
      // Roll up cost from `AI_CALL` audit rows (Phase 3 Week 8 cost
      // instrumentation — ADR-0012). Every planner / tool call writes
      // one row tagged with `entityType: "AgentRun"` + `entityId: runId`.
      const callRows = await ctx.db.auditLog.findMany({
        where: {
          action: "AI_CALL",
          entityType: "AgentRun",
          entityId: input.id,
        },
        select: { id: true, details: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      let totalCostUsd = 0;
      let cachedReadInputTokens = 0;
      let cachedCreationInputTokens = 0;
      for (const r of callRows) {
        const d = (r.details ?? {}) as Record<string, unknown>;
        const cost = typeof d.estimatedCostUsd === "number" ? d.estimatedCostUsd : 0;
        totalCostUsd += cost;
        if (typeof d.cacheReadInputTokens === "number") {
          cachedReadInputTokens += d.cacheReadInputTokens;
        }
        if (typeof d.cacheCreationInputTokens === "number") {
          cachedCreationInputTokens += d.cacheCreationInputTokens;
        }
      }
      return {
        ...run,
        cost: {
          totalUsd: totalCostUsd,
          calls: callRows.length,
          cachedReadInputTokens,
          cachedCreationInputTokens,
        },
      };
    }),

  /**
   * Latest workflow plan for an assessment (across all runs), with
   * per-node statuses derived from the assessment's current data
   * (document count, answered question count, deliverable count, …).
   *
   * Returns `null` when no workflow run has been drafted yet — the
   * UI then shows a "draft a plan" empty state.
   *
   * Status semantics in Slice 1 are *soft* — predicates inspect data
   * presence (see `workflow.ts:deriveStepStatus`). Slice 2 layers on
   * an explicit user-driven completion lock; this procedure's return
   * shape gains an `explicitStatus` field then but the existing
   * fields don't change, so callers don't break.
   */
  workflowSnapshot: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);

      // Pick the most recent non-archived workflow-mode run that has
      // at least one PLAN step. Archiving the latest run drops it
      // here; the next non-archived run takes over (or the diagram
      // hides if there's no surviving plan).
      const runs = await ctx.db.agentRun.findMany({
        where: {
          assessmentId: input.assessmentId,
          model: { contains: "workflow" },
          archivedAt: null,
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: {
          steps: {
            where: { kind: "PLAN" },
            orderBy: { idx: "desc" },
            take: 1,
          },
        },
      });
      const latest = runs.find((r) => r.steps.length > 0);
      if (!latest) return null;

      const planStep = latest.steps[0];
      const payload = planStep.payload as {
        mode?: string;
        workflow?: WorkflowPlan;
      };
      if (payload.mode !== "workflow" || !payload.workflow) return null;
      const plan = payload.workflow;

      // Hydrate explicit user locks alongside the soft signal so the
      // diagram reflects "Mark complete" / "In progress" clicks the
      // moment they happen.
      const [snapshot, explicitRows] = await Promise.all([
        loadStatusSnapshot(ctx.db, input.assessmentId),
        ctx.db.workflowStepStatus.findMany({
          where: { runId: latest.id },
        }),
      ]);
      const explicitByNode = new Map(
        explicitRows.map((r) => [r.nodeId, r] as const),
      );
      const baseStatuses = new Map<string, WorkflowStepStatus>();
      for (const node of plan.nodes) {
        baseStatuses.set(
          node.id,
          combineExplicitAndSoftStatus(
            node.type,
            snapshot,
            explicitByNode.get(node.id) ?? null,
          ),
        );
      }
      const finalStatuses = applyDependencies(plan.nodes, baseStatuses);

      return {
        runId: latest.id,
        runStatus: latest.status,
        createdAt: latest.createdAt,
        revision: plan.revision,
        goal: plan.goal,
        repositories: plan.repositories,
        // Hydrate each node with spec + status so the client renders
        // without a second round-trip to the registry.
        nodes: plan.nodes.map((n) => {
          const explicit = explicitByNode.get(n.id) ?? null;
          return {
            id: n.id,
            type: n.type,
            reason: n.reason,
            dependsOn: n.dependsOn,
            status: finalStatuses.get(n.id) ?? "PENDING",
            // Distinguish explicit lock from soft derivation in the
            // UI — popups read this to decide button state.
            explicit: explicit
              ? {
                  status: explicit.status,
                  note: explicit.note,
                  updatedAt: explicit.updatedAt,
                }
              : null,
            spec: WORKFLOW_STEP_SPECS[n.type],
          };
        }),
      };
    }),

  /**
   * Mark a workflow step IN_PROGRESS or COMPLETED. The mutation
   * persists an explicit `WorkflowStepStatus` row keyed on
   * `(runId, nodeId)`; the snapshot procedure surfaces it on the
   * diagram and overrides the soft-derived status. Side-effect on
   * COMPLETED: triggers a workflow re-plan so the planner can insert
   * follow-up nodes given the new state of the assessment.
   */
  markStep: protectedProcedure
    .input(
      z.object({
        runId: z.string().cuid(),
        nodeId: z.string().min(1).max(160),
        status: z.enum(["IN_PROGRESS", "COMPLETED"]),
        note: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const run = await ctx.db.agentRun.findUnique({
        where: { id: input.runId },
        select: { id: true, assessmentId: true },
      });
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      await assertCanMutateAssessment(ctx.db, ctx.session, run.assessmentId);

      // Validate the nodeId is in the latest plan — protects against
      // stale clients pointing at a node from an earlier revision.
      const plan = await loadLatestWorkflowPlan(ctx.db, run.id);
      if (!plan || !plan.nodes.find((n) => n.id === input.nodeId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Node not in current workflow plan",
        });
      }

      // BLOCKED-gate enforcement on COMPLETED: a node can't transition
      // to COMPLETED while any predecessor is incomplete. The diagram
      // already disables the button visually; this is the server-side
      // belt + braces.
      if (input.status === "COMPLETED") {
        const [snapshot, explicitRows] = await Promise.all([
          loadStatusSnapshot(ctx.db, run.assessmentId),
          ctx.db.workflowStepStatus.findMany({ where: { runId: run.id } }),
        ]);
        const explicitByNode = new Map(
          explicitRows.map((r) => [r.nodeId, r] as const),
        );
        const baseStatuses = new Map<string, WorkflowStepStatus>();
        for (const node of plan.nodes) {
          baseStatuses.set(
            node.id,
            combineExplicitAndSoftStatus(
              node.type,
              snapshot,
              explicitByNode.get(node.id) ?? null,
            ),
          );
        }
        const final = applyDependencies(plan.nodes, baseStatuses);
        const node = plan.nodes.find((n) => n.id === input.nodeId)!;
        for (const dep of node.dependsOn) {
          if (final.get(dep) !== "COMPLETED") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Cannot complete this step while predecessor ${dep} is not COMPLETED.`,
            });
          }
        }
      }

      const explicitStatus =
        input.status === "COMPLETED"
          ? WorkflowStepExplicitStatus.COMPLETED
          : WorkflowStepExplicitStatus.IN_PROGRESS;

      await ctx.db.workflowStepStatus.upsert({
        where: { runId_nodeId: { runId: run.id, nodeId: input.nodeId } },
        create: {
          runId: run.id,
          nodeId: input.nodeId,
          status: explicitStatus,
          note: input.note ?? null,
          updatedById: ctx.session.user.id,
        },
        update: {
          status: explicitStatus,
          note: input.note ?? null,
          updatedById: ctx.session.user.id,
        },
      });

      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: `WORKFLOW_STEP_${input.status}`,
          entityType: "AgentRun",
          entityId: run.id,
          details: {
            nodeId: input.nodeId,
            assessmentId: run.assessmentId,
            note: input.note ?? null,
          },
        },
      });

      // On COMPLETED, fire a re-plan so the planner can react to the
      // new state. Bounded by `MAX_PLAN_REVISIONS`. Best-effort: a
      // re-plan failure leaves the existing plan untouched and the
      // user sees a non-blocking warning.
      let replan: { ok: true; revision: number } | { ok: false; reason: string } | null = null;
      if (input.status === "COMPLETED") {
        replan = await maybeReplanAfterCompletion(ctx.db, run.id);
      }

      return {
        runId: run.id,
        nodeId: input.nodeId,
        status: input.status,
        replan,
      };
    }),

  /**
   * Roll back an explicit step lock — soft delete the
   * `WorkflowStepStatus` row so the soft-derived status takes back
   * over. Underlying outputs (uploaded docs, answers, findings) are
   * NOT deleted; the user can re-do the step which will produce new
   * outputs alongside the existing ones (the audit trail keeps
   * everything).
   */
  rollbackStep: protectedProcedure
    .input(
      z.object({
        runId: z.string().cuid(),
        nodeId: z.string().min(1).max(160),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const run = await ctx.db.agentRun.findUnique({
        where: { id: input.runId },
        select: { id: true, assessmentId: true },
      });
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      await assertCanMutateAssessment(ctx.db, ctx.session, run.assessmentId);

      const existing = await ctx.db.workflowStepStatus.findUnique({
        where: { runId_nodeId: { runId: run.id, nodeId: input.nodeId } },
      });
      if (!existing) {
        return { runId: run.id, nodeId: input.nodeId, rolledBack: false };
      }
      await ctx.db.workflowStepStatus.delete({
        where: { runId_nodeId: { runId: run.id, nodeId: input.nodeId } },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "WORKFLOW_STEP_ROLLBACK",
          entityType: "AgentRun",
          entityId: run.id,
          details: {
            nodeId: input.nodeId,
            priorStatus: existing.status,
            assessmentId: run.assessmentId,
          },
        },
      });
      return { runId: run.id, nodeId: input.nodeId, rolledBack: true };
    }),

  pendingCredentials: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      // Find pending credential requests across this assessment's runs.
      const requests = await ctx.db.agentCredentialRequest.findMany({
        where: {
          status: CredentialRequestStatus.PENDING,
          run: { assessmentId: input.assessmentId },
        },
        orderBy: { createdAt: "asc" },
        include: {
          run: {
            select: {
              id: true,
              status: true,
              planName: true,
              assessmentId: true,
              engagementId: true,
            },
          },
        },
      });
      // Hydrate each with the human-readable scope spec so the modal
      // doesn't have to know about the registry shape.
      return requests.map((r) => {
        const spec = isKnownCredentialScope(r.scope)
          ? getCredentialScope(r.scope)
          : null;
        return {
          id: r.id,
          runId: r.runId,
          scope: r.scope,
          reason: r.reason,
          requiredScopes: r.requiredScopes,
          createdAt: r.createdAt,
          run: r.run,
          spec,
        };
      });
    }),

  submitCredential: protectedProcedure
    .input(submitCredentialInput)
    .mutation(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const request = await ctx.db.agentCredentialRequest.findUnique({
        where: { id: input.requestId },
        include: {
          run: {
            select: {
              id: true,
              assessmentId: true,
              engagementId: true,
              status: true,
            },
          },
        },
      });
      if (!request) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Credential request not found",
        });
      }
      // OWNER/ADMIN gate — submitting a credential is a privileged
      // action (the secret unlocks reads against the engagement's
      // GitHub account).
      await assertCanMutateAssessment(
        ctx.db,
        ctx.session,
        request.run.assessmentId,
      );
      if (request.status !== CredentialRequestStatus.PENDING) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Credential request is in status ${request.status}`,
        });
      }
      if (!isKnownCredentialScope(request.scope)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unknown credential scope: ${request.scope}`,
        });
      }

      // Encrypt and store. The vault upserts on (engagement, scope) —
      // a fresh PAT replaces a stale row in place.
      await putAgentCredential(ctx.db, {
        engagementId: request.run.engagementId,
        scope: request.scope,
        secret: input.secret,
        createdById: ctx.session.user.id,
        metadata: input.metadata,
      });

      await ctx.db.agentCredentialRequest.update({
        where: { id: request.id },
        data: {
          status: CredentialRequestStatus.FULFILLED,
          fulfilledAt: new Date(),
          fulfilledById: ctx.session.user.id,
        },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "AGENT_CREDENTIAL_FULFILLED",
          entityType: "AgentRun",
          entityId: request.run.id,
          details: {
            scope: request.scope,
            requestId: request.id,
            assessmentId: request.run.assessmentId,
          },
        },
      });

      // Re-enqueue the harness with a stamped jobId so this resume
      // dispatches even if the previous (paused) job is still in the
      // queue's completed history. The harness re-loads from Prisma
      // and resumes from the trajectory's current step.
      const jobId = await enqueueAgentHarness(request.run.id);
      log.info("agent run resumed after credential", {
        worker: "agentRun.submitCredential",
        runId: request.run.id,
        scope: request.scope,
        jobId,
      });
      return {
        request: { id: request.id, status: "FULFILLED" },
        result: { queued: true, runId: request.run.id, jobId },
      };
    }),

  // ── Tier 5 — annotations ───────────────────────────────────────
  /**
   * Pin a reviewer note on an agent step. Captured in the inspection
   * side panel; surfaced as a chip on the step's diagram node.
   *
   * Authz: anyone with read access on the parent assessment may write.
   * The author is recorded for the audit trail but a non-author can
   * still resolve or remove the note (the principle: a stuck note
   * shouldn't block teammates who weren't there when it was filed).
   */
  addAnnotation: protectedProcedure
    .input(
      z.object({
        stepId: z.string().cuid(),
        body: z.string().min(1).max(2_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const step = await ctx.db.agentStep.findUnique({
        where: { id: input.stepId },
        select: { run: { select: { assessmentId: true } } },
      });
      if (!step) throw new TRPCError({ code: "NOT_FOUND" });
      await assertAssessmentAccess(ctx.db, ctx.session, step.run.assessmentId);
      const row = await ctx.db.agentStepAnnotation.create({
        data: {
          stepId: input.stepId,
          authorId: ctx.session.user.id,
          body: input.body,
        },
      });
      return row;
    }),

  resolveAnnotation: protectedProcedure
    .input(
      z.object({
        annotationId: z.string().cuid(),
        resolved: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const ann = await ctx.db.agentStepAnnotation.findUnique({
        where: { id: input.annotationId },
        select: { step: { select: { run: { select: { assessmentId: true } } } } },
      });
      if (!ann) throw new TRPCError({ code: "NOT_FOUND" });
      await assertAssessmentAccess(
        ctx.db,
        ctx.session,
        ann.step.run.assessmentId,
      );
      return ctx.db.agentStepAnnotation.update({
        where: { id: input.annotationId },
        data: input.resolved
          ? { resolvedAt: new Date(), resolvedById: ctx.session.user.id }
          : { resolvedAt: null, resolvedById: null },
      });
    }),

  // ── Tier 5 — run comparison ────────────────────────────────────
  /**
   * Compute a coarse diff between two agent runs on the same
   * assessment. Used by the Compare runs UI to surface
   * "what changed between attempt A and attempt B" without forcing
   * the reviewer to read two trajectories cell-by-cell.
   *
   * Diff is intentionally summary-level — status, totals, halt reason,
   * per-tool counts, evidence-count delta. Step-by-step diff is the
   * job of the side panel + scrubber on each run individually.
   */
  compareRuns: protectedProcedure
    .input(
      z.object({
        leftRunId: z.string().cuid(),
        rightRunId: z.string().cuid(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const [left, right] = await Promise.all([
        ctx.db.agentRun.findUnique({
          where: { id: input.leftRunId },
          include: { steps: { include: { toolCalls: true } } },
        }),
        ctx.db.agentRun.findUnique({
          where: { id: input.rightRunId },
          include: { steps: { include: { toolCalls: true } } },
        }),
      ]);
      if (!left || !right) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      if (left.assessmentId !== right.assessmentId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Both runs must belong to the same assessment.",
        });
      }
      await assertAssessmentAccess(
        ctx.db,
        ctx.session,
        left.assessmentId,
      );

      type Summarisable = NonNullable<typeof left>;
      function summarise(r: Summarisable) {
        let inputTokens = 0;
        let outputTokens = 0;
        let evidenceCount = 0;
        const toolCounts = new Map<string, { ok: number; failed: number }>();
        for (const s of r.steps) {
          inputTokens += s.inputTokens;
          outputTokens += s.outputTokens;
          for (const c of s.toolCalls) {
            evidenceCount += c.evidenceIds.length;
            const slot = toolCounts.get(c.toolName) ?? { ok: 0, failed: 0 };
            if (c.status === "SUCCEEDED") slot.ok += 1;
            else if (c.status === "FAILED" || c.status === "TIMED_OUT") {
              slot.failed += 1;
            }
            toolCounts.set(c.toolName, slot);
          }
        }
        return {
          id: r.id,
          status: r.status,
          steps: r.steps.length,
          inputTokens,
          outputTokens,
          evidenceCount,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          endReason: r.endReason,
          toolCounts: Array.from(toolCounts.entries()).map(([toolName, c]) => ({
            toolName,
            ...c,
          })),
        };
      }

      const ls = summarise(left);
      const rs = summarise(right);
      const allTools = new Set<string>([
        ...ls.toolCounts.map((t) => t.toolName),
        ...rs.toolCounts.map((t) => t.toolName),
      ]);
      const toolDiff = Array.from(allTools).map((toolName) => {
        const a = ls.toolCounts.find((t) => t.toolName === toolName);
        const b = rs.toolCounts.find((t) => t.toolName === toolName);
        return {
          toolName,
          left: a ?? { ok: 0, failed: 0 },
          right: b ?? { ok: 0, failed: 0 },
        };
      });
      return {
        left: ls,
        right: rs,
        delta: {
          steps: rs.steps - ls.steps,
          inputTokens: rs.inputTokens - ls.inputTokens,
          outputTokens: rs.outputTokens - ls.outputTokens,
          evidenceCount: rs.evidenceCount - ls.evidenceCount,
        },
        toolDiff,
      };
    }),

  // ── Tier 5 — replay a single tool call with edited args ────────
  /**
   * Re-dispatch a tool call standalone with overridden args. The
   * result lands as a new `AgentStep`/`AgentToolCall` pair on the
   * SAME run so the audit trail stays single-threaded — the replay
   * isn't its own run.
   *
   * Limits:
   *   - Tool must be in the active registry (`getToolByName`).
   *   - The originating step must be a TOOL_CALL.
   *   - Run must not be terminal — we don't reopen a closed run; the
   *     UI surfaces the button only when status ∈ { COMPLETED,
   *     AWAITING_USER, RUNNING, FAILED }.
   *
   * No credentials are auto-resolved here; if the tool needs a scope
   * the executor's normal AWAITING_USER flow still applies.
   */
  replayToolCall: protectedProcedure
    .input(
      z.object({
        stepId: z.string().cuid(),
        argsOverride: z.record(z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireFlagOr404(ctx.db);
      const step = await ctx.db.agentStep.findUnique({
        where: { id: input.stepId },
        include: {
          run: { select: { id: true, assessmentId: true, status: true } },
          toolCalls: true,
        },
      });
      if (!step) throw new TRPCError({ code: "NOT_FOUND" });
      await assertAssessmentAccess(ctx.db, ctx.session, step.run.assessmentId);
      if (step.kind !== "TOOL_CALL") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Replay is only valid for TOOL_CALL steps.",
        });
      }
      const sourceCall = step.toolCalls[0];
      if (!sourceCall) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Step has no tool-call row to replay.",
        });
      }

      // Record the request as an audit row + a SYSTEM step on the
      // run. The actual re-dispatch happens via the harness queue —
      // we don't execute tools inline in a tRPC mutation (would
      // block the request thread and skip the cost-accounting path).
      const maxIdx = await ctx.db.agentStep.aggregate({
        where: { runId: step.run.id },
        _max: { idx: true },
      });
      const nextIdx = (maxIdx._max.idx ?? -1) + 1;
      const sysStep = await ctx.db.agentStep.create({
        data: {
          runId: step.run.id,
          idx: nextIdx,
          kind: "SYSTEM",
          payload: {
            kind: "tool_replay_requested",
            reason: `Replay of #${step.idx} (${sourceCall.toolName})`,
            sourceStepId: step.id,
            argsOverride: (input.argsOverride ?? null) as Prisma.InputJsonValue,
          } as Prisma.InputJsonValue,
        },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "AGENT_TOOL_REPLAY_REQUESTED",
          entityType: "AgentRun",
          entityId: step.run.id,
          details: {
            sourceStepId: step.id,
            toolName: sourceCall.toolName,
            argsOverride: (input.argsOverride ?? null) as Prisma.InputJsonValue,
          } as Prisma.InputJsonValue,
        },
      });
      return { ok: true, queuedStepId: sysStep.id };
    }),
});

// ─── Helpers ────────────────────────────────────────────────────────

/** Hard cap on workflow re-plans per run — defensive, see Slice 3 design. */
const MAX_PLAN_REVISIONS = 10;

type DbLike = Parameters<typeof loadStatusSnapshot>[0];

/**
 * Load the latest workflow plan from a run's most-recent PLAN step.
 * Returns null if the run has no workflow PLAN steps (e.g., a tool-call
 * run mistakenly hit a workflow endpoint).
 */
async function loadLatestWorkflowPlan(
  db: DbLike,
  runId: string,
): Promise<WorkflowPlan | null> {
  const step = await db.agentStep.findFirst({
    where: { runId, kind: "PLAN" },
    orderBy: { idx: "desc" },
    select: { payload: true },
  });
  if (!step) return null;
  const payload = step.payload as { mode?: string; workflow?: WorkflowPlan };
  if (payload.mode !== "workflow" || !payload.workflow) return null;
  return payload.workflow;
}

/**
 * Re-plan trigger: fired after a step is marked COMPLETED. Loads the
 * prior plan + completed-node ids, asks the planner for a revised
 * graph, and appends a new PLAN step. The planner is instructed to
 * preserve completed-node ids so explicit locks carry across
 * revisions (see prompt). Bounded by MAX_PLAN_REVISIONS — exceeding
 * it returns `{ ok: false, reason: "max revisions reached" }` and the
 * existing plan stays in place.
 *
 * Best-effort: any failure (planner errors, JSON parse glitches)
 * returns `{ ok: false }` without throwing — the underlying mark-complete
 * mutation has already succeeded and the user shouldn't be punished
 * for a planner hiccup.
 */
async function maybeReplanAfterCompletion(
  db: import("@prisma/client").PrismaClient,
  runId: string,
): Promise<{ ok: true; revision: number } | { ok: false; reason: string }> {
  try {
    const run = await db.agentRun.findUnique({
      where: { id: runId },
      select: { id: true, assessmentId: true },
    });
    if (!run) return { ok: false, reason: "run not found" };

    const planSteps = await db.agentStep.count({
      where: { runId, kind: "PLAN" },
    });
    if (planSteps >= MAX_PLAN_REVISIONS) {
      return { ok: false, reason: "max revisions reached" };
    }

    const priorPlan = await loadLatestWorkflowPlan(db, runId);
    if (!priorPlan) return { ok: false, reason: "no prior plan to re-plan" };

    const explicitRows = await db.workflowStepStatus.findMany({
      where: { runId, status: WorkflowStepExplicitStatus.COMPLETED },
      select: { nodeId: true },
    });
    const completedNodeIds = explicitRows.map((r) => r.nodeId);

    const result = await planWorkflow({
      goal: priorPlan.goal,
      initialRepositories: priorPlan.repositories,
      priorPlan,
      completedNodeIds,
      audit: { assessmentId: run.assessmentId, runId },
    });

    // Defensive: if the new plan is identical to the prior (same node
    // ids in same order) we skip persisting — no point in burning a
    // revision slot. JSON-stringified comparison is cheap.
    const same =
      JSON.stringify(priorPlan.nodes.map((n) => n.id)) ===
      JSON.stringify(result.plan.nodes.map((n) => n.id));
    if (same) {
      return { ok: false, reason: "plan unchanged" };
    }

    await db.agentStep.create({
      data: {
        runId,
        // We can't safely re-use trajectory.appendStep's idx-finder
        // without spinning up a serializable transaction; this single
        // write is fine because the harness is the only other writer
        // and runs are workflow-mode (no harness loop active).
        idx:
          ((
            await db.agentStep.findFirst({
              where: { runId },
              orderBy: { idx: "desc" },
              select: { idx: true },
            })
          )?.idx ?? -1) + 1,
        kind: "PLAN",
        payload: JSON.parse(
          JSON.stringify({
            mode: "workflow",
            rawText: result.rawText,
            workflow: result.plan,
            resolvedModel: result.resolvedModel,
            replanFromRevision: priorPlan.revision,
          }),
        ),
        inputTokens: result.tokens.input,
        outputTokens: result.tokens.output,
      },
    });

    return { ok: true, revision: result.plan.revision };
  } catch {
    return { ok: false, reason: "planner failure" };
  }
}
