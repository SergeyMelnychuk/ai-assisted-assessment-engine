/**
 * Workflow planner — Phase 4 Slice 1.
 *
 * Single-turn LLM call that converts a user goal into a `WorkflowPlan`
 * (graph of human-driven steps). Distinct from `planner.ts` which
 * picks autonomous tool calls turn-by-turn — workflow planning runs
 * exactly once per workflow-mode `AgentRun` and the result is
 * persisted as the run's first PLAN step.
 *
 * Slice 3 will swap "exactly once" for "called again on completion of
 * each step so the planner can insert follow-up nodes." The contract
 * here doesn't change — only the call frequency.
 */

import { callAi, parseJsonResponse } from "../ai/router";
import {
  AGENT_WORKFLOW_PLANNER_SYSTEM_PROMPT,
  buildWorkflowPlannerPrompt,
} from "../ai/prompts/agent-workflow-planner";
import {
  WORKFLOW_STEP_SPECS,
  WORKFLOW_STEP_TYPES,
  isWorkflowStepType,
  type WorkflowNode,
  type WorkflowPlan,
} from "./workflow";

export interface WorkflowPlannerInput {
  goal: string;
  initialRepositories: ReadonlyArray<{
    owner: string;
    repo: string;
    ref?: string;
  }>;
  /**
   * Slice 3 re-plan path: prior plan to seed the planner with. When
   * present we ask for a revised full graph; the planner is instructed
   * to preserve completed-step ids so the explicit completion lock
   * carries over.
   */
  priorPlan?: WorkflowPlan;
  /**
   * Slice 3: which nodes the user has explicitly marked complete on
   * the prior revision. Surfaced to the planner so it knows what NOT
   * to re-plan around.
   */
  completedNodeIds?: readonly string[];
  audit?: { assessmentId: string; runId: string };
}

export interface WorkflowPlannerResult {
  plan: WorkflowPlan;
  tokens: { input: number; output: number; cached: number };
  rawText: string;
  resolvedModel: string;
}

interface PlannerJson {
  plan?: Array<{
    id?: unknown;
    type?: unknown;
    reason?: unknown;
    dependsOn?: unknown;
  }>;
  stop?: boolean;
  reason?: string;
}

/**
 * Build the step catalog the planner sees on its user turn. Dense by
 * design — the catalog re-serialises per call (it's not in the cached
 * system prompt) and a verbose catalog burns input tokens.
 */
function formatStepCatalog(): string {
  return WORKFLOW_STEP_TYPES.map((t) => {
    const spec = WORKFLOW_STEP_SPECS[t];
    return `- ${spec.type} — ${spec.description}`;
  }).join("\n");
}

/**
 * Validate planner output against the step registry. Returns the
 * sanitised plan or null if the planner produced something unusable.
 * Unknown types are dropped; nodes referencing missing predecessors
 * are kept but the diagram's `applyDependencies` will leave them
 * BLOCKED — better than failing the whole plan.
 */
function interpretPlan(
  raw: PlannerJson,
  goal: string,
  initialRepositories: WorkflowPlan["repositories"],
  priorRevision: number,
): WorkflowPlan | null {
  if (!raw.plan || !Array.isArray(raw.plan) || raw.plan.length === 0) {
    return null;
  }
  const nodes: WorkflowNode[] = [];
  for (let i = 0; i < raw.plan.length; i++) {
    const r = raw.plan[i];
    if (!r || typeof r !== "object") continue;
    if (typeof r.type !== "string" || !isWorkflowStepType(r.type)) continue;
    const id =
      typeof r.id === "string" && r.id.length > 0
        ? r.id
        : `workflow:${i}:${r.type}`;
    const reason =
      typeof r.reason === "string" && r.reason.length > 0
        ? r.reason.slice(0, 400)
        : `${WORKFLOW_STEP_SPECS[r.type].label} — planner did not provide a reason.`;
    const dependsOn = Array.isArray(r.dependsOn)
      ? r.dependsOn.filter((d): d is string => typeof d === "string")
      : [];
    nodes.push({ id, type: r.type, reason, dependsOn });
  }
  if (nodes.length === 0) return null;
  return {
    revision: priorRevision + 1,
    goal,
    repositories: initialRepositories,
    nodes,
  };
}

export async function planWorkflow(
  input: WorkflowPlannerInput,
): Promise<WorkflowPlannerResult> {
  // Format the prior plan for the planner to seed re-planning. Tag
  // completed nodes inline so the planner can see them at a glance
  // (rather than cross-referencing the completedNodeIds array).
  let priorPlanJson: string | undefined;
  if (input.priorPlan) {
    const completed = new Set(input.completedNodeIds ?? []);
    const enriched = {
      revision: input.priorPlan.revision,
      goal: input.priorPlan.goal,
      nodes: input.priorPlan.nodes.map((n) => ({
        ...n,
        explicitCompleted: completed.has(n.id),
      })),
    };
    priorPlanJson = JSON.stringify(enriched, null, 2);
  }

  const userTurn = buildWorkflowPlannerPrompt({
    goal: input.goal,
    stepCatalog: formatStepCatalog(),
    initialRepositories: input.initialRepositories,
    priorPlanJson,
  });

  const res = await callAi<PlannerJson>({
    task: "agent.workflow_planner",
    system: AGENT_WORKFLOW_PLANNER_SYSTEM_PROMPT,
    userContent: userTurn,
    // Force JSON-shape commitment from token 0.
    assistantPrefill: "{",
    parseResult: (raw) => parseJsonResponse<PlannerJson>(raw),
    audit: input.audit
      ? {
          callType: "agent",
          entityType: "AgentRun",
          entityId: input.audit.runId,
        }
      : undefined,
  });

  const priorRevision = input.priorPlan?.revision ?? 0;
  const plan = interpretPlan(
    res.result,
    input.goal,
    input.initialRepositories,
    priorRevision,
  );
  if (!plan) {
    throw new Error(
      "Workflow planner returned a payload with no usable nodes. " +
        "Inspect the run's PLAN step for the raw model output.",
    );
  }

  return {
    plan,
    tokens: {
      input: res.tokensUsed?.input ?? 0,
      output: res.tokensUsed?.output ?? 0,
      cached: res.cacheReadInputTokens ?? 0,
    },
    rawText: JSON.stringify(res.result),
    resolvedModel: `${res.resolvedProvider ?? "?"}/${res.resolvedModel ?? "?"}`,
  };
}
