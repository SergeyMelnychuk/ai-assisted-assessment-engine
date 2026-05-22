# ADR-0002: Per-domain analysis fan-out

- **Status:** Accepted
- **Date:** 2026-04-17
- **Deciders:** Engineering
- **Related:** `docs/design/phase-3-roadmap.md` §Week 2; `docs/architecture/README.md` §6 (AI integration); ADR-0001 (decouple ingest from analyse)

## Context

Phase 3 Week 1 (ADR-0001) gave us a clean line between ingest (AI-free)
and analyse (Claude). The analyse step, however, still runs as a
**single combined Claude call** that asks the model to reason over
all active domains at once (today: 8 for a full architecture
assessment — security, performance, observability, etc.).

Two concrete failure modes show up in practice:

1. **Output-budget truncation.** 8 domains × ~500 tokens of findings +
   risks + recommendations exceeds the single-call `max_tokens=8192`
   ceiling. The response appears truncated, JSON parsing fails, and
   the whole run is discarded — including the 6 domains that finished
   inside the budget. The error-classifier already surfaces this as
   `AI_OUTPUT_TOO_LARGE`; the fix has always been to split the call.
2. **Correlated blast radius.** A transient 529 / rate-limit / empty
   response on a single combined call discards all 8 domains' work.
   Retries re-bill the full prompt.

Week 2's acceptance criterion in the roadmap is "effective output
capacity ~8×" without schema work; that's achievable only by running
the call once per domain.

## Decision

Fan out one Claude call per `assessment.activeDomains` entry for both
`analysis-engine.runAnalysis` and `scoring-service.runDomainScoring`.
Calls run through a small in-process worker pool capped at
`DOMAIN_ANALYSIS_CONCURRENCY = 1` (**amended 2026-04 — originally
shipped at 2; dropped to 1 after we observed `rate_limit_error`
429s from Anthropic's 30k input-tokens-per-minute small-tier org
ceiling. Each per-domain prompt is 5–15k input tokens, so two in
flight blew the bucket. Sequential with a 2s inter-call delay
(`DOMAIN_ANALYSIS_INTER_CALL_DELAY_MS`) fits comfortably under the
ceiling without any backoff/retry machinery. Re-raising to 2+ is
still the Follow-up below, gated on paid-tier TPM headroom**).
Scoring cap is the same constant conceptually; see
`apps/web/src/server/services/scoring-service.ts`. Each call's
outcome is isolated — failures are captured as `{ domain, status:
"failed", error }` entries in the aggregated result; succeeded
domains' findings/risks/recs/scores are persisted normally.

### Concrete shape

- `apps/web/src/server/services/analysis-engine.ts` — `runAnalysis`
  loops over `activeDomains`, dispatches via `runWithConcurrency`,
  merges per-domain outputs into a single DB transaction at the end.
  Returns `{ …, perDomain: DomainAnalysisStatus[] }`.
- `apps/web/src/server/services/scoring-service.ts` — mirror shape.
  One call per domain, `maxTokens: 1024` (much tighter than the old
  combined `3000`).
- `apps/web/src/server/services/ai/prompts/finding-generation.ts` —
  reuses the existing `FINDING_GENERATION_SYSTEM_PROMPT` (cache-
  friendly for the Week 8 prompt-caching work); new
  `buildPerDomainFindingPrompt` scopes the user content to one domain,
  pins the domain field value, and clamps to `MAX_CLAUDE_INPUT_CHARS =
  40_000` (down from the combined call's effective ~120k).
- `apps/web/src/server/services/ai/prompts/domain-scoring.ts` —
  new `buildPerDomainScoringPrompt`.
- `apps/web/src/server/queue/jobs/run-analysis.ts` — writes a single
  aggregate `RUN_ANALYSIS` audit-log row whose `details.domains`
  carries `{ analysis: { security: "ok", performance: "failed", …},
  scoring: { … } }`. If **every** domain failed in both passes the
  job re-throws the first error so the existing
  `RUN_ANALYSIS_FAILED` path kicks in.
- `apps/web/src/server/services/ai/error-classifier.ts` — new
  `ANALYSIS_PARTIAL_FAILURE` category and
  `classifyPartialAnalysisFailure()` helper the UI can use to render a
  banner above the per-domain status strip.
- `apps/web/src/server/trpc/routers/analysis.ts` — new
  `analysis.perDomainStatus` query surfaces the per-domain status map
  to the UI; the existing `lastFailure` query is unchanged.
- `apps/web/src/components/analysis/analysis-page-shell.tsx` — renders
  per-domain status badges and a partial-failure banner using the
  shared `FailureBanner` component.

### Budget math

**Per-call output budget:** `maxTokens = 4096` for findings (was
`8192` combined); `maxTokens = 1024` for scoring (was `3000`
combined). 8 domains × 4096 ≈ 32 768 tokens of *effective* output
capacity for findings, roughly **8× the old combined ceiling**. This
matches the roadmap's "~8× effective output" claim verbatim.

**Per-call input budget:** clamped to `MAX_CLAUDE_INPUT_CHARS =
40_000` (≈10k tokens). Each per-domain call reasons over one domain's
evidence slice plus shared project context, so we don't need the
generous per-doc truncation that the combined call required. 40k is
conservative against Sonnet 4.5's 200k context window but leaves
room for the rubric, KB patterns, and future prompt-caching metadata.

**Wall-clock (as originally shipped, cap 2):** on an 8-domain run
wall-clock dropped from ~1× (serial combined call) to ~0.5× (4
waves of 2 parallel calls). Not as dramatic as concurrency=8 would
be, but rate-limit-safe on shared Anthropic accounts — see ADR-0002's
Risks section below.

**Wall-clock (2026-04 amendment, cap 1):** cap=1 + 2s inter-call
delay means the analysis pass runs ~8 × (per-call latency + 2s) ≈
4–6 minutes on an 8-domain run. Scoring pass adds another ~3–4
minutes. Total Draft (FAST) wall-clock is 2-3× the cap=2 number
but it's the price of the free-tier rate-limit envelope; paid-tier
re-raise is tracked in Follow-ups. THOROUGH mode adds the verifier
pass on top (see ADR-0013), landing at 5-6 min total.

## Alternatives considered

- **Single call with a bigger `maxTokens`.** Rejected. The practical
  ceiling on Sonnet 4.5 is 8192 output tokens per call; requesting
  more is refused. Even if the SDK allowed it, output cost scales
  linearly and a single truncation still wipes the entire run. The
  output-budget problem is intrinsic to the "one call, all domains"
  shape.
- **`p-limit` / external semaphore library.** Rejected. The in-house
  `runWithConcurrency` helper is ~20 lines and doesn't introduce a
  supply-chain dependency for a one-function need. If we grow other
  concurrency-bounded workflows later we can factor it out.
- **Split by tier (domain-group) rather than per-domain.** E.g. group
  security + auth into one call, performance + scalability into
  another. Rejected — the grouping is framework-specific and would
  re-introduce the truncation risk on the largest group. Per-domain
  is the finest safe granularity and matches the rubric's own
  boundary.
- **Concurrency cap 4–8 (faster wall-clock).** Rejected for this
  week. An 8-wide concurrent burst against a shared Anthropic
  account demonstrably trips rate limits on the development tier.
  Cap 2 is deliberately conservative; we can raise it in Week 8
  once we have cost/rate-limit instrumentation to back the change.
- **Remove the legacy combined `buildFindingGenerationPrompt`.**
  Rejected for this week — no caller uses it today, but the prompt
  docstring and system prompt are shared with the per-domain
  builder, and keeping the combined builder is a two-way-door that
  costs us nothing. If it rots we delete it in Week 8's cleanup.

## Consequences

- **Positive.** Per-domain failures are isolated — a 529 on security
  no longer wipes the other 7 domains' findings. Effective output
  budget is ~8× what it was, matching the roadmap's capacity target.
  Wall-clock improves modestly (~2×) with cap=2 on 8-domain runs.
  The system prompt is identical across per-domain calls, which sets
  up Week 8's prompt-caching for a ~20% input-token discount on
  every run.
- **Negative.** Per-run token spend goes up: 8 calls × per-call
  overhead (system prompt, shared context) vs. 1 combined call.
  Rough measurement on the dev fixture shows ~15–25% more input
  tokens per run before prompt caching lands; prompt caching in
  Week 8 recovers most of it. The audit-log schema now carries a
  `partial` flag — callers inspecting `RUN_ANALYSIS` rows need to
  handle the mixed-success case. We surface this on the UI with a
  per-domain status strip and an amber FailureBanner so consultants
  aren't surprised.
- **Neutral.** The single-call `buildFindingGenerationPrompt` stays
  exported for now; it's unused in production and costs nothing to
  keep. The `runAnalysis` function grew a third parameter
  (`callClaudeImpl`) with a sensible default — tests can inject a
  stub without mocking the SDK module.

## Reversibility

**Two-way door.** The fan-out is a pure service-layer refactor —
no schema changes, no migration. Reverting means restoring the old
`runAnalysis` and `runDomainScoring` bodies and pointing
`run-analysis.ts` back at their single-call shape. The
per-domain-status audit rows degrade gracefully: the
`analysis.perDomainStatus` query returns `null` when no
post-revert rows exist, and `analysis.lastFailure` still works.

A future env flag (`ANALYSIS_FAN_OUT=0`) could gate the behaviour
if we want to hot-swap during an incident, but the complexity
isn't worth carrying until we have evidence we need it.

## Follow-ups

- [ ] Week 4 (RAG): replace the `take: 80` evidence fetch with
      per-domain retrieval, composing cleanly with the fan-out.
- [ ] Week 8 (prompt caching): enable Anthropic prompt caching on
      the shared system prompt + framework rubric — savings compound
      with per-domain calls.
- [ ] Week 8 (cost instrumentation): per-domain token breakdown in
      the admin cost dashboard. The `details.tokens.analysis` /
      `details.tokens.scoring` audit row fields already carry the
      aggregate; per-domain detail is in the worker log.
- [ ] Revisit the concurrency cap once rate-limit headroom is
      measured — raising to 2 on a paid Anthropic tier (where the
      input-TPM ceiling is ~8× the free-tier 30k) should be safe
      and would halve analysis-pass wall-clock. 3–4 is a further
      step gated on instrumented 429-rate evidence.

## 2026-04-19 amendment — inter-call delay dropped to 0

`DOMAIN_ANALYSIS_INTER_CALL_DELAY_MS` was lowered from `2_000` to
`0`. The original 2 s gap was sized for the `concurrency = 2` era
where it spaced parallel bursts away from each other; at the
current `concurrency = 1` each call already takes 30–60 s of Claude
round-trip and the 2 s gap was pure idle wall time (~14 s wasted
per 8-domain run) with **no rate-limit benefit** — ITPM is a
rolling-minute average, not a per-request cooldown, so inserting a
pause between sequential calls does not raise the per-minute token
ceiling.

Saves ~30 s of P50 wall time on a full analysis pass for zero
downside. The delay constant stays in code (rather than being
deleted) as a parameter we can raise again if concurrency is ever
bumped back above 1 without a tier upgrade.

## References

- `docs/design/phase-3-roadmap.md` §Week 2
- `docs/architecture/README.md` §6
- `apps/web/src/server/services/analysis-engine.ts`
- `apps/web/src/server/services/scoring-service.ts`
- `apps/web/src/server/services/ai/prompts/finding-generation.ts`
- `apps/web/src/server/services/ai/prompts/domain-scoring.ts`
- `apps/web/src/server/queue/jobs/run-analysis.ts`
- Anthropic docs on rate limits: <https://docs.claude.com/en/api/rate-limits>
