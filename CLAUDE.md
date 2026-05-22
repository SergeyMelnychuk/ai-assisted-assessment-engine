# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Communication style

Use simple, clear, practical English.

Avoid complicated wording, academic language, and unnecessary abstractions.
Explain technical concepts in plain language.
Prefer short sentences and structured answers.
Give direct recommendations first, then explain reasoning.

The user prefers concise, human-like explanations similar to a senior colleague.

## Common commands

All commands run from the repo root. Turborepo dispatches into `apps/web`.

```bash
# Dev loop
pnpm dev                 # Next.js on :3000
pnpm worker              # BullMQ consumer (run in a second terminal)
pnpm worker:dev          # same, with --watch

# Quality gates
pnpm --filter @copilot/web type-check    # canonical correctness gate
pnpm --filter @copilot/web lint
pnpm --filter @copilot/web test          # vitest run
pnpm --filter @copilot/web test:watch
pnpm --filter @copilot/web test <pattern>   # e.g. test filler, test template

# Database
pnpm db:generate         # Prisma client (run after schema edits)
pnpm db:migrate          # apply migrations (uses migrate deploy)
pnpm --filter @copilot/web db:migrate:dev -- --name <name>   # author a new migration
pnpm db:seed             # seed assessment types, KB, rate card, admin user, workspace templates
pnpm db:studio

# First run
docker-compose up -d     # Postgres (pgvector), Redis, MinIO, PlantUML
pnpm install
cp .env.example apps/web/.env
pnpm db:generate && pnpm db:migrate && pnpm db:seed
```

Smoke tests (require live stack + worker) live in `scripts/smoke/*.sh`. Run them after changes that touch ingest, analysis, RAG, archives, repo links, evidence trail, or cost instrumentation.

## Architecture

Monorepo (pnpm workspaces + Turborepo). Single Next.js 15 app under `apps/web`; data lives in `packages/knowledge-seed/` as JSON loaded by `prisma/seed.ts`.

### Two processes, one codebase

- **Web** (`apps/web` via `next dev`): UI, tRPC routers, REST routes under `src/app/api/*` (auth, file upload/download, deliverable export).
- **Worker** (`src/server/queue/worker.ts` via `tsx`): BullMQ consumer. The worker imports services directly — it doesn't hit Next. Jobs live under `src/server/queue/jobs/`. Job types are a discriminated union on `DocumentJobData` in `queue.ts`; the worker switch is exhaustively typed.

Job types in play: `ingest-document`, `ingest-diagram`, `ingest-archive`, `ingest-repository`, `generate-follow-ups`, `run-analysis`, `run-estimation`, `generate-deliverable`, `agent-harness`, `propose-template-binding`, `prune-logs` (repeatable). One queue (`document-processing`) keeps ordering and backpressure uniform.

### tRPC router layout

Root router at `src/server/trpc/router.ts` composes per-domain routers under `src/server/trpc/routers/` (engagement, assessment, document, finding, risk, recommendation, scoring, estimation, deliverable, review, export, evidenceExplorer, repositoryLink, knowledgeArtifact, agentRun, template, …). Mutations that kick off background work always emit an `ENQUEUE_*` audit row before calling `enqueue*`.

### Data + audit trail

Postgres with pgvector. Schema source-of-truth is `apps/web/prisma/schema.prisma`. Two log tables, distinct purposes:

- `AuditLog` — business event ledger (`USER_APPROVED_X`, `RUN_ANALYSIS`, `AI_CALL`, `TEMPLATE_*`). Every mutation that matters writes a row. Worker success/failure also writes (`RUN_X` / `RUN_X_FAILED` / `RUN_X_CANCELLED`); the in-flight banner reads these to flip state without polling Redis.
- `Log` — operator-facing application traces. Pruned every 6h by the repeatable `prune-logs` job. Distinct from AuditLog by design.

### Document pipeline (ADR-0001)

`Document.ingestStatus` is the single source of truth: `PENDING → PROCESSING → READY` (or `FAILED`). Ingest writes Evidence rows; AI analysis is a *separate* job (`run-analysis`) keyed by assessment, not document. `ingest-archive` (ADR-0008) and `ingest-repository` (ADR-0009/0010) fan out child Documents with safety gates (size/depth/zip-slip) and per-engagement encrypted PATs.

### RAG retrieval (ADR-0003 → 0007, 0027)

`text-embedding-3-small` + pgvector HNSW cosine. Per-retrieval-point query construction (one query per finding/risk/rec/scoring point). Widen-on-underfill fallback when a domain filter underfills (ADR-0006). `EMBEDDING_MODE=fake` is supported for CI/dev without an OpenAI key.

**Hybrid retrieval (ADR-0027).** Behind `features.hybridRetrieval` (default off): a `tsvector` column on `Evidence` powers Postgres-native lexical search; the retriever fuses cosine + lexical via Reciprocal Rank Fusion (`k=60`) in a single CTE query. Closes the gap on exact-string queries (version numbers, error codes, file paths, rare acronyms) that pure cosine handles poorly. Flag-gated and reversible; the cosine path is unchanged when the flag is off.

### AI router (ADR-0015)

All AI calls go through `src/server/services/ai/router.ts`. Tasks are registered in `model-registry.ts` (`AiTask` union, primary + fallback model). The router writes `AI_CALL` audit rows with token + cost math (ADR-0012). Use `callAi(task, ...)` and `parseJsonResponse` — don't reach for `@anthropic-ai/sdk` directly. New AI features require a new task entry plus a copy entry in `components/admin/settings/ai-router-copy.ts`.

**Prompt caching is per-task, opt-in.** `cacheSystem: true` on a `ModelBinding` makes the router send the system message with Anthropic's `cacheControl: { type: "ephemeral" }`. Currently enabled on `analysis.synthesis`, `analysis.verifier`, `deliverable.section`, `agent.planner`, `agent.workflow_planner`, `ingest.domain_classifier`. Cache hits show up as `cacheReadInputTokens` on `AI_CALL` audit rows. Anthropic's ephemeral TTL is 5 minutes, so caching only pays off for burst patterns (e.g. analysis fan-out across 8 domains in one run); single calls minutes apart pay the write surcharge with no read offset.

### Soft-failure pattern

Optional / best-effort work (template fills after estimation, deliverable population) writes a typed audit row on failure but never throws to the caller. The principle: a missing template, broken binding, or MinIO hiccup must not fail the parent run. See `services/template/fill-and-store.ts` for the canonical implementation.

### Background-job lifecycle convention

Each long-running job has matching audit actions: `ENQUEUE_X` (tRPC), `RUN_X` / `GENERATE_X` (worker success), `RUN_X_FAILED`, `RUN_X_CANCELLED`. The UI's "in-flight" banners poll a `*.runStatus` query that derives `inFlight` from those rows. Cancellation is cooperative: the tRPC mutation writes `CANCEL_X_REQUESTED`; the worker's `throwIfCancelled` checks before each expensive step.

### Feature flags

DB-backed (`Setting` table), not env-backed. Toggled at `/admin/settings?tab=ai-router`. Read via `services/settings-service.ts` (cached ~10s per process). Don't add new env-based feature toggles — extend the settings service.

Current flags:
- `features.agentEnabled` — gates the agent harness routes/UI (ADR-0014, ADR-0017). Default OFF.
- `features.autoClassifyChunks` — per-chunk domain auto-classifier at ingest (ADR-0024). Default OFF.
- `features.agentFlowVisible` — sub-flag of the agent feature; hides the `AgentFlowDiagram` trace viewer when OFF (ADR-0026). Default ON (missing row treated as ON for back-compat).
- `features.hybridRetrieval` — fuses cosine + Postgres-native lexical via RRF when ON (ADR-0027). Default OFF.

### Knowledge seed

`packages/knowledge-seed/` contains JSON for question templates (per domain), risk patterns, scoring frameworks, the role catalog, the default rate card, plus two template folders:

- `estimation-templates/` — workspace-default WBS / estimation workbook (`wbs-and-estimates-v1.5.xlsx` + sidecar `*.binding.json`).
- `deliverable-shells/` — one file per deliverable type (`assessment-report-v1.docx`, `executive-summary-v1.pptx`, `risk-register-v1.xlsx`, `roadmap-v1.pptx`, `target-state-v1.pptx`, `team-proposal-v1.docx`, `estimate-summary-v1.xlsx`, `assumptions-gaps-v1.docx`, `sow-draft-v1.docx`, `greenfield-discovery-v1.docx`), each paired with a sidecar `<slug>-v<N>.binding.json`.

`prisma/seed.ts` upserts everything, including stamping each shell as a workspace-default `Template` row with status APPROVED keyed off the per-deliverable-type `TemplateKind`. To ship new content (a new question pack, a new framework, a new shell), drop the file + sidecar and re-run `pnpm db:seed` — no migration needed.

### Customer-uploadable templates (ADR-0018)

Customers upload `.xlsx` / `.docx` / `.pptx` workbooks; an AI proposer drafts a JSON binding mapping engine outputs to cells/placeholders; humans approve. Lifecycle PROPOSED → APPROVED → DEPRECATED, with archive/delete. The estimation and deliverable workers fill the chosen template best-effort (soft-failure). All filling code is under `src/server/services/template/`.

**`TemplateKind` per deliverable type.** The enum has one kind per `DeliverableType` (`EXECUTIVE_SUMMARY`, `ASSESSMENT_REPORT`, `RISK_REGISTER`, `TARGET_STATE`, `ROADMAP`, `TEAM_PROPOSAL`, `ESTIMATE`, `ASSUMPTIONS_GAPS`, `SOW_DRAFT`, `GREENFIELD_DISCOVERY`), plus the legacy generic kinds (`DELIVERABLE_REPORT` / `DELIVERABLE_PRESENTATION`) kept as fallbacks for older rows. Resolution in `fillAndStoreForAssessment`: exact-kind match first, then format-matching legacy fallback, then null. The Deliverables UI only lists types where an APPROVED template is available — `template.deliverableTypesWithTemplates` returns that set.

### Per-domain evidence tagging

Chunks historically all landed in a single `"ingested"` catch-all bucket, making the Evidence Explorer's domain filter a no-op. Three complementary mechanisms now produce real per-domain tags:

1. **Upload-time** — `Document.domain` column; the upload form exposes a domain dropdown sourced from `Assessment.activeDomains`. The ingest worker stamps every chunk with the chosen domain.
2. **AI auto-classifier** — `services/ingest/domain-classifier.ts`, gated by the `features.autoClassifyChunks` flag (off by default). Runs post-ingest as a best-effort hook; failures stay in the catch-all. Uses AI task `ingest.domain_classifier` (Haiku 4.5 primary) — new `"ingest"` `AiCallType` for cost rollup.
3. **Manual re-tag** — `evidenceExplorer.retag` mutation + multi-select checkboxes on the Search results. Lets reviewers fix mis-classified chunks after the fact.

The retriever's domain filter widens to include `"ingested"` automatically (`domain = X OR domain = 'ingested'`) so picking a domain still returns the catch-all chunks the analysis engine reads — matches `analysis-engine.ts` semantics.

### Evidence Explorer

Search-only surface: semantic search with domain dropdown, source-document type-ahead multi-select, bulk re-tag toolbar. The standalone Documents page owns the document index — duplicating it inside the Explorer was removed. Domain labels go through `lib/domain-labels.ts` (`domainLabel()`) — snake_case keys are never user-facing. The retriever uses `Prisma.sql` composition so optional `documentIds` IN-list filters compose with the domain filter without four SQL shapes.

### Evidence citations + context popup (ADR-0028)

Single citation surface — `components/evidence/evidence-citation.tsx` — renders the source trail consistently across the Explorer, "Why this finding?", finding/risk/recommendation lists, and the agent trace side panel. Variants by trail shape: repo (provider-specific Lucide icon — GitHub, GitLab, fallback for Azure / Bitbucket), document, archive child, bare path. Repo-archive children (chunks from a tarball ingested via the repo-link path) have their `repoUrl` / `commitSha` / `path` reconstructed from the parent tarball filename + `RepositoryLink.lastSha` in `evidenceExplorer.extractTrail`, so they render as repo files rather than opaque archive members. Blob URL builder accepts only 40-char SHA-1; everything else (short SHAs, 64-char ETags) falls back to `HEAD`.

Clicking a chunk preview opens a context-window dialog (`evidence-context-dialog.tsx`) that fetches the chunk plus its ±2 neighbours from the same document via `evidenceExplorer.contextWindow`. Reviewers can read the chunk in surrounding paragraphs before deciding whether it really supports a finding.

Flavour B (AI-emitted per-claim citations like `[E-23]` inline in analysis output) is deferred — see the ADR's "Future path" section.

### Agent trace viewer (ADR-0026)

The on-page `AgentFlowDiagram` is the audit surface for agent runs (ADR-0014). Five layered tiers, all reading the existing `AgentStep` / `AgentToolCall` / `AI_CALL` audit-log rows:

1. **Context band** — goal, status pill, totals, duration, budget bars, halt reason (`agent-flow-header.tsx`).
2. **Richer nodes** — planner reason + decision, tool arg/result summary, evidence badge, error class.
3. **Inspection side panel** — click-to-open right rail with full reasoning, full JSON payloads, evidence-id list, replay block (`agent-step-panel.tsx`).
4. **Long-run UX** — minimap, turn dividers, token-spend sparkline, replay scrubber (`agent-flow-diagram.tsx`).
5. **Tier 5** — branching layout for parallel tool fan-out, run comparison dialog (`agent-run-compare.tsx`), reviewer annotations (`AgentStepAnnotation` table + `addAnnotation`/`resolveAnnotation`), `replayToolCall` mutation (queues a re-dispatch as a SYSTEM step; harness pick-up is a follow-up).

`agentRun.get` includes a `cost` rollup computed from `AI_CALL` audit rows tagged `entityType: "AgentRun"`. Don't go around the AI router (ADR-0015) when adding agent AI calls — cost trail breaks if you do.

### Engagement deletion (ADMIN-only)

`engagement.delete` ADMIN-only mutation; refuses unless `status === "ARCHIVED"`. Postgres FK cascades take out every dependent row (members → assessments → all 22 child tables). The mutation *also* collects every MinIO key the engagement owns (uploaded documents, diagram images, template shells, populated fills) **before** the DB delete and best-effort sweeps them via `Promise.allSettled(deleteObject(key))` *after* the DB commits. Failures are logged in the audit row but never roll back — same pattern as `repositoryLink.delete`.

## Conventions worth knowing

- **Type-check is the canonical gate.** Lint is informational; tests cover services. Always run `pnpm --filter @copilot/web type-check` before declaring work done.
- **Migrations serialise** — only one in-flight branch should add a Prisma migration at a time.
- **Worker concurrency is 5** with `lockDuration: 10min` (analysis is sequential across 8 domains). Don't lower these casually.
- **No `@anthropic-ai/sdk` imports outside the AI router.** Tests mock `callAi`.
- **`buildStorageKey` for documents, `buildTemplateStorageKey` for templates** — never construct MinIO keys ad-hoc.
- **Authz helpers**: `engagementAccessFilter(session)` for engagement-scoped reads; `assertAssessmentAccess` for assessment-level mutations. Workspace-default templates and AI-router admin actions are ADMIN-only.
- **Evidence ids come in two shapes.** The ingest worker writes `ev_<uuid-v4>` (`ingest-document.ts:318`); the agent evidence emitter and other ORM-default paths produce plain `cuid()`. Don't use `z.string().cuid()` to validate evidence ids — it rejects the `ev_` shape silently. Use the shared `evidenceIdSchema` regex in `evidenceExplorer.ts` that accepts either.
- **BullMQ jobIds forbid `:`** — namespace with `-` (e.g. `analysis-${assessmentId}`).
- **Do NOT add `Co-Authored-By: Claude` trailers to commit messages.** No `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`, no Anthropic attribution lines, no "🤖 Generated with…" footers. Plain commit messages only.

## Documentation map

The README is the entry point. The deep references:

- `docs/design/product-design.md` — product domain model, MVP scope, non-goals (1600+ lines).
- `docs/architecture/README.md` — full technical architecture rationale.
- `docs/architecture/decisions/` — numbered ADRs (0001–0028), immutable once accepted. Read these before changing the things they describe (ingest decoupling, RAG, archive gates, PAT encryption, evidence trail, prompt caching, agent harness, multi-provider routing, template binding, background-job lifecycle, soft-failure, workflow planner, credential vault, DB-backed feature flags, per-domain tagging, engagement deletion + MinIO sweep, agent trace viewer, hybrid retrieval, evidence citations).
- `docs/guides/running-locally.md` — environment, ports, services.
- `docs/guides/engagements.md` — consultant-facing engagement handbook: create flow, workspace tabs, members/access, status lifecycle, archive vs delete.
- `docs/guides/knowledge-base.md` — human-readable KB guide: artifact families, per-assessment question selection, what feeds AI vs what fills output containers, edit workflow.
- `docs/guides/templates.md` — customer-uploadable templates user guide.
- `docs/guides/troubleshooting.md` — dev-loop symptom index.
- `docs/operations/troubleshooting.md` — production-shaped failures.
