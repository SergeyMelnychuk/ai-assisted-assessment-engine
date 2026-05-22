-- ADR-0027: hybrid retrieval — add a stored generated tsvector column
-- on `evidences` plus a GIN index for fast lexical matching.
--
-- Generated columns auto-populate on INSERT/UPDATE and on ALTER TABLE
-- (which backfills existing rows in one shot — no separate UPDATE).
-- The english analyser is hardcoded; per-language support is documented
-- as a follow-up in ADR-0027.
ALTER TABLE "evidences"
  ADD COLUMN "search_vec" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

-- GIN is the right index for tsvector matching (`@@`). The default
-- `gin_fastupdate=on` is fine — ingest writes one chunk at a time and
-- the queue worker is already the slowest link in the chain.
CREATE INDEX "evidences_search_vec_idx" ON "evidences" USING GIN ("search_vec");
