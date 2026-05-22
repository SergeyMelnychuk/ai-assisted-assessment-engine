import { db } from "@/server/db";
import { runEstimation } from "@/server/services/estimation-service";
import { fillAndStoreForAssessment } from "@/server/services/template/fill-and-store";
import { classifyProcessingError } from "@/server/services/ai/error-classifier";
import {
  CancelledError,
  isCancelledError,
  throwIfCancelled,
} from "@/server/services/cancellation";

/**
 * BullMQ handler for team+estimate generation.
 *
 * Lifecycle:
 *   - Worker starts → write nothing (the `ENQUEUE_ESTIMATION` row was
 *     already filed by the tRPC procedure).
 *   - Before the Claude call → check for a cancel request. If one
 *     was filed between enqueue and now, exit cleanly with a
 *     `RUN_ESTIMATION_CANCELLED` row (no `_FAILED` — cancel is a
 *     clean exit, not a fault).
 *   - On success → write `RUN_ESTIMATION` so `runStatus` can flip
 *     `inFlight` back to false and the in-flight banner clears.
 *   - On failure → existing path: classified error + audit row.
 */
export async function runEstimationJob(
  assessmentId: string,
  templateId?: string,
): Promise<void> {
  const started = new Date();
  console.log(`[run-estimation] ▶ assessment=${assessmentId}`);

  try {
    // Cancel check: the user may have clicked "Cancel" between
    // enqueue and the worker picking up the job. Honour it before
    // burning a Claude call.
    await throwIfCancelled(
      db,
      assessmentId,
      started,
      "CANCEL_ESTIMATION_REQUESTED",
    );

    const res = await runEstimation(db, assessmentId);
    console.log(
      `[run-estimation] ✓ assessment=${assessmentId} proposals=${res.proposalsCreated}` +
        ` low=${res.totalEffortHoursLow}h/${res.totalCostLow.toFixed(0)}` +
        ` high=${res.totalEffortHoursHigh}h/${res.totalCostHigh.toFixed(0)}` +
        (res.unmatchedRoles.length
          ? ` unmatched=[${res.unmatchedRoles.join(",")}]`
          : "") +
        ` (${Date.now() - started.getTime()}ms)`,
    );

    // Best-effort: fill the customer-uploaded WBS template (if one
    // is APPROVED for this engagement). The fill never blocks the
    // estimation success row — a missing/broken template is logged
    // and skipped.
    let templateFill: Awaited<
      ReturnType<typeof fillAndStoreForAssessment>
    > = null;
    try {
      templateFill = await fillAndStoreForAssessment(db, {
        assessmentId,
        kind: "ESTIMATION",
        templateId,
      });
      if (templateFill) {
        console.log(
          `[run-estimation] ✓ template filled assessment=${assessmentId}` +
            ` document=${templateFill.documentId} file=${templateFill.filename}`,
        );
      }
    } catch (fillErr) {
      console.warn(
        `[run-estimation] template fill failed assessment=${assessmentId}:` +
          ` ${fillErr instanceof Error ? fillErr.message : String(fillErr)}`,
      );
    }

    // Success row — closes the in-flight window for `runStatus`.
    await db.auditLog
      .create({
        data: {
          action: "RUN_ESTIMATION",
          entityType: "Assessment",
          entityId: assessmentId,
          details: {
            proposalsCreated: res.proposalsCreated,
            totalEffortHoursLow: res.totalEffortHoursLow,
            totalEffortHoursHigh: res.totalEffortHoursHigh,
            totalCostLow: res.totalCostLow,
            totalCostHigh: res.totalCostHigh,
            unmatchedRoles: res.unmatchedRoles,
            skippedLockedProposals: res.skippedLockedProposals,
            tokensUsed: res.tokensUsed ?? null,
            durationMs: Date.now() - started.getTime(),
            templateFillId: templateFill?.templateFillId ?? null,
            templateOutputDocumentId: templateFill?.documentId ?? null,
          },
        },
      })
      .catch(() => {
        /* best-effort */
      });
  } catch (err) {
    if (isCancelledError(err)) {
      console.log(
        `[run-estimation] ⚠ assessment=${assessmentId} cancelled before completion`,
      );
      await db.auditLog
        .create({
          data: {
            action: "RUN_ESTIMATION_CANCELLED",
            entityType: "Assessment",
            entityId: assessmentId,
            details: { cancelledAt: new Date().toISOString() },
          },
        })
        .catch(() => {
          /* best-effort */
        });
      // Do NOT rethrow — a clean cancel shouldn't surface as a BullMQ
      // job failure. Same convention as analysis.
      return;
    }
    const classified = classifyProcessingError(err);
    console.error(
      `[run-estimation] ✗ assessment=${assessmentId} [${classified.category}]: ${classified.technicalDetail}`,
    );
    await db.auditLog
      .create({
        data: {
          action: "RUN_ESTIMATION_FAILED",
          entityType: "Assessment",
          entityId: assessmentId,
          details: {
            category: classified.category,
            label: classified.label,
            userMessage: classified.userMessage,
            nextStep: classified.nextStep,
            isRetryable: classified.isRetryable,
            needsAdmin: classified.needsAdmin,
            technicalDetail: classified.technicalDetail,
          },
        },
      })
      .catch(() => {
        /* best-effort */
      });
    throw err;
  }
}

// Avoid an unused import warning when CancelledError is only used
// implicitly via isCancelledError.
void CancelledError;
