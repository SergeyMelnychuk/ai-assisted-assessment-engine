# ADR-0012: Anthropic prompt caching + cost instrumentation

- **Status:** Accepted
- **Date:** 2026-04-18
- **Deciders:** Phase 3 core team
- **Related:** ADR-0002 (per-domain fan-out), ADR-0003 (embedding model),
  roadmap §Week 8, `apps/web/src/server/services/ai/pricing.ts`,
  `apps/web/src/server/services/ai/claude-client.ts`

## Context

By the end of Week 7 the pipeline issued Claude calls from four
distinct call-sites — per-domain analysis, per-domain scoring,
deliverable sections, question follow-ups — plus two OpenAI embedding
call-sites (ingest and retrieval-query). Each call accrued tokens but
only a handful wrote anything to `AuditLog`, and none wrote cost.

Two forces pushed for tightening this in Week 8:

1. **Operator visibility.** The only way to answer "what did this
   engagement cost us in AI?" was to tail the worker log and add up
   tokens by hand. There was no per-engagement rollup anywhere.
2. **Spend discipline.** Per-domain fan-out (ADR-0002) sends the
   same ~6K-token system prompt + framework rubric on every one of
   the 8 per-domain calls. Anthropic shipped ephemeral prompt
   caching in late 2024; at ~$3/MTok input list price, caching the
   stable portion saves ~20% of input spend per assessment for
   roughly half a day of wiring work.

The remaining hyperparameter-sweep items in the Week 8 roadmap
(chunk-size sweep, top-K sweep with precision@10 measured on a real
corpus) need a labelled evaluation set and a day we didn't have;
those are deferred to post-Phase-3. This ADR still surfaces the
tuning *knobs* as named constants so the sweep, when it runs, edits
one file instead of four.

## Decision

Three interlocking pieces, landed together:

### 1. Cost audit trail

Every AI call writes one `AuditLog` row with
`action = 'AI_CALL'`. `details` carries:

```jsonc
{
  "callType": "analysis" | "scoring" | "deliverable" | "embedding" | "retrieval-query",
  "model":    "claude-sonnet-4-5" | "text-embedding-3-small" | …,
  "inputTokens":              Integer,
  "outputTokens":             Integer,
  "cacheReadInputTokens":     Integer,   // Anthropic only, 0 otherwise
  "cacheCreationInputTokens": Integer,   // Anthropic only, 0 otherwise
  "estimatedCostUsd":         Number,    // computed client-side
  "pricingVersion":           String     // e.g. "2026-04-18"
}
```

`entityType` / `entityId` ties the row to whichever Prisma entity
makes the rollup tractable — `Assessment` for analysis / scoring /
deliverable / retrieval-query, `Document` for ingest embedding.

Pricing lives in `apps/web/src/server/services/ai/pricing.ts`. One
constant map `PRICING` maps model id → `{ inputPer1K, outputPer1K,
cacheWritePer1K?, cacheReadPer1K? }`. `PRICING_VERSION` is stamped on
every row so historical rows can be recosted if we ever re-run the
math against a newer price list.

The write path is best-effort: `writeAiCallAudit()` swallows DB errors
with a warn-only log line. Cost instrumentation must never wedge the
foreground AI call.

### 2. Anthropic ephemeral prompt caching

`callClaude({ cacheSystem: true, … })` sends the system prompt as a
single content block with `cache_control: { type: "ephemeral" }`. The
user turn (retrieved chunks, domain question, project blurb) stays
uncached — it varies per call.

Enabled on:

- **Per-domain analysis** — `analysis-engine.ts#runOneDomain`.
- **Per-domain scoring** — `scoring-service.ts`.

Not enabled on deliverable sections: one call per generate, so the
cache would be written and never read. Not enabled on embedding
(model-side unsupported) or on the vision path in `callClaudeWithImage`
(single-shot, varying image).

Expected hit-rate: **~87.5% after the first call per pass**. Each pass
makes 8 domain calls with the identical system prompt; the first writes
the cache, the remaining 7 read it. For a two-pass assessment
(analysis + scoring) that's 14 cached calls and 2 writes.

**Fallback behaviour.** If the SDK or the provider returns without the
`cache_creation_input_tokens` / `cache_read_input_tokens` usage fields
(older SDK, cache disabled server-side, request path that doesn't
honour the cache_control block), the cost math degrades to the
baseline input rate — we pay full price for those tokens, we don't
crash. The audit row records 0s for both cache counters, which is
distinguishable from "cache hit with 0 read" because the input-token
count itself reflects whether caching kicked in.

### 3. Retrieval constants surfaced

`apps/web/src/server/services/retrieval/retrieval-config.ts` exports:

- `TOP_K_ANALYSIS = 20` — default top-K when the analysis engine
  retrieves per-call. Wide enough for diverse evidence without
  overflowing the prompt budget on an 8-domain run.
- `TOP_K_FOLLOWUP = 10` — default top-K when a follow-up path
  retrieves. Tighter because follow-ups only need enough signal to
  spot gaps.
- `MIN_COSINE_SIMILARITY = 0.3` — default floor for inclusion.
  Chunks scoring below are dropped rather than padding with near-
  random noise (consistent with ADR-0006 "widen don't pad").

`rag-retriever.ts` now sources its default top-K and default
minSimilarity from this file. `analysis-engine.ts` sources its
per-domain K from it.

## Alternatives considered

- **Log cost in a dedicated table** — cleaner schema, but doubles
  the number of rows the worker writes on every AI call and forks the
  audit trail. Chose to overload `AuditLog` because the aggregation
  SQL is cheap (JSON field extraction + SUM over an indexed
  `created_at`) and a dedicated `AiCallLog` table would have to be
  joined to `AuditLog` anyway for provenance. Can migrate later if
  `AuditLog` gets too heavy.
- **Write pricing to env, not a constant file** — would let us bump
  prices without a deploy, but the upside is marginal (prices change
  quarterly, at most) and a 12-line TypeScript file is easier to
  review than a sprawling `.env.example`. Rejected.
- **Cache the user turn too** — would catch cases where the same
  retrieved chunks feed two AI calls. Rejected because retrieval is
  per-domain and per-run, so the chunk set rarely repeats inside a
  single assessment. Would also risk stale caching across re-runs.
- **Skip caching on scoring** — scoring calls are shorter than
  analysis calls so the per-call savings are smaller. Kept caching
  because the system prompt for scoring is still ~2K tokens and the
  wiring is already paid for by the analysis path.

## Consequences

- **Positive**
  - Every AI call is now costable post-hoc by anyone with `psql`.
  - `/admin/cost` surfaces per-engagement spend without a tooling
    dep.
  - ~20% input-token saving on the analysis + scoring passes
    compounds across every engagement.
  - Retrieval tuning is now a one-file edit.
- **Negative**
  - `AuditLog` grows faster. An 8-domain assessment produces ~17
    extra rows (8 analysis + 8 scoring + 1 deliverable). Add an
    archive job for `AuditLog` older than N months when volume
    matters.
  - The `cacheSystem` flag couples the Claude client to a specific
    SDK shape. A major Anthropic SDK bump that removes
    `cache_control` will need a migration.
- **Neutral**
  - `AuditLog.action` enum grows by one value (`AI_CALL`). Every
    dashboard that filters by action now needs to opt-in or opt-out
    of the new rows.
  - Pricing table lives next to the call-site, not in env. Operators
    editing prices need a deploy, not a config change.

## Follow-ups

- [ ] Chunking hyperparameter sweep (600 / 800 / 1200 token chunks,
      precision@10 on a real corpus). Deferred post-Phase-3 —
      blocked on labelled evaluation set.
- [ ] Top-K sweep (10 / 20 / 30 / 50). Same blocker.
- [ ] `/admin/cost` CSV export. Easy once the tRPC procedure is in
      place.
- [ ] Archive / partition `AuditLog` once volume justifies.
- [ ] Consider caching the deliverable-sections system prompt if we
      ever generate multiple deliverables per engagement.
- [ ] Integration test that an analysis run's audit-row cost sum
      matches the SDK-reported token cost within ±10%. Smoke
      `smoke-cost.sh` is a weaker proxy today.

## References

- `docs/design/phase-3-roadmap.md` §Week 8
- `docs/architecture/README.md` §12 "Observability", §15 "Known limits"
- `apps/web/src/server/services/ai/pricing.ts`
- `apps/web/src/server/services/ai/claude-client.ts`
- `apps/web/src/server/services/retrieval/retrieval-config.ts`
- External: Anthropic prompt caching — https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- External: Anthropic pricing — https://www.anthropic.com/pricing
- External: OpenAI embeddings pricing — https://openai.com/api/pricing/
