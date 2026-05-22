# ADR-0006: Hybrid retrieval with domain-filter fallback

- **Status:** Accepted
- **Date:** 2026-04-17
- **Deciders:** Engineering
- **Related:** `docs/design/phase-3-roadmap.md` §Week 4; ADR-0003 (embedding model), ADR-0005 (HNSW); `docs/architecture/README.md` §5, §15

## Context

Week 4 wires the pgvector retrieval layer into every AI call that used
to do `evidence.findMany({ take: 80 })`. The natural shape is
"embed the query → cosine-rank chunks → take top-K". Most callers also
want to scope to a specific domain (e.g. the analysis engine asks
"what's the posture for the `security` domain?" and expects
security-tagged evidence first).

The load-bearing question: what happens when the domain-filtered
result underfills? Real-world corpora are uneven — a small engagement
might have only two or three chunks tagged `operations`, not enough
to give Claude useful context. Three policy options were on the table:

1. **Return what we have, even if topK is 3.** Conservative; lets the
   AI see only high-signal chunks but starves it of context.
2. **Pad with arbitrary recent rows** (the pre-Week-4 shape). Keeps
   the prompt full but the padding has no relationship to the query.
3. **Widen the filter** — re-run the query without the domain
   restriction and merge. Trades a slightly off-topic chunk for
   nothing-at-all.

Option 2 is what we're leaving behind. Option 1 breaks in cases where
a domain is genuinely under-represented in the corpus but the AI still
needs to reason about it. Option 3 is the one that holds up across
both small and large engagements.

## Decision

Implement option 3 in `apps/web/src/server/services/rag-retriever.ts`:

```
retrieve({ assessmentId, query, domain?, topK = 20, minSimilarity = 0 })
```

- Embed the query via the shared `embedding-service` (fake-mode in CI,
  OpenAI `text-embedding-3-small` in prod).
- Issue a raw-SQL cosine query against `evidences.embedding` using the
  `<=>` operator so the HNSW index (`evidences_embedding_hnsw_idx`)
  picks up. Similarity = `1 - (embedding <=> $query)`.
- If `domain` is set and the primary result either returns fewer than
  `topK` rows or fewer than `max(5, topK / 2)` rows clear the
  `minSimilarity` floor, re-run **without** the domain filter, merge
  preserving the primary order, de-dup by `evidenceId`, and stop once
  the merged list fills topK.
- `minSimilarity` defaults to `0` (keep everything). Callers that want
  to enforce a quality floor (e.g. an admin "Explain this finding" UI)
  can raise it. See Week 8 tuning for the calibration loop.

Widen-not-pad is the crisp one-liner.

## Alternatives considered

- **Return what we have (option 1 above).** Rejected. The per-domain
  analysis prompt needs ~10 chunks of context to produce useful
  findings; giving it 3 produces vague output and the reviewer can't
  tell if the gap is a genuine insight or a retrieval-underfill.
- **Pad with recent rows (option 2 above).** Rejected. This is the
  pre-Week-4 shape we're leaving behind — the noise-to-signal is
  terrible and it's what the RAG wiring is meant to fix.
- **Retrieve from all domains by default, filter post-hoc.** Rejected.
  Gives every AI call the same chunks and undermines the cost-reducing
  intent of per-domain retrieval (one tight query per domain vs. one
  broad query re-filtered N times).
- **Multiple HNSW indexes per domain.** Rejected. pgvector HNSW
  doesn't support partial indexes over arbitrary columns without
  workarounds, and the domain count is small enough that a single
  index + `WHERE domain = $1` is fast. Re-evaluate if a tenant-per-
  domain data model lands post-roadmap.

## Consequences

- **Positive.** Every AI call sees a non-trivial evidence set even on
  thin corpora. The widen step is opt-out (don't pass `domain`) so
  callers with a global query pay nothing. `minSimilarity` gives a
  knob for quality-over-quantity without changing the default
  behaviour.
- **Negative.** The second SQL query is unconditional when the
  primary underfills — adds one round-trip of latency on
  domain-scoped calls in thin corpora. Measurable but acceptable for
  MVP (both queries go through the same HNSW index).
- **Neutral.** The merged result can mix domain-tagged and
  off-domain chunks, so call sites that care must read the `domain`
  field on each `ChunkResult` rather than assuming the filter held.
  The analysis engine does this; it's a small contract change.

## Follow-ups

- [ ] Week 8: tune `minSimilarity` per call-type (analysis may want
      0.3, follow-ups may want 0.0 to cast a wider net). Calibrate
      against a precision@10 fixture.
- [ ] Post-roadmap: if a genuinely multi-domain query shape emerges
      (e.g. "security OR data"), add domain-array support instead of
      a single string.
- [ ] Week 8 perf test: confirm HNSW + `domain =` predicate stays
      under 200 ms p95 at 10k rows; if not, consider a composite
      index.

## References

- `docs/design/phase-3-roadmap.md` §Week 4
- `docs/architecture/README.md` §5, §15
- `apps/web/src/server/services/rag-retriever.ts`
- `apps/web/src/server/services/rag-retriever.test.ts`
- ADR-0003 (embedding model), ADR-0005 (HNSW index)
