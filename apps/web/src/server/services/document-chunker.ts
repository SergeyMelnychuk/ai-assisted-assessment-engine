import { createHash } from "node:crypto";

/**
 * Recursive heading → paragraph → sentence splitter for Phase 3 Week 3
 * (ADR-0004). Produces chunk records the embedding service turns into
 * vectors, and the ingest job persists alongside Evidence rows.
 *
 * Token estimation is the ubiquitous `Math.ceil(text.length / 4)`
 * heuristic — off by ~10–20% on English prose, wildly off on code or
 * CJK text, and we accept that error band. The alternative is shipping
 * a WASM tokenizer in the worker image, which we've explicitly rejected
 * for MVP (see ADR-0004). The chunker targets coarse chunk boundaries;
 * exact token counts only matter for the embedding API's per-call
 * batching ceiling, which `embedding-service.ts` bounds separately.
 *
 * Targets (from ADR-0004):
 *   - ~800 tokens per chunk (≈ 3,200 chars)
 *   - ~100 tokens overlap between adjacent chunks (≈ 400 chars)
 *   - heading lines start a fresh chunk
 *   - chunks never straddle headings when avoidable
 *
 * The output is stable: identical input → identical chunks, in the
 * same order. `chunk_index` is the 0-based ordinal; `startOffset` /
 * `endOffset` are byte-safe string offsets in the *trimmed* input.
 */

// Rough chars-per-token. Documented heuristic — callers and the ADR
// reference this constant so the trade-off stays visible.
export const CHARS_PER_TOKEN = 4;

export interface Chunk {
  /** 0-based ordinal in the source document. Stable for identical input. */
  index: number;
  /** Chunk text, already trimmed; never empty. */
  content: string;
  /** Nearest Markdown/ATX heading preceding the chunk, or `null`. */
  heading: string | null;
  /** Offset (inclusive) in the *trimmed* source text. */
  startOffset: number;
  /** Offset (exclusive) in the *trimmed* source text. */
  endOffset: number;
  /** SHA-256 hex of the chunk content. Used for idempotent re-embed. */
  contentSha: string;
}

export interface ChunkOptions {
  /** Soft ceiling in tokens; default 800. */
  targetTokens?: number;
  /** Requested overlap between adjacent chunks, in tokens; default 100. */
  overlapTokens?: number;
}

const DEFAULT_TARGET_TOKENS = 800;
const DEFAULT_OVERLAP_TOKENS = 100;

// ── Public API ────────────────────────────────────────────────────

/**
 * Split `text` into chunks respecting heading boundaries, targeting
 * `targetTokens` per chunk with `overlapTokens` overlap between
 * adjacent chunks. Returns an empty array for whitespace-only input.
 */
export function chunkText(
  text: string,
  opts: ChunkOptions = {},
): Chunk[] {
  const targetTokens = opts.targetTokens ?? DEFAULT_TARGET_TOKENS;
  // Auto-scale the default overlap when the caller supplies a target
  // smaller than the production default (tests exercise tiny chunks).
  // Callers that pass `overlapTokens` explicitly still get strict
  // validation below.
  const defaultOverlap = Math.min(
    DEFAULT_OVERLAP_TOKENS,
    Math.max(1, Math.floor(targetTokens / 8)),
  );
  const overlapTokens = opts.overlapTokens ?? defaultOverlap;
  if (targetTokens <= 0) {
    throw new Error("chunkText: targetTokens must be > 0");
  }
  if (overlapTokens < 0 || overlapTokens >= targetTokens) {
    throw new Error(
      "chunkText: overlapTokens must be >= 0 and < targetTokens",
    );
  }

  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return [];

  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  // Phase 1: split into heading-delimited sections. A section owns a
  // single heading (or `null` for the pre-heading prologue) and its
  // body. We never merge a section with one whose heading differs —
  // that's the "heading-boundary respect" invariant the tests pin.
  const sections = splitByHeadings(trimmed);

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const sectionChunks = chunkSection(
      section,
      targetChars,
      overlapChars,
    );
    chunks.push(...sectionChunks);
  }

  // Re-index + re-hash so callers get a monotonic, stable `index` and a
  // canonical `contentSha` without having to thread it through the
  // section loop.
  return chunks.map((c, i) => ({
    ...c,
    index: i,
    contentSha: computeContentSha(c.content),
  }));
}

/**
 * SHA-256 hex of the trimmed content. Exposed so the ingest job and
 * backfill script can compute change-detection hashes without pulling
 * in `node:crypto` directly.
 */
export function computeContentSha(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

// ── Internals ─────────────────────────────────────────────────────

interface Section {
  heading: string | null;
  body: string;
  /** Start offset of `body` in the original trimmed text. */
  offset: number;
}

// Markdown ATX headings (#, ##, …). Setext (underline) headings are
// rare in our corpora (RFPs, Word exports); punting on them keeps the
// splitter tight.
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

function splitByHeadings(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];

  let currentHeading: string | null = null;
  let buffer: string[] = [];
  let bufferStartLine = 0;

  // Running char offset so `offset` is in terms of the original string,
  // not line count. Matches what the tests and source-trail UI expect.
  let charOffset = 0;
  const lineOffsets: number[] = [];
  for (const line of lines) {
    lineOffsets.push(charOffset);
    charOffset += line.length + 1; // +1 for the '\n' join
  }

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (!body) return;
    sections.push({
      heading: currentHeading,
      body,
      offset: lineOffsets[bufferStartLine] ?? 0,
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(HEADING_RE);
    if (m) {
      flush();
      currentHeading = m[2].trim();
      buffer = [];
      bufferStartLine = i + 1;
      continue;
    }
    buffer.push(line);
  }
  flush();

  // If the document has no headings at all we still need a single
  // anonymous section.
  if (sections.length === 0) {
    sections.push({ heading: null, body: text.trim(), offset: 0 });
  }
  return sections;
}

/**
 * Chunk a single heading-scoped section. Greedy pack paragraphs into
 * the target window; if a paragraph alone exceeds the window, fall back
 * to sentence splitting; if a sentence alone still exceeds, hard-wrap
 * on codepoint boundaries (never on UTF-16 surrogates, never mid-char).
 */
function chunkSection(
  section: Section,
  targetChars: number,
  overlapChars: number,
): Chunk[] {
  const paragraphs = splitParagraphs(section.body);
  const pieces: { text: string; offset: number }[] = [];
  let cursor = 0;

  for (const para of paragraphs) {
    const paraStart = section.body.indexOf(para, cursor);
    cursor = paraStart + para.length;
    if (para.length <= targetChars) {
      pieces.push({ text: para, offset: paraStart });
      continue;
    }
    // Paragraph is too long — fall back to sentence split.
    const sentences = splitSentences(para);
    let innerCursor = paraStart;
    for (const sent of sentences) {
      const sStart = section.body.indexOf(sent, innerCursor);
      innerCursor = sStart + sent.length;
      if (sent.length <= targetChars) {
        pieces.push({ text: sent, offset: sStart });
      } else {
        // Hard-wrap preserving UTF-8 codepoint integrity.
        for (
          let i = 0;
          i < sent.length;
          i += targetChars
        ) {
          const slice = safeSlice(sent, i, i + targetChars);
          pieces.push({ text: slice.text, offset: sStart + slice.start });
          if (slice.consumed < targetChars && i + targetChars < sent.length) {
            // `safeSlice` rewound to avoid a surrogate split — resume
            // from the actual consumed boundary.
            i -= targetChars - slice.consumed;
          }
        }
      }
    }
  }

  // Pack pieces into chunks, respecting the target ceiling and the
  // overlap requirement. Overlap is implemented by replaying the tail
  // of chunk N at the head of chunk N+1.
  const chunks: Chunk[] = [];
  let current = "";
  let currentStart = -1;

  const flush = (endOffset: number) => {
    const content = current.trim();
    if (!content) return;
    const absStart = section.offset + Math.max(0, currentStart);
    chunks.push({
      index: 0, // Re-numbered by the outer `chunkText`.
      content,
      heading: section.heading,
      startOffset: absStart,
      endOffset: section.offset + endOffset,
      contentSha: "", // Filled by the outer `chunkText`.
    });
  };

  for (const piece of pieces) {
    if (currentStart < 0) currentStart = piece.offset;
    const separator = current ? "\n\n" : "";
    const candidate = current + separator + piece.text;
    if (candidate.length <= targetChars) {
      current = candidate;
      continue;
    }
    // Flush the current chunk.
    flush(currentStart + current.length);
    // Build the overlap prefix from the tail of the just-flushed chunk.
    const overlap = overlapChars > 0
      ? tailSlice(current, overlapChars)
      : "";
    current = overlap ? `${overlap}\n\n${piece.text}` : piece.text;
    currentStart = piece.offset - (overlap.length ? overlap.length + 2 : 0);
  }
  if (current) {
    flush(currentStart + current.length);
  }

  return chunks;
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// Cheap sentence-ish splitter. `?!.` followed by whitespace + capital /
// digit / quote. Not perfect — nothing short of a full NLP pipeline is
// — but good enough to break up a 10k-char runaway paragraph.
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“‘])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Take the last `n` characters of `s` without splitting a UTF-16
 * surrogate pair. Used to build the overlap prefix on the next chunk.
 */
function tailSlice(s: string, n: number): string {
  if (s.length <= n) return s;
  let start = s.length - n;
  // If we landed on a low surrogate, step back one so we grab the full
  // codepoint rather than half of it.
  const code = s.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start -= 1;
  return s.slice(start);
}

/**
 * Slice `[start, end)` from `s`, but if `end` falls inside a surrogate
 * pair, rewind to the preceding codepoint boundary. Returns the sliced
 * text plus how many characters it actually consumed so the caller can
 * advance its cursor correctly.
 */
function safeSlice(
  s: string,
  start: number,
  end: number,
): { text: string; start: number; consumed: number } {
  const clampedEnd = Math.min(end, s.length);
  let realEnd = clampedEnd;
  if (realEnd < s.length) {
    const code = s.charCodeAt(realEnd - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      // We'd split a surrogate pair — rewind one.
      realEnd -= 1;
    }
  }
  return {
    text: s.slice(start, realEnd),
    start,
    consumed: realEnd - start,
  };
}
