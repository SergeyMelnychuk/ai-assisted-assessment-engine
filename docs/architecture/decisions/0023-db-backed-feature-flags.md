# ADR-0023: DB-backed feature flags via the `Setting` table

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Engineering
- **Related:**
  [ADR-0014](./0014-agent-harness-for-evidence-collection.md) (the
  first feature behind a flag — `features.agentEnabled`),
  [ADR-0015](./0015-multi-provider-llm-routing.md) (admin Settings
  page where the flags live).

## Context

We need a way to roll features out behind a switch operators can
flip without a redeploy. The two obvious shapes:

- **Env vars** — fast to add, but require a process restart and
  scoping is per-deploy not per-workspace. The web and worker
  processes also have to agree, which means two restarts.
- **DB-backed flags** — toggle from an admin page, take effect on
  the next request. Requires a small service layer to keep the read
  path cheap.

We already have a `Setting` key/value table (Json `valueJson`) that
the analysis engine uses to store tunable knobs (concurrency caps,
pacing). The same table is the natural home for feature flags.

The first concrete need was `features.agentEnabled` (ADR-0014):
gate the agent-harness routes and nav entries while the feature
ramps. We expect more flags as Phase 4 lands (template auto-fill
toggle, in-flight banner cadence, …).

## Decision

Feature flags live on the existing `Setting` table, accessed via
`apps/web/src/server/services/settings-service.ts`. **Do not** add
env vars for new feature toggles.

Conventions:

- **Key namespacing:** `features.<name>` for binary on/off flags,
  `<engine>.<knob>` for tunables (`analysis.concurrency`, …).
  Keeping the namespaces separate prevents the admin UI from
  conflating "this is dangerous to flip" with "this is safe to
  tune".
- **Default in code, not in the table.** A missing row returns the
  caller-supplied default. Operators set the row only to **override**
  the code default, so a fresh database is functional without a
  `Setting` seed.
- **Helper per flag.** `isAgentEnabled(db)` reads the row and
  caches per-process for ~10s (`CACHE_TTL_MS` in
  `settings-service`). New flags get their own helper to keep the
  call sites typed and the cache key obvious.
- **Mutations invalidate locally.** `setSetting` clears the local
  cache so the admin's own click feels instant; other processes
  converge within the TTL.
- **Toggle UI lives at `/admin/settings?tab=ai-router`.** Admin-
  only. Each flag gets a copy entry in
  `components/admin/settings/ai-router-copy.ts` so the toggle
  renders with a name and description, not a raw key.

## Alternatives considered

- **Env vars.** Rejected — restart per change; can't differentiate
  per workspace; web and worker have to agree which is a
  coordination problem.
- **A dedicated `FeatureFlag` table.** Rejected — `Setting`
  already exists for tunables and the table boundary doesn't add
  value. The namespace convention separates concerns inside one
  table.
- **A third-party feature-flag service (LaunchDarkly,
  Unleash).** Rejected for the MVP — adds an external dependency
  and a per-flag cost for what is currently 1 flag in production.
  Trivially swappable later: the helper-per-flag shape is a clean
  interface around storage.
- **Compile-time flags (Next.js public env).** Rejected — flips
  require a rebuild, and the worker process can't read them
  consistently with the web.

## Consequences

**Positive**

- New flags are: add a helper, add a copy entry, ship. No
  redeploy, no env-var coordination.
- Admin UI is one place — operators don't hunt across env files,
  config files, and code to find the lever.
- Cache makes the read path cheap enough that hot code paths can
  consult the flag without measuring (~µs after warm).
- Worker and web process see the same flag values within the cache
  TTL — no two-process drift.

**Negative**

- A flag flip during a long-running job has weak consistency: the
  worker started under one value and may finish under another. In
  practice every flag we've added is a UI / route gate, not a
  mid-job pivot, so this is theoretical. Documented here so the
  next contributor doesn't add a flag that switches mid-Claude-
  call.
- The `Setting` table mixes binary flags with numeric tunables.
  Mitigated by the `features.*` / `<engine>.*` namespace split,
  but a code reviewer should sanity-check which namespace a new
  key belongs in.
- Cache TTL means an admin's flip takes up to ~10s to land in
  other processes. Acceptable for the human grain we're working
  at; if it ever isn't, push-invalidation via Postgres LISTEN/
  NOTIFY is a cheap upgrade path.

**Neutral**

- The flag values are persisted in Postgres backups. Don't put
  secrets in `Setting` rows — that's what `AgentCredential`
  (ADR-0022) and `RepositoryLink.encryptedPat` (ADR-0009) are for.

## Follow-ups

- A type-safe registry of flag keys + their default values, so the
  admin UI can render every known flag without hand-editing copy.
- Per-engagement overrides (a `Setting` row keyed on
  `engagementId + key`) once a feature wants A/B-shaped rollout.
