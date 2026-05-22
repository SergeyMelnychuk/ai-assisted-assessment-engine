import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma, type LogLevel } from "@prisma/client";
import { createRouter, protectedProcedure } from "../trpc";

/**
 * Admin-only router backing the `/admin/logs` UI.
 *
 * Wraps the `Log` table (see `docs/operations/logs.md`). All procedures
 * re-check `session.user.role === 'ADMIN'` — belt-and-braces with the
 * /admin layout role gate.
 *
 * Pagination is keyset, newer-first. `createdAt DESC, id DESC` guarantees
 * a stable order even when two rows land in the same millisecond.
 *
 * Search is substring-insensitive against `message`. We explicitly
 * do NOT search against the `context` JSON — the obvious query
 * (`cast(context::text) ilike '%x%'`) forces a seq scan on every row
 * and we'd rather the admin add a correlator (userId / assessmentId /
 * jobId) or an exact `source` filter than wait on a cross-column scan.
 */

const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const satisfies readonly LogLevel[];

const listInput = z.object({
  from: z.date().optional(),
  to: z.date().optional(),
  levels: z.array(z.enum(LOG_LEVELS)).optional(),
  sources: z.array(z.string().min(1)).optional(),
  search: z.string().optional(),
  userId: z.string().optional(),
  assessmentId: z.string().optional(),
  jobId: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});

function assertAdmin(role: string): void {
  if (role !== "ADMIN") {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

export const adminLogsRouter = createRouter({
  list: protectedProcedure
    .input(listInput)
    .query(async ({ ctx, input }) => {
      assertAdmin(ctx.session.user.role);
      const where: Prisma.LogWhereInput = {};
      if (input.from) where.createdAt = { ...(where.createdAt as object), gte: input.from };
      if (input.to) where.createdAt = { ...(where.createdAt as object), lte: input.to };
      if (input.levels && input.levels.length > 0) where.level = { in: input.levels };
      if (input.sources && input.sources.length > 0) where.source = { in: input.sources };
      if (input.userId) where.userId = input.userId;
      if (input.assessmentId) where.assessmentId = input.assessmentId;
      if (input.jobId) where.jobId = input.jobId;
      if (input.search && input.search.length > 0) {
        where.message = { contains: input.search, mode: "insensitive" };
      }

      // Keyset pagination: fetch one extra row past `limit` so we can
      // tell whether a "next page" exists without a separate count.
      // The cursor is the id of the last row we showed; we fetch rows
      // strictly older than it via `cursor + skip=1`.
      const take = input.limit + 1;
      const rows = await ctx.db.log.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        ...(input.cursor
          ? { cursor: { id: input.cursor }, skip: 1 }
          : {}),
        select: {
          id: true,
          createdAt: true,
          level: true,
          source: true,
          message: true,
          userId: true,
          assessmentId: true,
          jobId: true,
        },
      });
      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1].id : null;
      return { items, nextCursor };
    }),

  sources: protectedProcedure.query(async ({ ctx }) => {
    assertAdmin(ctx.session.user.role);
    // `SELECT DISTINCT source FROM logs` — cheap, even without an
    // index, because the column cardinality is low. Sorted server-side
    // so the multi-select is stable.
    const rows = await ctx.db.log.findMany({
      distinct: ["source"],
      select: { source: true },
      orderBy: { source: "asc" },
    });
    return rows.map((r) => r.source);
  }),

  // logs-tab charts need this; ADR-0013 follow-up.
  //
  // `rollups` returns the three aggregates the Logs settings tab shows
  // above the table in one round-trip: counts by level, top N sources,
  // and a per-hour histogram broken down by level. We colocate them so
  // the UI doesn't fan out 3 queries (the rollup window is always the
  // same — last 24 h by default).
  rollups: protectedProcedure
    .input(
      z
        .object({
          // Hours to look back from "now". Default 24 h matches the
          // default visual window in the Logs tab.
          hours: z.number().int().min(1).max(24 * 14).default(24),
          topSources: z.number().int().min(1).max(50).default(10),
        })
        .default({ hours: 24, topSources: 10 }),
    )
    .query(async ({ ctx, input }) => {
      assertAdmin(ctx.session.user.role);
      const since = new Date(Date.now() - input.hours * 3600 * 1000);

      // By level — cheap thanks to the (level, createdAt) index.
      const byLevelRows = await ctx.db.log.groupBy({
        by: ["level"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      });
      const byLevel: Record<LogLevel, number> = {
        DEBUG: 0,
        INFO: 0,
        WARN: 0,
        ERROR: 0,
      };
      for (const r of byLevelRows) byLevel[r.level] = r._count._all;

      // By source — top N, descending. Prisma `groupBy` doesn't let us
      // `orderBy _count` + `take` reliably on all adapters, so we sort
      // in JS. Cardinality is low (O(dozens)).
      const bySourceRows = await ctx.db.log.groupBy({
        by: ["source"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      });
      const bySource = bySourceRows
        .map((r) => ({ source: r.source, count: r._count._all }))
        .sort((a, b) => b.count - a.count)
        .slice(0, input.topSources);

      // Per-hour histogram, split by level, for a stacked bar chart.
      // `date_trunc('hour', …)` keys rows to the UTC hour boundary.
      // Raw SQL because Prisma `groupBy` can't project a derived column.
      const histRaw = await ctx.db.$queryRaw<
        Array<{ bucket: Date; level: LogLevel; count: bigint }>
      >(Prisma.sql`
        SELECT date_trunc('hour', created_at) AS bucket,
               level,
               COUNT(*)::bigint AS count
        FROM logs
        WHERE created_at >= ${since}
        GROUP BY bucket, level
        ORDER BY bucket ASC
      `);
      const perHour = histRaw.map((r) => ({
        bucket: r.bucket,
        level: r.level,
        count: Number(r.count),
      }));

      const total = byLevelRows.reduce((a, r) => a + r._count._all, 0);
      return { since, hours: input.hours, total, byLevel, bySource, perHour };
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertAdmin(ctx.session.user.role);
      const row = await ctx.db.log.findUnique({ where: { id: input.id } });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Log row not found" });
      }
      return row;
    }),

  /**
   * Bulk export of the currently-filtered log set. Same filter schema
   * as `list` (minus cursor/limit) so the UI can call it with the
   * filters the admin applied to the table. We deliberately cap the
   * response at `MAX_EXPORT_ROWS` — the intent is "download what you
   * see and a reasonable slice more", not "dump the whole table".
   * Beyond the cap the admin should narrow the filters.
   *
   * Returned in newest-first order to match the on-screen list so the
   * JSON file reads the same way the UI does.
   */
  export: protectedProcedure
    .input(
      z.object({
        from: z.date().optional(),
        to: z.date().optional(),
        levels: z.array(z.enum(LOG_LEVELS)).optional(),
        sources: z.array(z.string().min(1)).optional(),
        search: z.string().optional(),
        userId: z.string().optional(),
        assessmentId: z.string().optional(),
        jobId: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertAdmin(ctx.session.user.role);
      const MAX_EXPORT_ROWS = 10_000;
      const where: Prisma.LogWhereInput = {};
      if (input.from) where.createdAt = { ...(where.createdAt as object), gte: input.from };
      if (input.to) where.createdAt = { ...(where.createdAt as object), lte: input.to };
      if (input.levels && input.levels.length > 0) where.level = { in: input.levels };
      if (input.sources && input.sources.length > 0) where.source = { in: input.sources };
      if (input.userId) where.userId = input.userId;
      if (input.assessmentId) where.assessmentId = input.assessmentId;
      if (input.jobId) where.jobId = input.jobId;
      if (input.search && input.search.length > 0) {
        where.message = { contains: input.search, mode: "insensitive" };
      }
      // `take: MAX + 1` lets us tell the caller whether the set was
      // truncated without a separate count query.
      const rows = await ctx.db.log.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: MAX_EXPORT_ROWS + 1,
      });
      const truncated = rows.length > MAX_EXPORT_ROWS;
      return {
        rows: truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows,
        truncated,
        limit: MAX_EXPORT_ROWS,
      };
    }),
});
