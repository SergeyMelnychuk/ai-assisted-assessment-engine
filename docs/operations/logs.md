# Application logs

Two log tables coexist and answer different questions.

| Table | Purpose | Writers | Surface |
|---|---|---|---|
| `Log` | Application traces for operator debugging — worker progress, tRPC errors, ingest warnings. | `log.info / warn / error` (`apps/web/src/server/lib/logger.ts`) | `/admin/logs` |
| `AuditLog` | Business-event ledger — user approvals, `AI_CALL` cost events, state transitions. | Business-path code paths. | `/admin/usage`, `/admin/cost` |

Rule of thumb: if you are answering **"why did this job fail?"** read `Log`. If you are answering **"who approved this, and when?"** read `AuditLog`.

## Adding a new log source

Just call the logger from anywhere on the server. No registration step.

```ts
import { log } from "@/server/lib/logger";

log.info("job completed", { worker: "queue", jobId, jobName });
log.error("analysis failed", { worker: "run-analysis", jobId, error: err });
```

Persistence is automatic and fire-and-forget — your code never waits on the Prisma insert. If the write fails the error is logged to stderr and the row is dropped; the caller never sees a throw.

The admin UI uses three fields for filtering when they appear in the context:

- `userId`
- `assessmentId`
- `jobId`

Pass them whenever they are known — the logger lifts them to dedicated columns.

### Redaction

The following context keys (case-insensitive) are replaced with `"[redacted]"` before persistence: `password`, `token`, `apiKey`, `authorization`, `cookie`. Nested objects and arrays are walked recursively. If you are adding a new sensitive field, extend `REDACT_KEYS` in `logger.ts`.

## Disabling persistence in an emergency

Set `LOG_PERSIST_ENABLED=false` and restart the web / worker processes. The logger falls back to stdout-only behaviour identical to pre-persistence. Any value other than the literal string `false` enables persistence; `undefined` enables it in dev and prod but disables it under `NODE_ENV=test` / `VITEST=true` so unit tests do not pollute the table.

## Retention

Rows older than **`LOG_RETENTION_DAYS` (default 5)** are pruned automatically by the `prune-logs` BullMQ job — registered as a repeatable (`every: 6h`) on worker start-up, with an extra one-shot fire at boot so a long worker-down window doesn't leave the table bloated until the next tick. Implementation: `apps/web/src/server/queue/jobs/prune-logs.ts`.

Five days is deliberate: `Log` is for debugging recent runs — the permanent business-event history lives in `AuditLog`, which is never pruned. Override with the `LOG_RETENTION_DAYS` env var (integer, days; `0` / invalid values fall back to the default).

The job uses a single parameterised `DELETE` so Postgres can drop whole index pages rather than rewriting them. A failure is logged (`prune-logs failed`) but never rethrown — a failing repeatable would otherwise pile up in BullMQ's `failed` set forever.
