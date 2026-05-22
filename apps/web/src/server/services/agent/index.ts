/**
 * Agent harness public surface — ADR-0014.
 *
 * Deliberately narrow barrel. Internal modules (registry, budget,
 * trajectory, evidence-emitter, types beyond the ones re-exported
 * below) should be imported by path from inside this folder, not via
 * the barrel — call-sites that need them are harness-internal.
 *
 * Importing this module also pulls in the side-effect tool registration
 * via `./tools` (see `tools/index.ts`).
 *
 * See:
 *   docs/architecture/decisions/0014-agent-harness-for-evidence-collection.md
 */

export { runAgent } from "./harness";
export type { RunAgentInput, RunAgentResult } from "./harness";
export { defineTool } from "./tool";
export type { Tool } from "./tool";
export { registerTool } from "./registry";
export type { EvidenceDraft, AgentRunBudget } from "./types";
export { PLANS, toolCredentialScopes } from "./tools";
export type { AgentPlanName } from "./tools";
