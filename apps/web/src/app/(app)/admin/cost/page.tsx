import { db } from "@/server/db";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Admin cost dashboard — Phase 3 Week 8 (ADR-0012).
 *
 * Reads the `AuditLog` rows produced by the instrumented Claude +
 * embedding clients and rolls them up by engagement × callType. The
 * server-side query lives in this page (rather than the tRPC
 * `cost.byEngagement` procedure) because the admin gate already
 * server-renders the layout — duplicating the SQL here keeps the page
 * a single DB round-trip and avoids a client waterfall. The tRPC
 * procedure exists for future client-side filters / CSV export.
 *
 * This page is intentionally table-only (no charts). The numbers are
 * the product; a sparkline would distract from the "is anything
 * obviously wrong" read that triggers the dashboard's use.
 */

export const dynamic = "force-dynamic";

interface RawRow {
  engagement_id: string;
  engagement_name: string;
  call_type: string;
  cost: number | null;
  calls: bigint | number;
}

interface AggregatedRow {
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

export default async function AdminCostPage() {
  // Union over the two entityType → engagement paths (Assessment-scoped
  // and Document-scoped). Same shape as the tRPC procedure; if tuning
  // the rollup, update both call-sites.
  const rows = await db.$queryRawUnsafe<RawRow[]>(`
    WITH ai_rows AS (
      SELECT
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

  const byEngagement = new Map<string, AggregatedRow>();
  for (const r of rows) {
    const row =
      byEngagement.get(r.engagement_id) ??
      ({
        engagementId: r.engagement_id,
        engagementName: r.engagement_name,
        analysis: 0,
        scoring: 0,
        deliverable: 0,
        embedding: 0,
        retrievalQuery: 0,
        total: 0,
        calls: 0,
      } as AggregatedRow);
    const cost = Number(r.cost ?? 0);
    const calls = Number(r.calls ?? 0);
    switch (r.call_type) {
      case "analysis":
        row.analysis += cost;
        break;
      case "scoring":
        row.scoring += cost;
        break;
      case "deliverable":
        row.deliverable += cost;
        break;
      case "embedding":
        row.embedding += cost;
        break;
      case "retrieval-query":
        row.retrievalQuery += cost;
        break;
      default:
        // Unknown callType — lands in total, stays out of the per-type
        // columns. Makes migration to new callTypes safe-by-default.
        break;
    }
    row.total += cost;
    row.calls += calls;
    byEngagement.set(r.engagement_id, row);
  }

  const aggregated = Array.from(byEngagement.values()).sort((a, b) =>
    b.total - a.total,
  );

  const grandTotal = aggregated.reduce((acc, r) => acc + r.total, 0);
  const grandCalls = aggregated.reduce((acc, r) => acc + r.calls, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cost by engagement</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Estimated AI spend per engagement, broken down by call type.
          Rollup source: <code>AuditLog</code> rows with
          <code> action = &quot;AI_CALL&quot; </code>.
          Prices from <code>apps/web/src/server/services/ai/pricing.ts</code>.
          See ADR-0012 for methodology.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Totals</CardTitle>
          <CardDescription>
            All-time rollup across every engagement. {grandCalls.toLocaleString()}{" "}
            tracked AI calls · ${grandTotal.toFixed(4)} total estimated USD.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {aggregated.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No AI calls recorded yet. Run an analysis on an assessment
              to populate this view.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium">Engagement</th>
                    <th className="py-2 pr-4 font-medium text-right">Analysis</th>
                    <th className="py-2 pr-4 font-medium text-right">Scoring</th>
                    <th className="py-2 pr-4 font-medium text-right">Deliverable</th>
                    <th className="py-2 pr-4 font-medium text-right">Embedding</th>
                    <th className="py-2 pr-4 font-medium text-right">Retrieval</th>
                    <th className="py-2 pr-4 font-medium text-right">Total</th>
                    <th className="py-2 pr-0 font-medium text-right">Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {aggregated.map((r) => (
                    <tr key={r.engagementId} className="border-b last:border-0">
                      <td className="py-2 pr-4">{r.engagementName}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        ${r.analysis.toFixed(4)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        ${r.scoring.toFixed(4)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        ${r.deliverable.toFixed(4)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        ${r.embedding.toFixed(4)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        ${r.retrievalQuery.toFixed(4)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums font-medium">
                        ${r.total.toFixed(4)}
                      </td>
                      <td className="py-2 pr-0 text-right tabular-nums">
                        {r.calls.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
