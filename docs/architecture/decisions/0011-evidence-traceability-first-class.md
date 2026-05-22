# ADR-0011: Evidence traceability as first-class data

- **Status:** Accepted
- **Date:** 2026-04-18
- **Deciders:** Engineering (solo)
- **Related:** [ADR-0002](./0002-per-domain-analysis-fan-out.md),
  [ADR-0006](./0006-hybrid-retrieval-fallback.md),
  [ADR-0007](./0007-query-construction-per-retrieval-point.md),
  [Phase 3 roadmap §Week 7](../../design/phase-3-roadmap.md#week-7--ux-traceability),
  `apps/web/src/server/services/evidence-clusterer.ts`,
  `apps/web/src/server/trpc/routers/evidenceExplorer.ts`.

## Context

By Week 6 the AI pipeline was already retrieval-augmented
end-to-end — every Finding / Risk / Recommendation / DomainScore is
produced from a per-domain retrieval pass (ADR-0007), and reviewers
rely on the model to cite the chunks that drove each output via the
existing `evidenceIds` column. Two problems with that arrangement:

1. **"Cited" is not "given."** `evidenceIds` captures what the model
   *chose* to cite. The full set the retriever *gave* the model — the
   superset that bounded its choice — is discarded after the call. A
   reviewer inspecting a finding has no way to see "what else did the
   AI have in context?" without re-running retrieval, which is
   paid, non-deterministic (HNSW index may have shifted), and
   racy against re-ingests.
2. **Best-effort citation is opaque.** The model sometimes omits
   `evidenceIds` or picks an unexpected subset. Without the retrieved
   set recorded, a spot-check that "this finding is grounded in
   evidence" has no receipts.

The Week 7 roadmap task was always about making this visible in the
UI; doing so *correctly* required a schema change, not just a front-
end one.

## Decision

Add a `retrievedEvidenceIds text[]` column (Prisma:
`retrievedEvidenceIds String[] @default([])`) to each of the four
tables already carrying `evidenceIds`:

- `findings`
- `risks`
- `recommendations`
- `domain_scores`

Semantics, pinned:

- `evidenceIds`           — **model cited**. Best-effort, chosen by
                            the LLM during generation, may be empty.
- `retrievedEvidenceIds`  — **retriever gave**. The full per-domain
                            retrieval output the model saw. Always
                            populated by the service layer.

`retrievedEvidenceIds` is strictly a superset of `evidenceIds` for any
row whose model cooperated; the UI surfaces "cited" as primary and
"retrieved but not cited" as a secondary disclosure list ("what else
the AI had in context"). For `Recommendation`, since the model may
derive a rec from one or many findings, we record the union of the
domain's retrieved set — that's the correct bound on what was in
context for the rec-generation pass.

The service layer (`analysis-engine.ts`, `scoring-service.ts`) is the
load-bearing wiring: it already runs retrieval up-front
(`perDomainChunks`), so `retrievedIdsByDomain` is a map that every
insert body reads from. No additional retrieval calls.

New surfaces that consume this:

- `evidenceExplorer.findingTrail` tRPC query — resolves both
  cited and retrieved-only sets into `EvidenceWithTrail` DTOs.
- `WhyThisFindingPanel` React component — triggered from any finding /
  risk / recommendation row.
- `EvidenceSourceTrail` component + matching server-side
  `renderEvidenceTrailString` / `renderEvidenceTrailParagraphs` — one
  trail formatter, two renderers (React + DOCX).
- DOCX export (`export-service.ts`) — dedicated "Evidence trail"
  appendix citing source docs per finding / risk.
- `evidence-clusterer.ts` — greedy cosine-threshold cluster
  (`DEFAULT_DUPLICATE_COSINE = 0.95`) that collapses near-duplicate
  chunks into one representative row for the Evidence Explorer
  search results.

## Alternatives considered

- **Keep best-effort `evidenceIds`, build the UI over a new
  per-retrieval log table.** Would have preserved the "cited is all we
  persist" discipline and kept finding rows lean. Rejected: the
  retrieval log would need an FK to each of four consumers and a
  domain-scoped filter at read time. Four `String[]` columns with a
  default of `{}` is ~zero runtime cost and zero join — the obvious
  win.
- **Re-retrieve on-demand for the "Why this finding?" panel.** Cheap
  in code, expensive in dollars (one embed call + SQL per popover
  open) and non-deterministic after any re-ingest. Rejected — the
  reviewer UX explicitly needs "what the AI actually had," not
  "what the AI would get today."
- **Store the retrieval payload as JSON on a single column.** Flexible
  but inert to Postgres querying and inflates the row with duplicated
  content. Rejected — a `text[]` of Evidence ids is all the reviewer
  UI needs, and the Evidence table is already the single source of
  truth for the chunk body.

## Consequences

**Positive**

- Reviewers can answer "what did the AI have in context for this
  finding?" in one click, against the committed row — no re-
  retrieval, no race against HNSW / re-ingest state.
- The DOCX export carries an "Evidence trail" appendix listing source
  doc names per finding / risk. The deliverable is provenance-bearing
  by default, not a black-box LLM artifact.
- Near-duplicate clustering (`DEFAULT_DUPLICATE_COSINE = 0.95`) turns
  "3 chunks from 3 copies of the same paragraph" into "1 row · 3
  similar chunks from 2 sources" in the Evidence Explorer, which is
  the difference between "noisy scroll" and "signal."
- Four `text[]` columns with a zero-cost default mean the migration
  is additive, non-blocking, and reversible with a single
  `DROP COLUMN` per table — no data rewrite.

**Negative**

- Disk cost: each retrieval pass records ~10 ids per domain
  (~25 chars each including array separators). For an 8-domain
  analysis producing ~50 findings that's ~10 KB of text[] per run.
  Annual worst-case per engagement well under 1 MB. Storage we can
  spend.
- Read-path cost on a crowded findings list: the UI now hydrates
  potentially dozens of chunks per panel open. Mitigated by a
  `staleTime` on the React Query cache and lazy-fetch (only when the
  panel is expanded).
- "Cited vs retrieved" adds a reviewer concept. Unmitigated —
  reviewers working with RAG-backed tools will learn it in a
  heartbeat; the disclosure is the whole point.

**Neutral**

- `retrievedEvidenceIds` for `Recommendation` holds the **domain
  union**, not a per-finding subset. The model's mapping of
  findings → recs isn't recoverable from the output shape. Reviewers
  chasing "where did this rec come from?" should cross-reference the
  domain and the cited Risk ids.

## Follow-ups

- [ ] Week 8: cross-page linkage from findings / risks / recs rows
      back into the Evidence Explorer with the query pre-filled.
      Unticked at Week 7 merge time.
- [ ] Post-roadmap: per-finding AST-aware attribution for code-sourced
      chunks (currently "repo:owner/repo · path/file.ts"). The
      language tag is already on `chunkSource` via the Week 6 ingest
      path.
- [ ] Consider a nightly `VACUUM`-friendly reaper that prunes stale
      ids from `retrievedEvidenceIds` if the underlying Evidence row
      is deleted; currently the array can hold dangling ids after a
      doc re-ingest. The router's `resolveTrails` filters unknown ids
      silently — fine for the UI, worth cleaning up at scale.

## References

- `docs/design/phase-3-roadmap.md` §Week 7
- `docs/architecture/README.md` §10 Review discipline
- `docs/architecture/diagrams/container-topology.mmd`
- `docs/architecture/diagrams/evidence-trail.mmd`
