# Admin Settings (`/admin/settings`)

The Settings page hosts three tabs:

- **Settings** — runtime-editable engine knobs (this document).
- **Logs** — mirrors the old `/admin/logs` viewer.
- **AI Usage** — mirrors the old `/admin/usage` dashboard.

## Runtime-editable keys

All keys live in the `Setting` table (`key`, `valueJson`, `updatedAt`,
`updatedBy`). Reads go through
`apps/web/src/server/services/settings-service.ts`, which caches values
for 10 s in-process — long enough to cover a full 8-domain analysis
fan-out without a DB round-trip per domain, short enough that a save
lands interactively on the next run.

| Key | Default | Range | Effect |
| --- | --- | --- | --- |
| `analysis.domainConcurrency` | `1` | `1..8` | Per-domain Claude concurrency for `runAnalysis`. Raising cuts wall time; past the model/tier ITPM ceiling it surfaces as 429s. |
| `analysis.interCallDelayMs` | `0` | `0..30000` | Pause inserted between consecutive per-domain Claude calls. Useful at concurrency > 1. |

The compiled-in defaults live on
`apps/web/src/server/services/analysis-engine.ts` as the named exports
`DOMAIN_ANALYSIS_CONCURRENCY` and `DOMAIN_ANALYSIS_INTER_CALL_DELAY_MS`.
If a Setting row is missing or malformed, the engine falls back to those
constants. The engine also re-clamps on read so a manually-edited
`valueJson` can't drive the pool to a pathological value.

## Recommendations

The Settings tab shows a "recommended" value next to each knob. Copy is
generated server-side from the configured Claude model id
(`ANTHROPIC_MODEL` → `MODEL` in
`apps/web/src/server/services/ai/claude-client.ts`) — not hard-coded in
the client. The mapping lives in
`apps/web/src/server/trpc/routers/admin-settings.ts`:

- **Sonnet** — concurrency 1, delay 0 ms. Prompts are 5–15k input tokens;
  at the small-tier 30k ITPM ceiling one call already saturates the
  bucket. Raising concurrency risks 429 `rate_limit_error`.
- **Haiku** — concurrency 2, delay 0 ms. Faster round-trips + same prompt
  size = headroom under the small-tier ceiling for two parallel calls.
- **Opus** — concurrency 1, delay 2000 ms. Slower, costlier; 429 retries
  re-bill the full prompt, so sequential with a burst-damp is the right
  trade-off regardless of tier.

When the org tier upgrades (≥ large / scale), revisit the recommendation
table — the ITPM ceiling is what pins these numbers, not the model.

## Changing a value

1. Navigate to `/admin/settings?tab=settings` (admin role required).
2. Edit a field, click **Save**.
3. The change lands in the `Setting` table and invalidates the local
   cache. The next `runAnalysis` call (new assessment or the next
   re-run) picks up the new value. In-flight runs keep the value they
   resolved at the top of the run — deliberate, so a mid-run save
   doesn't change behaviour halfway through.

Non-admin users get a `NOT_FOUND` from the tRPC mutation — the same
error the server returns for unknown procedures, by design, so probing
the router by guessing names reveals nothing.
