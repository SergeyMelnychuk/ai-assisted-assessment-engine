# ADR-0013: FAST/THOROUGH analysis modes and verifier pass

- **Status:** Accepted
- **Date:** 2026-04-18
- **Deciders:** Engineering (Phase 3 Week 9)
- **Related:** ADR-0002 (per-domain fan-out), ADR-0012 (prompt caching & cost instrumentation), `docs/design/phase-3-roadmap.md` §Week 9

## Context

Phase 3 Week 8 introduced a second "verifier" Claude call per domain —
a strict reviewer that dropped findings/risks/recommendations that
weren't evidence-grounded. It improved output quality on hand-reviewed
assessments but had four problems:

1. **Cost doubling with no opt-out.** Every run paid for ~16 Claude
   calls instead of ~8. There was no flag, no A/B, no way for the
   user to say "I want a cheap run now."
2. **Verifier selection by reference-equality.** The engine decided
   whether to call the real verifier by comparing `callClaudeImpl ===
   defaultDomainCaller`. Any test or tracing wrapper around the
   generator silently demoted the verifier to a local heuristic —
   a footgun waiting to fire in production.
3. **Silent swallow on verifier failure.** A verifier exception was
   `catch {}`'d and the unverified output was kept. No audit row,
   no log — impossible to measure verifier reliability.
4. **Conflated cost accounting.** Verifier calls were audited as
   `callType: "analysis"`, indistinguishable from generator calls in
   the usage dashboard. We couldn't actually measure the ROI of the
   pass we'd just added.
5. **Weak prompt.** The verifier system prompt asked the model to
   drop "weakly supported" items without defining *weak*. Behaviour
   drifted between runs.
6. **Magic thresholds.** The heuristic fallback had numeric
   confidence floors (0.7 / 0.75 / 0.4 / 0.6) inline with zero
   rationale.

We needed a way to ship the verifier as a deliberate, measurable
opt-in rather than a silent cost multiplier.

## Decision

Introduce two execution modes, surfaced in the UI at run time. The
UI labels them by *outcome* (Draft / Reviewed); the server-side
enum keeps the mechanical labels (FAST / THOROUGH) because they
describe the engine path, not the product intent.

- **FAST** — "Draft" in the UI. Generator only. Per-domain analysis
  call + per-domain scoring call → ~16 Claude calls across 8
  domains, 2-3 minute wall time. Used for iteration.
- **THOROUGH** — "Reviewed" in the UI. Generator + per-domain
  verifier + scoring → ~24 Claude calls, 5-6 minute wall time,
  roughly 2× the cost of Draft. Used when the user wants a
  defensible output.

Mode flows end to end:

```
RunAnalysisButton (Draft=FAST | Reviewed=THOROUGH)
  → trpc analysis.run { mode }
  → enqueueRunAnalysis(assessmentId, mode)
  → BullMQ job payload { type: "run-analysis", assessmentId, mode }
  → runAnalysisJob(assessmentId, mode)
  → runAnalysis(db, assessmentId, _, _, mode, verifierImpl?)
  → runOneDomain({ mode, verifierImpl }) — short-circuits when mode !== "THOROUGH"
```

Concrete shape changes:

- **New type** `AnalysisMode = "FAST" | "THOROUGH"` in
  `server/services/analysis-mode.ts`, with `DEFAULT_ANALYSIS_MODE =
  "FAST"`. The default applies to legacy callers (retry-after-failure
  button, BullMQ jobs enqueued before this migration).
- **New `callType`** `"analysis-verify"` in
  `server/services/ai/pricing.ts`, split from `"analysis"`. Admin
  usage dashboard now shows generator vs verifier spend independently.
- **Explicit `verifierImpl` parameter** on `runAnalysis`. Production
  passes `defaultAnalysisVerifier` (a real Claude call) only when
  `mode === "THOROUGH"`. Tests pass `heuristicAnalysisVerifier` (a
  pure-JS filter) or omit the arg to exercise the FAST path.
- **Audit on verifier failure.** A throw inside the verifier writes
  an `ANALYSIS_VERIFIER_FAILED` audit row (best-effort) and the
  generator output is kept. Previously silent.
- **Named thresholds.** `VERIFIER_THRESHOLDS` const with per-kind
  confidence floors + rationale comments. The heuristic fallback
  references the const; any future tuning is one edit.
- **Rewritten verifier prompt** (`prompts/analysis-verification.ts`)
  — six numbered rules (EVIDENCE GROUNDING, SPECIFICITY,
  NON-REDUNDANCY, RECOMMENDATION COHERENCE, ASSUMPTION DISCIPLINE,
  CALIBRATION) the model can actually apply.
- **Mode stamped into audit rows.** `ENQUEUE_ANALYSIS.details.mode`
  and `RUN_ANALYSIS.details.mode` carry the arm so the usage
  dashboard can bucket AI_CALL spend by FAST vs THOROUGH without
  re-deriving.
- **Per-call timeout.** Every Claude invocation is now wrapped in
  an `AbortController` with a `CLAUDE_CALL_TIMEOUT_MS` ceiling
  (default 120 s) in `server/services/ai/claude-client.ts`. A
  wedged / stalled call used to hold the BullMQ worker slot
  hostage — we've seen 10+ minute hangs on overloaded days that
  blocked every other assessment in the queue. On timeout we throw
  `ClaudeCallTimeoutError`; the classifier maps it to the new
  retryable `AI_TIMEOUT` category so the FailureBanner surfaces a
  Retry path without bouncing the run to a dead-letter. The 120 s
  value is chosen well above P99 observed generation latency
  (~45 s for a 4096-token call) while keeping a wedged call inside
  one BullMQ job's budget. Tighter per-call loops (verifier inside
  a THOROUGH run) still fit because each call gets its own 120 s
  window — not a shared budget across the domain.

## Alternatives considered

- **Keep verifier always-on, drop the cost.** Rejected — the cost
  *is* the point. We're making twice as many Claude calls; pretending
  that's free would show up on the next invoice.
- **Feature flag via env var.** Rejected — that's an ops knob, not a
  user choice. We want per-run A/B data, not "verifier was on this
  week, off that week."
- **Three modes (FAST / BALANCED / THOROUGH).** Rejected for now —
  we don't have a principled middle option, and two buttons is the
  minimum viable surface to get A/B signal. Room to add later.
- **Keep selecting verifier by `callClaudeImpl === defaultDomainCaller`.**
  Rejected — the bug it hides (any wrapper silently disabling the
  verifier in prod) is exactly the kind of thing you discover six
  months later by auditing token spend. Make the dependency
  explicit.

## Consequences

- **Positive**
  - Users choose cost vs quality per run. Retry buttons default to
    FAST so a single transient failure doesn't silently double spend.
  - `analysis-verify` split in the usage dashboard lets us compute
    verifier ROI directly: (quality delta) / (verifier token spend).
  - Verifier failures are visible (`ANALYSIS_VERIFIER_FAILED`
    audit row) instead of swallowed. Signal for tuning the prompt.
  - Explicit `verifierImpl` arg removes an entire class of
    "wrapper-silently-disables-the-feature" footgun.
- **Negative**
  - Two buttons is more UI surface than one — slight cognitive cost
    on the first run. Mitigated by hover tooltips that spell out
    the call count and wall-time delta.
  - Callers of `runAnalysis` now have a longer signature
    (`mode`, `verifierImpl`). Mitigated by sensible defaults —
    `mode = "FAST"`, `verifierImpl = undefined` works and does the
    cheap thing.
- **Neutral**
  - `AiCallType` union gained a member; any exhaustive switch on
    it (usage dashboard, pricing table) must handle the new case.
    TypeScript catches this at compile time.

## Follow-ups

- [ ] Retrospective after 2 weeks of real runs: what % of runs use
  THOROUGH, what's the verifier drop-rate, do users revert to FAST
  after trying it once?
- [ ] Consider auto-promoting to THOROUGH when the user clicks
  "Generate deliverable" — the deliverable is the point at which
  quality matters most.
- [ ] Wire `analysis-evaluation.ts` into CI with a fixture so
  `VERIFIER_THRESHOLDS` changes are gated on precision/recall deltas.

## References

- `docs/design/phase-3-roadmap.md` §Week 9
- `docs/architecture/README.md` §Analysis engine
- `apps/web/src/server/services/analysis-mode.ts`
- `apps/web/src/server/services/analysis-engine.ts` (`runOneDomain`,
  `VERIFIER_THRESHOLDS`, `heuristicAnalysisVerifier`)
- `apps/web/src/server/services/ai/prompts/analysis-verification.ts`
