"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BarChart, type BarRow } from "@/components/charts/bar-chart";
import { PieChart, type PieSegment } from "@/components/charts/pie-chart";
import { UsageFullView } from "@/components/admin/usage-full-view";

/**
 * AI Usage tab for `/admin/settings?tab=usage`.
 *
 * Split into two inner views via a nested tab control:
 *
 *   - Diagrams        (?view=diagrams, default) — summary cards + pie
 *     (spend by callType) + stacked daily-tokens bar. A quick-glance
 *     executive dashboard.
 *   - Full usage page (?view=full)              — the model × callType
 *     rollup rendered inline by `<UsageFullView />` so the admin
 *     doesn't have to navigate to `/admin/usage` for the detail view.
 *
 * Inner-tab state is mirrored into `?view=` so deep links
 * (`?tab=usage&view=full`) land on the right sub-panel. The outer tab
 * switcher owns `?tab=`; we only touch `?view=` here.
 *
 * Week 10 edit: the former "Top 10 most expensive assessments" chart
 * was redundant with the engagement-level rollup on the Full usage
 * page and has been removed. The underlying `cost.topAssessments`
 * tRPC procedure is kept (marked unused) in case another dashboard
 * picks it up.
 */

// Hex palette (emerald/blue/amber/violet/rose/slate) chosen for
// high contrast on both light and dark themes. These are literal
// hex rather than Tailwind class names because `<svg fill=>` and
// inline-style swatches need resolved colors, not utility classes.
const CALLTYPE_PALETTE: readonly string[] = [
  "#10b981", // emerald-500
  "#3b82f6", // blue-500
  "#f59e0b", // amber-500
  "#8b5cf6", // violet-500
  "#f43f5e", // rose-500
  "#64748b", // slate-500
];

// Parallel Tailwind classes for the stacked-bar segments — the
// bar-chart primitive accepts `className` on each segment, and
// Tailwind's JIT will only emit classes it sees literally.
const CALLTYPE_BAR_CLASSES: readonly string[] = [
  "bg-emerald-500",
  "bg-blue-500",
  "bg-amber-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-slate-500",
];

function colorFor(index: number): string {
  return CALLTYPE_PALETTE[index % CALLTYPE_PALETTE.length] ?? "#64748b";
}
function barClassFor(index: number): string {
  return (
    CALLTYPE_BAR_CLASSES[index % CALLTYPE_BAR_CLASSES.length] ?? "bg-slate-500"
  );
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
function fmtTok(n: number): string {
  return n.toLocaleString();
}
function shortDay(iso: string): string {
  // `YYYY-MM-DD` → `MM/DD` for compact x-axis labels. Parsed by
  // hand because `new Date("YYYY-MM-DD")` treats the value as UTC
  // and then renders in local time, which can shift the label by
  // a day for east-of-UTC users.
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  return `${parts[1]}/${parts[2]}`;
}

type InnerView = "diagrams" | "full";

const INNER_TABS: Array<{ key: InnerView; label: string }> = [
  // Renamed "Diagrams" → "Dashboards" so the label is consistent
  // with the Logs tab (which also uses "Dashboards" for its visual
  // rollup view). Internal slug stays `diagrams` — the URL is the
  // deep-link contract; renaming the slug would silently break any
  // bookmark pointing at `?tab=usage&view=diagrams`.
  { key: "diagrams", label: "Dashboards" },
  { key: "full", label: "Full usage page" },
];

function parseInnerView(raw: string | null): InnerView {
  return raw === "full" ? "full" : "diagrams";
}

/**
 * Named export (tabs.tsx imports `{ UsageTab }` from this path).
 * Client component because all data hooks are `useQuery` and the
 * inner-tab state reads `useSearchParams`.
 */
export function UsageTab() {
  const router = useRouter();
  const params = useSearchParams();
  const view = parseInnerView(params.get("view"));

  // `router.replace` mirrors the inner-tab into the URL without
  // stacking history entries. Preserves the outer `?tab=` plus any
  // filters a sibling feature might layer on later.
  const selectView = useCallback(
    (next: InnerView) => {
      const p = new URLSearchParams(params);
      p.set("view", next);
      router.replace(`?${p.toString()}`, { scroll: false });
    },
    [params, router],
  );

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="AI usage sub-views"
        className="inline-flex rounded-lg border bg-muted/40 p-1"
      >
        {INNER_TABS.map((t) => {
          const isActive = t.key === view;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => selectView(t.key)}
              className={
                "px-3 py-1 text-sm font-medium rounded-md transition-colors " +
                (isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel">
        {view === "diagrams" ? <DiagramsView /> : <UsageFullView />}
      </div>
    </div>
  );
}

/**
 * The colorful summary view — three keeper charts after the Week 10
 * cleanup. Extracted into its own component so the two inner-tab
 * panels stay visually aligned at the top level of `UsageTab`.
 */
function DiagramsView() {
  const byCallType = trpc.cost.byCallType.useQuery({ sinceDays: 30 });
  const daily = trpc.cost.dailyStacked.useQuery({ days: 14 });

  // Assign a stable color per callType across both charts — the order
  // comes from the by-callType response (sorted by cost desc), and
  // both the pie and the stacked-bar reuse the same index→color
  // mapping so a reader's eye doesn't have to re-map.
  const callTypeOrder = useMemo(() => {
    const rows = byCallType.data ?? [];
    return rows.map((r) => r.callType);
  }, [byCallType.data]);

  const callTypeColor = useMemo(() => {
    const m = new Map<string, { hex: string; className: string }>();
    callTypeOrder.forEach((ct, i) => {
      m.set(ct, { hex: colorFor(i), className: barClassFor(i) });
    });
    return m;
  }, [callTypeOrder]);

  const pieSegments: PieSegment[] = useMemo(() => {
    const rows = byCallType.data ?? [];
    return rows.map((r, i) => ({
      label: r.callType,
      value: r.cost,
      color: colorFor(i),
    }));
  }, [byCallType.data]);

  // Stacked bars — one row per day, each segment keyed by callType
  // so the bar-chart primitive can render proportional widths.
  const dailyRows: BarRow[] = useMemo(() => {
    const rows = daily.data ?? [];
    return rows.map((d) => {
      const segments = Object.entries(d.byCallType).map(([key, value]) => ({
        key,
        value,
        className: callTypeColor.get(key)?.className ?? "bg-slate-500",
      }));
      return {
        key: d.date,
        label: shortDay(d.date),
        value: d.total,
        segments,
      };
    });
  }, [daily.data, callTypeColor]);

  // Summary numbers — derived from the same queries so there's no
  // extra round-trip just for totals. Month-to-date is a fine stand-in
  // for "this month" here because the query window is 30d.
  const totalSpend = useMemo(
    () => (byCallType.data ?? []).reduce((a, r) => a + r.cost, 0),
    [byCallType.data],
  );
  const totalTokens = useMemo(
    () => (byCallType.data ?? []).reduce((a, r) => a + r.tokens, 0),
    [byCallType.data],
  );
  const totalCalls = useMemo(
    () => (byCallType.data ?? []).reduce((a, r) => a + r.calls, 0),
    [byCallType.data],
  );

  const isLoading = byCallType.isLoading || daily.isLoading;

  return (
    <div className="space-y-6">
      {/* Summary cards — the top-of-tab "how are we doing?" row. */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Spend (last 30d)</CardTitle>
            <CardDescription>
              {isLoading ? "Loading…" : fmtUsd(totalSpend)}
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tokens (last 30d)</CardTitle>
            <CardDescription>
              {isLoading ? "Loading…" : fmtTok(totalTokens)}
            </CardDescription>
          </CardHeader>
        </Card>
        {/* "AI calls" rather than "Claude calls" because the number
            rolls up every agent/workflow that hit the AI layer —
            generator, verifier, scoring, deliverable, embedding,
            retrieval. The micro-breakdown beneath the total names the
            active agents so an admin can see at a glance which ones
            contributed without having to read the pie. If we ever
            route some calls through a second provider, the label
            stays accurate. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">AI calls (last 30d)</CardTitle>
            <CardDescription>
              {isLoading ? "Loading…" : fmtTok(totalCalls)}
            </CardDescription>
            {!isLoading && totalCalls > 0 ? (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                {(byCallType.data ?? []).map((r) => (
                  <span key={r.callType}>
                    <span className="font-medium text-foreground">
                      {r.callType}
                    </span>
                    <span className="opacity-70"> {fmtTok(r.calls)}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Spend by agent</CardTitle>
            <CardDescription>
              Share of the last 30 days of AI spend, split by the
              agent/workflow that made the call — analysis, verifier,
              scoring, deliverable, embedding, and retrieval each get
              their own slice. Each color matches the daily stacked
              bars below so you can follow one agent across charts.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PieChart
              segments={pieSegments}
              size={200}
              ariaLabel="AI spend by call type"
              emptyLabel="No usage yet — run an analysis to populate this chart."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Daily tokens (last 14 days)</CardTitle>
            <CardDescription>
              Total input+output tokens per UTC day, stacked by call
              type. Colors match the pie chart legend on the left.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              rows={dailyRows}
              ariaLabel="Daily tokens stacked by call type"
              emptyLabel="No token usage in the last 14 days."
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
