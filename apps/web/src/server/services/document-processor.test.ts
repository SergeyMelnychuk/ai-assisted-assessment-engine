import { describe, expect, it, vi } from "vitest";
import {
  chunkDocumentText,
  extractDocumentText,
  summaryFromChunks,
  DEFAULT_CHUNK_CHARS,
} from "./document-processor";

// Unit tests for the trimmed document-processor (Week 1, ADR-0001).
//
// The module must NOT call Claude. We install a throwing mock on the
// AI client module to prove it: any path that tries to import
// `claude-client` would need to be updated here and would fail.

vi.mock("./ai/router", () => ({
  callClaude: vi.fn(() => {
    throw new Error(
      "document-processor must not call Claude (Week 1 decoupling)",
    );
  }),
  parseJsonResponse: vi.fn(() => {
    throw new Error("document-processor must not parse AI responses");
  }),
}));

describe("extractDocumentText", () => {
  it("decodes plain text as UTF-8", async () => {
    const buf = Buffer.from("hello world\n\nsecond paragraph", "utf-8");
    const out = await extractDocumentText(buf, "text/plain", "notes.txt");
    expect(out).toContain("hello world");
    expect(out).toContain("second paragraph");
  });

  it("handles markdown via the text fallback", async () => {
    const buf = Buffer.from("# Heading\n\nBody.", "utf-8");
    const out = await extractDocumentText(buf, "text/markdown", "readme.md");
    expect(out).toContain("Heading");
  });
});

describe("chunkDocumentText", () => {
  it("returns an empty array for whitespace-only input", () => {
    expect(chunkDocumentText("")).toEqual([]);
    expect(chunkDocumentText("   \n\n  ")).toEqual([]);
  });

  it("produces one chunk for a short document", () => {
    const chunks = chunkDocumentText("a short paragraph");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ index: 0, content: "a short paragraph" });
  });

  it("splits on blank lines and preserves order", () => {
    const text = "one\n\ntwo\n\nthree";
    const chunks = chunkDocumentText(text, { maxChars: 10 });
    const contents = chunks.map((c) => c.content);
    // Each paragraph is ~3 chars so they batch — but the total (13 chars)
    // exceeds maxChars=10 so the third paragraph rolls to a new chunk.
    expect(contents.length).toBeGreaterThanOrEqual(2);
    expect(contents.join(" ")).toContain("one");
    expect(contents.join(" ")).toContain("two");
    expect(contents.join(" ")).toContain("three");
    // Indices are stable 0..N-1.
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("hard-wraps paragraphs larger than the window", () => {
    const big = "x".repeat(DEFAULT_CHUNK_CHARS * 2 + 13);
    const chunks = chunkDocumentText(big);
    // Should split into 3 chunks (2 full windows + remainder).
    expect(chunks.length).toBe(3);
    expect(chunks[0].content.length).toBe(DEFAULT_CHUNK_CHARS);
    expect(chunks[1].content.length).toBe(DEFAULT_CHUNK_CHARS);
    expect(chunks[2].content.length).toBe(13);
  });

  it("rejects non-positive maxChars", () => {
    expect(() => chunkDocumentText("abc", { maxChars: 0 })).toThrow();
    expect(() => chunkDocumentText("abc", { maxChars: -5 })).toThrow();
  });
});

describe("summaryFromChunks", () => {
  it("returns null for an empty chunk list", () => {
    expect(summaryFromChunks([])).toBeNull();
  });

  it("returns the first chunk content when it fits", () => {
    const chunks = chunkDocumentText("short");
    expect(summaryFromChunks(chunks)).toBe("short");
  });

  it("truncates with an ellipsis beyond the limit", () => {
    const chunks = [{ index: 0, content: "a".repeat(500) }];
    const summary = summaryFromChunks(chunks, 50);
    expect(summary).toHaveLength(50);
    expect(summary!.endsWith("…")).toBe(true);
  });
});
