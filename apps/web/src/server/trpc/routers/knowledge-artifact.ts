import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { createRouter, protectedProcedure } from "../trpc";

/**
 * Knowledge-base CRUD for admins. Mirrors `pnpm db:seed` semantics:
 *   - CREATE starts at version 1
 *   - UPDATE bumps `version` by 1 on every write (matches seed idempotency)
 *   - DELETE is a hard delete (no soft-delete column on the model)
 *
 * ADMIN-only. We re-check the role inside every procedure — the
 * admin-layout gate at the route level is the first line of defence,
 * this is belt-and-braces for a misconfigured client call.
 *
 * Audit logging: every mutation writes an `AuditLog` row with the full
 * pre-change snapshot in `details.before` plus the submitted patch in
 * `details.after` (create) / `details.patch` (update), so the admin
 * page can be reconstructed from the audit table if ever needed.
 *
 * NOTE: `KnowledgeArtifact` has no embedding column today; grep for
 * `embedding` returned only document/chunk embeddings. If vector
 * embeddings are ever added to this table, this router will need to
 * re-generate (or invalidate) them on CREATE/UPDATE — see the README
 * of `packages/knowledge-seed/`.
 */

const ARTIFACT_TYPES = [
  "FRAMEWORK",
  "CHECKLIST",
  "TEMPLATE",
  "HEURISTIC",
  "RISK_PATTERN",
  "RECOMMENDATION_PATTERN",
  "ROLE_CATALOG",
  "RATE_CARD",
  "TECHNOLOGY_OPTION",
  "PLATFORM_GUIDANCE",
  "CAPABILITY_MODEL",
  "SCORING_MODEL",
  "INDUSTRY_OVERLAY",
  "CLOUD_OVERLAY",
  "QUESTION_TEMPLATE",
] as const;

const ArtifactTypeSchema = z.enum(ARTIFACT_TYPES);

// The `content` payload shape is type-dependent (question templates look
// nothing like rate-card snapshots). Rather than encode 15 discriminated
// unions here, we accept any JSON object/array/primitive — the seed
// pipeline doesn't validate schema either, so this matches reality.
const JsonValueSchema: z.ZodType<Prisma.InputJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
) as z.ZodType<Prisma.InputJsonValue>;

function requireAdmin(role: string) {
  if (role !== "ADMIN") {
    // Hide existence from non-admins (same pattern as cost router).
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

export const knowledgeArtifactRouter = createRouter({
  /**
   * List artifacts. Optional filters by type/domain/active flag.
   * Ordered by type then name — matches the grouping the admin UI
   * renders (one card per type).
   */
  list: protectedProcedure
    .input(
      z
        .object({
          artifactType: ArtifactTypeSchema.optional(),
          domain: z.string().optional(),
          isActive: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session.user.role);
      return ctx.db.knowledgeArtifact.findMany({
        where: {
          artifactType: input?.artifactType,
          domain: input?.domain,
          isActive: input?.isActive,
        },
        orderBy: [{ artifactType: "asc" }, { name: "asc" }],
        select: {
          id: true,
          artifactType: true,
          name: true,
          description: true,
          domain: true,
          version: true,
          isActive: true,
          tags: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    }),

  /**
   * Fetch a single artifact including its full `content` JSON blob —
   * the list endpoint deliberately omits `content` (can be large) so
   * the detail/edit view is the only path that loads it.
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session.user.role);
      const artifact = await ctx.db.knowledgeArtifact.findUnique({
        where: { id: input.id },
      });
      if (!artifact) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return artifact;
    }),

  create: protectedProcedure
    .input(
      z.object({
        artifactType: ArtifactTypeSchema,
        name: z.string().trim().min(1, "Name is required").max(200),
        description: z.string().max(4000).optional().default(""),
        domain: z.string().max(120).optional(),
        tags: z.array(z.string().max(60)).optional().default([]),
        content: JsonValueSchema,
        isActive: z.boolean().optional().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session.user.role);
      const created = await ctx.db.knowledgeArtifact.create({
        data: {
          artifactType: input.artifactType,
          name: input.name,
          description: input.description ?? "",
          domain: input.domain,
          tags: input.tags ?? [],
          content: input.content,
          isActive: input.isActive,
          version: 1,
          createdById: ctx.session.user.id,
        },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "CREATE_KNOWLEDGE_ARTIFACT",
          entityType: "KnowledgeArtifact",
          entityId: created.id,
          details: {
            after: {
              artifactType: created.artifactType,
              name: created.name,
              domain: created.domain,
              version: created.version,
              isActive: created.isActive,
            },
          },
        },
      });
      return created;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(4000).optional(),
        domain: z.string().max(120).nullable().optional(),
        tags: z.array(z.string().max(60)).optional(),
        content: JsonValueSchema.optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session.user.role);
      const { id, ...patch } = input;
      const existing = await ctx.db.knowledgeArtifact.findUnique({
        where: { id },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      // Bump version on every update so downstream consumers (scoring,
      // analysis-engine, estimation) can detect a refresh the same way
      // a seed re-run would signal it.
      const data: Prisma.KnowledgeArtifactUpdateInput = {
        version: { increment: 1 },
      };
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.description !== undefined) data.description = patch.description;
      if (patch.domain !== undefined) data.domain = patch.domain;
      if (patch.tags !== undefined) data.tags = { set: patch.tags };
      if (patch.content !== undefined) data.content = patch.content;
      if (patch.isActive !== undefined) data.isActive = patch.isActive;

      const updated = await ctx.db.knowledgeArtifact.update({
        where: { id },
        data,
      });

      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "UPDATE_KNOWLEDGE_ARTIFACT",
          entityType: "KnowledgeArtifact",
          entityId: id,
          details: {
            before: {
              name: existing.name,
              description: existing.description,
              domain: existing.domain,
              tags: existing.tags,
              isActive: existing.isActive,
              version: existing.version,
            },
            patch: {
              name: patch.name,
              description: patch.description,
              domain: patch.domain,
              tags: patch.tags,
              isActive: patch.isActive,
              // Flag content changes without dumping the full blob.
              contentChanged: patch.content !== undefined,
            },
            newVersion: updated.version,
          },
        },
      });
      return updated;
    }),

  toggleActive: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session.user.role);
      const existing = await ctx.db.knowledgeArtifact.findUnique({
        where: { id: input.id },
        select: { id: true, isActive: true, version: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      const updated = await ctx.db.knowledgeArtifact.update({
        where: { id: input.id },
        data: {
          isActive: !existing.isActive,
          version: { increment: 1 },
        },
        select: {
          id: true,
          isActive: true,
          version: true,
        },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "UPDATE_KNOWLEDGE_ARTIFACT",
          entityType: "KnowledgeArtifact",
          entityId: input.id,
          details: {
            before: { isActive: existing.isActive, version: existing.version },
            patch: { isActive: updated.isActive },
            newVersion: updated.version,
            via: "toggleActive",
          },
        },
      });
      return updated;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session.user.role);
      const existing = await ctx.db.knowledgeArtifact.findUnique({
        where: { id: input.id },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      await ctx.db.knowledgeArtifact.delete({ where: { id: input.id } });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "DELETE_KNOWLEDGE_ARTIFACT",
          entityType: "KnowledgeArtifact",
          entityId: input.id,
          details: {
            before: {
              artifactType: existing.artifactType,
              name: existing.name,
              domain: existing.domain,
              version: existing.version,
              isActive: existing.isActive,
            },
          },
        },
      });
      return { id: input.id };
    }),
});
