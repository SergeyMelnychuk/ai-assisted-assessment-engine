# Troubleshooting

Known issues that have bitten us during local development, organized by the
error message or symptom you'd see first. If your problem isn't here, add it
after you solve it — future-you will thank present-you.

---

## Next.js

### `Invariant: Expected clientReferenceManifest to be defined. This is a bug in Next.js.`

**Cause.** `.next` build cache is stale — usually from a dev-server boot that
happened before `src/app/layout.tsx` / `page.tsx` existed, or after a major
config change. The build artifacts reference a client-component manifest
Next never finished writing.

**Fix (fastest first).**

```bash
# 1. clear the build cache and restart
rm -rf apps/web/.next apps/web/node_modules/.cache
pnpm --filter @copilot/web dev

# 2. if still broken, reinstall dependencies
rm -rf node_modules apps/web/node_modules
pnpm install
pnpm --filter @copilot/web dev

# 3. last resort: verify only one copy of react / react-dom / next is installed
pnpm why react
pnpm why react-dom
pnpm why next
```

Step 1 resolves this ~95% of the time.

### Startup banner prints `Experiments (use with caution): serverActions`

**Not an error.** Server Actions themselves are stable in Next 15. Only the
`bodySizeLimit` *tuning* still lives under `experimental.serverActions` — see
[`apps/web/next.config.ts`](../../apps/web/next.config.ts). The banner is
Next informing you that you're touching an experimental config key. Ignore it.

### `⚠ Invalid next.config.ts options detected: Unrecognized key(s) in object: 'serverActions'`

**Cause.** `serverActions` was placed at the top level of the config. In Next
15.x it belongs under `experimental.serverActions`. Move it back under
`experimental` in `apps/web/next.config.ts`.

### `404` on http://localhost:3000 right after a fresh bootstrap

**Cause.** No `src/app/page.tsx` exists yet — the dev server is up, there's
just nothing routed at `/`. If you're expecting the landing page, check
[`apps/web/src/app/page.tsx`](../../apps/web/src/app/page.tsx) wasn't
accidentally deleted.

---

## pnpm / Node

### `npm error code EACCES` when running `npm install -g pnpm`

**Cause.** Your Node was installed via the official macOS `.pkg`, so
`/usr/local/lib/node_modules` is owned by `root`. Global installs need sudo
by default. Avoid sudo — pick one of these instead.

**Option A — install pnpm via Homebrew (recommended).**

```bash
brew install pnpm@9
pnpm -v
```

**Option B — point npm's global prefix at your home dir (fixes all future
`-g` installs).**

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g pnpm@9
```

**Option C — one-time sudo via corepack.**

```bash
sudo corepack enable pnpm
corepack prepare pnpm@9.15.0 --activate
```

**Option D (long-term cleanup).** Uninstall the `.pkg` Node, then
`brew install node` or use `fnm` / `nvm`. Eliminates this class of issue.

### `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "#" not found`

**Cause.** zsh does not treat `#` as a comment in interactive shells by
default. Pasting `pnpm -v   # prints version` sends `# prints version` to
pnpm as arguments, and pnpm tries to run `#` as a script.

**Fix.**

```bash
echo 'setopt interactivecomments' >> ~/.zshrc
source ~/.zshrc
```

After that, `#` works as a comment in pasted commands.

### `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "<task>" not found` when running `pnpm <task>` from the repo root

**Cause.** The task isn't declared in the root `package.json` / `turbo.json`.
Workspace scripts only run from the root if Turbo knows about them.

**Fix — two places to update.**

1. Add the script to the root `package.json`:
   ```json
   "scripts": {
     "my:task": "turbo my:task"
   }
   ```
2. Declare the task in `turbo.json` so Turbo will execute it:
   ```json
   "tasks": {
     "my:task": { "cache": false }
   }
   ```

`cache: false` is appropriate for anything that touches external state (DB,
network, filesystem outside the workspace).

---

## Docker

### `Bind for 0.0.0.0:8080 failed: port is already allocated`

**Cause.** Some other container (or host process) is bound to port 8080. Our
`docker-compose.yml` now maps PlantUML to **`8081:8080`** on the host to avoid
this — check that matches yours. If 8081 is also taken, change both the port
mapping and `PLANTUML_SERVER_URL` in `.env` in lockstep.

Find the offender:

```bash
lsof -i :8080
docker ps --format "{{.Names}} {{.Ports}}" | grep 8080
```

### `docker-compose up -d` exits 1 during image pulls

**Cause.** Network timeout during a large image download (Postgres, MinIO,
and PlantUML are the largest). Images are cached once fetched, so just retry.

```bash
docker-compose pull      # optional — downloads without starting containers
docker-compose up -d
docker-compose ps        # verify all services report "healthy" or "running"
```

---

## Database

### Prisma migrations succeed but Postgres rejects `vector` column types at runtime

**Cause.** The `pgvector` extension isn't enabled in the database. Prisma
doesn't auto-install Postgres extensions even when `extensions = [vector]` is
in the schema — you have to run the `CREATE EXTENSION` yourself once per
database.

**Fix.**

```bash
docker exec ai-assisted-assessment-engine-postgres-1 \
  psql -U copilot -d assessment_copilot \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

Safe to re-run; the `IF NOT EXISTS` makes it idempotent. Add this to any
fresh-DB bootstrap script you write.

### `pnpm db:migrate` fails with `Environment variable not found: DATABASE_URL`

**Cause.** `apps/web/.env` doesn't exist or hasn't been loaded. Prisma reads
the `DATABASE_URL` from the `.env` inside `apps/web/` (not the repo root).

**Fix.**

```bash
cp .env.example apps/web/.env
# then edit apps/web/.env to set real secrets (ANTHROPIC_API_KEY,
# NEXTAUTH_SECRET). See docs/guides/troubleshooting.md "Secrets" below.
```

---

## Secrets / `.env`

### I accidentally put a real secret in `.env.example`

`.env.example` is the **committed template** — it must only contain
placeholders. Real secrets go in `apps/web/.env`, which is gitignored
(see `.gitignore:14`).

**Recovery.**

1. Replace the real value with the placeholder in `.env.example`.
2. Put the real value in `apps/web/.env` instead.
3. If the real secret was already committed or pushed, **rotate it** at the
   provider (e.g. delete the Anthropic key at
   https://console.anthropic.com/settings/keys and create a new one). Do not
   rely on rewriting git history — assume it's been scraped the moment it
   touched a remote.

### Shell one-liners for editing `apps/web/.env`

Replace the Anthropic key without putting it in shell history:

```bash
read -s ANTHROPIC_KEY   # paste key, no echo
sed -i '' "s|ANTHROPIC_API_KEY=\".*\"|ANTHROPIC_API_KEY=\"$ANTHROPIC_KEY\"|" apps/web/.env
unset ANTHROPIC_KEY
```

Generate a fresh `NEXTAUTH_SECRET`:

```bash
SECRET=$(openssl rand -base64 32)
sed -i '' "s|NEXTAUTH_SECRET=\".*\"|NEXTAUTH_SECRET=\"$SECRET\"|" apps/web/.env
unset SECRET
```

(The `-i ''` is macOS-specific — BSD `sed` requires the empty backup suffix.)

---

## Checking service health quickly

```bash
# Docker services
docker-compose ps

# Postgres + pgvector
docker exec ai-assisted-assessment-engine-postgres-1 \
  psql -U copilot -d assessment_copilot \
  -c "SELECT extname FROM pg_extension WHERE extname='vector';"

# Redis
docker exec ai-assisted-assessment-engine-redis-1 redis-cli ping

# MinIO (console)
open http://localhost:9001   # login: minioadmin / minioadmin

# PlantUML
curl -I http://localhost:8081

# Next.js
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/
```

If all six pass, the dev environment is green.

---

## Document upload / processing

### Uploads stay stuck in `PENDING`

The worker isn't running. Start it in a second terminal:

```bash
pnpm worker:dev      # from the repo root, --watch-enabled
# or
pnpm --filter @copilot/web worker
```

The worker is a separate Node process — `pnpm dev` only starts Next.js.
Without the worker, jobs enqueue into Redis but nothing drains them.

Confirm it picked up your job:

```bash
docker exec ai-assisted-assessment-engine-redis-1 redis-cli \
  LRANGE "bull:document-processing:wait" 0 -1
```

### Upload returns 502 "Storage upload failed"

MinIO isn't reachable, or the bucket doesn't exist yet. The storage
helper auto-creates `assessment-documents` on first put, but if MinIO
itself is down you'll see a connection error. Check:

```bash
docker-compose ps minio
curl -I http://localhost:9000/minio/health/live
```

### Worker crashes with `maxRetriesPerRequest must be null`

Redis connection in `queue.ts` already sets this — but if you've edited
the file, BullMQ requires `maxRetriesPerRequest: null` on its IORedis
connection. Workers block on `BRPOPLPUSH`; IORedis would otherwise
treat it as a hung command and kill it.

### Processing fails with `Extracted text is empty`

The uploaded file was binary (e.g. a scanned PDF with no text layer,
or an unsupported Office format). Pipeline currently handles PDF,
DOCX, and UTF-8 text. OCR is out of scope for MVP.

### Anthropic API errors (529 / overloaded)

Transient. **The app does not auto-retry AI calls** — every retry costs
real tokens and the same prompt often hits the same wall. The document
flips to `FAILED` immediately; click **Retry processing** from the
document detail panel to re-enqueue once you want to spend another
round-trip.

If you genuinely need automatic retries (e.g. for a batch run where
babysitting the UI isn't practical), flip both in the worker config:

- `attempts: 1 → 2` in `apps/web/src/server/queue/queue.ts`
- `maxRetries: 0 → 2` on the `new Anthropic({...})` in
  `apps/web/src/server/services/ai/claude-client.ts`

Both are deliberately off by default to keep token spend under
human control.

### Anthropic 404 "not_found_error" — model not available

Example from a real failure:

```
Processing failed: 404 {"type":"error","error":{
  "type":"not_found_error","message":"model: claude-sonnet-4-20250514"
}}
```

Your key authenticates fine and has credits, but the model ID the app
is passing isn't provisioned on your Anthropic account. Usually one of:

- The dated snapshot was retired (Anthropic deprecates old snapshots).
- Your account / organisation doesn't have that tier enabled.
- A typo in `ANTHROPIC_MODEL` (if you set the override).

Diagnose — list what the key can actually call:

```bash
export $(grep ANTHROPIC_API_KEY apps/web/.env | xargs)
curl -sS https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" | jq '.data[].id'
```

Pick any id from the list and set it in `apps/web/.env`:

```bash
ANTHROPIC_MODEL="claude-sonnet-4-5"      # or whatever your key has
```

Then **restart the worker** (`pnpm worker` re-reads `.env` at boot)
and retry processing on the failed document.

The app-wide default is `claude-sonnet-4-5` (rolling alias). If
Anthropic ever rotates that, set the override to a current model.

---

## Authentication

### "Login seems to work but I'm still logged out" (port 3001 trap)

Symptom: you submit `admin@copilot.dev` / `admin123`, the page redirects,
but you're dropped back on `/login` or see an unauthenticated page.
The browser URL bar shows `localhost:3001` (or some other port) —
**not** `localhost:3000`.

Root cause: something else was already listening on port 3000, so
Next.js auto-shifted your dev server to 3001 and logged a warning on
boot:

```
⚠ Port 3000 is in use by process <PID>, using available port 3001 instead.
```

But `NEXTAUTH_URL` in `apps/web/.env` is pinned to
`http://localhost:3000`. NextAuth sets the session cookie on 3001 (your
actual origin), then the post-login redirect targets 3000 (the
configured callback). The browser ends up on 3000 — a *different* Next
instance (often a leftover `next-server` from an earlier run) — which
never saw your cookie.

Fix:

```bash
# see who's holding both ports
lsof -i :3000 -i :3001
ps aux | grep next-server

# free them
lsof -t -i:3000 | xargs -r kill -9
lsof -t -i:3001 | xargs -r kill -9

# confirm they're free
lsof -i :3000 -i :3001    # should print nothing

# restart one dev server + one worker
pnpm dev                  # first log line should say "Local: http://localhost:3000"
pnpm worker               # in another terminal
```

Do **not** change `NEXTAUTH_URL` to `localhost:3001` as a workaround.
The fix is to ensure `pnpm dev` claims 3000 cleanly. If you genuinely
can't use 3000 (port already mapped to something you need to keep),
update `NEXTAUTH_URL` consistently in `apps/web/.env` AND in
`.claude/launch.json` AND restart the server — but 3000 is the
expected default.

Common sources of leftover `next-server` processes:

- An earlier `pnpm dev` that was closed with `Ctrl+Z` (suspended, not
  killed). Check with `jobs` in the parent shell and `kill %N`.
- A `.claude/launch.json` preview server that was stopped in the
  Claude Code UI but whose child `next-server` didn't get reaped.
- An abandoned `turbo dev` invocation whose children outlived the
  parent. `pkill -f "next dev"` clears them.

### `InvariantError: Expected clientReferenceManifest to be defined`

Stale `.next` cache, usually after `pnpm db:seed` regenerates Prisma
or after a big refactor. Clear and restart:

```bash
rm -rf apps/web/.next
pnpm dev
```
