import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import {
  assertAssessmentAccess,
  engagementAccessFilter,
} from "@/server/authz";
import { deleteObject } from "@/server/storage/minio";
import {
  documentQueue,
  enqueueIngestDiagram,
  enqueueIngestDocument,
} from "@/server/queue/queue";
import {
  isImageDiagram,
  isTextBasedDiagram,
} from "@/server/services/diagram-parser";

export const documentRouter = createRouter({
  /**
   * List documents for an assessment. Membership is enforced via the
   * parent engagement — non-members get NOT_FOUND on the assessment.
   */
  listByAssessment: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      return ctx.db.document.findMany({
        where: { assessmentId: input.assessmentId },
        orderBy: { createdAt: "desc" },
        include: {
          uploadedBy: { select: { id: true, name: true, email: true } },
          diagrams: {
            select: {
              id: true,
              diagramFormat: true,
              diagramType: true,
              title: true,
              extractedSummary: true,
              processingStatus: true,
              sourceCode: true,
              extractedEntities: true,
            },
          },
        },
      });
    }),

  /**
   * Fetch a single document with full detail. Joins through the parent
   * engagement's membership filter so authorization + fetch happen in a
   * single query, same pattern as engagement.getById.
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const doc = await ctx.db.document.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        include: {
          uploadedBy: { select: { id: true, name: true, email: true } },
          diagrams: true,
          evidences: {
            orderBy: { createdAt: "asc" },
          },
        },
      });
      if (!doc) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }
      return doc;
    }),

  /**
   * Hard-delete the document, its S3 object, and any child diagrams/
   * evidence (cascade in the schema handles the latter two). Only the
   * uploader or an ADMIN can delete — collaborators get FORBIDDEN.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const doc = await ctx.db.document.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: {
          id: true,
          storagePath: true,
          uploadedById: true,
        },
      });
      if (!doc) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }
      if (
        ctx.session.user.role !== "ADMIN" &&
        doc.uploadedById !== ctx.session.user.id
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the uploader or an admin can delete this document",
        });
      }

      // Best-effort S3 cleanup. If the object is already gone we still
      // want the DB row removed, so swallow the storage error.
      await deleteObject(doc.storagePath).catch(() => {});
      await ctx.db.document.delete({ where: { id: doc.id } });
      return { success: true };
    }),

  /**
   * Re-enqueue processing — useful when a job has failed transiently (AI
   * outage, Redis hiccup) and the user wants to retry without re-uploading.
   */
  reprocess: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const doc = await ctx.db.document.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: {
          id: true,
          uploadType: true,
          filename: true,
          mimeType: true,
        },
      });
      if (!doc) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }

      await ctx.db.document.update({
        where: { id: doc.id },
        data: {
          ingestStatus: "PENDING",
          processingStatus: "PENDING",
          extractedSummary: null,
          chunkCount: null,
        },
      });

      // BullMQ keeps failed jobs in Redis (`removeOnFail: { count: 500 }`
      // in `queue.ts`) and `documentQueue.add()` silently no-ops when a
      // job with the same deterministic jobId already exists. Without
      // this cleanup, Retry would flip the DB row to PENDING but never
      // produce a runnable job — the doc would stay stuck in "Queued"
      // forever. We drop *both* possible jobIds because `uploadType`
      // could change between attempts (e.g. an image originally routed
      // to `ingest-document` may now route to `ingest-diagram`).
      for (const staleJobId of [`doc-${doc.id}`, `diag-${doc.id}`]) {
        try {
          const stale = await documentQueue.getJob(staleJobId);
          if (stale) {
            await stale.remove();
          }
        } catch {
          // Best-effort: a stale job that's currently active can throw
          // on remove(); the subsequent add() will then dedupe to that
          // active job, which is acceptable (it's already running).
        }
      }

      // Same routing logic as the upload handler. We don't re-sample S3
      // content here because the filename+mime+uploadType combo has
      // already proven enough.
      //
      // Mime alone isn't enough for repo-tarball children: the archive
      // walker only knows a small whitelist of mime types and falls
      // through to `application/octet-stream` for everything else
      // (including PNG/JPEG before the routing fix landed). Fall back
      // to the filename extension so PNGs uploaded inside a repo
      // tarball reprocess as diagrams instead of bouncing into the
      // text-extraction pipeline (which crashes on binary content).
      const mimeFormat = guessFormatFromMime(doc.mimeType);
      const filenameFormat = guessFormatFromFilename(doc.filename);
      const treatAsDiagram =
        doc.uploadType.startsWith("DIAGRAM_") ||
        isTextBasedDiagram(mimeFormat) ||
        isImageDiagram(mimeFormat) ||
        isTextBasedDiagram(filenameFormat) ||
        isImageDiagram(filenameFormat);

      if (treatAsDiagram) {
        await enqueueIngestDiagram(doc.id);
      } else {
        await enqueueIngestDocument(doc.id);
      }
      return { success: true };
    }),

  /**
   * Fetch the classified failure payload for a document whose processing
   * failed. Mirrors `analysis.lastFailure` in shape: returns null if the
   * most recent terminal audit row is a success, the classified object
   * otherwise. The UI uses this to render the fancy `<FailureBanner>`
   * (icon + tone + admin-hint + retry button) instead of a raw string
   * in `Document.extractedSummary`.
   */
  lastFailure: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      // Authz — same membership gate as everything else.
      const doc = await ctx.db.document.findFirst({
        where: {
          id: input.id,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: { id: true, ingestStatus: true, processingStatus: true },
      });
      if (!doc) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }
      // Short-circuit: if the document isn't FAILED right now, no banner
      // belongs on the card. Saves an audit-log lookup on the common path.
      // `ingestStatus` is canonical; fall back to `processingStatus` so
      // pre-migration rows still surface correctly.
      if (doc.ingestStatus !== "FAILED" && doc.processingStatus !== "FAILED") {
        return null;
      }

      const recent = await ctx.db.auditLog.findFirst({
        where: {
          entityType: "Document",
          entityId: doc.id,
          action: {
            in: [
              "INGEST_DOCUMENT_FAILED",
              "INGEST_DIAGRAM_FAILED",
              // Older names — retained so re-reads of pre-migration
              // audit rows still render the classified banner.
              "PROCESS_DOCUMENT_FAILED",
              "PROCESS_DIAGRAM_FAILED",
            ],
          },
        },
        orderBy: { createdAt: "desc" },
      });
      if (!recent) {
        // FAILED but no audit row — older failure from before the
        // classifier was wired. Fall back to a generic shape so the UI
        // still renders something sensible.
        return {
          action: "INGEST_DOCUMENT_FAILED",
          failedAt: new Date(),
          category: "UNKNOWN",
          label: "Processing failed",
          userMessage:
            "This document failed to process. We don't have a classified error on record (older failure), but the raw message is on the document summary.",
          nextStep: "Click Retry to try again.",
          isRetryable: true,
          needsAdmin: false,
        };
      }

      const d = (recent.details ?? {}) as {
        category?: string;
        isRetryable?: boolean;
        needsAdmin?: boolean;
        technicalDetail?: string;
      };

      // The job handler wrote `category` + `technicalDetail` to details
      // but the user-facing fields (label, userMessage, nextStep) are in
      // the `extractedSummary` column. Re-classify from technicalDetail
      // here so the banner's label/icon line up with the document's
      // visible summary — no duplication on write, cheap on read.
      const { classifyProcessingError } = await import(
        "@/server/services/ai/error-classifier"
      );
      const reclassified = classifyProcessingError(
        new Error(d.technicalDetail ?? ""),
      );
      return {
        action: recent.action,
        failedAt: recent.createdAt,
        category: d.category ?? reclassified.category,
        label: reclassified.label,
        userMessage: reclassified.userMessage,
        nextStep: reclassified.nextStep,
        isRetryable: d.isRetryable ?? reclassified.isRetryable,
        needsAdmin: d.needsAdmin ?? reclassified.needsAdmin,
      };
    }),
});

// Thin mime→format heuristic for the reprocess path. Full detection still
// happens inside the worker off the actual bytes.
function guessFormatFromMime(mime: string) {
  if (mime === "image/png") return "PNG" as const;
  if (mime === "image/jpeg") return "JPEG" as const;
  if (mime === "image/svg+xml") return "SVG" as const;
  return "OTHER" as const;
}

// Filename-based fallback for repo-tarball children whose mime got
// stamped as `application/octet-stream` by the archive walker. Only
// covers the image formats `isImageDiagram` recognises — extending
// this to text-diagram extensions (`.mmd`, `.puml`) is straightforward
// if it ever matters.
function guessFormatFromFilename(filename: string) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "PNG" as const;
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "JPEG" as const;
  if (lower.endsWith(".svg")) return "SVG" as const;
  return "OTHER" as const;
}
