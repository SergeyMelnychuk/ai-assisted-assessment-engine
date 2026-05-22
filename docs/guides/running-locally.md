# Running locally

A concise run-book. For *why* the stack looks this way see
[`../architecture/README.md`](../architecture/README.md). For
symptom-indexed fixes when things break, see
[`./troubleshooting.md`](./troubleshooting.md) (dev loop) and
[`../operations/troubleshooting.md`](../operations/troubleshooting.md)
(production-shaped failures).

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | Native `--env-file` flag, matches `engines` in `package.json` |
| pnpm | 9.x | `brew install pnpm@9` or `npm i -g pnpm@9` |
| Docker + Docker Compose | any recent | Postgres + Redis + MinIO + PlantUML |
| Postgres + pgvector | 16 + pgvector ≥ 0.7 | `docker-compose.yml` ships a pgvector image. If you swap to a managed/self-hosted Postgres, run `CREATE EXTENSION IF NOT EXISTS vector;` once before `pnpm db:migrate`. |
| Redis | 7+ | BullMQ requirement. The compose file pins this. |
| An Anthropic API key | — | Paid account. Free-tier keys won't clear the billing gate. |
| An OpenAI API key | optional | Only for `EMBEDDING_MODE=live`. Local dev works with `EMBEDDING_MODE=fake` (deterministic pseudo-vectors). |

macOS zsh quirk — if you get `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL
Command "#" not found` when pasting from the docs, run
`setopt interactivecomments` or strip the trailing `# comment` first.

---

## First-time setup

```bash
# 1. clone + install
git clone <this-repo>
cd ai-assisted-assessment-engine
pnpm install

# 2. bring up infra (detached)
docker-compose up -d
docker-compose ps      # verify: postgres, redis, minio, plantuml are "healthy"

# 3. env file (web-scoped; root .env is not read by the app)
cp .env.example apps/web/.env
#    edit apps/web/.env and paste your real ANTHROPIC_API_KEY

# 3a. generate a repo-credential key (encrypts GitHub PATs at rest,
#     AES-256-GCM, ADR-0009). Paste the output into
#     REPO_CREDENTIAL_KEY in apps/web/.env:
openssl rand -base64 32
#     Or skip the keygen entirely for local dev without real PATs:
#       REPO_CREDENTIAL_MODE=fake
#     (fake-mode uses a fixed dev-only key — never use in prod).

# 4. database
pnpm db:generate       # regenerate Prisma client from schema
pnpm db:migrate        # apply migrations (prisma migrate deploy — no drift check)
pnpm db:seed           # load KB (questions / risks / frameworks / roles / rate card) + admin user

# Authoring a new migration? Use `pnpm db:migrate:dev` (prisma migrate dev).
# The default `db:migrate` uses `deploy` because Prisma's schema DSL can't
# declare the pgvector HNSW index (`evidences_embedding_hnsw_idx`) created
# by `20260418000000_embedding_foundation`, and `migrate dev`'s drift check
# would otherwise prompt to drop it on every run.
```

After seeding you have one user: **`admin@copilot.dev`** /
**`admin123`** (override via `ADMIN_SEED_PASSWORD` env var before
seeding). Re-seeding is idempotent and updates the password hash each
time, so you can always rotate it back with `pnpm db:seed`.

---

## Running the app

You need **two long-running processes**: the Next.js server and the
BullMQ worker.

### Option A — two terminals

```bash
# terminal 1
pnpm dev                # Next.js on http://localhost:3000

# terminal 2
pnpm worker             # BullMQ consumer — drains jobs from Redis
```

The worker is **not started by `pnpm dev`** on purpose. Uploads,
AI analysis, team estimation, and deliverable generation all enqueue
jobs that need the worker alive to make progress. Symptom of a missing
worker: uploads stuck on status=PENDING forever.

The worker hosts every BullMQ queue in one process — concurrency 5
per queue (bumped from 2 in Phase 3 W8, ADR-0012):

- `ingest-document` — text extraction, chunking, embedding.
- `ingest-archive` — zip / tar.gz fan-out under safety gates
  (ADR-0008). Emits child `ingest-document` jobs.
- `ingest-repository` — GitHub tarball fetch + fan-out
  (ADR-0009 / 0010).
- `run-analysis`, `generate-team-estimate`, `generate-deliverable`
  — the AI pipelines.

Logs are structured JSON by default. For pretty-printed dev logs set
`DEBUG_WORKERS=1` in `apps/web/.env`.

> ⚠️ **Port 3000 must be free before `pnpm dev`.** If something else is
> already listening there, Next.js will silently shift to `:3001` and
> log `Port 3000 is in use, using available port 3001 instead`.
> `NEXTAUTH_URL` is pinned to `http://localhost:3000`, so login will
> silently fail — the session cookie lands on `:3001`, the post-login
> redirect goes to `:3000`, and the browser ends up on a different
> server instance that never saw the cookie. Always start from:
>
> ```bash
> lsof -i :3000 -i :3001      # should print nothing
> # if something is there:
> lsof -t -i:3000 | xargs -r kill -9
> lsof -t -i:3001 | xargs -r kill -9
> pnpm dev                     # now it claims :3000
> ```
>
> A common cause is a leftover `next-server` from an earlier `pnpm dev`
> that didn't exit cleanly. `ps aux | grep next-server` will show them.

### Option B — Claude Code preview servers

`.claude/launch.json` (committed) configures both processes for the
Claude Code preview runtime. Starting them via `preview_start` works
the same as the two-terminal setup but the output is aggregated in
Claude Code's log viewer.

```jsonc
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "web",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["dev"],
      "port": 3000,
      "autoPort": false
    },
    {
      "name": "worker",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["worker"],
      "autoPort": true
    }
  ]
}
```

- `autoPort: false` on web is deliberate — `NEXTAUTH_URL` is pinned to
  `http://localhost:3000`, so the preview system must not reassign the
  port.
- `autoPort: true` on the worker is a no-op — the worker doesn't bind
  an HTTP port, it's a pure Redis consumer. The assigned port is
  unused.

---

## Service matrix

| Service | Port | Purpose | Credentials (dev only) |
|---|---|---|---|
| Next.js web | `3000` | UI + tRPC + API + NextAuth | admin@copilot.dev / admin123 |
| Postgres 16 + pgvector | `5432` | Primary DB | `copilot` / `copilot_dev` / db `assessment_copilot` |
| Redis 7 | `6379` | BullMQ transport | — |
| MinIO S3 | `9000` | Bucket `assessment-documents` | `minioadmin` / `minioadmin` |
| MinIO console | `9001` | Admin UI | same as S3 |
| PlantUML server | `8081` | Optional diagram rendering | — |

Health checks:

```bash
docker-compose ps
docker exec ai-assisted-assessment-engine-postgres-1 \
  psql -U copilot -d assessment_copilot -c "SELECT extname FROM pg_extension WHERE extname='vector';"
docker exec ai-assisted-assessment-engine-redis-1 redis-cli ping
curl -I http://localhost:9001
curl -I http://localhost:8081
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/
```

All six passing = dev env green.

---

## Common flows

### End-to-end assessment (requires funded Anthropic key)

1. Log in at <http://localhost:3000> as admin.
2. **Create engagement** — `/engagements` → New engagement.
3. **Start assessment** — pick type (Architecture Assessment),
   confirm mode + domains, fill project context.
4. **Upload documents** — drop a PDF or Mermaid file; watch status go
   PENDING → PROCESSING → PROCESSED (or FAILED with a retry button).
5. **Questions** — click *Generate baseline*; answer a couple of
   FREE_TEXT and SINGLE_CHOICE questions. Follow-ups debounce for 1.5s
   then run.
6. **Run analysis** → Findings / Risks / Recommendations / Scoring
   tabs populate as the worker finishes.
7. **Team & estimate** → Generate team & estimate; watch the per-role
   table + pricing land.
8. **Deliverables** → Generate; wait for the worker to finish both
   diagram passes + the batched section pass.
9. **Review** — approve/reject/request-revision on each section; the
   history panel captures every action.
10. **Approve deliverable** on the review dashboard (blocked until
    every section is APPROVED).
11. **Export** → Download the DOCX. First clean export flips status to
    EXPORTED.

### Re-running a single pipeline

- Re-upload a single document → old row kept, new Document + Evidence
  rows added.
- Re-seed the KB (`pnpm db:seed`) → existing artifacts updated in
  place, `version` column bumped.
- Re-run analysis → replaces only DRAFT findings/risks/recs; reviewed
  ones survive. Scoring follows the same rule.
- Re-generate deliverable → wipes DRAFT deliverable + GENERATED
  diagrams; preserves IN_REVIEW / APPROVED / EXPORTED deliverables.

---

## Environment variables (`apps/web/.env`)

Canonical reference is **[`.env.example`](../../.env.example)** — copy
and edit. Summary of every var, grouped by concern:

| Var | Required? | Fake-mode? | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres with pgvector. Compose default: `copilot:copilot_dev@localhost:5432/assessment_copilot`. |
| `REDIS_URL` | yes | — | BullMQ transport. Compose default: `redis://localhost:6379`. |
| `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` / `S3_REGION` | yes in dev | — | MinIO in dev. In prod, unset `S3_ENDPOINT` so the SDK talks to real AWS. |
| `NEXTAUTH_SECRET` | yes | — | Any string in dev; rotate per env in prod. |
| `NEXTAUTH_URL` | yes | — | Pinned to `http://localhost:3000` in dev — keep port 3000 free. |
| `ANTHROPIC_API_KEY` | yes for AI | — | Paid key. Without it, AI paths fail gracefully (audit row + UI banner). |
| `ANTHROPIC_MODEL` | no | — | Defaults to `claude-sonnet-4-5`. Pin a dated snapshot for determinism. |
| `OPENAI_API_KEY` | yes for live embeddings | yes | Blank + `EMBEDDING_MODE=fake` runs the full RAG code path on deterministic pseudo-vectors. |
| `EMBEDDING_MODEL` | no | — | Defaults to `text-embedding-3-small` (ADR-0003). |
| `EMBEDDING_MODE` | no | yes | `live` or `fake`. Unset → inferred from `OPENAI_API_KEY` presence. |
| `REPO_CREDENTIAL_KEY` | yes for real PATs | via `_MODE=fake` | 32-byte base64 (AES-256-GCM, ADR-0009). Generate: `openssl rand -base64 32`. |
| `REPO_CREDENTIAL_MODE` | no | yes | `fake` = use a fixed dev-only key. Never in prod. |
| `DEBUG_WORKERS` | no | — | `1` = pretty-printed worker logs; unset/0 = structured JSON (prod shape). |
| `PLANTUML_SERVER_URL` | no | — | Defaults to `http://localhost:8081`. Optional raster diagram rendering. |
| `NODE_ENV` | yes | — | `development` locally. |

In prod-shaped deployments, `S3_ENDPOINT` should be unset (so the SDK
talks to real AWS), `DATABASE_URL` points at a managed Postgres,
`REDIS_URL` at a managed Redis, and `NEXTAUTH_URL` to the deployed
origin. Everything else stays the same.

---

## Smoke tests

Black-box end-to-end proofs for Phase 3 capabilities. Each script
lives under `scripts/smoke/` and drives the real local stack — no
stubs. Run `docker-compose up -d`, `pnpm dev`, `pnpm worker`, export
the cookies/ids each script expects, then invoke:

- `smoke-embeddings.sh` — ingest → embed → pgvector cosine query
  (W3, ADR-0003/0004/0005).
- `smoke-rag-analysis.sh` — multi-document analysis cites evidence
  across distinct source Documents (W4).
- `smoke-per-domain-analysis.sh` — one Claude call per active
  domain, partial-success audit shape (W2).
- `smoke-ingest-decoupled.sh` — ingest writes `INGEST_DOCUMENT`, no
  `PROCESS_DOCUMENT`, no Claude call (W1).
- `smoke-ingest-shape.sh` — post-chunking Evidence rows > 1 per doc,
  `content_sha` populated, zero `analysis` audit rows (W1).
- `smoke-archive-upload.sh` — zip becomes parent Document + child
  rows via `ingest-archive` under safety gates (W5, ADR-0008).
- `smoke-repo-link.sh` — RepositoryLink → GitHub tarball → child
  Documents, PAT encrypted at rest (W6, ADR-0009/0010).
- `smoke-evidence-trail.sh` — Findings carry non-empty
  `retrievedEvidenceIds`; `evidenceExplorer.findingTrail` resolves
  (W7, ADR-0011).
- `smoke-cost.sh` — `run-analysis` emits `AI_CALL` audit rows with
  positive, bounded `estimatedCostUsd` (W8, ADR-0012).

---

## Admin & internal URLs

Mounted under the authed shell; require an admin user.

- `/admin/cost` — per-assessment AI cost rollup (ADR-0012).
- `/admin/knowledge-base` — read-only KB browser (questions, risk
  patterns, frameworks, roles).
- `/admin/rate-cards` — read-only active rate card view.
- `/engagements/[id]/evidence` — Evidence Explorer; click a Finding
  to see its "Why this finding?" retrieved + cited trail.

---

## When things break

First stop for dev-loop issues: [`./troubleshooting.md`](./troubleshooting.md).
For production-shaped failures (archive extraction stuck, PAT
decryption, ingest-pipeline stalls) see
[`../operations/troubleshooting.md`](../operations/troubleshooting.md).

Indexed symptoms include:

- `InvariantError: Expected clientReferenceManifest to be defined`
  (stale `.next` cache)
- `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "#" not found`
  (zsh paste)
- Port 8080 conflict on PlantUML (moved to 8081)
- Anthropic 529 / billing errors (graceful worker failure, retry from
  UI)
- BullMQ `:` colon in custom job ids
- Stuck PENDING uploads (worker not running)
- MinIO 502 on first put (bucket auto-create; first put is slower)

Phase 3 additions:

- **pgvector extension missing** — `ERROR: type "vector" does not
  exist` on `pnpm db:migrate`. Fix: `CREATE EXTENSION IF NOT EXISTS
  vector;` on the target database. The compose image does this for
  you; managed Postgres usually doesn't.
- **`REPO_CREDENTIAL_KEY is not set`** on first repo link — either
  set a real 32-byte base64 key (`openssl rand -base64 32`) or export
  `REPO_CREDENTIAL_MODE=fake` for local dev.
- **Embeddings returning zero vectors / "fake" prefixes** — you're in
  `EMBEDDING_MODE=fake`. Set `OPENAI_API_KEY` and
  `EMBEDDING_MODE=live` to hit the real API. CI and offline dev stay
  on fake-mode intentionally (ADR-0003).

If it's not covered there, the worker's stdout is the single richest
signal — every job logs `▶ / ✓ / ✗` lines with the assessment id and
error message (`DEBUG_WORKERS=1` makes them readable in dev).
