import { describe, expect, it } from "vitest";
import {
  clusterChunks,
  cosineSimilarity,
  DEFAULT_DUPLICATE_COSINE,
  type RankedChunk,
} from "./evidence-clusterer";

// Unit tests for the Week 7 near-duplicate clusterer (ADR-0011).
// The clusterer is a pure function — no Prisma / IO — so these tests
// run without any mock scaffolding.

function chunk(
  id: string,
  embedding: number[],
  similarity: number,
  source?: string,
): RankedChunk {
  return { evidenceId: id, content: id, embedding, similarity, source };
}

describe("clusterChunks", () => {
  it("collapses identical embeddings into a single cluster", () => {
    const e = [1, 0, 0];
    const input = [
      chunk("a", e, 0.9, "doc-1"),
      chunk("b", e, 0.88, "doc-2"),
      chunk("c", e, 0.87, "doc-1"),
    ];
    const out = clusterChunks(input);
    expect(out).toHaveLength(1);
    expect(out[0].representativeId).toBe("a");
    expect(out[0].memberIds).toEqual(["a", "b", "c"]);
    expect(out[0].duplicateCount).toBe(3);
    expect(out[0].sources).toEqual(["doc-1", "doc-2"]);
  });

  it("keeps orthogonal chunks as singleton clusters", () => {
    const input = [
      chunk("x", [1, 0, 0], 0.9),
      chunk("y", [0, 1, 0], 0.8),
      chunk("z", [0, 0, 1], 0.7),
    ];
    const out = clusterChunks(input);
    expect(out.map((c) => c.representativeId)).toEqual(["x", "y", "z"]);
    for (const c of out) expect(c.duplicateCount).toBe(1);
  });

  it("preserves highest-similarity representative (retriever order)", () => {
    // Ranked by similarity descending; "a" should win representation
    // even though "b"'s embedding is numerically smaller.
    const e1 = [1, 0];
    const e2 = [0.999, 0.01];
    const input = [
      chunk("a", e1, 0.95),
      chunk("b", e2, 0.80),
    ];
    const out = clusterChunks(input, { threshold: 0.9 });
    expect(out).toHaveLength(1);
    expect(out[0].representativeId).toBe("a");
    expect(out[0].representative.similarity).toBe(0.95);
  });

  it("respects a custom threshold — loose merges what tight would not", () => {
    // Two vectors ~0.80 cosine apart — merged at 0.5, split at 0.95.
    const input = [chunk("p", [1, 0, 0], 0.9), chunk("q", [0.8, 0.6, 0], 0.85)];
    const tight = clusterChunks(input, { threshold: 0.95 });
    const loose = clusterChunks(input, { threshold: 0.5 });
    expect(tight).toHaveLength(2);
    expect(loose).toHaveLength(1);
  });

  it("handles empty input", () => {
    expect(clusterChunks([])).toEqual([]);
  });

  it("does not duplicate sources within a cluster", () => {
    const e = [1, 0];
    const input = [
      chunk("a", e, 0.9, "doc-1"),
      chunk("b", e, 0.85, "doc-1"),
      chunk("c", e, 0.80, "doc-1"),
    ];
    const out = clusterChunks(input);
    expect(out[0].sources).toEqual(["doc-1"]);
  });

  it("defaults threshold to DEFAULT_DUPLICATE_COSINE when unset", () => {
    // At default 0.95, a near-identical vector should merge.
    const e = [1, 0, 0];
    const ePerturbed = [0.9999, 0.01, 0];
    const out = clusterChunks([
      chunk("a", e, 0.9),
      chunk("b", ePerturbed, 0.85),
    ]);
    expect(DEFAULT_DUPLICATE_COSINE).toBe(0.95);
    expect(out).toHaveLength(1);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
  });
  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("returns 0 on length mismatch", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
  it("returns 0 on zero-norm vectors", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
