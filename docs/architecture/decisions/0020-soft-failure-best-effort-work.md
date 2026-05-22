# ADR-0020: Soft-failure pattern for best-effort work

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Engineering
- **Related:**
  [ADR-0019](./0019-background-job-lifecycle.md) (terminal audit
  row taxonomy this pattern lives inside),
  [ADR-0018](./0018-template-binding.md) (the canonical caller —
  `fillAndStoreForAssessment`).

## Context

Some sub-steps inside long-running jobs are **optional but
nice-to-have**:

- Filling a customer-uploaded WBS template after
  `runEstimation` succeeds.
- Filling a deliverable Word/PowerPoint shell after
  `generateDeliverable` succeeds.
- Future hooks (e.g. emitting a Slack notification, syncing a
  Confluence page).

If any of those throw, the parent run is **already a success**: the
estimate is computed, the deliverable is generated. Bubbling the
exception would mark the parent `RUN_X_FAILED` (per ADR-0019) and
discard the work the user actually paid for. Hiding the exception
silently is also wrong — operators need to know a template fill
failed so they can fix the binding.

The pattern needs a name and a single shape so the next contributor
adding a "best-effort hook" doesn't have to redesign the failure
mode.

## Decision

Best-effort sub-steps follow these rules:

1. **They never throw to the parent.** The parent worker wraps the
   call in `try / catch` and logs at WARN.
2. **They write a typed audit row on failure.** Action name is
   `<HOOK>_FAILED` (e.g. `TEMPLATE_FILL_FAILED`); `details` carries a
   short reason code (`binding_schema_invalid`,
   `storage_put_failed`, …) plus the structured error.
3. **They return `null` (or a similarly explicit sentinel) on the
   skip path** — missing input, no template configured, optional
   feature disabled. No audit row for "nothing to do"; we only log
   *failures*, not no-ops.
4. **The parent's success row references the hook outcome** —
   `details.templateFillId` / `templateOutputDocumentId` are
   `null` when the hook was skipped or failed, populated when it
   succeeded. The UI reads those to decide whether to render the
   "Download populated WBS" CTA.

Canonical implementation lives in
`apps/web/src/server/services/template/fill-and-store.ts`. The
worker calls look like this in `run-estimation.ts` and
`generate-deliverable.ts`:

```ts
let templateFill = null;
try {
  templateFill = await fillAndStoreForAssessment(db, { ... });
} catch (fillErr) {
  console.warn(`[run-estimation] template fill failed: ${fillErr}`);
}
// parent success path runs unchanged
```

## Alternatives considered

- **Promote optional steps to first-class jobs on the queue.**
  Rejected — adds queue plumbing, more audit rows, and breaks the
  invariant that each run produces one terminal row in ADR-0019.
  Best-effort hooks are tightly coupled to the parent's outputs;
  decoupling them buys nothing.
- **Bubble the exception and add a `partial-success` terminal
  state.** Rejected — UI in-flight banners would have to handle a
  three-way state (success / partial / failed) and the parent's
  primary work would feel less successful than it actually is.
  Reviewers want the estimate; the missing template fill is a
  separate problem.
- **Swallow silently with no audit row.** Rejected — operators
  wouldn't know their binding is broken until a customer noticed.

## Consequences

**Positive**

- Adding a new optional hook is a 10-line wrapper, not a design
  decision.
- Operators get a queryable failure log without paying with parent-
  run reliability — `SELECT … FROM audit_log WHERE action ENDS WITH
  '_FAILED'` surfaces every soft failure across the system.
- The UI gets a clean signal: presence of an output document or
  `templateFillId` in the parent run's success row drives the CTA.
- The pattern composes — a future hook (Slack notification) can sit
  next to template fill in the same try/catch chain without one
  failure cascading into another.

**Negative**

- Operators must **read the audit log** to spot soft failures; the
  UI doesn't put a banner on the engagement page saying "your last
  template fill failed". Mitigation: the Templates tab's "Recent
  fills" section surfaces the populated outputs, and a recent
  failure with no fill is implicitly visible by absence. A future
  improvement could surface `_FAILED` rows in a sidebar.
- Distinguishing "skipped because no input" from "failed mid-fill"
  requires reading the audit details, not the absence of a row. The
  rule "no row for no-ops" is deliberate but takes a moment to
  internalise.

**Neutral**

- The pattern is **scope-limited** — only for hooks the user
  expects to be optional (template fill is configurable; deliverable
  generation is not). Any step on the critical path stays loud.

## Follow-ups

- A small `BestEffortFailureBanner` component on the engagement
  detail page that queries the recent `_FAILED` audit rows and
  surfaces them so operators don't have to dig.
