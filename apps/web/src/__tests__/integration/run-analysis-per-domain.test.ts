import { beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for the Week 2 per-domain analysis fan-out
// (ADR-0002). We mock Prisma and the Claude client boundaries so this
// runs in plain Node; the load-bearing assertions are:
//
//   1. The run-analysis job succeeds (does not re-throw) when some
//      domains fail and some succeed.
//   2. Findings/risks/recs/scores land for the succeeded domain(s)
//      and NOT for the failed one.
//   3. A single aggregated RUN_ANALYSIS audit-log row captures the
//      per-domain status map and a `partial: true` flag.

const activeDomains = ["security", "performance"];
const assessmentId = "asm-per-domain-1";

// ── Prisma mock ────────────────────────────────────────────────

type Row = Record<string, unknown>;
const state = {
  findings: [] as Row[],
  risks: [] as Row[],
  recs: [] as Row[],
  assumptions: [] as Row[],
  scores: [] as Row[],
  audit: [] as Row[],
  assessmentUpdates: [] as Array<{ where: Row; data: Row }>,
};

vi.mock("@/server/db", () => {
  const tx = {
    finding: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        state.findings.push(...data);
        return { count: data.length };
      }),
    },
    risk: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        state.risks.push(...data);
        return { count: data.length };
      }),
    },
    recommendation: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        state.recs.push(...data);
        return { count: data.length };
      }),
    },
    assumption: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        state.assumptions.push(...data);
        return { count: data.length };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        state.audit.push(data);
        return data;
      }),
    },
  };
  const db = {
    assessment: {
      findUnique: vi.fn(async () => ({
        id: assessmentId,
        mode: "architecture",
        activeDomains,
        projectContext: null,
        assessmentType: null,
      })),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        state.assessmentUpdates.push({ where, data });
        return {};
      }),
    },
    evidence: {
      findMany: vi.fn(async () =>
        activeDomains.map((d, i) => ({
          id: `ev-${d}-${i}`,
          domain: d,
          content: `evidence for ${d}`,
          confidence: 0.7,
          sourceType: "DOCUMENT",
        })),
      ),
    },
    question: { findMany: vi.fn(async () => []) },
    domainScore: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        state.scores.push(...data);
        return { count: data.length };
      }),
      update: vi.fn(async () => ({})),
    },
    finding: {
      findMany: vi.fn(async () => []),
      ...tx.finding,
    },
    risk: { ...tx.risk },
    recommendation: { ...tx.recommendation },
    assumption: { ...tx.assumption },
    // Cancellation checks poll the audit log for a cancel marker.
    // This fixture never requests cancellation, so return null.
    auditLog: {
      ...tx.auditLog,
      findFirst: vi.fn(async () => null),
    },
    knowledgeArtifact: {
      findMany: vi.fn(async ({ where }: { where: { artifactType: string } }) => {
        if (where.artifactType === "FRAMEWORK") {
          return [
            {
              name: "architecture",
              content: {
                domains: activeDomains.map((d) => ({
                  key: d,
                  name: d,
                  scoringCriteria: [
                    { level: 1, description: "ad hoc" },
                    { level: 5, description: "optimised" },
                  ],
                })),
              },
            },
          ];
        }
        return [];
      }),
    },
    $transaction: vi.fn(
      async (
        arg:
          | Array<Promise<unknown>>
          | ((tx: unknown) => Promise<unknown>),
      ) => {
        if (Array.isArray(arg)) return Promise.all(arg);
        return arg(tx);
      },
    ),
  };
  return { db };
});

// ── Claude mock — `performance` throws; `security` returns a clean
//    payload. The `run-analysis` job calls `callClaude` via the two
//    services; we route by inspecting the userContent for the domain
//    string the per-domain builders embed.

vi.mock("@/server/services/ai/router", () => ({
  callClaude: vi.fn(
    async ({
      userContent,
      parseResult,
    }: {
      userContent: string;
      parseResult: (raw: string) => unknown;
    }) => {
      if (userContent.includes('"performance"')) {
        throw new Error("simulated Anthropic 529 overloaded_error");
      }
      // Both finding-generation and domain-scoring prompts route here.
      // Detect which one by looking for the scoring-shaped schema hint.
      const isScoring = /domainScores/i.test(userContent) && /Score a single domain/.test(userContent);
      const payload = isScoring
        ? {
            domainScores: [
              {
                domain: "security",
                score: 3.5,
                maturityLevel: "DEFINED",
                confidence: 0.8,
                scoringRationale: "evidence-backed rationale",
              },
            ],
          }
        : {
            findings: [
              {
                domain: "security",
                findingType: "observation",
                title: "token sink",
                description: "something about security",
                evidenceIds: ["ev-security-0"],
                confidence: 0.8,
                severity: "medium",
              },
            ],
            risks: [],
            recommendations: [],
            assumptions: [],
          };
      const result = parseResult(JSON.stringify(payload));
      return { result, tokensUsed: { input: 200, output: 100 } };
    },
  ),
  parseJsonResponse: <T,>(raw: string): T => JSON.parse(raw) as T,
  claude: new Proxy({}, { get: () => undefined }),
}));

vi.mock("@/server/services/rag-retriever", () => ({
  retrieve: vi.fn(async (_db: unknown, args: { domain?: string; topK?: number }) => {
    const domain = args.domain ?? "security";
    const topK = args.topK ?? 1;
    return Array.from({ length: Math.min(topK, 2) }, (_, idx) => ({
      evidenceId: `ev-${domain}-${idx}`,
      content: `retrieved evidence for ${domain}`,
      similarity: 0.9,
      chunkIndex: idx,
      chunkSource: null,
      sourceDocumentId: null,
      domain,
    }));
  }),
}));

import { runAnalysisJob } from "@/server/queue/jobs/run-analysis";

beforeEach(() => {
  state.findings.length = 0;
  state.risks.length = 0;
  state.recs.length = 0;
  state.assumptions.length = 0;
  state.scores.length = 0;
  state.audit.length = 0;
  state.assessmentUpdates.length = 0;
});

describe("run-analysis per-domain partial success (ADR-0002)", () => {
  it("completes when one domain fails and another succeeds", async () => {
    await expect(runAnalysisJob(assessmentId)).resolves.toBeUndefined();

    // Findings landed for the succeeded domain only.
    expect(state.findings).toHaveLength(1);
    expect((state.findings[0] as { domain: string }).domain).toBe("security");

    // Scoring similarly landed for security only.
    expect(state.scores).toHaveLength(1);
    expect((state.scores[0] as { domain: string }).domain).toBe("security");

    // Aggregate audit row captures both statuses.
    const runRow = state.audit.find(
      (r) => (r as { action: string }).action === "RUN_ANALYSIS",
    );
    expect(runRow).toBeTruthy();
    const details = (runRow as { details: Record<string, unknown> }).details;
    expect(details.partial).toBe(true);
    const domains = details.domains as {
      analysis: Record<string, "ok" | "failed">;
      scoring: Record<string, "ok" | "failed">;
    };
    expect(domains.analysis.security).toBe("ok");
    expect(domains.analysis.performance).toBe("failed");
    expect(domains.scoring.security).toBe("ok");
    expect(domains.scoring.performance).toBe("failed");

    // No RUN_ANALYSIS_FAILED row — it's a partial, not a hard failure.
    const failedRow = state.audit.find(
      (r) => (r as { action: string }).action === "RUN_ANALYSIS_FAILED",
    );
    expect(failedRow).toBeUndefined();

    // Bug: worker used to set `status = ANALYSIS` at job start but
    // never flipped it back on success, leaving the UI in the
    // analysis-in-progress banner state forever. Assert the stage
    // advances to DRAFTING (guarded by `status = ANALYSIS`).
    const toAnalysis = state.assessmentUpdates.find(
      (u) => (u.data as { status?: string }).status === "ANALYSIS",
    );
    const toDrafting = state.assessmentUpdates.find(
      (u) => (u.data as { status?: string }).status === "DRAFTING",
    );
    expect(toAnalysis).toBeTruthy();
    expect(toDrafting).toBeTruthy();
    expect(
      (toDrafting!.where as { status?: string }).status,
    ).toBe("ANALYSIS");
  });
});
