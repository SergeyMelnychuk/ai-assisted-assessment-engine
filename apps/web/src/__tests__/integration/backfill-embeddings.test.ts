import { beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for the Week 3 embeddings backfill
// (`apps/web/prisma/backfill-embeddings.ts`). Uses an in-memory
// stand-in for Prisma so we don't need a live Postgres; the SQL
// string shape is matched on a best-effort basis (enough to know the
// backfill wrote what it claimed to).
//
// The critical properties: (1) idempotent — a re-run does nothing,
// (2) resumable — a crash partway through leaves committed rows
// committed, and a restart finishes the job without double-embedding.

process.env.EMBEDDING_MODE = "fake";
delete process.env.OPENAI_API_KEY;

interface FakeRow {
  id: string;
  content: string;
  content_sha: string | null;
  embedding: string | null;
  chunk_source: string | null;
  chunk_index: number | null;
  created_at: number;
}

const rows = new Map<string, FakeRow>();

// Optional hook for tests to throw on the Nth $executeRawUnsafe call
// (to simulate a crash mid-run).
let killAfter: number | null = null;
let executeCount = 0;

const fakePrisma = {
  $queryRawUnsafe: vi.fn(
    async (sql: string, ...params: unknown[]): Promise<FakeRow[]> => {
      const limit = (params[0] as number) ?? 50;
      const pending = [...rows.values()]
        .filter((r) => r.embedding === null)
        .sort((a, b) => a.created_at - b.created_at)
        .slice(0, limit);
      return pending.map((r) => ({
        id: r.id,
        content: r.content,
        content_sha: r.content_sha,
      })) as FakeRow[];
    },
  ),
  $executeRawUnsafe: vi.fn(
    async (sql: string, ...params: unknown[]): Promise<number> => {
      executeCount += 1;
      if (killAfter !== null && executeCount > killAfter) {
        throw new Error("synthetic crash: killAfter reached");
      }
      // Two SQL shapes we care about:
      //   1. "UPDATE …SET content_sha = 'empty' WHERE id = $1" — empty-content sentinel.
      //   2. "UPDATE …SET embedding = '[…]'::vector(1536), content_sha = $1, chunk_source = $2::jsonb, chunk_index = … WHERE id = $3"
      if (sql.includes("content_sha = 'empty'")) {
        const id = params[0] as string;
        const row = rows.get(id);
        if (row) row.content_sha = "empty";
        return 1;
      }
      if (sql.includes("embedding") && sql.includes("vector(1536)")) {
        const contentSha = params[0] as string;
        const chunkSource = params[1] as string;
        const id = params[2] as string;
        const row = rows.get(id);
        if (!row) return 0;
        // Extract the vector literal from the SQL so we can assert it
        // looks like 1536 comma-separated numbers.
        const match = sql.match(/'\[([^\]]+)\]'::vector\(1536\)/);
        if (!match) throw new Error("no vector literal found");
        const components = match[1].split(",");
        if (components.length !== 1536) {
          throw new Error(
            `vector literal had ${components.length} components, expected 1536`,
          );
        }
        row.embedding = match[0];
        row.content_sha = contentSha;
        row.chunk_source = chunkSource;
        row.chunk_index = 0;
        return 1;
      }
      return 0;
    },
  ),
};

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor() {
      return fakePrisma;
    }
  },
}));

async function loadBackfill() {
  // Lazy import so the mock is wired before module load.
  const mod = await import("../../../prisma/backfill-embeddings");
  return mod.runBackfill;
}

beforeEach(() => {
  rows.clear();
  executeCount = 0;
  killAfter = null;
  vi.clearAllMocks();
  for (let i = 0; i < 10; i += 1) {
    rows.set(`ev_${i}`, {
      id: `ev_${i}`,
      content: `Evidence content ${i} — deterministic enough to hash stably.`,
      content_sha: null,
      embedding: null,
      chunk_source: null,
      chunk_index: null,
      created_at: i,
    });
  }
});

describe("backfill-embeddings (integration)", () => {
  it("embeds all rows in fake mode, idempotent on re-run", async () => {
    const runBackfill = await loadBackfill();
    const result = await runBackfill(fakePrisma as never, {
      batchSize: 4,
      log: () => {},
    });
    expect(result.processed).toBe(10);
    for (const row of rows.values()) {
      expect(row.embedding).not.toBeNull();
      expect(row.content_sha).toMatch(/^[0-9a-f]{64}$/);
      expect(row.chunk_source).toBeTruthy();
    }

    // Re-run: the query returns zero pending rows because every
    // embedding is populated. processed stays 0.
    const second = await runBackfill(fakePrisma as never, {
      batchSize: 4,
      log: () => {},
    });
    expect(second.processed).toBe(0);
    expect(second.batches).toBe(0);
  });

  it("is resumable: mid-run crash does not double-embed", async () => {
    const runBackfill = await loadBackfill();
    // Allow the first batch's updates to land, then crash. Batch size
    // of 4 → the first batch writes 4 updates; killAfter=5 means the
    // first row of batch 2 also lands, then we throw.
    killAfter = 5;
    let caught: unknown;
    try {
      await runBackfill(fakePrisma as never, {
        batchSize: 4,
        log: () => {},
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const partiallyDone = [...rows.values()].filter(
      (r) => r.embedding !== null,
    ).length;
    expect(partiallyDone).toBeGreaterThan(0);
    expect(partiallyDone).toBeLessThan(10);

    // Resume.
    killAfter = null;
    executeCount = 0;
    const result = await runBackfill(fakePrisma as never, {
      batchSize: 4,
      log: () => {},
    });
    expect(result.processed).toBe(10 - partiallyDone);
    for (const row of rows.values()) {
      expect(row.embedding).not.toBeNull();
    }
  });

  it("produces deterministic vectors per content in fake mode", async () => {
    const runBackfill = await loadBackfill();
    await runBackfill(fakePrisma as never, { log: () => {} });
    const snapshot = [...rows.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => r.embedding);

    // Clear, re-seed with identical content, re-run. Vectors match.
    rows.clear();
    for (let i = 0; i < 10; i += 1) {
      rows.set(`ev_${i}`, {
        id: `ev_${i}`,
        content: `Evidence content ${i} — deterministic enough to hash stably.`,
        content_sha: null,
        embedding: null,
        chunk_source: null,
        chunk_index: null,
        created_at: i,
      });
    }
    await runBackfill(fakePrisma as never, { log: () => {} });
    const second = [...rows.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => r.embedding);
    expect(second).toEqual(snapshot);
  });
});
