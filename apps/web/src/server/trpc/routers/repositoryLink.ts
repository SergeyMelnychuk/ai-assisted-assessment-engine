import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createRouter, protectedProcedure } from "../trpc";
import {
  assertAssessmentAccess,
  engagementAccessFilter,
} from "@/server/authz";
import { scrubCredential } from "@/server/services/repo/credentials";
import { putAgentCredential } from "@/server/services/agent/credentials";
import { parseGithubRepoUrl } from "@/server/services/repo/provider";
import { enqueueIngestRepository } from "@/server/queue/queue";
import { deleteObject } from "@/server/storage/minio";

/**
 * tRPC router for `RepositoryLink` (Phase 3 Week 6, ADR-0009/0010).
 *
 * Endpoints:
 *   - `create` — bind a GitHub URL + PAT to an assessment. Encrypts
 *     the PAT at rest, enqueues the ingest job, returns the link
 *     metadata (no PAT echoed back — ever).
 *   - `list`   — membership-scoped list for the assessment shell.
 *   - `resync` — re-fetch the tarball and re-run the ingest pipeline.
 *   - `delete` — hard-delete the link. Credentials + any child
 *     Document cascade via the FK.
 *
 * Every procedure funnels through `assertAssessmentAccess` — no
 * direct lookup by link id without first confirming the caller can
 * see the parent assessment. We always return the link with a
 * `credentialStored: boolean` hint in place of anything PAT-shaped.
 */

const githubUrlRegex =
  /^(https?:\/\/github\.com\/[^/]+\/[^/\s]+|[^/\s]+\/[^/\s]+)(\/tree\/.+)?\/?$/;

const createInput = z.object({
  assessmentId: z.string().cuid(),
  url: z.string().trim().min(3).regex(githubUrlRegex, {
    message:
      "URL must be a GitHub web URL (https://github.com/owner/repo) or shorthand (owner/repo).",
  }),
  pat: z.string().trim().min(10).max(512),
});

function toPublicShape(link: {
  id: string;
  assessmentId: string;
  url: string;
  provider: string;
  authMethod: string;
  ingestStatus: string;
  lastSyncedAt: Date | null;
  lastSha: string | null;
  parentDocumentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: link.id,
    assessmentId: link.assessmentId,
    url: link.url,
    provider: link.provider,
    authMethod: link.authMethod,
    ingestStatus: link.ingestStatus,
    lastSyncedAt: link.lastSyncedAt,
    lastSha: link.lastSha,
    parentDocumentId: link.parentDocumentId,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    credentialStored: true,
  };
}

export const repositoryLinkRouter = createRouter({
  create: protectedProcedure
    .input(createInput)
    .mutation(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);

      // Validate the URL parses cleanly before we bother encrypting.
      // Bad URLs should never reach the DB.
      try {
        parseGithubRepoUrl(input.url);
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Could not parse the GitHub URL.",
        });
      }

      // PAT consolidation (Slice 3): upsert into the engagement-scoped
      // AgentCredential vault. Multiple repo links share one PAT per
      // engagement; subsequent creates for the same engagement
      // overwrite the vault row (rotation in place).
      const assessment = await ctx.db.assessment.findUnique({
        where: { id: input.assessmentId },
        select: { engagementId: true },
      });
      if (!assessment) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Assessment not found",
        });
      }
      const cred = await putAgentCredential(ctx.db, {
        engagementId: assessment.engagementId,
        scope: "github.pat",
        secret: input.pat,
        createdById: ctx.session.user.id,
      });

      const link = await ctx.db.repositoryLink.create({
        data: {
          assessmentId: input.assessmentId,
          url: input.url,
          provider: "github",
          authMethod: "pat",
          // Legacy in-row columns left null on new rows. Old rows
          // continue to ingest until the backfill upserts them into
          // the vault and links via `agentCredentialId`.
          agentCredentialId: cred.id,
          ingestStatus: "PENDING",
        },
      });

      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "CREATE_REPOSITORY_LINK",
          entityType: "RepositoryLink",
          entityId: link.id,
          // The scrub is belt-and-braces — we never include the PAT
          // in `details`, but future refactors might, and the scrub
          // guarantees nothing slips through.
          details: scrubCredential({
            assessmentId: input.assessmentId,
            url: input.url,
            provider: "github",
          }),
        },
      });

      await enqueueIngestRepository(link.id);

      return toPublicShape(link);
    }),

  list: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const rows = await ctx.db.repositoryLink.findMany({
        where: { assessmentId: input.assessmentId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toPublicShape);
    }),

  resync: protectedProcedure
    .input(z.object({ linkId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const link = await ctx.db.repositoryLink.findFirst({
        where: {
          id: input.linkId,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
      });
      if (!link) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Repository link not found",
        });
      }

      await ctx.db.repositoryLink.update({
        where: { id: link.id },
        data: { ingestStatus: "PENDING" },
      });

      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "RESYNC_REPOSITORY_LINK",
          entityType: "RepositoryLink",
          entityId: link.id,
          details: scrubCredential({
            url: link.url,
            provider: link.provider,
          }),
        },
      });

      await enqueueIngestRepository(link.id);
      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ linkId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const link = await ctx.db.repositoryLink.findFirst({
        where: {
          id: input.linkId,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: {
          id: true,
          url: true,
          provider: true,
          parentDocumentId: true,
        },
      });
      if (!link) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Repository link not found",
        });
      }

      // Collect documents owned by this link: the archive parent and
      // every extracted child. We need an explicit list because
      // `evidences_document_id_fkey` is ON DELETE SET NULL, so
      // evidence rows would otherwise be orphaned (and would keep
      // surfacing in retrieval forever). Children cascade via
      // `documents_parent_document_id_fkey` ON DELETE CASCADE, so we
      // only have to delete the parent Document row.
      const docIds: string[] = [];
      const storageKeys: string[] = [];
      if (link.parentDocumentId) {
        const docs = await ctx.db.document.findMany({
          where: {
            OR: [
              { id: link.parentDocumentId },
              { parentDocumentId: link.parentDocumentId },
            ],
          },
          select: { id: true, storagePath: true },
        });
        for (const d of docs) {
          docIds.push(d.id);
          if (d.storagePath) storageKeys.push(d.storagePath);
        }
      }

      await ctx.db.$transaction(async (tx) => {
        if (docIds.length > 0) {
          await tx.evidence.deleteMany({
            where: { documentId: { in: docIds } },
          });
          if (link.parentDocumentId) {
            await tx.document.delete({
              where: { id: link.parentDocumentId },
            });
          }
        }
        await tx.repositoryLink.delete({ where: { id: link.id } });
        await tx.auditLog.create({
          data: {
            userId: ctx.session.user.id,
            action: "DELETE_REPOSITORY_LINK",
            entityType: "RepositoryLink",
            entityId: link.id,
            details: scrubCredential({
              url: link.url,
              provider: link.provider,
              deletedDocumentCount: docIds.length,
            }),
          },
        });
      });

      // Best-effort MinIO cleanup. An orphaned object is annoying but
      // not a correctness failure — DB state is already consistent.
      for (const key of storageKeys) {
        try {
          await deleteObject(key);
        } catch {
          // swallow — dev MinIO may be down, or the key may already
          // be gone. The audit log above records the intent.
        }
      }

      return { success: true, deletedDocumentCount: docIds.length };
    }),
});
