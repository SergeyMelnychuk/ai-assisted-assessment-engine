# ADR-0028: Evidence citations — Flavour A now (source attribution + context window), Flavour B as the deferred path (claim grounding)

- **Status:** Accepted
- **Date:** 2026-05-12
- **Deciders:** Engineering
- **Related:**
  [ADR-0004](./0004-chunking-strategy.md) (chunker writes
  `chunk_source.heading` / `page` / `path` we now surface),
  [ADR-0009](./0009-pat-per-engagement-credentials.md) /
  [ADR-0010](./0010-tarball-api-over-git-clone.md) (repo-link
  ingest populates `repoUrl` / `language` / `path`),
  [ADR-0011](./0011-evidence-traceability-first-class.md)
  (`retrievedEvidenceIds` on Findings + the "Why this finding?"
  trail this builds on),
  [ADR-0027](./0027-hybrid-retrieval-rrf.md) (matched-on:
  semantic / lexical / both — added by hybrid retrieval, surfaced
  in the citation chip).

## Context

Evidence chunks today are presented as a body of text with a thin
one-line trail (`from architecture.md §Security`). Real readers
need more before they trust the chunk:

- Where exactly in the document — page number, chunk index,
  section heading.
- Whether it's a repo file, an archive child, or a primary upload —
  and how to open the original.
- A way to **link to** the chunk so a teammate can land on the same
  view.
- For findings: a clear pointer from a claim back to the chunks
  that support it.

Two distinct concepts get conflated when people say "citations":

- **Flavour A — Source attribution on the chunk itself.** Static,
  derived from the chunk's metadata at retrieval time. Always
  present. Pure UI plumbing of data we already store.
- **Flavour B — Citation-grounded analysis output.** The AI emits
  per-claim references (`[E-23]`) inline in findings / risks /
  recommendations; the UI renders them as clickable links; the
  deliverable carries them into the export. Prompt change + output
  parsing + UI rendering + DOCX/PDF integration.

The two solve different problems. **A** answers "where did this
chunk come from?" — readability of an existing data shape. **B**
answers "which sentence in this finding is supported by which
chunk?" — finer-grained traceability the model has to emit.

We ship A now and defer B.

## Decision — Flavour A (this ADR)

### Data plumbing

Extend `EvidenceTrailSourceTrail` (the shape the explorer router
returns) with fields we already store but don't surface:

- `documentId: string | null` — for the download deep link.
- `chunkIndex: number | null` — position inside the source.
- `chunkCount: number | null` — total chunk count for that document
  (so the UI can read `chunk 14/47`).
- `parentDocumentId: string | null` + `parentDocumentName: string
  | null` — for archive children, identifies the archive parent so
  the chip can show `q3-handover.zip › docs/runbook.md`.
- `commitSha: string | null` — repo chunks already record this in
  `chunk_source.commitSha` at ingest; surface it.

Existing fields stay (`documentName`, `heading`, `page`, `language`,
`repoUrl`, `path`).

### Component — `EvidenceCitation`

A single React component that renders the citation line consistently
across every consumer (search results, finding-trail panel, finding /
risk / recommendation evidence list, deliverable preview). One
component, three renderable surfaces driven by `compact` /
`interactive` props:

- **Display variants** based on the trail shape:
  - Repo chunk: `🐙 acme/infra · src/auth/middleware.ts · ts · @abc1234`
  - Document chunk: `📄 architecture.md · §Security & IAM · p.12 · chunk 14/47`
  - Archive child: `🗂 q3-handover.zip › docs/runbook.md · §Rollback`
  - Bare repo path (no repo URL): `📁 src/auth/middleware.ts`
  - Fallback: `source unavailable`
- **Interactive affordances** when `interactive` is true:
  - The filename is a link to `/api/documents/<id>/download`.
  - Repo chunks link to the resolved provider URL (e.g.
    `github.com/owner/repo/blob/<sha>/<path>`).
- **Hybrid retrieval chip (ADR-0027).** When the chunk row carries
  `denseRank` and / or `lexicalRank`, append `· matched:
  semantic+lexical` (or `· matched: lexical only`, etc.) as a
  small muted chip. Tells the reader why the chunk surfaced.
- **Similarity** as a faint trailing chip when present
  (`· sim 0.82`).

The component is small and pure. Server-rendered DOCX export keeps
using the existing `renderEvidenceTrailString()` for an
inline-text-only rendering — the React component is one of two
renderers of the same trail data, just as today.

### Where it lands

1. **Evidence Explorer search results.** `ClusteredChunkPreview`
   renders `<EvidenceCitation interactive>` under each chunk card.
2. **"Why this finding?" panel.** Replaces the current trail line
   with the richer citation per row.
3. **Findings / risks / recommendations evidence trail.** Same
   treatment — the existing "from `…`" line becomes the new
   component.
4. **Agent trace viewer side panel** (the `AgentStepPanel` evidence
   list from ADR-0026) — passes evidence ids through to the same
   component.

### Context-window dialog

Reviewers consistently asked the same question of a retrieved
chunk: *"does this actually mean what the AI thinks it means?"*
A bare 360-char snippet is rarely enough to answer that — context
matters. So clicking a chunk preview opens a popup that shows the
chunk plus its immediate neighbours in the source document.

- **Procedure:** `evidenceExplorer.contextWindow({ evidenceId,
  before?: 2, after?: 2 })`. Fetches the target Evidence row plus
  Evidence rows from the same `documentId` whose `chunkIndex` is
  within `[target - before, target + after]`. Empty result for
  answer-derived or document-less chunks — caller renders the
  target alone.
- **UI:** `EvidenceContextDialog` (a thin wrapper over the project's
  existing `Dialog` primitive). The target chunk is highlighted
  with a primary border + "retrieved chunk" badge; neighbours are
  muted. Citation row at the top so the reviewer still knows the
  source.
- **Trigger:** the snippet body inside `EvidenceChunkPreview`
  becomes a button that opens the dialog. The citation row is
  outside the trigger so its links (download / repo blob) still
  work independently. Off when `evidenceId` is omitted (export
  preview, DOCX renderer).
- **Cost.** One extra DB round-trip per opened popup — bounded
  (≤ before + 1 + after rows). Lazy-fetched: the query only
  fires once the dialog opens, so the typical Evidence Explorer
  result list pays nothing for chunks no one expands.

Stable deep-link URLs (an earlier sketch of "let me share this
chunk via Slack") were tried and removed — pasting one yourself
opens the same page you were already on, so the affordance
confused more than it helped. If a need for shareable chunk
permalinks resurfaces, it should be a separate ADR with a
concrete sharing flow (e.g. inline-in-comment renderers).

## Future path — Flavour B (deferred, not implemented here)

When we ship B, the steps are:

1. **Prompt change.** `finding-generation.ts` adds an instruction
   to emit `[<chunk_id>]` markers inline after each sentence
   that's supported by retrieved evidence. The schema gains a
   `claimCitations: Array<{ snippet: string; evidenceIds:
   string[] }>` field.
2. **Server-side validation.** Parse the citations out of the
   model output and validate each `evidenceIds` reference against
   the actual retrieved-evidence set. Drop unknown ids with a
   warning; never let the model invent a chunk id.
3. **Storage.** New `Finding.claimCitations Json?` column (and
   matching on `Risk` / `Recommendation`). The existing
   `retrievedEvidenceIds` stays — it's the *retrieved set*; the
   new field is the *cited subset*, finer-grained.
4. **UI rendering.** Render the finding body with inline `[E-23]`
   markers as clickable chips that scroll the
   `EvidenceCitation` panel (from Flavour A) to the cited chunk.
5. **Deliverable export.** Carry the citations into the DOCX /
   PDF as endnote-style references (e.g. `[12]` → footnote linking
   back to the chunk's source trail).

**Cost.** Longer model output (citations add tokens), one new
migration, prompt + parser + UI rendering changes. Roughly a week
of work plus measurable Anthropic spend per analysis run.

**Trigger to ship B.** Only after A lands and real users report
that "which sentence is grounded in which chunk" is still
ambiguous. Otherwise A solves the audit-trail problem with much
less code.

## Alternatives considered

- **Ship B first, skip A.** Rejected — A is data we already
  store; not surfacing it is the bigger gap. B is more code, more
  AI spend, and only solves the finer-grained question after the
  broader one is already answered.
- **Free-text "source" string per chunk.** Rejected — the trail
  fields are already typed; rendering them through a small
  component keeps formatting consistent across surfaces (search
  results / DOCX export / finding trail / agent panel). One
  formatter, many call-sites.
- **Hover-card popover with full preview.** Reasonable polish on
  top of A; out of scope for the first cut. Documented as a
  follow-up.
- **Generate citations server-side as Markdown.** Rejected — locks
  the format into the persisted output and makes the
  interactive bits (download link, copy-deep-link) harder. Keep
  the typed shape; let the React component own presentation.

## Consequences

**Positive**

- Reader trust: every chunk shows where it came from, with a click
  back to the original.
- One component, four surfaces — consistency across the Explorer,
  the finding trail, the agent trace, and any future evidence
  surface (e.g. the deliverable preview).
- Hybrid-retrieval signal (ADR-0027) finally has somewhere to
  surface — the `matched: …` chip closes the loop on "why did
  this chunk come up?".
- Context-window popup answers the "does this chunk actually mean
  what it looks like?" question without sending the reviewer
  hunting through the source document. One click, two
  paragraphs of context, decision made.

**Negative**

- A few extra fields on the trail shape mean a few extra `select`
  joins server-side. Bounded; the explorer queries are already
  small.
- `chunkCount` per document needs either an aggregate
  sub-query at trail-hydration time (cheap, one query per
  hydration) or a denormalised `Document.chunkCount` column (we
  already maintain this — `Document.chunkCount` is written by the
  ingest worker; just read it).
- Per-language citation copy is English-only for now. The
  decision tree on `renderEvidenceTrailString` doesn't translate
  cleanly to other locales; out of scope.

**Neutral**

- The DOCX export keeps its plain-string trail renderer; no
  change to the export path.

## Follow-ups

- Per-evidence inline annotations (reviewer notes on a specific
  chunk, similar to the agent-trace annotations from ADR-0026).
- Configurable context window (`before`/`after` sliders in the
  dialog) — currently fixed at 2+2.
- **Flavour B** once usage data tells us claim-level grounding is
  needed — see "Future path" above.

## References

- `apps/web/src/components/evidence/evidence-citation.tsx` (this
  ADR's primary artefact).
- `apps/web/src/components/evidence/evidence-context-dialog.tsx`
  (context-window popup).
- `apps/web/src/components/evidence/evidence-source-trail.tsx`
  (kept for the DOCX renderer).
- `apps/web/src/server/trpc/routers/evidenceExplorer.ts`
  (`EvidenceTrailSourceTrail` extension + `contextWindow`
  procedure).
