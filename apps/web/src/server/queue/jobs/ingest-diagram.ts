import { db } from "@/server/db";
import { log } from "@/server/lib/logger";
import { getObjectBuffer } from "@/server/storage/minio";
import {
  detectDiagramFormat,
  isImageDiagram,
  isTextBasedDiagram,
  parseImageDiagram,
  parseTextDiagram,
} from "@/server/services/diagram-parser";
import { chunkText } from "@/server/services/document-chunker";
import { embedTexts } from "@/server/services/ai/embedding-service";
import { insertEvidenceRowsWithEmbeddings } from "@/server/queue/jobs/ingest-document";
import {
  classifyProcessingError,
  formatErrorForUser,
} from "@/server/services/ai/error-classifier";

/**
 * Ingest a diagram upload. Detects format from the Document row, routes
 * to text-based parsing or Claude vision, and creates a Diagram record
 * plus Evidence entries so architecture-domain scoring has something to
 * chew on.
 *
 * Note: image diagrams still invoke Claude vision — the raster path has
 * no deterministic equivalent to chunking, and the roadmap explicitly
 * keeps this call on the ingest lane for Week 1. Text-based diagrams
 * (Mermaid / PlantUML / Structurizr) also touch Claude today; a fuller
 * "no AI on ingest" story lands when Week 3 introduces dedicated text-
 * diagram chunking. The per-document *prose* AI call is gone either way.
 *
 * Status transitions mirror `ingest-document`:
 *   PENDING → EXTRACTING → READY, or → FAILED.
 */
export async function ingestDiagramJob(documentId: string): Promise<void> {
  const doc = await db.document.findUnique({
    where: { id: documentId },
    include: {
      assessment: {
        include: { projectContext: true },
      },
    },
  });
  if (!doc) {
    console.warn(`[ingest-diagram] ${documentId} not found, skipping`);
    log.warn("diagram not found, skipping", {
      worker: "ingest-diagram",
      documentId,
    });
    return;
  }

  await db.document.update({
    where: { id: documentId },
    data: {
      ingestStatus: "EXTRACTING",
      processingStatus: "PROCESSING",
    },
  });

  log.info("diagram ingest start", {
    worker: "ingest-diagram",
    documentId,
    assessmentId: doc.assessmentId,
    filename: doc.filename,
    mimeType: doc.mimeType,
  });

  try {
    const buffer = await getObjectBuffer(doc.storagePath);
    // Re-detect from filename+mime+content-sample: the upload handler made
    // a best guess but may have fallen back to OTHER if content inspection
    // wasn't done. Re-running here gives the job handler the last word.
    const contentSample = buffer.toString("utf8", 0, 512);
    const format = detectDiagramFormat(
      doc.filename,
      doc.mimeType,
      contentSample,
    );

    const projectBlurb = buildProjectBlurb(doc.assessment.projectContext);

    let result;
    if (isTextBasedDiagram(format)) {
      result = await parseTextDiagram(buffer.toString("utf8"), format, projectBlurb);
    } else if (isImageDiagram(format)) {
      result = await parseImageDiagram(
        buffer,
        doc.mimeType,
        doc.filename,
        projectBlurb,
      );
    } else {
      throw new Error(
        `Unsupported diagram format '${format}' for ${doc.filename}`,
      );
    }

    // Evidence from diagrams: one row per identified component. Cheap,
    // keyed into architecture domain for downstream retrieval. Connections/
    // datastores could also be evidence — keep it tight for MVP.
    const evidenceCreates = result.extractedEntities.entities.components.map(
      (c) => ({
        assessmentId: doc.assessmentId,
        sourceType: "DOCUMENT" as const,
        documentId: doc.id,
        content:
          c.technology
            ? `${c.name} (${c.type}, ${c.technology})${c.description ? " — " + c.description : ""}`
            : `${c.name} (${c.type})${c.description ? " — " + c.description : ""}`,
        domain: "architecture",
        confidence: 0.7,
      }),
    );

    // Week 3 (ADR-0003): for text-based diagram sources (Mermaid /
    // PlantUML / Structurizr DSL) chunk the source code and embed it
    // so diagram content participates in retrieval. Image diagrams
    // keep the vision path only — their source *is* the rendered
    // summary, already captured above.
    const sourceChunks =
      isTextBasedDiagram(format) && result.sourceCode
        ? chunkText(result.sourceCode)
        : [];
    // Audit the embedding call so diagram ingest lands in the AI-usage
    // rollup the same way prose/code Document ingest does.
    const sourceVectors =
      sourceChunks.length > 0
        ? (
            await embedTexts(sourceChunks.map((c) => c.content), {
              callType: "embedding",
              entityId: doc.id,
              entityType: "Document",
              userId: doc.uploadedById,
            })
          ).vectors
        : [];

    await db.$transaction(async (tx) => {
      // Defensive cleanup: on Retry, drop any Evidence rows + diagram-
      // sourced rows this document produced last time. `createMany`
      // below would otherwise append duplicates, and downstream retrieval
      // already de-dupes poorly. Mirrors the deliverable-generator
      // pattern that deletes prior DRAFT deliverables before recreating
      // them. The Diagram itself is `upsert`ed by deterministic id
      // (`diagram-<documentId>`) so the row identity stays stable across
      // retries.
      await tx.evidence.deleteMany({
        where: { documentId: doc.id },
      });
      await tx.diagram.upsert({
        where: { id: `diagram-${doc.id}` },
        create: {
          id: `diagram-${doc.id}`,
          assessmentId: doc.assessmentId,
          documentId: doc.id,
          direction: "INGESTED",
          diagramFormat: result.format,
          title: result.title,
          description: result.summary,
          sourceCode: result.sourceCode,
          imageStoragePath: result.sourceCode ? null : doc.storagePath,
          extractedEntities: result.extractedEntities as object,
          extractedSummary: result.summary,
          diagramType: result.diagramType,
          processingStatus: "PROCESSED",
        },
        update: {
          diagramFormat: result.format,
          title: result.title,
          description: result.summary,
          sourceCode: result.sourceCode,
          extractedEntities: result.extractedEntities as object,
          extractedSummary: result.summary,
          diagramType: result.diagramType,
          processingStatus: "PROCESSED",
        },
      });
      await tx.document.update({
        where: { id: documentId },
        data: {
          ingestStatus: sourceChunks.length > 0 ? "READY" : "READY",
          processingStatus: "PROCESSED",
          extractedSummary: result.summary,
          chunkCount: evidenceCreates.length + sourceChunks.length,
        },
      });
      if (evidenceCreates.length > 0) {
        await tx.evidence.createMany({ data: evidenceCreates });
      }
      if (sourceChunks.length > 0) {
        await insertEvidenceRowsWithEmbeddings(tx, {
          assessmentId: doc.assessmentId,
          documentId: doc.id,
          chunks: sourceChunks,
          vectors: sourceVectors,
          domain: "architecture",
          confidence: 0.7,
        });
      }
      await tx.auditLog.create({
        data: {
          action: "INGEST_DIAGRAM",
          entityType: "Diagram",
          entityId: doc.id,
          details: {
            format: result.format,
            diagramType: result.diagramType,
            components: result.extractedEntities.entities.components.length,
            connections: result.extractedEntities.entities.connections.length,
            sourceChunks: sourceChunks.length,
          },
        },
      });
    });

    console.log(
      `[ingest-diagram] ✓ ${doc.filename} → ${result.extractedEntities.entities.components.length} components`,
    );
    log.info("diagram ingest complete", {
      worker: "ingest-diagram",
      documentId,
      assessmentId: doc.assessmentId,
      filename: doc.filename,
      format: result.format,
      diagramType: result.diagramType,
      components: result.extractedEntities.entities.components.length,
      sourceChunks: sourceChunks.length,
    });
  } catch (err) {
    const classified = classifyProcessingError(err);
    console.error(
      `[ingest-diagram] ✗ ${doc.filename} [${classified.category}]: ${classified.technicalDetail}`,
    );
    log.error("diagram ingest failed", {
      worker: "ingest-diagram",
      documentId,
      assessmentId: doc.assessmentId,
      filename: doc.filename,
      category: classified.category,
      technicalDetail: classified.technicalDetail,
    });
    await db.document.update({
      where: { id: documentId },
      data: {
        ingestStatus: "FAILED",
        processingStatus: "FAILED",
        extractedSummary: formatErrorForUser(classified),
      },
    });
    await db.auditLog
      .create({
        data: {
          action: "INGEST_DIAGRAM_FAILED",
          entityType: "Document",
          entityId: doc.id,
          details: {
            category: classified.category,
            isRetryable: classified.isRetryable,
            needsAdmin: classified.needsAdmin,
            technicalDetail: classified.technicalDetail,
          },
        },
      })
      .catch(() => {
        /* best-effort */
      });
    throw err;
  }
}

function buildProjectBlurb(
  pc: {
    projectName: string | null;
    industry: string | null;
    description: string | null;
  } | null,
): string | undefined {
  if (!pc) return undefined;
  const parts: string[] = [];
  if (pc.projectName) parts.push(`Project: ${pc.projectName}`);
  if (pc.industry) parts.push(`Industry: ${pc.industry}`);
  if (pc.description) parts.push(`Description: ${pc.description}`);
  return parts.length > 0 ? parts.join("\n") : undefined;
}
