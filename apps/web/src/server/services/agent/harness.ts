/**
 * Agent harness — ADR-0014 §3, bounded execute loop.
 *
 * v1 deliberately ships **without** an LLM planner. The "plan" is a
 * static list of `tool` invocations baked into the AgentRun's
 * `systemPrompt` JSON at draft time (see `agentRun.draft` tRPC); the
 * harness just iterates that list. Two reasons:
 *
 *   1. The user-visible behaviour worth shipping first is JIT
 *      credentials — pause when a tool needs a secret, prompt the
 *      user, resume from the paused step. That works the same with
 *      or without a planner.
 *   2. A real planner needs the full ADR-0012 cached system prompt +
 *      tool catalog + trajectory shaping work. That's its own slice.
 *
 * When the planner lands, the loop swaps the static iterator for a
 * `callAi({ task: "agent.planner" })` call that emits PlanStep — the
 * dispatch code below stays the same.
 *
 * **Replay invariant.** Every observable thing — plan decision, tool
 * call, result, evidence — is persisted via `trajectory.ts` writes.
 * `harness.ts` itself is stateless across runs; resume after pause
 * is a fresh invocation that re-reads the trajectory.
 *
 * **JIT credentials (ADR-0014 §8).** Before each tool dispatch we:
 *   1. Look up the tool's required scopes in `toolCredentialScopes`.
 *   2. For each scope, call `getAgentCredential(db, engagementId, scope)`.
 *   3. If any returns null, write an `AgentCredentialRequest` row,
 *      transition the run to AWAITING_USER, and return. Resume happens
 *      when `agentRun.submitCredential` re-invokes us.
 *   4. Otherwise build the credential bag and dispatch.
 *
 * See:
 *   docs/architecture/decisions/0014-agent-harness-for-evidence-collection.md
 */

import type { PrismaClient, Prisma } from "@prisma/client";
import {
  AgentRunStatus,
  AgentStepKind,
  ToolCallStatus,
  CredentialRequestStatus,
} from "@prisma/client";
import {
  appendStep,
  finishRun,
  markRunning,
  recordToolCall,
  updateToolCall,
} from "./trajectory";
import { getTool } from "./registry";
import { getAgentCredential } from "./credentials";
import { emitEvidence } from "./evidence-emitter";
import { toolCredentialScopes } from "./tools";
// Side-effect import: registers all tools on plan load. Without this
// the registry is empty and every dispatch fails the allowlist check.
import "./tools";
import { nextPlanStep } from "./planner";
import { planWorkflow } from "./workflow-planner";
import type {
  EvidenceDraft,
  PlanStep,
  ToolAsk,
  ToolContext,
  ToolCredentialBag,
} from "./types";

// Belt + braces budget: even a runaway planner shouldn't burn arbitrary
// tokens. The AgentRun.budget JSON carries the real caps; this constant
// is a defensive ceiling in case the budget is missing or malformed.
const PLANNER_DEFAULT_MAX_STEPS = 16;

// ─── Public entry ───────────────────────────────────────────────────

export interface RunAgentInput {
  db: PrismaClient;
  runId: string;
  abortSignal?: AbortSignal;
}

export interface RunAgentResult {
  status: AgentRunStatus;
  endReason: string;
}

/**
 * Drive the run from its current state to either a terminal status or
 * an AWAITING_USER pause. Safe to invoke repeatedly: a COMPLETED /
 * CANCELLED / FAILED run returns its existing status without re-work.
 */
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const { db, runId, abortSignal } = input;
  const run = await db.agentRun.findUnique({ where: { id: runId } });
  if (!run) {
    throw new Error(`AgentRun ${runId} not found`);
  }

  if (
    run.status === AgentRunStatus.COMPLETED ||
    run.status === AgentRunStatus.CANCELLED ||
    run.status === AgentRunStatus.FAILED ||
    run.status === AgentRunStatus.BUDGET_EXHAUSTED
  ) {
    return { status: run.status, endReason: run.endReason ?? "" };
  }

  if (run.status === AgentRunStatus.PROPOSED) {
    // Caller must approve before run dispatches — keeps the human-
    // approval gate from ADR-0014 §5 honest.
    return { status: run.status, endReason: "awaiting approval" };
  }

  // From APPROVED, AWAITING_USER, or RUNNING all paths flow through the
  // dispatch loop. AWAITING_USER means "we paused waiting on a credential
  // that should now be present" — re-attempting from the same step is
  // the resume path.
  await markRunning(db, runId);

  const task = parseTask(run.systemPrompt);
  if (!task.ok) {
    await finishRun(
      db,
      runId,
      AgentRunStatus.FAILED,
      "invalid task spec",
      { reason: task.reason } as Prisma.InputJsonValue,
    );
    return { status: AgentRunStatus.FAILED, endReason: "invalid task spec" };
  }

  // Workflow mode is one-shot: call the workflow planner, persist the
  // resulting graph as the run's first PLAN step, and finish. The plan
  // itself becomes the canvas the user works against on the assessment
  // detail page; subsequent re-plans (Slice 3) create new PLAN
  // revisions off the same AgentRun.
  if (task.kind === "workflow") {
    try {
      const result = await planWorkflow({
        goal: task.goal,
        initialRepositories: task.repositories,
        audit: { assessmentId: run.assessmentId, runId },
      });
      await appendStep(
        db,
        runId,
        AgentStepKind.PLAN,
        // Cast via unknown — readonly arrays in WorkflowPlan trip the
        // structural compatibility check against InputJsonValue
        // (which expects mutable arrays). The runtime payload is
        // plain JSON-serialisable.
        JSON.parse(
          JSON.stringify({
            mode: "workflow",
            rawText: result.rawText,
            workflow: result.plan,
            resolvedModel: result.resolvedModel,
          }),
        ) as Prisma.InputJsonValue,
        {
          input: result.tokens.input,
          output: result.tokens.output,
          cached: result.tokens.cached,
        },
      );
      await finishRun(
        db,
        runId,
        AgentRunStatus.COMPLETED,
        `workflow plan with ${result.plan.nodes.length} steps`,
      );
      return {
        status: AgentRunStatus.COMPLETED,
        endReason: `workflow plan with ${result.plan.nodes.length} steps`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishRun(
        db,
        runId,
        AgentRunStatus.FAILED,
        "workflow planner failed",
        { message } as Prisma.InputJsonValue,
      );
      return {
        status: AgentRunStatus.FAILED,
        endReason: "workflow planner failed",
      };
    }
  }

  // Tool-call execution strategies, same dispatch core:
  //   - Static task: iterate a pre-baked tool list. Used by the v1
  //     "Probe a file" form so the user can drive the agent without
  //     trusting the planner.
  //   - Planner: call the LLM each turn. Used when the draft passed
  //     `{ goal: "..." }` instead of `{ task: [...] }`.
  const stepIterator =
    task.kind === "static"
      ? staticIterator(db, runId, task.steps)
      : plannerIterator(
          db,
          run.assessmentId,
          runId,
          run.planName,
          task.goal,
          task.repository,
        );

  for await (const planStep of stepIterator) {
    if (abortSignal?.aborted) {
      await finishRun(db, runId, AgentRunStatus.CANCELLED, "abort signal");
      return { status: AgentRunStatus.CANCELLED, endReason: "abort signal" };
    }

    if (planStep.kind === "stop") {
      await appendStep(db, runId, AgentStepKind.SYSTEM, {
        kind: "planner_stop",
        reason: planStep.reason,
      } as Prisma.InputJsonValue);
      await finishRun(
        db,
        runId,
        AgentRunStatus.COMPLETED,
        planStep.reason,
      );
      return { status: AgentRunStatus.COMPLETED, endReason: planStep.reason };
    }

    const tool = getTool(run.planName, planStep.tool);
    if (!tool) {
      await appendStep(db, runId, AgentStepKind.SYSTEM, {
        kind: "tool_not_in_allowlist",
        tool: planStep.tool,
        plan: run.planName,
      } as Prisma.InputJsonValue);
      await finishRun(
        db,
        runId,
        AgentRunStatus.FAILED,
        `tool not in plan allowlist: ${planStep.tool}`,
      );
      return {
        status: AgentRunStatus.FAILED,
        endReason: `tool not in allowlist: ${planStep.tool}`,
      };
    }

    // ── Validate args via the tool's Zod schema ────────────────────
    const parsed = tool.inputSchema.safeParse(planStep.args);
    if (!parsed.success) {
      await appendStep(db, runId, AgentStepKind.SYSTEM, {
        kind: "input_validation_failed",
        tool: tool.name,
        issues: JSON.parse(JSON.stringify(parsed.error.issues)),
      } as Prisma.InputJsonValue);
      await finishRun(
        db,
        runId,
        AgentRunStatus.FAILED,
        `input validation failed for ${tool.name}`,
      );
      return {
        status: AgentRunStatus.FAILED,
        endReason: `bad args for ${tool.name}`,
      };
    }

    // ── JIT credentials ────────────────────────────────────────────
    const scopes = toolCredentialScopes(run.planName, tool.name);
    const bag: Record<string, string> = {};
    for (const scope of scopes) {
      const resolved = await getAgentCredential(db, run.engagementId, scope);
      if (!resolved) {
        // Open one PENDING request per missing scope; bail. The first
        // submitCredential resume will land here and either complete
        // the bag (and proceed) or open the next missing scope.
        await openCredentialRequest(db, runId, scope, tool.name);
        await finishRun(
          db,
          runId,
          AgentRunStatus.AWAITING_USER,
          `awaiting credential: ${scope}`,
        );
        return {
          status: AgentRunStatus.AWAITING_USER,
          endReason: `awaiting credential: ${scope}`,
        };
      }
      bag[scope] = resolved.secret;
    }

    // ── Dispatch ───────────────────────────────────────────────────
    const step = await appendStep(
      db,
      runId,
      AgentStepKind.TOOL_CALL,
      {
        tool: tool.name,
        args: planStep.args as Prisma.InputJsonValue,
      } as Prisma.InputJsonValue,
    );
    const callId = await recordToolCall(
      db,
      step.id,
      tool.name,
      planStep.args as Prisma.InputJsonValue,
    );

    const ctx = buildToolContext({
      runId,
      stepId: step.id,
      engagementId: run.engagementId,
      assessmentId: run.assessmentId,
      tenantId: run.engagementId,
      credentials: bag,
      abortSignal: abortSignal ?? new AbortController().signal,
    });

    const start = Date.now();
    let evidenceIds: string[] = [];
    let result;
    try {
      result = await tool.execute(ctx, parsed.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updateToolCall(db, callId, {
        status: ToolCallStatus.FAILED,
        errorClass: "tool.threw",
        durationMs: Date.now() - start,
        result: { message } as Prisma.InputJsonValue,
      });
      await finishRun(
        db,
        runId,
        AgentRunStatus.FAILED,
        `tool ${tool.name} threw`,
        { tool: tool.name, message } as Prisma.InputJsonValue,
      );
      return {
        status: AgentRunStatus.FAILED,
        endReason: `tool ${tool.name} threw`,
      };
    }

    if (!result.ok) {
      await updateToolCall(db, callId, {
        status: ToolCallStatus.FAILED,
        errorClass: result.errorClass,
        durationMs: Date.now() - start,
        result: { message: result.message } as Prisma.InputJsonValue,
      });
      // Failure policy diverges by task kind:
      //   - Static task: end the run. There's no planner to recover.
      //   - Planner: feed the failure back as an observation on the
      //     next turn so the planner can retry, switch tools, or stop.
      //     The planner's `priorSteps` formatter sees the FAILED tool
      //     call status from the trajectory.
      if (task.kind === "static") {
        await finishRun(
          db,
          runId,
          AgentRunStatus.FAILED,
          `${tool.name}: ${result.errorClass}`,
          { errorClass: result.errorClass, message: result.message } as Prisma.InputJsonValue,
        );
        return {
          status: AgentRunStatus.FAILED,
          endReason: `${tool.name}: ${result.errorClass}`,
        };
      }
      // Planner case: continue the loop. The next planner turn will
      // see the failure in `priorSteps` and decide what to do.
      continue;
    }

    if (result.evidence && result.evidence.length > 0) {
      evidenceIds = await emitEvidence(ctx, result.evidence as EvidenceDraft[], {
        db,
      });
    }

    await updateToolCall(db, callId, {
      status: ToolCallStatus.SUCCEEDED,
      durationMs: Date.now() - start,
      result: redactForPersistence(result.data) as Prisma.InputJsonValue,
      evidenceIds,
    });
  }

  await finishRun(db, runId, AgentRunStatus.COMPLETED, "task complete");
  return { status: AgentRunStatus.COMPLETED, endReason: "task complete" };
}

// ─── Task spec (parses out of AgentRun.systemPrompt) ────────────────

interface TaskStep {
  tool: string;
  args: unknown;
}

/**
 * Two task shapes share the `systemPrompt` JSON envelope:
 *   - `{ "task": [...] }` — static: the harness iterates a pre-baked
 *     list. Used by the v1 "Probe a file" form.
 *   - `{ "goal": "..." }` — planner: the harness calls the LLM each
 *     turn with the run's recent trajectory + tool catalog and
 *     dispatches whatever the planner returns.
 */
interface RepositoryRef {
  owner: string;
  repo: string;
  ref?: string;
}

type ParsedTask =
  | { ok: true; kind: "static"; steps: TaskStep[] }
  | { ok: true; kind: "planner"; goal: string; repository: RepositoryRef }
  | {
      ok: true;
      kind: "workflow";
      goal: string;
      repositories: RepositoryRef[];
    }
  | { ok: false; reason: string };

function parseTask(systemPrompt: string): ParsedTask {
  let parsed: unknown;
  try {
    parsed = JSON.parse(systemPrompt);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "json parse failed",
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "task envelope is not an object" };
  }
  const obj = parsed as {
    task?: unknown;
    goal?: unknown;
    repository?: unknown;
  };

  // Workflow envelope: explicit `mode: "workflow"` + goal + optional
  // initial repositories (multiple supported per Slice 1 spec).
  if ((obj as { mode?: unknown }).mode === "workflow") {
    if (typeof obj.goal !== "string" || obj.goal.trim().length === 0) {
      return { ok: false, reason: "workflow envelope missing `goal`" };
    }
    const reposIn = Array.isArray((obj as { repositories?: unknown }).repositories)
      ? ((obj as { repositories: unknown[] }).repositories as Array<
          Partial<RepositoryRef>
        >)
      : [];
    const repositories: RepositoryRef[] = [];
    for (const r of reposIn) {
      if (
        r &&
        typeof r.owner === "string" &&
        typeof r.repo === "string"
      ) {
        repositories.push({
          owner: r.owner,
          repo: r.repo,
          ref: typeof r.ref === "string" ? r.ref : undefined,
        });
      }
    }
    return { ok: true, kind: "workflow", goal: obj.goal, repositories };
  }
  if (Array.isArray(obj.task)) {
    const steps: TaskStep[] = [];
    for (const raw of obj.task) {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof (raw as { tool?: unknown }).tool !== "string"
      ) {
        return { ok: false, reason: "task entry missing `tool` string" };
      }
      const r = raw as { tool: string; args?: unknown };
      steps.push({ tool: r.tool, args: r.args ?? {} });
    }
    return { ok: true, kind: "static", steps };
  }
  if (typeof obj.goal === "string" && obj.goal.trim().length > 0) {
    const repo = obj.repository as Partial<RepositoryRef> | undefined;
    if (
      !repo ||
      typeof repo.owner !== "string" ||
      typeof repo.repo !== "string"
    ) {
      return {
        ok: false,
        reason:
          "planner envelope missing `repository` with { owner, repo }",
      };
    }
    return {
      ok: true,
      kind: "planner",
      goal: obj.goal,
      repository: {
        owner: repo.owner,
        repo: repo.repo,
        ref: typeof repo.ref === "string" ? repo.ref : undefined,
      },
    };
  }
  return {
    ok: false,
    reason: "envelope must carry either `task: []` or `goal: \"…\"`",
  };
}

// ─── Step iterators ────────────────────────────────────────────────

/**
 * Static-task iterator: yields the task list, resuming from
 * `count(TOOL_CALL steps)` so a re-invoked harness picks up where it
 * paused (typically after a credential supply).
 */
async function* staticIterator(
  db: PrismaClient,
  runId: string,
  steps: TaskStep[],
): AsyncIterableIterator<PlanStep> {
  const completedToolSteps = await db.agentStep.count({
    where: { runId, kind: AgentStepKind.TOOL_CALL },
  });
  for (const s of steps.slice(completedToolSteps)) {
    yield { kind: "tool", tool: s.tool, args: s.args };
  }
}

/**
 * Planner-driven iterator: each turn formats the run's trajectory into
 * a compact `priorSteps` block, calls the planner, persists a `PLAN`
 * step with the raw model output + token usage, and yields the
 * decision. Stops the iterator when the planner returns `stop` (the
 * outer loop persists the SYSTEM/COMPLETED bookkeeping).
 *
 * Defensive cap on iterations: even if the planner never emits `stop`
 * we won't run more than `PLANNER_DEFAULT_MAX_STEPS` turns. The real
 * cap is the AgentRun.budget JSON; this constant is the floor.
 */
async function* plannerIterator(
  db: PrismaClient,
  assessmentId: string,
  runId: string,
  planName: string,
  goal: string,
  repository: RepositoryRef,
): AsyncIterableIterator<PlanStep> {
  // Decorate the user goal with an explicit `# Target` block so the
  // planner doesn't have to guess `owner`/`repo` from the goal text.
  // The static system prompt already tells the planner to ground every
  // tool call in observed data; pinning the target here means the
  // first call lands on a real repo instead of a hallucination.
  const decoratedGoal =
    `${goal.trim()}\n\n# Target repository (use these exact values in tool args)\n` +
    `owner: ${repository.owner}\n` +
    `repo: ${repository.repo}\n` +
    (repository.ref ? `ref: ${repository.ref}\n` : "");

  for (let i = 0; i < PLANNER_DEFAULT_MAX_STEPS; i++) {
    const priorSteps = await summarisePriorSteps(db, runId);
    const result = await nextPlanStep({
      planName,
      userGoal: decoratedGoal,
      priorSteps,
      audit: { assessmentId, runId },
    });
    await appendStep(
      db,
      runId,
      AgentStepKind.PLAN,
      {
        rawText: result.rawText,
        decision: result.step,
        resolvedModel: result.resolvedModel,
      } as Prisma.InputJsonValue,
      { input: result.tokens.input, output: result.tokens.output, cached: result.tokens.cached },
    );
    yield result.step;
    if (result.step.kind === "stop") return;
  }
  // Hit the defensive cap → emit a synthesised stop so the outer loop
  // finishes COMPLETED with a clear reason.
  yield {
    kind: "stop",
    reason: `planner step cap (${PLANNER_DEFAULT_MAX_STEPS}) reached`,
  };
}

/**
 * Render the trajectory the planner sees on its next turn. We only
 * include TOOL_CALL and PLAN steps — SYSTEM bookkeeping and prior
 * USER_INPUT credential supplies aren't relevant to the next decision.
 */
async function summarisePriorSteps(
  db: PrismaClient,
  runId: string,
): Promise<string[]> {
  const steps = await db.agentStep.findMany({
    where: { runId },
    orderBy: { idx: "asc" },
    include: { toolCalls: true },
  });
  const out: string[] = [];
  for (const s of steps) {
    if (s.kind === AgentStepKind.TOOL_CALL) {
      const call = s.toolCalls[0];
      if (!call) continue;
      const args = JSON.stringify(call.argsJson).slice(0, 200);
      const summary =
        call.status === ToolCallStatus.SUCCEEDED
          ? `OK ${truncate(JSON.stringify(call.resultJson) ?? "", 240)}`
          : call.status === ToolCallStatus.FAILED
            ? `FAILED (${call.errorClass ?? "unknown"})`
            : call.status;
      out.push(`tool ${call.toolName} args=${args} → ${summary}`);
    } else if (s.kind === AgentStepKind.PLAN) {
      const decision = (s.payload as { decision?: PlanStep })?.decision;
      if (decision?.kind === "tool") {
        out.push(`plan: call ${decision.tool}`);
      } else if (decision?.kind === "stop") {
        out.push(`plan: stop (${decision.reason})`);
      }
    }
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

// ─── Helpers ────────────────────────────────────────────────────────

async function openCredentialRequest(
  db: PrismaClient,
  runId: string,
  scope: string,
  toolName: string,
): Promise<void> {
  // Idempotency: if there's already a PENDING request for the same
  // (runId, scope), don't open a duplicate. A run that was paused once
  // and re-attempted by an over-eager UI should converge on one row.
  const existing = await db.agentCredentialRequest.findFirst({
    where: { runId, scope, status: CredentialRequestStatus.PENDING },
    select: { id: true },
  });
  if (existing) return;
  await db.agentCredentialRequest.create({
    data: {
      runId,
      scope,
      reason: `Tool ${toolName} requires the ${scope} credential to read from the engagement's GitHub account.`,
      requiredScopes: ["contents:read", "metadata:read"],
      status: CredentialRequestStatus.PENDING,
    },
  });
}

interface BuildContextInput {
  runId: string;
  stepId: string;
  engagementId: string;
  assessmentId: string;
  tenantId: string;
  credentials: ToolCredentialBag;
  abortSignal: AbortSignal;
}

function buildToolContext(input: BuildContextInput): ToolContext {
  // The `ask` channel isn't wired in v1 — clarifying questions are
  // out of scope until the planner lands. We pass a stub that throws
  // so any tool that mistakenly calls it fails loudly during testing.
  const ask: ToolAsk = async () => {
    throw new Error("ToolContext.ask is not wired in agent harness v1");
  };
  const taggedLogger = (level: string) => (msg: string, fields?: object) => {
    // Minimal console logger — the platform logger threads tags from a
    // request context this code path doesn't own. The harness runs from
    // a tRPC mutation today; once it moves to BullMQ we'll inject the
    // worker logger here.
    // eslint-disable-next-line no-console
    console.log(
      `[agent ${level}] run=${input.runId} step=${input.stepId} ${msg}`,
      fields ?? "",
    );
  };
  return {
    runId: input.runId,
    stepId: input.stepId,
    engagementId: input.engagementId,
    assessmentId: input.assessmentId,
    tenantId: input.tenantId,
    credentials: input.credentials,
    ask,
    logger: {
      debug: taggedLogger("debug"),
      info: taggedLogger("info"),
      warn: taggedLogger("warn"),
      error: taggedLogger("error"),
    },
    abortSignal: input.abortSignal,
  };
}

/**
 * Trim a tool result before persisting to `AgentToolCall.resultJson`.
 * Today this just caps the `content` field at 64KB so a giant file
 * read doesn't bloat the trajectory row; the original blob is in
 * Evidence anyway. Future: redact specific keys if a tool surfaces
 * something secret-shaped.
 */
function redactForPersistence(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = data as Record<string, unknown>;
  if (typeof obj.content === "string" && obj.content.length > 64 * 1024) {
    return {
      ...obj,
      content: `${obj.content.slice(0, 64 * 1024)}…[truncated]`,
      contentTruncated: true,
    };
  }
  return data;
}
