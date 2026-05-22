import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import {
  assertAssessmentAccess,
  engagementAccessFilter,
} from "@/server/authz";
import { enqueueGenerateDeliverable } from "@/server/queue/queue";
import { regenerateDiagram } from "@/server/services/deliverable-generator";

const DELIVERABLE_TYPES = [
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
] as const;

const REVIEW_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "NEEDS_REVISION",
] as const;

const DELIVERABLE_STATUSES = [
  "GENERATING",
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "EXPORTED",
] as const;

export const deliverableRouter = createRouter({
  /**
   * Is a deliverable generation currently in flight? Same audit-log
   * lifecycle pattern as analysis.runStatus / estimation.runStatus —
   * the most-recent ENQUEUE_DELIVERABLE row + no terminal row since.
   * `cancelRequested: true` while a soft cancel is pending so the
   * banner can show "Cancelling…".
   */
  runStatus: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const lastEnqueue = await ctx.db.auditLog.findFirst({
        where: {
          entityType: "Assessment",
          entityId: input.assessmentId,
          action: "ENQUEUE_DELIVERABLE",
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
              "GENERATE_DELIVERABLE",
              "GENERATE_DELIVERABLE_FAILED",
              "GENERATE_DELIVERABLE_CANCELLED",
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
          action: "CANCEL_DELIVERABLE_REQUESTED",
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
   * Soft cancel — writes a `CANCEL_DELIVERABLE_REQUESTED` audit row.
   * The worker checks before its first AI call and exits cleanly with
   * `GENERATE_DELIVERABLE_CANCELLED` if the row exists.
   */
  cancel: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "CANCEL_DELIVERABLE_REQUESTED",
          entityType: "Assessment",
          entityId: input.assessmentId,
          details: {},
        },
      });
      return { ok: true };
    }),

  /**
   * Enqueue a deliverable generation run. Returns the job id so the UI
   * can show a "queued" pill until the DB reflects the result.
   */
  generate: protectedProcedure
    .input(
      z.object({
        assessmentId: z.string().cuid(),
        deliverableType: z.enum(DELIVERABLE_TYPES).default("ASSESSMENT_REPORT"),
        templateId: z.string().cuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const jobId = await enqueueGenerateDeliverable(
        input.assessmentId,
        input.deliverableType,
        input.templateId,
      );
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "ENQUEUE_DELIVERABLE",
          entityType: "Assessment",
          entityId: input.assessmentId,
          details: {
            jobId,
            deliverableType: input.deliverableType,
            templateId: input.templateId ?? null,
          },
        },
      });
      return { jobId };
    }),

  /**
   * List every deliverable for an assessment — used for a left-rail
   * selector on the deliverables page.
   */
  listByAssessment: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      return ctx.db.deliverable.findMany({
        where: { assessmentId: input.assessmentId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          deliverableType: true,
          status: true,
          templateId: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { sections: true, diagrams: true } },
        },
      });
    }),

  /**
   * Full deliverable with ordered sections + all linked diagrams. Main
   * data feed for the preview/editor UI.
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const deliverable = await ctx.db.deliverable.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        include: {
          sections: { orderBy: { orderIndex: "asc" } },
          diagrams: { orderBy: { createdAt: "asc" } },
        },
      });
      if (!deliverable) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Deliverable not found",
        });
      }
      return deliverable;
    }),

  /**
   * Edit one section. `contentFinal` is the reviewer's published version
   * — once set the preview prefers it over the AI draft. We also auto-
   * lock the section's reviewStatus on any content edit.
   */
  updateSection: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        title: z.string().min(1).max(500).optional(),
        contentFinal: z.string().max(50_000).optional(),
        contentDraft: z.string().max(50_000).optional(),
        reviewStatus: z.enum(REVIEW_STATUSES).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.deliverableSection.findFirst({
        where: {
          id: input.id,
          deliverable: {
            assessment: { engagement: engagementAccessFilter(ctx.session) },
          },
        },
        select: { id: true, reviewStatus: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Section not found",
        });
      }
      const { id, ...data } = input;
      const isContentEdit =
        data.title !== undefined ||
        data.contentDraft !== undefined ||
        data.contentFinal !== undefined;
      if (
        isContentEdit &&
        data.reviewStatus === undefined &&
        existing.reviewStatus === "DRAFT"
      ) {
        data.reviewStatus = "IN_REVIEW";
      }
      // Any edit to contentFinal also stamps reviewedBy/At so the export
      // step can later enforce "must be approved by X".
      const update: Record<string, unknown> = { ...data };
      if (data.contentFinal !== undefined) {
        update.reviewedById = ctx.session.user.id;
        update.reviewedAt = new Date();
      }
      return ctx.db.deliverableSection.update({
        where: { id },
        data: update,
      });
    }),

  /**
   * Change the overall deliverable status (GENERATING → DRAFT → IN_REVIEW
   * → APPROVED → EXPORTED). We let the UI drive these transitions for
   * MVP; Task 12 will add guard rails ("can't APPROVE until all sections
   * approved").
   */
  updateStatus: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        status: z.enum(DELIVERABLE_STATUSES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.deliverable.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: { id: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Deliverable not found",
        });
      }
      return ctx.db.deliverable.update({
        where: { id: existing.id },
        data: { status: input.status },
      });
    }),

  /**
   * Regenerate a diagram's Mermaid source, optionally with reviewer
   * feedback ("add the Redis cache", "make this more detailed"). Only
   * GENERATED diagrams are eligible — INGESTED diagrams come from user
   * uploads and shouldn't be replaced silently.
   */
  regenerateDiagram: protectedProcedure
    .input(
      z.object({
        diagramId: z.string().cuid(),
        feedback: z.string().max(2_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const diagram = await ctx.db.diagram.findFirst({
        where: {
          id: input.diagramId,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: { id: true, direction: true },
      });
      if (!diagram) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Diagram not found",
        });
      }
      if (diagram.direction !== "GENERATED") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only generated diagrams can be regenerated",
        });
      }
      return regenerateDiagram(ctx.db, diagram.id, input.feedback);
    }),

  /**
   * Hand-edit a generated diagram's source code. Auto-flips processing
   * status to PROCESSED so the UI doesn't spinner forever on a manual
   * save.
   */
  updateDiagramSource: protectedProcedure
    .input(
      z.object({
        diagramId: z.string().cuid(),
        sourceCode: z.string().min(1).max(50_000),
        title: z.string().min(1).max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const diagram = await ctx.db.diagram.findFirst({
        where: {
          id: input.diagramId,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: { id: true },
      });
      if (!diagram) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Diagram not found",
        });
      }
      return ctx.db.diagram.update({
        where: { id: diagram.id },
        data: {
          sourceCode: input.sourceCode,
          title: input.title ?? undefined,
          processingStatus: "PROCESSED",
        },
      });
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.deliverable.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: { id: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Deliverable not found",
        });
      }
      await ctx.db.deliverable.delete({ where: { id: existing.id } });
      return { success: true };
    }),
});
