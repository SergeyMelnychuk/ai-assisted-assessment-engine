# ADR-0029: AI-section field family for template bindings

- **Status:** Accepted
- **Date:** 2026-05-23
- **Deciders:** Engineering
- **Related:**
  [ADR-0015](./0015-multi-provider-llm-routing.md) — `deliverable.section`
  AI task that writes the section bodies this ADR threads into output files;
  [ADR-0018](./0018-template-binding.md) — original binding spec; this
  ADR extends the binding's `field` vocabulary with the `section.<key>`
  family;
  [ADR-0020](./0020-soft-failure-best-effort-work.md) — section
  resolution stays soft-failure: a missing key produces a warning, not
  a crashed run.

## Context

Two output channels for a generated deliverable used to run in
parallel without ever meeting:

1. **AI section pass** (`runDeliverableGeneration` in
   `apps/web/src/server/services/deliverable-generator.ts`) — per
   deliverable type, fans out one `deliverable.section` Claude call
   per section spec declared in
   `packages/knowledge-seed/deliverable-templates/<key>.json`.
   Outputs land as `DeliverableSection` rows on the new
   `Deliverable` row and surface in the Deliverables UI as section
   cards the reviewer can edit / regenerate.
2. **Template fill** (`fillAndStoreForAssessment` in
   `apps/web/src/server/services/template/fill-and-store.ts`,
   ADR-0018) — opens the workspace-default or customer-uploaded
   `.docx` / `.pptx` / `.xlsx` shell, walks the binding entries,
   substitutes each `{{token}}` (docx/pptx) or cell (xlsx) with the
   matching `EngineOutputs` field (totals, counts, names, raw
   bullet lists).

The two paths share no state. The narrative the AI wrote for the
section cards never reached the downloaded file. Anywhere the
deliverable shell needed prose narrative, one of two things
happened:

- The slide / paragraph stayed empty (templates that left consultant-
  fill placeholders, e.g. the per-phase scope boxes on the roadmap),
  or
- The binding wired it to a raw `findings.bulletList` /
  `risks.bulletList` / `recommendations.bulletList` engine field —
  pre-formatted dumps with internal `[severity/domain]` prefixes that
  read poorly in sponsor-facing copy.

The user-visible failure surfaced as a generated roadmap whose Phase
1/2/3 scope boxes were blank and whose milestones panel held 58
unfiltered recommendation lines tagged `[CRITICAL/security_iam] …`.

We had two incomplete options for closing this gap:

- **Author per-template prose in the binding itself.** Brittle and
  doesn't scale across customer uploads.
- **Stop running the AI section pass and have the filler call Claude
  directly when it hits a narrative slot.** Double the AI calls per
  fill, breaks the "edit a section card and re-export" UX promise,
  and makes per-section regenerate (the existing UI feature) point at
  nothing.

Neither path preserved the property we wanted: **the section the
reviewer sees in the UI and the section the .pptx contains must be
the same artefact**, edited once, exported many times.

## Decision

Add a new field family `section.<key>` to the template binding
language. A binding entry of the form

```json
{
  "field": "section.phase_1_scope",
  "target": { "kind": "docx.placeholder", "token": "{{section_phase_1_scope}}" },
  "format": "auto"
}
```

resolves at fill time to the body of the matching `DeliverableSection`
row for the assessment + deliverable type. The filler substitutes the
prose into the file the same way it substitutes any other engine
field.

Concrete shape:

- **`EngineOutputs.section: Record<string, string>`** — populated by
  `loadEngineOutputs(db, assessmentId, deliverableType?)`. When
  `deliverableType` is set, the loader pulls the *latest*
  `DeliverableSection` rows for that assessment + type and surfaces
  them keyed by `sectionKey`. `contentFinal` wins over `contentDraft`
  so reviewer edits override the AI draft. Missing keys yield
  `undefined` at resolution time — the filler logs an unresolved-
  field warning (soft-failure, ADR-0020).
- **`resolveEngineField`** gains a special-case for `section.<key>`:
  arbitrary keys with underscores / dashes resolve as a single map
  lookup instead of being dot-walked.
- **The binding allowlist (`ENGINE_OUTPUT_FIELDS` in `binding.ts`)**
  lists illustrative `section.*` paths but the filter at proposer
  output time treats `section.<key>` as **open-ended**: any well-
  formed `^section\.[A-Za-z0-9_]+$` path passes.
- **`fillAndStoreForAssessment`** maps `TemplateKind →
  DeliverableType` (1:1 for the per-deliverable kinds; `null` for
  `ESTIMATION` + legacy `DELIVERABLE_REPORT` /
  `DELIVERABLE_PRESENTATION` — those fills run before any deliverable
  exists and just get `section = {}`).
- **The AI binding proposer** (`binding-proposer.ts`,
  `template-binding.ts` prompt) is taught the new family. The
  proposer:
  - Loads `packages/knowledge-seed/deliverable-templates/<key>.json`
    for the customer's chosen `TemplateKind` and injects the section
    catalog (key + title + purpose) into the prompt under an "AI
    section keys" block.
  - The system prompt's "must come from the engine catalog" rule is
    extended: `section.<key>` paths may also come from this per-
    deliverable catalog. The rule explicitly prefers `section.<key>`
    over `*.bulletList` for narrative-shaped placeholders.
  - The post-AI filter accepts any `section.<key>` shape (not just
    catalog members) — missing keys surface as runtime warnings, which
    is more diagnostic than a silent post-AI drop.

All ten workspace-default deliverable shells were updated in lockstep
to (a) ship a matching `deliverable-templates/<key>.json` spec and
(b) replace raw `*.bulletList` dumps + consultant-fill empty bodies
with `{{section_<key>}}` placeholders bound to the new fields.

## Alternatives considered

- **Push narrative into the binding via inline templating** (e.g.
  Handlebars-style loops over findings inside the binding JSON).
  Rejected — customers don't write templates with logic in them, and
  it'd duplicate the AI synthesis the section pass already does. The
  goal was to land the existing AI output into the file, not to add a
  second synthesis path.
- **Have the filler call Claude directly when it hits a narrative
  placeholder.** Rejected — doubles the AI calls per fill (one in the
  section pass, one in the filler), makes per-section regenerate
  inconsistent (UI shows one version, file shows another), and breaks
  the cost-attribution model since the filler would issue an
  unscoped `deliverable.section` call.
- **Hard-code a `customer.<token>` field family that returns
  whatever's in the section by exact token name.** Rejected — tied the
  feature to docx/pptx placeholder tokens specifically and didn't
  generalise to xlsx cells; also forced customers to name their
  tokens identically to internal section keys, which they don't.
- **Skip the proposer integration; document that customers must
  hand-edit bindings to add `section.<key>` entries.** Rejected —
  every customer upload would have an unbound narrative slot until
  someone learned the convention. The proposer integration is what
  makes the feature work for new uploads without per-customer
  authoring.

## Consequences

- **Positive**
  - Generated `.docx` / `.pptx` / `.xlsx` files now ship with the
    same AI prose the reviewer sees in section cards — single source
    of truth, edit once, export many times.
  - The user-facing roadmap regression (empty phase boxes, raw rec
    dump in milestones) is fixed by spec, not by a one-off hack —
    the same mechanism applies to every deliverable type.
  - Customer-uploaded templates benefit automatically: the proposer
    knows which section keys exist for their chosen deliverable type
    and proposes `section.<key>` bindings without per-customer
    engineering.
  - Per-section regenerate (existing UI feature) now flows through to
    the exported file on the next download — closing a loop that
    didn't exist before.
  - No new AI calls per fill; we're just plumbing the existing
    section pass's output into a previously unused channel.
- **Negative**
  - Adding a new section to a deliverable type requires updating two
    JSON files (the `deliverable-templates/<key>.json` spec and any
    `.binding.json` that references it). The spec is the canonical
    declaration; bindings are the consumer.
  - The proposer prompt grows by the section catalog size. For the
    largest deliverable (assessment report, 9 sections) that's roughly
    300 extra tokens per binding-proposer call — fine, but worth
    keeping the section `purpose` field concise.
  - The filler's unresolved-field warnings now include `section.<key>`
    misses when an AI run partially fails. Reviewers may see warnings
    on the `TemplateFill` row for sections that the AI section pass
    skipped. That's intentional (visibility into degradation) but
    could be confusing — see the templates guide for the explanation.
- **Neutral**
  - `EngineOutputs` gained one new required field (`section`).
    Existing test fixtures across all `*-fill.test.ts` files needed a
    `section: {}` literal — a one-line update per test, no semantic
    change.
  - `loadEngineOutputs`'s signature gained an optional
    `deliverableType` parameter. Callers that don't pass it (the
    estimation xlsx fill, future ad-hoc fills) get
    `outputs.section = {}` and behave exactly as before.

## Follow-ups

- [ ] When the AI section pass partially fails (1–2 sections out of
      N), surface the per-section failure on the `TemplateFill` row's
      warnings list so reviewers can see exactly which placeholder
      will be empty in the file. Today the filler logs "Field
      `section.X` did not resolve" without context on *why*.
- [ ] Consider an idempotency guarantee on regenerate: when a section
      regenerate fires while a `TemplateFill` is in flight, the fill
      should see the *post-regenerate* version, not the snapshot
      taken at enqueue. Today there's a race; in practice it's tiny.
- [ ] Audit the legacy generic kinds (`DELIVERABLE_REPORT`,
      `DELIVERABLE_PRESENTATION`) — they don't get section catalogs
      today because the kind alone doesn't pin a deliverable type.
      A migration to per-type kinds for every existing customer
      template would close this gap, but isn't worth doing until a
      customer actually requests it.

## References

- `apps/web/src/server/services/template/engine-outputs.ts` — new
  `section: Record<string, string>` field + `loadEngineOutputs`
  signature change + `resolveEngineField` section-path branch.
- `apps/web/src/server/services/template/binding.ts` — illustrative
  `section.*` entries in the field allowlist.
- `apps/web/src/server/services/template/binding-proposer.ts` —
  open-ended section filter + per-deliverable-type section catalog
  loader.
- `apps/web/src/server/services/ai/prompts/template-binding.ts` —
  proposer system + user prompt updates teaching the AI about the
  `section.<key>` family.
- `apps/web/src/server/services/template/fill-and-store.ts` —
  `TemplateKind → DeliverableType` mapping; threads the type through
  `loadEngineOutputs`.
- `packages/knowledge-seed/deliverable-templates/*.json` — ten
  per-deliverable-type section specs (assessment-report.json existed
  before; the other nine are new in this work).
- `packages/knowledge-seed/deliverable-shells/*.{pptx,docx,xlsx}` +
  matching `*.binding.json` — all ten workspace-default shells +
  bindings updated to the new field family.
- `docs/guides/templates.md` §"AI-section field family" — operator-
  facing explanation of how the binding language now spans engine
  data + AI prose.
