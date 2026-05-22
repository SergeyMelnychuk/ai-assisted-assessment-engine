import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

// Router-surface tests for the Week 7 Evidence Explorer (ADR-0011).
// We bypass the real tRPC builder and call each procedure's resolver
// directly — the router is a thin protected-procedure shell; we
// exercise the authz path + happy path + the cited-vs-retrieved
// deduplication in findingTrail.

vi.mock("@/server/services/rag-retriever", () => ({
  retrieve: vi.fn(),
}));

vi.mock("@/server/services/ai/embedding-service", () => ({
  embedTexts: vi.fn(async (inputs: string[]) => ({
    vectors: inputs.map(() => [0.1, 0.2, 0.3]),
    model: "test",
    inputTokens: 1,
  })),
}));

import { retrieve } from "@/server/services/rag-retriever";
import { evidenceExplorerRouter } from "./evidenceExplorer";
import type { Context } from "../trpc";

type Caller = ReturnType<typeof evidenceExplorerRouter.createCaller>;

function makeCtx(opts: {
  assessmentVisible?: boolean;
  finding?: {
    id: string;
    assessmentId: string;
    evidenceIds: string[];
    retrievedEvidenceIds: string[];
  } | null;
  evidenceRows?: Array<{
    id: string;
    content: string;
    domain: string;
    sourceType: string;
    confidence: number;
    chunkIndex: number | null;
    chunkSource: unknown;
    document: { filename: string } | null;
  }>;
  embeddingRows?: Array<{ id: string; embedding: number[] | null }>;
}) {
  const {
    assessmentVisible = true,
    finding = null,
    evidenceRows = [],
    embeddingRows = [],
  } = opts;

  const db = {
    assessment: {
      findFirst: vi.fn(async () =>
        assessmentVisible ? { engagementId: "eng-1" } : null,
      ),
    },
    finding: {
      findFirst: vi.fn(async () => finding),
    },
    evidence: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        const ids = new Set(args.where.id.in);
        return evidenceRows.filter((r) => ids.has(r.id));
      }),
    },
    $queryRaw: vi.fn(async () => embeddingRows),
  } as const;

  return {
    db: db as unknown as Context["db"],
    session: {
      user: { id: "u1", role: "ASSESSOR" as const },
      expires: "2099-01-01T00:00:00.000Z",
    },
  } satisfies Context;
}

function caller(ctx: ReturnType<typeof makeCtx>): Caller {
  return evidenceExplorerRouter.createCaller(ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("evidenceExplorer.search", () => {
  it("throws NOT_FOUND when the caller is not a member of the engagement", async () => {
    const ctx = makeCtx({ assessmentVisible: false });
    await expect(
      caller(ctx).search({
        assessmentId: "clxxxxxxxxxxxxxxxxxxxxxxx",
        query: "hi",
      }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("returns clustered results on the happy path", async () => {
    vi.mocked(retrieve).mockResolvedValueOnce([
      {
        evidenceId: "clev1xxxxxxxxxxxxxxxxxxxx",
        content: "same text",
        similarity: 0.9,
        chunkIndex: 0,
        chunkSource: { heading: "H1" },
        sourceDocumentId: "cldoc1xxxxxxxxxxxxxxxxxxx",
        domain: "security",
      },
      {
        evidenceId: "clev2xxxxxxxxxxxxxxxxxxxx",
        content: "same text elsewhere",
        similarity: 0.88,
        chunkIndex: 0,
        chunkSource: { heading: "H1" },
        sourceDocumentId: "cldoc2xxxxxxxxxxxxxxxxxxx",
        domain: "security",
      },
    ]);
    const ctx = makeCtx({
      evidenceRows: [
        {
          id: "clev1xxxxxxxxxxxxxxxxxxxx",
          content: "same text",
          domain: "security",
          sourceType: "DOCUMENT",
          confidence: 0.9,
          chunkIndex: 0,
          chunkSource: { heading: "Intro" },
          document: { filename: "arch.md" },
        },
      ],
      embeddingRows: [
        { id: "clev1xxxxxxxxxxxxxxxxxxxx", embedding: [1, 0, 0] },
        { id: "clev2xxxxxxxxxxxxxxxxxxxx", embedding: [1, 0, 0] },
      ],
    });
    const out = await caller(ctx).search({
      assessmentId: "clxxxxxxxxxxxxxxxxxxxxxxx",
      query: "auth",
    });
    expect(out).toHaveLength(1);
    expect(out[0].duplicateCount).toBe(2);
    expect(out[0].memberIds).toEqual(["clev1xxxxxxxxxxxxxxxxxxxx", "clev2xxxxxxxxxxxxxxxxxxxx"]);
    expect(out[0].trail.documentName).toBe("arch.md");
  });
});

describe("evidenceExplorer.findingTrail", () => {
  it("throws NOT_FOUND when finding is missing or out of scope", async () => {
    const ctx = makeCtx({ finding: null });
    await expect(
      caller(ctx).findingTrail({ findingId: "clfmissingxxxxxxxxxxxxxxx" }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("returns cited and retrieved-only (deduped) trails", async () => {
    const ctx = makeCtx({
      finding: {
        id: "clfind1xxxxxxxxxxxxxxxxxx",
        assessmentId: "clasmt1xxxxxxxxxxxxxxxxxx",
        evidenceIds: ["clev1xxxxxxxxxxxxxxxxxxxx"],
        retrievedEvidenceIds: ["clev1xxxxxxxxxxxxxxxxxxxx", "clev2xxxxxxxxxxxxxxxxxxxx", "clev3xxxxxxxxxxxxxxxxxxxx"],
      },
      evidenceRows: [
        {
          id: "clev1xxxxxxxxxxxxxxxxxxxx",
          content: "cited chunk",
          domain: "security",
          sourceType: "DOCUMENT",
          confidence: 0.8,
          chunkIndex: 0,
          chunkSource: { heading: "A" },
          document: { filename: "a.md" },
        },
        {
          id: "clev2xxxxxxxxxxxxxxxxxxxx",
          content: "retrieved-only 2",
          domain: "security",
          sourceType: "DOCUMENT",
          confidence: 0.7,
          chunkIndex: 1,
          chunkSource: { heading: "B" },
          document: { filename: "b.md" },
        },
        {
          id: "clev3xxxxxxxxxxxxxxxxxxxx",
          content: "retrieved-only 3",
          domain: "security",
          sourceType: "DOCUMENT",
          confidence: 0.6,
          chunkIndex: 2,
          chunkSource: { heading: "C" },
          document: { filename: "c.md" },
        },
      ],
    });
    const out = await caller(ctx).findingTrail({ findingId: "clfind1xxxxxxxxxxxxxxxxxx" });
    expect(out.cited.map((c) => c.evidenceId)).toEqual(["clev1xxxxxxxxxxxxxxxxxxxx"]);
    expect(out.retrieved.map((c) => c.evidenceId)).toEqual(["clev2xxxxxxxxxxxxxxxxxxxx", "clev3xxxxxxxxxxxxxxxxxxxx"]);
  });
});

describe("evidenceExplorer.trail", () => {
  it("hydrates source trails, silently dropping out-of-scope ids", async () => {
    const ctx = makeCtx({
      evidenceRows: [
        {
          id: "clev1xxxxxxxxxxxxxxxxxxxx",
          content: "hello",
          domain: "security",
          sourceType: "DOCUMENT",
          confidence: 0.8,
          chunkIndex: 0,
          chunkSource: { heading: "Intro", page: 3 },
          document: { filename: "arch.md" },
        },
      ],
    });
    const out = await caller(ctx).trail({
      assessmentId: "clxxxxxxxxxxxxxxxxxxxxxxx",
      evidenceIds: ["clev1xxxxxxxxxxxxxxxxxxxx", "clmissingxxxxxxxxxxxxxxxx"],
    });
    expect(out).toHaveLength(1);
    expect(out[0].trail.heading).toBe("Intro");
    expect(out[0].trail.page).toBe(3);
  });
});
