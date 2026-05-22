/**
 * Tool registration barrel.
 *
 * Importing this module side-effects the in-process registry so the
 * harness sees the agent's full tool catalog. Plans group tools:
 *
 *   - "github-evidence" — v1 plan that ships read-only GitHub access
 *     (read_file + list_repo_files). The credential vault must hold
 *     `github.pat` for this engagement before any of these can dispatch.
 *
 * Adding a new tool: implement it under `tools/<provider>.ts`, then
 * register it on its plan(s) here. Keeping registration centralised
 * means the planner's tool catalog and the harness's allowlist are
 * generated from the same source — no drift.
 */

import { registerTool } from "../registry";
import {
  githubReadFile,
  githubListFiles,
  GITHUB_TOOL_CREDENTIALS,
} from "./github";

const PLAN_GITHUB_EVIDENCE = "github-evidence" as const;

registerTool(PLAN_GITHUB_EVIDENCE, githubReadFile);
registerTool(PLAN_GITHUB_EVIDENCE, githubListFiles);

/**
 * Plan → tool credential needs map. The harness consults this at
 * dispatch time to pre-resolve credentials per tool. New plans append
 * here; new tools on an existing plan merge into the existing entry.
 */
export const PLAN_TOOL_CREDENTIALS: Record<
  string,
  Record<string, readonly string[]>
> = {
  [PLAN_GITHUB_EVIDENCE]: { ...GITHUB_TOOL_CREDENTIALS },
};

/**
 * Lookup the credential scopes a (plan, tool) pair needs. Returns an
 * empty array when the tool needs nothing — most local-only tools
 * (e.g. `scratchpad.*` once they land) will fall through this branch.
 */
export function toolCredentialScopes(
  planName: string,
  toolName: string,
): readonly string[] {
  return PLAN_TOOL_CREDENTIALS[planName]?.[toolName] ?? [];
}

export const PLANS = {
  GITHUB_EVIDENCE: PLAN_GITHUB_EVIDENCE,
} as const;
export type AgentPlanName = (typeof PLANS)[keyof typeof PLANS];
