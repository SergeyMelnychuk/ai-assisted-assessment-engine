/**
 * Budget tracker — ADR-0014 §5.
 *
 * In-memory counters for a single agent run, keyed on the six caps the
 * ADR pins: steps / tokens / toolCalls / durationMs / sandboxSeconds /
 * evidenceRows. The harness calls `increment` after every step and
 * `check` before dispatching the next tool call; exhaustion ends the
 * run with `BUDGET_EXHAUSTED` and the partial evidence is preserved.
 *
 * Slice 0: in-memory only. Slice 1 wires this to `AgentRun.usage` JSON
 * via the trajectory writer so an interrupted run resumes with the
 * right counters.
 *
 * See:
 *   docs/architecture/decisions/0014-agent-harness-for-evidence-collection.md
 */

import type { AgentRunBudget, AgentRunUsage } from "./types";

export class BudgetTracker {
  private readonly _budget: AgentRunBudget;
  private readonly _usage: AgentRunUsage;

  constructor(budget: AgentRunBudget) {
    this._budget = budget;
    this._usage = {
      maxSteps: 0,
      maxTokens: 0,
      maxToolCalls: 0,
      maxDurationMs: 0,
      maxSandboxSeconds: 0,
      maxEvidenceRows: 0,
    };
  }

  /**
   * Add `amount` to the running tally for one cap. `kind` uses the
   * `AgentRunBudget` key naming so tallies line up 1:1 with caps.
   */
  increment(kind: keyof AgentRunUsage, amount: number): void {
    // Stub: real implementation persists to `AgentRun.usage` in
    // Slice 1 and is safe against concurrent step writes.
    this._usage[kind] += amount;
  }

  /** Current tallies (read-only snapshot). */
  usage(): AgentRunUsage {
    return { ...this._usage };
  }

  /**
   * Check whether the run may continue. Returns the first exhausted
   * cap if any — the harness reports that key as the `endReason`.
   */
  check(): { ok: true } | { ok: false; exhausted: keyof AgentRunUsage } {
    // Stub: implementation lands in Slice 1; keeping the shape pinned
    // so harness tests can mock it without rewriting call-sites.
    const keys: (keyof AgentRunBudget)[] = [
      "maxSteps",
      "maxTokens",
      "maxToolCalls",
      "maxDurationMs",
      "maxSandboxSeconds",
      "maxEvidenceRows",
    ];
    for (const k of keys) {
      if (this._usage[k] >= this._budget[k]) {
        return { ok: false, exhausted: k };
      }
    }
    return { ok: true };
  }
}
