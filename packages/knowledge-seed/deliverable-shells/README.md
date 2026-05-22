# Deliverable shells

This folder holds **workspace-default deliverable templates** that
ship with the engine — the Word reports, PowerPoint decks, and
Excel registers a fresh install can fill in straight away. Customers
can still upload their own per-engagement overrides; these are the
defaults the seeder loads.

## File pair convention

Every shell is two files sharing a basename:

- `<slug>-v<N>.<ext>` — the binary (`.xlsx`, `.docx`, or `.pptx`).
- `<slug>-v<N>.binding.json` — the binding sidecar, validated
  against `BindingDocument` in
  `apps/web/src/server/services/template/binding.ts`.

Examples:

```
exec-summary-v1.docx
exec-summary-v1.binding.json

risk-register-v1.xlsx
risk-register-v1.binding.json
```

## `seed:` block in the binding's `notes`

The binding's `notes` field is freeform. The seed loader reads an
optional JSON fragment embedded in it to override filename-derived
defaults:

```json
{
  "version": 1,
  "templateKind": "EXECUTIVE_SUMMARY",
  "entries": [...],
  "notes": "Cover deck for the executive summary deliverable. seed: {\"name\":\"Executive Summary\",\"version\":\"v1\",\"kind\":\"EXECUTIVE_SUMMARY\"}"
}
```

If the `seed: { ... }` fragment is absent, the loader derives the
display name from the slug (title-cased, dashes → spaces), the
version from the filename suffix, and the kind from the binding's
own `templateKind`.

## Lifecycle

`pnpm db:seed` upserts a `Template` row per pair, keyed on
`(name, version, engagementId=null, kind)`. When the binding parses
cleanly the row is stamped **APPROVED** straight away — same rule as
for `estimation-templates/`. If MinIO is offline at seed time the row
is created with a placeholder `storagePath`; re-run seed once MinIO
is up to push the binary.

Re-running seed is idempotent — existing rows are updated in place,
no duplicates.
