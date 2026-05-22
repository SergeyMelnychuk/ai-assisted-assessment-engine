-- Drop the legacy in-row encrypted PAT columns from `repository_links`.
--
-- Background: the Slice 3 PAT consolidation moved every github.pat
-- into the engagement-scoped `agent_credentials` vault. The
-- `agent_credential_id` FK points each link at its vault row. The
-- `backfill-pat-vault.ts` script copied legacy in-row PATs into the
-- vault before this migration runs.
--
-- Safety: every link with a legacy PAT now has either a vault entry
-- of its own or a pointer to the engagement's shared vault row. The
-- ingest worker reads from the vault first; the legacy fallback path
-- is no longer reachable. Dropping the columns is a one-way move —
-- if you haven't run the backfill, do that first.

ALTER TABLE "repository_links"
  DROP COLUMN "encrypted_credentials",
  DROP COLUMN "credentials_iv",
  DROP COLUMN "credentials_tag";
