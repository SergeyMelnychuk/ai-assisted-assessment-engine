import { describe, expect, it } from "vitest";
import { chunkText, computeContentSha, CHARS_PER_TOKEN } from "./document-chunker";

// Unit tests for the Week 3 recursive chunker (ADR-0004). Runs as a
// pure module test — no DB, no AI, no network.

describe("chunkText", () => {
  it("returns an empty array for whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n\t")).toEqual([]);
  });

  it("produces stable output for identical input", () => {
    const text = "# Intro\n\nAlpha paragraph.\n\nBeta paragraph with more text.";
    const a = chunkText(text);
    const b = chunkText(text);
    expect(a).toEqual(b);
    expect(a.map((c) => c.contentSha)).toEqual(b.map((c) => c.contentSha));
  });

  it("attaches the nearest preceding heading", () => {
    const text =
      "# Introduction\n\nIntro body.\n\n" +
      "## Security\n\nSecurity body one.\n\nSecurity body two.";
    const chunks = chunkText(text, { targetTokens: 50 });
    const securityChunks = chunks.filter((c) => c.heading === "Security");
    const introChunks = chunks.filter((c) => c.heading === "Introduction");
    expect(securityChunks.length).toBeGreaterThan(0);
    expect(introChunks.length).toBeGreaterThan(0);
    // A chunk under "Security" never contains "Intro body" (heading
    // boundary respect).
    for (const c of securityChunks) {
      expect(c.content).not.toContain("Intro body");
    }
  });

  it("starts a fresh chunk on a new heading", () => {
    const text =
      "# A\n\nbody a.\n\n# B\n\nbody b.";
    const chunks = chunkText(text, { targetTokens: 1000 });
    // Even with a huge target, the two headings must split.
    expect(chunks.length).toBe(2);
    expect(chunks[0].heading).toBe("A");
    expect(chunks[1].heading).toBe("B");
  });

  it("produces adjacent chunks whose tail/head overlap by ~overlapTokens", () => {
    // Build a long heading-less body so the chunker is forced to
    // split mid-section.
    const paragraphs: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      paragraphs.push(
        `Paragraph ${i} — ${"lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(3)}`,
      );
    }
    const text = paragraphs.join("\n\n");
    const chunks = chunkText(text, { targetTokens: 100, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    const overlapChars = 20 * CHARS_PER_TOKEN;
    // Chunk N's tail must appear in chunk N+1's head. We check on the
    // first ~overlapChars of N+1's content.
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const tail = chunks[i].content.slice(-overlapChars);
      const head = chunks[i + 1].content.slice(0, overlapChars * 2);
      // Allow the "\n\n" separator the packer inserts.
      const tailFirstWord = tail.trim().split(/\s+/).slice(-3).join(" ");
      if (tailFirstWord.length > 4) {
        expect(head).toContain(tailFirstWord.slice(0, Math.min(tailFirstWord.length, 20)));
      }
    }
  });

  it("never splits a UTF-16 surrogate pair on a hard-wrap boundary", () => {
    // 𝕏 (U+1D54F) is a non-BMP character — two UTF-16 code units. If
    // we split mid-surrogate the decoded chunk would contain a lone
    // unpaired surrogate (0xD835 or 0xDD4F) and JSON.stringify would
    // explode. We use a long paragraph of these so the chunker is
    // forced to slice through them.
    const emoji = "𝕏"; // two code units, one codepoint
    const body = emoji.repeat(5000);
    const chunks = chunkText(body, { targetTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Round-trip through JSON to detect lone surrogates.
      expect(() => JSON.parse(JSON.stringify(c.content))).not.toThrow();
      // And no surrogate appears alone at either end.
      const first = c.content.charCodeAt(0);
      const last = c.content.charCodeAt(c.content.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("assigns monotonic 0-based indices", () => {
    const text = `# A\n\n${"blah ".repeat(500)}\n\n# B\n\n${"blah ".repeat(500)}`;
    const chunks = chunkText(text, { targetTokens: 100 });
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("rejects invalid options", () => {
    expect(() => chunkText("x", { targetTokens: 0 })).toThrow();
    expect(() => chunkText("x", { targetTokens: -1 })).toThrow();
    expect(() => chunkText("x", { overlapTokens: -1 })).toThrow();
    expect(() =>
      chunkText("x", { targetTokens: 10, overlapTokens: 10 }),
    ).toThrow();
  });
});

describe("computeContentSha", () => {
  it("is stable and trim-insensitive", () => {
    expect(computeContentSha("hello")).toBe(computeContentSha("  hello\n"));
    expect(computeContentSha("a")).not.toBe(computeContentSha("b"));
    // SHA-256 is 64 hex chars.
    expect(computeContentSha("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
