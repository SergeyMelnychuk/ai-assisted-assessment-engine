# ADR-0001: Decouple ingest from analyse

- **Status:** Accepted
- **Date:** 2026-04-18
- **Deciders:** Engineering
- **Related:** `docs/design/phase-3-roadmap.md` §Week 1; `docs/architecture/README.md` §5 (Background job pipeline), §15 (Known limits & debts)

## Context

The MVP's `process-document` BullMQ job did text extraction **and** an
AI analysis call in a single transaction. That shape has three
specific failure modes the roadmap's later weeks (RAG, per-domain
analysis, bulk upload, repo linking) all compound:

1. **AI failure discards deterministic work.** A 529 from Anthropic
   during per-doc analysis aborts the whole job; `Document` flips to
   `FAILED` and the text + would-be Evidence rows are lost. Every retry
   re-runs pdf-parse/mammoth and re-bills Claude tokens for work that
   already succeeded.
2. **Per-doc AI is the wrong granularity.** The `run-analysis` job
   already reads Evidence rows and produces findings / risks /
   recommendations. The per-doc AI pass only ever populated the
   cosmetic `extractedSummary` column on the Document card; the data it
   produced didn't feed downstream analysis in any load-bearing way.
3. **Bulk ingest multiplies the cost.** Week 5's drag-a-project-zip
   feature wants to enqueue hundreds of documents at once. Each one
   calling Claude during ingest is $X × hundreds before the user has
   asked for any analysis.

With ingest and analyse fused, every downstream Phase 3 feature has to
reason about "did the AI call happen, did it succeed, do we need to
re-do the deterministic part". Splitting them is the prerequisite for
everything.

## Decision

Split the old `process-document` / `process-diagram` jobs into
`ingest-document` / `ingest-diagram`. The ingest jobs do only
deterministic work:

- Download from S3.
- Extract text (pdf-parse / mammoth / UTF-8 decode).
- Split into chunks (naive fixed-window splitter for Week 1; the Week 3
  recursive chunker will replace this).
- Insert one `Evidence` row per chunk.
- Populate `Document.extractedSummary` from the first chunk (no AI).

No Claude call. Diagram ingest keeps its vision/DSL-parse call for
image and text-based diagram formats — the raster path has no
deterministic equivalent, and removing it is out of scope for Week 1.
The per-document *prose* AI call is gone.

Per-document AI analysis lives on the existing per-assessment
`run-analysis` job (Option A in the roadmap). It already reads from
`Evidence`, so splitting ingest off doesn't require any additional
downstream rewiring; Week 2 will fan it out per-domain.

### Schema shape

- New enum `IngestStatus { PENDING, EXTRACTING, CHUNKED, EMBEDDED, READY, FAILED }`.
- New column `Document.ingestStatus` (default `PENDING`) — canonical
  state for the ingest pipeline.
- New column `Document.chunkCount` (nullable int) — populated when
  chunking completes so the UI can render "Chunked (N chunks)".
- `EMBEDDED` is reserved for Week 3; the Week 1 worker never writes it.
- The legacy `Document.processingStatus` column is **kept**. Renaming
  it would have cascaded through the audit log, retry UI, and existing
  reprocess code for no semantic win — the two columns are cheap to
  keep in sync during the transition and the next week that touches
  Document will be Week 3, which will rename if it makes sense then.

### Error classifier

Two new categories, distinct from the `AI_*` family:

- `INGEST_EXTRACTION_FAILED` — pdf-parse/mammoth threw.
- `INGEST_CHUNK_FAILED` — extractor returned text but the chunker
  couldn't produce any chunks.

The UI reuses the existing `FailureBanner` with the new categories.

### Code

- `apps/web/src/server/services/document-processor.ts` — trimmed to
  `extractDocumentText`, `chunkDocumentText`, `summaryFromChunks`. No
  AI imports; unit tests install a throwing Claude mock to prove it.
- `apps/web/src/server/queue/jobs/ingest-document.ts` — new worker
  handler; writes `INGEST_DOCUMENT` audit rows.
- `apps/web/src/server/queue/jobs/ingest-diagram.ts` — renamed from
  `process-diagram`; writes `INGEST_DIAGRAM`; still calls Claude
  vision / DSL parser (Week 1 does not touch the diagram AI path).
- `apps/web/src/server/queue/queue.ts` — `enqueueIngestDocument` /
  `enqueueIngestDiagram`; old names kept as deprecated aliases.
- Upload API (`apps/web/src/app/api/documents/upload/route.ts`) —
  returns as soon as the S3 put + `PENDING` row land; worker handles
  extraction.

## Alternatives considered

- **Keep one job, retry only the AI step on AI failure.** Rejected.
  Adds retry state + deterministic-vs-AI branching inside a single
  handler, and the cost model doesn't change — the AI call still fires
  on every upload, blocking the bulk-upload use case. Also fights
  against the `attempts: 1` / `maxRetries: 0` discipline: the whole
  point is no automatic retry.
- **Rename `processingStatus` to `aiStatus` and use `ingestStatus` as
  the canonical column.** Rejected for Week 1 scope. The rename has
  surface area in audit rows, retry handlers, and the existing
  `document.lastFailure` endpoint; doing it while also introducing
  the new pipeline would bloat the PR. Queued as a follow-up.
- **Drop `extractedSummary` entirely.** Rejected. The column is
  referenced by the failure-banner fallback and the Documents tab; the
  AI-free "first N chars of first chunk" summary is cheap and keeps
  the card legible. Removing it would touch the UI in ways out of
  scope for a decoupling refactor.

## Consequences

- **Positive.** Ingest is idempotent and deterministic — retries don't
  re-pay Claude. Uploads return faster (S3 put + PENDING row only).
  Bulk upload (Week 5) and repo linking (Week 6) can fan out ingest
  without fanning out AI cost. Per-doc AI failures can no longer
  corrupt text-extraction state.
- **Negative.** The per-doc "summary" on the Documents card is now
  mechanical, not AI-authored. The old summary was cosmetic (it didn't
  feed analysis) so the regression is UI-only, but it is a regression.
  Two status columns on `Document` during the transition is duplicative;
  we accept this for Week 1 and earmark the cleanup for Week 3.
- **Neutral.** The `EMBEDDED` enum variant ships unused in Week 1 so
  the Week 3 migration is additive, not a new enum value requiring a
  second migration.

## Follow-ups

- [ ] Week 3: populate `ingestStatus = EMBEDDED` after the embedding
      pass; stop lying about READY meaning "embedded".
- [ ] Week 3 or later: decide whether `processingStatus` is renamed
      or dropped once the per-assessment `run-analysis` job is the only
      consumer of AI-related state on a Document.
- [ ] Week 2: the per-domain analysis fan-out will further reduce the
      value of the old per-doc AI summary — revisit whether the UI
      still needs any summary column after Week 2 lands.

## References

- `docs/design/phase-3-roadmap.md` §Week 1
- `docs/architecture/README.md` §5, §15
- `apps/web/prisma/migrations/20260417120000_decouple_ingest/migration.sql`
- `apps/web/src/server/queue/jobs/ingest-document.ts`
- `apps/web/src/server/services/document-processor.ts`
