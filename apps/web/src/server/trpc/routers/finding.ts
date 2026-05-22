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

const FINDING_TYPES = [
  "STRENGTH",
  "WEAKNESS",
  "GAP",
  "OBSERVATION",
  "OPPORTUNITY",
] as const;

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;

export const findingRouter = createRouter({
  listByAssessment: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      return ctx.db.finding.findMany({
        where: { assessmentId: input.assessmentId },
        orderBy: [
          { severity: "asc" }, // CRITICAL < HIGH (alphabetical order happens to work here)
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
        findingType: z.enum(FINDING_TYPES).optional(),
        severity: z.enum(SEVERITIES).optional(),
        reviewStatus: z.enum(REVIEW_STATUSES).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Fetch + authz-gate via parent assessment/engagement.
      const f = await ctx.db.finding.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: { id: true },
      });
      if (!f) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Finding not found" });
      }
      const { id, ...data } = input;
      return ctx.db.finding.update({ where: { id }, data });
    }),

  /**
   * Hard delete. Gated to engagement OWNER or global ADMIN (see
   * `assertCanMutateAnalysisOutput`). Writes a `DELETE_FINDING` audit
   * row with the full pre-delete snapshot under `details`, so the
   * audit log is the recovery path — no schema-level tombstone.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      // Read-access check first (so non-members get NOT_FOUND, not
      // FORBIDDEN — avoids existence-oracle leak).
      const f = await ctx.db.finding.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
      });
      if (!f) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Finding not found" });
      }
      // Then the OWNER/ADMIN gate — may throw FORBIDDEN.
      await assertCanMutateAnalysisOutput(
        ctx.db,
        ctx.session,
        f.assessmentId,
      );
      await ctx.db.$transaction([
        ctx.db.finding.delete({ where: { id: f.id } }),
        ctx.db.auditLog.create({
          data: {
            userId: ctx.session.user.id,
            action: "DELETE_FINDING",
            entityType: "Assessment",
            entityId: f.assessmentId,
            details: {
              findingId: f.id,
              snapshot: f,
            },
          },
        }),
      ]);
      return { success: true };
    }),

  /**
   * Bulk-delete every finding on an assessment. OWNER/ADMIN-gated.
   * When `spareReviewed` is true, only rows with `reviewStatus = DRAFT`
   * are removed — anything a reviewer has touched (IN_REVIEW, APPROVED,
   * REJECTED, NEEDS_REVISION) survives. Defaults to `false` (wipe all).
   *
   * Writes a single `CLEAR_FINDINGS` audit row with the deleted count
   * and the opt-in flag. We intentionally don't snapshot the full rows
   * — bulk clears can touch hundreds of entries and the per-row
   * DELETE_FINDING path remains available for individual recovery.
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
        ctx.db.finding.deleteMany({ where }),
        ctx.db.auditLog.create({
          data: {
            userId: ctx.session.user.id,
            action: "CLEAR_FINDINGS",
            entityType: "Assessment",
            entityId: input.assessmentId,
            details: {
              spareReviewed: input.spareReviewed,
            },
          },
        }),
      ]);
      return { deletedCount: result.count };
    }),
});
