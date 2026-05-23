# ADR-0018: Customer-uploadable templates with JSON bindings

- **Status:** Accepted
- **Date:** 2026-05-07
- **Deciders:** Engineering, Product
- **Related:**
  [ADR-0011](./0011-evidence-traceability-first-class.md) — fills emit
  Document rows that flow into the same evidence stream;
  [ADR-0015](./0015-multi-provider-llm-routing.md) — the AI binding
  proposer is just another routed task;
  [ADR-0029](./0029-deliverable-section-field-family.md) — extends the
  binding `field` vocabulary with the `section.<key>` family so AI-
  written prose lands in the output file alongside engine data.

## Context

Customers want their estimation workbooks and deliverable shells to
look like *theirs*: corporate WBS in their layout, narrative reports
in their template, presentations on their master slide. Today the
engine emits its own generated Word/Excel files. Reviewers like the
content but spend hours retyping it into the customer's chrome before
it can leave the building.

Two important properties of the templates customers actually upload:

1. They are **artefacts the customer didn't author themselves** —
   workbooks built years ago by a partner team, or shells maintained
   by a corporate brand group. The user uploading the file does not
   want to (and often cannot) edit cells, add macros, or paste in a
   templating-language expression.
2. They are **format-diverse and structurally messy.** Cell B12 on
   sheet "Cover", a named range `EstTotal`, a `{{role_pm_hours}}`
   token in a Word doc, and a "one row per role starting at A8 in the
   WBS sheet" pattern all show up in the same workbook family.

We need a way to wire the engine's outputs into those files without
asking the customer to learn a templating language and without
hard-coding our shapes into theirs.

## Decision

A template is a customer-uploaded `.xlsx` / `.docx` / `.pptx` plus a
**binding document** — a JSON file whose schema is owned by
`apps/web/src/server/services/template/binding.ts`.

The binding document maps a **closed enum of engine output fields**
(role hours, totals, project context, findings/risks/recs lists, and
generated dates) to **typed targets** inside the file:

- `xlsx.cell` — sheet name + A1 ref.
- `xlsx.namedRange` — workbook-scoped defined name.
- `xlsx.tableRow` — start cell + column for one-row-per-array iteration,
  grouped by `groupKey` so sibling columns iterate together.
- `docx.placeholder` — a `{{token}}` substituted in `word/document.xml`.
  The same target kind is reused for `.pptx` slide / layout / notes XML.
- `docx.bookmark` — reserved; not yet implemented.

The schema is validated by zod in `binding.ts`. The filler skips
unknown target kinds with a warning rather than rejecting the
document, so a forward-compatible binding (e.g. one mentioning a
target kind we add later) does not brick a fill on an older deploy.

Bindings start life as **AI proposals.** On upload the file lands in
MinIO, a `Template` row is created in `PROPOSED` status, and a
BullMQ job (`propose-template-binding`) runs an LLM over the file
structure plus the engine-output catalogue and writes a draft
`bindingJson`. A human approver reviews, edits, and clicks Approve.
Approval transitions the row to `APPROVED` and auto-deprecates older
approved versions of the same `(name, kind, scope)`. If the proposer
fails, the UI surfaces a **Retry** affordance that re-queues the
job via `reproposeBinding` on the `template` router.

Mutating actions (save binding, approve, deprecate, archive, delete,
re-propose) live on the `template` tRPC router. Workspace defaults
(`engagementId = null`) are admin-only; engagement-scoped templates
are owner-or-admin gated. Delete requires archive first.

## Alternatives considered

- **A full templating language inside cells / paragraphs** (e.g.
  Jinja-style loops). Rejected: customers don't write
  `{{# for role in roles }}` in their WBS workbook, and asking them
  to add it is the same friction as asking them to give up the
  template.
- **A fixed convention** (e.g. always sheet "Outputs", always rows
  starting at A2). Rejected: the workbooks we see in the field don't
  share a convention. Forcing one would mean the customer must
  modify their template to use ours — the inverse of the goal.
- **Rendering our output into the file via headless Office.**
  Rejected: introduces a heavy runtime dependency (LibreOffice or a
  similar server), is harder to make deterministic for replay, and
  doesn't generalise across Office versions.
- **Keep the binding inline in the customer's file** (e.g. a hidden
  sheet of mappings). Rejected: edits to that sheet are hard to
  audit, and a re-uploaded workbook would silently change the
  binding contract.

## Consequences

**Positive**

- File-format-agnostic: `.pptx` parity landed in the same milestone
  as `.xlsx` / `.docx` — adding a new format is a new filler module
  plus a branch in `fillTemplate`, not a change to the binding
  schema.
- No templating language for customers to learn.
- Replayable: each `TemplateFill` row stores the binding snapshot and
  the engine-output snapshot it ran against, so a fill can be
  reproduced even after the template is re-versioned.
- Forward-compatible: new target kinds and new engine fields land
  without breaking existing bindings.
- Soft-failure behaviour is **production-tested** — unit tests cover
  both the schema-invalid binding path and the MinIO storage-failure
  path, asserting that a `TEMPLATE_FILL_FAILED` audit row is written
  and the parent run is unaffected.

**Negative**

- Power users editing JSON by hand will hit ergonomics problems —
  cell refs are easy to mistype. A future binding editor with a
  picker UX (planned for Wave 2) is required to make this nice
  without an AI proposer in the loop.
- The AI proposer is now load-bearing for onboarding. A bad first
  proposal turns into a manual edit; a bad upload format turns into
  a no-op fill. Both are recoverable, but neither is invisible.
- Per-format fillers each carry their own surface area (named-range
  resolution for xlsx, OOXML round-tripping for docx, slide-XML
  walking for pptx).
- **PPTX split-run limitation.** PowerPoint can split a logical
  token across multiple `<a:t>` runs when the author edits
  mid-token. The v1 filler does a flat string replace per slide XML
  and silently misses split tokens, surfacing a warning on the
  fill's audit row. Authors retype tokens in one edit as the
  documented workaround; a run-merging pass is a follow-up.
- **Per-role hours/cost are zero today.** `RoleProposal` does not
  yet emit per-role distributions, so the engine outputs `0` for
  `roles[*].hoursLow`, `roles[*].hoursHigh`, `roles[*].costLow`, and
  `roles[*].costHigh`. Templates that bind those fields receive
  zeros. This is an intentional deferral — the per-role distribution
  work is tracked as a follow-up, and the binding schema is
  unchanged so existing templates keep working once it lands.

## Soft-failure design

A broken template **must never fail the run.** Estimation and
deliverable workers complete their primary work first, then call
`fillAndStoreForAssessment` as an optional step. That function:

- Returns `null` when no APPROVED template is in scope.
- Returns `null` and writes a `TEMPLATE_FILL_FAILED` audit row when
  the binding fails schema validation or when MinIO storage of the
  filled file fails.
- Writes a `TEMPLATE_FILLED` audit row with the warnings array on
  success — partial fills (some entries skipped) are surfaced, not
  fatal.

The estimation/deliverable output the user already expected is
unaffected by any of those branches. The filled template lands as a
`Document` on the assessment, alongside the standard outputs.

## Follow-ups

- [ ] Per-role hours and cost on `RoleProposal` (currently zero — see
      Consequences).
- [ ] Run-merging pass for PPTX split-run tokens.
- [ ] Add the `docx.bookmark` target kind (currently warns + skips).
- [ ] Replace hand-editing of `bindingJson` with a picker-driven UI
      (Wave 2 — see `docs/guides/templates.md`).

## References

- `apps/web/src/server/services/template/binding.ts` — schema and
  engine field enum.
- `apps/web/src/server/services/template/filler.ts` — per-format fill
  logic for `.xlsx`, `.docx`, and `.pptx`.
- `apps/web/src/server/services/template/fill-and-store.ts` —
  resolution order and soft-failure semantics.
- `apps/web/src/server/services/template/binding-proposer.ts` — AI
  proposer flow.
- `apps/web/src/server/trpc/routers/template.ts` — lifecycle, picker
  options, retry, fill history.
- `apps/web/src/app/api/templates/upload/route.ts` — upload contract.
