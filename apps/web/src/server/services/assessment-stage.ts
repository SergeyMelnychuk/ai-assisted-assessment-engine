import type { PrismaClient, AssessmentStage } from "@prisma/client";

/**
 * Monotonic auto-advance for `Assessment.status`.
 *
 * The lifecycle is a checklist, not a state machine — users can manually
 * jump anywhere via the dropdown, and several stages (`INTAKE`,
 * `QUESTIONING`, `REVIEW`) only ever land here as side-effects of
 * domain actions. This helper exists so those side-effects don't have
 * to repeat the same "is this actually a forward step?" guard.
 *
 * Rules:
 *   - Never moves backwards. Uploading a document on a `DRAFTING`
 *     assessment must not knock it back to `INTAKE`.
 *   - Never touches archived rows. The detail page is read-locked and
 *     bumping the stage of a hidden row is silent footgun-fuel.
 *   - Best-effort. Returns `null` (rather than throwing) when nothing
 *     happened — callers in upload paths or queue jobs should not have
 *     their primary work fail because of an audit-row bookkeeping miss.
 *   - Writes an `AuditLog` row with `action: "AUTO_ADVANCE"` so the
 *     transition is traceable next to manual `UPDATE` rows from
 *     `assessment.updateStatus`.
 *
 * `actorUserId` is optional: ingest pipelines run on the worker without
 * a session, in which case the audit row carries `userId: null` and the
 * `details.trigger` field carries the reason instead.
 */

// Source-of-truth ordering — must stay in lockstep with the Prisma
// `AssessmentStage` enum (apps/web/prisma/schema.prisma) and the zod
// guard in `assessment.updateStatus`. Add new stages here AND there.
const STAGE_ORDER: Record<AssessmentStage, number> = {
  SETUP: 0,
  INTAKE: 1,
  QUESTIONING: 2,
  ANALYSIS: 3,
  DRAFTING: 4,
  REVIEW: 5,
  COMPLETED: 6,
};

export interface AdvanceStageOptions {
  /**
   * Short string describing what triggered the auto-advance, e.g.
   * `"document.uploaded"` or `"deliverable.generated"`. Lands in the
   * audit row's `details.trigger` for forensics.
   */
  trigger: string;
  /** Session user id when one is available; null for worker contexts. */
  actorUserId?: string | null;
  /** Extra context to drop into the audit `details` JSON. */
  extra?: Record<string, unknown>;
}

/**
 * Advance `assessmentId`'s status to `target` if (and only if) the
 * current status sits strictly earlier in the lifecycle. Returns the
 * updated row when a transition happened, or `null` when the call was
 * a no-op (already past `target`, archived, or row missing).
 */
export async function maybeAdvanceAssessmentStage(
  db: PrismaClient,
  assessmentId: string,
  target: AssessmentStage,
  options: AdvanceStageOptions,
): Promise<{ from: AssessmentStage; to: AssessmentStage } | null> {
  try {
    const current = await db.assessment.findUnique({
      where: { id: assessmentId },
      select: { status: true, archivedAt: true },
    });
    if (!current) return null;
    if (current.archivedAt) return null;
    if (STAGE_ORDER[current.status] >= STAGE_ORDER[target]) return null;

    // Conditional update: re-check status in the WHERE clause so two
    // concurrent triggers (e.g. a doc upload + a question seed firing
    // at the same time) don't double-advance through a stage. Whichever
    // write lands first wins; the second sees `count: 0` and bails.
    const updated = await db.assessment.updateMany({
      where: {
        id: assessmentId,
        status: current.status,
        archivedAt: null,
      },
      data: { status: target },
    });
    if (updated.count === 0) return null;

    await db.auditLog
      .create({
        data: {
          userId: options.actorUserId ?? null,
          action: "AUTO_ADVANCE",
          entityType: "Assessment",
          entityId: assessmentId,
          details: {
            field: "status",
            from: current.status,
            to: target,
            trigger: options.trigger,
            ...(options.extra ?? {}),
          },
        },
      })
      .catch(() => {
        /* audit failure must not unwind the stage update */
      });

    return { from: current.status, to: target };
  } catch {
    // Stage advancement is a side-effect, never a primary contract.
    // Swallow so callers (upload routes, queue jobs) don't fail their
    // real work over a bookkeeping miss.
    return null;
  }
}
