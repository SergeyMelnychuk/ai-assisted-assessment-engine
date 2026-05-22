/**
 * LLM planner — ADR-0014 §3 (planner role) + ADR-0012 (cached prompts).
 *
 * Drives one PLAN turn. The harness calls `nextPlanStep()` with the
 * current trajectory; the planner formats the tool catalog + recent
 * steps into the user-turn shape `agent-planner.ts` expects, calls
 * `callAi({ task: "agent.planner" })`, and parses the JSON response
 * into a {@link PlanStep}.
 *
 * The static system prompt comes from `prompts/agent-planner.ts` and is
 * passed as `system:` so Anthropic prompt caching (per ADR-0012's
 * registry binding for `agent.planner`) holds the prefix across every
 * step of every run. Only the run context (catalog + goal + history)
 * lands in `userContent` and re-serialises per turn.
 *
 * Output contract (terse — see the system prompt for the full version):
 *   - Tool call: `{"tool":"...","args":{...}}`
 *   - Stop:      `{"stop":true,"reason":"..."}`
 *
 * Anything else is a parse failure, which the harness handles by
 * stopping the run with `endReason: "planner produced unparseable output"`.
 */

import { callAi, parseJsonResponse } from "../ai/router";
import {
  AGENT_PLANNER_SYSTEM_PROMPT,
  buildRunContext,
} from "../ai/prompts/agent-planner";
import { getToolsForPlan } from "./registry";
import { toolCredentialScopes } from "./tools";
import type { PlanStep } from "./types";

export interface PlannerInput {
  planName: string;
  /** Free-form user goal carried on the AgentRun's task envelope. */
  userGoal: string;
  /**
   * Compact summaries of the run's prior steps, in order. Plain strings
   * keep the formatting in one place (here) — the harness shouldn't need
   * to know what the planner wants to see.
   */
  priorSteps: string[];
  /** Forwarded to `callAi.audit` for cost attribution. */
  audit?: {
    assessmentId: string;
    runId: string;
  };
}

export interface PlannerResult {
  step: PlanStep;
  /** Token usage so the harness can charge the budget tracker. */
  tokens: { input: number; output: number; cached: number };
  /** Raw model output, retained for the trajectory PLAN step payload. */
  rawText: string;
  /** Resolved model id ("anthropic/claude-sonnet-4-7" etc.) for audit. */
  resolvedModel: string;
}

/**
 * Ask the planner for the next step. Throws on transport / router-level
 * failures; returns `{ step: { kind: "stop", reason } }` if the model
 * returns parseable but malformed JSON (so the harness can persist the
 * stop step + the raw text rather than failing the run silently).
 */
export async function nextPlanStep(
  input: PlannerInput,
): Promise<PlannerResult> {
  const toolCatalog = formatToolCatalog(input.planName);
  const userTurn = buildRunContext({
    planName: input.planName,
    toolCatalog,
    userGoal: input.userGoal,
    priorSteps: input.priorSteps,
  });

  const res = await callAi<PlannerJson>({
    task: "agent.planner",
    system: AGENT_PLANNER_SYSTEM_PROMPT,
    userContent: userTurn,
    // Force the response shape: prefilling the assistant turn with `{`
    // makes the model commit to JSON from token 0. The router pipes the
    // prefill back into `rawText` so the parser sees a complete object.
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

  const step = interpretPlannerJson(res.result);
  return {
    step,
    tokens: {
      input: res.tokensUsed?.input ?? 0,
      output: res.tokensUsed?.output ?? 0,
      cached: res.cacheReadInputTokens ?? 0,
    },
    // The router doesn't surface `rawText` separately on AIResponse —
    // we get the parsed JSON back. Re-serialise so the trajectory's
    // PLAN payload still preserves what came across the wire.
    rawText: JSON.stringify(res.result),
    resolvedModel: `${res.resolvedProvider ?? "?"}/${res.resolvedModel ?? "?"}`,
  };
}

// ─── Internals ──────────────────────────────────────────────────────

interface PlannerJson {
  tool?: string;
  args?: unknown;
  stop?: boolean;
  reason?: string;
}

function interpretPlannerJson(json: PlannerJson): PlanStep {
  if (json.stop === true) {
    return { kind: "stop", reason: json.reason ?? "planner stopped" };
  }
  if (typeof json.tool === "string" && json.tool.length > 0) {
    return { kind: "tool", tool: json.tool, args: json.args ?? {} };
  }
  // Malformed: produce a stop with a diagnostic so the trajectory
  // captures what came back. The harness persists this as PLAN, then
  // sees the `stop` and ends with the same `reason` on `endReason`.
  return {
    kind: "stop",
    reason: "planner emitted JSON that matched neither schema",
  };
}

/**
 * Render the tool catalog the planner sees. Each entry is one line:
 *   `name — description (credentials: scope1, scope2)`
 *
 * Keeping it dense matters: the catalog re-serialises per turn (it's in
 * the user-turn block, not the cached system prompt), and a verbose
 * catalog burns input tokens on every step. If a tool's `description`
 * has more nuance the model needs, expand the description string —
 * don't add columns here.
 */
function formatToolCatalog(planName: string): string {
  const tools = getToolsForPlan(planName);
  if (tools.length === 0) return "(no tools registered for this plan)";
  return tools
    .map((t) => {
      const scopes = toolCredentialScopes(planName, t.name);
      const credBlurb =
        scopes.length === 0 ? "" : ` (credentials: ${scopes.join(", ")})`;
      return `- ${t.name} — ${t.description}${credBlurb}`;
    })
    .join("\n");
}
