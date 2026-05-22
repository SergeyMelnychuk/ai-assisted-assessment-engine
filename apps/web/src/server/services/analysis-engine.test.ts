import { describe, expect, it, vi } from "vitest";

vi.mock("./rag-retriever", () => ({
  retrieve: vi.fn(async (_db: unknown, args: { domain?: string }) => [
    {
      evidenceId: `ev-${args.domain ?? "generic"}-0`,
      content: `retrieved content for ${args.domain ?? "generic"}`,
      similarity: 0.9,
      chunkIndex: 0,
      chunkSource: null,
      sourceDocumentId: null,
      domain: args.domain,
    },
  ]),
}));

// Unit tests for the Week 2 per-domain dispatch in `runAnalysis`
// (ADR-0002). The full Prisma surface is stubbed in-test so we don't
// need docker-compose; the injected Claude caller is the load-bearing
// point of observation — we assert it's invoked N times for N domains
// and that one domain's throw doesn't abort the siblings.
//
// We do NOT re-test JSON parsing here (covered by claude-client tests
// implicitly via integration); this suite is about dispatch, domain
// isolation, and partial-success aggregation.

import {
  runAnalysis,
  DOMAIN_ANALYSIS_CONCURRENCY,
  heuristicAnalysisVerifier,
  type DomainClaudeCaller,
} from "./analysis-engine";

function makeDbMock(opts: {
  activeDomains: string[];
  evidence?: Array<{ id: string; domain: string; content: string; confidence: number; sourceType: string }>;
  riskPatterns?: Array<{ name: string; domain: string | null; content: unknown }>;
}) {
  const state = {
    findingCreates: [] as Array<Record<string, unknown>>,
    riskCreates: [] as Array<Record<string, unknown>>,
    recCreates: [] as Array<Record<string, unknown>>,
    assumptionCreates: [] as Array<Record<string, unknown>>,
  };
  const tx = {
    finding: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        state.findingCreates.push(...data);
        return { count: data.length };
      }),
    },
    risk: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        state.riskCreates.push(...data);
        return { count: data.length };
      }),
    },
    recommendation: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        state.recCreates.push(...data);
        return { count: data.length };
      }),
    },
    assumption: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        state.assumptionCreates.push(...data);
        return { count: data.length };
      }),
    },
    auditLog: {
      create: vi.fn(async () => ({})),
    },
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
        opts.evidence ??
        opts.activeDomains.map((d, i) => ({
          id: `ev-${d}-${i}`,
          domain: d,
          content: `evidence content for ${d}`,
          confidence: 0.8,
          sourceType: "DOCUMENT",
          createdAt: new Date(),
        })),
      ),
    },
    question: { findMany: vi.fn(async () => []) },
    domainScore: { findMany: vi.fn(async () => []) },
    knowledgeArtifact: { findMany: vi.fn(async () => opts.riskPatterns ?? []) },
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      return fn(tx);
    }),
  };
  return { db, tx, state };
}

describe("runAnalysis per-domain dispatch (ADR-0002)", () => {
  it("makes one Claude call per active domain", async () => {
    const domains = ["security", "performance", "observability"];
    const { db } = makeDbMock({ activeDomains: domains });
    const calls: string[] = [];
    const caller: DomainClaudeCaller = async ({ userContent }) => {
      // The per-domain prompt names the domain — capture it for assertion.
      const match = userContent.match(/scoped to a single domain: "([^"]+)"/);
      if (match) calls.push(match[1]);
      return {
        result: { findings: [], risks: [], recommendations: [], assumptions: [] },
        tokensUsed: { input: 100, output: 50 },
      };
    };

    // Cast is safe for the subset of Prisma we exercise; the engine
    // only touches the methods we stubbed above.
    const result = await runAnalysis(
      db as unknown as Parameters<typeof runAnalysis>[0],
      "asm-1",
      caller,
    );

    expect(calls.sort()).toEqual(domains.sort());
    expect(result.perDomain).toHaveLength(domains.length);
    expect(result.perDomain.every((d) => d.status === "ok")).toBe(true);
  });

  it("isolates one domain's failure from its siblings", async () => {
    const domains = ["security", "performance", "observability"];
    const { db, state } = makeDbMock({ activeDomains: domains });
    const caller: DomainClaudeCaller = async ({ userContent }) => {
      if (userContent.includes('"performance"')) {
        throw new Error("simulated 529 overloaded_error for performance");
      }
      const match = userContent.match(/scoped to a single domain: "([^"]+)"/);
      const domain = match?.[1] ?? "unknown";
      return {
        result: {
          findings: [
            {
              domain,
              findingType: "observation",
              title: `finding for ${domain}`,
              description: "ok",
              evidenceIds: [],
              confidence: 0.8,
              severity: "medium",
            },
          ],
        },
        tokensUsed: { input: 100, output: 50 },
      };
    };

    const result = await runAnalysis(
      db as unknown as Parameters<typeof runAnalysis>[0],
      "asm-1",
      caller,
    );

    // Two succeeded, one failed — no exception bubbles up.
    const failed = result.perDomain.filter((d) => d.status === "failed");
    const ok = result.perDomain.filter((d) => d.status === "ok");
    expect(failed).toHaveLength(1);
    expect(failed[0].domain).toBe("performance");
    expect(failed[0].error).toMatch(/overloaded/i);
    expect(ok.map((d) => d.domain).sort()).toEqual(["observability", "security"]);

    // Findings landed for the two succeeded domains only.
    expect(state.findingCreates).toHaveLength(2);
    expect(
      state.findingCreates.map((f) => (f as { domain: string }).domain).sort(),
    ).toEqual(["observability", "security"]);
  });

  it("filters low-confidence unsupported findings in the verifier pass", async () => {
    const domains = ["security"];
    const { db, state } = makeDbMock({ activeDomains: domains });
    const caller: DomainClaudeCaller = async () => ({
      result: {
        findings: [
          {
            domain: "security",
            findingType: "observation",
            title: "supported finding",
            description: "kept",
            evidenceIds: ["ev-security-0"],
            confidence: 0.4,
            severity: "medium",
          },
          {
            domain: "security",
            findingType: "observation",
            title: "speculative finding",
            description: "should be dropped",
            evidenceIds: [],
            confidence: 0.2,
            severity: "medium",
          },
        ],
        risks: [],
        recommendations: [],
        assumptions: [],
      },
      tokensUsed: { input: 100, output: 50 },
    });

    // ADR-0013: the verifier only runs in THOROUGH mode and the caller
    // is responsible for supplying an implementation. We inject the
    // exported heuristic variant so the test exercises real filter
    // behaviour without burning a Claude call.
    await runAnalysis(
      db as unknown as Parameters<typeof runAnalysis>[0],
      "asm-1",
      caller,
      undefined,
      "THOROUGH",
      heuristicAnalysisVerifier,
    );

    expect(state.findingCreates).toHaveLength(1);
    expect(
      (state.findingCreates[0] as { title: string }).title,
    ).toBe("supported finding");
  });

  it("returns empty perDomain with zero activeDomains", async () => {
    const { db } = makeDbMock({ activeDomains: [] });
    const caller: DomainClaudeCaller = vi.fn();
    const result = await runAnalysis(
      db as unknown as Parameters<typeof runAnalysis>[0],
      "asm-1",
      caller,
    );
    expect(result.perDomain).toEqual([]);
    expect(caller).not.toHaveBeenCalled();
  });

  it("respects the documented concurrency cap", () => {
    // Compile-time sanity on the exported constant — downstream docs
    // and ADR-0002 cite this value. Changing it must be deliberate.
    expect(DOMAIN_ANALYSIS_CONCURRENCY).toBe(1);
  });
});
