import { describe, expect, it, vi, beforeEach } from "vitest";

// Week 7 (ADR-0011). After `runAnalysis`, every inserted Finding /
// Risk / Recommendation row must carry the per-domain
// `retrievedEvidenceIds` the retriever produced. The retriever itself
// is mocked at module-boundary — this suite's point of observation is
// the Prisma `createMany` call bodies.

vi.mock("./rag-retriever", () => ({
  retrieve: vi.fn(),
}));

import { retrieve } from "./rag-retriever";
import { runAnalysis, type DomainClaudeCaller } from "./analysis-engine";

function makeDb(opts: { activeDomains: string[] }) {
  const state = {
    findingCreates: [] as Array<Record<string, unknown>>,
    riskCreates: [] as Array<Record<string, unknown>>,
    recCreates: [] as Array<Record<string, unknown>>,
  };
  const capture =
    (arr: Array<Record<string, unknown>>) =>
    async ({ data }: { data: Array<Record<string, unknown>> }) => {
      arr.push(...data);
      return { count: data.length };
    };
  const tx = {
    finding: { deleteMany: vi.fn(async () => ({ count: 0 })), createMany: vi.fn(capture(state.findingCreates)) },
    risk: { deleteMany: vi.fn(async () => ({ count: 0 })), createMany: vi.fn(capture(state.riskCreates)) },
    recommendation: { deleteMany: vi.fn(async () => ({ count: 0 })), createMany: vi.fn(capture(state.recCreates)) },
    assumption: { deleteMany: vi.fn(async () => ({ count: 0 })), createMany: vi.fn(async () => ({ count: 0 })) },
  };
  const db = {
    assessment: {
      findUnique: vi.fn(async () => ({
        id: "asm-1",
        mode: "architecture",
        activeDomains: opts.activeDomains,
        projectContext: null,
        assessmentType: null,
      })),
    },
    evidence: {
      findMany: vi.fn(async () =>
        opts.activeDomains.flatMap((d) => [
          { id: `ev-${d}-1`, domain: d, content: "x", confidence: 0.9, sourceType: "DOCUMENT" },
          { id: `ev-${d}-2`, domain: d, content: "y", confidence: 0.9, sourceType: "DOCUMENT" },
        ]),
      ),
    },
    question: { findMany: vi.fn(async () => []) },
    domainScore: { findMany: vi.fn(async () => []) },
    knowledgeArtifact: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { db, state };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runAnalysis retrievedEvidenceIds plumbing (ADR-0011)", () => {
  it("attaches the per-domain retrieval result to every Finding/Risk/Rec", async () => {
    const domains = ["security", "performance"];
    // retrieve() returns 2 chunks per domain keyed by domain name so
    // we can assert the inserted retrievedEvidenceIds match.
    vi.mocked(retrieve).mockImplementation(async (_db, { domain }) => [
      {
        evidenceId: `ev-${domain}-1`,
        content: "a",
        similarity: 0.9,
        chunkIndex: 0,
        chunkSource: null,
        sourceDocumentId: null,
        domain,
      },
      {
        evidenceId: `ev-${domain}-2`,
        content: "b",
        similarity: 0.8,
        chunkIndex: 1,
        chunkSource: null,
        sourceDocumentId: null,
        domain,
      },
    ]);

    const { db, state } = makeDb({ activeDomains: domains });
    const caller: DomainClaudeCaller = async ({ userContent }) => {
      const match = userContent.match(/scoped to a single domain: "([^"]+)"/);
      const domain = match?.[1] ?? "unknown";
      return {
        result: {
          findings: [
            {
              domain,
              findingType: "observation",
              title: `f-${domain}`,
              description: "ok",
              evidenceIds: [`ev-${domain}-1`],
              confidence: 0.8,
              severity: "medium",
            },
          ],
          risks: [
            {
              title: `r-${domain}`,
              description: "ok",
              category: domain,
              evidenceIds: [],
              impact: "medium",
              likelihood: "possible",
            },
          ],
          recommendations: [
            {
              domain,
              title: `rec-${domain}`,
              description: "ok",
              priority: "medium",
            },
          ],
          assumptions: [],
        },
        tokensUsed: { input: 10, output: 5 },
      };
    };

    await runAnalysis(
      db as unknown as Parameters<typeof runAnalysis>[0],
      "asm-1",
      caller,
    );

    for (const row of state.findingCreates) {
      const domain = row.domain as string;
      expect(row.retrievedEvidenceIds).toEqual([
        `ev-${domain}-1`,
        `ev-${domain}-2`,
      ]);
    }
    // Every row must be non-empty — the core ADR-0011 invariant.
    expect(state.findingCreates.every((r) => (r.retrievedEvidenceIds as string[]).length > 0)).toBe(
      true,
    );
    expect(state.riskCreates.every((r) => (r.retrievedEvidenceIds as string[]).length > 0)).toBe(
      true,
    );
    expect(state.recCreates.every((r) => (r.retrievedEvidenceIds as string[]).length > 0)).toBe(
      true,
    );
  });
});
