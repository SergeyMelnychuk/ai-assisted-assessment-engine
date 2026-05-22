# AI-Powered Assessment Co-Pilot

An AI-assisted platform for early-phase software consulting work —
**discovery, architecture assessment, modernization review, audit
preparation, solution shaping, and estimation**. The tool standardises
intake, drafts findings and deliverables with Claude, and keeps an
accountable human expert at every approval gate.

---

## What it does, end to end

A consultant kicks off an engagement and walks the AI through the same
phases they'd walk a client through — except the co-pilot keeps the
trail:

1. **Engagement setup** — create an engagement (client + industry),
   pick an assessment type (architecture / discovery / modernization /
   audit), mode (existing system / greenfield / …), and active domains.
2. **Document intake** — drop in RFPs, architecture docs, Mermaid /
   PlantUML / Structurizr diagrams, PNG/SVG diagrams. Text is extracted
   (pdf-parse / mammoth), diagrams are parsed or run through Claude
   vision, and structured **Evidence** rows fan out per domain.
3. **Adaptive Q&A** — baseline questions are seeded from the knowledge
   base; each answer triggers an AI follow-up pass that proposes sharper
   questions grounded in the existing evidence.
4. **Analysis** — Claude produces *findings*, *risks*,
   *recommendations*, and *assumptions*, plus a 1–5 *domain score* with
   a maturity level and rationale. Knowledge-base risk patterns are
   injected as prompt context.
5. **Team & estimate** — Claude proposes a team from the role catalog
   with hour ranges; the service prices it against the rate card.
6. **Deliverable drafting** — sections + Mermaid diagrams are generated
   from a template (`assessment-report.json`) and land as
   `Deliverable` + `DeliverableSection` + `Diagram` rows.
7. **Review workflow** — reviewers approve / reject / request-revise /
   edit each section. Every action lands in the `Review` audit table
   (content diff for edits, reviewer + timestamp for everything).
8. **Export** — DOCX with cover page, TOC, page numbers, DRAFT
   watermarks on non-approved sections, embedded diagrams. Gated on
   full approval to flip status `APPROVED → EXPORTED`.

### Phase 3 capabilities (post-MVP)

- **Decoupled ingest + analyse** — two BullMQ jobs. `Document.ingestStatus`
  is the single pipeline source-of-truth (ADR-0001).
- **Per-domain analysis fan-out** — one Claude call per active domain,
  partial-success semantics, per-domain audit rows (ADR-0002).
- **RAG retrieval** — `text-embedding-3-small` + pgvector HNSW cosine,
  hybrid fallback when a domain filter underfills, per-retrieval-point
  query construction (ADR-0003 / 0004 / 0005 / 0006 / 0007).
- **Bulk + archive ingest** — zip / tar.gz dropped into the drop-zone
  fans out via `ingest-archive` with size / depth / zip-slip gates
  (ADR-0008).
- **Repository linking** — GitHub tarball API + per-engagement PAT,
  encrypted AES-256-GCM at rest (ADR-0009 / 0010).
- **Evidence Explorer + "Why this finding?"** — Findings / Risks /
  Recommendations carry `retrievedEvidenceIds` that survive through
  review and export; a dedicated explorer UI traces any claim back
  to the source chunks (ADR-0011).
- **Anthropic prompt caching + cost instrumentation** — cached
  system-prompt tiers, `AI_CALL` audit rows with per-call cost math,
  `/admin/cost` rollup page (ADR-0012).

Full functional detail is in
**[`docs/design/product-design.md`](./docs/design/product-design.md)**
(1600+ lines — domain model, knowledge-base shape, sequencing, MVP
scope, non-goals). This README stays pitch-short on purpose.

---

## Quick start

### Prerequisites

- Node.js ≥ 20 (see `.nvmrc` / `engines` in `package.json`)
- pnpm 9.x (`brew install pnpm@9` or `npm i -g pnpm@9`)
- Docker (for Postgres, Redis, MinIO, PlantUML)

### First run

```bash
pnpm install                   # install workspaces
docker-compose up -d           # start Postgres, Redis, MinIO, PlantUML
cp .env.example apps/web/.env  # fill in ANTHROPIC_API_KEY
pnpm db:generate               # Prisma client
pnpm db:migrate                # apply schema
pnpm db:seed                   # assessment types, KB, rate card, admin user
pnpm dev                       # Next.js on :3000
# in a second terminal:
pnpm worker                    # BullMQ consumer (document + AI jobs)
```

Open http://localhost:3000 and log in as `admin@copilot.dev` /
`admin123` (dev-only default — override with `ADMIN_SEED_PASSWORD`
before seeding).

More detail — including the Docker ports used, PlantUML server URL,
MinIO auto-bucket behaviour, and the `.claude/launch.json` preview
config — lives in
**[`docs/guides/running-locally.md`](./docs/guides/running-locally.md)**.

If something breaks, start at
**[`docs/operations/troubleshooting.md`](./docs/operations/troubleshooting.md)**
for production-shaped failures (stuck archive extraction, PAT
decryption, pgvector extension missing). For dev-loop issues
(InvariantError, stuck PENDING uploads, Anthropic 529s, BullMQ `:` id
bug, stale `.next` after Prisma regen) see
**[`docs/guides/troubleshooting.md`](./docs/guides/troubleshooting.md)**.

### Environment variables

Copy `.env.example` to `apps/web/.env` and fill in:

- `ANTHROPIC_API_KEY` — required for any AI path.
- `ANTHROPIC_MODEL` — optional; defaults to `claude-sonnet-4-5`.
- `OPENAI_API_KEY` — embeddings. Leave blank with `EMBEDDING_MODE=fake`
  for local / CI.
- `EMBEDDING_MODE` — `live` | `fake` (inferred from key presence if
  unset).
- `EMBEDDING_MODEL` — defaults to `text-embedding-3-small`.
- `REPO_CREDENTIAL_KEY` — 32-byte base64 for PAT-at-rest encryption
  (`openssl rand -base64 32`).
- `REPO_CREDENTIAL_MODE` — set to `fake` for dev without a key.
- `DEBUG_WORKERS` — `1` pretty-prints worker logs; unset/0 emits
  JSON (prod shape).

Full list with defaults lives in
**[`.env.example`](./.env.example)**.

#### Feature flags

Platform-wide toggles. **DB-backed, not env-backed** — stored on the
`Setting` table, toggled from `/admin/settings?tab=ai-router`, applied
on the next tRPC call with no redeploy. Helpers under
`apps/web/src/server/services/**` read them via the settings-service
cache (~10 s per process).

| Flag | Default | Controls |
|---|---|---|
| `features.agentEnabled` | off | Phase 4 agent harness surface — tRPC routes and nav entries for the agentic evidence-collection harness (ADR-0014, ADR-0017). Off: routes return `NOT_FOUND`, nav entries hidden. Affects visibility only; no persistence or queue behaviour changes. Helper: `isAgentEnabled(db)` in `apps/web/src/server/services/agent/feature-flag.ts`. |
| `features.autoClassifyChunks` | off | Per-chunk domain auto-classifier (ADR-0024). When on, the ingest worker runs the `ingest.domain_classifier` task post-ingest and writes each chunk's `Evidence.domain`. Off: chunks stay in the `"ingested"` catch-all bucket the analysis engine already reads. Best-effort; failures leave chunks in the catch-all. Toggled at `/admin/settings?tab=ai-router`. |
| `features.agentFlowVisible` | on | Sub-flag of `features.agentEnabled`. When off, the `AgentFlowDiagram` trace viewer hides on the assessment runs panel — the agent harness keeps running, only the trajectory UI is suppressed. Defaults ON so existing deploys aren't surprised by the toggle landing. Admin-toggled at `/admin/settings?tab=ai-router`. Decision: ADR-0026. |
| `features.hybridRetrieval` | off | When on, the RAG retriever fuses pgvector cosine with Postgres-native lexical search (`tsvector` + `ts_rank`) via Reciprocal Rank Fusion (`k = 60`), in a single CTE query. Closes the gap on exact-string queries (version numbers, error codes, file paths). When off, retrieval stays pure semantic. Decision: ADR-0027. |

### Smoke tests

Black-box end-to-end scripts that drive the real local stack. Run
`docker-compose up -d`, `pnpm dev`, `pnpm worker`, then invoke the
relevant script from `scripts/smoke/`:

- `smoke-embeddings.sh` — ingest → embed → pgvector cosine query
  (W3, ADR-0003/0004/0005).
- `smoke-rag-analysis.sh` — multi-document analysis picks evidence
  across source docs (W4).
- `smoke-per-domain-analysis.sh` — analysis fans out one Claude
  call per active domain (W2).
- `smoke-ingest-decoupled.sh` — ingest writes `INGEST_DOCUMENT`, no
  `PROCESS_DOCUMENT`, no Claude call (W1).
- `smoke-ingest-shape.sh` — post-chunking Evidence rows > 1 per doc,
  `content_sha` populated, zero `analysis` audit rows (W1).
- `smoke-archive-upload.sh` — zip becomes parent Document + child
  rows via `ingest-archive` (W5).
- `smoke-repo-link.sh` — RepositoryLink → tarball fetch →
  child Documents (W6).
- `smoke-evidence-trail.sh` — Findings carry non-empty
  `retrievedEvidenceIds`; `evidenceExplorer.findingTrail` resolves
  (W7).
- `smoke-cost.sh` — `run-analysis` emits `AI_CALL` audit rows with
  positive, bounded `estimatedCostUsd` (W8).

---

## Documentation map

### Product & scope
- **[`docs/design/product-design.md`](./docs/design/product-design.md)**
  — full product design: target users, use cases, domain model, knowledge
  base, scoring models, MVP scope, non-goals, glossary.
- **[`docs/design/implementation-tasks.md`](./docs/design/implementation-tasks.md)**
  — the 13-task execution plan that built the MVP (tasks 1–13 are all
  green).
- **[`docs/design/phase-3-roadmap.md`](./docs/design/phase-3-roadmap.md)**
  — 8-week post-MVP roadmap: decouple ingest from analyse, RAG over
  evidence, bulk/archive upload, repo linking. Moves the product from
  MVP to real-world-viable (50-repo / 500-doc engagements). Includes
  parallel **cross-cutting tracks** for documentation, tests, and
  diagrams so they ship alongside code rather than as an
  end-of-phase backfill. Checkboxed tasks; tick them as work lands.
- **[`docs/design/phase-3-retrospective.md`](./docs/design/phase-3-retrospective.md)**
  — candid retrospective written at the close of Week 8: what
  shipped, what slipped, what surprised us.
- **[`docs/design/backlog.md`](./docs/design/backlog.md)** — open
  backlog items tracked during MVP build (MVP+1 / MVP+2 scope).

### Architecture & operation
- **[`docs/architecture/README.md`](./docs/architecture/README.md)** —
  full technical architecture: stack rationale, runtime topology, AI
  pipeline, data model, auth, audit-trail discipline, review-lock
  semantics.
- **[`docs/architecture/decisions/`](./docs/architecture/decisions/)** —
  Architecture Decision Records (ADRs): the *why* behind the
  non-obvious calls. One file per decision, numbered, immutable once
  accepted. Phase 3 ADRs:
  - [0001 — decouple ingest from analyse](./docs/architecture/decisions/0001-decouple-ingest-from-analyse.md)
  - [0002 — per-domain analysis fan-out](./docs/architecture/decisions/0002-per-domain-analysis-fan-out.md)
  - [0003 — embedding model choice](./docs/architecture/decisions/0003-embedding-model-choice.md)
  - [0004 — chunking strategy](./docs/architecture/decisions/0004-chunking-strategy.md)
  - [0005 — pgvector HNSW over IVFFlat](./docs/architecture/decisions/0005-pgvector-hnsw-over-ivfflat.md)
  - [0006 — hybrid retrieval fallback](./docs/architecture/decisions/0006-hybrid-retrieval-fallback.md)
  - [0007 — query construction per retrieval point](./docs/architecture/decisions/0007-query-construction-per-retrieval-point.md)
  - [0008 — archive safety gates](./docs/architecture/decisions/0008-archive-safety-gates.md)
  - [0009 — PAT-per-engagement credentials](./docs/architecture/decisions/0009-pat-per-engagement-credentials.md)
  - [0010 — tarball API over git clone](./docs/architecture/decisions/0010-tarball-api-over-git-clone.md)
  - [0011 — evidence traceability first-class](./docs/architecture/decisions/0011-evidence-traceability-first-class.md)
  - [0012 — prompt caching + cost instrumentation](./docs/architecture/decisions/0012-prompt-caching-and-cost-instrumentation.md)
- **[`docs/architecture/diagrams/README.md`](./docs/architecture/diagrams/README.md)**
  — how to render the Structurizr DSL + Mermaid diagrams.
- **[`docs/guides/running-locally.md`](./docs/guides/running-locally.md)**
  — run-book: environment, ports, services, common flows.
- **[`docs/guides/troubleshooting.md`](./docs/guides/troubleshooting.md)**
  — dev-loop symptom index (Next.js, pnpm, MinIO, PlantUML).
- **[`docs/operations/troubleshooting.md`](./docs/operations/troubleshooting.md)**
  — production-shaped failures (archive extraction stuck, PAT
  decryption, pgvector extension missing).

### Diagrams (canonical source)
- **[`docs/architecture/diagrams/workspace.dsl`](./docs/architecture/diagrams/workspace.dsl)**
  — Structurizr DSL, all views in one workspace (system context,
  container, deployment).
- **[`docs/architecture/diagrams/system-context.mmd`](./docs/architecture/diagrams/system-context.mmd)**
  — Mermaid C4 system context.
- **[`docs/architecture/diagrams/container-topology.mmd`](./docs/architecture/diagrams/container-topology.mmd)**
  — Mermaid C4 container view.
- **[`docs/architecture/diagrams/data-flow.mmd`](./docs/architecture/diagrams/data-flow.mmd)**
  — how evidence flows through document processing, analysis, and
  deliverable generation.
- **[`docs/architecture/diagrams/sequence-analysis.mmd`](./docs/architecture/diagrams/sequence-analysis.mmd)**
  — sequence for the `run-analysis` BullMQ job.
- **[`docs/architecture/diagrams/deployment.mmd`](./docs/architecture/diagrams/deployment.mmd)**
  — docker-compose runtime topology.

---

## Repository layout

```
.
├── apps/
│   └── web/                         # Next.js 15 app — UI + tRPC + API routes + BullMQ worker entry
│       ├── prisma/                  # schema.prisma, migrations, seed.ts
│       └── src/
│           ├── app/                 # App-router pages + API routes
│           │   ├── (app)/           # Authed area
│           │   └── api/             # REST routes (auth, document upload/download, deliverable export)
│           ├── components/          # React components
│           ├── server/              # Server-only code
│           │   ├── queue/           # BullMQ queue + worker + jobs
│           │   ├── services/        # Domain services (analysis, scoring, estimation, export, review)
│           │   ├── storage/         # MinIO S3 client
│           │   └── trpc/            # tRPC routers
│           └── lib/                 # Shared utilities
├── packages/
│   └── knowledge-seed/              # JSON data loaded by prisma/seed.ts
│       ├── frameworks/              # Scoring rubrics
│       ├── question-templates/      # Per-domain intake questions
│       ├── risk-patterns/           # Reusable risk signatures
│       ├── role-catalog/            # Canonical roles for estimation
│       ├── rate-cards/              # Live rate card
│       ├── estimation-templates/    # WBS workbook + binding (workspace default)
│       └── deliverable-shells/      # One file + binding per deliverable type
├── docker-compose.yml               # Postgres + Redis + MinIO + PlantUML
├── turbo.json                       # Turborepo pipeline
└── docs/                            # You're here
```

---

## Tech stack at a glance

| Area | Choice | Why |
|---|---|---|
| Runtime | Node.js 20, TypeScript 5.7 | Shared language with the AI SDK; strict types across the boundary |
| Monorepo | pnpm workspaces + Turborepo | Fast installs + cached task running; standard in the ecosystem |
| Web | Next.js 15 App Router | SSR + Server Components + API routes in one repo |
| API | tRPC v11 + React Query | End-to-end typed client/server without schema drift |
| Auth | NextAuth 4 (Credentials + JWT) | Credentials provider is fine for MVP; swap for OIDC post-MVP |
| DB | Postgres 16 + pgvector + Prisma 6 | Wired for Evidence retrieval — ADR-0005 (HNSW cosine); Prisma keeps migrations honest |
| Queue | BullMQ + ioredis (Redis 7) | `ingest-document`, `ingest-archive`, `ingest-repository`, plus run-analysis / estimation / deliverable / agent-harness jobs |
| Storage | MinIO (S3 API) | Same client code in dev and prod; object lifecycle unchanged |
| AI | `@anthropic-ai/sdk` → `claude-sonnet-4-5` | Strong at structured JSON output; vision for raster diagrams; prompt caching (ADR-0012) |
| Embeddings | `openai` → `text-embedding-3-small` | 1536-dim, cheap, strong-enough for evidence retrieval (ADR-0003) |
| Archive ingest | `tar-stream`, `yauzl` | Streaming extraction under safety gates (ADR-0008) |
| DOCX export | `docx` | Low-level but lets us control headings/tables/embedded images |
| PDF export | `puppeteer` + `marked` | Server-side HTML render (markdown → HTML, mermaid → SVG) printed to PDF |
| Diagrams | Mermaid (client + server-side render), PlantUML (server), Structurizr DSL | All text-based, AI-friendly, reviewable via `git diff` |

Each choice's rationale lives in detail in
**[`docs/architecture/README.md`](./docs/architecture/README.md)**.

---

## Current status

All **13 MVP tasks are complete and smoke-tested**:

| # | Task | Status |
|---|---|---|
| 1 | Dev environment bootstrap | ✅ |
| 2 | Authentication | ✅ |
| 3 | App shell & layout | ✅ |
| 4 | tRPC client wiring | ✅ |
| 5 | Engagement CRUD | ✅ |
| 6 | Assessment setup + project context | ✅ |
| 7 | Document upload + processing (BullMQ worker) | ✅ |
| 8 | Question engine (templates + AI follow-ups) | ✅ |
| 9 | Analysis engine (findings / risks / recommendations / scoring) | ✅ |
| 10 | Team composition + priced estimation | ✅ |
| 11 | Deliverable generation (sections + diagrams) | ✅ |
| 12 | Expert review workflow (audit trail + export gate) | ✅ |
| 13 | DOCX export (embedded diagrams + watermark) | ✅ |

### Phase 3 — shipped

Eight weeks past MVP. Full narrative in the
[retrospective](./docs/design/phase-3-retrospective.md); checkboxes
in the [roadmap](./docs/design/phase-3-roadmap.md).

| Week | Outcome | Reference |
|---|---|---|
| W1 | Ingest decoupled from analyse; `Document.ingestStatus` as pipeline truth | ADR-0001 |
| W2 | Per-domain analysis fan-out with partial-success semantics | ADR-0002 |
| W3 | Embedding foundation — `text-embedding-3-small`, ~800-token recursive chunks, pgvector HNSW cosine, fake-mode for CI | ADR-0003 / 0004 / 0005 |
| W4 | RAG wired into every AI call-site; hybrid fallback; per-point query construction | ADR-0006 / 0007 |
| W5 | Bulk + archive ingest with stream extraction + safety gates | ADR-0008 |
| W6 | Repository linking via GitHub tarball API; per-engagement PAT encrypted at rest | ADR-0009 / 0010 |
| W7 | Evidence traceability end-to-end; Explorer UI + "Why this finding?" trail | ADR-0011 |
| W8 | Anthropic prompt caching; cost instrumentation; `/admin/cost` rollup; worker concurrency 2 → 5 | ADR-0012 |

Known caveats, kept visible:

- **Anthropic API credits** — every AI path is infrastructurally verified
  (queue, auth, terminal state, graceful failure). Actual AI content
  requires a funded key.
- **Server-side Mermaid rendering is deferred.** Generated diagrams ship
  in DOCX as monospace source blocks plus a `mermaid.live` pointer;
  uploaded raster images embed directly. Real server-side rendering
  needs Chromium-in-puppeteer which isn't in the dev container.
- **Knowledge-base and rate-card editors are deferred beyond MVP.** Data
  lives as JSON in `packages/knowledge-seed/` and is applied by
  `pnpm db:seed`. The `/admin/*` pages render live read-only views.

---

## License

**Proprietary — All Rights Reserved.** See [`LICENSE`](./LICENSE).

No use, copying, modification, distribution, or deployment is permitted
without a signed agreement with the copyright holder. Repository access
grants review-only rights; everything else — including internal business
use, production deployment, and training AI/ML systems on this code — is
expressly reserved. Contact the project lead for a license.
