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

const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

export const recommendationRouter = createRouter({
  listByAssessment: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      return ctx.db.recommendation.findMany({
        where: { assessmentId: input.assessmentId },
        orderBy: [
          { priority: "asc" },
          { domain: "asc" },
          { createdAt: "desc" },
        ],
      });
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        title: z.string().min(1).max(500).optional(),
        description: z.string().min(1).max(8000).optional(),
        priority: z.enum(PRIORITIES).optional(),
        effortIndication: z.string().max(200).optional(),
        reviewStatus: z.enum(REVIEW_STATUSES).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const r = await ctx.db.recommendation.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: { id: true },
      });
      if (!r) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Recommendation not found",
        });
      }
      const { id, ...data } = input;
      return ctx.db.recommendation.update({ where: { id }, data });
    }),

  /** Hard delete; OWNER/ADMIN-gated; audited. See finding.delete. */
  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const r = await ctx.db.recommendation.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
      });
      if (!r) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Recommendation not found",
        });
      }
      await assertCanMutateAnalysisOutput(
        ctx.db,
        ctx.session,
        r.assessmentId,
      );
      await ctx.db.$transaction([
        ctx.db.recommendation.delete({ where: { id: r.id } }),
        ctx.db.auditLog.create({
          data: {
            userId: ctx.session.user.id,
            action: "DELETE_RECOMMENDATION",
            entityType: "Assessment",
            entityId: r.assessmentId,
            details: { recommendationId: r.id, snapshot: r },
          },
        }),
      ]);
      return { success: true };
    }),

  /** Bulk-delete; OWNER/ADMIN-gated. See `finding.clearAll`. */
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
        ctx.db.recommendation.deleteMany({ where }),
        ctx.db.auditLog.create({
          data: {
            userId: ctx.session.user.id,
            action: "CLEAR_RECOMMENDATIONS",
            entityType: "Assessment",
            entityId: input.assessmentId,
            details: { spareReviewed: input.spareReviewed },
          },
        }),
      ]);
      return { deletedCount: result.count };
    }),
});
