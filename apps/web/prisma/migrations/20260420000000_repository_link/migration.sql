-- Week 6: repository linking (see ADR-0009, ADR-0010).
--
-- A RepositoryLink binds an Assessment to a remote code repository
-- (GitHub for MVP). Credentials (PAT) are encrypted at rest with
-- AES-256-GCM using `REPO_CREDENTIAL_KEY`. `ingestStatus` mirrors the
-- Document lifecycle so the UI can reuse the same status components.
--
-- The link itself is metadata + credentials; the actual per-file
-- evidence lives on child Documents fanned out by `ingest-repository`
-- via the Week 5 `ingest-archive` pipeline. We reuse `IngestStatus`
-- rather than a bespoke enum so the dashboard progress UI stays one
-- component.

CREATE TABLE "repository_links" (
    "id"                       TEXT NOT NULL,
    "assessment_id"            TEXT NOT NULL,
    "url"                      TEXT NOT NULL,
    "provider"                 TEXT NOT NULL,
    "auth_method"              TEXT NOT NULL,
    "encrypted_credentials"    BYTEA NOT NULL,
    "credentials_iv"           BYTEA NOT NULL,
    "credentials_tag"          BYTEA NOT NULL,
    "last_synced_at"           TIMESTAMP(3),
    "last_sha"                 TEXT,
    "ingest_status"            "IngestStatus" NOT NULL DEFAULT 'PENDING',
    "parent_document_id"       TEXT,
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL,
    CONSTRAINT "repository_links_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "repository_links_assessment_id_idx"
    ON "repository_links"("assessment_id");

ALTER TABLE "repository_links"
    ADD CONSTRAINT "repository_links_assessment_id_fkey"
        FOREIGN KEY ("assessment_id")
        REFERENCES "assessments"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE;

ALTER TABLE "repository_links"
    ADD CONSTRAINT "repository_links_parent_document_id_fkey"
        FOREIGN KEY ("parent_document_id")
        REFERENCES "documents"("id")
        ON DELETE SET NULL
        ON UPDATE CASCADE;
