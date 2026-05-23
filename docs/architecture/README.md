# Architecture

This document is the single source of truth for *how* the Assessment
Co-Pilot is built. It complements the product-focused
[`../design/product-design.md`](../design/product-design.md) —
there we describe **what** we're building and why; here we describe
**how** it actually runs.

Contents:

1. [Stack & rationale](#1-stack--rationale)
2. [Runtime topology](#2-runtime-topology)
3. [Repository shape](#3-repository-shape)
4. [Request lifecycle](#4-request-lifecycle)
5. [Background job pipeline](#5-background-job-pipeline)
6. [AI integration](#6-ai-integration)
7. [Data model highlights](#7-data-model-highlights)
8. [Authentication & authorization](#8-authentication--authorization)
9. [Knowledge base pattern](#9-knowledge-base-pattern)
10. [Review discipline](#10-review-discipline)
11. [DOCX export](#11-docx-export)
12. [Observability & audit trail](#12-observability--audit-trail)
13. [How it runs (dev + prod-shaped)](#13-how-it-runs-dev--prod-shaped)
14. [Security posture](#14-security-posture)
15. [Known limits & debts](#15-known-limits--debts)

Accompanying diagrams live in
[`./diagrams/`](./diagrams/). The Structurizr workspace
([`./diagrams/workspace.dsl`](./diagrams/workspace.dsl)) is the
canonical C4 model; the Mermaid files are derived views that can be
rendered inline in GitHub / GitLab / mermaid.live. See the
[diagrams README](./diagrams/README.md) for rendering.

---

## 1. Stack & rationale

| Area | Choice | Why we picked it | Alternatives considered |
|---|---|---|---|
| Runtime | Node.js 20 + TypeScript 5.7 | Shared language with the Anthropic SDK; strict types survive the Next/tRPC/Prisma boundary | Deno (less ecosystem for BullMQ, Prisma); Python (would split languages) |
| Monorepo tooling | pnpm workspaces + Turborepo | Deterministic installs, cached task running, one-shot typechecks across packages | Nx (heavier for a 2-package repo); single-package (would block future worker / cli splits) |
| Web framework | Next.js 15 App Router | Server Components for authed SSR pages, API routes for binary responses (upload / download / DOCX), tight integration with React Query | Remix (similar shape, smaller AI ecosystem); Express + SPA (more plumbing for zero gain) |
| API | tRPC v11 + superjson + React Query | End-to-end types from server to `trpc.useQuery()` without a schema file to drift | GraphQL (heavier, more layers to the AI data); REST + Zod (would re-invent typesafety) |
| Auth | NextAuth 4, Credentials + JWT | No OAuth dance required for consulting staff; easy to swap for OIDC post-MVP | Clerk / Auth0 (vendor lock + $ for MVP); Lucia (less batteries-included) |
| DB | Postgres 16 + pgvector extension, Prisma 6 | Vector column available when we add KB RAG; Prisma keeps migrations honest | MongoDB (poor fit for relational engagement/assessment model); bare pg + sqlc (fine but loses editor autocompletion) |
| Queue | BullMQ 5 + ioredis, Redis 7 | Mature Node queue with retries, delayed jobs, dedup via `jobId`, observable via Redis primitives | Cloud Tasks / SQS (cloud-locked, dev loop worse); inline processing (AI calls are ~10s; would block requests) |
| Object storage | MinIO (S3 API) | S3-compatible, runs in docker-compose, identical client code in prod | Local filesystem (breaks in a real deploy); Cloudflare R2 (OK for prod but local dev loop matters) |
| AI provider (analysis) | Anthropic Claude Sonnet 4 | Strong JSON-structured output, vision for raster diagrams, 200k context | OpenAI (parallel line; could swap via the client wrapper if needed); Gemini (vision parity but less stable JSON) |
| AI provider (embeddings) | OpenAI `text-embedding-3-small` (1536-dim) | Cheap ($0.02/M tokens), good quality on prose, fits pgvector HNSW comfortably. Swappable via `EMBEDDING_MODEL` env var (ADR-0003) | Voyage, Cohere (another vendor account); in-house bge-small (false economy at our scale); `text-embedding-3-large` (3× cost for marginal lift) |
| DOCX | `docx` (npm) | Low-level enough to embed images, tables, headers/footers, TOC; no MS Office required | Pandoc (needs a binary); docxtemplater (template-driven, poor fit for AI-generated sections) |
| Diagrams (source) | Mermaid (primary), PlantUML (server), Structurizr DSL | All text-based → reviewable in `git diff`; Claude already speaks them | Lucidchart / drawio (GUI-only, not AI-friendly) |
| Diagram rendering | PlantUML server (docker); Mermaid client-side (deferred); mermaid-cli (deferred, needs Chromium) | Text-based source is the source of truth; rendering is a view | — |
| Password hashing | bcryptjs (12 rounds) | Pure-JS, no native build; fine for 2026-class password hashing | argon2 (native build fragility across macOS/Linux dev loops) |
| UI primitives | Hand-rolled shadcn-style (CVA + clsx + tailwind-merge) | No runtime dep; control over accessibility + tokens | shadcn/ui CLI (fine, but we wanted no copy-paste drift with a CLI); Radix alone (more verbose) |
| Logging | `console.*` with structured prefixes | MVP-appropriate; easy to stream to any aggregator later | Pino / Winston (optional, not critical until prod) |

---

## 2. Runtime topology

Two long-running processes drive the app:

1. **`web`** — Next.js dev/prod server. Handles SSR, tRPC calls,
   authentication, file uploads/downloads, and the DOCX export route.
2. **`worker`** — Node process (`tsx src/server/queue/worker.ts`) that
   consumes the BullMQ `document-processing` queue. Every AI-heavy job
   runs here, off the request hot path.

Stateful dependencies (local dev, via `docker-compose`):

- **Postgres 16 + pgvector** (`:5432`) — primary durable state, `prisma`
  migrations.
- **Redis 7** (`:6379`) — BullMQ transport.
- **MinIO** (`:9000`, console `:9001`) — S3-compatible object storage.
- **PlantUML server** (`:8081`) — optional, used by the diagram parser
  for PlantUML rendering. Not required for the happy path (we store
  source code).

External dependencies:

- **Anthropic API** (`https://api.anthropic.com`) — primary LLM
  provider. All calls routed through `services/ai/router.ts`
  (ADR-0015); no direct `@anthropic-ai/sdk` imports outside the
  router. Multi-provider failover supported (Bedrock, OpenAI,
  Mistral) per task.
- **OpenAI API** (`https://api.openai.com`) — embeddings only
  (`text-embedding-3-small`, 1536-dim — ADR-0003). The router's
  `embedding.ingest` task uses Bedrock Titan v2 as fallback;
  `embedding.query` has no fallback (mid-flight provider hop
  would change embedding space).
- **GitHub API** (`https://api.github.com`) — repo tarball
  downloads for repo-link evidence (ADR-0010). PAT-authenticated;
  PATs stored AES-256-GCM-encrypted in the engagement-scoped
  `AgentCredential` vault (ADR-0022).

See the C4 views in
[`diagrams/system-context.mmd`](./diagrams/system-context.mmd) and
[`diagrams/container-topology.mmd`](./diagrams/container-topology.mmd).

---

## 3. Repository shape

```
.
├── apps/web/                     # Next.js app + API + worker entry
│   ├── prisma/
│   │   ├── schema.prisma         # single source of truth for DB schema
│   │   ├── migrations/           # Prisma migrations
│   │   └── seed.ts               # idempotent dev-data loader
│   └── src/
│       ├── app/
│       │   ├── (app)/            # Authed UI (route group)
│       │   ├── (auth)/           # Login / register
│       │   └── api/              # REST routes (NextAuth, upload, download, export)
│       ├── components/           # React components (grouped by feature)
│       ├── server/
│       │   ├── authz.ts          # Shared NOT_FOUND-scoped access helpers
│       │   ├── db.ts             # PrismaClient singleton
│       │   ├── queue/
│       │   │   ├── queue.ts      # BullMQ Queue + Redis connection
│       │   │   ├── worker.ts     # Worker entry point (long-running)
│       │   │   └── jobs/*        # Per-job-type handlers
│       │   ├── services/
│       │   │   ├── ai/           # Claude client wrapper + prompts
│       │   │   ├── storage/      # MinIO S3 wrapper
│       │   │   ├── analysis-engine.ts
│       │   │   ├── scoring-service.ts
│       │   │   ├── estimation-service.ts
│       │   │   ├── deliverable-generator.ts
│       │   │   ├── review-manager.ts
│       │   │   ├── question-engine.ts
│       │   │   ├── document-processor.ts
│       │   │   ├── diagram-parser.ts
│       │   │   ├── diagram-generator.ts
│       │   │   ├── export-service.ts
│       │   │   └── markdown-to-docx.ts
│       │   └── trpc/
│       │       ├── trpc.ts       # Context, error formatter, middleware
│       │       ├── router.ts     # Root AppRouter
│       │       └── routers/*.ts  # One file per domain router
│       └── lib/
│           ├── auth.ts           # NextAuth options
│           ├── trpc.ts           # createTRPCReact<AppRouter>
│           └── resolve-assessment-page.ts  # SSR resolver shared by tab pages
│
├── packages/knowledge-seed/      # Consumed by seed.ts
│   ├── frameworks/*.json
│   ├── question-templates/*.json
│   ├── risk-patterns/*.json
│   ├── role-catalog/*.json
│   ├── rate-cards/*.json
│   ├── deliverable-templates/*.json   # AI-content specs the generator uses
│   ├── estimation-templates/          # WBS workbook + binding
│   └── deliverable-shells/            # One file + binding per deliverable type
│
├── docker-compose.yml            # Postgres + Redis + MinIO + PlantUML
├── turbo.json                    # dev / build / db:* / worker tasks
└── pnpm-workspace.yaml
```

**Why a `packages/knowledge-seed` workspace?** Separating the curated
JSON from the app binary means:
- Changes to the KB are `git log`-able as data changes, not code changes.
- Non-engineers can review / PR them without touching TypeScript.
- The seed script is a thin loader; the data itself never needs a
  TypeScript type cast on read.

---

## 4. Request lifecycle

All UI traffic hits the Next.js app. Three routes exist:

1. **App Router pages** (SSR) — `(app)/...` tree. Every page is an
   `async` Server Component. Auth is enforced by the layout reading
   `getServerSession(authOptions)`; the `(app)` group redirects to
   `/login` on miss. Admin-only pages sit under `(app)/admin/` and are
   gated again by the admin layout.

2. **tRPC calls** — `POST /api/trpc/[trpc]` (with GET for queries). One
   fetch-adapter handler wires the `appRouter` to Next.js using the
   fetch handler pattern. `createTRPCContextFromRequest` resolves the
   NextAuth session per request so every procedure sees `ctx.session`.
   Middleware (`protectedProcedure`) throws `UNAUTHORIZED` on missing
   session.

3. **REST routes** for binary traffic that doesn't fit tRPC:
   - `POST /api/documents/upload` — multipart, stores in MinIO, enqueues.
   - `GET  /api/documents/[id]/download` — streams from MinIO with authz.
   - `GET  /api/deliverables/[id]/export` — streams the generated DOCX.

Typical tRPC query round-trip:

```
<Page />  --useQuery-->  /api/trpc/<procedure>?input=...
                          ├─ NextAuth session hydrate
                          ├─ context assembled
                          ├─ protectedProcedure middleware (session check)
                          ├─ procedure-specific authz (assertAssessmentAccess, ...)
                          ├─ Prisma call
                          └─ superjson-serialized payload
```

The **zod errorFormatter** in `src/server/trpc/trpc.ts` surfaces
field-level validation errors under `error.data.zodError.fieldErrors`
so forms can render per-field messages without string-parsing the
error.

---

## 5. Background job pipeline

BullMQ is the heartbeat of every AI flow. One queue
(`document-processing`) with eleven job types. As of Phase 3 Week 1
(ADR-0001) ingest is decoupled from analyse — the deterministic
extract/chunk pipeline does **not** call Claude. Job types and
audit-log lifecycle conventions (`ENQUEUE_X` / `RUN_X` /
`RUN_X_FAILED` / `RUN_X_CANCELLED`) are documented in ADR-0019.

| Job | Triggered by | What it does | AI call? |
|---|---|---|---|
| `ingest-document` | Upload of non-diagram file | pdf-parse/mammoth → chunk → Evidence rows. `Document.ingestStatus: PENDING → EXTRACTING → CHUNKED → READY`. Post-transaction: optional auto-domain-classifier (ADR-0024) when `features.autoClassifyChunks` is on. | Conditional — embedding always (OpenAI); classifier only when opted-in |
| `ingest-diagram` | Upload of diagram format | Diagram parser (text) or Claude vision (PNG/JPEG) → Diagram row + Evidence | Yes — vision / DSL parser (raster path has no deterministic equivalent) |
| `ingest-archive` | Upload of zip / tar / tar.gz | Stream-extract with safety gates (ADR-0008) → one child Document + `ingest-document` fan-out per surviving entry. Parent row holds the archive; children carry `parentDocumentId`. | **No** |
| `ingest-repository` | Create/resync `RepositoryLink` | Decrypt PAT → GitHub tarball API → MinIO → hand off to `ingest-archive` (ADR-0009, ADR-0010). Re-uses the archive pipeline; repo ingest doesn't invent a parallel path. Language tag stored on `Evidence.chunkSource`. | **No** |
| `generate-follow-ups` | Answering a question | Dedup-debounced (1.5s); Claude proposes AI follow-up questions | Yes |
| `run-analysis` | "Run analysis" button | Evidence + KB risk patterns → Claude → Findings/Risks/Recs/Assumptions; flips `Assessment.status=ANALYSIS`. Owns **all** per-assessment text-AI work now. | Yes |
| `run-estimation` | "Generate team & estimate" | Evidence + Findings + KB role catalog → Claude team proposal → priced against rate card. Post-success: best-effort WBS template fill (ADR-0018, ADR-0020 soft-failure). | Yes |
| `generate-deliverable` | "Generate deliverable" | Planned diagrams (N Claude calls) + per-section AI prose (N calls, ~3 concurrency) → `Deliverable` + `DeliverableSection[]` + `Diagram[]`. Post-success: best-effort deliverable-shell template fill (per-type kind from ADR-0018; AI section bodies land in `{{section_<key>}}` placeholders via ADR-0029). | Yes |
| `propose-template-binding` | Template upload | Customer template structural extract → AI binding proposer → `Template.bindingJson`. Human approves separately. | Yes |
| `agent-harness` | Agent-mode evidence collection | Workflow planner → tool calls against external systems → Evidence rows. Gated by `features.agentEnabled` (ADR-0014, ADR-0017). | Yes |
| `prune-logs` | Repeatable (every 6h) | Deletes operator-facing `Log` rows older than `LOG_RETENTION_DAYS`. AuditLog is retained intentionally. | **No** |

Status on a `Document` therefore has two columns during the Week 1
transition: `ingestStatus` (canonical) and `processingStatus` (legacy,
kept for the audit-log and retry surface). The ingest worker keeps the
two in sync. See ADR-0001 for the rationale and the planned cleanup.

Design choices:

- **Shared queue, not N queues.** Lets us reason about backpressure in
  one place; worker concurrency is **5** with a 10-minute lock duration
  (raised from 2 in Phase 3 Week 8 once cost instrumentation + the
  per-domain fan-out's internal concurrency cap landed — see
  ADR-0012). Drop back to 2 if Anthropic rate-limit errors start
  appearing in the audit log.
- **`jobId` always set.** Dedup semantics (`followups-<aid>`) or
  audit-friendly timestamps (`analysis-<aid>-<ms>`) depending on what
  the job type needs. **Colons are forbidden** in BullMQ `jobId` — we
  use `-`; that was a bug caught during Task 7 smoke.
- **Automatic retries are OFF** at the queue layer (`attempts: 1` in
  BullMQ). The AI router does multi-provider failover on classified
  transient errors (rate_limit / overloaded / 5xx) inside a single
  call, but doesn't retry the same call against the same provider —
  retries re-send the full prompt and re-bill tokens, and our most
  common failure modes (billing exhaustion, missing model,
  output-too-long, malformed JSON) deterministically fail on retry
  anyway. User-initiated retries come through the UI's Retry buttons
  (`document.reprocess`, `analysis.run`, `estimation.run`,
  `deliverable.generate`). Adjust the queue-level retry policy in
  `queue.ts`; per-task failover lives in `services/ai/model-registry.ts`.
- **Graceful failure** — each service wraps the AI call in a
  try/catch, flips the relevant row (e.g.
  `Document.processingStatus=FAILED`) with the error message stored in
  `extractedSummary` / equivalent, then re-throws so BullMQ marks the
  job as failed (for audit correlation); with `attempts: 1` this does
  *not* trigger a retry.
- **Status flip on entry** — the analysis worker job flips
  `Assessment.status=ANALYSIS` *before* the Claude call, so the UI can
  show a banner even mid-flight.

See [`diagrams/sequence-analysis.mmd`](./diagrams/sequence-analysis.mmd)
for a concrete sequence diagram of `run-analysis`.

---

## 6. AI integration

### The AI router (ADR-0015 / ADR-0016)

`src/server/services/ai/router.ts` is the single entry point for
every AI call in the system. It supersedes the original
`claude-client.ts` wrapper, which was deleted outright in ADR-0016.

Surface:

1. `callAi<T>({ task, system, userContent, parseResult, ... })` — the
   only call shape services use. `task` is an `AiTask` enum value
   (e.g. `analysis.synthesis`, `template.binding_proposer`,
   `ingest.domain_classifier`) registered in `model-registry.ts`
   with a primary + fallback (provider, model) pair. The router
   tries the primary, falls back on classified transient errors
   (rate limit / overloaded / 5xx), and writes an `AI_CALL` audit
   row with token + cost math (ADR-0012).
2. `parseJsonResponse<T>(raw)` — strips optional ```` ```json ````
   fences and `JSON.parse`s. Every service uses this instead of
   hand-rolling the same guard.
3. Vision prompting reuses the same `callAi` path with an extra
   `image` field; SVG goes through the text path because the
   Messages API doesn't accept SVG as `image`.

Adding a new AI feature requires:

- A new entry in `AiTask` + `DEFAULT_REGISTRY` (model-registry.ts).
- A new copy entry in `components/admin/settings/ai-router-copy.ts`
  so the admin Settings page can render it.
- A prompt file under `services/ai/prompts/`.

**No `@anthropic-ai/sdk` (or OpenAI / Bedrock SDK) imports outside
the router.** Tests mock `callAi`.

### AI tasks — full registry

Source of truth: `AiTask` union + `DEFAULT_REGISTRY` in
[`apps/web/src/server/services/ai/model-registry.ts`](../../apps/web/src/server/services/ai/model-registry.ts).
Operators can override the primary/fallback chain per task via
`/admin/settings?tab=ai-router` (writes to `AiModelOverride`,
hot-reloaded by the router cache).

| Task key | Purpose | Primary | Fallback chain | Prompt cache |
|---|---|---|---|---|
| `analysis.synthesis` | Per-domain fan-out: findings / risks / recommendations / assumptions (ADR-0002). | Anthropic Sonnet 4.7 | Bedrock Sonnet 4.7 → OpenAI GPT-5 | yes |
| `analysis.verifier` | Per-domain verifier pass under THOROUGH mode (ADR-0013). | Anthropic Sonnet 4.7 | Bedrock Sonnet 4.7 | yes |
| `analysis.scoring` | Rubric-anchored 1–5 domain scoring (pass 2). | Anthropic Haiku 4.5 | OpenAI GPT-5-mini | no |
| `deliverable.section` | Batched section generation for the assessment report (~9 sections, `maxTokens: 6000`, 240 s timeout). | Anthropic Sonnet 4.7 | OpenAI GPT-5 | yes |
| `diagram.generate` | Mermaid / PlantUML / Structurizr source for deliverable diagrams. | Anthropic Sonnet 4.7 | OpenAI GPT-5 | no |
| `diagram.parse` | Claude-vision on raster diagrams at ingest. Vision-only path; no fallback yet (Vertex Gemini 2.5 planned, ADR-0015 §3 note). | Anthropic Sonnet 4.7 | — | no |
| `estimation` | Role catalog menu → team proposal + hours allocation. | Anthropic Sonnet 4.7 | OpenAI GPT-5 | no |
| `followups.generate` | Adaptive follow-up questions after an answer (debounced 1.5 s). | Anthropic Haiku 4.5 | OpenAI GPT-5-mini → Mistral small | no |
| `agent.planner` | Tool-call planner inside the agent harness (ADR-0014). | Anthropic Sonnet 4.7 | OpenAI GPT-5 | yes |
| `agent.workflow_planner` | Workflow-step graph planner (ADR-0021) — emits the user-driven node list for the React-Flow surface. | Anthropic Sonnet 4.7 | OpenAI GPT-5 | yes |
| `template.binding_proposer` | Customer-uploaded workbook / docx → JSON binding proposal (ADR-0018). Section-aware: the prompt receives the per-deliverable-type `section.<key>` catalog so narrative-shaped tokens get bound to AI prose, not raw bullet dumps (ADR-0029). | Anthropic Sonnet 4.7 | OpenAI GPT-5 | no |
| `ingest.domain_classifier` | Per-chunk domain auto-tagging at ingest (ADR-0024), behind `features.autoClassifyChunks`. | Anthropic Haiku 4.5 | OpenAI GPT-5 | yes |
| `embedding.ingest` | Embed chunks at ingest. 1536-dim assertion on every row. | OpenAI `text-embedding-3-small` | Bedrock Titan v2 (1536-dim) | n/a |
| `embedding.query` | Embed the retrieval query. **No fallback** — a mid-flight provider hop would change embedding space and wreck pgvector cosine scores. | OpenAI `text-embedding-3-small` | — | n/a |

Notes:

- **Adding a new task** requires three things: a row in `AiTask` +
  `DEFAULT_REGISTRY`, a copy entry in
  `components/admin/settings/ai-router-copy.ts`, and a prompt file
  under `services/ai/prompts/`.
- **Caching** (`cacheSystem: true`) is opt-in per binding. Only
  Anthropic / Bedrock honor the `cacheControl: { type: "ephemeral" }`
  flag today; the router silently ignores it for other providers.
- **Cost rollup** at `/admin/cost` aggregates `AuditLog.AI_CALL` rows
  keyed off `details.task`. Including `cacheReadInputTokens` /
  `cacheCreationInputTokens` so cache savings show up in the dollar
  number, not just the token count.

### Prompts

All prompts live in `src/server/services/ai/prompts/`. One file per
prompt type:

- `document-analysis.ts` — extract facts + risks from uploaded docs.
- `diagram-analysis.ts` — extract entities from uploaded diagrams.
- `question-generation.ts` — adaptive follow-up questions.
- `finding-generation.ts` — one prompt → findings/risks/recs/assumptions.
- `domain-scoring.ts` — rubric-anchored 1–5 scoring.
- `team-estimation.ts` — role catalog menu → team proposal.
- `deliverable-sections.ts` — batched section generation.
- `diagram-generation.ts` — Mermaid/PlantUML source production.
- `template-binding.ts` — customer-uploaded template → JSON binding proposer (ADR-0018).
- `domain-classifier.ts` — per-chunk domain classification at ingest (ADR-0024).
- `agent-planner.ts` / `agent-workflow-planner.ts` — agent-mode tool dispatch + workflow graph (ADR-0014, ADR-0021).

Pattern: every prompt is a pair of `SYSTEM_PROMPT` constant + a
`buildXPrompt(opts)` function that interpolates the per-call context.
The system prompt fixes the output JSON schema; the builder injects
the facts the model reasons over.

### Analysis pipeline (per-domain fan-out, ADR-0002)

`run-analysis` does **not** make one big "analyse everything" Claude call.
Instead the job handler loops over `assessment.activeDomains` and fires
one Claude call per domain, with RAG-retrieved evidence filtered to that
domain's tag, a domain-scoped prompt, and a `maxTokens` budget tuned for
a single-domain output slice (~4096). Calls run with a small concurrency
cap (2–3). Each domain succeeds or fails independently — one domain's
failure doesn't abort the others. The handler aggregates per-domain
results into a single final audit-log row that records both the
successful and `failedDomains` set, so the UI can render a per-domain
status badge and the user can re-run only the failed slice. Same shape
applies to `scoring-service.ts`. Effective output capacity is ~8× what
the combined call used to deliver.

```
run-analysis job
  for domain in activeDomains (concurrency: 2–3):
    retrieve(topK, domain) → scoped prompt → Claude → parsed slice
  aggregate → single AuditLog { successful[], failedDomains[], tokens }
```

### Hybrid retrieval (ADR-0027, opt-in)

Pure cosine handles "this concept appears" well and "this exact
string appears" badly. Behind `features.hybridRetrieval` (DB-backed
flag, default off), the retriever adds a Postgres-native lexical
stage and fuses both rankings with **Reciprocal Rank Fusion** (`k =
60`) in a single SQL statement (two CTEs + a LEFT JOIN on `id`).

- Lexical side: `tsvector` stored generated column + GIN index. No
  new extension, no ingest-worker code — `to_tsvector('english',
  content)` runs at ALTER TABLE / INSERT time.
- Filter composition (`domain`, `documentIds`) applies to both CTEs
  via the same `Prisma.sql` fragment.
- Off by default; existing deploys see no behaviour change. Flip on
  per workspace at `/admin/settings?tab=ai-router`.

### Token / cost hygiene

- Each per-domain call clamps its user-content blob to
  `MAX_CLAUDE_INPUT_CHARS = 20_000` chars (halved from the initial 40k
  once RAG top-K settled; see ADR-0002). RAG top-K × chunk-size fits
  comfortably under the ceiling, and the tighter bound boosts
  Anthropic prompt-cache hit-rates (ADR-0012).
- Evidence / answered-question / finding lists are capped by RAG
  retrieval (`topK`) rather than by a blanket `.take(80)` — the
  retrieval layer already returns the most relevant slice.
- The deliverable generator runs **one Claude call per section** with
  a per-section RAG retrieval; shared system prompt is cached.
- Per-diagram generation stays **one call each** — different output
  contract (source code, not prose) and easier to isolate failures.

### Agentic AI (Phase 4, opt-in)

Alongside the deterministic synthesis pipeline above, an **agent
harness** (ADR-0014) can collect evidence autonomously from connected
external systems. It is an additional evidence *source*, layered
upstream of synthesis — not a replacement for any AI task below it.

Each `Assessment` carries an `evidenceMode` field
(`MANUAL` | `AGENTIC`, default `MANUAL`). When `AGENTIC`, approved
`AgentRun`s execute a plan→observe→dispatch loop over a tool registry
and emit `Evidence(sourceType=CONNECTOR)` rows that feed the exact
same per-domain synthesis, scoring, deliverable, and retrieval paths
as document- and answer-sourced evidence. The feature is gated by
`Setting("features.agentEnabled")` (admin-toggleable at
`/admin/settings?tab=ai-router`) until Slice 3 of the Phase 4
roadmap.

Runs are inspectable from the assessment page through the
`AgentFlowDiagram` trace viewer — a React Flow graph of the run's
`AgentStep` / `AgentToolCall` rows with a context band (goal, status,
totals, budget, halt reason), per-node arg/result summaries +
evidence badges, a click-to-open inspection side panel, a token-spend
sparkline, a replay scrubber, a minimap, branching layout for
parallel tool dispatch, reviewer annotations
(`AgentStepAnnotation`), a same-assessment run-comparison dialog, and
a replay-tool-call hook that queues a re-dispatch with edited args.
See ADR-0026 for the layered tier breakdown.

See:
- [ADR-0014](./decisions/0014-agent-harness-for-evidence-collection.md)
  — harness contract (tool protocol, budgets, trajectory tables).
- [ADR-0017](./decisions/0017-dual-mode-evidence-collection.md) —
  per-assessment `EvidenceMode` + two-layer rollout.
- [ADR-0026](./decisions/0026-agent-trace-viewer.md) — trace viewer
  decision record.
- [Phase 4 roadmap](../design/phase-4-agentic-ai.md) — slicing and
  dependency graph.

---

## 7. Data model highlights

Full schema is in `apps/web/prisma/schema.prisma`. Relationships at the
level that matter for reasoning:

```
User ── EngagementMember ── Engagement ── Assessment
                                            ├── ProjectContext (1:1)
                                            ├── Document[] ── Evidence[]
                                            ├── Diagram[] (INGESTED + GENERATED)
                                            ├── Question[] ── Answer[]
                                            ├── DomainScore[] (1 per active domain)
                                            ├── Finding[]
                                            ├── Risk[]
                                            ├── Recommendation[]
                                            ├── Assumption[]
                                            ├── RoleProposal[]
                                            ├── Estimate[]
                                            │    └── RateCard (fkey)
                                            ├── Deliverable[]
                                            │     ├── DeliverableSection[]
                                            │     │    └── Review[] (audit trail)
                                            │     └── Diagram[] (GENERATED, linked here)
                                            └── RepositoryLink[] (Phase 3 Week 6, ADR-0009/0010)
                                                  └── Document (parent) ── Document[] (children) ── Evidence[]
```

`RepositoryLink` carries `agent_credential_id` (FK to the
engagement-scoped `AgentCredential` vault — see §14 and ADR-0009
post-Slice 3 consolidation note), plus `lastSyncedAt` / `lastSha` /
`ingestStatus` for re-sync UX. The PAT itself lives in the vault, not
on the link — multiple links in the same engagement reuse one PAT
row. The link's tarball lands in MinIO as a single parent
`Document`; per-file evidence is fanned out via the Week 5
`ingest-archive` pipeline and tagged with `chunkSource.language` on
each Evidence row.

**Agent harness tables (Phase 4, ADR-0014 + ADR-0017).** Three new
trajectory tables sit alongside `Assessment`:

- `AgentRun` — one row per planned or executed agent run.
  Carries `planName`, `status` (`PROPOSED` → `APPROVED` → `RUNNING` →
  `COMPLETED` / `BUDGET_EXHAUSTED` / `CANCELLED` / `FAILED`, plus
  `AWAITING_USER` for resumption), `budget` / `usage` (frozen +
  running JSON), `systemPrompt` + `systemPromptSha` for replay, and
  `approvedById` / `approvedAt` for the human-in-the-loop gate.
- `AgentStep` — one row per planner / assistant / tool-call turn,
  keyed by `(runId, idx)` for monotonic ordering. Carries
  `inputTokens` / `outputTokens` for per-step cost accounting.
- `AgentToolCall` — one row per dispatched tool invocation, with
  `argsJson` / `resultJson`, `status`, `errorClass`, `startedAt` /
  `endedAt` / `durationMs`, and the `evidenceIds[]` that the call
  emitted.

`Assessment.evidenceMode` (`MANUAL` | `AGENTIC`, default `MANUAL`)
selects whether a given assessment uses the agent as an evidence
source. It composes orthogonally with the existing `mode` axis
(`FAST` / `THOROUGH`, ADR-0013) — see §6 "Agentic AI" above.

Every AI-produced entity carries:

- `confidence: Float` (0–1)
- `reviewStatus: ReviewStatus` (DRAFT / IN_REVIEW / APPROVED / REJECTED / NEEDS_REVISION)
- `createdAt` / `updatedAt`

Some also carry:

- `evidenceIds: String[]` (array of `Evidence.id` that support the claim)
- `relatedRiskIds: String[]` (on `Recommendation`, links back to risks
  it mitigates)

**Idempotence on re-run** — every AI worker job wipes only DRAFT rows
before inserting new ones. Reviewed rows (IN_REVIEW / APPROVED /
REJECTED / NEEDS_REVISION) survive. This is the key invariant behind
the review-lock discipline (§10).

---

## 8. Authentication & authorization

### Authentication

NextAuth 4 + `CredentialsProvider` + JWT session strategy. The Prisma
adapter isn't compatible with Credentials, so we store only the
`User` row ourselves and stash `id` + `role` on the JWT (typed via
`next-auth.d.ts`).

Three enforcement layers:

1. **Edge middleware** (`src/middleware.ts`) on `/engagements/:path*`
   and `/admin/:path*` — rejects unauthenticated page navigation.
2. **Layout-level session check** in `(app)/layout.tsx` (redirect
   `/login`) and role gate in `(app)/admin/layout.tsx` (redirect `/`).
3. **Procedure-level authz** in tRPC — every data-touching procedure
   runs `assertEngagementAccess()` or `assertAssessmentAccess()`
   (or an inline `engagement: engagementAccessFilter(session)` on a
   join), throwing `NOT_FOUND` on miss.

### Authorization semantics

- **ADMIN role** bypasses membership filters (platform-wide visibility
  for governance).
- **Engagement membership** is the unit of access for non-admins. The
  `EngagementMember` table with `EngagementRole` (OWNER / CONTRIBUTOR
  / REVIEWER / VIEWER) is the source of truth.
- **Review / approve permissions** — the `review.perform` router's
  APPROVE and REJECT actions gate on the caller's **global** `role`
  being ADMIN or REVIEWER (not just engagement membership). This
  matches the "expert review" framing: anyone on the engagement can
  edit; only reviewers sign off.
- **NOT_FOUND, not FORBIDDEN.** Non-members get `NOT_FOUND` on any
  engagement-scoped resource so the error code can't be used as an
  existence oracle. `FORBIDDEN` is only used once the membership gate
  has passed (e.g. the assessor-tries-to-approve case).

Helpers in `src/server/authz.ts`:

```ts
engagementAccessFilter(session)      // Prisma where-fragment
assertEngagementAccess(db, session, engagementId)
assertAssessmentAccess(db, session, assessmentId)  // via parent engagement
```

---

## 9. Knowledge base pattern

Every "data the AI learns from" — question templates, risk patterns,
frameworks (with scoring rubrics), role catalogs, rate cards,
deliverable templates — is a **JSON file in
`packages/knowledge-seed/`** that the Prisma seed (`apps/web/prisma/
seed.ts`) loads into the `KnowledgeArtifact` table (or, for rate
cards, the dedicated `RateCard` table).

### Why JSON files, not DB-CRUD?

- **Reviewable.** Diffs in PRs, not in a black-box admin UI.
- **Reproducible.** Any engineer can `rm -rf` their dev DB and get an
  identical starting state.
- **Versioned.** The seed bumps `version` on every re-apply, so
  history is visible.
- **Idempotent.** Re-seeding updates existing rows in place
  (by `(artifactType, name)`), never duplicates.

### How it feeds the AI

Services query the relevant `KnowledgeArtifact` rows at run time and
stringify them into prompt context. Examples:

- `question-engine.ts` pulls `QUESTION_TEMPLATE` rows for the
  assessment's active domains and materialises them as baseline
  questions.
- `analysis-engine.ts` pulls `RISK_PATTERN` rows for those same
  domains and dumps them into a "Relevant knowledge base patterns"
  block in the prompt.
- `scoring-service.ts` pulls `FRAMEWORK` rows to build a rubric string.
- `estimation-service.ts` pulls the `ROLE_CATALOG` artifact and a
  `RateCard`, exposes the role catalog as the "menu" Claude must pick
  from, and prices the output against the rate card.
- `deliverable-generator.ts` reads
  `packages/knowledge-seed/deliverable-templates/*.json` directly
  (these aren't persisted — the seed doesn't load them to DB because
  the service reads the file at call time for fast iteration).

The admin pages `/admin/knowledge-base` and `/admin/rate-cards` render
read-only views over what's currently loaded, so admins can audit
without an editor UI.

---

## 10. Review discipline

Every AI-produced entity lands with `reviewStatus=DRAFT`. From there,
three concerns interact:

### a) Reviewer-driven transitions

The `review` tRPC router (`routers/review.ts`) exposes
`review.perform({ sectionId, action, comments?, newContent?, newTitle? })`.
Actions:

- **APPROVE** → status=APPROVED
- **REJECT** → status=REJECTED
- **REQUEST_REVISION** → status=NEEDS_REVISION
- **EDIT** → status=IN_REVIEW, `contentFinal` updated, `Review` row
  captures `contentBefore` + `contentAfter`

### b) Author edits also leave an audit trail

The section editor in `DeliverablePreview` calls
`review.perform({ action: "EDIT" })` (not the lighter
`deliverable.updateSection`) so every content change carries the
before/after diff. Optional "edit rationale" field lands on
`Review.comments`.

### c) Re-run preservation

The AI worker jobs (`run-analysis`, `run-estimation`,
`generate-deliverable`) wipe only DRAFT rows before inserting fresh
ones. Any row a reviewer has touched (IN_REVIEW / APPROVED /
REJECTED / NEEDS_REVISION) survives. For domain scoring and team
proposals and estimate edits, the **update mutation auto-flips
DRAFT → IN_REVIEW on any content change** so the reviewer doesn't have
to remember to click Approve/Reject just to protect their edit from
the next re-run.

### d) Evidence traceability contract (Week 7, ADR-0011)

Every AI-produced row (`Finding`, `Risk`, `Recommendation`,
`DomainScore`) carries two evidence-id columns with distinct
semantics:

- `evidenceIds` — **model cited.** What the LLM chose to reference in
  its output. Best-effort, may be empty.
- `retrievedEvidenceIds` — **retriever gave.** The full per-domain
  retrieval output the model saw during the generation call.
  Populated unconditionally by the service layer
  (`analysis-engine.ts`, `scoring-service.ts`).

The reviewer UI surfaces both: "Why this finding?" shows the cited
set primarily and the retrieved-but-not-cited set as a secondary
"what else was in context" disclosure. The DOCX export appendix cites
the source documents from the cited set for publishable provenance.
The Evidence Explorer
(`/engagements/[id]/evidence`) reuses the same retriever +
`evidence-clusterer.ts` so review and search are a consistent view
over the same corpus.

`retrievedEvidenceIds` is additive — downstream code that predates
ADR-0011 keeps working against `evidenceIds` untouched.

### e) Export gate

`review.approveDeliverable(deliverableId)` fails with `BAD_REQUEST` +
a list of blocking sections unless every `DeliverableSection` is
APPROVED. When it succeeds, `Deliverable.status` flips to APPROVED and
the DOCX export route will flip it to EXPORTED on the next clean
download. Draft exports watermark every non-APPROVED section inside
the DOCX and leave status untouched.

---

## 11. DOCX export

Pipeline when a user clicks Export on the `/export` page:

```
Browser
  GET /api/deliverables/:id/export
    ↓
Route handler (Next.js API)
  ├─ getServerSession + assertEngagementAccess
  ├─ Prisma: load Deliverable + sections + diagrams + rate card
  ├─ buildDocxFromDeliverable()
  │   ├─ renderMarkdownToDocxBlocks()  (sections' contentFinal / contentDraft)
  │   ├─ For each uploaded-PNG/JPEG diagram: fetch bytes from MinIO → ImageRun
  │   └─ For text-based (Mermaid/PlantUML/Structurizr/SVG): monospace code block
  ├─ Packer.toBuffer(doc)
  ├─ If Deliverable.status === APPROVED → flip to EXPORTED
  ├─ AuditLog row: EXPORT_DELIVERABLE + bytes + originalStatus
  └─ Respond with Content-Type: vnd.openxmlformats...document
                     Content-Disposition: attachment; filename="..."
```

The **markdown→DOCX renderer** in
`src/server/services/markdown-to-docx.ts` is intentionally minimal
(~290 lines). It handles what our prompts actually emit:

- ATX headings `#` / `##` / `###` / `####`
- Paragraphs with inline `**bold**`, `*italic*` / `_italic_`,
  `` `code` ``
- Bullet and numbered lists (-, *, `1.`)
- Pipe tables with a `---` delimiter row
- Horizontal rules (`---`, `***`)
- Fenced code blocks

A full CommonMark parser would add ~50 KB for edge cases the AI
doesn't produce. If future prompts diversify, swap in
`remark-parse` → `mdast` → `docx` — the renderer's public surface
(`renderMarkdownToDocxBlocks(md) → Array<Paragraph | Table>`) is
stable.

---

## 12. Observability & audit trail

Two overlapping trails:

1. **`AuditLog` table** — every consequential action writes a row:
   - `CREATE Engagement`
   - `CREATE Assessment`
   - `GENERATE_QUESTIONS`, `ENQUEUE_ANALYSIS`, `ENQUEUE_ESTIMATION`,
     `ENQUEUE_DELIVERABLE`
   - `PROCESS Document`, `PROCESS Diagram` (with token usage in `details`)
   - `RUN_ANALYSIS`, `RUN_ESTIMATION`, `GENERATE_DELIVERABLE`
   - `APPROVE_DELIVERABLE`
   - `EXPORT_DELIVERABLE` (with byte count + status transitions)
   - `Review` rows (per-section APPROVE / REJECT / REQUEST_REVISION /
     EDIT with before/after content)

   Each has `userId`, `entityType`, `entityId`, and a free-form
   `details: Json` blob for per-action context.

2. **Structured `console.log` from the worker** — prefixed with the
   job type: `[run-analysis] ▶ assessment=...`, `[run-analysis] ✓ ...`,
   `[run-analysis] ✗ ...`. Easy to ship to any aggregator by piping
   the worker's stdout.

Neither uses an external observability vendor yet. When we add one,
the `AuditLog` table doesn't go away — it's the user-facing audit
trail; the log shipping is for engineers.

**Cost audit trail (Phase 3 Week 8, ADR-0012; multi-provider — ADR-0015).**
Every AI call routed through `callAi()` writes one `AuditLog` row with
`action = 'AI_CALL'` and a `details` blob carrying `task` (one of the
14 `AiTask` values — see the AI tasks registry table in §6),
`callType` (broad bucket: `analysis | scoring | deliverable |
estimation | followups | diagram | embedding | retrieval-query |
agent | ingest | template`), `provider`, `model`,
`inputTokens`, `outputTokens`, Anthropic cache counters
(`cacheReadInputTokens` / `cacheCreationInputTokens`), and an
`estimatedCostUsd` from the per-model pricing table in
`apps/web/src/server/services/ai/pricing.ts`. The `/admin/cost` page
rolls these rows up by engagement × call-type so an operator can
answer "what did this engagement cost" with one SQL query instead of a
log tail. The rollup also powers the `cost.byEngagement` tRPC
procedure for future client-side filters. Writes are best-effort: a
DB blip in the audit path warns-then-continues so cost tracking can
never wedge a foreground AI call.

---

## 13. How it runs (dev + prod-shaped)

### Dev loop

```
docker-compose up -d        # Postgres + Redis + MinIO + PlantUML
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm db:seed                # KB + users + rate card
pnpm dev                    # Next.js on :3000
pnpm worker                 # BullMQ consumer in a second terminal
```

We also support **preview servers** via `.claude/launch.json`:

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "web",    "runtimeExecutable": "pnpm", "runtimeArgs": ["dev"],    "port": 3000, "autoPort": false },
    { "name": "worker", "runtimeExecutable": "pnpm", "runtimeArgs": ["worker"], "autoPort": true }
  ]
}
```

`autoPort: false` on web is deliberate — NextAuth's callback URL
(`NEXTAUTH_URL=http://localhost:3000`) is pinned to 3000. `autoPort:
true` on the worker is a no-op because the worker doesn't bind an HTTP
port; it's a pure Redis consumer.

### Prod-shaped

(Not deployed yet — this is the shape the codebase assumes.)

- **Web** — containerised (`next build && next start` or the standalone
  build). Scales horizontally behind a load balancer; session is a
  self-contained JWT so no sticky sessions needed.
- **Worker** — the same repo, started with `pnpm worker`. Scales
  horizontally; BullMQ handles distribution and deduping.
- **Postgres** — managed (RDS / Cloud SQL / Neon). pgvector extension
  must be enabled; `db:migrate` handles schema.
- **Redis** — managed (ElastiCache / Upstash). `maxRetriesPerRequest:
  null` is required on the IORedis connection (BullMQ contract) — it's
  set in code, not env.
- **Object storage** — real S3. The client is S3-API compliant; only
  `S3_ENDPOINT` changes between MinIO and AWS (set it unset for AWS).
- **Anthropic** — credentials in a secret manager; the SDK reads
  `ANTHROPIC_API_KEY` from env.

See [`../guides/running-locally.md`](../guides/running-locally.md) for
the concise run-book.

---

## 14. Security posture

- **Passwords** — bcryptjs at cost factor 12.
- **Sessions** — JWT via NextAuth. Cookie is `HttpOnly; SameSite=Lax;
  Secure` (in prod — dev runs http). Token carries `id` + `role`; every
  tRPC request re-hydrates session per call.
- **Authz everywhere** — no procedure skips the membership check.
  NOT_FOUND over FORBIDDEN is deliberate.
- **Uploads** — gated by session + engagement membership at the REST
  route boundary. File type is matched against an explicit allowlist in
  the multipart handler; `uploadType` defaults to `OTHER` if the
  detector can't classify.
- **Downloads** — never presigned. Every download goes through the
  proxy route so revoking membership revokes access immediately.
- **Audit** — every reviewer action, every AI run, every export lands
  in `AuditLog` / `Review` with the acting user's id.
- **No secrets in repo** — `.env.example` ships placeholders; real
  `.env` files live outside git. (An Anthropic key was once pasted
  into `.env.example` during Task 1 — caught before push; see
  troubleshooting doc.)
- **Repository credentials** — Phase 3 Week 6 (ADR-0009), revised in
  Phase 4 Slice 3. GitHub PATs are stored in the engagement-scoped
  `AgentCredential` vault (one row per `(engagementId, scope="github.pat")`),
  encrypted at rest with AES-256-GCM using a dedicated 32-byte
  symmetric key in `REPO_CREDENTIAL_KEY` (not derived from
  `NEXTAUTH_SECRET` — the threat models are different). Random 96-bit
  IV per row, 128-bit auth tag for tamper detection. Every
  `RepositoryLink` carries an `agent_credential_id` FK pointing at
  the vault entry — the legacy in-row encrypted columns were dropped
  in migration `20260427201500_drop_legacy_pat_cols`. Both write
  paths (the repo-link form and the agent's credential modal) upsert
  to the same vault row, so rotation is one operation. Every audit
  path funnels through
  `scrubCredential(details)` which strips any field matching
  `pat` / `token` / `credentials` / `authorization` or the
  `ghp_…` / `github_pat_…` shape; a unit test with a known PAT
  asserts the raw string never appears in stringified
  `AuditLog.details`. Fake-mode escape hatch for CI
  (`REPO_CREDENTIAL_MODE=fake`) uses a fixed test key; any other
  unset-key state throws loudly.

Open items for post-MVP:

- **Rate limiting** — tRPC has no rate limit today.
- **CSRF** — NextAuth handles its own; tRPC uses cookies + same-origin.
  An explicit CSRF token layer could be added if we ever open the API
  to cross-origin callers.
- **Secret rotation** — current dev setup stores the Anthropic key in a
  local `.env`. Prod will need a proper secret store hook.

---

## 15. Known limits & debts

| Area | Status | Plan |
|---|---|---|
| Server-side Mermaid rendering | Deferred | Add mermaid-cli in a Docker layer with Chromium, or use a mermaid-rendering microservice |
| Client-side Mermaid preview in DOCX preview | Deferred | Pulls in ~500 KB `mermaid` package client-side; evaluate post-MVP |
| Knowledge-base editor UI | Deferred | Edit JSON + re-seed today; UI gated by usage signal |
| Rate-card editor UI | Deferred | Same pattern |
| Multi-tenant isolation | Single tenant today | All membership / authz is in place for it; needs a `Tenant` row + FK cascade |
| Background job observability UI | Worker logs only | BullMQ Board or custom admin page |
| Full CommonMark in DOCX | Minimal renderer today | Swap in remark-parse if prompts broaden |
| Evidence → pgvector retrieval | **Wired (Phase 3 Week 4, ADR-0003/0004/0005/0006/0007)** | `rag-retriever.retrieve()` is the single entry point; analysis, scoring, deliverable sections, and question follow-ups all go through it. Embeddings populated on every Evidence row, HNSW cosine index backs them, widen-not-pad fallback when the domain filter underfills. `retrieval-flow.mmd` is the canonical diagram. |
| Cost / token tracking per engagement | **Shipped (Phase 3 Week 8, ADR-0012)** | Every AI call writes an `AI_CALL` audit row with tokens + USD cost from `apps/web/src/server/services/ai/pricing.ts`. Rollup UI at `/admin/cost`. Prompt caching enabled on per-domain analysis + scoring. |
| Bulk + archive ingest | **Shipped (Phase 3 Week 5, ADR-0008)** | Stream-extraction with archive safety gates (size cap, zip-slip guard, depth limit). Fan-out to per-file ingest jobs. |
| Repository linking | **Shipped (Phase 3 Week 6, ADR-0009/0010)** | GitHub PAT per engagement, AES-256-GCM encrypted at rest. Tarball-API ingest path — no `git clone`. |
| Per-domain analysis fan-out | **Shipped (Phase 3 Week 2, ADR-0002)** | One Claude call per active domain, bounded concurrency, partial success preserved. |
| Draft / Reviewed analysis modes | **Shipped (Phase 3 Week 9, ADR-0013)** | `RunAnalysisButton` is a single "Run analysis" button that opens a chooser with two options — Draft (FAST: generator + scoring, ~16 Claude calls) and Reviewed (THOROUGH: adds a per-domain verifier, ~24 calls). `mode` flows through tRPC, BullMQ payload, and the engine. Verifier calls audited as `callType = "analysis-verify"` so the /admin/usage dashboard shows the cost split. Mode stamped into `ENQUEUE_ANALYSIS` and `RUN_ANALYSIS` audit rows for per-run A/B attribution. |
| Evidence traceability | **Shipped (Phase 3 Week 4)** | Findings / Risks / Recommendations carry evidenceIds referencing Evidence rows; retrieval-backed citations. |
| Continuous-analysis loop | Open | Re-trigger analysis on evidence change without manual kick. Post-Phase-3 backlog. |
| Multi-tenant isolation | Open | Single tenant today; all membership / authz hooks in place for a `Tenant` row + FK cascade. |
| Code-aware embeddings | Open | Today code chunks use the same text-embedding-3-small pass as docs. Post-Phase-3 evaluation. |
| GitHub App | Open (ADR-0009 follow-up) | PAT flow works today; installing as an App would remove per-user token rotation pain. |
| Playwright E2E suite | **Deferred to post-Phase-3 backlog** | Week 8 deferral — a full E2E pass needs a stable seed + a CI browser runner we haven't scoped. Smoke scripts cover the critical paths in the interim. |
| Chunking + top-K hyperparameter sweep | **Deferred to post-Phase-3 backlog** | Needs labelled evaluation corpus. Knobs surfaced as named constants in `retrieval-config.ts` (ADR-0012) so the sweep, when run, edits one file. |
| Single-phase ingest | **Superseded (Phase 3 Week 1, ADR-0001)** | Ingest and analyse are separate BullMQ jobs; ingest never calls Claude. `Document.ingestStatus` is the canonical pipeline state. |
| `Document.processingStatus` vs `ingestStatus` duplication | Transitional | Both columns exist during the Week 1 decoupling; a follow-up week will drop or rename `processingStatus` once retries/UI stop reading it. |

---

For questions the diagrams answer better than prose, see
[`./diagrams/`](./diagrams/).
