import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import { engagementAccessFilter } from "@/server/authz";
// Import from the dependency-free mapper module, NOT from
// `fill-and-store.ts` — the latter statically pulls in the heavy fill
// stack (exceljs + yauzl-promise → native @node-rs/crc32 binary),
// which webpack can't bundle into the `/api/trpc` route.
import { templateKindToDeliverableType } from "@/server/services/template/template-kind-map";

/**
 * Export-router is intentionally thin: the heavy lifting (DOCX build +
 * streaming) happens in the REST route at `/api/deliverables/[id]/export`
 * because tRPC isn't a great fit for binary responses.
 *
 * This router surfaces two things to the export page:
 *   1. The "which deliverables are ready to export" signal (status +
 *      section-approval ratio) that gates the engine DOCX/PDF buttons.
 *   2. The latest **populated customer-template fill** per deliverable
 *      type, so the export page can also offer the branded `.docx` /
 *      `.pptx` / `.xlsx` the customer uploaded — not just the engine's
 *      house-layout export. These are two genuinely different artifacts
 *      (see ADR-0018 / ADR-0029); the page must not conflate them.
 */
export const exportRouter = createRouter({
  /**
   * Aggregated export-readiness for an assessment's deliverables. One
   * row per deliverable with: current status, draft/clean export
   * eligibility, section approval ratio, and the latest populated
   * customer-template fill (if any) with its fill-health.
   */
  listByAssessment: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      // Access gate — same pattern as every other router.
      const gate = await ctx.db.assessment.findFirst({
        where: {
          id: input.assessmentId,
          engagement: engagementAccessFilter(ctx.session),
        },
        select: { id: true },
      });
      if (!gate) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Assessment not found",
        });
      }

      const [deliverables, fills] = await Promise.all([
        ctx.db.deliverable.findMany({
          where: { assessmentId: input.assessmentId },
          orderBy: { createdAt: "desc" },
          include: {
            sections: {
              select: { id: true, reviewStatus: true },
            },
          },
        }),
        // All template fills for this assessment, newest first, with the
        // source template (for name/kind) + the produced document (for
        // the download link). We resolve "the fill that belongs to this
        // deliverable type" client-of-this-query side below.
        ctx.db.templateFill.findMany({
          where: { assessmentId: input.assessmentId },
          orderBy: { filledAt: "desc" },
          select: {
            id: true,
            filledAt: true,
            filledEntryCount: true,
            warnings: true,
            template: {
              select: { name: true, version: true, kind: true },
            },
            outputDocument: {
              select: { id: true, filename: true, fileSize: true },
            },
          },
        }),
      ]);

      // Index the latest fill per DeliverableType. `fills` is already
      // newest-first, so the FIRST fill we see for a given type wins.
      // A fill maps to a type via its template kind (1:1 for per-
      // deliverable kinds; ESTIMATION + legacy generic kinds map to
      // null and are skipped — they don't correspond to a deliverable).
      const latestFillByType = new Map<
        string,
        (typeof fills)[number]
      >();
      for (const f of fills) {
        const type = templateKindToDeliverableType(f.template.kind);
        if (!type) continue;
        if (!f.outputDocument) continue; // produced doc was deleted
        if (!latestFillByType.has(type)) {
          latestFillByType.set(type, f);
        }
      }

      return deliverables.map((d) => {
        const total = d.sections.length;
        const approved = d.sections.filter(
          (s) => s.reviewStatus === "APPROVED",
        ).length;

        const fill = latestFillByType.get(d.deliverableType);
        const warnings = Array.isArray(fill?.warnings)
          ? (fill.warnings as string[])
          : [];
        const populatedFill =
          fill && fill.outputDocument
            ? {
                documentId: fill.outputDocument.id,
                filename: fill.outputDocument.filename,
                fileSize: fill.outputDocument.fileSize,
                templateName: fill.template.name,
                templateVersion: fill.template.version,
                filledAt: fill.filledAt,
                // `filledEntryCount` is null on fills created before the
                // column existed — treat null as "unknown" (no badge).
                filledEntryCount: fill.filledEntryCount,
                warnings,
                // True only when we KNOW the fill wrote nothing. Null
                // count (legacy row) is not treated as empty.
                isEmpty: fill.filledEntryCount === 0,
              }
            : null;

        return {
          id: d.id,
          deliverableType: d.deliverableType,
          status: d.status,
          // The section-spec key the engine rendered from — NOT a
          // customer template. Renamed in the UI to "Layout" to stop
          // it reading as if it were the uploaded template.
          layoutKey: d.templateId,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          totalSections: total,
          approvedSections: approved,
          canExportClean: total > 0 && total === approved,
          // Draft exports are always allowed — the DOCX watermarks non-
          // approved sections. This flag lets the UI nuance the label
          // ("Export draft" vs "Export approved").
          hasAnyContent: total > 0,
          // The branded customer-template fill, when one exists for this
          // deliverable type. Null when no template produced a file.
          populatedFill,
        };
      });
    }),
});
