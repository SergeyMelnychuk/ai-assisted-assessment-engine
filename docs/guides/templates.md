# Customer templates — user guide

This guide explains how to upload your own Excel, Word, and
PowerPoint templates, how the engine fills them with assessment
outputs, and how to manage versions over time.

> **Scope.** Everything below lives under the **Templates** tab on an
> engagement (for engagement-scoped templates) and `/admin/templates`
> (for workspace defaults). The engine still produces its standard
> outputs even when no template is uploaded — templates are an
> optional layer, not a replacement.

---

## 1. What templates are

A template is a customer-supplied workbook, document, or deck that
the engine fills with the numbers and text it has already produced
for an assessment: role hours, totals, project context, findings,
risks, and recommendations. The output keeps your file's structure,
formulas, formatting, and chrome — only the cells / placeholders
covered by the binding change.

You upload a file, the engine drafts a binding (a JSON map from
"engine field" to "where in your file the value goes"), a human
reviews and approves it, and from that point forward every relevant
assessment run produces a filled copy of your template alongside the
standard deliverables.

Template kinds map 1:1 to the deliverables the engine can produce.
The shipping set:

- **WBS workbook (Estimation)** — the WBS / per-role estimation
  workbook. `.xlsx`.
- One kind per deliverable type, each backed by a workspace-default
  shell that ships with the repo (`packages/knowledge-seed/deliverable-shells/`):
  - **Executive summary** — `.pptx`
  - **Assessment report** — `.docx`
  - **Risk register** — `.xlsx`
  - **Target state** — `.pptx`
  - **Roadmap** — `.pptx`
  - **Team proposal** — `.docx`
  - **Estimate** — `.xlsx`
  - **Assumptions & gaps** — `.docx`
  - **Statement of work (draft)** — `.docx`
  - **Greenfield discovery** — `.docx`
- **Generic report (.docx) / Generic deck (.pptx)** — legacy
  fallback kinds. Existing rows uploaded before the per-type kinds
  shipped keep working: the resolver checks for an exact-kind
  template first, then falls back to the matching generic kind
  (presentation-style deliverables to `DELIVERABLE_PRESENTATION`,
  everything else to `DELIVERABLE_REPORT`).

`.pptx` filling supports `{{token}}` placeholders with one caveat —
see section 9.

## 2. Supported file types and size limits

The upload endpoint accepts:

- `.xlsx` (modern Excel) and `.xls` (legacy)
- `.docx` (modern Word) and `.doc` (legacy)
- `.pptx` (modern PowerPoint)

The hard limit is **25 MB per file.** Files above that are rejected
at upload with a 413. Any other type is rejected with a 415.

## 3. Lifecycle

A template moves through three statuses, plus a soft-archive state:

| Status | What it means |
| --- | --- |
| **PROPOSED** | Uploaded. The AI binding proposer is drafting (or has drafted) a binding. Not yet eligible to run. |
| **APPROVED** | A human reviewed the binding and clicked Approve. The template is now picked up automatically by the engine for runs in scope. |
| **DEPRECATED** | Superseded by a newer approved version, or manually deprecated. Older fills still link to it for audit, but new runs skip it. |

Two extra controls:

- **Archive** — hides the template from default lists. You must
  archive a template before you can delete it.
- **Delete** — permanent. Only works on archived templates.

When you approve a new version of a template (same name, same kind,
same scope), the previous APPROVED version is auto-deprecated so the
picker only shows one current row.

## 4. Workspace default vs engagement override

Templates can live at two scopes:

1. **Workspace default** — `engagementId = null`. One per
   `(name, kind)`. Visible everywhere, edited only by admins.
   Managed at `/admin/templates`.
2. **Engagement override** — scoped to a single engagement. Edited
   by engagement owners and admins. Managed on the engagement's
   **Templates** tab.

When the engine runs a fill for an assessment, the default
resolution order is:

1. APPROVED template scoped to the assessment's engagement.
2. APPROVED workspace default.

The first match wins. If neither exists, the fill is simply skipped
— the run still produces its standard outputs. The user can
override this default with the **template picker** at run time
(see section 6).

## 5. How to upload

**Engagement-scoped:**

1. Open the engagement.
2. Click the **Templates** tab.
3. Click **Upload template** and pick a file.
4. Choose the kind (Estimation / Report / Presentation), an optional
   display name, and a version string (e.g. `v1.5`).

**Workspace default:**

1. Go to `/admin/templates`.
2. Click **Upload workspace default**.
3. Same fields as above; admin-only.

After upload the row appears in **PROPOSED** status. Within a few
seconds the AI binding proposer runs and populates the draft
binding.

### Proposer status & retry

Each row in the templates list shows its binding status:

- **AI is mapping…** — the proposer job is still running. The row
  auto-polls and refreshes when the job completes.
- **Ready** — the proposer succeeded. The draft binding is
  available for review.
- **Failed** — the proposer errored (bad file structure, model
  failure, etc.). A **Retry** button appears; clicking it re-queues
  the `propose-template-binding` job. The retry uses the same
  uploaded file, so you don't need to re-upload.

You can hand-edit the JSON in the binding editor at any point,
regardless of proposer status. The server validates the schema on
save and rejects malformed bindings with a 400 explaining which
field failed.

## 6. The template picker

When triggering a run that produces a templated output (Team &
Estimate, Generate Deliverable), the popup includes a **template
picker** so you can choose which approved template the engine
should use.

The picker default follows the same resolution order as automatic
fills: engagement-scoped APPROVED template first, workspace default
second. You can override that default by selecting any other
APPROVED template visible to the engagement. If you don't pick
anything, the default wins and the run behaves the same as before
the picker existed.

The picker only shows APPROVED templates of the kind appropriate
for the action — Team & Estimate sees ESTIMATION templates,
Generate Deliverable sees REPORT and PRESENTATION templates.

## 7. The binding

The binding is the small JSON document that connects engine outputs
to spots in your file. There are three target kinds for `.xlsx`:

- **Cell** — sheet + A1 ref (e.g. `Cover!B12`).
- **Named range** — a workbook-scoped defined name (e.g. `EstTotal`).
- **Table row** — a start cell + a column letter, grouped across
  sibling entries so each per-role array writes one row at a time.

For `.docx` and `.pptx` we substitute `{{placeholder}}` tokens.
Bookmarks are on the roadmap.

The list of engine fields you can bind is a closed enumeration owned
by `apps/web/src/server/services/template/binding.ts`. It currently
covers per-role aggregates (`roles[*].roleName`, `roles[*].hoursLow`,
…), totals, project context, engagement metadata, assessment counts,
joined bullet lists for findings/risks/recs, and the generated date.
That file is the canonical list — when you can't find a field in the
proposer's draft, check there before assuming it's missing.

> **Heads up — per-role hours and cost are zero today.** The engine
> currently emits `0` for `roles[*].hoursLow|hoursHigh|costLow|costHigh`
> until the per-role distribution work lands. Bindings that target
> those fields will write zeros. Totals (`totals.*`) and aggregate
> fields are unaffected. See ADR-0018 for the deferral rationale.

The proposer's draft will be close but not always perfect. You can
hand-edit the JSON in the binding editor; the server validates the
schema on save and rejects malformed bindings with a 400 explaining
which field failed.

## 8. AI-section field family (`section.<key>`)

Engine fields (totals, names, dates, raw bullet lists) are great for
structured slots but read poorly when a placeholder wants prose
narrative. The **`section.<key>`** field family closes that gap: it
plumbs the AI-written deliverable sections you see on the Deliverables
page directly into the output file.

How it works:

```
DB row: DeliverableSection         Binding entry:
  sectionKey: "phase_1_scope"       { "field": "section.phase_1_scope",
  contentDraft: "Foundation locks      "target": {
   down auth and observability..."         "kind": "docx.placeholder",
                                           "token": "{{section_phase_1_scope}}"
                                       }}
                                            │
                                            ▼
                                    Filler substitutes the AI prose
                                    into your `.docx` / `.pptx` / `.xlsx`
```

Two things to know:

- **Section keys are declared per deliverable type** in
  `packages/knowledge-seed/deliverable-templates/<key>.json` (e.g.
  `roadmap.json`, `executive-summary.json`). Each entry pins a key
  (`phase_1_scope`), a title, and a *purpose* — the prompt the AI
  reads when writing the body. When a customer uploads a template,
  the proposer reads this catalog and matches your placeholder
  tokens to the right `section.<key>` automatically.
- **Reviewer edits flow through.** The Deliverables UI lets reviewers
  edit or regenerate any section card before exporting. `contentFinal`
  (the approved version) wins over `contentDraft` at fill time, so
  the file always contains the latest reviewer-approved prose.

**Prefer `section.<key>` over `*.bulletList` for narrative slots.**
`findings.bulletList` / `risks.bulletList` / `recommendations.bulletList`
are pre-formatted engine dumps with internal `[severity/domain]`
prefixes — useful as raw data in a reference appendix, painful in
sponsor-facing prose. The proposer's system prompt explicitly tells
the AI to bind narrative-shaped tokens (anything that wants curated
sentences, headline summaries, milestone lists) to `section.<key>`
instead.

**Missing sections produce a warning, not a crash.** If the AI section
pass fails for one section out of N, the matching `{{section_<key>}}`
token won't resolve and the filler will log a
`Field "section.X" did not resolve` warning on the `TemplateFill` row.
Other tokens fill normally — soft-failure all the way through. You
can re-trigger the section from the per-section *Regenerate* button
on the Deliverables page and re-export to pick up the fresh prose.

The full set of section keys available per deliverable type lives
in `packages/knowledge-seed/deliverable-templates/`. Highlights:

| Deliverable type | Section keys (excerpt) |
|---|---|
| ROADMAP | `phase_1_scope`, `phase_2_scope`, `phase_3_scope`, `milestones_owners` |
| EXECUTIVE_SUMMARY | `headline_findings`, `top_risks`, `executive_recommendations` |
| ASSESSMENT_REPORT | `executive_summary`, `engagement_context`, `current_state`, `key_findings`, `risks`, `recommendations`, `target_state`, `team_and_estimate` |
| RISK_REGISTER | `risk_overview` |
| TARGET_STATE | `findings_drivers`, `risks_drivers`, `narrative`, `recommendations`, `transition_risks` |
| TEAM_PROPOSAL | `team_proposal_overview` |
| ESTIMATE | `estimate_overview` |
| ASSUMPTIONS_GAPS | `open_questions`, `dependencies`, `evidence_gaps`, `next_discovery_activities` |
| SOW_DRAFT | `sow_scope`, `sow_deliverables_summary` |
| GREENFIELD_DISCOVERY | `target_capabilities`, `architecture_style`, `technology_choices`, `phasing`, `greenfield_risks`, `greenfield_recommendations` |

If your template needs a section that isn't in the catalog for its
deliverable type, ask the engineering team to add an entry to the
matching JSON file — it's a one-time change that benefits the
workspace default, every existing customer template of that kind,
and every future upload.

See [ADR-0029](../architecture/decisions/0029-deliverable-section-field-family.md)
for the architectural rationale.

## 9. What happens on a fill

When the engine finishes its primary work for an assessment (running
estimation, generating a deliverable), it calls the template fill as
an optional follow-up step:

- Resolves the right template — the user's picker choice if any,
  otherwise engagement override → workspace default.
- Loads the file from MinIO, parses the binding, runs the per-format
  filler.
- Writes the produced file back as a `Document` on the assessment.
- Records a `TemplateFill` row with snapshots of the binding and the
  engine outputs that drove the fill, so the result is replayable.
- Records a `TEMPLATE_FILLED` (or `TEMPLATE_FILL_FAILED`) audit row.

**Soft-failure is by design.** A missing template, a malformed
binding, an unresolved field, a sheet that no longer exists — none
of these fail the run. The standard outputs always reach the user.
A partially-filled template still lands as a Document; the warnings
list is recorded on the audit row so a reviewer can spot bindings
that silently skipped entries.

### Download CTAs

After a fill lands successfully, a **Download** button appears on
the page that triggered it:

- **Team & Estimate** page — a Download button on the latest
  estimation fill for that assessment.
- **Deliverables** page — a Download button on the latest report or
  presentation fill for that assessment.

The button hits the `latestFillForAssessment` tRPC procedure and
streams the stored file from MinIO. If no fill exists yet (or the
last attempt soft-failed), the button is hidden and only the
standard outputs are offered.

### Fill history

The engagement **Templates** tab includes a **Recent Fills**
section showing the last 20 fills across all visible templates for
that engagement, newest first. Each row links to the assessment
that triggered it, the template version that ran, and the produced
document. Use it to audit which template version filled which
assessment over time. The data is pulled from
`recentFillsForEngagement` on the `template` router.

Recommended check after the first run on a new template: open the
filled document, eyeball the targeted cells, and adjust the binding
if a field landed in the wrong spot.

## 10. PowerPoint caveat — split-run tokens

PowerPoint sometimes splits a logical token across multiple
`<a:t>` text runs (commonly when the author edited a placeholder
mid-token, or PowerPoint auto-corrected partway through typing).
Our v1 PPTX filler does a flat string replace per slide XML file,
so a token split across runs is **silently missed** — the slide
keeps its placeholder text and a warning appears on the audit row.

Workaround: if you find a token isn't being substituted, retype it
in a single uninterrupted edit (delete the entire `{{...}}` and
type it back from scratch). That keeps it in one run.

A real run-merging pass is on the roadmap and will remove this
caveat.

## 11. Admin templates

Workspace defaults are managed at `/admin/templates`. The page
mirrors the engagement Templates tab — same list view, binding
editor, lifecycle controls, and Recent Fills (scoped to fills
across the workspace) — but is admin-only and operates on
templates with `engagementId = null`.

Use it to keep one canonical estimation workbook, narrative report
shell, and presentation shell that any engagement falls back to
when it hasn't uploaded its own.

## 12. Versioning

Versioning is manual and additive: re-uploading a file with a new
`version` string creates a **new row** rather than overwriting the
existing one. Approving the new row auto-deprecates the previous
approved row with the same `(name, kind, scope)`.

Old fills keep their link to the exact `templateId` they ran
against, so a later re-version never invalidates the audit history.

If you need to retire a template entirely, deprecate it (no new
fills) and then archive it (hidden from lists). Delete only when
you're sure no audit consumer needs the row.

---

## Where to read more

- [`docs/architecture/decisions/0018-template-binding.md`](../architecture/decisions/0018-template-binding.md)
  — the architectural rationale for the binding system.
- [`docs/architecture/decisions/0029-deliverable-section-field-family.md`](../architecture/decisions/0029-deliverable-section-field-family.md)
  — the `section.<key>` field family that lets AI prose flow into
  output files alongside engine data.
- `apps/web/src/server/services/template/binding.ts` — the canonical
  list of engine fields and target kinds.
- `packages/knowledge-seed/deliverable-templates/` — per-deliverable-
  type section specs (names + purposes of the AI-written sections).
- `apps/web/src/server/services/template/fill-and-store.ts` —
  resolution order and soft-failure semantics in code.
- `apps/web/src/server/trpc/routers/template.ts` — picker, retry,
  and fill-history procedures.
