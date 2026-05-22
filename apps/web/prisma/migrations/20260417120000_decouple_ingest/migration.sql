-- Week 1: decouple ingest from analyse (see ADR-0001).
-- Adds the `ingest_status` enum + column to `documents`, plus a
-- `chunk_count` column the UI uses to surface "Chunked (N chunks)".
-- The existing `processing_status` column is retained — it is still
-- used for the classified-failure audit trail and for backwards
-- compatibility with older readers. The ingest worker keeps the two
-- columns in sync.

CREATE TYPE "IngestStatus" AS ENUM (
    'PENDING',
    'EXTRACTING',
    'CHUNKED',
    'EMBEDDED',
    'READY',
    'FAILED'
);

ALTER TABLE "documents"
    ADD COLUMN "ingest_status" "IngestStatus" NOT NULL DEFAULT 'PENDING',
    ADD COLUMN "chunk_count" INTEGER;

-- Backfill: derive ingest_status from the existing processing_status
-- so pre-migration rows report something useful in the UI.
UPDATE "documents"
SET "ingest_status" = CASE "processing_status"
    WHEN 'PROCESSED' THEN 'READY'::"IngestStatus"
    WHEN 'FAILED'    THEN 'FAILED'::"IngestStatus"
    WHEN 'PROCESSING' THEN 'EXTRACTING'::"IngestStatus"
    ELSE 'PENDING'::"IngestStatus"
END;
