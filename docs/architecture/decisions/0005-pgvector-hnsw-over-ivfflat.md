# ADR-0005: Vector index — pgvector HNSW over IVFFlat

- **Status:** Accepted
- **Date:** 2026-04-17
- **Deciders:** Serhii Melnychuk (project lead), Claude agents during Phase 3 build
- **Related:** ADR-0003 (embedding model), ADR-0004 (chunking), `docs/design/phase-3-roadmap.md` §Week 3 / §Week 4

## Context

The Evidence table now carries 1536-dim vectors (ADR-0003). Week 4
will query them with cosine similarity to replace the MVP's
"take: 80" evidence selection. We need an index — a sequential scan
over every chunk is fine at 1,000 rows and unworkable at 100,000.

pgvector ships two index families: **IVFFlat** (inverted-file over
k-means centroids) and **HNSW** (hierarchical navigable small-world
graph). Each trades off recall, latency, build time, and write cost
differently. Picking one shapes how we think about retrieval
correctness, how we ingest at scale, and what we measure in Week 8's
perf sweep.

## Decision

Use **HNSW with cosine distance** (`vector_cosine_ops`) on the
`embedding` column, created in the Week 3 migration
(`apps/web/prisma/migrations/20260418000000_embedding_foundation/migration.sql`):

```sql
CREATE INDEX evidences_embedding_hnsw_idx
  ON evidences
  USING hnsw (embedding vector_cosine_ops);
```

Index parameters stay at pgvector defaults (`m = 16`,
`ef_construction = 64`) for MVP. Week 8's perf sweep owns the
tuning decision on a real corpus.

## Alternatives considered

- **IVFFlat.** Faster to build, smaller on disk, lower recall on the
  same parameter budget. Tunable via `lists` (number of centroids) —
  the rule-of-thumb is `rows / 1000` for datasets up to ~1M rows.
  Rejected because:
  1. IVFFlat's recall curve is noticeably worse than HNSW's at the
     latency we care about (p95 < 200 ms on ~100k rows). The
     retrieval-quality lever matters more to us than the index
     build-time lever.
  2. IVFFlat requires a **rebuild** when the dataset grows more than
     ~2× the `lists` target, because the centroids become stale.
     HNSW grows incrementally without that discontinuity.
  3. For the engagement size in the roadmap's cost appendix (~14 M
     tokens / tens of thousands of chunks), HNSW builds in seconds
     on commodity Postgres.
- **No index — sequential scan.** Viable at fixture-sized DBs (<10k
  chunks). Rejected because retrieval latency would become
  unpredictable as engagements grow, and Week 4's UX depends on the
  retrieval step being fast enough to run synchronously inside the
  analysis worker.
- **External vector store** (Pinecone, Qdrant, Weaviate, Chroma).
  Rejected as a structural choice — pgvector was enabled in Task 1
  specifically to avoid this. Joining vector search to SQL (for
  authz filters, domain filters, assessment scoping) is a
  first-class operation in pgvector and a cross-system join
  elsewhere. Also one fewer vendor, one fewer SLA, one fewer
  credential to rotate.

## Consequences

- **Positive.** Retrieval latency stays predictable as the Evidence
  table grows. Week 4's in-worker retrieval stays synchronous; we
  don't need to promote it into a separate job.
- **Positive.** Writes are O(log N) — fine for the ~hundreds of
  chunks per doc write path. Bulk load (backfill, archive ingest) is
  where HNSW cost shows; see below.
- **Positive.** Cosine distance (`<=>` operator) aligns with the
  embedding model's native similarity metric. No normalisation
  drift.
- **Negative.** HNSW index build is slower than IVFFlat during bulk
  writes. Week 5's archive ingest and the Week 3 backfill script
  both do fan-out inserts against an indexed table. At the MVP scale
  in the cost appendix this is still seconds-to-tens-of-seconds; if
  it becomes a real problem, the mitigation is documented under
  "Risks" in the roadmap — drop the index, bulk-load, rebuild.
- **Negative.** HNSW memory usage is higher than IVFFlat. At our
  scale (up to ~10 M vectors per table per the roadmap's assumption
  section) this is not a Postgres-host concern on any reasonable
  box.
- **Neutral.** `m` and `ef_construction` are at defaults. The Week 8
  perf sweep owns the decision whether to tune them; until then
  "defaults" is the answer you should give.

## Follow-ups

- [ ] Week 4 — build `rag-retriever.ts`; exercise the index with
      `EXPLAIN` to confirm it's being used (not a sequential scan).
- [ ] Week 5 / Week 8 — if bulk-load index cost becomes a bottleneck,
      add the "drop index, bulk-load, rebuild" pattern to the archive
      and backfill paths.
- [ ] Week 8 — sweep `m` (8 / 16 / 32) and `ef_construction` (64 /
      128 / 200) against a real corpus; record in a perf appendix.

## References

- `apps/web/prisma/migrations/20260418000000_embedding_foundation/migration.sql`
- `apps/web/src/server/services/ai/embedding-service.ts` — `EMBEDDING_DIMENSIONS`
- pgvector docs — https://github.com/pgvector/pgvector#hnsw
- `docs/design/phase-3-roadmap.md` §Week 4 perf test; §Appendix B Risks
