# AI-Powered Assessment Co-Pilot

An AI-assisted platform for early-phase software consulting work —
**discovery, architecture assessment, modernization review, audit
preparation, solution shaping, and estimation**. The tool standardises
intake, drafts findings and deliverables with Claude, and keeps an
accountable human expert at every approval gate.

The product is **post-MVP**: every consulting flow described below is
implemented and used end-to-end. Continuing work refines templates,
prompts, and the agent harness — not the core pipeline.

---

## What it does, end to end

A consultant kicks off an engagement and walks the AI through the same
sequence they'd walk a client through — except the co-pilot keeps the
trail:

1. **Engagement setup** — create an engagement (client + industry),
   pick an assessment type (architecture / discovery / modernization /
   audit), mode (existing system / greenfield / …), and active domains.
2. **Document intake** — drop in RFPs, architecture docs, Mermaid /
   PlantUML / Structurizr diagrams, PNG/SVG diagrams. Text is extracted
   (pdf-parse / mammoth), diagrams are parsed or run through Claude
   vision, and structured **Evidence** rows fan out per domain.
   Repositories link via GitHub / GitLab tarball API + an encrypted
   per-engagement personal-access token.
3. **Adaptive Q&A** — baseline questions are seeded from the knowledge
   base per active domain; each answer triggers an AI follow-up pass
   that proposes sharper questions grounded in the existing evidence.
4. **Analysis** — Claude produces *findings*, *risks*,
   *recommendations*, and *assumptions*, plus a 1–5 *domain score*
   anchored to the framework's maturity rubric. Knowledge-base risk
   patterns are injected as prompt context. Every claim retains a
   trail back to the source evidence chunks.
5. **Team & estimate** — Claude proposes a team from the role catalog
   with hour ranges; the service prices it against the rate card.
6. **Deliverable drafting** — sections + Mermaid diagrams are generated
   from a per-deliverable-type spec, land as `Deliverable` +
   `DeliverableSection` + `Diagram` rows, and fill the customer's
   uploaded `.docx` / `.pptx` / `.xlsx` template (or the workspace
   default) with both engine data and AI-written narrative.
7. **Review workflow** — reviewers approve / reject / request-revise /
   edit each section. Every action lands in the `Review` audit table
   (content diff for edits, reviewer + timestamp for everything).
8. **Export** — populated `.docx` / `.pptx` / `.xlsx` plus a fallback
   DOCX export with cover page, TOC, page numbers, DRAFT watermarks on
   non-approved sections, embedded diagrams. Gated on full approval to
   flip status `APPROVED → EXPORTED`.

Full functional detail is in
**[`docs/design/product-design.md`](./docs/design/product-design.md)** —
domain model, knowledge-base shape, scoring rubrics, glossary. The
**[`docs/architecture/README.md`](./docs/architecture/README.md)**
covers the technical side.

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
pnpm db:seed                   # assessment types, KB, rate card, admin user, workspace templates
pnpm dev                       # Next.js on :3000
# in a second terminal:
pnpm worker                    # BullMQ consumer (document + AI jobs)
```

Open http://localhost:3000 and log in as `admin@copilot.dev` /
`admin123` (dev-only default — override with `ADMIN_SEED_PASSWORD`
before seeding).

More detail — Docker ports, PlantUML server URL, MinIO auto-bucket
behaviour, the `.claude/launch.json` preview config — lives in
**[`docs/guides/running-locally.md`](./docs/guides/running-locally.md)**.

If something breaks:

- **Dev-loop issues** (InvariantError, stuck PENDING uploads, Anthropic
  529s, BullMQ `:` id bug, stale `.next` after Prisma regen) —
  **[`docs/guides/troubleshooting.md`](./docs/guides/troubleshooting.md)**.
- **Production-shaped failures** (stuck archive extraction, PAT
  decryption, pgvector extension missing) —
  **[`docs/operations/troubleshooting.md`](./docs/operations/troubleshooting.md)**.

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

### Feature flags

Platform-wide toggles. **DB-backed, not env-backed** — stored on the
`Setting` table, toggled from `/admin/settings?tab=ai-router`, applied
on the next tRPC call with no redeploy. Helpers under
`apps/web/src/server/services/**` read them via the settings-service
cache (~10 s per process).

| Flag | Default | Controls |
|---|---|---|
| `features.agentEnabled` | off | Agent-harness surface — tRPC routes and nav entries for the agentic evidence-collection harness (ADR-0014, ADR-0017). Off: routes return `NOT_FOUND`, nav entries hidden. Affects visibility only; no persistence or queue behaviour changes. |
| `features.autoClassifyChunks` | off | Per-chunk domain auto-classifier (ADR-0024). When on, the ingest worker runs the `ingest.domain_classifier` task post-ingest and writes each chunk's `Evidence.domain`. Off: chunks stay in the `"ingested"` catch-all the analysis engine already reads. Best-effort; failures leave chunks in the catch-all. |
| `features.agentFlowVisible` | on | Sub-flag of `features.agentEnabled`. When off, the `AgentFlowDiagram` trace viewer hides on the assessment runs panel — the agent harness keeps running, only the trajectory UI is suppressed. Defaults ON so existing deploys aren't surprised. Decision: ADR-0026. |
| `features.hybridRetrieval` | off | When on, the RAG retriever fuses pgvector cosine with Postgres-native lexical search (`tsvector` + `ts_rank`) via Reciprocal Rank Fusion (`k = 60`), in a single CTE query. Closes the gap on exact-string queries (version numbers, error codes, file paths). When off, retrieval stays pure semantic. Decision: ADR-0027. |

### Smoke tests

Black-box end-to-end scripts that drive the real local stack. Run
`docker-compose up -d`, `pnpm dev`, `pnpm worker`, then invoke the
relevant script from `scripts/smoke/`:

- `smoke-embeddings.sh` — ingest → embed → pgvector cosine query.
- `smoke-rag-analysis.sh` — multi-document analysis picks evidence
  across source docs.
- `smoke-per-domain-analysis.sh` — analysis fans out one Claude call
  per active domain.
- `smoke-ingest-decoupled.sh` / `smoke-ingest-shape.sh` — ingest
  pipeline shape: no Claude on ingest, chunked Evidence rows with
  `content_sha` populated.
- `smoke-archive-upload.sh` — zip becomes parent Document + child
  rows via `ingest-archive`.
- `smoke-repo-link.sh` — RepositoryLink → tarball fetch → child
  Documents.
- `smoke-evidence-trail.sh` — Findings carry non-empty
  `retrievedEvidenceIds`; the Evidence Explorer trail resolves.
- `smoke-cost.sh` — `run-analysis` emits `AI_CALL` audit rows with
  positive, bounded `estimatedCostUsd`.

Run them after changes that touch ingest, analysis, RAG, archives,
repo links, evidence trail, or cost instrumentation.

---

## Documentation map

### Product & scope
- **[`docs/design/product-design.md`](./docs/design/product-design.md)**
  — full product design: target users, use cases, domain model,
  knowledge base, scoring models, glossary.
- **[`docs/design/backlog.md`](./docs/design/backlog.md)** — open
  backlog items.

### Consultant & operator guides
- **[`docs/guides/engagements.md`](./docs/guides/engagements.md)** —
  end-to-end engagement handbook: create flow, workspace tabs,
  members/access, status lifecycle, archive vs delete.
- **[`docs/guides/knowledge-base.md`](./docs/guides/knowledge-base.md)**
  — KB artifact families, how questions get assigned per assessment,
  what feeds AI vs what fills output containers, edit workflow.
- **[`docs/guides/templates.md`](./docs/guides/templates.md)** —
  customer-uploaded `.docx` / `.pptx` / `.xlsx` templates: upload
  flow, binding lifecycle (PROPOSED → APPROVED → DEPRECATED), the
  AI-section field family that lets AI prose flow into output files.
- **[`docs/guides/admin-ai-router.md`](./docs/guides/admin-ai-router.md)**
  — operator handbook for the AI router: tasks, providers, model
  pins, fallback chains, safety rails.
- **[`docs/guides/running-locally.md`](./docs/guides/running-locally.md)**
  — environment, ports, services, common dev flows.
- **[`docs/guides/troubleshooting.md`](./docs/guides/troubleshooting.md)**
  — dev-loop symptom index (Next.js, pnpm, MinIO, PlantUML).
- **[`docs/operations/troubleshooting.md`](./docs/operations/troubleshooting.md)**
  — production-shaped failures.

### Architecture & decisions
- **[`docs/architecture/README.md`](./docs/architecture/README.md)** —
  full technical architecture: stack rationale, runtime topology, AI
  pipeline, data model, auth, audit-trail discipline, review-lock
  semantics.
- **[`docs/architecture/decisions/`](./docs/architecture/decisions/)** —
  Architecture Decision Records. One file per non-obvious decision,
  numbered, immutable once accepted. Index at
  **[`docs/architecture/decisions/README.md`](./docs/architecture/decisions/README.md)**.
  The full set covers ingest decoupling, per-domain analysis fan-out,
  RAG (embedding model, chunking, pgvector HNSW, hybrid fallback,
  query construction), archive safety gates, PAT encryption, evidence
  traceability, prompt caching + cost instrumentation, multi-provider
  LLM routing, agent harness, template binding, soft-failure, workflow
  planner, credential vault, DB-backed feature flags, per-domain
  evidence tagging, engagement deletion + storage sweep, agent trace
  viewer, hybrid retrieval RRF, evidence citations, deliverable-section
  field family, and section character budgets.
- **[`docs/architecture/diagrams/README.md`](./docs/architecture/diagrams/README.md)**
  — how to render the Structurizr DSL + Mermaid diagrams.

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
│           │   └── api/             # REST routes (auth, document upload/download, template download, deliverable export)
│           ├── components/          # React components
│           ├── server/              # Server-only code
│           │   ├── queue/           # BullMQ queue + worker + jobs
│           │   ├── services/        # Domain services (analysis, scoring, estimation, export, review, template)
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
│       ├── deliverable-templates/   # Per-deliverable-type AI section specs
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
| Auth | NextAuth 4 (Credentials + JWT) | Credentials provider for dev; OIDC plug-in path documented |
| DB | Postgres 16 + pgvector + Prisma 6 | Wired for Evidence retrieval — HNSW cosine (ADR-0005); Prisma keeps migrations honest |
| Queue | BullMQ + ioredis (Redis 7) | `ingest-document`, `ingest-archive`, `ingest-repository`, plus run-analysis / estimation / deliverable / agent-harness / propose-template-binding jobs |
| Storage | MinIO (S3 API) | Same client code in dev and prod; object lifecycle unchanged |
| AI | `@anthropic-ai/sdk` → `claude-sonnet-4-5` (primary); multi-provider routing | Strong at structured JSON output; vision for raster diagrams; prompt caching (ADR-0012); fallback to OpenAI / Bedrock per-task (ADR-0015) |
| Embeddings | `openai` → `text-embedding-3-small` | 1536-dim, cheap, strong-enough for evidence retrieval (ADR-0003) |
| Archive ingest | `tar-stream`, `yauzl` | Streaming extraction under safety gates (ADR-0008) |
| Template fill | `exceljs`, `yauzl`/`yazl` (OOXML zip rewrite), `python-pptx` / `python-docx` for authoring | xlsx via exceljs; docx + pptx via direct XML rewrite + a `docx.tableRow` primitive for per-row tables |
| DOCX export | `docx` | Low-level but lets us control headings/tables/embedded images |
| PDF export | `puppeteer` + `marked` | Server-side HTML render (markdown → HTML, mermaid → SVG) printed to PDF |
| Diagrams | Mermaid (client + server-side render), PlantUML (server), Structurizr DSL | All text-based, AI-friendly, reviewable via `git diff` |

Each choice's rationale lives in
**[`docs/architecture/README.md`](./docs/architecture/README.md)** with
deep-dives in the matching ADR.

---

## Known caveats

- **Anthropic API credits.** Every AI path is infrastructurally
  verified (queue, auth, terminal state, graceful failure). Actual AI
  content requires a funded key.
- **Server-side Mermaid rendering** in the fallback DOCX export is
  deferred — generated diagrams ship as monospace source blocks plus
  a `mermaid.live` pointer; uploaded raster images embed directly.
  Customer-uploaded `.pptx` deliverables render Mermaid client-side as
  expected. Server-side rasterisation needs Chromium-in-puppeteer
  which isn't in the dev container.
- **Knowledge-base editing** is mostly seed-driven. Data lives as JSON
  in `packages/knowledge-seed/` and is applied by `pnpm db:seed`. The
  `/admin/knowledge-base` page has create / edit / activate controls;
  the seed remains the source of truth (re-seeding overwrites runtime
  edits to the same `(artifactType, name)` keys).
- **Per-role hours / cost** are not computed today. The estimation
  engine produces rolled-up totals and role mix; per-role hour
  distribution is a backlog item. Templates that ask for per-role
  hours will fill those columns with zero — keep them out of customer
  deliverables for now.

---

## License

**Proprietary — All Rights Reserved.** See [`LICENSE`](./LICENSE).

No use, copying, modification, distribution, or deployment is permitted
without a signed agreement with the copyright holder. Repository access
grants review-only rights; everything else — including internal business
use, production deployment, and training AI/ML systems on this code — is
expressly reserved. Contact the project lead for a license.
