import mammoth from "mammoth";

/**
 * Text extraction + naive chunking for uploaded documents.
 *
 * As of Phase 3 Week 1 (ADR-0001) this module is intentionally
 * AI-free. The previous `analyzeDocumentWithAI()` path — one Claude
 * call per ingested document — has been removed. Per-document AI
 * analysis now lives on the per-assessment `run-analysis` job, which
 * reads Evidence rows directly (Option A in the roadmap).
 *
 * A richer recursive chunker lands in Week 3 alongside the embedding
 * foundation. For Week 1 we keep the shape trivial: one Evidence row
 * per non-empty chunk. This is enough for the rest of the pipeline to
 * continue working while the AI is moved off-path.
 */

export interface DocumentChunk {
  /** Stable per-document ordinal, 0-indexed. */
  index: number;
  /** Chunk text — already trimmed; never empty. */
  content: string;
}

// Default chunk size for Week 1. Keep it conservative so the resulting
// Evidence rows stay readable as-is when the downstream analyse step
// stringifies them into prompts. Week 3 replaces this with a recursive
// heading/paragraph/sentence splitter.
export const DEFAULT_CHUNK_CHARS = 2_000;

/**
 * Extract plain text from a document buffer. Supports PDF, DOCX, and any
 * plain-text flavor (.txt, .md, .json, source code, raw diagram DSLs). We
 * fall back to UTF-8 decode on unknown MIME types — worst case the chunker
 * produces gibberish chunks and the ingest job flags the doc as FAILED
 * via the "empty text" branch below.
 */
export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<string> {
  const lower = filename.toLowerCase();

  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
    // Lazy-load pdf-parse. Its index.js has a dev-only filesystem probe
    // that blows up when imported at module scope in Next's bundler; the
    // lib/pdf-parse submodule skips it.
    const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
    const parsed = await pdfParse(buffer);
    return parsed.text;
  }

  if (
    mimeType.includes("wordprocessingml") ||
    lower.endsWith(".docx")
  ) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }

  // Everything else we treat as UTF-8 text. Binary formats will end up
  // with unusable output, which is intentional — the ingest job will
  // flag them for re-upload in a supported format.
  return buffer.toString("utf-8");
}

/**
 * Legacy fixed-window splitter — kept as a thin compatibility shim so
 * any code still calling `chunkDocumentText` (Week 1 semantics: naive
 * paragraph packing with a character ceiling) keeps working. The Week
 * 3 ingest path invokes `chunkText` from `./document-chunker` directly
 * so it can persist heading trails, offsets, and `contentSha` onto the
 * Evidence row.
 */
export function chunkDocumentText(
  text: string,
  opts: { maxChars?: number } = {},
): DocumentChunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_CHUNK_CHARS;
  if (maxChars <= 0) {
    throw new Error("chunkDocumentText: maxChars must be > 0");
  }
  const trimmed = text.trim();
  if (!trimmed) return [];

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer.trim().length > 0) chunks.push(buffer.trim());
    buffer = "";
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      flush();
      for (let i = 0; i < para.length; i += maxChars) {
        chunks.push(para.slice(i, i + maxChars));
      }
      continue;
    }
    if (buffer.length + para.length + 2 > maxChars) {
      flush();
    }
    buffer = buffer ? `${buffer}\n\n${para}` : para;
  }
  flush();

  return chunks.map((content, index) => ({ index, content }));
}

/**
 * Produce a short, AI-free summary for the `Document.extractedSummary`
 * column. Populated from the first chunk rather than Claude so ingest
 * never pays AI cost — the column is cosmetic UI-only, the downstream
 * analysis reads from Evidence.
 */
export function summaryFromChunks(
  chunks: DocumentChunk[],
  maxChars = 300,
): string | null {
  const first = chunks[0]?.content;
  if (!first) return null;
  const single = first.replace(/\s+/g, " ").trim();
  if (single.length <= maxChars) return single;
  return `${single.slice(0, maxChars - 1)}…`;
}
