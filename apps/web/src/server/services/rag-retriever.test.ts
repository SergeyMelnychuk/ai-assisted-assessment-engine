import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { retrieve } from "./rag-retriever";

// Unit tests for the RAG retriever (Phase 3 Week 4, ADR-0006/0007).
//
// We mock the embedding service so no network is needed, and stub
// `prisma.$queryRaw` so we can assert the SQL shape (`<=>` operator,
// topK limit, optional domain filter) and exercise the hybrid fallback
// policy without touching a real Postgres + pgvector.

vi.mock("./ai/embedding-service", () => ({
  // Return a deterministic 4-dim vector (real prod dim is 1536 but the
  // retriever is dimension-agnostic — we only need something stringifiable).
  embed: vi.fn(async (texts: string[]) =>
    texts.map((_, i) => [0.1, 0.2, 0.3, 0.4 + i]),
  ),
}));

// Hybrid retrieval (ADR-0027) is read via the feature-flag helper —
// every existing test exercises the cosine path, so stub the helper
// to return `false` by default. The dedicated hybrid test below flips
// it on for one call via `mockResolvedValueOnce`.
vi.mock("./agent/feature-flag", () => ({
  isHybridRetrievalEnabled: vi.fn(async () => false),
}));

type QueryRawCall = {
  strings: readonly string[];
  values: unknown[];
};

interface FakeDb {
  $queryRaw: ReturnType<typeof vi.fn>;
  calls: QueryRawCall[];
}

function makeDb(results: Array<Array<Record<string, unknown>>>): FakeDb {
  const calls: QueryRawCall[] = [];
  let idx = 0;
  const $queryRaw = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    const next = results[idx] ?? [];
    idx += 1;
    return Promise.resolve(next);
  });
  return { $queryRaw, calls } as unknown as FakeDb;
}

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? "ev1",
    content: overrides.content ?? "chunk text",
    distance: overrides.distance ?? 0.1,
    chunk_index: overrides.chunk_index ?? 0,
    chunk_source: overrides.chunk_source ?? { heading: "Intro" },
    source_document_id: overrides.source_document_id ?? "doc1",
    domain: overrides.domain ?? "security",
  };
}

describe("retrieve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty for empty query without touching prisma", async () => {
    const fake = makeDb([]);
    const out = await retrieve(fake as unknown as PrismaClient, {
      assessmentId: "a1",
      query: "   ",
    });
    expect(out).toEqual([]);
    expect(fake.$queryRaw).not.toHaveBeenCalled();
  });

  it("issues one cosine query with topK and no domain filter by default", async () => {
    const fake = makeDb([[row({ id: "e1", distance: 0.1 }), row({ id: "e2", distance: 0.2 })]]);
    const out = await retrieve(fake as unknown as PrismaClient, {
      assessmentId: "a1",
      query: "authentication",
      topK: 10,
    });

    expect(out).toHaveLength(2);
    expect(fake.$queryRaw).toHaveBeenCalledTimes(1);
    const call = fake.calls[0]!;
    const outerSql = call.strings.join("?");
    // Assert the operator shape and the LIMIT / ORDER BY shape on the
    // outer template.
    expect(outerSql).toMatch(/<=>/);
    expect(outerSql).toMatch(/ORDER BY/);
    expect(outerSql).toMatch(/LIMIT/);

    // The WHERE clause is composed via Prisma.sql — inspect its
    // contents to assert filter shape and parameter binding.
    const whereSql = inspectComposedWhere(call.values);
    expect(whereSql.text).toMatch(/assessment_id =/);
    expect(whereSql.values).toContain("a1");
    // No domain fragment on the default path.
    expect(whereSql.text).not.toMatch(/domain =/);
    // No documentId fragment when not provided.
    expect(whereSql.text).not.toMatch(/document_id =/);
    // topK is passed as a bind param on the outer template.
    expect(call.values).toContain(10);

    // Similarity = 1 - distance, clamped to [0, 1].
    expect(out[0]!.similarity).toBeCloseTo(0.9, 5);
    expect(out[1]!.similarity).toBeCloseTo(0.8, 5);
  });

  it("adds the domain filter to the SQL when domain is supplied", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ id: `e${i}`, distance: 0.1, domain: "security" }),
    );
    const fake = makeDb([rows]);
    await retrieve(fake as unknown as PrismaClient, {
      assessmentId: "a1",
      query: "encryption at rest",
      domain: "security",
      topK: 20,
    });

    expect(fake.$queryRaw).toHaveBeenCalledTimes(1);
    const call = fake.calls[0]!;
    const whereSql = inspectComposedWhere(call.values);
    expect(whereSql.text).toMatch(/domain =/);
    // Matches analysis-engine semantics: domain filter widens to
    // include the catch-all 'ingested' bucket.
    expect(whereSql.text).toMatch(/'ingested'/);
    expect(whereSql.values).toContain("security");
  });

  it("adds the document filter to the SQL when documentIds is supplied", async () => {
    const fake = makeDb([[row({ id: "e1", distance: 0.1 })]]);
    await retrieve(fake as unknown as PrismaClient, {
      assessmentId: "a1",
      query: "rollback",
      documentIds: ["doc-42", "doc-7"],
      topK: 5,
    });

    expect(fake.$queryRaw).toHaveBeenCalledTimes(1);
    const whereSql = inspectComposedWhere(fake.calls[0]!.values);
    expect(whereSql.text).toMatch(/document_id IN/);
    // Both ids end up bound, either directly or nested inside a
    // Prisma.join array — flatten the values tree to assert.
    const flat = flattenValues(whereSql.values);
    expect(flat).toContain("doc-42");
    expect(flat).toContain("doc-7");
  });

  it("treats an empty documentIds array as 'all documents'", async () => {
    const fake = makeDb([[row({ id: "e1", distance: 0.1 })]]);
    await retrieve(fake as unknown as PrismaClient, {
      assessmentId: "a1",
      query: "anything",
      documentIds: [],
      topK: 5,
    });

    expect(fake.$queryRaw).toHaveBeenCalledTimes(1);
    const whereSql = inspectComposedWhere(fake.calls[0]!.values);
    expect(whereSql.text).not.toMatch(/document_id/);
  });

  it("triggers the fallback query when domain-filtered result underfills topK", async () => {
    // First call returns only 3 rows — below both topK (20) and the
    // `Math.max(5, topK/2) = 10` widen threshold.
    const primary = [
      row({ id: "p1", distance: 0.1 }),
      row({ id: "p2", distance: 0.2 }),
      row({ id: "p3", distance: 0.3 }),
    ];
    const widened = Array.from({ length: 20 }, (_, i) =>
      row({ id: `w${i}`, distance: 0.4, domain: "architecture" }),
    );
    const fake = makeDb([primary, widened]);

    const out = await retrieve(fake as unknown as PrismaClient, {
      assessmentId: "a1",
      query: "zero trust posture",
      domain: "security",
      topK: 20,
    });

    expect(fake.$queryRaw).toHaveBeenCalledTimes(2);
    // Second call must be the widened (no-domain) shape.
    const secondWhere = inspectComposedWhere(fake.calls[1]!.values);
    expect(secondWhere.text).not.toMatch(/domain =/);

    // Domain hits stay at the front; widened hits fill the rest.
    expect(out.slice(0, 3).map((c) => c.evidenceId)).toEqual(["p1", "p2", "p3"]);
    expect(out).toHaveLength(20);
    // De-duplication: no evidenceId appears twice.
    const ids = out.map((c) => c.evidenceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not trigger fallback when there is no domain filter to widen", async () => {
    const only = [row({ id: "x1", distance: 0.1 })];
    const fake = makeDb([only]);

    const out = await retrieve(fake as unknown as PrismaClient, {
      assessmentId: "a1",
      query: "anything",
      topK: 20,
    });

    expect(fake.$queryRaw).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
  });

  it("respects minSimilarity when filtering results", async () => {
    const mixed = [
      row({ id: "hi", distance: 0.1 }), // sim 0.9
      row({ id: "lo", distance: 0.9 }), // sim 0.1
    ];
    const fake = makeDb([mixed]);

    const out = await retrieve(fake as unknown as PrismaClient, {
      assessmentId: "a1",
      query: "anything",
      minSimilarity: 0.5,
    });

    expect(out.map((c) => c.evidenceId)).toEqual(["hi"]);
  });

  // ── ADR-0027 hybrid retrieval ────────────────────────────────────

  it("dispatches to the hybrid SQL when features.hybridRetrieval is on", async () => {
    const { isHybridRetrievalEnabled } = await import("./agent/feature-flag");
    (isHybridRetrievalEnabled as unknown as Mock).mockResolvedValueOnce(
      true,
    );
    // One result row in the hybrid shape: includes rrf_score +
    // dense_rank + lexical_rank.
    const fake = makeDb([
      [
        {
          id: "h1",
          content: "fused result",
          distance: 0.2,
          chunk_index: 0,
          chunk_source: { heading: "Section A" },
          source_document_id: "doc1",
          domain: "security",
          rrf_score: 0.0312,
          dense_rank: 1,
          lexical_rank: 3,
        },
      ],
    ]);

    const out = await retrieve(fake as unknown as PrismaClient, {
      assessmentId: "a1",
      query: "ECONNRESET",
      topK: 10,
    });

    // One DB call, the hybrid CTE shape.
    expect(fake.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = fake.calls[0]!.strings.join("?");
    expect(sql).toMatch(/WITH dense AS/);
    expect(sql).toMatch(/lex AS/);
    expect(sql).toMatch(/plainto_tsquery/);
    expect(sql).toMatch(/rrf_score/);

    // Result carries the per-side ranks + RRF score.
    expect(out).toHaveLength(1);
    expect(out[0]!.evidenceId).toBe("h1");
    expect(out[0]!.rrfScore).toBeCloseTo(0.0312, 4);
    expect(out[0]!.denseRank).toBe(1);
    expect(out[0]!.lexicalRank).toBe(3);
    // Similarity still derived from cosine distance.
    expect(out[0]!.similarity).toBeCloseTo(0.8, 5);
  });

  it("hybrid path skips the widen-on-underfill fallback", async () => {
    const { isHybridRetrievalEnabled } = await import("./agent/feature-flag");
    (isHybridRetrievalEnabled as unknown as Mock).mockResolvedValueOnce(
      true,
    );
    // Return just one row even though topK=20 — under the legacy
    // cosine path this would trigger a second (widening) query. The
    // hybrid path is single-shot.
    const fake = makeDb([
      [
        {
          id: "h1",
          content: "x",
          distance: 0.1,
          chunk_index: 0,
          chunk_source: null,
          source_document_id: null,
          domain: null,
          rrf_score: 0.02,
          dense_rank: 1,
          lexical_rank: null,
        },
      ],
    ]);

    const out = await retrieve(fake as unknown as PrismaClient, {
      assessmentId: "a1",
      query: "anything",
      domain: "security",
      topK: 20,
    });

    expect(fake.$queryRaw).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out[0]!.lexicalRank).toBeNull();
  });
});

/**
 * Pull the composed WHERE clause back out of a tagged-template `values`
 * array. The retriever uses `Prisma.sql` to compose conditional WHERE
 * fragments (assessment_id + optional domain / document_id), so the
 * fragment lands in `values` as a `Prisma.Sql`-shaped object with its
 * own `strings` and `values` arrays.
 */
/**
 * Flatten a Prisma.Sql value tree into a flat list of bound primitives.
 * Useful when assertion targets are nested inside a `Prisma.join` (used
 * for IN-list parameters).
 */
function flattenValues(vals: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const v of vals) {
    if (
      v &&
      typeof v === "object" &&
      Array.isArray((v as { values?: unknown }).values)
    ) {
      out.push(...flattenValues((v as { values: unknown[] }).values));
    } else {
      out.push(v);
    }
  }
  return out;
}

function inspectComposedWhere(callValues: unknown[]): {
  text: string;
  values: unknown[];
} {
  const composed = callValues.find(
    (v): v is { strings: string[]; values: unknown[] } =>
      typeof v === "object" &&
      v !== null &&
      Array.isArray((v as { strings?: unknown }).strings) &&
      Array.isArray((v as { values?: unknown }).values),
  );
  if (!composed) {
    return { text: "", values: [] };
  }
  return {
    text: composed.strings.join(" ? "),
    values: composed.values,
  };
}
