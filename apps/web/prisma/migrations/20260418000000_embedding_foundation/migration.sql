-- Week 3: embedding foundation (see ADR-0003, ADR-0004, ADR-0005).
--
-- Adds vector, chunking, and change-detection columns to `evidences`
-- alongside an HNSW index for cosine similarity search. All columns
-- are nullable so the Week 3 backfill can populate them incrementally —
-- existing Week 1 rows keep working until the backfill catches up.
--
-- `embedding` is a pgvector column; Prisma models it as
-- `Unsupported("vector(1536)")`. Reads and writes of this column go
-- through raw SQL (`$queryRaw` / `$executeRaw`) in the worker.

-- Defensive: the project already turned pgvector on in Task 1's init
-- migration, but `IF NOT EXISTS` keeps this migration runnable against
-- a DB that somehow missed it (e.g. a fresh local Postgres).
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "evidences"
    ADD COLUMN "embedding"     vector(1536),
    ADD COLUMN "chunk_index"   INTEGER,
    ADD COLUMN "chunk_source"  JSONB,
    ADD COLUMN "content_sha"   TEXT;

-- HNSW index for cosine similarity. ADR-0005 explains the trade-off
-- vs. IVFFlat: HNSW gives us better recall on small-to-medium corpora
-- and doesn't require a list-count parameter we'd have to re-tune
-- after every bulk load. Default `m` and `ef_construction` are fine
-- for our expected scale (Phase 3 caps ~10k chunks per engagement);
-- Week 4's perf task may override them if the 200ms budget slips.
CREATE INDEX "evidences_embedding_hnsw_idx"
    ON "evidences"
    USING hnsw ("embedding" vector_cosine_ops);

-- A btree index on `content_sha` makes the backfill's "already
-- processed?" lookup cheap. Not unique — the same chunk content could
-- legitimately appear across documents.
CREATE INDEX "evidences_content_sha_idx"
    ON "evidences" ("content_sha");
