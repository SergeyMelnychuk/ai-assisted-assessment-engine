/**
 * Agent tool interface — ADR-0014 §3.
 *
 * Every agent tool implements the same contract: a Zod-validated input
 * schema, a declared `scope` (read / exec / network / human — used by
 * the harness to gate sandboxing and approval), and an `execute` that
 * returns a `ToolResult`. Tools never touch assessment rows directly;
 * they may only emit `EvidenceDraft`s which the harness hands to the
 * evidence emitter.
 *
 * Slice 0 provides the interface + `defineTool` inference helper.
 * Concrete tools (`repo.*`, `access.request`, `scratchpad.*`) land in
 * Slice 1 per the ADR's §4 tool suite.
 *
 * See:
 *   docs/architecture/decisions/0014-agent-harness-for-evidence-collection.md
 */

import type { z } from "zod";
import type { ToolContext, ToolResult } from "./types";

/**
 * Scope classifier — coarse capability tag the harness uses to:
 *   - `read`   — pure reads; safe to run without approval.
 *   - `exec`   — runs code (linters, SAST, grep-in-checkout). Must
 *                run in a sandbox (ADR-0014 §8).
 *   - `network`— makes outbound calls with customer credentials
 *                (provider APIs, cloud SDKs).
 *   - `human`  — blocks on the user (e.g. `access.request`). Writes an
 *                `AgentStep { kind: AWAITING_USER }` and suspends.
 */
export type ToolScope = "read" | "exec" | "network" | "human";

export interface Tool<I = unknown, O = unknown> {
  /** Stable identifier surfaced to the planner, e.g. "repo.read_file". */
  name: string;
  /** One-line description shown to the model in the tool catalog. */
  description: string;
  /** Zod schema for input args. Validated by the harness before execution. */
  inputSchema: z.ZodType<I>;
  /** Capability tag — see `ToolScope`. */
  scope: ToolScope;
  /** The implementation. */
  execute(ctx: ToolContext, args: I): Promise<ToolResult<O>>;
}

/**
 * Type-inference helper: returns the definition as-is so call-sites can
 * write `defineTool({ ... })` and get `Tool<I, O>` inferred from the
 * Zod schema + execute signature without restating generics.
 */
export function defineTool<I, O>(def: Tool<I, O>): Tool<I, O> {
  return def;
}
