# ADR-0019: Background-job lifecycle as audit-log state machine

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Engineering
- **Related:**
  [ADR-0001](./0001-decouple-ingest-from-analyse.md) (introduced the
  worker / queue split),
  [ADR-0011](./0011-evidence-traceability-first-class.md) (audit log
  as durable record),
  [ADR-0020](./0020-soft-failure-best-effort-work.md) (failure
  shape for optional sub-steps).

## Context

Long-running jobs (`run-analysis`, `run-estimation`,
`generate-deliverable`, `agent-harness`, `propose-template-binding`)
need three things the BullMQ queue alone doesn't give us:

1. **A UI signal that "a run is in flight"** that survives a page
   reload, a worker restart, and a Redis flush.
2. **Cooperative cancellation** — the user clicks Cancel; the worker
   stops at the next safe checkpoint without burning the rest of the
   token budget.
3. **A complete record of what happened** that lives next to the
   business event ledger, not in a separate metrics store.

BullMQ's job state (`active` / `completed` / `failed`) covers the
queue's view but not the application's. `removeOnComplete: 100`
evicts records quickly, the queue knows nothing about *why* a job
failed in product terms, and a worker crash mid-run leaves the queue
in an awkward state the UI can't reason about.

## Decision

Every long-running job follows the same audit-log state machine,
keyed on the entity the run mutates (`Assessment`, `Template`,
`AgentRun`):

| Phase | Audit action | Written by | When |
|---|---|---|---|
| Enqueue | `ENQUEUE_X` | tRPC mutation | Before `enqueue*()` |
| Start | (none — implicit) | — | Worker picks the job up |
| Cancel-requested | `CANCEL_X_REQUESTED` | tRPC mutation | User clicks Cancel |
| Success | `RUN_X` / `GENERATE_X` | Worker | Job finishes cleanly |
| Failure | `RUN_X_FAILED` | Worker | Classified error |
| Cancellation | `RUN_X_CANCELLED` | Worker | Clean exit on cancel |

A run is **in flight** iff the latest `ENQUEUE_X` for that entity has
no terminal counterpart (`RUN_X` / `RUN_X_FAILED` / `RUN_X_CANCELLED`)
filed after it. The UI's `*.runStatus` query computes this server-side
from one indexed audit-log read; the in-flight banner polls it on a
3 s cadence.

Cooperative cancellation lives in
`apps/web/src/server/services/cancellation.ts`. The worker calls
`throwIfCancelled(db, entityId, startedAt, "CANCEL_X_REQUESTED")` at
each safe checkpoint (between Claude calls, between domain
fan-outs). It throws `CancelledError`; the worker's catch block
maps that to `RUN_X_CANCELLED` (not `_FAILED` — cancel is a clean
exit). Other errors flow through `classifyProcessingError` and
become `RUN_X_FAILED` rows with structured `details`.

`AuditLog` is the source of truth for run state. Redis is the
transport; the audit log is the ledger. The two never disagree
because the worker is the only writer of terminal rows, and the worker
writes them after the work has actually finished (or thrown).

## Alternatives considered

- **Use BullMQ's job state directly.** Rejected — `removeOnComplete`
  evicts history fast, BullMQ has no opinion on "cancelled vs
  failed" (both look like `failed`), and the UI would have to read
  Redis from the web process, breaking the worker / web isolation
  ADR-0001 set up.
- **Add a `JobRun` table dedicated to lifecycle.** Rejected — would
  duplicate every transition the audit log already records, and force
  every reader to join two tables instead of one. Audit-log queries
  are already the standard read pattern in the UI.
- **Redis pub/sub for cancel signals.** Rejected — adds a second
  channel for state we already write to Postgres, and a worker that
  missed the signal (network blip, restart) would never resync. The
  audit log is replayable; pub/sub isn't.
- **Hard cancellation via signal.** Rejected — Claude calls aren't
  abortable mid-flight without losing the tokens already streamed,
  and a partially-applied analysis pass would corrupt downstream
  state. Soft cancellation between checkpoints is the right grain.

## Consequences

**Positive**

- Single shape for every job — adding a new long-running job is
  copy-paste-rename, not a design discussion.
- UI banners are durable across reloads, restarts, and queue
  evictions — they read Postgres, not Redis.
- The audit log already has a domain-event-style shape, so
  lifecycle rows compose with business events on the same timeline
  (`/admin/logs`, `/admin/cost`).
- Cancellation respects token budgets — the user pays for what was
  done, not for the unfortunate moment the cancel arrived.

**Negative**

- Three audit rows per run (enqueue + terminal + sometimes cancel)
  add to log volume. Mitigated by `prune-logs` repeatable on the
  `Log` table; `AuditLog` itself is retained intentionally.
- `*.runStatus` reads are 3 s polled — not push-driven. A lighter
  cadence would feel laggy; tighter would hammer Postgres. Acceptable
  for the human grain we're working at.
- Workers must remember to write the terminal row even on partial
  failures. A worker that crashes between work and audit-write leaves
  the run looking in-flight forever. Mitigation: `removeOnComplete`
  is generous (100), so re-running clears the dangling row when the
  user clicks Run again. A periodic stale-detector is filed under
  follow-ups.

**Neutral**

- `CANCEL_X_REQUESTED` is best-effort — the worker may already be in
  the final phase when the row lands. The UI labels Cancel as
  "request cancel", not "stop now", to set expectations.

## Follow-ups

- Stale-run detector: a repeatable job that flips audit rows older
  than `2 * lockDuration` to `RUN_X_FAILED` with a "stalled" reason,
  so the UI doesn't show a permanent in-flight banner if a worker
  process dies between work and audit-write.
- Push-driven status (Server-Sent Events) over the 3 s poll once we
  have a use case where the latency matters.
