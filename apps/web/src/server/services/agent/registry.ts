/**
 * Agent tool registry — ADR-0014 §3 (allowlist per plan).
 *
 * In-process map of `planName → (toolName → Tool)`. The harness looks up
 * the tool set for the plan being executed and refuses any tool call
 * the planner emits that is not on that plan's allowlist. This is the
 * enforcement point for the ADR's "scoped credential list, tool
 * allowlist" approval contract (§5).
 *
 * Slice 0: no tools registered. Slice 1 wires repo.* + access.request +
 * scratchpad.* into the "repo-inspection" plan.
 *
 * See:
 *   docs/architecture/decisions/0014-agent-harness-for-evidence-collection.md
 */

import type { Tool } from "./tool";

const _plans: Map<string, Map<string, Tool>> = new Map();

/**
 * Register a tool for a plan. Multiple plans may share a tool; call
 * `registerTool` once per (plan, tool) pair. Last write wins for a
 * given (planName, tool.name) — intentional, so tests can swap in
 * fakes without tearing down the registry.
 */
export function registerTool(planName: string, tool: Tool): void {
  let bucket = _plans.get(planName);
  if (!bucket) {
    bucket = new Map();
    _plans.set(planName, bucket);
  }
  bucket.set(tool.name, tool);
}

/**
 * Ordered snapshot of the tools available to a plan. Returns an empty
 * array for unknown plans — the harness treats that as "no tools
 * allowed" and the run will end `FAILED` on the first tool call.
 */
export function getToolsForPlan(planName: string): readonly Tool[] {
  const bucket = _plans.get(planName);
  if (!bucket) return [];
  return Array.from(bucket.values());
}

/**
 * Resolve a single tool on a plan. Returns `undefined` for an unknown
 * plan or an unregistered tool name; callers surface that as a
 * `BUDGET_DENIED`-adjacent "tool not in allowlist" step.
 */
export function getTool(
  planName: string,
  toolName: string,
): Tool | undefined {
  return _plans.get(planName)?.get(toolName);
}
