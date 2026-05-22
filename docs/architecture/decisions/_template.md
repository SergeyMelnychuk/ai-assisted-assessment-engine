# ADR-NNNN: <short decision title>

- **Status:** Proposed <!-- Proposed | Accepted | Superseded by ADR-XXXX | Deprecated -->
- **Date:** YYYY-MM-DD
- **Deciders:** <names or roles>
- **Related:** <links to other ADRs, roadmap tasks, PRs, architecture-doc sections>

## Context

What is the problem we're solving? What forces are at play (technical,
product, organisational)? Keep this factual — no decision yet. A
reader who has never seen the codebase should understand *why this
decision needed to be made at all* after reading this section.

## Decision

The choice, stated crisply. One paragraph at most, followed by the
concrete shape (interfaces, data model changes, env vars, new jobs,
etc.). Bullet lists are fine. Link to code where it already exists.

## Alternatives considered

Enumerate the options that were genuinely on the table. For each:

- **Option name** — one-sentence summary. Why rejected? (cost, risk,
  complexity, team fit, reversibility). Be honest — "we didn't have
  time to learn X" is a valid reason; pretending otherwise rots the
  record.

Rejected options that were never seriously considered don't belong
here — this section documents the *real* fork in the road.

## Consequences

What changes because of this decision? Both sides of the ledger:

- **Positive** — what becomes easier, cheaper, safer, faster.
- **Negative** — what becomes harder, what debt we take on, what we
  can no longer do without revisiting this ADR.
- **Neutral** — shape changes that are neither win nor loss but that
  future readers need to know about (e.g. "all new tables get a
  `tenant_id` column").

## Follow-ups

Concrete things this ADR doesn't decide but implies. Tracked as
roadmap tasks, backlog items, or linked issues. This section is
what distinguishes an ADR from a design doc — it closes the loop.

- [ ] …
- [ ] …

## References

- `docs/design/phase-3-roadmap.md` §<week>
- `docs/architecture/README.md` §<section>
- External: <links to vendor docs, RFCs, blog posts that informed the
  call>
