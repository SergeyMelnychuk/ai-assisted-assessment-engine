import type { DeliverableType } from "@prisma/client";
import { db } from "@/server/db";
import { runDeliverableGeneration } from "@/server/services/deliverable-generator";
import { classifyProcessingError } from "@/server/services/ai/error-classifier";
import {
  isCancelledError,
  throwIfCancelled,
} from "@/server/services/cancellation";
import { fillAndStoreForAssessment } from "@/server/services/template/fill-and-store";

const ALLOWED_TYPES: DeliverableType[] = [
  "EXECUTIVE_SUMMARY",
  "ASSESSMENT_REPORT",
  "RISK_REGISTER",
  "TARGET_STATE",
  "ROADMAP",
  "TEAM_PROPOSAL",
  "ESTIMATE",
  "ASSUMPTIONS_GAPS",
  "SOW_DRAFT",
  "GREENFIELD_DISCOVERY",
];

/**
 * Worker wrapper around the deliverable-generator service. Heavy job —
 * 1 AI call per diagram + 1 AI call for all sections. Emits a single
 * structured log line for audit correlation.
 */
export async function generateDeliverableJob(
  assessmentId: string,
  deliverableTypeRaw: string,
  templateId?: string,
): Promise<void> {
  const started = new Date();
  const deliverableType = coerceDeliverableType(deliverableTypeRaw);
  console.log(
    `[generate-deliverable] ▶ assessment=${assessmentId} type=${deliverableType}`,
  );

  try {
    // Honour user cancels filed between enqueue and pickup.
    await throwIfCancelled(
      db,
      assessmentId,
      started,
      "CANCEL_DELIVERABLE_REQUESTED",
    );

    const res = await runDeliverableGeneration(db, assessmentId, deliverableType);
    console.log(
      `[generate-deliverable] ✓ assessment=${assessmentId}` +
        ` deliverableId=${res.deliverableId}` +
        ` sections=${res.sectionsGenerated} diagrams=${res.diagramsGenerated}` +
        ` tokens=${res.tokensUsed.input}/${res.tokensUsed.output}` +
        ` (${Date.now() - started.getTime()}ms)`,
    );

    // Best-effort: fill an APPROVED Word/PowerPoint template (if any).
    // Reports get DELIVERABLE_REPORT, decks get DELIVERABLE_PRESENTATION.
    // Skipped silently when no template exists for the engagement.
    let templateFill: Awaited<
      ReturnType<typeof fillAndStoreForAssessment>
    > = null;
    try {
      // Per-type template kind matches the deliverable type 1:1
      // (e.g. EXECUTIVE_SUMMARY → EXECUTIVE_SUMMARY). The resolver
      // automatically falls back to the legacy generic kinds
      // (DELIVERABLE_REPORT / DELIVERABLE_PRESENTATION) when no
      // per-type template is uploaded — see
      // `fillAndStoreForAssessment` + `legacyFallbackKind`.
      templateFill = await fillAndStoreForAssessment(db, {
        assessmentId,
        kind: deliverableType as
          | "EXECUTIVE_SUMMARY"
          | "ASSESSMENT_REPORT"
          | "RISK_REGISTER"
          | "TARGET_STATE"
          | "ROADMAP"
          | "TEAM_PROPOSAL"
          | "ESTIMATE"
          | "ASSUMPTIONS_GAPS"
          | "SOW_DRAFT"
          | "GREENFIELD_DISCOVERY",
        templateId,
      });
      if (templateFill) {
        console.log(
          `[generate-deliverable] ✓ template filled assessment=${assessmentId}` +
            ` document=${templateFill.documentId} file=${templateFill.filename}`,
        );
      }
    } catch (fillErr) {
      console.warn(
        `[generate-deliverable] template fill failed assessment=${assessmentId}:` +
          ` ${fillErr instanceof Error ? fillErr.message : String(fillErr)}`,
      );
    }

    // Success audit row — closes the in-flight window for `runStatus`.
    await db.auditLog
      .create({
        data: {
          action: "GENERATE_DELIVERABLE",
          entityType: "Assessment",
          entityId: assessmentId,
          details: {
            deliverableType,
            deliverableId: res.deliverableId,
            sectionsGenerated: res.sectionsGenerated,
            diagramsGenerated: res.diagramsGenerated,
            tokensUsed: res.tokensUsed,
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
        `[generate-deliverable] ⚠ assessment=${assessmentId} cancelled before completion`,
      );
      await db.auditLog
        .create({
          data: {
            action: "GENERATE_DELIVERABLE_CANCELLED",
            entityType: "Assessment",
            entityId: assessmentId,
            details: { deliverableType, cancelledAt: new Date().toISOString() },
          },
        })
        .catch(() => {
          /* best-effort */
        });
      return; // clean cancel — don't surface as a BullMQ failure.
    }
    const classified = classifyProcessingError(err);
    console.error(
      `[generate-deliverable] ✗ assessment=${assessmentId} [${classified.category}]: ${classified.technicalDetail}`,
    );
    await db.auditLog
      .create({
        data: {
          action: "GENERATE_DELIVERABLE_FAILED",
          entityType: "Assessment",
          entityId: assessmentId,
          details: {
            category: classified.category,
            label: classified.label,
            userMessage: classified.userMessage,
            nextStep: classified.nextStep,
            isRetryable: classified.isRetryable,
            needsAdmin: classified.needsAdmin,
            deliverableType,
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

function coerceDeliverableType(raw: string): DeliverableType {
  const k = raw.trim().toUpperCase();
  if ((ALLOWED_TYPES as string[]).includes(k)) return k as DeliverableType;
  return "ASSESSMENT_REPORT";
}
