# ADR-0030: Hard character budgets + strict format rules on deliverable-template section specs

- **Status:** Accepted
- **Date:** 2026-05-24
- **Deciders:** Engineering
- **Related:**
  [ADR-0029](./0029-deliverable-section-field-family.md) — establishes
  the `section.<key>` field family that plumbs AI prose into output
  files; this ADR governs how those sections are sized.

## Context

The AI section pass (`runDeliverableGeneration` →
`deliverable.section` Claude calls) writes prose that the template
filler splices into placeholders in `.pptx` / `.docx` / `.xlsx`
files. The slots those placeholders sit in have **fixed geometry**:

- **PowerPoint slide text frames** are sized at author time and don't
  grow. When the substituted content exceeds the frame's capacity
  the rendering engine **auto-shrinks** the text to fit. Past
  roughly 8pt it becomes illegible. We observed this in production
  on the Roadmap deck when an AI section ran ~1,100 characters into
  a frame whose comfortable cap is ~500.
- **Word table cells** behave similarly inside fixed-width columns —
  they don't shrink, but a four-paragraph "summary" inside a one-row
  summary cell pushes surrounding layout off the page.
- **Excel cells** with `wrapText` on don't shrink either, but rows
  grow tall enough that the spreadsheet becomes unreadable.

The section spec format (`packages/knowledge-seed/deliverable-templates/<key>.json`)
exposes a per-section `purpose` field — a free-form natural-language
instruction the AI gets in the prompt. Before this change `purpose`
typically described the *intent* of the section ("write a sponsor-
facing summary of the headline findings") with at most a vague
length hint ("3–4 sentences"). The AI interpreted vague hints
liberally — sometimes 3 sentences, sometimes 9, sometimes a 12-bullet
list — and the downstream auto-shrink made bad days look catastrophic
in the exported file.

`targetLength` (the spec's existing enum: `"short"` / `"medium"` /
`"long"`) is too coarse to enforce anything. It influences the prompt
the way any vague instruction does — without numeric bounds the AI
nondeterministically over- and under-shoots.

We considered three remediation paths:

1. **Render-time enforcement** in the filler: truncate AI output to
   N characters, cut mid-sentence if needed.
2. **Disable auto-shrink** on the slide text frames so overflow
   becomes obvious (text spills past the frame).
3. **Author-time hard limits** in the section spec itself — declare
   the character / bullet / words-per-bullet budget next to the
   section purpose, and have the AI prompt receive it verbatim.

## Decision

Adopt option (3). Every section spec under
`packages/knowledge-seed/deliverable-templates/<key>.json` MUST
declare hard, numeric format constraints in the `purpose` field for
each section. The constraints are derived from the actual geometry
of the slot the section lands in (slide text-frame dimensions, table
cell width, etc.) and are framed as non-negotiable rules the AI must
honour.

A compliant `purpose` field carries:

- **A total-character ceiling** for the section body
  (e.g. "Total output ≤ 500 characters"). This is the hard wall; the
  AI must come in under it.
- **A bullet-count ceiling** when the section is a list
  (e.g. "Up to 5 markdown bullets").
- **A per-bullet word ceiling** when bullets are used
  (e.g. "Each bullet ≤ 18 words, NO sub-bullets").
- **A format pattern** when one is recoverable
  (e.g. "Pattern: \`**Risk title** — impact; mitigation.\`").
- **Negative constraints** for things the AI tends to add without
  prompting (e.g. "NO `[severity/domain]` prefixes", "NO sub-bullets",
  "NO supporting paragraphs"). Listing the anti-patterns explicitly
  is cheaper than trying to over-specify the positive shape.

The spec's top-level `description` field gains a `**Hard
constraint:**` paragraph stating the geometric reason for the
budgets — so a future spec author sees the rationale alongside the
limits.

The existing `targetLength` enum is retained for back-compatibility
but treated as a coarse hint; the character ceiling is what the
filler-bound prompt actually enforces.

All ten workspace deliverable specs that ship to customers have been
updated in lockstep with this ADR landing
(`executive-summary.json`, `roadmap.json`, `target-state.json`, and
the rest under `packages/knowledge-seed/deliverable-templates/`).

## Alternatives considered

- **Render-time truncation in the filler.** Rejected: cuts mid-
  sentence, breaks bullet rendering, and silently loses content the
  reviewer wrote feedback to include. Doesn't address the root
  cause that the AI was generating too much.
- **Disable PowerPoint auto-shrink** on the slide text frames so
  overflow becomes a visible "text falls past the edge" failure
  instead of an unreadable-text failure. Rejected: the failure mode
  is just as bad (content invisible vs. tiny), and PowerPoint's
  default exists because the alternative is worse in client-facing
  decks. Doesn't address the AI-overshoot root cause either.
- **Post-generation length checker that re-prompts** when the AI
  output exceeds a budget. Adds a second Claude call per over-long
  section, doubling token cost and latency. Rejected for now — if
  the declarative-budget approach proves insufficient we'll revisit
  with this as a fallback.
- **Programmatic geometry inspection at spec-author time** —
  extract the actual text-frame dimensions from the `.pptx` XML and
  surface them in a tool that helps the spec author pick budgets.
  Worth doing as a follow-up; for v1 we hard-code budgets we
  validated by hand against the shipped shells.

## Consequences

- **Positive**
  - Generated `.pptx` / `.docx` / `.xlsx` outputs stop auto-shrinking
    to illegible sizes. The user-visible failure (shrunken text on
    the Roadmap deck) is closed at the source.
  - Spec authors and binding proposers see the constraints in the
    same file — the catalog the AI binding proposer ingests
    (ADR-0029) already includes the section `purpose` field, so the
    AI sees the budget at binding-proposal time too.
  - Declarative + version-controlled: edits to budgets land via PR
    review like any other content change, with diffs that explain
    the geometric reason in the spec's `description`.
  - Customer-uploaded templates with similarly-shaped text frames
    inherit the same constraints automatically — the spec is shared
    across workspace defaults and customer overrides for a given
    deliverable type.
- **Negative**
  - Tighter budgets mean some content nuance gets cut. We accept
    "the right content fits the slide" over "the full content runs
    off the slide invisibly."
  - Budgets must be re-validated whenever a shell file's text-frame
    geometry changes (e.g. the Roadmap deck gets a new layout). No
    automated check today — drift will only show as visibly cramped
    or shrunken output until someone notices.
  - Each new deliverable type or new section requires authoring
    discipline: the spec author has to know the slot dimensions and
    pick a defensible budget. Not hard, but a step that's easy to
    skip without convention enforcement.
- **Neutral**
  - The `targetLength` enum stays in the schema but is no longer
    load-bearing. Newer specs ignore it in favour of the explicit
    ceilings; older specs that lack ceilings degrade to the
    pre-ADR-0030 vague-hint behaviour.

## Follow-ups

- [ ] Automated character-budget check at section-generation time:
      warn (and optionally re-prompt) when the AI's output exceeds
      the spec's declared ceiling. Cheap to implement at the
      `deliverable.section` call site; defer until we see specs
      drifting in practice.
- [ ] Tool / script that inspects a `.pptx` / `.docx` shell and
      reports the text-frame dimensions per placeholder token. Would
      let spec authors pick budgets from observed geometry rather
      than eyeballing.
- [ ] Apply the same discipline to `.xlsx` cells where overflow
      meaningfully degrades layout (e.g. risk-register Cover
      `risk_overview`). The current spec budgets focus on `.pptx`;
      the `.xlsx` audit hasn't run yet.
- [ ] Treat `targetLength` as deprecated in the JSON schema —
      either remove it (with a migration of older specs) or
      formally mark it `@deprecated` so the proposer + section pass
      stop relying on it. Low priority but cleans up the schema.

## References

- `packages/knowledge-seed/deliverable-templates/executive-summary.json` —
  three sections, each with ≤ 600–700 character budgets.
- `packages/knowledge-seed/deliverable-templates/roadmap.json` —
  per-phase sections at ≤ 500 chars; milestones at ≤ 700.
- `packages/knowledge-seed/deliverable-templates/target-state.json` —
  five sections, budgets 450–600 chars depending on slot.
- `apps/web/src/server/services/deliverable-generator.ts` — the
  `deliverable.section` Claude call where the `purpose` field lands
  in the prompt verbatim.
- ADR-0029 §"Consequences" — notes that section keys carry AI
  narrative; this ADR governs how that narrative is sized.
