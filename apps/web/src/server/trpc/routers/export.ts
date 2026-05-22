import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import { engagementAccessFilter } from "@/server/authz";

/**
 * Export-router is intentionally thin: the heavy lifting (DOCX build +
 * streaming) happens in the REST route at `/api/deliverables/[id]/export`
 * because tRPC isn't a great fit for binary responses.
 *
 * This router just surfaces the "which deliverables are ready to export"
 * signal to the frontend so the download buttons can gate themselves
 * correctly without re-implementing the progress logic from scratch.
 */
export const exportRouter = createRouter({
  /**
   * Aggregated export-readiness for an assessment's deliverables. The
   * export page renders one row per deliverable with: current status,
   * whether it's downloadable as a draft, whether it's been exported,
   * section approval ratio.
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

      const deliverables = await ctx.db.deliverable.findMany({
        where: { assessmentId: input.assessmentId },
        orderBy: { createdAt: "desc" },
        include: {
          sections: {
            select: { id: true, reviewStatus: true },
          },
        },
      });

      return deliverables.map((d) => {
        const total = d.sections.length;
        const approved = d.sections.filter(
          (s) => s.reviewStatus === "APPROVED",
        ).length;
        return {
          id: d.id,
          deliverableType: d.deliverableType,
          status: d.status,
          templateId: d.templateId,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          totalSections: total,
          approvedSections: approved,
          canExportClean: total > 0 && total === approved,
          // Draft exports are always allowed — the DOCX watermarks non-
          // approved sections. This flag lets the UI nuance the label
          // ("Export draft" vs "Export approved").
          hasAnyContent: total > 0,
        };
      });
    }),
});
