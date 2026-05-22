import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import {
  assertAssessmentAccess,
  engagementAccessFilter,
} from "@/server/authz";
import { enqueueRunEstimation } from "@/server/queue/queue";

const REVIEW_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "NEEDS_REVISION",
] as const;

const SENIORITIES = ["JUNIOR", "MID", "SENIOR", "LEAD", "PRINCIPAL"] as const;

export const estimationRouter = createRouter({
  /**
   * Is an estimation run currently in flight? Same audit-log-based
   * detection as `analysis.runStatus` so the UI logic stays
   * symmetric. Returns `cancelRequested: true` when the user has
   * already filed a cancel for this run — drives the
   * "Cancelling…" disabled state on the cancel button.
   */
  runStatus: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const lastEnqueue = await ctx.db.auditLog.findFirst({
        where: {
          entityType: "Assessment",
          entityId: input.assessmentId,
          action: "ENQUEUE_ESTIMATION",
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (!lastEnqueue) {
        return { inFlight: false, cancelRequested: false };
      }
      const terminal = await ctx.db.auditLog.findFirst({
        where: {
          entityType: "Assessment",
          entityId: input.assessmentId,
          action: {
            in: [
              "RUN_ESTIMATION",
              "RUN_ESTIMATION_FAILED",
              "RUN_ESTIMATION_CANCELLED",
            ],
          },
          createdAt: { gte: lastEnqueue.createdAt },
        },
        select: { id: true },
      });
      if (terminal) {
        return { inFlight: false, cancelRequested: false };
      }
      const cancel = await ctx.db.auditLog.findFirst({
        where: {
          entityType: "Assessment",
          entityId: input.assessmentId,
          action: "CANCEL_ESTIMATION_REQUESTED",
          createdAt: { gte: lastEnqueue.createdAt },
        },
        select: { id: true },
      });
      return {
        inFlight: true,
        cancelRequested: cancel !== null,
        enqueuedAt: lastEnqueue.createdAt,
      };
    }),

  /**
   * Soft cancel — writes a `CANCEL_ESTIMATION_REQUESTED` audit row.
   * The worker checks before its Claude call and exits cleanly with
   * `RUN_ESTIMATION_CANCELLED` if the row exists. If the cancel
   * lands AFTER the Claude call started, it's effectively a no-op
   * (the call runs to completion); for a ~30s call that's the
   * accepted trade-off.
   */
  cancel: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "CANCEL_ESTIMATION_REQUESTED",
          entityType: "Assessment",
          entityId: input.assessmentId,
          details: {},
        },
      });
      return { ok: true };
    }),

  /**
   * Fire the background team+estimate job. Same shape as analysis.run.
   */
  run: protectedProcedure
    .input(
      z.object({
        assessmentId: z.string().cuid(),
        templateId: z.string().cuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const jobId = await enqueueRunEstimation(
        input.assessmentId,
        input.templateId,
      );
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "ENQUEUE_ESTIMATION",
          entityType: "Assessment",
          entityId: input.assessmentId,
          details: { jobId, templateId: input.templateId ?? null },
        },
      });
      return { jobId };
    }),

  listProposals: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      return ctx.db.roleProposal.findMany({
        where: { assessmentId: input.assessmentId },
        orderBy: [{ roleName: "asc" }, { seniority: "asc" }],
      });
    }),

  /**
   * Return the most recent Estimate for an assessment along with the
   * associated rate card (so the UI can render per-role rate breakdowns
   * without a second round trip).
   */
  getLatestEstimate: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      return ctx.db.estimate.findFirst({
        where: { assessmentId: input.assessmentId },
        orderBy: { createdAt: "desc" },
        include: {
          rateCard: {
            select: { id: true, name: true, currency: true },
          },
        },
      });
    }),

  /**
   * Inline edits on a role proposal. Same auto-lock pattern as scoring —
   * any content edit on a DRAFT row auto-flips it to IN_REVIEW so the
   * next estimation run doesn't clobber the reviewer's change.
   */
  updateProposal: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        roleName: z.string().min(1).max(120).optional(),
        seniority: z.enum(SENIORITIES).optional(),
        count: z.number().int().min(1).max(50).optional(),
        justification: z.string().max(4000).optional(),
        responsibilities: z.string().max(4000).optional(),
        phase: z.string().max(80).nullable().optional(),
        expertiseRequired: z.array(z.string().max(80)).max(16).optional(),
        reviewStatus: z.enum(REVIEW_STATUSES).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.roleProposal.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: { id: true, reviewStatus: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Role proposal not found",
        });
      }

      const { id, ...data } = input;
      const contentKeys: Array<keyof typeof data> = [
        "roleName",
        "seniority",
        "count",
        "justification",
        "responsibilities",
        "phase",
        "expertiseRequired",
      ];
      const isContentEdit = contentKeys.some((k) => data[k] !== undefined);
      if (
        isContentEdit &&
        data.reviewStatus === undefined &&
        existing.reviewStatus === "DRAFT"
      ) {
        data.reviewStatus = "IN_REVIEW";
      }
      return ctx.db.roleProposal.update({ where: { id }, data });
    }),

  deleteProposal: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.roleProposal.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: { id: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Role proposal not found",
        });
      }
      await ctx.db.roleProposal.delete({ where: { id: existing.id } });
      return { success: true };
    }),

  /**
   * Edit the Estimate row itself — scenario name, assumptions, totals
   * (if the reviewer wants to override the AI's math), review status.
   */
  updateEstimate: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        scenarioName: z.string().max(120).optional(),
        assumptions: z.string().max(4000).optional(),
        totalEffortHoursLow: z.number().int().min(0).optional(),
        totalEffortHoursHigh: z.number().int().min(0).optional(),
        totalCostLow: z.number().min(0).optional(),
        totalCostHigh: z.number().min(0).optional(),
        reviewStatus: z.enum(REVIEW_STATUSES).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.estimate.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: { id: true, reviewStatus: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Estimate not found",
        });
      }

      const { id, totalCostLow, totalCostHigh, ...rest } = input;
      // Convert number → Decimal for the money columns — Prisma rejects
      // raw JS numbers on Decimal fields.
      const data: Record<string, unknown> = { ...rest };
      if (totalCostLow !== undefined) data.totalCostLow = totalCostLow.toFixed(2);
      if (totalCostHigh !== undefined) data.totalCostHigh = totalCostHigh.toFixed(2);

      const contentKeys = [
        "scenarioName",
        "assumptions",
        "totalEffortHoursLow",
        "totalEffortHoursHigh",
        "totalCostLow",
        "totalCostHigh",
      ] as const;
      const isContentEdit = contentKeys.some(
        (k) => (input as Record<string, unknown>)[k] !== undefined,
      );
      if (
        isContentEdit &&
        data.reviewStatus === undefined &&
        existing.reviewStatus === "DRAFT"
      ) {
        data.reviewStatus = "IN_REVIEW";
      }
      return ctx.db.estimate.update({ where: { id }, data });
    }),
});
