import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import {
  assertCanMutateEngagement,
  canMutateEngagement,
  engagementAccessFilter,
} from "@/server/authz";
import { deleteObject } from "@/server/storage/minio";

export const engagementRouter = createRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.engagement.findMany({
      where: engagementAccessFilter(ctx.session),
      orderBy: { createdAt: "desc" },
      include: {
        // Archived assessments stay hidden from the dashboard; the detail
        // page has the "Show archived" toggle when the user needs them.
        assessments: {
          where: { archivedAt: null },
          select: { id: true, status: true, mode: true },
        },
        _count: {
          select: { assessments: { where: { archivedAt: null } } },
        },
      },
    });
  }),

  getById: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        // Opt-in — the detail page flips this when the user toggles
        // "Show archived" so archived rows can be listed (and restored
        // or deleted) without polluting the default view.
        includeArchived: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Single query that enforces authorization *and* fetches the data. If
      // the user isn't a member (and isn't ADMIN), `findFirst` returns null
      // — we map that to NOT_FOUND rather than FORBIDDEN to avoid leaking
      // the existence of engagements the caller shouldn't know about.
      const engagement = await ctx.db.engagement.findFirst({
        where: {
          id: input.id,
          ...engagementAccessFilter(ctx.session),
        },
        include: {
          assessments: {
            where: input.includeArchived ? undefined : { archivedAt: null },
            include: {
              assessmentType: true,
              projectContext: true,
            },
            orderBy: [{ archivedAt: "asc" }, { createdAt: "desc" }],
          },
          members: {
            include: {
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
      });
      if (!engagement) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Engagement not found",
        });
      }
      return engagement;
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        clientName: z.string().min(1).max(200),
        industry: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const engagement = await ctx.db.engagement.create({
        data: {
          name: input.name,
          clientName: input.clientName,
          industry: input.industry,
          status: "ACTIVE",
          members: {
            create: {
              userId: ctx.session.user.id,
              role: "OWNER",
            },
          },
        },
      });

      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "CREATE",
          entityType: "Engagement",
          entityId: engagement.id,
          details: { name: input.name, clientName: input.clientName },
        },
      });

      return engagement;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        clientName: z.string().min(1).max(200).optional(),
        industry: z.string().optional(),
        status: z.enum(["DRAFT", "ACTIVE", "COMPLETED", "ARCHIVED"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      // Authz: OWNER or ADMIN only (mirrors analysis-output mutation gate).
      await assertCanMutateEngagement(ctx.db, ctx.session, id);

      // If status is part of the update, capture the prior value so we
      // can write a meaningful audit row and skip no-op transitions.
      let priorStatus: string | null = null;
      if (data.status) {
        const prior = await ctx.db.engagement.findUnique({
          where: { id },
          select: { status: true },
        });
        priorStatus = prior?.status ?? null;
      }

      const updated = await ctx.db.engagement.update({
        where: { id },
        data,
      });

      if (data.status && priorStatus && priorStatus !== data.status) {
        await ctx.db.auditLog.create({
          data: {
            userId: ctx.session.user.id,
            action: "UPDATE",
            entityType: "Engagement",
            entityId: id,
            details: {
              field: "status",
              from: priorStatus,
              to: data.status,
            },
          },
        });
      }

      return updated;
    }),

  /**
   * Hard-delete an engagement. ADMIN-only; refuses unless the
   * engagement is already in `ARCHIVED` status.
   *
   * Two cleanup passes:
   *
   * 1. **Postgres cascade.** Schema FKs (`onDelete: Cascade`) take
   *    out every dependent row — EngagementMembers, Assessments and
   *    *everything* hanging off them (Documents, Evidence, Diagrams,
   *    Findings, Risks, Recommendations, Scoring, Reviews,
   *    RoleProposals, Estimates, Deliverables, DeliverableSections,
   *    Questions, Answers, RepositoryLinks, AgentRuns + Steps +
   *    CredentialRequests, etc.), plus the engagement-scoped
   *    Templates, TemplateFills, AgentRuns and AgentCredentials.
   *
   * 2. **MinIO cleanup.** Before the SQL delete, we collect every
   *    object key the engagement owns — uploaded documents, rendered
   *    diagram images, customer-uploaded templates, populated
   *    template fills — and best-effort delete them after the DB
   *    transaction commits. Failures here are logged in the audit
   *    row but never roll back the delete: the DB state is the
   *    source of truth, an orphan blob is annoying but not a
   *    correctness failure (same convention as
   *    `repositoryLink.delete`).
   *
   * Audit row captures the counts so an operator can confirm the
   * scope of what was reclaimed.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.session.user.role !== "ADMIN") {
        // NOT_FOUND, not FORBIDDEN, to avoid leaking existence of the
        // route to anyone probing for admin endpoints (same pattern as
        // `assertAdmin` in admin-settings).
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      const row = await ctx.db.engagement.findUnique({
        where: { id: input.id },
        select: { id: true, status: true, name: true, clientName: true },
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      if (row.status !== "ARCHIVED") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Archive the engagement before deleting it. Set status to ARCHIVED first.",
        });
      }

      // ── Collect every storage key this engagement owns ───────────
      // Done BEFORE the cascade-delete, while the rows still exist.
      // We pull keys via `findMany` rather than `$queryRaw` so the
      // Prisma client handles the FK joins and we can't accidentally
      // pick up another engagement's keys.
      const [docs, diagrams, templates, fillDocs] = await Promise.all([
        ctx.db.document.findMany({
          where: { assessment: { engagementId: input.id } },
          select: { id: true, storagePath: true },
        }),
        ctx.db.diagram.findMany({
          where: {
            assessment: { engagementId: input.id },
            imageStoragePath: { not: null },
          },
          select: { id: true, imageStoragePath: true },
        }),
        ctx.db.template.findMany({
          where: { engagementId: input.id },
          select: { id: true, storagePath: true },
        }),
        // TemplateFill.outputDocument is the populated file we wrote
        // back to MinIO under the same Document storage namespace.
        // The underlying Document row is already covered by `docs`
        // above (it lives on the assessment); the explicit join here
        // is belt-and-braces so a future change that decouples fills
        // from Documents still cleans up.
        ctx.db.templateFill.findMany({
          where: { assessment: { engagementId: input.id } },
          select: {
            id: true,
            outputDocument: { select: { storagePath: true } },
          },
        }),
      ]);

      const storageKeys = new Set<string>();
      for (const d of docs) {
        if (d.storagePath && d.storagePath !== "pending") {
          storageKeys.add(d.storagePath);
        }
      }
      for (const d of diagrams) {
        if (d.imageStoragePath) storageKeys.add(d.imageStoragePath);
      }
      for (const t of templates) {
        if (t.storagePath && t.storagePath !== "pending") {
          storageKeys.add(t.storagePath);
        }
      }
      for (const f of fillDocs) {
        const p = f.outputDocument?.storagePath;
        if (p && p !== "pending") storageKeys.add(p);
      }

      // ── Cascade-delete via Postgres FKs ─────────────────────────
      await ctx.db.engagement.delete({ where: { id: input.id } });

      // ── Best-effort MinIO sweep ─────────────────────────────────
      // `allSettled` so one failed delete doesn't abort the rest.
      let deletedBlobs = 0;
      let failedBlobs = 0;
      const failures: string[] = [];
      const results = await Promise.allSettled(
        Array.from(storageKeys).map((key) => deleteObject(key)),
      );
      for (let i = 0; i < results.length; i += 1) {
        const r = results[i];
        if (r.status === "fulfilled") {
          deletedBlobs += 1;
        } else {
          failedBlobs += 1;
          if (failures.length < 5) {
            const key = Array.from(storageKeys)[i];
            const msg =
              r.reason instanceof Error ? r.reason.message : String(r.reason);
            failures.push(`${key}: ${msg}`);
          }
        }
      }

      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "DELETE",
          entityType: "Engagement",
          // The row is gone — record the id we deleted in `details`
          // too so the audit row stands on its own.
          entityId: input.id,
          details: {
            id: input.id,
            name: row.name,
            clientName: row.clientName,
            priorStatus: row.status,
            counts: {
              documents: docs.length,
              diagrams: diagrams.length,
              templates: templates.length,
              templateFills: fillDocs.length,
              storageBlobsAttempted: storageKeys.size,
              storageBlobsDeleted: deletedBlobs,
              storageBlobsFailed: failedBlobs,
            },
            blobFailures: failures,
          },
        },
      });
      return {
        ok: true,
        deletedBlobs,
        failedBlobs,
        totalBlobs: storageKeys.size,
      };
    }),

  /**
   * UI-only probe: returns `true` when the caller can rename / change
   * status on this engagement. Keeps the detail page from rendering a
   * dropdown the server would immediately reject.
   */
  canMutate: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      return canMutateEngagement(ctx.db, ctx.session, input.id);
    }),

  /**
   * Lightweight user search for the team-member picker. Matches name
   * or email substring (case-insensitive). Excludes users already on
   * the engagement so the UI doesn't offer redundant rows.
   *
   * Authz: OWNER/ADMIN only — same gate as adding members. Returning
   * the user list to anyone with access would leak the directory.
   */
  searchAddableMembers: protectedProcedure
    .input(
      z.object({
        engagementId: z.string().cuid(),
        query: z.string().trim().max(100).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertCanMutateEngagement(ctx.db, ctx.session, input.engagementId);
      const existing = await ctx.db.engagementMember.findMany({
        where: { engagementId: input.engagementId },
        select: { userId: true },
      });
      const existingIds = existing.map((m) => m.userId);
      const q = input.query?.trim();
      const where = {
        id: { notIn: existingIds.length ? existingIds : ["__none__"] },
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" as const } },
                { email: { contains: q, mode: "insensitive" as const } },
              ],
            }
          : {}),
      };
      return ctx.db.user.findMany({
        where,
        select: { id: true, name: true, email: true, role: true },
        orderBy: [{ name: "asc" }, { email: "asc" }],
        take: 20,
      });
    }),

  /**
   * Add a user to the engagement. OWNER/ADMIN only. Defaults the new
   * member to CONTRIBUTOR; the caller can override via `role`.
   */
  addMember: protectedProcedure
    .input(
      z.object({
        engagementId: z.string().cuid(),
        userId: z.string().cuid(),
        role: z
          .enum(["OWNER", "CONTRIBUTOR", "REVIEWER", "VIEWER"])
          .default("CONTRIBUTOR"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertCanMutateEngagement(ctx.db, ctx.session, input.engagementId);
      // Idempotent: if the user is already on the engagement, no-op.
      const existing = await ctx.db.engagementMember.findUnique({
        where: {
          engagementId_userId: {
            engagementId: input.engagementId,
            userId: input.userId,
          },
        },
        select: { id: true, role: true },
      });
      if (existing) {
        return { ok: true, alreadyMember: true };
      }
      await ctx.db.engagementMember.create({
        data: {
          engagementId: input.engagementId,
          userId: input.userId,
          role: input.role,
        },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "ENGAGEMENT_MEMBER_ADDED",
          entityType: "Engagement",
          entityId: input.engagementId,
          details: { userId: input.userId, role: input.role },
        },
      });
      return { ok: true, alreadyMember: false };
    }),

  /**
   * Change a member's role. OWNER/ADMIN only. Refuses to demote the
   * last OWNER — every engagement keeps at least one owner who can
   * still manage membership.
   */
  updateMemberRole: protectedProcedure
    .input(
      z.object({
        engagementId: z.string().cuid(),
        userId: z.string().cuid(),
        role: z.enum(["OWNER", "CONTRIBUTOR", "REVIEWER", "VIEWER"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertCanMutateEngagement(ctx.db, ctx.session, input.engagementId);
      const target = await ctx.db.engagementMember.findUnique({
        where: {
          engagementId_userId: {
            engagementId: input.engagementId,
            userId: input.userId,
          },
        },
        select: { role: true },
      });
      if (!target) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User is not a member of this engagement",
        });
      }
      if (target.role === "OWNER" && input.role !== "OWNER") {
        const ownerCount = await ctx.db.engagementMember.count({
          where: { engagementId: input.engagementId, role: "OWNER" },
        });
        if (ownerCount <= 1) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot demote the last owner. Promote another member first.",
          });
        }
      }
      await ctx.db.engagementMember.update({
        where: {
          engagementId_userId: {
            engagementId: input.engagementId,
            userId: input.userId,
          },
        },
        data: { role: input.role },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "ENGAGEMENT_MEMBER_ROLE_CHANGED",
          entityType: "Engagement",
          entityId: input.engagementId,
          details: {
            userId: input.userId,
            from: target.role,
            to: input.role,
          },
        },
      });
      return { ok: true };
    }),

  /**
   * Remove a user from the engagement. OWNER/ADMIN only. Same
   * last-owner guard as `updateMemberRole`.
   */
  removeMember: protectedProcedure
    .input(
      z.object({
        engagementId: z.string().cuid(),
        userId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertCanMutateEngagement(ctx.db, ctx.session, input.engagementId);
      const target = await ctx.db.engagementMember.findUnique({
        where: {
          engagementId_userId: {
            engagementId: input.engagementId,
            userId: input.userId,
          },
        },
        select: { role: true },
      });
      if (!target) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User is not a member of this engagement",
        });
      }
      if (target.role === "OWNER") {
        const ownerCount = await ctx.db.engagementMember.count({
          where: { engagementId: input.engagementId, role: "OWNER" },
        });
        if (ownerCount <= 1) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot remove the last owner. Promote another member first.",
          });
        }
      }
      await ctx.db.engagementMember.delete({
        where: {
          engagementId_userId: {
            engagementId: input.engagementId,
            userId: input.userId,
          },
        },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "ENGAGEMENT_MEMBER_REMOVED",
          entityType: "Engagement",
          entityId: input.engagementId,
          details: { userId: input.userId, role: target.role },
        },
      });
      return { ok: true };
    }),
});
