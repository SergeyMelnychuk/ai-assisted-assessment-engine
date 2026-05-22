import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import {
  assertAssessmentAccess,
  assertCanMutateAnalysisOutput,
  engagementAccessFilter,
} from "@/server/authz";

const REVIEW_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "NEEDS_REVISION",
] as const;

const MATURITY_LEVELS = [
  "AD_HOC",
  "INITIAL",
  "DEFINED",
  "MANAGED",
  "OPTIMIZED",
] as const;

export const scoringRouter = createRouter({
  listByAssessment: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      return ctx.db.domainScore.findMany({
        where: { assessmentId: input.assessmentId },
        orderBy: { domain: "asc" },
      });
    }),

  /**
   * Adjust an AI-suggested score. Once a reviewer touches it we flip
   * reviewStatus off DRAFT so the next analysis run won't clobber the
   * edit (see scoring-service.ts partitioning).
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        score: z.number().min(0).max(5).optional(),
        maturityLevel: z.enum(MATURITY_LEVELS).optional(),
        confidence: z.number().min(0).max(1).optional(),
        scoringRationale: z.string().max(4000).optional(),
        reviewStatus: z.enum(REVIEW_STATUSES).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.domainScore.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: { id: true, reviewStatus: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Domain score not found",
        });
      }

      const { id, ...data } = input;

      // Auto-lock on content edit: if the caller updates score/maturity/
      // rationale but doesn't explicitly set reviewStatus, bump to
      // IN_REVIEW so the next analysis run preserves the edit.
      const isContentEdit =
        data.score !== undefined ||
        data.maturityLevel !== undefined ||
        data.scoringRationale !== undefined;
      if (
        isContentEdit &&
        data.reviewStatus === undefined &&
        existing.reviewStatus === "DRAFT"
      ) {
        data.reviewStatus = "IN_REVIEW";
      }

      return ctx.db.domainScore.update({ where: { id }, data });
    }),

  /**
   * Hard delete of a single domain's score. OWNER/ADMIN-gated, audited.
   * Note: the next `runDomainScoring` pass will regenerate a DRAFT score
   * for the same domain unless the caller also excludes the domain from
   * `Assessment.activeDomains` — intentional; deletion here is "remove
   * this stale entry" rather than "disable this domain".
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const s = await ctx.db.domainScore.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
      });
      if (!s) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Domain score not found",
        });
      }
      await assertCanMutateAnalysisOutput(
        ctx.db,
        ctx.session,
        s.assessmentId,
      );
      await ctx.db.$transaction([
        ctx.db.domainScore.delete({ where: { id: s.id } }),
        ctx.db.auditLog.create({
          data: {
            userId: ctx.session.user.id,
            action: "DELETE_DOMAIN_SCORE",
            entityType: "Assessment",
            entityId: s.assessmentId,
            details: { domainScoreId: s.id, snapshot: s },
          },
        }),
      ]);
      return { success: true };
    }),

  /**
   * Bulk-delete every domain score on an assessment. OWNER/ADMIN-gated.
   * See `finding.clearAll`. Note: the next analysis run will recreate
   * DRAFT scores for every active domain — this is "wipe the current
   * grid", not "disable scoring".
   */
  clearAll: protectedProcedure
    .input(
      z.object({
        assessmentId: z.string().cuid(),
        spareReviewed: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      await assertCanMutateAnalysisOutput(
        ctx.db,
        ctx.session,
        input.assessmentId,
      );
      const where = {
        assessmentId: input.assessmentId,
        ...(input.spareReviewed ? { reviewStatus: "DRAFT" as const } : {}),
      };
      const [result] = await ctx.db.$transaction([
        ctx.db.domainScore.deleteMany({ where }),
        ctx.db.auditLog.create({
          data: {
            userId: ctx.session.user.id,
            action: "CLEAR_DOMAIN_SCORES",
            entityType: "Assessment",
            entityId: input.assessmentId,
            details: { spareReviewed: input.spareReviewed },
          },
        }),
      ]);
      return { deletedCount: result.count };
    }),
});
