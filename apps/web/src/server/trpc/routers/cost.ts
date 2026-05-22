import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";

/**
 * Cost-dashboard router — Phase 3 Week 8 (ADR-0012).
 *
 * Aggregates `AuditLog` rows where `action = 'AI_CALL'` by engagement
 * and `callType`, summing `details.estimatedCostUsd`. The row-level
 * detail shape is:
 *
 *   { callType, model, inputTokens, outputTokens,
 *     cacheReadInputTokens, cacheCreationInputTokens,
 *     estimatedCostUsd, pricingVersion }
 *
 * Produced by `callClaude` (for `analysis | scoring | deliverable`),
 * `embedTexts` (for `embedding | retrieval-query`).
 *
 * Entity linkage:
 *   - Analysis / scoring / deliverable rows use `entityType =
 *     'Assessment'` with `entityId = assessmentId`. We join to
 *     `Assessment` to discover the engagement.
 *   - Embedding / retrieval rows for `Document` entityType need the
 *     document → assessment → engagement traversal; the SQL below
 *     unions both paths so a single rollup query handles everything.
 *
 * ADMIN-only. The rollup includes every engagement the platform has
 * ever spent tokens on; we trust the admin-layout gate at the route
 * level and additionally assert the session role here so a misconfigured
 * procedure call can't bypass it.
 */

const ByEngagementRow = z.object({
  engagementId: z.string(),
  engagementName: z.string(),
  analysis: z.number(),
  scoring: z.number(),
  deliverable: z.number(),
  embedding: z.number(),
  retrievalQuery: z.number(),
  total: z.number(),
  calls: z.number(),
});

interface RawByEngagementRow {
  engagement_id: string;
  engagement_name: string;
  call_type: string;
  cost: string | number | null;
  calls: bigint | number;
}

// Week 9 ADR-0013 follow-up: usage-tab needs a by-callType rollup.
// These three procedures power the colored charts on
// `/admin/settings?tab=usage` without duplicating the table-oriented
// aggregations already exposed for `/admin/cost` and `/admin/usage`.
// We keep the queries small and single-purpose so each chart renders
// in one round-trip and the cache key is obvious.
const ByCallTypeRow = z.object({
  callType: z.string(),
  cost: z.number(),
  tokens: z.number(),
  calls: z.number(),
});

const DailyStackedDay = z.object({
  // ISO `YYYY-MM-DD`, UTC day boundary — keeps the key stable across
  // client timezones without having to serialize a full Date.
  date: z.string(),
  byCallType: z.record(z.string(), z.number()),
  total: z.number(),
});

const TopAssessmentRow = z.object({
  assessmentId: z.string(),
  assessmentName: z.string(),
  engagementName: z.string(),
  cost: z.number(),
  calls: z.number(),
});

// Week 10: the settings usage tab gained an inner "Full usage page"
// view that renders the same content as `/admin/usage` inline. That
// page is an async server component with direct SQL access, so we
// expose the same rollup via tRPC for the client-side tab body.
// Shapes mirror the server page's `ModelRow` / option-list types; the
// client component picks strings for provider/model/callType/date range
// via URL state and narrows on the server.
const ModelRollupRow = z.object({
  provider: z.enum(["Anthropic", "OpenAI", "Unknown"]),
  model: z.string(),
  callType: z.string(),
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  cost: z.number(),
  firstSeen: z.date().nullable(),
  lastSeen: z.date().nullable(),
});

const EngagementDetailOut = z
  .object({
    id: z.string(),
    name: z.string(),
    clientName: z.string(),
    industry: z.string().nullable(),
    status: z.string(),
    createdAt: z.date(),
    owners: z.array(
      z.object({ id: z.string(), name: z.string(), email: z.string() }),
    ),
    otherMembers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        email: z.string(),
        role: z.string(),
      }),
    ),
    assessmentCount: z.number(),
  })
  .nullable();

const ModelRollupOut = z.object({
  rows: z.array(ModelRollupRow),
  modelOptions: z.array(z.string()),
  callTypeOptions: z.array(z.string()),
  engagementOptions: z.array(
    z.object({ id: z.string(), name: z.string(), clientName: z.string() }),
  ),
  engagementDetail: EngagementDetailOut,
});

type Provider = "Anthropic" | "OpenAI" | "Unknown";
const PROVIDERS_INTERNAL: readonly Provider[] = [
  "Anthropic",
  "OpenAI",
  "Unknown",
];
function providerForModel(model: string): Provider {
  if (model.startsWith("claude-")) return "Anthropic";
  if (model.startsWith("text-embedding-")) return "OpenAI";
  return "Unknown";
}

export const costRouter = createRouter({
  /**
   * Cost rolled up by engagement + callType. ADMIN-only.
   *
   * Optional `sinceDays` input narrows the window (default: all-time) —
   * handy when the audit table grows and a full-table scan gets slow.
   */
  byEngagement: protectedProcedure
    .input(
      z
        .object({ sinceDays: z.number().int().positive().max(365).optional() })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      if (ctx.session.user.role !== "ADMIN") {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      const sinceDays = input?.sinceDays;
      // Two sub-queries unioned — one for assessment-scoped rows,
      // one for document-scoped rows — then outer-grouped. Using
      // raw SQL because Prisma JSON aggregation can't sum across
      // `details->>'estimatedCostUsd'` in a portable way.
      const sinceClause = sinceDays
        ? `AND a.created_at > NOW() - INTERVAL '${sinceDays} days'`
        : "";

      const rows = await ctx.db.$queryRawUnsafe<RawByEngagementRow[]>(`
        WITH ai_rows AS (
          SELECT
            a.id AS audit_id,
            a.created_at,
            a.details->>'callType' AS call_type,
            COALESCE((a.details->>'estimatedCostUsd')::numeric, 0) AS cost,
            asmt_a.engagement_id AS engagement_id_a,
            asmt_d.engagement_id AS engagement_id_d
          FROM audit_logs a
          LEFT JOIN assessments asmt_a
            ON a.entity_type = 'Assessment' AND asmt_a.id = a.entity_id
          LEFT JOIN documents d
            ON a.entity_type = 'Document' AND d.id = a.entity_id
          LEFT JOIN assessments asmt_d
            ON asmt_d.id = d.assessment_id
          WHERE a.action = 'AI_CALL'
            ${sinceClause}
        )
        SELECT
          eng.id AS engagement_id,
          eng.name AS engagement_name,
          r.call_type,
          SUM(r.cost)::float8 AS cost,
          COUNT(*) AS calls
        FROM ai_rows r
        JOIN engagements eng
          ON eng.id = COALESCE(r.engagement_id_a, r.engagement_id_d)
        GROUP BY eng.id, eng.name, r.call_type
        ORDER BY eng.name
      `);

      // Pivot into one row per engagement with per-callType columns.
      const byEngagement = new Map<
        string,
        {
          engagementId: string;
          engagementName: string;
          analysis: number;
          scoring: number;
          deliverable: number;
          embedding: number;
          retrievalQuery: number;
          total: number;
          calls: number;
        }
      >();
      for (const r of rows) {
        const existing = byEngagement.get(r.engagement_id) ?? {
          engagementId: r.engagement_id,
          engagementName: r.engagement_name,
          analysis: 0,
          scoring: 0,
          deliverable: 0,
          embedding: 0,
          retrievalQuery: 0,
          total: 0,
          calls: 0,
        };
        const cost = Number(r.cost ?? 0);
        const calls = Number(r.calls ?? 0);
        switch (r.call_type) {
          case "analysis":
            existing.analysis += cost;
            break;
          case "scoring":
            existing.scoring += cost;
            break;
          case "deliverable":
            existing.deliverable += cost;
            break;
          case "embedding":
            existing.embedding += cost;
            break;
          case "retrieval-query":
            existing.retrievalQuery += cost;
            break;
          default:
            // Unknown callType lands in total but not in any bucket —
            // visible via the discrepancy. Not a breaking case.
            break;
        }
        existing.total += cost;
        existing.calls += calls;
        byEngagement.set(r.engagement_id, existing);
      }

      const result = Array.from(byEngagement.values());
      // Validate the shape once at the router boundary so the client
      // infers a clean tuple type, not `any`.
      return z.array(ByEngagementRow).parse(result);
    }),

  /**
   * Week 9 ADR-0013 follow-up: usage-tab needs a by-callType rollup.
   *
   * Spend + token + call counts grouped solely by `details.callType`.
   * The pie chart on the settings usage tab consumes this — each
   * slice is a callType and its angle is its share of total cost.
   * ADMIN-only.
   */
  byCallType: protectedProcedure
    .input(
      z
        .object({ sinceDays: z.number().int().positive().max(365).optional() })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      if (ctx.session.user.role !== "ADMIN") {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      const sinceDays = input?.sinceDays;
      const sinceClause = sinceDays
        ? `AND a.created_at > NOW() - INTERVAL '${sinceDays} days'`
        : "";
      const rows = await ctx.db.$queryRawUnsafe<
        Array<{
          call_type: string | null;
          cost: number | null;
          tokens: bigint | number | null;
          calls: bigint | number;
        }>
      >(`
        SELECT
          a.details->>'callType' AS call_type,
          SUM(COALESCE((a.details->>'estimatedCostUsd')::numeric, 0))::float8 AS cost,
          SUM(
            COALESCE((a.details->>'inputTokens')::bigint, 0) +
            COALESCE((a.details->>'outputTokens')::bigint, 0)
          ) AS tokens,
          COUNT(*) AS calls
        FROM audit_logs a
        WHERE a.action = 'AI_CALL' ${sinceClause}
        GROUP BY call_type
        ORDER BY cost DESC NULLS LAST
      `);
      const result = rows
        .filter((r) => r.call_type)
        .map((r) => ({
          callType: r.call_type ?? "unknown",
          cost: Number(r.cost ?? 0),
          tokens: Number(r.tokens ?? 0),
          calls: Number(r.calls ?? 0),
        }));
      return z.array(ByCallTypeRow).parse(result);
    }),

  /**
   * Week 9 ADR-0013 follow-up: usage-tab needs a by-callType rollup.
   *
   * Daily stacked tokens for the last N days (default 14), bucketed
   * by callType. The stacked bar chart on the settings usage tab
   * consumes this — each day is a row, each callType a segment.
   * Zero-volume days are filled in client-side so the bar chart has
   * a continuous x-axis; we don't emit empty rows from SQL.
   */
  dailyStacked: protectedProcedure
    .input(
      z
        .object({ days: z.number().int().positive().max(90).default(14) })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      if (ctx.session.user.role !== "ADMIN") {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      const days = input?.days ?? 14;
      const rows = await ctx.db.$queryRawUnsafe<
        Array<{
          day: string;
          call_type: string | null;
          tokens: bigint | number | null;
        }>
      >(`
        SELECT
          to_char(date_trunc('day', a.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
          a.details->>'callType' AS call_type,
          SUM(
            COALESCE((a.details->>'inputTokens')::bigint, 0) +
            COALESCE((a.details->>'outputTokens')::bigint, 0)
          ) AS tokens
        FROM audit_logs a
        WHERE a.action = 'AI_CALL'
          AND a.created_at > NOW() - INTERVAL '${days} days'
        GROUP BY day, call_type
        ORDER BY day ASC
      `);

      // Pivot into per-day rows with a byCallType map.
      const byDay = new Map<string, Map<string, number>>();
      for (const r of rows) {
        const m = byDay.get(r.day) ?? new Map<string, number>();
        const key = r.call_type ?? "unknown";
        m.set(key, (m.get(key) ?? 0) + Number(r.tokens ?? 0));
        byDay.set(r.day, m);
      }

      // Fill the full window — including empty days — so the chart
      // x-axis is continuous. Generated client-side of Postgres in JS
      // because the generate_series variant is noisier than this loop.
      const out: Array<{
        date: string;
        byCallType: Record<string, number>;
        total: number;
      }> = [];
      const today = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        const m = byDay.get(key);
        const byCallType: Record<string, number> = {};
        let total = 0;
        if (m) {
          for (const [k, v] of m.entries()) {
            byCallType[k] = v;
            total += v;
          }
        }
        out.push({ date: key, byCallType, total });
      }
      return z.array(DailyStackedDay).parse(out);
    }),

  /**
   * Week 9 ADR-0013 follow-up: usage-tab needs a by-callType rollup.
   *
   * Top N (default 10) assessments by total AI spend. Drives the
   * horizontal-bar "most expensive assessments" chart. Only rows
   * whose `entityType = 'Assessment'` participate — document-scoped
   * embedding/retrieval rows are out of scope (they cost cents and
   * would crowd out the expensive Claude calls).
   *
   * NOTE: Unused as of Week 10 — the "Top 10 assessments" chart was
   * removed from the settings usage tab because it duplicated the
   * engagement-level rollup on `/admin/usage`. Kept in place so other
   * dashboards (or a future "cost outliers" widget) can pick it up
   * without re-deriving the SQL. Safe to delete once nothing imports it.
   */
  topAssessments: protectedProcedure
    .input(
      z
        .object({ limit: z.number().int().positive().max(50).default(10) })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      if (ctx.session.user.role !== "ADMIN") {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      const limit = input?.limit ?? 10;
      const rows = await ctx.db.$queryRawUnsafe<
        Array<{
          assessment_id: string;
          assessment_name: string;
          engagement_name: string;
          cost: number | null;
          calls: bigint | number;
        }>
      >(`
        SELECT
          asmt.id AS assessment_id,
          asmt.name AS assessment_name,
          eng.name AS engagement_name,
          SUM(COALESCE((a.details->>'estimatedCostUsd')::numeric, 0))::float8 AS cost,
          COUNT(*) AS calls
        FROM audit_logs a
        JOIN assessments asmt
          ON a.entity_type = 'Assessment' AND asmt.id = a.entity_id
        JOIN engagements eng
          ON eng.id = asmt.engagement_id
        WHERE a.action = 'AI_CALL'
        GROUP BY asmt.id, asmt.name, eng.name
        ORDER BY cost DESC NULLS LAST
        LIMIT ${limit}
      `);
      const result = rows.map((r) => ({
        assessmentId: r.assessment_id,
        assessmentName: r.assessment_name,
        engagementName: r.engagement_name,
        cost: Number(r.cost ?? 0),
        calls: Number(r.calls ?? 0),
      }));
      return z.array(TopAssessmentRow).parse(result);
    }),

  /**
   * Week 10: full model-rollup feed for the inline "Full usage page"
   * view inside `/admin/settings?tab=usage&view=full`. Mirrors the
   * SQL already used by the standalone `/admin/usage` server page so
   * both surfaces agree on numbers. Filters are optional strings; we
   * parse date inputs as `YYYY-MM-DD` and bump the `to` bound to the
   * next day so the window is inclusive on the right.
   *
   * Provider filtering is post-SQL (inferred from the model string)
   * to match the server page's behaviour without widening the schema.
   * Engagement detail is returned only when an engagement filter is
   * active, otherwise it's null (one fewer round-trip on the common
   * "all engagements" case).
   */
  modelRollup: protectedProcedure
    .input(
      z
        .object({
          from: z.string().optional(),
          to: z.string().optional(),
          model: z.string().optional(),
          callType: z.string().optional(),
          provider: z.string().optional(),
          engagement: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      if (ctx.session.user.role !== "ADMIN") {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      const fromRaw = input?.from;
      const toRaw = input?.to;
      const modelFilter = input?.model ?? "";
      const callTypeFilter = input?.callType ?? "";
      const providerFilterRaw = input?.provider ?? "";
      const providerFilter: Provider | "" = (
        PROVIDERS_INTERNAL as readonly string[]
      ).includes(providerFilterRaw)
        ? (providerFilterRaw as Provider)
        : "";
      const engagementFilter = input?.engagement ?? "";

      // Accept either legacy `YYYY-MM-DD` (interpreted as UTC midnight
      // → end = +24h) or an ISO-8601 instant (what the client now sends
      // after converting the `datetime-local` wall time to UTC). This
      // keeps old bookmarked URLs working while letting admins filter
      // with minute precision in their local zone.
      const parseInstant = (
        raw: string | undefined,
      ): { at: Date; isDateOnly: boolean } | null => {
        if (!raw) return null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          const d = new Date(`${raw}T00:00:00.000Z`);
          return Number.isNaN(d.getTime())
            ? null
            : { at: d, isDateOnly: true };
        }
        const d = new Date(raw);
        return Number.isNaN(d.getTime())
          ? null
          : { at: d, isDateOnly: false };
      };
      const fromParsed = parseInstant(fromRaw);
      const toParsed = parseInstant(toRaw);
      const fromDate = fromParsed?.at ?? null;
      // Legacy date-only `to` is inclusive of the chosen day, so bump
      // by +24h to get an exclusive upper bound. datetime instants are
      // already exact and used verbatim.
      const toDateExclusive = toParsed
        ? toParsed.isDateOnly
          ? new Date(toParsed.at.getTime() + 24 * 60 * 60 * 1000)
          : toParsed.at
        : null;

      const whereParts: string[] = ["a.action = 'AI_CALL'"];
      const params: unknown[] = [];
      if (fromDate) {
        params.push(fromDate);
        whereParts.push(`a.created_at >= $${params.length}`);
      }
      if (toDateExclusive) {
        params.push(toDateExclusive);
        whereParts.push(`a.created_at < $${params.length}`);
      }
      if (modelFilter) {
        params.push(modelFilter);
        whereParts.push(
          `regexp_replace(COALESCE(a.details->>'model', ''), '\\+fake$', '') = $${params.length}`,
        );
      }
      if (callTypeFilter) {
        params.push(callTypeFilter);
        whereParts.push(`a.details->>'callType' = $${params.length}`);
      }
      if (engagementFilter) {
        params.push(engagementFilter);
        whereParts.push(
          `COALESCE(asmt_a.engagement_id, asmt_d.engagement_id) = $${params.length}`,
        );
      }
      const whereSql = whereParts.join(" AND ");

      const raw = await ctx.db.$queryRawUnsafe<
        Array<{
          model: string | null;
          call_type: string | null;
          calls: bigint | number;
          input_tokens: bigint | number | null;
          output_tokens: bigint | number | null;
          cache_read_tokens: bigint | number | null;
          cache_creation_tokens: bigint | number | null;
          cost: number | null;
          first_seen: Date | null;
          last_seen: Date | null;
        }>
      >(
        `
        SELECT
          regexp_replace(COALESCE(a.details->>'model', ''), '\\+fake$', '') AS model,
          a.details->>'callType' AS call_type,
          COUNT(*) AS calls,
          SUM(COALESCE((a.details->>'inputTokens')::bigint, 0)) AS input_tokens,
          SUM(COALESCE((a.details->>'outputTokens')::bigint, 0)) AS output_tokens,
          SUM(COALESCE((a.details->>'cacheReadInputTokens')::bigint, 0)) AS cache_read_tokens,
          SUM(COALESCE((a.details->>'cacheCreationInputTokens')::bigint, 0)) AS cache_creation_tokens,
          SUM(COALESCE((a.details->>'estimatedCostUsd')::numeric, 0))::float8 AS cost,
          MIN(a.created_at) AS first_seen,
          MAX(a.created_at) AS last_seen
        FROM audit_logs a
        LEFT JOIN assessments asmt_a
          ON a.entity_type = 'Assessment' AND asmt_a.id = a.entity_id
        LEFT JOIN documents d
          ON a.entity_type = 'Document' AND d.id = a.entity_id
        LEFT JOIN assessments asmt_d
          ON asmt_d.id = d.assessment_id
        WHERE ${whereSql}
        GROUP BY model, call_type
        ORDER BY cost DESC NULLS LAST
      `,
        ...params,
      );

      // Unfiltered option lists so the select dropdowns don't collapse
      // to the currently selected value.
      const optionRows = await ctx.db.$queryRawUnsafe<
        { model: string | null; call_type: string | null }[]
      >(`
        SELECT DISTINCT
          regexp_replace(COALESCE(a.details->>'model', ''), '\\+fake$', '') AS model,
          a.details->>'callType' AS call_type
        FROM audit_logs a
        WHERE a.action = 'AI_CALL'
      `);
      const modelOptions = Array.from(
        new Set(
          optionRows.map((r) => r.model ?? "").filter((s) => s.length > 0),
        ),
      ).sort();
      const callTypeOptions = Array.from(
        new Set(
          optionRows
            .map((r) => r.call_type ?? "")
            .filter((s) => s.length > 0),
        ),
      ).sort();

      const engagementOptionRows = await ctx.db.$queryRawUnsafe<
        { id: string; name: string; client_name: string }[]
      >(`
        SELECT DISTINCT eng.id, eng.name, eng.client_name
        FROM audit_logs a
        LEFT JOIN assessments asmt_a
          ON a.entity_type = 'Assessment' AND asmt_a.id = a.entity_id
        LEFT JOIN documents d
          ON a.entity_type = 'Document' AND d.id = a.entity_id
        LEFT JOIN assessments asmt_d
          ON asmt_d.id = d.assessment_id
        JOIN engagements eng
          ON eng.id = COALESCE(asmt_a.engagement_id, asmt_d.engagement_id)
        WHERE a.action = 'AI_CALL'
        ORDER BY eng.name
      `);
      const engagementOptions = engagementOptionRows.map((r) => ({
        id: r.id,
        name: r.name,
        clientName: r.client_name,
      }));

      let engagementDetail: z.infer<typeof EngagementDetailOut> = null;
      if (engagementFilter) {
        const eng = await ctx.db.engagement.findUnique({
          where: { id: engagementFilter },
          include: {
            members: {
              include: {
                user: { select: { id: true, name: true, email: true } },
              },
            },
            _count: { select: { assessments: true } },
          },
        });
        if (eng) {
          const owners = eng.members
            .filter((m) => m.role === "OWNER")
            .map((m) => ({
              id: m.user.id,
              name: m.user.name,
              email: m.user.email,
            }));
          const otherMembers = eng.members
            .filter((m) => m.role !== "OWNER")
            .map((m) => ({
              id: m.user.id,
              name: m.user.name,
              email: m.user.email,
              role: m.role,
            }));
          engagementDetail = {
            id: eng.id,
            name: eng.name,
            clientName: eng.clientName,
            industry: eng.industry,
            status: eng.status,
            createdAt: eng.createdAt,
            owners,
            otherMembers,
            assessmentCount: eng._count.assessments,
          };
        }
      }

      let rows = raw
        .filter((r) => r.model && r.model.length > 0)
        .map((r) => ({
          provider: providerForModel(r.model ?? ""),
          model: r.model ?? "",
          callType: r.call_type ?? "unknown",
          calls: Number(r.calls ?? 0),
          inputTokens: Number(r.input_tokens ?? 0),
          outputTokens: Number(r.output_tokens ?? 0),
          cacheReadTokens: Number(r.cache_read_tokens ?? 0),
          cacheCreationTokens: Number(r.cache_creation_tokens ?? 0),
          cost: Number(r.cost ?? 0),
          firstSeen: r.first_seen,
          lastSeen: r.last_seen,
        }));

      if (providerFilter) {
        rows = rows.filter((r) => r.provider === providerFilter);
      }

      return ModelRollupOut.parse({
        rows,
        modelOptions,
        callTypeOptions,
        engagementOptions,
        engagementDetail,
      });
    }),
});
