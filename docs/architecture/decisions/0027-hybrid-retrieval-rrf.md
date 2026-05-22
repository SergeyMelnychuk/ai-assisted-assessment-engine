# ADR-0027: Hybrid retrieval — Postgres tsvector + cosine, fused via Reciprocal Rank Fusion

- **Status:** Accepted
- **Date:** 2026-05-12
- **Deciders:** Engineering
- **Related:**
  [ADR-0003](./0003-embedding-model-choice.md) (embedding model),
  [ADR-0005](./0005-pgvector-hnsw-over-ivfflat.md) (vector index),
  [ADR-0006](./0006-hybrid-retrieval-fallback.md) (the prior
  "widen-not-pad" fallback — *not* lexical hybrid; this ADR adds
  the actual lexical layer the name hinted at),
  [ADR-0007](./0007-query-construction-per-retrieval-point.md)
  (per-retrieval-point queries),
  [ADR-0023](./0023-db-backed-feature-flags.md) (flag mechanism).

## Context

Retrieval today is **pure semantic** — cosine similarity over
`text-embedding-3-small` vectors with an HNSW index. The "hybrid"
fallback in ADR-0006 is a misnomer: it widens the *vector* query
when the domain filter underfills, never adds lexical signal.

Pure semantic is great at "concept appears in chunk" and weak at:

- **Exact-string matches** — version numbers (`v2.4.1`), error codes
  (`ECONNRESET`), file paths (`/etc/nginx/sites-enabled/`),
  acronyms only used once in the corpus. Embeddings smear these
  into nearby strings.
- **Rare / domain-specific tokens** — long-tail technical names the
  embedding model saw infrequently during pre-training have weaker
  signal.
- **Boolean intent** — "auth AND OAuth2" gets one combined
  embedding; rank degrades vs literal intersection.

The Evidence Explorer's empty-state hint already labels the
behaviour ("semantic search, not keyword"). Users hit it: searching
for an exact AWS service name surfaces the wrong cluster.

The IR literature is clear that **lexical + dense, fused via
Reciprocal Rank Fusion (RRF)**, reliably beats either alone — has
been since the original RRF paper (Cormack et al., 2009). The
question isn't *whether* to add lexical, it's *how cheaply*.

## Decision

Add a Postgres-native lexical retrieval path alongside cosine and
fuse the two with **Reciprocal Rank Fusion**. Implementation:

**Data layer (a):** Postgres built-in full-text search.

- New `search_vec tsvector` column on `Evidence`, populated as a
  **stored generated column**: `GENERATED ALWAYS AS (to_tsvector(
  'english', content)) STORED`. No trigger, no ingest-worker code
  to keep in sync, no chance of drift.
- New **GIN index** on `search_vec` for fast `@@` matching.
- Migration backfill is implicit — generated columns populate on
  ALTER TABLE.

The Prisma schema carries the column as
`Unsupported("tsvector")?` (same shape as the existing
`embedding` column) — invisible to the Prisma client; the
retriever uses `$queryRaw` for both stages anyway.

**Merge mechanism (d):** Reciprocal Rank Fusion.

Per-chunk score is

```
score = (1 / (k + rank_dense)) + (1 / (k + rank_lexical))
```

with `k = 60`, the de-facto standard from the original RRF paper.
A chunk missing from either side contributes 0 from that side.
Top-`topK` by `score` is returned.

Rank-based (not score-based) fusion is the central choice — cosine
similarity is in `[0, 1]` and `ts_rank` is unbounded; they aren't
directly comparable. Ranks are scale-free, so RRF doesn't need
score normalisation.

**Query topology (f):** one SQL statement with two CTEs.

```sql
WITH dense AS (
  SELECT id,
         RANK() OVER (ORDER BY embedding <=> $vec::vector) AS rnk
  FROM evidences
  WHERE assessment_id = $aid AND embedding IS NOT NULL
        AND <domain / document_id filters compose here>
  ORDER BY embedding <=> $vec::vector
  LIMIT $candidateK    -- e.g. 50; widens the candidate pool for fusion
),
lexical AS (
  SELECT id,
         RANK() OVER (ORDER BY ts_rank(search_vec, q) DESC) AS rnk
  FROM evidences, plainto_tsquery('english', $query) AS q
  WHERE assessment_id = $aid AND search_vec @@ q
        AND <same filters>
  ORDER BY ts_rank(search_vec, q) DESC
  LIMIT $candidateK
)
SELECT e.id, e.content, ...,
       COALESCE(1.0 / (60 + d.rnk), 0)
     + COALESCE(1.0 / (60 + l.rnk), 0) AS rrf_score
FROM evidences e
LEFT JOIN dense   d USING (id)
LEFT JOIN lexical l USING (id)
WHERE d.id IS NOT NULL OR l.id IS NOT NULL
ORDER BY rrf_score DESC
LIMIT $topK;
```

One DB round-trip. Composable filters live in `Prisma.sql`
fragments and substitute into both CTE bodies.

**Feature flag:** `features.hybridRetrieval` (DB-backed, ADR-0023).
**Off by default** so existing deploys see no behaviour change.
When on, every call to `retrieve()` uses the hybrid path; when off,
the existing pure-cosine path stays.

The widen-on-underfill fallback (ADR-0006) is preserved for the
cosine path. It's redundant when hybrid is on — lexical results
usually fill in for an underfilling cosine query — so it's
disabled in the hybrid branch.

## Alternatives considered

- **True BM25 via `pg_search` / ParadeDB extension.** Gives the
  gold-standard lexical ranker. Cost: a new Postgres extension to
  install in every environment (local dev, CI, prod), version
  management, re-indexing on extension upgrades. The lift over
  `ts_rank` (cover-density scoring) shows up on millions-of-docs
  corpora; at our scale the difference is in the noise. **Rejected**
  for MVP; revisit if corpus size ever crosses the threshold where
  it matters.
- **Score-weighted fusion** (e.g. `α * cosine + (1-α) * lexical`).
  Requires score normalisation between two incompatible scales.
  More knobs, no quality win on benchmarks. Rejected.
- **Two separate DB calls + JS merge.** Simpler at first glance.
  Two round-trips, harder to filter consistently, no transactional
  snapshot across the two reads. Rejected.
- **Replace cosine outright with lexical.** Loses everything
  cosine is good at (paraphrase, concept-match). Rejected.
- **Add lexical only as a fallback when cosine returns < N
  results.** Asymmetric, hides lexical's contribution on
  well-served queries, doesn't help the "exact string" case where
  cosine returns plenty of *wrong* results. Rejected.

## Consequences

**Positive**

- Exact-string queries (version numbers, error codes, file paths,
  rare acronyms) work as users expect.
- Robust to query intent — semantic and lexical strengths
  complement each other; RRF surfaces consensus.
- No new infrastructure: ships entirely on Postgres + pgvector
  (already deployed). No extension to install, no service to run.
- Single round-trip per retrieval; same latency budget as cosine
  alone (HNSW + GIN are both sub-linear).
- Flag-gated and reversible — flip off if a regression appears.

**Negative**

- One more column + one more index per Evidence row. Modest
  storage cost (a few % overhead on the table). GIN inserts are
  slightly more expensive than B-tree on ingest, but ingest is
  already heavily I/O-bound on the embedding call so the relative
  impact is small.
- The stored generated column locks the analyser to `english`. A
  multi-language corpus would need either a per-document language
  tag + per-language tsvector columns, or a switch to a
  language-agnostic tokeniser. Acceptable for the current customer
  base; documented as a follow-up.
- `ts_rank` is cover-density, not BM25. On large corpora BM25 is
  measurably better; on ours it's in the noise.
- Query parsing via `plainto_tsquery` strips Boolean operators and
  punctuation. A user typing `AND` literally won't get Boolean
  intersection — that's deliberate, the alternative
  (`to_tsquery`) raises on malformed input and would force us to
  validate user-supplied queries.

**Neutral**

- The flag's default-off state means measurement is opt-in. A
  workspace flips the flag, observes the change in real use, and
  flips back if anything looks worse. No A/B framework needed.

## Follow-ups

- Surface the per-side rank (dense / lexical) on the retriever's
  return shape so the Evidence Explorer can show "matched on:
  semantic / lexical / both" badges. Useful when debugging
  unexpected results.
- Per-language tsvector if a customer's corpus is non-English.
- Re-evaluate BM25 (via `pg_search` or ParadeDB) when corpus size
  per assessment passes ~500k chunks.
- Optional precision@10 measurement harness if a future retriever
  change is hard to evaluate from real-world signal alone.

## References

- `apps/web/src/server/services/rag-retriever.ts`
- Migration `20260512_*_evidence_search_vec`
- ADR-0006 (the misleadingly-named "hybrid retrieval fallback"
  this ADR finally implements properly).
