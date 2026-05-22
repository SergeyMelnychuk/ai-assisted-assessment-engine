import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import { engagementAccessFilter } from "@/server/authz";
import {
  approveDeliverable,
  getDeliverableReviewProgress,
  getSectionReviewHistory,
  performReview,
} from "@/server/services/review-manager";

const REVIEW_ACTIONS = ["APPROVE", "REJECT", "REQUEST_REVISION", "EDIT"] as const;

export const reviewRouter = createRouter({
  /**
   * Unified review action endpoint. APPROVE / REJECT / REQUEST_REVISION
   * just flip section state; EDIT also writes new content + captures
   * contentBefore/contentAfter on the Review audit row.
   *
   * Reviewer role check: any engagement member with REVIEWER or ADMIN
   * global role can approve/reject; ADMIN bypass via the same authz
   * helper we use everywhere else. Assessor-only members can still EDIT
   * and REQUEST_REVISION, but not APPROVE or REJECT — this matches the
   * "expert review" framing in the task spec.
   */
  perform: protectedProcedure
    .input(
      z.object({
        sectionId: z.string().cuid(),
        action: z.enum(REVIEW_ACTIONS),
        comments: z.string().max(4_000).optional(),
        newContent: z.string().max(50_000).optional(),
        newTitle: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Gate: section must belong to a deliverable on an assessment the
      // caller can access.
      const section = await ctx.db.deliverableSection.findFirst({
        where: {
          id: input.sectionId,
          deliverable: {
            assessment: { engagement: engagementAccessFilter(ctx.session) },
          },
        },
        select: { id: true },
      });
      if (!section) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Section not found",
        });
      }

      // Author-only actions (EDIT, REQUEST_REVISION) — no role gate. The
      // reviewer actions (APPROVE, REJECT) require elevated privilege.
      if (input.action === "APPROVE" || input.action === "REJECT") {
        const role = ctx.session.user.role;
        if (role !== "ADMIN" && role !== "REVIEWER") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Only reviewers or admins can approve or reject sections",
          });
        }
      }

      return performReview(ctx.db, {
        sectionId: input.sectionId,
        reviewerId: ctx.session.user.id,
        action: input.action,
        comments: input.comments,
        newContent: input.newContent,
        newTitle: input.newTitle,
      });
    }),

  /**
   * Full review history for a section, newest first. Used by the
   * expandable history panel below each section in the preview.
   */
  historyBySection: protectedProcedure
    .input(z.object({ sectionId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const section = await ctx.db.deliverableSection.findFirst({
        where: {
          id: input.sectionId,
          deliverable: {
            assessment: { engagement: engagementAccessFilter(ctx.session) },
          },
        },
        select: { id: true },
      });
      if (!section) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Section not found",
        });
      }
      return getSectionReviewHistory(ctx.db, section.id);
    }),

  /**
   * Aggregate review state + the list of sections still blocking
   * approval. One endpoint so the dashboard can render from a single
   * query, and the "Approve deliverable" button can disable itself
   * without a separate check.
   */
  deliverableProgress: protectedProcedure
    .input(z.object({ deliverableId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const deliverable = await ctx.db.deliverable.findFirst({
        where: {
          id: input.deliverableId,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: { id: true, status: true },
      });
      if (!deliverable) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Deliverable not found",
        });
      }
      const progress = await getDeliverableReviewProgress(
        ctx.db,
        deliverable.id,
      );
      return { ...progress, deliverableStatus: deliverable.status };
    }),

  /**
   * Export gate — flip `Deliverable.status` to APPROVED, gated on every
   * section being approved. Throws BAD_REQUEST with the exact blocking
   * list otherwise so the UI can show which sections need attention.
   */
  approveDeliverable: protectedProcedure
    .input(z.object({ deliverableId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const deliverable = await ctx.db.deliverable.findFirst({
        where: {
          id: input.deliverableId,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: { id: true },
      });
      if (!deliverable) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Deliverable not found",
        });
      }
      const role = ctx.session.user.role;
      if (role !== "ADMIN" && role !== "REVIEWER") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only reviewers or admins can approve a deliverable for export",
        });
      }
      const updated = await approveDeliverable(ctx.db, deliverable.id);

      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "APPROVE_DELIVERABLE",
          entityType: "Deliverable",
          entityId: updated.id,
          details: { status: updated.status },
        },
      });
      return updated;
    }),
});
