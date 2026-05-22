# Operations troubleshooting

Symptom-indexed entries for production-shaped failures. For developer-facing
dev-loop issues see [`../guides/troubleshooting.md`](../guides/troubleshooting.md).

---

## Archive upload stuck at "extracting"

### Symptom

A user drops a `.zip` / `.tar.gz` into the document drop-zone. The archive
row appears in the Documents tab with `ingestStatus = EXTRACTING` and
the archive-card expansion-progress reads **"Extracting archive…"**
indefinitely — often for more than a couple of minutes — without any
child rows appearing underneath it.

### Cause

Almost always one of three things:

1. **A safety gate tripped mid-stream.** `ingest-archive` enforces
   hard limits (ADR-0008): `ARCHIVE_MAX_ENTRIES` (10 000), uncompressed
   size `ARCHIVE_MAX_UNCOMPRESSED_BYTES` (500 MB), depth
   `ARCHIVE_MAX_DEPTH` (20), and any symlink entry. When one fires, the
   parent flips to `FAILED` and an `AuditLog` row with one of the
   `ARCHIVE_*` categories is written. If the worker crashed *before*
   it could flip the row, the parent stays in `EXTRACTING`.
2. **The BullMQ worker crashed or is paused.** The `ingest-archive`
   queue isn't draining — no child `ingest-document` jobs ever land
   in Redis.
3. **Quarantine / zip-bomb guard.** A compressed-vs-uncompressed ratio
   past the pathological threshold aborts the stream with an
   `ARCHIVE_SIZE_LIMIT` error before any entries are emitted.

### Fix

Work down this list — each step rules out one cause above.

1. **Check the worker is alive and draining `ingest-archive`.**
   ```sh
   redis-cli -n 0 llen bull:ingest-archive:wait
   redis-cli -n 0 llen bull:ingest-archive:active
   ```
   `wait > 0` with `active = 0` means the worker isn't consuming jobs.
   Restart `pnpm worker`. If `active > 0` for > 5 min the worker is
   hung — inspect its logs, then restart.

2. **Look for a classified audit row for this document.**
   ```sql
   SELECT action, details, created_at
     FROM audit_logs
    WHERE entity_id = '<documentId>'
      AND action LIKE 'INGEST_%'
    ORDER BY created_at DESC LIMIT 10;
   ```
   An `ARCHIVE_ENTRY_LIMIT` / `ARCHIVE_SIZE_LIMIT` /
   `ARCHIVE_DEPTH_LIMIT` / `ARCHIVE_SYMLINK` / `ARCHIVE_MALFORMED`
   category tells you which gate tripped. Surface the entry path from
   `details.entryPath` to the user.

3. **If the worker logs show the stream errored but no audit row
   landed**, the parent row is orphaned — flip it manually and let the
   UI surface the failure banner.
   ```sql
   UPDATE documents
      SET ingest_status = 'FAILED'
    WHERE id = '<documentId>' AND ingest_status = 'EXTRACTING';
   ```

4. **Drain and re-upload.** Once the parent is terminal (READY or
   FAILED), the user can re-upload via the drop-zone. If the limit
   was a legitimate over-size, prune the archive (drop `node_modules`,
   vendored assets, lockfiles) or ask an operator to raise the env
   knob in `infra/`:
   - `ARCHIVE_MAX_UNCOMPRESSED_BYTES`
   - `ARCHIVE_MAX_ENTRIES`
   - `ARCHIVE_MAX_DEPTH`

5. **If the queue is genuinely backed up and you need to clear it**,
   drain `ingest-archive` explicitly (safe — children are already
   enqueued as separate jobs on `ingest-document`):
   ```sh
   redis-cli -n 0 del bull:ingest-archive:wait bull:ingest-archive:delayed
   ```
   Only do this after confirming no audit rows are mid-write.

See also: [`../architecture/README.md`](../architecture/README.md) §5
(background job pipeline) and ADR-0008 (archive safety gates).

---

## Analysis runs slowly, duplicates, or "job stalled" in worker log

### Symptom

One or more of:

- Clicking **Run analysis** produces audit-log inserts in the worker
  log for much longer than the expected 4–6 minutes (e.g. 10 min+
  with activity still scrolling).
- Worker log shows `job failed … error="job stalled more than allowable limit"`.
- Worker log shows `connection error … error="could not renew lock for job …"` repeated multiple times.
- The analysis page shows the **same** `completedAt` timestamp after every Refresh, even after a restart.
- Two analysis passes appear to run in parallel (duplicate audit rows,
  double rate-limit pressure producing 429s).
- The **Cancel run** button is visible but clicking it does nothing —
  the UI stays stuck at "Cancelling…" forever. (Indicates a ghost job:
  `ENQUEUE_ANALYSIS` is the last audit row, but no worker is actually
  processing it to see the cancel request.)

### Cause

Almost always one of:

1. **A `pnpm worker:dev` process survived `Ctrl-C`.** tsx's watch mode
   can leave the child reparented to init (PPID=1); the parent shell's
   SIGINT never reaches it. Starting a new worker then produces **two**
   competing workers — each takes a different copy of the job, doubling
   the Anthropic token burn and compounding 429s.
2. **The worker's graceful-shutdown handler hung.** `worker.ts` calls
   `await worker.close()` on SIGTERM, which waits for active jobs to
   finish. If those jobs are mid-Claude-call (30–60s each) or if the
   Redis queue state is corrupt, the handler never returns and the
   process stays alive indefinitely.
3. **Stale BullMQ keys in Redis.** Before `lockDuration` was raised
   (see `worker.ts` → `10 * 60 * 1000`), the default 30s lock expired
   mid-analysis, BullMQ requeued the job as stalled, and the cycle
   repeated. Left behind: piles of entries under `bull:document-processing:failed`
   and sometimes orphaned `:active` entries whose owning worker is
   long dead.
4. **Running code is stale.** `pnpm worker` (no `:dev`) does **not**
   watch for file changes. Any edit to `analysis-engine.ts`,
   `scoring-service.ts`, or a prompt file only takes effect on worker
   restart. Tell-tale sign: the `completedAt` timestamp in the tRPC
   response never advances past the last failed run.

### Fix

Work top-down — each step rules out one cause.

1. **Check for stray workers.**
   ```sh
   pgrep -af "src/server/queue/worker.ts" && echo "STILL RUNNING ↑" || echo "all clear"
   ```
   Each matching line is one live process. You should see **zero**
   lines when no `pnpm worker:dev` terminal is active.

2. **Force-kill any survivors.** `Ctrl-C` is not enough if PPID=1 —
   use SIGKILL. Wrap the kill so it doesn't error when there's nothing
   to kill (bare `kill -9 $(pgrep …)` errors with `kill: not enough
   arguments` if `pgrep` finds nothing, which is confusing noise):
   ```sh
   pids=$(pgrep -f "src/server/queue/worker.ts"); \
     [ -n "$pids" ] && kill -9 $pids || echo "no worker running"
   ```
   Or use `pkill`, which silently no-ops on no match:
   ```sh
   pkill -9 -f "src/server/queue/worker.ts"
   ```
   Re-run step 1 to confirm "all clear".

3. **Verify no worker is still holding a job in Redis.**
   ```sh
   docker exec ai-assisted-assessment-engine-redis-1 redis-cli LLEN 'bull:document-processing:active'
   ```
   Must print `0`. Anything other than `0` after step 2 confirmed "all
   clear" means a **ghost active entry** — the previous worker died
   holding a BullMQ job lock and never released it. Two options:

   ```sh
   # a. Move it back to :wait so the next worker start retries cleanly.
   docker exec ai-assisted-assessment-engine-redis-1 \
     redis-cli RPOPLPUSH 'bull:document-processing:active' 'bull:document-processing:wait'

   # b. Drop it entirely (choose this if you've already written
   #    RUN_ANALYSIS_CANCELLED or the run is no longer wanted).
   docker exec ai-assisted-assessment-engine-redis-1 \
     redis-cli DEL 'bull:document-processing:active'
   ```

   Either way, follow up by clearing any leftover per-job locks — step 4
   handles this as part of a wider cleanup, or do it surgically:
   ```sh
   docker exec ai-assisted-assessment-engine-redis-1 sh -c \
     "redis-cli --scan --pattern 'bull:document-processing:*:lock' | xargs -r redis-cli DEL"
   ```

   **Ghost-job side-effect on the UI:** an orphaned `:active` entry
   leaves the most-recent analysis-lifecycle audit row as
   `ENQUEUE_ANALYSIS` with no terminal row, so `analysis.runStatus`
   reports `inFlight: true` indefinitely and the "Cancel run" button
   sticks around. Clicking Cancel writes `CANCEL_ANALYSIS_REQUESTED`,
   but with no worker to honor it, nothing terminal ever lands. Fix by
   writing the terminal row directly:
   ```sql
   INSERT INTO audit_logs (id, action, entity_type, entity_id, details, created_at)
   VALUES (gen_random_uuid(), 'RUN_ANALYSIS_CANCELLED', 'Assessment',
           '<assessmentId>', '{"reason":"ghost-job-recovery"}'::jsonb, NOW());
   ```
   (Or re-enqueue via option (a) above and let the now-running worker
   write the terminal row naturally — including respecting any pending
   cancel request.)

4. **Clear the queue when it's full of stale/failed jobs.** Safe only
   after step 2 confirms all workers are dead. This wipes every job
   for the `document-processing` queue — jobs that were in flight are
   gone (tokens already spent are already billed; there's nothing to
   recover). Jobs in `:wait` that were duplicates from double-clicks
   are gone — a win.
   ```sh
   docker exec ai-assisted-assessment-engine-redis-1 sh -c \
     "redis-cli --scan --pattern 'bull:document-processing:*' | xargs -r redis-cli DEL"
   ```
   Verify:
   ```sh
   docker exec ai-assisted-assessment-engine-redis-1 redis-cli LLEN 'bull:document-processing:wait'
   docker exec ai-assisted-assessment-engine-redis-1 redis-cli LLEN 'bull:document-processing:active'
   docker exec ai-assisted-assessment-engine-redis-1 redis-cli ZCARD 'bull:document-processing:failed'
   ```
   All three should print `0`.

5. **Always restart via `pnpm worker:dev`, not `pnpm worker`.** The
   `:dev` variant runs `tsx --watch` so subsequent edits to
   `analysis-engine.ts` / `scoring-service.ts` / prompt modules reload
   automatically. Confirm you're on the right command via the
   workspace `package.json`:
   ```sh
   grep -E '"worker' apps/web/package.json
   ```

6. **Prove the run is really new.** After a successful Run analysis,
   the `completedAt` field returned by the `analysis.perDomainStatus`
   tRPC query must be a timestamp **later than** the last failed run.
   If it isn't, the UI is rendering cached tRPC data or the worker
   didn't pick up the enqueue — loop back to step 1.

---

## THOROUGH run took twice as long / cost twice as much

### Symptom

An operator notices a recent `RUN_ANALYSIS` audit row whose
wall-time and Anthropic token spend are roughly 1.5× an earlier
run for the same assessment. The admin usage dashboard shows
`analysis-verify` AI_CALL rows alongside the usual `analysis` ones.

### Cause

Working as intended. Phase 3 Week 9 (ADR-0013) added two run modes:

- **FAST** ("Draft" in the UI) — generator + scoring only. ~16
  Claude calls (8 analysis + 8 scoring), 2-3 min wall time.
- **THOROUGH** ("Reviewed" in the UI) — generator + verifier +
  scoring. ~24 calls, 5-6 min, roughly 2× the cost.

The user picked THOROUGH via the "Reviewed" option in the Run
analysis chooser. Mode is
recorded in `ENQUEUE_ANALYSIS.details.mode` and
`RUN_ANALYSIS.details.mode` so operators can audit which arm a run
took. The verifier calls are audited with `callType =
"analysis-verify"` so the cost shows up as its own line item
rather than inflating `"analysis"`.

### Fix

Nothing to fix — this is the cost of the quality premium (the
verifier adds 8 Claude calls on top of the 16 that FAST already
runs, so a Reviewed run is ~1.5× the wall time and ~1.5–2× the
spend of a Draft run, depending on prompt-cache hit rate). If the
operator wants to confirm:

```sql
SELECT details->>'mode' AS mode, created_at
  FROM audit_logs
 WHERE entity_id = '<assessmentId>'
   AND action IN ('ENQUEUE_ANALYSIS', 'RUN_ANALYSIS')
 ORDER BY created_at DESC LIMIT 10;
```

If a user is hitting THOROUGH by accident, educate on the chooser
copy. The "Run analysis" button opens a two-option menu; the
cheaper path is "Draft" (FAST). There is no default arm — the
user has to pick.

---

## Verifier dropped all findings / output looks too sparse

### Symptom

A THOROUGH run completes successfully but the findings / risks /
recommendations lists come back much shorter than expected, or
empty. Generator call was fine but the verifier pass pruned
aggressively.

### Cause

Two possibilities:

1. **The verifier did its job.** The six rules in
   `prompts/analysis-verification.ts` drop items that aren't
   evidence-grounded, are overly generic, or are recommendations
   that no longer connect to a surviving finding. On thin
   evidence corpora (e.g. a single-document upload) this pruning
   can look extreme. The generator was being optimistic; the
   verifier is being strict.
2. **The verifier call errored and fell back to the heuristic
   filter.** Look for `ANALYSIS_VERIFIER_FAILED` audit rows:

   ```sql
   SELECT details->>'error' AS err, created_at
     FROM audit_logs
    WHERE entity_id = '<assessmentId>'
      AND action = 'ANALYSIS_VERIFIER_FAILED'
    ORDER BY created_at DESC LIMIT 10;
   ```

   If there are rows here the verifier Claude call (or its JSON
   parse) failed on one or more domains and we kept the generator
   output as-is. Not a drop-all — but signal worth watching for
   prompt-regression after model or schema changes.

### Fix

- If #1 — the verifier did its job — the user should re-run in
  Draft mode (FAST) to compare. If the Draft output is also
  sparse, the underlying evidence is thin; upload more documents
  or link the repo.
- If #2 — verifier errored — the audit row carries the classified
  error. Rate-limit (429) / overload (529) errors retry naturally
  on the next run. A schema-parse error means the prompt drifted;
  check `prompts/analysis-verification.ts` against the current
  generator output shape.

---

### Why `lockDuration` was bumped

Default BullMQ `lockDuration` is 30 s. Our analysis job is sequential
across 8 domains with per-call Claude latency that routinely hits
30–60 s on rich prompts, so the lock used to expire mid-run. The
worker now uses `lockDuration: 10 * 60 * 1000` (10 min),
`stalledInterval: 30_000`, and `maxStalledCount: 1`, which comfortably
covers the realistic worst case while still detecting a *truly*
crashed worker within 30 s of lock release. See `apps/web/src/server/queue/worker.ts`.
