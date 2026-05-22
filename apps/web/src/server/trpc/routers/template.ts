import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma, TemplateKind, TemplateStatus } from "@prisma/client";
import { createRouter, protectedProcedure } from "../trpc";
import { engagementAccessFilter } from "@/server/authz";
import { bindingDocumentSchema } from "@/server/services/template/binding";
import { enqueueProposeTemplateBinding } from "@/server/queue/queue";

/**
 * Templates router — list, approve, deprecate, archive, delete,
 * binding edit. Upload itself goes through `/api/templates/upload`
 * because tRPC isn't great at multipart bodies.
 *
 * Visibility model:
 *   - workspace defaults: `engagementId = null`. Listed for every
 *     authenticated user.
 *   - per-engagement: `engagementId` set. Listed only for users with
 *     access to that engagement (via `engagementAccessFilter`).
 *
 * Mutations are OWNER/ADMIN gated for engagement-scoped templates;
 * workspace defaults can only be touched by ADMIN.
 */
export const templateRouter = createRouter({
  list: protectedProcedure
    .input(
      z.object({
        engagementId: z.string().cuid().optional(),
        kind: z.nativeEnum(TemplateKind).optional(),
        includeArchived: z.boolean().optional(),
        includeDeprecated: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // If an engagementId is supplied, gate on access. Workspace
      // defaults (engagementId=null in the row) come back regardless.
      if (input.engagementId) {
        const eng = await ctx.db.engagement.findFirst({
          where: {
            id: input.engagementId,
            ...engagementAccessFilter(ctx.session),
          },
          select: { id: true },
        });
        if (!eng) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Engagement not found",
          });
        }
      }
      const rows = await ctx.db.template.findMany({
        where: {
          // Surface both: workspace defaults (engagementId null) AND
          // any per-engagement overrides.
          OR: [
            { engagementId: null },
            input.engagementId
              ? { engagementId: input.engagementId }
              : { id: "__none__" }, // when no engagementId supplied
          ],
          kind: input.kind,
          ...(input.includeArchived ? {} : { archivedAt: null }),
          ...(input.includeDeprecated
            ? {}
            : {
                NOT: { status: TemplateStatus.DEPRECATED },
              }),
        },
        orderBy: [{ kind: "asc" }, { createdAt: "desc" }],
        include: {
          uploader: { select: { name: true, email: true } },
          approver: { select: { name: true, email: true } },
        },
      });
      // Derive a per-row `bindingStatus` so the UI can distinguish
      // "AI is still mapping" from "proposer crashed — offer retry".
      // One batched audit-log query keyed on the row ids; fold the
      // most-recent BINDING_* event per template into a status string.
      // Rows with `bindingJson` are always "ready" — audit lookup is
      // only consulted for the empty case.
      const rowsMissingBinding = rows
        .filter((r) => r.bindingJson === null)
        .map((r) => r.id);
      const bindingEvents = rowsMissingBinding.length
        ? await ctx.db.auditLog.findMany({
            where: {
              entityType: "Template",
              entityId: { in: rowsMissingBinding },
              action: {
                in: [
                  "TEMPLATE_BINDING_PROPOSED",
                  "TEMPLATE_BINDING_PROPOSE_FAILED",
                  "TEMPLATE_BINDING_REPROPOSE_REQUESTED",
                ],
              },
            },
            orderBy: { createdAt: "desc" },
            select: {
              entityId: true,
              action: true,
              details: true,
              createdAt: true,
            },
          })
        : [];
      const lastEventByTemplate = new Map<
        string,
        (typeof bindingEvents)[number]
      >();
      for (const ev of bindingEvents) {
        if (!lastEventByTemplate.has(ev.entityId)) {
          lastEventByTemplate.set(ev.entityId, ev);
        }
      }
      return rows.map((r) => {
        const hasBinding = r.bindingJson !== null;
        let bindingStatus: "ready" | "pending" | "failed";
        let bindingError: string | null = null;
        if (hasBinding) {
          bindingStatus = "ready";
        } else {
          const last = lastEventByTemplate.get(r.id);
          if (last?.action === "TEMPLATE_BINDING_PROPOSE_FAILED") {
            bindingStatus = "failed";
            const details = last.details as { error?: unknown } | null;
            if (details && typeof details.error === "string") {
              bindingError = details.error;
            }
          } else {
            // No event yet, or a re-propose is in flight, or an old
            // PROPOSED row predates the audit logging — treat as
            // still working so we don't show a misleading retry button.
            bindingStatus = "pending";
          }
        }
        return {
          id: r.id,
          engagementId: r.engagementId,
          scope:
            r.engagementId === null
              ? ("workspace" as const)
              : ("engagement" as const),
          kind: r.kind,
          name: r.name,
          version: r.version,
          filename: r.filename,
          mimeType: r.mimeType,
          fileSize: r.fileSize,
          status: r.status,
          hasBinding,
          bindingStatus,
          bindingError,
          uploader: r.uploader,
          approver: r.approver,
          approvedAt: r.approvedAt,
          deprecatedAt: r.deprecatedAt,
          archivedAt: r.archivedAt,
          createdAt: r.createdAt,
        };
      });
    }),

  /**
   * Lightweight picker source for the Team & Estimate / Deliverables
   * popups. Returns APPROVED, non-archived templates the caller can
   * use for the given kind, optionally narrowed to an engagement.
   *
   * Visibility & default match the auto-resolver in
   * `resolveTemplateForAssessment`:
   *   - Engagement-scoped templates first (when engagementId given,
   *     gated on access), then workspace defaults.
   *   - `isDefault` flags whichever row the auto-resolver would
   *     pick (engagement-scoped beats workspace; newer approval wins
   *     within scope) so the UI can preselect it.
   */
  pickerOptions: protectedProcedure
    .input(
      z.object({
        engagementId: z.string().cuid().optional(),
        kind: z.nativeEnum(TemplateKind),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.engagementId) {
        const eng = await ctx.db.engagement.findFirst({
          where: {
            id: input.engagementId,
            ...engagementAccessFilter(ctx.session),
          },
          select: { id: true },
        });
        if (!eng) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Engagement not found",
          });
        }
      }
      // Per-type kind plus the legacy generic fallback for that
      // file format — so a customer who uploaded under the old
      // DELIVERABLE_REPORT / DELIVERABLE_PRESENTATION kinds still
      // sees their file in the picker for any matching deliverable
      // type.
      const presentationLikeKinds: TemplateKind[] = [
        "EXECUTIVE_SUMMARY",
        "TARGET_STATE",
      ];
      const allowedKinds: TemplateKind[] = [input.kind];
      if (input.kind !== TemplateKind.ESTIMATION) {
        allowedKinds.push(
          presentationLikeKinds.includes(input.kind)
            ? TemplateKind.DELIVERABLE_PRESENTATION
            : TemplateKind.DELIVERABLE_REPORT,
        );
      }
      const rows = await ctx.db.template.findMany({
        where: {
          kind: { in: allowedKinds },
          status: TemplateStatus.APPROVED,
          archivedAt: null,
          bindingJson: { not: Prisma.DbNull } as never,
          OR: [
            { engagementId: null },
            ...(input.engagementId
              ? [{ engagementId: input.engagementId }]
              : []),
          ],
        },
        // Same precedence the auto-resolver uses: engagement-scoped
        // first, exact-kind beats fallback, then newest approval.
        orderBy: [
          { engagementId: "desc" },
          { approvedAt: "desc" },
        ],
        select: {
          id: true,
          name: true,
          version: true,
          engagementId: true,
          kind: true,
        },
      });
      // Stable sort: rows whose kind matches the requested input
      // exactly come first; fallback rows sit at the bottom.
      rows.sort((a, b) => {
        const aExact = a.kind === input.kind ? 0 : 1;
        const bExact = b.kind === input.kind ? 0 : 1;
        return aExact - bExact;
      });
      return rows.map((r, idx) => ({
        id: r.id,
        name: r.name,
        version: r.version,
        scope:
          r.engagementId === null
            ? ("workspace" as const)
            : ("engagement" as const),
        // First row in the precedence-ordered list is what
        // resolveTemplateForAssessment would pick.
        isDefault: idx === 0,
      }));
    }),

  /**
   * Drives the Deliverables page's deliverable-type dropdown: returns
   * the set of `DeliverableType` strings for which at least one
   * APPROVED template (workspace-default OR engagement-scoped) is
   * uploaded. This way the picker only offers types the user can
   * actually generate.
   *
   * Mapping:
   *   - per-type kinds (EXECUTIVE_SUMMARY, ASSESSMENT_REPORT, …)
   *     map 1:1 to the same DeliverableType.
   *   - the legacy generic kinds (DELIVERABLE_REPORT,
   *     DELIVERABLE_PRESENTATION) cover *any* deliverable type that
   *     uses that file format — a single uploaded
   *     DELIVERABLE_PRESENTATION makes EXECUTIVE_SUMMARY +
   *     TARGET_STATE both available, which matches the existing
   *     `templateKindForDeliverable` worker behaviour.
   */
  deliverableTypesWithTemplates: protectedProcedure
    .input(z.object({ engagementId: z.string().cuid().optional() }))
    .query(async ({ ctx, input }) => {
      if (input.engagementId) {
        const eng = await ctx.db.engagement.findFirst({
          where: {
            id: input.engagementId,
            ...engagementAccessFilter(ctx.session),
          },
          select: { id: true },
        });
        if (!eng) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Engagement not found",
          });
        }
      }
      const rows = await ctx.db.template.findMany({
        where: {
          status: TemplateStatus.APPROVED,
          archivedAt: null,
          bindingJson: { not: Prisma.DbNull } as never,
          OR: [
            { engagementId: null },
            ...(input.engagementId
              ? [{ engagementId: input.engagementId }]
              : []),
          ],
          NOT: { kind: TemplateKind.ESTIMATION },
        },
        select: { kind: true },
        distinct: ["kind"],
      });
      const kinds = new Set(rows.map((r) => r.kind));
      // Per-type kinds enable that single DeliverableType.
      // Legacy presentation generic enables both EXEC + TARGET_STATE
      // (mirrors templateKindForDeliverable). Legacy report generic
      // enables every other type.
      const presentationTypes = new Set<string>([
        "EXECUTIVE_SUMMARY",
        "TARGET_STATE",
      ]);
      const allDeliverableTypes = [
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
      const enabled = new Set<string>();
      for (const t of allDeliverableTypes) {
        if (kinds.has(t as TemplateKind)) enabled.add(t);
      }
      if (kinds.has(TemplateKind.DELIVERABLE_PRESENTATION)) {
        for (const t of presentationTypes) enabled.add(t);
      }
      if (kinds.has(TemplateKind.DELIVERABLE_REPORT)) {
        for (const t of allDeliverableTypes) {
          if (!presentationTypes.has(t)) enabled.add(t);
        }
      }
      return Array.from(enabled);
    }),

  /**
   * Full detail with binding JSON — used by the binding editor.
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.template.findUnique({
        where: { id: input.id },
        include: {
          uploader: { select: { name: true, email: true } },
          approver: { select: { name: true, email: true } },
        },
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
      }
      // Gate: workspace defaults are visible to anyone authenticated;
      // engagement-scoped require access.
      if (row.engagementId) {
        const eng = await ctx.db.engagement.findFirst({
          where: {
            id: row.engagementId,
            ...engagementAccessFilter(ctx.session),
          },
          select: { id: true },
        });
        if (!eng) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Template not found",
          });
        }
      }
      return row;
    }),

  /**
   * Persist an edited binding. The schema is validated server-side;
   * a malformed binding is rejected with a 400 explaining the field
   * that failed.
   */
  saveBinding: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        binding: bindingDocumentSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertTemplateMutationAccess(ctx, input.id);
      await ctx.db.template.update({
        where: { id: input.id },
        data: {
          // The Prisma Json column accepts our parsed structure 1:1.
          bindingJson:
            input.binding as unknown as import("@prisma/client").Prisma.InputJsonValue,
        },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "TEMPLATE_BINDING_SAVED",
          entityType: "Template",
          entityId: input.id,
          details: { entryCount: input.binding.entries.length },
        },
      });
      return { ok: true };
    }),

  /**
   * Re-run the AI binding proposer when the previous attempt failed.
   * Refuses when a binding already exists — that path would clobber
   * human edits, and we'd rather force the user to delete the
   * binding explicitly if they really want a fresh proposal.
   */
  reproposeBinding: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertTemplateMutationAccess(ctx, input.id);
      const row = await ctx.db.template.findUnique({
        where: { id: input.id },
        select: { bindingJson: true },
      });
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Template not found",
        });
      }
      if (row.bindingJson) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Template already has a binding. Edit it directly instead.",
        });
      }
      await enqueueProposeTemplateBinding(input.id);
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "TEMPLATE_BINDING_REPROPOSE_REQUESTED",
          entityType: "Template",
          entityId: input.id,
          details: {},
        },
      });
      return { ok: true };
    }),

  approve: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertTemplateMutationAccess(ctx, input.id);
      const row = await ctx.db.template.findUnique({
        where: { id: input.id },
        select: {
          name: true,
          kind: true,
          engagementId: true,
          status: true,
          bindingJson: true,
        },
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
      }
      if (!row.bindingJson) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This template has no binding yet. Save the proposed binding before approving.",
        });
      }
      // Approval also DEPRECATEs older approved versions of the same
      // (name, kind, engagementId) so the picker shows just one row.
      await ctx.db.$transaction([
        ctx.db.template.updateMany({
          where: {
            name: row.name,
            kind: row.kind,
            engagementId: row.engagementId,
            status: TemplateStatus.APPROVED,
            id: { not: input.id },
          },
          data: {
            status: TemplateStatus.DEPRECATED,
            deprecatedAt: new Date(),
          },
        }),
        ctx.db.template.update({
          where: { id: input.id },
          data: {
            status: TemplateStatus.APPROVED,
            approvedById: ctx.session.user.id,
            approvedAt: new Date(),
            deprecatedAt: null,
          },
        }),
      ]);
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "TEMPLATE_APPROVED",
          entityType: "Template",
          entityId: input.id,
          details: { engagementId: row.engagementId },
        },
      });
      return { ok: true };
    }),

  deprecate: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertTemplateMutationAccess(ctx, input.id);
      await ctx.db.template.update({
        where: { id: input.id },
        data: {
          status: TemplateStatus.DEPRECATED,
          deprecatedAt: new Date(),
        },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "TEMPLATE_DEPRECATED",
          entityType: "Template",
          entityId: input.id,
          details: {},
        },
      });
      return { ok: true };
    }),

  archive: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertTemplateMutationAccess(ctx, input.id);
      await ctx.db.template.update({
        where: { id: input.id },
        data: { archivedAt: new Date() },
      });
      return { ok: true };
    }),

  restore: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertTemplateMutationAccess(ctx, input.id);
      await ctx.db.template.update({
        where: { id: input.id },
        data: { archivedAt: null },
      });
      return { ok: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertTemplateMutationAccess(ctx, input.id);
      const row = await ctx.db.template.findUnique({
        where: { id: input.id },
        select: { archivedAt: true },
      });
      if (!row?.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Archive the template before deleting it.",
        });
      }
      await ctx.db.template.delete({ where: { id: input.id } });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "TEMPLATE_DELETED",
          entityType: "Template",
          entityId: input.id,
          details: {},
        },
      });
      return { ok: true };
    }),

  /**
   * List the fills (populated outputs) for a template, scoped to the
   * caller's engagement membership.
   */
  fills: protectedProcedure
    .input(z.object({ templateId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const fills = await ctx.db.templateFill.findMany({
        where: {
          templateId: input.templateId,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        orderBy: { filledAt: "desc" },
        include: {
          outputDocument: {
            select: { id: true, filename: true, fileSize: true },
          },
          assessment: { select: { id: true, mode: true } },
        },
        take: 50,
      });
      return fills;
    }),

  /**
   * Latest populated-template fill for a given assessment + template
   * kind. Used by the Team & Estimate and Deliverables surfaces to
   * render a "Download populated …" CTA pointing at the most recent
   * output Document.
   *
   * Returns `null` when no successful fill exists yet (the CTA hides).
   */
  latestFillForAssessment: protectedProcedure
    .input(
      z.object({
        assessmentId: z.string().cuid(),
        kind: z.nativeEnum(TemplateKind),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Gate access via the assessment's engagement.
      const assessment = await ctx.db.assessment.findFirst({
        where: {
          id: input.assessmentId,
          engagement: engagementAccessFilter(ctx.session),
        },
        select: { id: true },
      });
      if (!assessment) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Assessment not found",
        });
      }
      const fill = await ctx.db.templateFill.findFirst({
        where: {
          assessmentId: input.assessmentId,
          template: { kind: input.kind },
          outputDocumentId: { not: null },
        },
        orderBy: { filledAt: "desc" },
        include: {
          outputDocument: {
            select: {
              id: true,
              filename: true,
              fileSize: true,
              mimeType: true,
            },
          },
          template: {
            select: { id: true, name: true, version: true, kind: true },
          },
        },
      });
      return fill;
    }),

  /**
   * Most recent fills across templates the caller can see for an
   * engagement. Powers the "Recent fills" history list on the
   * Templates tab. One round trip vs. fanning out `fills` per row.
   */
  recentFillsForEngagement: protectedProcedure
    .input(
      z.object({
        engagementId: z.string().cuid().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.engagementId) {
        const eng = await ctx.db.engagement.findFirst({
          where: {
            id: input.engagementId,
            ...engagementAccessFilter(ctx.session),
          },
          select: { id: true },
        });
        if (!eng) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Engagement not found",
          });
        }
      }
      const fills = await ctx.db.templateFill.findMany({
        where: {
          assessment: { engagement: engagementAccessFilter(ctx.session) },
          outputDocumentId: { not: null },
          ...(input.engagementId
            ? {
                OR: [
                  { template: { engagementId: input.engagementId } },
                  { template: { engagementId: null } },
                ],
              }
            : {}),
        },
        orderBy: { filledAt: "desc" },
        include: {
          outputDocument: {
            select: { id: true, filename: true, fileSize: true },
          },
          template: {
            select: { id: true, name: true, version: true, kind: true },
          },
          assessment: {
            select: {
              id: true,
              engagement: { select: { id: true, name: true } },
            },
          },
        },
        take: input.limit ?? 20,
      });
      return fills;
    }),
});

// ─── Authz helper ──────────────────────────────────────────────────

interface MutationCtx {
  db: import("@prisma/client").PrismaClient;
  session: {
    user: { id: string; role: import("@prisma/client").UserRole };
  };
}

async function assertTemplateMutationAccess(
  ctx: MutationCtx,
  templateId: string,
): Promise<void> {
  const row = await ctx.db.template.findUnique({
    where: { id: templateId },
    select: { engagementId: true },
  });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
  }
  // Workspace defaults — admin only.
  if (row.engagementId === null) {
    if (ctx.session.user.role !== "ADMIN") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only admins can mutate workspace-default templates.",
      });
    }
    return;
  }
  // Engagement-scoped — OWNER/ADMIN on the engagement.
  if (ctx.session.user.role === "ADMIN") return;
  const owner = await ctx.db.engagementMember.findFirst({
    where: {
      engagementId: row.engagementId,
      userId: ctx.session.user.id,
      role: "OWNER",
    },
    select: { id: true },
  });
  if (!owner) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only engagement owners and admins can mutate this template.",
    });
  }
}
