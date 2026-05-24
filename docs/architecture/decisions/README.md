# Architecture Decision Records

This folder holds **ADRs** — short, numbered records of the non-obvious
architectural decisions we made while building the Assessment Co-Pilot.
Each ADR captures the context, the decision, the alternatives we
genuinely considered, and the consequences we're accepting. ADRs are
immutable once accepted; we supersede rather than edit.

## Why ADRs (not just the architecture doc)

The architecture doc at
[`../README.md`](../README.md) describes the system as it is **today**.
ADRs describe *why the system is this way and not some other way*.
When a future contributor asks "why on earth did they put the
chunker there?" the architecture doc says what; the ADR says why.

This matters most for:

- **Choices that look odd at first glance** — e.g. NOT_FOUND over
  FORBIDDEN, `maxRetries: 0`, knowledge-base-as-JSON.
- **Choices where a different reasonable engineer would've gone the
  other way** — chunk size, embedding model, retrieval fallback.
- **Choices we may want to revisit** — every week we ship in the
  Phase 3 roadmap has at least one such choice.

## Conventions

- **Filename:** `NNNN-kebab-case-title.md`. Zero-padded four-digit
  serial. Never reuse a number.
- **Status:** `Proposed → Accepted → Superseded by ADR-XXXX | Deprecated`.
  Transition by editing the status line in-place (the only edit an
  accepted ADR gets); otherwise never rewrite history — write a new
  ADR that supersedes the old.
- **Template:** copy [`_template.md`](./_template.md). Do not skip
  sections; use "N/A — <reason>" if a section truly doesn't apply.
- **Scope:** one decision per ADR. If you're writing two decisions,
  write two ADRs and cross-link them.
- **Length:** aim for one-page; anything longer is usually two
  decisions in a trenchcoat.
- **Authoring moment:** file the ADR *in the same PR as the code
  change*. Retrofitted ADRs lose the forces-at-play that made the
  decision non-obvious.

## Index

| # | Title | Status | Week |
|---|---|---|---|
| [0001](./0001-decouple-ingest-from-analyse.md) | Decouple ingest from analyse | Accepted | 1 |
| [0002](./0002-per-domain-analysis-fan-out.md) | Per-domain analysis fan-out | Accepted | 2 |
| [0003](./0003-embedding-model-choice.md) | Embedding model — `text-embedding-3-small` | Accepted | 3 |
| [0004](./0004-chunking-strategy.md) | Chunking strategy — recursive ~800/~100 | Accepted | 3 |
| [0005](./0005-pgvector-hnsw-over-ivfflat.md) | Vector index — pgvector HNSW | Accepted | 3 |
| [0006](./0006-hybrid-retrieval-fallback.md) | Hybrid retrieval with domain-filter fallback | Accepted | 4 |
| [0007](./0007-query-construction-per-retrieval-point.md) | Query construction per retrieval point | Accepted | 4 |
| [0008](./0008-archive-safety-gates.md) | Archive safety gates | Accepted | 5 |
| [0009](./0009-pat-per-engagement-credentials.md) | Repository credentials — PAT per engagement, encrypted at rest | Accepted | 6 |
| [0010](./0010-tarball-api-over-git-clone.md) | Repository ingest — GitHub tarball API over `git clone` | Accepted | 6 |
| [0011](./0011-evidence-traceability-first-class.md) | Evidence traceability as first-class data | Accepted | 7 |
| [0012](./0012-prompt-caching-and-cost-instrumentation.md) | Anthropic prompt caching + cost instrumentation | Accepted | 8 |
| [0013](./0013-analysis-mode-and-verifier-pass.md) | Analysis mode & per-domain verifier pass | Accepted | 9 |
| [0014](./0014-agent-harness-for-evidence-collection.md) | Agent harness for evidence collection | Accepted | Phase 4 Slices 0–3 |
| [0015](./0015-multi-provider-llm-routing.md) | Multi-provider LLM routing | Accepted | — |
| [0016](./0016-delete-legacy-claude-client-outright.md) | Delete legacy `claude-client.ts` outright | Accepted | — |
| [0017](./0017-dual-mode-evidence-collection.md) | Dual-mode evidence collection (MANUAL + AGENTIC) | Accepted | Phase 4 |
| [0018](./0018-template-binding.md) | Customer-uploadable templates with JSON bindings | Accepted | Phase 4 |
| [0019](./0019-background-job-lifecycle.md) | Background-job lifecycle as audit-log state machine | Accepted | Phase 4 |
| [0020](./0020-soft-failure-best-effort-work.md) | Soft-failure pattern for best-effort work | Accepted | Phase 4 |
| [0021](./0021-workflow-planner.md) | Workflow planner — graph of human-driven steps with re-planning | Accepted | Phase 4 |
| [0022](./0022-agent-credential-vault.md) | Agent credential vault — generalising ADR-0009 to arbitrary scopes | Accepted | Phase 4 |
| [0023](./0023-db-backed-feature-flags.md) | DB-backed feature flags via the `Setting` table | Accepted | Phase 4 |
| [0024](./0024-per-domain-evidence-tagging.md) | Per-domain evidence tagging — three complementary mechanisms | Accepted | Phase 4 |
| [0025](./0025-engagement-deletion-storage-sweep.md) | Engagement deletion — DB cascade plus best-effort storage sweep | Accepted | Phase 4 |
| [0026](./0026-agent-trace-viewer.md) | Agent trace viewer — five tiers of run inspection | Accepted | Phase 4 |
| [0027](./0027-hybrid-retrieval-rrf.md) | Hybrid retrieval — Postgres tsvector + cosine via Reciprocal Rank Fusion | Accepted | Phase 4 |
| [0028](./0028-evidence-citations.md) | Evidence citations — Flavour A (source attribution) now, Flavour B (claim grounding) deferred | Accepted | Phase 4 |
| [0029](./0029-deliverable-section-field-family.md) | AI-section field family for template bindings — `section.<key>` plumbs AI prose into `.docx` / `.pptx` / `.xlsx` outputs | Accepted | Phase 4 |
| [0030](./0030-deliverable-section-character-budgets.md) | Hard character budgets + strict format rules on deliverable-template section specs so AI output fits fixed-height OOXML text frames | Accepted | Phase 4 |

ADRs 001–012 are scheduled in the Phase 3 roadmap. See
[`../../design/phase-3-roadmap.md`](../../design/phase-3-roadmap.md)
per-week "Documentation & tests" subsections for the current list.
This table gets a new row each time an ADR lands.

## How to write a good ADR

- **State the decision in the first paragraph.** A reader skimming
  the index shouldn't have to scroll to learn what you decided.
- **Be honest about alternatives.** If you picked option B because
  you know it better, say so — that's a legitimate reason and future
  readers need to know it wasn't a pure technical call.
- **Record the rejected option's failure mode.** "IVFFlat was
  rejected because recall dropped below 0.8 on our test corpus" is
  useful; "IVFFlat was rejected because HNSW is better" is not.
- **Call out reversibility.** Is this a one-way door (schema
  migration with data) or a two-way door (swap an env var)? Readers
  calibrate risk from this.
- **Link to code.** Once the PR lands, add file paths to the
  Decision section so the ADR stays grounded.
