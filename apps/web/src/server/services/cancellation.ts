import type { PrismaClient } from "@prisma/client";

/**
 * Soft cancellation for long-running analysis jobs.
 *
 * The UI writes a `CANCEL_ANALYSIS_REQUESTED` audit-log row. The worker
 * polls this helper between domain calls; if a request newer than the
 * run's `startedAt` exists, the pipeline short-circuits with
 * `CancelledError` and the orchestrator writes a terminal
 * `RUN_ANALYSIS_CANCELLED` row (not `*_FAILED` — cancel is a clean
 * exit, not a fault).
 *
 * Polling beats signals here because:
 *   - BullMQ workers run in a separate process from the web server, so
 *     we can't share an in-memory flag.
 *   - Redis pub/sub would work but adds a second channel to reason
 *     about; the audit log is already the single source of truth for
 *     run lifecycle and survives a worker restart.
 *   - One `findFirst` on an indexed `(entityId, action, createdAt)`
 *     lookup between domain calls is cheap (~2ms local) versus the
 *     30-60s Claude calls it gates.
 */
export class CancelledError extends Error {
  constructor(message = "run cancelled by user request") {
    super(message);
    this.name = "CancelledError";
  }
}

export function isCancelledError(err: unknown): err is CancelledError {
  return err instanceof Error && err.name === "CancelledError";
}

/**
 * Generic cancel-request lookup. Pass the audit action name the UI
 * writes (`CANCEL_ANALYSIS_REQUESTED`, `CANCEL_ESTIMATION_REQUESTED`,
 * etc.) and the run's start timestamp. `>=` (not `>`) is deliberate:
 * a cancel request filed in the same millisecond as the run start
 * should still halt the run.
 */
export async function isCancelRequested(
  db: PrismaClient,
  assessmentId: string,
  action: string,
  startedAt: Date,
): Promise<boolean> {
  const row = await db.auditLog.findFirst({
    where: {
      entityType: "Assessment",
      entityId: assessmentId,
      action,
      createdAt: { gte: startedAt },
    },
    select: { id: true },
  });
  return row !== null;
}

/** Backwards-compat shim — analysis-specific helper kept for existing
 *  callers in `analysis-engine.ts` etc. Routes through the generic
 *  `isCancelRequested`. */
export async function isAnalysisCancelRequested(
  db: PrismaClient,
  assessmentId: string,
  startedAt: Date,
): Promise<boolean> {
  return isCancelRequested(
    db,
    assessmentId,
    "CANCEL_ANALYSIS_REQUESTED",
    startedAt,
  );
}

/**
 * Convenience — throws `CancelledError` if a cancel has been requested
 * for the given `action`. Call between expensive phases.
 */
export async function throwIfCancelled(
  db: PrismaClient,
  assessmentId: string,
  startedAt: Date,
  action: string = "CANCEL_ANALYSIS_REQUESTED",
): Promise<void> {
  if (await isCancelRequested(db, assessmentId, action, startedAt)) {
    throw new CancelledError();
  }
}
