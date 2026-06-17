-- Fill-health columns on template_fills. Surfaced on the Export page so
-- a no-op fill (0 placeholders bound) is never handed over silently.
-- Both nullable: existing rows predate the columns and read as
-- "unknown" (the UI shows no badge for null).
--
-- NOTE: `prisma migrate dev` autogenerates spurious `evidences.search_vec`
-- DROP DEFAULT / DROP INDEX statements here because Prisma's schema can't
-- model the Postgres GENERATED tsvector column added in
-- 20260512165717_evidence_search_vec_tsvector. Those statements are
-- removed by hand — this migration touches ONLY template_fills. Apply
-- with `migrate deploy` (not `migrate dev`) to avoid re-introducing them.
ALTER TABLE "template_fills"
  ADD COLUMN "filled_entry_count" INTEGER,
  ADD COLUMN "warnings" JSONB;
