import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import {
  assertAssessmentAccess,
  assertCanMutateAssessment,
  assertEngagementAccess,
  engagementAccessFilter,
} from "@/server/authz";

// Keep enum literals in one place so zod and the DB stay in sync. Prisma
// exports the enum values as well, but importing them here forces the tRPC
// router to depend on `@prisma/client` types at build time — fine, since it
// already does via the db client, and it lets zod reject out-of-range values
// at the edge instead of deferring to the DB constraint.
const ASSESSMENT_MODES = [
  "EXISTING_SYSTEM",
  "GREENFIELD",
  "MODERNIZATION",
  "AUDIT",
  "PRE_IMPLEMENTATION",
] as const;

const ASSESSMENT_STAGES = [
  "SETUP",
  "INTAKE",
  "QUESTIONING",
  "ANALYSIS",
  "DRAFTING",
  "REVIEW",
  "COMPLETED",
] as const;

const BUDGET_SENSITIVITIES = ["LOW", "MEDIUM", "HIGH"] as const;

export const assessmentRouter = createRouter({
  listAssessmentTypes: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.assessmentType.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
    });
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      // Membership is enforced via the parent engagement. `findFirst` with
      // the engagement filter in the `where` clause combines authz + fetch
      // in a single query. Missing → NOT_FOUND (see authz.ts for rationale).
      const assessment = await ctx.db.assessment.findFirst({
        where: {
          id: input.id,
          // Archived assessments are read-locked — the UI must restore
          // first. Same NOT_FOUND response as an inaccessible row so
          // the backend doesn't have to know whether the caller got
          // here by link, bookmark, or id-poke.
          archivedAt: null,
          engagement: engagementAccessFilter(ctx.session),
        },
        include: {
          assessmentType: true,
          projectContext: true,
          documents: { orderBy: { createdAt: "desc" } },
          domainScores: { orderBy: { domain: "asc" } },
          findings: { orderBy: { createdAt: "desc" } },
          risks: { orderBy: { createdAt: "desc" } },
          recommendations: { orderBy: { createdAt: "desc" } },
          assumptions: { orderBy: { createdAt: "desc" } },
          roleProposals: { orderBy: { createdAt: "desc" } },
          estimates: { orderBy: { createdAt: "desc" } },
          deliverables: {
            include: { sections: { orderBy: { orderIndex: "asc" } } },
          },
        },
      });
      if (!assessment) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Assessment not found",
        });
      }
      return assessment;
    }),

  create: protectedProcedure
    .input(
      z.object({
        engagementId: z.string().cuid(),
        assessmentTypeId: z.string().cuid(),
        mode: z.enum(ASSESSMENT_MODES),
        // At least one domain — zero-domain assessments can't drive the
        // analysis engine and would silently produce empty deliverables.
        activeDomains: z.array(z.string().min(1)).min(1).max(32),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertEngagementAccess(ctx.db, ctx.session, input.engagementId);

      // Validate assessment type exists and is active. A bad id would
      // otherwise surface as a raw Prisma foreign-key error.
      const type = await ctx.db.assessmentType.findUnique({
        where: { id: input.assessmentTypeId },
        select: { id: true, isActive: true },
      });
      if (!type || !type.isActive) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid assessment type",
        });
      }

      const assessment = await ctx.db.assessment.create({
        data: {
          engagementId: input.engagementId,
          assessmentTypeId: input.assessmentTypeId,
          mode: input.mode,
          activeDomains: input.activeDomains,
          status: "SETUP",
        },
      });

      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "CREATE",
          entityType: "Assessment",
          entityId: assessment.id,
          details: {
            engagementId: input.engagementId,
            mode: input.mode,
            activeDomains: input.activeDomains,
          },
        },
      });

      return assessment;
    }),

  updateProjectContext: protectedProcedure
    .input(
      z.object({
        assessmentId: z.string().cuid(),
        projectName: z.string().max(200).optional(),
        description: z.string().max(4000).optional(),
        industry: z.string().max(120).optional(),
        cloudProviders: z.array(z.string().min(1)).max(16).optional(),
        platforms: z.array(z.string().min(1)).max(32).optional(),
        knownConstraints: z.string().max(4000).optional(),
        businessGoals: z.string().max(4000).optional(),
        expectedTimeline: z.string().max(200).optional(),
        budgetSensitivity: z.enum(BUDGET_SENSITIVITIES).optional(),
        targetDeliveryModel: z.string().max(200).optional(),
        estimatedUsers: z.string().max(200).optional(),
        complianceRequirements: z.array(z.string().min(1)).max(32).optional(),
        existingTeamSummary: z.string().max(4000).optional(),
        isGreenfield: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { assessmentId, ...data } = input;
      await assertAssessmentAccess(ctx.db, ctx.session, assessmentId);

      return ctx.db.projectContext.upsert({
        where: { assessmentId },
        create: { assessmentId, ...data },
        update: data,
      });
    }),

  /**
   * Soft-archive an assessment. Hides it from default lists but keeps
   * every child row (documents, findings, etc.) intact so restore is a
   * no-data-loss operation. Rejected if the assessment is already
   * archived — idempotency at this level would swallow user confusion
   * ("I clicked archive on an archived row, what happened?").
   */
  archive: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const { engagementId } = await assertCanMutateAssessment(
        ctx.db,
        ctx.session,
        input.id,
      );
      const current = await ctx.db.assessment.findUnique({
        where: { id: input.id },
        select: { archivedAt: true },
      });
      if (current?.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Assessment is already archived",
        });
      }
      const updated = await ctx.db.assessment.update({
        where: { id: input.id },
        data: {
          archivedAt: new Date(),
          archivedById: ctx.session.user.id,
        },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "ARCHIVE",
          entityType: "Assessment",
          entityId: input.id,
          details: { engagementId },
        },
      });
      return updated;
    }),

  /**
   * Restore a previously archived assessment. Clears the archive
   * timestamp and actor so the row becomes active again.
   */
  restore: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const { engagementId } = await assertCanMutateAssessment(
        ctx.db,
        ctx.session,
        input.id,
      );
      const current = await ctx.db.assessment.findUnique({
        where: { id: input.id },
        select: { archivedAt: true },
      });
      if (!current?.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Assessment is not archived",
        });
      }
      const updated = await ctx.db.assessment.update({
        where: { id: input.id },
        data: { archivedAt: null, archivedById: null },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "RESTORE",
          entityType: "Assessment",
          entityId: input.id,
          details: { engagementId },
        },
      });
      return updated;
    }),

  /**
   * Hard-delete an assessment and cascade through every child table
   * (documents, findings, risks, recommendations, scores, deliverables,
   * etc.) via the `onDelete: Cascade` relations defined in the schema.
   *
   * Two-step rule: the assessment MUST already be archived. This forces
   * the user through an explicit "I meant to remove this" beat before
   * we drop rows that can't be recovered without a database restore.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const { engagementId } = await assertCanMutateAssessment(
        ctx.db,
        ctx.session,
        input.id,
      );
      const current = await ctx.db.assessment.findUnique({
        where: { id: input.id },
        select: { archivedAt: true },
      });
      if (!current) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Assessment not found",
        });
      }
      if (!current.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Archive the assessment before deleting it",
        });
      }
      await ctx.db.assessment.delete({ where: { id: input.id } });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "DELETE",
          entityType: "Assessment",
          entityId: input.id,
          details: { engagementId },
        },
      });
      return { id: input.id, engagementId };
    }),

  updateStatus: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        status: z.enum(ASSESSMENT_STAGES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Lifecycle moves are an OWNER/ADMIN concern, same gate as the
      // engagement-level status. assertCanMutateAssessment opts in to
      // archived rows for archive/restore/delete; we need the opposite
      // here — status edits on a read-locked row would be a footgun —
      // so we re-check archive state after the authz pass.
      const { engagementId } = await assertCanMutateAssessment(
        ctx.db,
        ctx.session,
        input.id,
      );
      const prior = await ctx.db.assessment.findUnique({
        where: { id: input.id },
        select: { status: true, archivedAt: true },
      });
      if (!prior) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Assessment not found",
        });
      }
      if (prior.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Restore the assessment before changing its status",
        });
      }
      // No-op transitions skip the write + audit row entirely; the
      // mutation still resolves so the client can keep its optimistic
      // state without a refetch.
      if (prior.status === input.status) {
        return ctx.db.assessment.findUniqueOrThrow({
          where: { id: input.id },
        });
      }
      const updated = await ctx.db.assessment.update({
        where: { id: input.id },
        data: { status: input.status },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "UPDATE",
          entityType: "Assessment",
          entityId: input.id,
          details: {
            engagementId,
            field: "status",
            from: prior.status,
            to: input.status,
          },
        },
      });
      return updated;
    }),

  /**
   * UI-only probe: returns `true` when the caller can edit lifecycle
   * fields (status today; future fields land here too). Mirrors
   * `engagement.canMutate` and lets the assessment page render a
   * read-only badge vs an editable dropdown without provoking a
   * server rejection.
   */
  canMutate: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const { session, db } = ctx;
      // ADMIN bypass — but the row must still exist and be unarchived,
      // otherwise the dropdown would offer to edit a 404 surface.
      if (session.user.role === "ADMIN") {
        const visible = await db.assessment.count({
          where: { id: input.id, archivedAt: null },
        });
        return visible > 0;
      }
      const ownerMembership = await db.engagementMember.findFirst({
        where: {
          userId: session.user.id,
          role: "OWNER",
          engagement: {
            assessments: { some: { id: input.id, archivedAt: null } },
          },
        },
        select: { id: true },
      });
      return ownerMembership !== null;
    }),
});
