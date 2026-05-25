# Production Deployment — Single-VM Runbook

**Audience:** the application engineer deploying Assessment Co-Pilot
to a Linux VM for a customer pilot.

**Prerequisite:** the VM is already prepared per
[`vm-preparation.md`](./vm-preparation.md). Confirm all 12
verification checks in §7 of that document pass before starting
here.

**Outcome:** a single VM running the full application stack (web,
worker, Postgres, Redis, MinIO, PlantUML, Caddy with TLS) in
production mode, fronted by a real hostname, suitable for a 1–2
customer pilot of ~5 concurrent users.

This runbook assumes the code arrives as a **tarball** (no `git` on
the box, no clone, no pull). All builds happen on the VM.

---

## Step 1 — Get the code on the VM

On your laptop, from the repo root:

```bash
git archive --format=tar.gz --prefix=app/ -o copilot-v1.tar.gz HEAD
scp copilot-v1.tar.gz deploy@<host>:/opt/copilot/
```

`git archive` (rather than `tar` of your working tree) gives you a
clean snapshot of committed files only — no `node_modules`, no
`.next`, no local `.env`.

On the VM, as the `deploy` user:

```bash
cd /opt/copilot
tar xzf copilot-v1.tar.gz       # creates /opt/copilot/app/
rm copilot-v1.tar.gz
cd app
```

---

## Step 2 — Enable Next.js standalone output

Production deploys use Next.js's standalone build to keep the runtime
image small. The repo doesn't enable it by default — add one line.

Edit `apps/web/next.config.ts` and add `output: "standalone"`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",        // ← add this line
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
  },
};

export default nextConfig;
```

**Recommended:** commit this change to a `deploy/` branch of your
repo so it ships with the tarball on the next deploy and you don't
have to remember to re-apply it.

---

## Step 3 — Create the application Dockerfile

Create `apps/web/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.6
FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ---- deps ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/
COPY packages ./packages
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM base AS build
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @copilot/web exec prisma generate
RUN pnpm --filter @copilot/web build

# ---- web runtime ----
FROM node:20-bookworm-slim AS web
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/prisma ./apps/web/prisma
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# ---- worker runtime ----
FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/web
CMD ["pnpm", "exec", "tsx", "src/server/queue/worker.ts"]

# ---- migrator (one-shot) ----
FROM base AS migrator
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/web
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]
```

One source, four targets: `web`, `worker`, `migrator` (one-shot for
schema migrations), and `base`/`deps`/`build` as intermediate
stages.

---

## Step 4 — Create the production Compose file

Create `docker-compose.prod.yml` at the repo root:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_USER: copilot
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: assessment_copilot
    volumes: [ "postgres_data:/var/lib/postgresql/data" ]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U copilot -d assessment_copilot"]
      interval: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes: [ "redis_data:/data" ]

  minio:
    image: minio/minio:latest
    restart: unless-stopped
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes: [ "minio_data:/data" ]
    command: server /data --console-address ":9001"

  plantuml:
    image: plantuml/plantuml-server:jetty
    restart: unless-stopped
    environment:
      PLANTUML_LIMIT_SIZE: 16384

  migrator:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      target: migrator
    env_file: .env.production
    depends_on:
      postgres: { condition: service_healthy }
    restart: "no"

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      target: web
    env_file: .env.production
    depends_on:
      migrator: { condition: service_completed_successfully }
      redis: { condition: service_started }
      minio: { condition: service_started }
    restart: unless-stopped

  worker:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      target: worker
    env_file: .env.production
    depends_on:
      migrator: { condition: service_completed_successfully }
      redis: { condition: service_started }
      minio: { condition: service_started }
    restart: unless-stopped

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: [ "80:80", "443:443" ]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on: [ web ]

volumes:
  postgres_data:
  redis_data:
  minio_data:
  caddy_data:
  caddy_config:
```

Notes:
- Only Caddy binds to host ports (80 / 443). Postgres / Redis /
  MinIO / PlantUML / web stay on the internal Docker network.
- The migrator service runs to completion and exits — web and worker
  wait for it before starting (`service_completed_successfully`).

---

## Step 5 — Create the Caddyfile

Create `Caddyfile` at the repo root:

```
copilot.acme-pilot.com {
    encode gzip
    reverse_proxy web:3000
}
```

Replace the hostname with the customer's. Caddy provisions TLS from
Let's Encrypt automatically on first start.

---

## Step 6 — Create the production env file

```bash
cd /opt/copilot/app

PG_PW=$(openssl rand -base64 24)
MINIO_PW=$(openssl rand -base64 24)
NEXTAUTH=$(openssl rand -base64 32)
REPO_KEY=$(openssl rand -base64 32)

cat > .env.production <<EOF
# --- Postgres ---
POSTGRES_PASSWORD=$PG_PW
DATABASE_URL=postgresql://copilot:$PG_PW@postgres:5432/assessment_copilot

# --- Redis ---
REDIS_URL=redis://redis:6379

# --- MinIO ---
MINIO_ROOT_USER=copilot-admin
MINIO_ROOT_PASSWORD=$MINIO_PW
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=copilot-admin
S3_SECRET_KEY=$MINIO_PW
S3_BUCKET=assessment-documents
S3_REGION=us-east-1

# --- Auth ---
NEXTAUTH_SECRET=$NEXTAUTH
NEXTAUTH_URL=https://copilot.acme-pilot.com

# --- AI providers ---
ANTHROPIC_API_KEY=sk-ant-PASTE_HERE
ANTHROPIC_MODEL=claude-sonnet-4-5
OPENAI_API_KEY=sk-PASTE_HERE
EMBEDDING_MODEL=text-embedding-3-small

# --- Repo credential vault (AES-256-GCM key for stored PATs) ---
REPO_CREDENTIAL_KEY=$REPO_KEY

# --- PlantUML ---
PLANTUML_SERVER_URL=http://plantuml:8080

# --- App ---
NODE_ENV=production
EOF

# Paste the two real API keys
nano .env.production

chmod 600 .env.production
```

**Save every generated secret in a password manager immediately.**
The most critical one is `REPO_CREDENTIAL_KEY` — losing it means
every stored customer GitHub PAT becomes unreadable. Treat it like
a database root password.

---

## Step 7 — Build the images

```bash
cd /opt/copilot/app
docker compose -f docker-compose.prod.yml build
```

Takes 5–10 minutes the first time (downloads base images, installs
pnpm dependencies, builds Next.js). Subsequent builds are 1–2
minutes with the Docker layer cache.

---

## Step 8 — Bring up infra and run migrations

```bash
docker compose -f docker-compose.prod.yml up -d postgres redis minio plantuml
docker compose -f docker-compose.prod.yml up migrator    # foreground; runs once, exits 0
```

If `migrator` exits non-zero, almost always either a `DATABASE_URL`
typo or Postgres not healthy yet. Re-run after fixing.

---

## Step 9 — Seed the knowledge base + admin user

```bash
docker compose -f docker-compose.prod.yml run --rm \
  -w /app/apps/web \
  --entrypoint "pnpm exec tsx prisma/seed.ts" web
```

Loads frameworks, question packs, risk patterns, role catalog, rate
card, all deliverable shells, and creates the initial admin user.
The seed is idempotent — safe to re-run.

---

## Step 10 — Create the MinIO bucket

```bash
docker compose -f docker-compose.prod.yml exec minio sh -c '
  mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
  mc mb -p local/assessment-documents
'
```

If the `mc` binary isn't in the image, do this from the MinIO web
console after Step 11 (browse to `https://<hostname>:9001` via SSH
port-forward — the console isn't exposed publicly).

---

## Step 11 — Start web + worker + Caddy

```bash
docker compose -f docker-compose.prod.yml up -d web worker caddy
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f caddy   # watch for TLS cert success
```

Caddy should log `certificate obtained successfully` within 30–60
seconds. If it fails, check DNS resolves to the VM and ports 80 / 443
are open externally. Let's Encrypt has rate limits on failed
challenges — fix the underlying issue, then `docker compose restart
caddy`.

---

## Step 12 — Post-deploy parity checklist

The deployment is technically live after Step 11, but the running
app starts with empty defaults. Walk through this checklist to bring
the environment in line with what you've been using locally.

### 12a. Change the seeded admin password

The seed creates the admin user with a default password (see
`apps/web/prisma/seed.ts`). Sign in with the seeded credentials,
then **immediately**:

1. Open `/admin/users`.
2. Reset the admin password to something strong.
3. Save the new password in your password manager.

### 12b. Configure auth provider (if using email magic links)

NextAuth ships with multiple providers. If your local setup uses
email magic links, you must configure SMTP in `.env.production`
before customers can sign in. Check `apps/web/src/server/auth.ts` for
the active providers and add the corresponding SMTP env vars
(`EMAIL_SERVER_HOST`, `EMAIL_SERVER_PORT`, `EMAIL_SERVER_USER`,
`EMAIL_SERVER_PASSWORD`, `EMAIL_FROM`) plus a real SMTP provider
account (SendGrid, AWS SES, Postmark).

If you're using credentials-based auth, skip this and pre-create
customer users in `/admin/users`.

### 12c. Set feature flags

Feature flags live in the DB-backed `Setting` table and **reset to
defaults on every fresh deploy** — they don't carry over from your
local environment. Open `/admin/settings?tab=ai-router` and toggle
on whatever you've been relying on locally:

- `features.agentEnabled` — agent harness routes/UI.
- `features.autoClassifyChunks` — per-chunk domain auto-classifier.
- `features.hybridRetrieval` — RRF cosine + lexical fusion.
- `features.agentFlowVisible` — agent trace viewer.

### 12d. Verify the AI router

`/admin/settings?tab=ai-router` should show every task with a green
provider status. If any task shows an error, the corresponding API
key is either missing, malformed, or doesn't have access to the
configured model.

### 12e. Smoke test

Run through one full path end-to-end:

1. Create an engagement.
2. Upload a small PDF.
3. Wait for it to reach `READY` (confirms worker is consuming jobs).
4. Create an assessment, answer one question, run analysis.
5. Confirm a finding appears within a minute or two.
6. Generate a deliverable, download it, open it.

If any step fails, check logs in order: `worker`, then `web`, then
`postgres`.

---

## Step 13 — Configure backups

```bash
sudo tee /etc/cron.daily/copilot-backup > /dev/null <<'EOF'
#!/usr/bin/env bash
set -e
TS=$(date +%Y%m%d-%H%M)
DEST=/opt/copilot/backups
mkdir -p "$DEST"
cd /opt/copilot/app
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U copilot assessment_copilot | gzip > "$DEST/pg-$TS.sql.gz"
docker run --rm -v app_minio_data:/data -v "$DEST":/backup alpine \
  tar czf "/backup/minio-$TS.tar.gz" -C /data .
find "$DEST" -type f -mtime +14 -delete
EOF
sudo chmod +x /etc/cron.daily/copilot-backup
```

**Verify the MinIO volume name first** with `docker volume ls | grep
minio` — Compose prefixes the volume name with the project name. If
your project folder is `app/`, the volume is `app_minio_data`. Edit
the script accordingly.

**Off-box copy:** schedule a separate sync (rsync, AWS S3, Backblaze)
to copy `/opt/copilot/backups/` off the VM at least weekly. A backup
on the same disk that fails is not a backup.

---

## Step 14 — Update workflow (when you ship a new version)

```bash
# On laptop
git archive --format=tar.gz --prefix=app/ -o copilot-v2.tar.gz HEAD
scp copilot-v2.tar.gz deploy@<host>:/opt/copilot/

# On VM
cd /opt/copilot
mv app app-old-$(date +%s)              # keep the old folder for quick rollback
tar xzf copilot-v2.tar.gz
cp app-old-*/.env.production app/       # preserve secrets
cp app-old-*/Caddyfile app/             # preserve the Caddy config
cd app

docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d migrator       # waits to completion
docker compose -f docker-compose.prod.yml up -d web worker
```

Expect ~30–60 seconds of downtime during web/worker restart. To roll
back: `cd /opt/copilot/app-old-*` and re-run `docker compose -f
docker-compose.prod.yml up -d` (provided the update did not run a
destructive migration).

### Re-seed KB after content changes

If the update included changes under `packages/knowledge-seed/`
(framework, question pack, risk pattern, role catalog, deliverable
shell, etc.), the migrator only applies schema changes — it does not
re-load JSON content. Re-run the seed manually:

```bash
docker compose -f docker-compose.prod.yml run --rm \
  -w /app/apps/web \
  --entrypoint "pnpm exec tsx prisma/seed.ts" web
```

The seed is idempotent on `(artifactType, name)`, so it's safe.
**Note:** the seed *overwrites* runtime admin edits if a JSON file
defines the same artifact. If a Knowledge Manager has been editing
content via `/admin/knowledge-base`, capture their changes into the
JSON files before re-seeding.

---

## Things that will bite you, ranked

1. **DNS not propagated when Caddy first starts** — Let's Encrypt
   rate-limits failed challenges. Fix DNS, wait 5 min, then `docker
   compose restart caddy`.
2. **`output: "standalone"` not added to `next.config.ts`** — the
   `web` Docker stage build fails because `.next/standalone` doesn't
   exist.
3. **MinIO bucket not created in Step 10** — uploads silently fail;
   worker logs show `NoSuchBucket`.
4. **`REPO_CREDENTIAL_KEY` lost between deployments** — every stored
   customer GitHub PAT becomes unreadable. Always preserve the env
   file across upgrades (Step 14 handles this; double-check before
   nuking the old folder).
5. **VM disk fills up** — pgvector indexes and MinIO blobs grow.
   Monitor `df -h`; 100 GB lasts a couple of months at pilot pace.
6. **Anthropic 429s during analysis fan-out** — burst calls across 8
   domains can trip per-minute limits on a low-tier key. Watch
   `AI_CALL` rows in `/admin/logs` for `status: error` and upgrade
   the tier if needed.
7. **Mermaid CLI / Chromium gap** — the worker base image is
   `node:20-bookworm-slim` and does not include Chromium. PlantUML
   handles the main diagram path server-side, but if any code path
   invokes `@mermaid-js/mermaid-cli` at runtime it will fail. Switch
   to `node:20-bookworm` (non-slim) and `apt install chromium` in the
   worker stage if you hit this.
8. **Feature flags reset on fresh deploy** — covered in Step 12c, but
   easy to forget. The app will be functionally fine; specific
   features (agent harness, hybrid retrieval, auto-classifier) will
   just be off until toggled.

---

## Reference: file layout after deployment

```
/opt/copilot/
├── app/                          ← current deployed version
│   ├── apps/web/Dockerfile       (created in Step 3)
│   ├── docker-compose.prod.yml   (created in Step 4)
│   ├── Caddyfile                 (created in Step 5)
│   ├── .env.production           (created in Step 6, chmod 600)
│   └── ... (rest of the repo)
├── app-old-<timestamp>/          ← previous version, for rollback
└── backups/
    ├── pg-YYYYMMDD-HHMM.sql.gz
    └── minio-YYYYMMDD-HHMM.tar.gz
```

---

## When to upgrade beyond a single VM

This setup is sized for **1–2 customers, ~5 concurrent users, ~2–3
active assessments**. Move off it when any of the following becomes
true:

- More than 3 customers, or any single customer with 10+ concurrent
  users.
- Worker job queue regularly backs up (visible in `/admin/logs` —
  jobs stay `WAITING` for more than a minute).
- The customer asks for HA / 99.9% uptime / disaster recovery beyond
  a nightly restore.
- The customer requires the database, object storage, or AI keys to
  live inside their own cloud account.

At that point, separate the services: managed Postgres with
pgvector (Neon, Supabase, RDS, Crunchy Data), managed Redis
(Upstash, ElastiCache), real S3 / R2 / GCS for object storage, and
the app + worker on a managed runtime (Render, Fly.io, ECS,
Kubernetes). The code already abstracts the S3 endpoint and reads
all credentials from environment variables, so the migration is
mostly an ops effort, not a code one.
