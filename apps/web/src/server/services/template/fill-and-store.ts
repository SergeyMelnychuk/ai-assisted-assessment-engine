import { Prisma, type PrismaClient, type TemplateKind } from "@prisma/client";
import {
  buildStorageKey,
  getObjectBuffer,
  putObject,
} from "@/server/storage/minio";
import { fillTemplate } from "./filler";
import { loadEngineOutputs } from "./engine-outputs";
import { bindingDocumentSchema } from "./binding";

/**
 * Pick the template a fill should use for the given assessment + kind.
 *
 * Resolution order (first match wins):
 *   1. APPROVED template scoped to the assessment's engagement.
 *   2. APPROVED workspace default (engagementId = null).
 *
 * Returns `null` when no APPROVED template exists — callers should
 * treat that as "skip the fill, don't fail the run". Customers without
 * an uploaded template still get the standard pipeline outputs.
 */
export async function resolveTemplateForAssessment(
  db: PrismaClient,
  assessmentId: string,
  kind: TemplateKind,
): Promise<{ id: string; engagementId: string | null } | null> {
  const assessment = await db.assessment.findUnique({
    where: { id: assessmentId },
    select: { engagementId: true },
  });
  if (!assessment) return null;

  // Resolution order:
  //   1. Exact-kind match (e.g. EXECUTIVE_SUMMARY → EXECUTIVE_SUMMARY).
  //   2. Legacy generic fallback for the same file format
  //      (presentation-style deliverables fall back to
  //      DELIVERABLE_PRESENTATION; everything else to DELIVERABLE_REPORT).
  //   3. Null — caller skips the fill.
  // Within each tier engagement-scoped beats workspace-default and
  // newer approval beats older.
  const tiers: TemplateKind[] = [kind];
  const fallback = legacyFallbackKind(kind);
  if (fallback && fallback !== kind) tiers.push(fallback);

  for (const t of tiers) {
    const row = await db.template.findFirst({
      where: {
        kind: t,
        status: "APPROVED",
        archivedAt: null,
        OR: [{ engagementId: assessment.engagementId }, { engagementId: null }],
        bindingJson: { not: Prisma.DbNull } as never,
      },
      orderBy: [
        { engagementId: "desc" },
        { approvedAt: "desc" },
      ],
      select: { id: true, engagementId: true },
    });
    if (row) return row;
  }
  return null;
}

/**
 * Map a per-deliverable-type template kind to its legacy generic
 * fallback. Existing customer uploads predate the per-type kinds and
 * live under DELIVERABLE_REPORT / DELIVERABLE_PRESENTATION; this
 * keeps them eligible without a data migration. Returns null when
 * the kind has no fallback (e.g. ESTIMATION).
 */
function legacyFallbackKind(kind: TemplateKind): TemplateKind | null {
  const presentationTypes = new Set<TemplateKind>([
    "EXECUTIVE_SUMMARY",
    "TARGET_STATE",
  ]);
  const deliverableTypes = new Set<TemplateKind>([
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
  ]);
  if (!deliverableTypes.has(kind)) return null;
  return presentationTypes.has(kind)
    ? "DELIVERABLE_PRESENTATION"
    : "DELIVERABLE_REPORT";
}

/**
 * Fill the resolved template (if any) for `assessmentId` + `kind`,
 * persist the populated file as a Document on the same assessment,
 * and link it via a `TemplateFill` audit row.
 *
 * Soft-failure semantics: missing template, malformed binding, or
 * MinIO/render failures are logged + surfaced as audit rows, but do
 * NOT throw. The estimation/deliverable workers should always
 * complete their primary work even when the optional template fill
 * blows up.
 */
export interface FillAndStoreResult {
  templateFillId: string;
  documentId: string;
  filename: string;
  warnings: string[];
}

export async function fillAndStoreForAssessment(
  db: PrismaClient,
  params: {
    assessmentId: string;
    kind: TemplateKind;
    /** Used as the User who "uploaded" the produced Document. Falls
     * back to the assessment's owner when unknown. */
    actingUserId?: string;
    /**
     * Optional explicit template override. When set, skips the
     * auto-resolver and uses this template id directly — provided
     * the caller verified access in the tRPC layer (the picker
     * procedure only returns rows the user can see, and the worker
     * runs after enqueue authz). The id is still validated here
     * against the assessment's engagement scope: an engagement-
     * scoped template must match the assessment's engagement, and
     * it must match `kind` + APPROVED + non-archived. Mismatches
     * fall back to null (skip the fill, never throw).
     */
    templateId?: string;
  },
): Promise<FillAndStoreResult | null> {
  let tpl: { id: string; engagementId: string | null } | null;
  if (params.templateId) {
    // Explicit override: re-validate against assessment scope.
    const assessment = await db.assessment.findUnique({
      where: { id: params.assessmentId },
      select: { engagementId: true },
    });
    if (!assessment) return null;
    // Accept the override if it matches the per-type kind OR the
    // legacy generic fallback for that kind — the picker on the
    // Deliverables page lists both via pickerOptions.
    const allowedKinds: TemplateKind[] = [params.kind];
    const fallback = legacyFallbackKind(params.kind);
    if (fallback && fallback !== params.kind) allowedKinds.push(fallback);
    const row = await db.template.findFirst({
      where: {
        id: params.templateId,
        kind: { in: allowedKinds },
        status: "APPROVED",
        archivedAt: null,
        bindingJson: { not: Prisma.DbNull } as never,
        OR: [
          { engagementId: assessment.engagementId },
          { engagementId: null },
        ],
      },
      select: { id: true, engagementId: true },
    });
    tpl = row ?? null;
  } else {
    tpl = await resolveTemplateForAssessment(
      db,
      params.assessmentId,
      params.kind,
    );
  }
  if (!tpl) return null;

  const tplRow = await db.template.findUnique({
    where: { id: tpl.id },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      storagePath: true,
      bindingJson: true,
      name: true,
      version: true,
    },
  });
  if (!tplRow || !tplRow.bindingJson) return null;

  const parsed = bindingDocumentSchema.safeParse(tplRow.bindingJson);
  if (!parsed.success) {
    await db.auditLog
      .create({
        data: {
          action: "TEMPLATE_FILL_FAILED",
          entityType: "Template",
          entityId: tplRow.id,
          details: {
            assessmentId: params.assessmentId,
            reason: "binding_schema_invalid",
            issues: parsed.error.issues
              .slice(0, 5)
              .map((i) => `${i.path.join(".")}: ${i.message}`),
          },
        },
      })
      .catch(() => {});
    return null;
  }

  const [templateBuffer, outputs] = await Promise.all([
    getObjectBuffer(tplRow.storagePath),
    loadEngineOutputs(db, params.assessmentId),
  ]);

  const filled = await fillTemplate({
    templateBuffer,
    templateMimeType: tplRow.mimeType,
    binding: parsed.data,
    outputs,
  });

  // Resolve a user id for the produced Document (Document.uploadedById
  // is required). Prefer the caller's; fall back to the assessment's
  // owner.
  let uploadedById = params.actingUserId ?? null;
  if (!uploadedById) {
    const assessmentRow = await db.assessment.findUnique({
      where: { id: params.assessmentId },
      select: { engagementId: true },
    });
    if (assessmentRow) {
      const owner = await db.engagementMember.findFirst({
        where: { engagementId: assessmentRow.engagementId, role: "OWNER" },
        orderBy: { id: "asc" },
        select: { userId: true },
      });
      uploadedById = owner?.userId ?? null;
    }
  }
  if (!uploadedById) {
    // No user to attribute to — bail. Should never happen in practice.
    return null;
  }

  const outName = buildFilledFilename(tplRow.filename, tplRow.version);

  // Create the Document row first so we can derive the storage key.
  const doc = await db.document.create({
    data: {
      assessmentId: params.assessmentId,
      filename: outName,
      mimeType: tplRow.mimeType,
      storagePath: "pending",
      fileSize: filled.buffer.byteLength,
      uploadType: "OTHER",
      ingestStatus: "READY",
      processingStatus: "PROCESSED",
      uploadedById,
    },
    select: { id: true },
  });
  const key = buildStorageKey(params.assessmentId, doc.id, outName);
  try {
    await putObject(key, filled.buffer, tplRow.mimeType);
  } catch (err) {
    await db.document.delete({ where: { id: doc.id } }).catch(() => {});
    await db.auditLog
      .create({
        data: {
          action: "TEMPLATE_FILL_FAILED",
          entityType: "Template",
          entityId: tplRow.id,
          details: {
            assessmentId: params.assessmentId,
            reason: "storage_put_failed",
            error: err instanceof Error ? err.message : String(err),
          },
        },
      })
      .catch(() => {});
    return null;
  }
  await db.document.update({
    where: { id: doc.id },
    data: { storagePath: key },
  });

  const fill = await db.templateFill.create({
    data: {
      templateId: tplRow.id,
      assessmentId: params.assessmentId,
      bindingSnapshot: tplRow.bindingJson as Prisma.InputJsonValue,
      outputDocumentId: doc.id,
      // Only the engine sections that drove the fill — keeps the
      // snapshot bounded.
      inputsSnapshot: outputs as unknown as Prisma.InputJsonValue,
      filledById: params.actingUserId ?? null,
    },
    select: { id: true },
  });

  await db.auditLog
    .create({
      data: {
        userId: params.actingUserId ?? null,
        action: "TEMPLATE_FILLED",
        entityType: "Template",
        entityId: tplRow.id,
        details: {
          assessmentId: params.assessmentId,
          documentId: doc.id,
          filledEntryCount: filled.filledEntryCount,
          warnings: filled.warnings,
        },
      },
    })
    .catch(() => {});

  return {
    templateFillId: fill.id,
    documentId: doc.id,
    filename: outName,
    warnings: filled.warnings,
  };
}

/**
 * "wbs-and-estimates-v1.5.xlsx" → "wbs-and-estimates-v1.5--filled.xlsx".
 * Keeps the original extension so the mime-type stays accurate for
 * download.
 */
function buildFilledFilename(original: string, version: string): string {
  const dot = original.lastIndexOf(".");
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : "";
  const ts = new Date().toISOString().slice(0, 10);
  return `${stem}--filled-${version}-${ts}${ext}`;
}
