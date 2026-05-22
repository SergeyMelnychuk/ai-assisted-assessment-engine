import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { retrieve } from "./rag-retriever";

/**
 * RAG retriever integration test — Phase 3 Week 4 (ADR-0006/0007).
 *
 * The unit tests in `rag-retriever.test.ts` exercise the SQL shape +
 * fallback policy with a single mocked row-set. This suite operates one
 * level up: it builds a synthetic 50-chunk corpus spread across 4
 * domains (~12 per domain) with **deterministic embeddings** (one-hot
 * per domain, padded to 1536 dims) and exercises the retriever end-to-
 * end against an in-memory fake Prisma that re-implements the cosine
 * query the real DB runs.
 *
 * Why this shape: Prisma test DB helpers (`test-db.ts`) aren't present
 * in this repo, and spinning up pgvector in CI is out-of-scope for the
 * static-authoring gap-fill. Mocking `db.$queryRaw` with a faithful
 * cosine-ranker lets us assert the *observable* retrieval contract —
 * domain-scoped hits dominate, and `nonexistent-domain` widens to the
 * full corpus — without touching real Postgres.
 *
 * Guarantees asserted:
 *   1. `domain: 'security'` with a security-like query vector returns
 *      top-10 rows all in `security`.
 *   2. `domain: 'nonexistent-domain'` widens (ADR-0006 fallback) and
 *      returns 10 rows drawn from across the corpus.
 */

vi.mock("./ai/embedding-service", () => ({
  // The retriever calls embed() once per retrieve(); we return the
  // vector the test supplied via a module-level closure so each case
  // controls which domain its query is "most similar" to.
  embed: vi.fn(async (texts: string[]) =>
    texts.map(() => __nextQueryVec.slice()),
  ),
}));

// Hybrid retrieval is opt-in (ADR-0027). The fixture tests below
// exercise the cosine path; pin the flag off so each retrieve() call
// stays on the original path under test.
vi.mock("./agent/feature-flag", () => ({
  isHybridRetrievalEnabled: vi.fn(async () => false),
}));

// Dim matches the production embedding model. The retriever is dim-
// agnostic but keeping the fixtures at 1536 catches any accidental
// padding / slicing mistakes.
const DIM = 1536;
const DOMAINS = ["security", "architecture", "operations", "data"] as const;
type Domain = (typeof DOMAINS)[number];

function oneHot(domainIdx: number, dim = DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  v[domainIdx] = 1;
  return v;
}

/** Normalised cosine distance (0 identical, 2 opposite). */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    aNorm += a[i]! * a[i]!;
    bNorm += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(aNorm) * Math.sqrt(bNorm);
  if (denom === 0) return 1; // treat degenerate as orthogonal
  const cosSim = dot / denom;
  return 1 - cosSim;
}

interface Chunk {
  id: string;
  content: string;
  assessment_id: string;
  domain: Domain;
  embedding: number[];
  chunk_index: number;
  chunk_source: unknown;
  document_id: string;
}

/** Build 50 chunks across 4 domains (12/12/13/13 split). */
function buildCorpus(assessmentId: string): Chunk[] {
  const sizes = [12, 12, 13, 13]; // sums to 50
  const out: Chunk[] = [];
  DOMAINS.forEach((d, domainIdx) => {
    const base = oneHot(domainIdx);
    for (let i = 0; i < sizes[domainIdx]!; i += 1) {
      out.push({
        id: `ev-${d}-${i}`,
        content: `${d} chunk ${i}`,
        assessment_id: assessmentId,
        domain: d,
        // Small jitter so rows within a domain have a stable tie-break
        // order. Keeps the top-K stable across runs.
        embedding: base.map((x, j) => (j === domainIdx ? x + i * 1e-6 : x)),
        chunk_index: i,
        chunk_source: { heading: `${d} §${i}` },
        document_id: `doc-${d}`,
      });
    }
  });
  return out;
}

// Module-level seam: the mocked `embed()` returns whatever the test
// writes here. Small hack but it keeps the mock declaration top-level
// (vitest hoists `vi.mock` above imports, which forbids closures over
// per-test state without this indirection).
let __nextQueryVec: number[] = oneHot(0);

interface FakeDbResult {
  id: string;
  content: string;
  distance: number;
  chunk_index: number;
  chunk_source: unknown;
  source_document_id: string;
  domain: string;
}

function makeFakeDb(corpus: Chunk[]) {
  // Pull the vector literal + composed WHERE filters out of the
  // tagged-template values array and run an in-memory cosine ranker
  // matching the real SQL's semantics. Bind order after the
  // `Prisma.sql` WHERE composition is:
  //   [vecLiteral, whereClauseSql, vecLiteral, topK]
  // where `whereClauseSql` is a Prisma.Sql with its own .strings /
  // .values containing the assessmentId / optional domain /
  // optional documentId filters.
  const $queryRaw = vi.fn(
    async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const vecLiteral = values[0] as string;
      const whereClause = values[1] as
        | { strings: string[]; values: unknown[] }
        | undefined;
      const topK = values[values.length - 1] as number;

      // Reconstruct the filter intent from the composed WHERE.
      let assessmentId: string | undefined;
      let domain: string | undefined;
      let documentId: string | undefined;
      if (whereClause && Array.isArray(whereClause.strings)) {
        const text = whereClause.strings.join(" ? ");
        const vals = whereClause.values;
        // The order in rag-retriever.ts always starts with
        // `assessment_id = ?`; domain and document_id may follow.
        let cursor = 0;
        if (/assessment_id =/.test(text)) {
          assessmentId = vals[cursor++] as string;
        }
        if (/domain =/.test(text)) {
          domain = vals[cursor++] as string;
        }
        if (/document_id =/.test(text)) {
          documentId = vals[cursor++] as string;
        }
      }

      const queryVec = parseVec(vecLiteral);

      const ranked = corpus
        .filter((c) =>
          assessmentId ? c.assessment_id === assessmentId : true,
        )
        .filter((c) => (domain ? c.domain === domain : true))
        .filter((c) => (documentId ? c.document_id === documentId : true))
        .map<FakeDbResult>((c) => ({
          id: c.id,
          content: c.content,
          distance: cosineDistance(queryVec, c.embedding),
          chunk_index: c.chunk_index,
          chunk_source: c.chunk_source,
          source_document_id: c.document_id,
          domain: c.domain,
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, topK);

      return ranked;
    },
  );
  return { $queryRaw } as unknown as PrismaClient;
}

function parseVec(literal: string): number[] {
  // literal looks like "[0.1,0.2,...]"
  return literal
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => Number.parseFloat(s));
}

describe("rag-retriever integration — 50-chunk fixture", () => {
  const assessmentId = "asmt-int-1";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("domain-scoped retrieval returns all-security rows", async () => {
    const corpus = buildCorpus(assessmentId);
    const db = makeFakeDb(corpus);
    // Query vector = one-hot on the security dim ⇒ security rows rank first.
    __nextQueryVec = oneHot(DOMAINS.indexOf("security"));

    const out = await retrieve(db, {
      assessmentId,
      query: "security posture, authentication, encryption",
      domain: "security",
      topK: 10,
    });

    expect(out).toHaveLength(10);
    for (const chunk of out) {
      expect(chunk.domain).toBe("security");
    }
  });

  it("unknown domain widens via fallback to return 10 rows from all domains", async () => {
    const corpus = buildCorpus(assessmentId);
    const db = makeFakeDb(corpus);
    // Query vector biased toward the `architecture` dim so the widened
    // (all-domain) fallback has a clear ranking target.
    __nextQueryVec = oneHot(DOMAINS.indexOf("architecture"));

    const out = await retrieve(db, {
      assessmentId,
      query: "anything goes",
      domain: "nonexistent-domain",
      topK: 10,
    });

    // Primary (domain-scoped) returns 0 rows ⇒ fallback widens.
    expect(out).toHaveLength(10);
    // The widened set draws from the real corpus — every row must come
    // from one of the four real domains.
    for (const chunk of out) {
      expect(DOMAINS).toContain(chunk.domain as Domain);
    }
    // And the top hit matches the query's bias (architecture).
    expect(out[0]!.domain).toBe("architecture");
  });
});
