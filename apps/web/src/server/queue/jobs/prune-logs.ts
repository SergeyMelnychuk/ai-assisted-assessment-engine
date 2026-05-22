import { db } from "@/server/db";
import { log } from "@/server/lib/logger";

/**
 * Prunes the `Log` table of rows older than the configured retention
 * window. Runs as a repeatable BullMQ job (`prune-logs`) registered
 * on worker start-up.
 *
 * Retention is 5 days by default — application traces are for
 * debugging recent runs, not long-term forensics. `AuditLog` carries
 * the permanent business-event history. Override with
 * `LOG_RETENTION_DAYS`.
 *
 * Uses `$executeRaw` rather than `deleteMany` so the delete is a
 * single round-trip and the DB can drop whole index pages instead of
 * rewriting them on repeated batches. Safe because the WHERE clause
 * is parameterised.
 */
export const DEFAULT_LOG_RETENTION_DAYS = 5;

export function resolveLogRetentionDays(): number {
  const raw = process.env.LOG_RETENTION_DAYS;
  if (!raw) return DEFAULT_LOG_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  // Guard against typos — a 0 or NaN would wipe the table on first
  // run. Anything <= 0 falls back to the default.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LOG_RETENTION_DAYS;
  }
  return parsed;
}

export async function pruneLogsJob(): Promise<void> {
  const days = resolveLogRetentionDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const started = Date.now();
  try {
    // Parameterised — Prisma's tagged-template escapes the Date.
    const deleted = await db.$executeRaw`
      DELETE FROM "logs" WHERE "created_at" < ${cutoff}
    `;
    log.info("logs pruned", {
      worker: "queue",
      jobName: "prune-logs",
      retentionDays: days,
      cutoff: cutoff.toISOString(),
      deleted,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    // The prune running late is not catastrophic; log and let BullMQ
    // retry on the next scheduled fire. We deliberately don't rethrow
    // — a failing repeatable would pollute the `failed` set forever.
    log.error("prune-logs failed", {
      worker: "queue",
      jobName: "prune-logs",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
