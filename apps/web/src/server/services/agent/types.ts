/**
 * Shared types for the agent harness — ADR-0014 §3 (tool protocol) and
 * §4 (budget shape).
 *
 * Slice 0 of Phase 4 — Agentic AI. These types define the stable
 * contracts the harness, tools, registry, budget tracker, trajectory
 * writer and evidence emitter all share. Implementations land in
 * Slice 1; this file is types-only plus TODO references.
 *
 * See:
 *   docs/architecture/decisions/0014-agent-harness-for-evidence-collection.md
 */

import type { LogFields } from "@/server/lib/logger";

// ─── Budget shape (ADR-0014 §5) ─────────────────────────────────────

/**
 * Hard caps composed at job enqueue time. A run that hits ANY cap ends
 * with status `BUDGET_EXHAUSTED`, not a silent partial. Mirrors the
 * ADR's `AgentRunBudget` interface; `maxCostUsd` is derived at enqueue
 * from `maxTokens × model pricing` and lives on the frozen budget JSON
 * in `AgentRun.budget`, not here (tracker cares about the raw caps).
 */
export interface AgentRunBudget {
  maxSteps: number;
  maxTokens: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxSandboxSeconds: number;
  maxEvidenceRows: number;
}

/**
 * Running tallies kept in lock-step with the budget caps. Same keys,
 * same units — so `usage[k] >= budget[k]` is the exhaustion predicate.
 */
export type AgentRunUsage = {
  [K in keyof AgentRunBudget]: number;
};

// ─── Tool execution context (ADR-0014 §3) ───────────────────────────

/**
 * Per-tool view of the credential vault (ADR-0014 §8). A tool declares
 * the scopes it needs via `requiresCredentials` and the harness
 * pre-resolves them before dispatch — the tool sees a read-only map
 * keyed by scope. If a scope is missing, the harness never dispatches
 * the tool in the first place (it pauses the run with AWAITING_USER
 * and opens an `AgentCredentialRequest`). So if a tool reads
 * `credentials["github.pat"]` it can assume the string is present.
 */
export type ToolCredentialBag = Readonly<Record<string, string>>;

/**
 * The harness-side `ask` channel. Writes an `AgentStep { kind:
 * USER_INPUT }` paired with an `AgentCredentialRequest` (when the ask
 * is about a credential) or a free-form clarifying question. The
 * returned promise resolves once the user answers via the tRPC
 * `agentRun.submitUserInput` / `submitCredential` mutation. Until
 * then the run sits in AWAITING_USER.
 *
 * Slice 1 wires this for credential requests. Clarifying questions
 * land with the executor loop in the same slice.
 */
export type ToolAsk = (
  input:
    | { kind: "credential"; scope: string; reason: string }
    | { kind: "clarify"; prompt: string; options?: readonly string[] },
) => Promise<string>;

/**
 * Minimal execution context handed to every tool. Extended in Slice 1
 * with `credentials` and `ask` per ADR-0014 §3. `sandbox` and the
 * per-call `budget` snapshot land with the sandbox / budget wiring
 * later in Slice 1.
 */
export interface ToolContext {
  runId: string;
  stepId: string;
  engagementId: string;
  assessmentId: string;
  tenantId: string;
  /** Credentials the tool declared via `requiresCredentials`, pre-
   *  resolved from the vault. See `ToolCredentialBag` for the
   *  "always-present-if-declared" guarantee. */
  credentials: ToolCredentialBag;
  /** Block the run and surface a prompt to the user (credential ask
   *  or free-form clarification). Resolves with the user's answer. */
  ask: ToolAsk;
  /** Structured logger pre-tagged with run/step/tool identifiers. */
  logger: {
    debug: (msg: string, fields?: LogFields) => void;
    info: (msg: string, fields?: LogFields) => void;
    warn: (msg: string, fields?: LogFields) => void;
    error: (msg: string, fields?: LogFields) => void;
  };
  /** Cooperative cancellation — tools must honour this. */
  abortSignal: AbortSignal;
}

// ─── Tool result envelope ───────────────────────────────────────────

/**
 * Discriminated union returned by every tool. The success branch may
 * carry `evidence` drafts the harness will hand to the evidence
 * emitter (which dedups on `contentSha`). Failures carry a stable
 * `errorClass` so the planner can decide whether to retry or move on.
 */
export type ToolResult<T> =
  | { ok: true; data: T; evidence?: EvidenceDraft[] }
  | { ok: false; errorClass: string; message: string };

// ─── Evidence draft (ADR-0014 §3, §7) ───────────────────────────────

/**
 * Shape the evidence emitter converts into `Evidence(sourceType=CONNECTOR)`
 * rows.
 *
 * TODO (Slice 1): align exactly with the Evidence table columns —
 *   - `domain` → `Evidence.domain`
 *   - `content` → `Evidence.content` (also feeds embedding pass)
 *   - `confidence` → `Evidence.confidence`
 *   - `provenance` → serialised into `Evidence.chunkSource` JSON as the
 *     provenance envelope documented in ADR-0014 §7
 *   - `contentSha` → `Evidence.contentSha` for cross-run dedup
 * Extend `EvidenceProvenance` with the full `repo | ci | cloud | tool`
 * union from the ADR once the first tool lands.
 */
export interface EvidenceDraft {
  domain: string;
  content: string;
  confidence: number;
  provenance: EvidenceProvenance;
  /** Optional: tool-provided SHA. Emitter computes one if absent. */
  contentSha?: string;
}

/**
 * Minimal provenance union for Slice 0. Slice 1 replaces this with the
 * full discriminated union from ADR-0014 §3 (repo / ci / cloud / tool).
 */
export type EvidenceProvenance = {
  kind: "repo" | "ci" | "cloud" | "tool";
  // TODO (Slice 1): replace this catch-all with the typed variants.
  ref: Record<string, unknown>;
};

// ─── Planner output (ADR-0014 §3) ───────────────────────────────────

/**
 * One parsed decision from the planner. Either a tool invocation or
 * the model's signal that the run is done. The harness loop consumes
 * a sequence of these across steps.
 */
export type PlanStep =
  | { kind: "tool"; tool: string; args: unknown }
  | { kind: "stop"; reason: string };
