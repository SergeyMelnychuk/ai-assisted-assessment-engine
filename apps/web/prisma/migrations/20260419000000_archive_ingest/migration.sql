-- Week 5: bulk upload + archive support (see ADR-0008).
--
-- Archives (zip / tar / tar.gz) upload as a single "parent" Document
-- row; each surviving member becomes a child Document with
-- `parent_document_id` pointing back at the parent. The ingest-archive
-- worker stream-extracts members and enqueues one `ingest-document`
-- per child, so the fan-out reuses the deterministic Week 1 pipeline
-- unchanged.
--
-- We deliberately do NOT add a `kind` enum column. A nullable
-- self-referencing FK is the minimum schema churn that encodes the
-- parent/child relationship: a Document with children = archive;
-- a Document with a non-null parent = archive member; everything else
-- is a plain file. The UI infers the archive-card shape from the
-- presence of children rather than a type tag.

ALTER TABLE "documents"
    ADD COLUMN "parent_document_id" TEXT;

ALTER TABLE "documents"
    ADD CONSTRAINT "documents_parent_document_id_fkey"
        FOREIGN KEY ("parent_document_id")
        REFERENCES "documents"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE;

-- Child-lookup index. Archive parents list their members via this,
-- and the UI's archive-card progress bar queries it once per poll.
CREATE INDEX "documents_parent_document_id_idx"
    ON "documents"("parent_document_id");
