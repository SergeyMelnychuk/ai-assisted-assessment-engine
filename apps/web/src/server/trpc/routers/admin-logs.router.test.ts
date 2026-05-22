import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

import { adminLogsRouter } from "./admin-logs";
import type { Context } from "../trpc";

type Caller = ReturnType<typeof adminLogsRouter.createCaller>;

function makeCtx(opts: {
  role?: "ADMIN" | "ASSESSOR";
  rows?: Array<{
    id: string;
    createdAt: Date;
    level: "INFO" | "WARN" | "ERROR" | "DEBUG";
    source: string;
    message: string;
    userId: string | null;
    assessmentId: string | null;
    jobId: string | null;
    context?: unknown;
    error?: string | null;
  }>;
  sources?: string[];
}) {
  const { role = "ADMIN", rows = [], sources = [] } = opts;

  const db = {
    log: {
      findMany: vi.fn(async (args: { take?: number; distinct?: string[] } | undefined) => {
        if (args?.distinct) {
          return sources.map((s) => ({ source: s }));
        }
        const take = args?.take ?? rows.length;
        return rows.slice(0, take);
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        rows.find((r) => r.id === args.where.id) ?? null,
      ),
    },
  } as const;

  return {
    db: db as unknown as Context["db"],
    session: {
      user: { id: "u1", role },
      expires: "2099-01-01T00:00:00.000Z",
    },
  } satisfies Context;
}

function caller(ctx: ReturnType<typeof makeCtx>): Caller {
  return adminLogsRouter.createCaller(ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adminLogs.list", () => {
  it("throws NOT_FOUND for non-admin callers", async () => {
    const ctx = makeCtx({ role: "ASSESSOR" });
    await expect(caller(ctx).list({ limit: 10 })).rejects.toBeInstanceOf(
      TRPCError,
    );
  });

  it("returns items with nextCursor=null when fewer than limit+1 rows", async () => {
    const ctx = makeCtx({
      rows: [
        {
          id: "l1",
          createdAt: new Date(),
          level: "INFO",
          source: "worker:queue",
          message: "job completed",
          userId: null,
          assessmentId: null,
          jobId: "j1",
        },
      ],
    });
    const out = await caller(ctx).list({ limit: 10 });
    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).toBeNull();
  });

  it("returns nextCursor when a page is full", async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `l${i}`,
      createdAt: new Date(Date.now() - i * 1000),
      level: "INFO" as const,
      source: "worker:queue",
      message: `msg ${i}`,
      userId: null,
      assessmentId: null,
      jobId: null,
    }));
    const ctx = makeCtx({ rows });
    const out = await caller(ctx).list({ limit: 10 });
    expect(out.items).toHaveLength(10);
    expect(out.nextCursor).toBe("l9");
  });
});

describe("adminLogs.sources", () => {
  it("returns distinct source strings", async () => {
    const ctx = makeCtx({
      sources: ["worker:queue", "trpc:analysis.run"],
    });
    const out = await caller(ctx).sources();
    expect(out).toEqual(["worker:queue", "trpc:analysis.run"]);
  });

  it("gates on ADMIN", async () => {
    const ctx = makeCtx({ role: "ASSESSOR" });
    await expect(caller(ctx).sources()).rejects.toBeInstanceOf(TRPCError);
  });
});

describe("adminLogs.get", () => {
  it("returns the row when found", async () => {
    const row = {
      id: "l1",
      createdAt: new Date(),
      level: "ERROR" as const,
      source: "worker:queue",
      message: "boom",
      userId: null,
      assessmentId: null,
      jobId: null,
      context: { foo: "bar" },
      error: "stack trace",
    };
    const ctx = makeCtx({ rows: [row] });
    const out = await caller(ctx).get({ id: "l1" });
    expect(out.id).toBe("l1");
    expect(out.error).toBe("stack trace");
  });

  it("throws NOT_FOUND when missing", async () => {
    const ctx = makeCtx({ rows: [] });
    await expect(caller(ctx).get({ id: "nope" })).rejects.toBeInstanceOf(
      TRPCError,
    );
  });
});
