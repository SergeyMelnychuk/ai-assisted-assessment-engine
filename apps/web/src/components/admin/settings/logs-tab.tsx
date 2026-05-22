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
// Agent B owns this module; we import eagerly so the final typecheck
// pass — after their PR lands — resolves the primitive. If it's missing
// at intermediate typechecks, that's cross-agent noise (noted in the
// handoff) rather than something we can fix here.
import { PieChart } from "@/components/charts/pie-chart";
import { LogsViewer } from "@/components/admin/logs-viewer";

/**
 * Logs tab for `/admin/settings?tab=logs`.
 *
 * Splits the tab into two inner views so the page stops competing
 * with itself for vertical space:
 *   - `?view=charts` (default): the at-a-glance rollup cards + charts.
 *   - `?view=table`           : the full `<LogsViewer />` with filters.
 * Inner state rides on the existing `?tab=logs` query param so deep
 * links keep working and back/forward still navigates view changes.
 *
 * The former "per-hour stacked histogram" was dropped — in practice
 * INFO/DEBUG dwarfed the signal we actually care about (ERROR/WARN),
 * so the chart read as noise. Replaced with a 24 h "incidents per
 * hour" chart that shows ERROR + WARN counts only, stacked rose on
 * amber, so a spike pops off the page at a glance.
 */

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];

// Palette mirrors Agent B's Usage tab: slate / blue / amber / rose.
// ERROR = rose is the loud one — picked so a single error bar stays
// readable even when the volume is dwarfed by INFO/DEBUG traffic.
const LEVEL_HEX: Record<LogLevel, string> = {
  DEBUG: "#64748b", // slate-500
  INFO: "#3b82f6", // blue-500
  WARN: "#f59e0b", // amber-500
  ERROR: "#f43f5e", // rose-500
};

const LEVEL_BAR_CLASS: Record<LogLevel, string> = {
  DEBUG: "bg-slate-500",
  INFO: "bg-blue-500",
  WARN: "bg-amber-500",
  ERROR: "bg-rose-500",
};

type InnerView = "charts" | "table";

// Labels read "Dashboards" / "Logs" so the vocabulary matches the
// sibling AI Usage tab (which also uses "Dashboards"). Internal slugs
// stay `charts` / `table` — the URL is the source of truth for deep
// links, and renaming the slug would silently break bookmarks.
const INNER_TABS: Array<{ key: InnerView; label: string }> = [
  { key: "charts", label: "Dashboards" },
  { key: "table", label: "Logs" },
];

function parseView(raw: string | null): InnerView {
  return raw === "table" ? "table" : "charts";
}

function fmtHour(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    hour12: false,
  });
}

export function LogsTab() {
  const router = useRouter();
  const params = useSearchParams();
  const view = parseView(params.get("view"));

  // `router.replace` matches the outer tabs' behaviour — inner view
  // flicks shouldn't pollute history, but the URL still reflects the
  // active pane so a copy-paste lands on the same screen.
  const selectView = useCallback(
    (key: InnerView) => {
      const next = new URLSearchParams(params);
      next.set("tab", "logs");
      next.set("view", key);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Logs sections"
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
                "px-4 py-1.5 text-sm font-medium rounded-md transition-colors " +
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
        {view === "charts" ? <ChartsPane /> : <TablePane />}
      </div>
    </div>
  );
}

/**
 * Charts pane — summary cards, level pie, top sources bar, and the
 * new "incidents per hour" chart. Runs one tRPC query so flipping
 * back from the table pane doesn't pay three round-trips.
 */
function ChartsPane() {
  // Fixed 24h window. Not user-tunable yet — if operators want a wider
  // window they can filter in the table pane. Stable input also keeps
  // the query key cacheable across inner-tab switches.
  const rollups = trpc.adminLogs.rollups.useQuery({ hours: 24, topSources: 10 });

  const data = rollups.data;

  const total = data?.total ?? 0;
  const errorCount = data?.byLevel.ERROR ?? 0;
  const warnCount = data?.byLevel.WARN ?? 0;

  // Pie segments — skip zero-value levels (the primitive treats an
  // all-zero total as empty and renders its own placeholder, which is
  // what we want). We still pass every non-zero level so the built-in
  // legend matches the stable level palette.
  const pieSegments = useMemo(
    () =>
      LEVELS.filter((lvl) => (data?.byLevel[lvl] ?? 0) > 0).map((lvl) => ({
        label: lvl,
        value: data?.byLevel[lvl] ?? 0,
        color: LEVEL_HEX[lvl],
      })),
    [data],
  );

  const sourceRows: BarRow[] = useMemo(
    () =>
      (data?.bySource ?? []).map((r) => ({
        key: r.source,
        label: r.source,
        value: r.count,
      })),
    [data],
  );

  // "Incidents per hour" — replaces the old all-levels stacked
  // histogram. We deliberately drop DEBUG/INFO: they dominate the
  // track so badly that a single ERROR becomes a one-pixel sliver.
  // Stacking WARN (amber) under ERROR (rose) keeps the convention
  // that "loud" sits on top of "yellow". We still pre-fill the full
  // 24-slot window so a silent hour renders as an empty track (a
  // missing slot would imply "no data" which is misleading).
  const incidentRows: BarRow[] = useMemo(() => {
    if (!data) return [];
    const hours = data.hours;
    const base = new Date(data.since);
    base.setMinutes(0, 0, 0);
    const slots: BarRow[] = [];
    for (let i = 0; i < hours; i++) {
      const ts = new Date(base.getTime() + i * 3600 * 1000);
      const key = ts.toISOString();
      slots.push({
        key,
        label: fmtHour(ts),
        value: 0,
        segments: [
          { key: "WARN", value: 0, className: LEVEL_BAR_CLASS.WARN },
          { key: "ERROR", value: 0, className: LEVEL_BAR_CLASS.ERROR },
        ],
      });
    }
    const byKey = new Map(slots.map((s) => [s.key, s]));
    for (const row of data.perHour) {
      if (row.level !== "ERROR" && row.level !== "WARN") continue;
      const k = new Date(row.bucket).toISOString();
      const slot = byKey.get(k);
      if (!slot) continue;
      slot.value += row.count;
      const seg = slot.segments?.find((s) => s.key === row.level);
      if (seg) seg.value = row.count;
    }
    return slots;
  }, [data]);

  const incidentTotal = incidentRows.reduce((a, r) => a + r.value, 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-3">
        <SummaryCard
          title="Total (24 h)"
          value={total}
          hint="All levels, rolling window."
        />
        <SummaryCard
          title="Errors"
          value={errorCount}
          tone="error"
          hint="level = ERROR"
        />
        <SummaryCard
          title="Warnings"
          value={warnCount}
          tone="warn"
          hint="level = WARN"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Level distribution</CardTitle>
            <CardDescription>
              Share of log volume by level over the last 24 h.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PieChart
              segments={pieSegments}
              ariaLabel="Log volume by level"
              emptyLabel="No logs in the last 24 h."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top sources</CardTitle>
            <CardDescription>
              Top 10 source/worker channels by volume, descending.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              rows={sourceRows}
              ariaLabel="Log volume by source"
              emptyLabel="No source activity in the last 24 h."
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Incidents per hour</CardTitle>
          <CardDescription>
            ERROR + WARN counts per hour over the last 24 h. DEBUG/INFO
            are excluded so a spike stays visible against normal traffic.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BarChart
            rows={incidentRows}
            ariaLabel="Errors and warnings per hour"
            emptyLabel={
              incidentTotal === 0
                ? "No errors or warnings in the last 24 h."
                : "No logs in the last 24 h."
            }
          />
          <IncidentLegend />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Table pane — just the existing self-contained viewer. We wrap it
 * so future layout tweaks (e.g. a density toggle) have a home that
 * doesn't touch the shared component.
 */
function TablePane() {
  return <LogsViewer />;
}

function SummaryCard({
  title,
  value,
  hint,
  tone,
}: {
  title: string;
  value: number;
  hint?: string;
  tone?: "error" | "warn";
}) {
  const toneClass =
    tone === "error"
      ? "text-rose-600 dark:text-rose-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground";
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-semibold tabular-nums ${toneClass}`}>
          {value.toLocaleString()}
        </div>
        {hint ? (
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function IncidentLegend() {
  // Only WARN + ERROR show up in the incidents chart, so the legend
  // is intentionally a subset of the level palette.
  const items: LogLevel[] = ["WARN", "ERROR"];
  return (
    <ul className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
      {items.map((lvl) => (
        <li key={lvl} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={`inline-block h-2.5 w-2.5 rounded-sm ${LEVEL_BAR_CLASS[lvl]}`}
          />
          {lvl}
        </li>
      ))}
    </ul>
  );
}
