import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/server/db";
import { log } from "@/server/lib/logger";
import { getObjectBuffer } from "@/server/storage/minio";
import {
  extractDocumentText,
  summaryFromChunks,
} from "@/server/services/document-processor";
import { chunkText, type Chunk } from "@/server/services/document-chunker";
import {
  embedTexts,
  EMBEDDING_DIMENSIONS,
} from "@/server/services/ai/embedding-service";
import {
  classifyProcessingError,
  formatErrorForUser,
} from "@/server/services/ai/error-classifier";
import { detectLanguage } from "@/server/services/repo/language-registry";
import {
  getSetting,
  SETTING_KEYS,
} from "@/server/services/settings-service";
import { classifyChunkDomains } from "@/server/services/ingest/domain-classifier";

/**
 * Ingest a non-diagram document: download from S3, extract text, chunk
 * with the Week 3 recursive splitter, embed, and fan out Evidence rows.
 *
 * **Still no Claude call.** The embedding step is OpenAI (or fake-mode
 * pseudo-vectors for tests / unfunded CI). Per-document AI *analysis*
 * remains on the per-assessment `run-analysis` job (see ADR-0001).
 *
 * Status transitions on Document.ingestStatus:
 *
 *   PENDING → EXTRACTING → CHUNKED → EMBEDDED → READY
 *            └───────────── FAILED ────────────┘
 *
 * The `embedding`, `chunk_index`, `chunk_source`, `content_sha` columns
 * on `evidences` land via raw SQL — Prisma can't type the pgvector
 * column so `createMany` is off the table. We do one `INSERT …` with
 * a `VALUES` list inside a transaction for atomicity with the document
 * update + audit row.
 */
export async function ingestDocumentJob(documentId: string): Promise<void> {
  const doc = await db.document.findUnique({ where: { id: documentId } });
  if (!doc) {
    console.warn(`[ingest-document] ${documentId} not found, skipping`);
    log.warn("document not found, skipping", {
      worker: "ingest-document",
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

  log.info("document ingest start", {
    worker: "ingest-document",
    documentId,
    assessmentId: doc.assessmentId,
    filename: doc.filename,
    mimeType: doc.mimeType,
  });

  try {
    const buffer = await getObjectBuffer(doc.storagePath);
    const extractedText = await extractDocumentText(
      buffer,
      doc.mimeType,
      doc.filename,
    );

    if (!extractedText.trim()) {
      throw new Error("Extracted text is empty — unsupported format?");
    }

    const chunks = chunkText(extractedText);
    if (chunks.length === 0) {
      throw new Error(
        "Extracted text is empty after chunking — unsupported format?",
      );
    }

    await db.document.update({
      where: { id: documentId },
      data: {
        ingestStatus: "CHUNKED",
        chunkCount: chunks.length,
      },
    });

    // Batch-embed all chunk content in one service call (the service
    // itself splits into OpenAI-sized batches internally). Fake-mode
    // makes this a no-op cost-wise in CI.
    // Pass `audit` so the embedding call writes an `AI_CALL` row
    // tying this ingest's OpenAI spend to the Document (and, via
    // Document → Assessment → Engagement, to the cost/usage rollups).
    // Without this the /admin/usage dashboard silently under-reports
    // OpenAI usage and engagements that have only had ingest activity
    // never appear in the engagement filter dropdown.
    const { vectors, model, inputTokens } = await embedTexts(
      chunks.map((c) => c.content),
      {
        callType: "embedding",
        entityId: doc.id,
        entityType: "Document",
        userId: doc.uploadedById,
      },
    );
    if (vectors.length !== chunks.length) {
      throw new Error(
        `embedding vector count (${vectors.length}) does not match chunk count (${chunks.length})`,
      );
    }

    // Mark EMBEDDED for UI surfacing before we flush to Evidence — the
    // row-write takes a little longer on big documents and the user
    // gets a richer progress indicator.
    await db.document.update({
      where: { id: documentId },
      data: { ingestStatus: "EMBEDDED" },
    });

    const summary = summaryFromChunks(
      chunks.map(({ index, content }) => ({ index, content })),
    );

    // Week 6: when a Document was fanned out from a repo/archive
    // parent, stamp each Evidence row with a language tag so the
    // retriever + UI can filter code by ext. Prose uploads set
    // `parentDocumentId=null` and get `language=null`.
    const language = doc.parentDocumentId ? detectLanguage(doc.filename) : null;

    await db.$transaction(async (tx) => {
      await insertEvidenceRowsWithEmbeddings(tx, {
        assessmentId: doc.assessmentId,
        documentId: doc.id,
        chunks,
        vectors,
        // If the user picked a domain at upload time, stamp every
        // chunk with it. Falls through to the worker's default
        // ("ingested") when null.
        domain: doc.domain ?? undefined,
        language,
        sourcePath: doc.parentDocumentId ? doc.filename : null,
      });

      await tx.document.update({
        where: { id: documentId },
        data: {
          ingestStatus: "READY",
          processingStatus: "PROCESSED",
          extractedText,
          extractedSummary: summary,
          chunkCount: chunks.length,
        },
      });

      await tx.auditLog.create({
        data: {
          action: "INGEST_DOCUMENT",
          entityType: "Document",
          entityId: doc.id,
          details: {
            chunks: chunks.length,
            extractedChars: extractedText.length,
            embeddingModel: model,
            embeddingInputTokens: inputTokens,
          },
        },
      });
    });

    console.log(
      `[ingest-document] ✓ ${doc.filename} → ${chunks.length} chunks, embedded via ${model}`,
    );
    log.info("document ingest complete", {
      worker: "ingest-document",
      documentId,
      assessmentId: doc.assessmentId,
      filename: doc.filename,
      chunks: chunks.length,
      embeddingModel: model,
      embeddingInputTokens: inputTokens,
    });

    // Best-effort: auto-classify chunks into the assessment's active
    // domains when the operator has opted in (ADR-0023 feature flag,
    // ADR-0020 soft-failure pattern). Skipped when:
    //   - the doc was already explicitly tagged at upload time
    //   - the flag is off (default)
    //   - the assessment has no active domains
    if (!doc.domain) {
      await maybeAutoClassifyChunks(doc.id, doc.assessmentId);
    }
  } catch (err) {
    const classified = classifyProcessingError(err);
    console.error(
      `[ingest-document] ✗ ${doc.filename} [${classified.category}]: ${classified.technicalDetail}`,
    );
    log.error("document ingest failed", {
      worker: "ingest-document",
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
          action: "INGEST_DOCUMENT_FAILED",
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

// ── Raw-SQL bulk insert for Evidence rows with pgvector column ────

/**
 * Insert Evidence rows populated with embedding, chunk metadata, and
 * content hash. Prisma's `createMany` can't target the pgvector column
 * (it's `Unsupported`), so we build one parameterized `INSERT` with a
 * `VALUES` list. Vectors are serialized as the canonical pgvector
 * literal `'[1,2,3]'::vector(1536)` — inline because `$n` placeholders
 * don't type-cast to vector in `$executeRaw`.
 *
 * The other columns go through `$n` placeholders, so any consultant-
 * authored content is still parameter-escaped.
 */
export async function insertEvidenceRowsWithEmbeddings(
  tx: Prisma.TransactionClient,
  args: {
    assessmentId: string;
    documentId: string;
    chunks: Chunk[];
    vectors: number[][];
    /** Override the domain tag (text diagrams set "architecture"). */
    domain?: string;
    /** Override confidence; defaults to 0.5. */
    confidence?: number;
    /** Week 6: language tag from repo-ingest, stored in chunk_source. */
    language?: string | null;
    /** Week 6: original repo-relative path for source-trail display. */
    sourcePath?: string | null;
  },
): Promise<void> {
  const {
    assessmentId,
    documentId,
    chunks,
    vectors,
    domain = "ingested",
    confidence = 0.5,
    language = null,
    sourcePath = null,
  } = args;
  if (chunks.length === 0) return;

  // Column order has to match the VALUES tuple below. Keep them in
  // sync if schema fields are added.
  const cols = [
    "id",
    "assessment_id",
    "source_type",
    "document_id",
    "content",
    "domain",
    "confidence",
    "chunk_index",
    "chunk_source",
    "content_sha",
    "embedding",
    "created_at",
  ];

  const placeholders: string[] = [];
  const values: unknown[] = [];
  let p = 1;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const vector = vectors[i];
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Vector at index ${i} has wrong shape (got ${Array.isArray(vector) ? vector.length : typeof vector}, expected ${EMBEDDING_DIMENSIONS})`,
      );
    }
    // cuid()-ish id generated app-side so we don't need a RETURNING
    // clause. randomUUID is fine — the column is TEXT and we never
    // depend on the specific prefix.
    const id = `ev_${randomUUID()}`;
    const chunkSource = JSON.stringify({
      documentId,
      offset: chunk.startOffset,
      endOffset: chunk.endOffset,
      heading: chunk.heading,
      ...(language ? { language } : {}),
      ...(sourcePath ? { sourcePath } : {}),
    });
    // `vector` column value is inlined — see function comment.
    const vectorLiteral = `'[${vector.join(",")}]'::vector(${EMBEDDING_DIMENSIONS})`;

    placeholders.push(
      `($${p++}, $${p++}, $${p++}::"EvidenceSourceType", $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++}, ${vectorLiteral}, NOW())`,
    );
    values.push(
      id,
      assessmentId,
      "DOCUMENT",
      documentId,
      chunk.content,
      domain,
      confidence,
      chunk.index,
      chunkSource,
      chunk.contentSha,
    );
  }

  const sql = `INSERT INTO "evidences" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES ${placeholders.join(", ")}`;
  // `$executeRawUnsafe` because the SQL body is built from a trusted
  // template + parameter placeholders; user-supplied values flow
  // through `values` which are bound, not concatenated.
  await tx.$executeRawUnsafe(sql, ...values);
}

/**
 * Auto-classify the chunks just inserted for a Document into the
 * assessment's active domains (Option B). No-op when the operator
 * hasn't enabled the feature, the assessment has no active domains,
 * or the AI router fails — chunks stay in the catch-all bucket and
 * the analysis engine still reads them (ADR-0020 soft-failure).
 *
 * Done as a separate Postgres pass (post-transaction) on purpose:
 * the AI call can take seconds; we don't want to hold the ingest
 * transaction open for it.
 */
async function maybeAutoClassifyChunks(
  documentId: string,
  assessmentId: string,
): Promise<void> {
  const enabled = await getSetting<boolean | null>(
    db,
    SETTING_KEYS.featureAutoClassifyChunks,
    null,
  );
  if (enabled !== true) return;

  const assessment = await db.assessment.findUnique({
    where: { id: assessmentId },
    select: { activeDomains: true },
  });
  if (!assessment || assessment.activeDomains.length === 0) return;

  const evidences = await db.evidence.findMany({
    where: { documentId },
    select: { id: true, content: true },
    orderBy: { chunkIndex: "asc" },
  });
  if (evidences.length === 0) return;

  const startedAt = Date.now();
  try {
    const { domainByChunkId, warnings, tokens } =
      await classifyChunkDomains({
        activeDomains: assessment.activeDomains,
        chunks: evidences.map((e) => ({ id: e.id, text: e.content })),
        audit: { documentId },
      });

    if (domainByChunkId.size > 0) {
      // Group ids by their assigned domain so we can fire one UPDATE
      // per domain rather than N per-row writes.
      const byDomain = new Map<string, string[]>();
      for (const [id, dom] of domainByChunkId) {
        if (!byDomain.has(dom)) byDomain.set(dom, []);
        byDomain.get(dom)!.push(id);
      }
      for (const [dom, ids] of byDomain) {
        await db.evidence.updateMany({
          where: { id: { in: ids } },
          data: { domain: dom },
        });
      }
    }

    await db.auditLog
      .create({
        data: {
          action: "CHUNK_DOMAINS_CLASSIFIED",
          entityType: "Document",
          entityId: documentId,
          details: {
            classified: domainByChunkId.size,
            total: evidences.length,
            warnings: warnings.slice(0, 5),
            tokens,
            durationMs: Date.now() - startedAt,
          },
        },
      })
      .catch(() => {
        /* best-effort */
      });
    log.info("chunk auto-classification complete", {
      worker: "ingest-document",
      documentId,
      classified: domainByChunkId.size,
      total: evidences.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("chunk auto-classification failed", {
      worker: "ingest-document",
      documentId,
      error: msg,
    });
    await db.auditLog
      .create({
        data: {
          action: "CHUNK_DOMAINS_CLASSIFY_FAILED",
          entityType: "Document",
          entityId: documentId,
          details: { error: msg },
        },
      })
      .catch(() => {
        /* best-effort */
      });
  }
}
