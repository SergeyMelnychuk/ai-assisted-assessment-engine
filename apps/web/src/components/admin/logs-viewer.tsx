"use client";

import { useEffect, useMemo, useState } from "react";
import { trpc, type RouterOutputs, type RouterInputs } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
type LogRow = RouterOutputs["adminLogs"]["list"]["items"][number];
type LogDetail = RouterOutputs["adminLogs"]["get"];

const LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];

const LEVEL_BADGE: Record<LogLevel, string> = {
  DEBUG: "bg-muted text-muted-foreground",
  INFO: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  WARN: "bg-amber-500/20 text-amber-800 dark:text-amber-300",
  ERROR: "bg-red-500/15 text-red-700 dark:text-red-400",
};

interface Filters {
  // `<input type="datetime-local">` values — `yyyy-MM-ddTHH:mm` in the
  // browser's local zone. Stored as strings so the form round-trips
  // cleanly; we only convert to `Date` when sending to the server.
  from: string;
  to: string;
  levels: LogLevel[];
  sources: string[];
  search: string;
  userId: string;
  assessmentId: string;
  jobId: string;
}

const EMPTY_FILTERS: Filters = {
  from: "",
  to: "",
  levels: [],
  sources: [],
  search: "",
  userId: "",
  assessmentId: "",
  jobId: "",
};

/**
 * Parse a `<input type="datetime-local">` value — always `yyyy-MM-ddTHH:mm`
 * (optionally `:ss`) with *no* timezone suffix — as a `Date` in the
 * browser's local zone. We construct the Date from parts rather than
 * `new Date(v)` because the ECMAScript rule "no-offset datetime = local"
 * is subtle and has been quietly wrong in some runtimes; building via
 * `new Date(y, m-1, d, ...)` is unambiguous. The returned `Date` is a
 * UTC instant (that's all a `Date` ever is) corresponding to the local
 * wall time the admin typed — the server stores timestamps in UTC, so
 * Prisma's filter works on apples-to-apples instants.
 */
function parseLocalDateTime(v: string): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) {
    // Fallback for any odd browser that emits a different shape.
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const [, y, mo, da, h, mi, s] = m;
  const d = new Date(
    Number(y),
    Number(mo) - 1,
    Number(da),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
    0,
  );
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Shared conversion for both `list` and `export` — they take the same
 * filter fields. Previously we padded `to` by +24h because the picker
 * was date-only and we wanted the range to be inclusive of that day.
 * With `datetime-local` the admin picks the exact minute, so no fudge.
 */
function toFilterInput(f: Filters) {
  return {
    from: parseLocalDateTime(f.from),
    to: parseLocalDateTime(f.to),
    levels: f.levels.length > 0 ? f.levels : undefined,
    sources: f.sources.length > 0 ? f.sources : undefined,
    search: f.search || undefined,
    userId: f.userId || undefined,
    assessmentId: f.assessmentId || undefined,
    jobId: f.jobId || undefined,
  };
}

function toListInput(f: Filters): RouterInputs["adminLogs"]["list"] {
  return { ...toFilterInput(f), limit: 100 };
}

/**
 * Format a timestamp (UTC instant from the server — either a `Date` or
 * an ISO string) in the *browser's* local zone. Server stores UTC;
 * admins want to read wall-clock time where they're sitting.
 */
function fmtTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Short IANA tz name for the current browser, e.g. "Europe/Kyiv". */
function localTzName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

export function LogsViewer() {
  const tz = localTzName();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // The filters the current query actually reflects — bumped only when
  // the admin clicks "Apply" or clears, so editing the filter bar
  // doesn't refetch on every keystroke.
  const [activeFilters, setActiveFilters] = useState<Filters>(EMPTY_FILTERS);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  // One-shot export state. Tracks "busy" so the button can disable,
  // and a trailing status line so the admin sees row counts / truncation.
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const sourcesQuery = trpc.adminLogs.sources.useQuery();

  // We fetch each "page" as an independent query keyed on its cursor,
  // then stitch them together client-side. Simpler than useInfiniteQuery
  // here because our router returns `{ items, nextCursor }` directly.
  const pages = cursors.map((cursor) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    trpc.adminLogs.list.useQuery(
      { ...toListInput(activeFilters), cursor: cursor ?? undefined },
      {
        // Pause auto-refresh when a row is open so polling doesn't
        // pull the drawer out from under the admin.
        refetchInterval: autoRefresh && selected === null ? 10_000 : false,
      },
    ),
  );

  const items: LogRow[] = useMemo(() => {
    const all: LogRow[] = [];
    for (const p of pages) {
      if (p.data) all.push(...p.data.items);
    }
    return all;
  }, [pages]);

  const isLoading = pages.some((p) => p.isLoading);
  const lastPage = pages[pages.length - 1];
  const hasMore = lastPage?.data?.nextCursor != null;

  const detailQuery = trpc.adminLogs.get.useQuery(
    { id: selected ?? "" },
    { enabled: selected != null },
  );

  // When filters change (via Apply), reset pagination.
  useEffect(() => {
    setCursors([null]);
  }, [activeFilters]);

  const hasActive =
    !!activeFilters.from ||
    !!activeFilters.to ||
    activeFilters.levels.length > 0 ||
    activeFilters.sources.length > 0 ||
    !!activeFilters.search ||
    !!activeFilters.userId ||
    !!activeFilters.assessmentId ||
    !!activeFilters.jobId;

  const toggleLevel = (lvl: LogLevel) => {
    setFilters((f) => ({
      ...f,
      levels: f.levels.includes(lvl)
        ? f.levels.filter((l) => l !== lvl)
        : [...f.levels, lvl],
    }));
  };

  const toggleSource = (src: string) => {
    setFilters((f) => ({
      ...f,
      sources: f.sources.includes(src)
        ? f.sources.filter((s) => s !== src)
        : [...f.sources, src],
    }));
  };

  const applyFilters = () => setActiveFilters(filters);
  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setActiveFilters(EMPTY_FILTERS);
  };

  /**
   * Export the currently-applied filter set as a JSON file. We call
   * `export` instead of walking the paginated `list` client-side so
   * the download is one round-trip and the server can enforce its
   * truncation cap atomically. Uses the *active* filters — the ones
   * the table is showing — rather than the draft edits still in the
   * form, so "Export" always matches what's on screen.
   */
  const exportLogs = async () => {
    setExporting(true);
    setExportStatus(null);
    try {
      const result = await utils.adminLogs.export.fetch(
        toFilterInput(activeFilters),
      );
      const payload = {
        exportedAt: new Date().toISOString(),
        filters: toFilterInput(activeFilters),
        rowCount: result.rows.length,
        truncated: result.truncated,
        limit: result.limit,
        rows: result.rows,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `logs-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportStatus(
        result.truncated
          ? `Exported ${result.rows.length} rows (capped at ${result.limit} — narrow filters to include the rest).`
          : `Exported ${result.rows.length} row${result.rows.length === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      setExportStatus(
        err instanceof Error ? `Export failed: ${err.message}` : "Export failed.",
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription>
            Date range and correlators run server-side. Search is a
            case-insensitive substring match against the message only
            (context JSON is excluded — use a correlator for that).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="logs-from" className="text-xs text-muted-foreground">
                From ({tz})
              </Label>
              <Input
                id="logs-from"
                type="datetime-local"
                value={filters.from}
                onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="logs-to" className="text-xs text-muted-foreground">
                To ({tz})
              </Label>
              <Input
                id="logs-to"
                type="datetime-local"
                value={filters.to}
                onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="logs-search" className="text-xs text-muted-foreground">
                Search (message)
              </Label>
              <Input
                id="logs-search"
                type="text"
                placeholder="e.g. worker online"
                value={filters.search}
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="logs-userId" className="text-xs text-muted-foreground">
                User id
              </Label>
              <Input
                id="logs-userId"
                type="text"
                value={filters.userId}
                onChange={(e) => setFilters((f) => ({ ...f, userId: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="logs-assessmentId" className="text-xs text-muted-foreground">
                Assessment id
              </Label>
              <Input
                id="logs-assessmentId"
                type="text"
                value={filters.assessmentId}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, assessmentId: e.target.value }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="logs-jobId" className="text-xs text-muted-foreground">
                Job id
              </Label>
              <Input
                id="logs-jobId"
                type="text"
                value={filters.jobId}
                onChange={(e) => setFilters((f) => ({ ...f, jobId: e.target.value }))}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Level</Label>
            <div className="flex flex-wrap gap-2">
              {LEVELS.map((lvl) => {
                const active = filters.levels.includes(lvl);
                return (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => toggleLevel(lvl)}
                    className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                      active
                        ? `${LEVEL_BADGE[lvl]} border-transparent`
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {lvl}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Source</Label>
            {sourcesQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : sourcesQuery.data && sourcesQuery.data.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {sourcesQuery.data.map((src) => {
                  const active = filters.sources.includes(src);
                  return (
                    <button
                      key={src}
                      type="button"
                      onClick={() => toggleSource(src)}
                      className={`rounded-md border px-2.5 py-1 font-mono text-xs transition ${
                        active
                          ? "bg-foreground text-background border-transparent"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {src}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No sources yet — nothing has been logged.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={applyFilters}>
              Apply
            </Button>
            {hasActive ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={clearFilters}
              >
                Clear
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={exportLogs}
              disabled={exporting}
              title="Download the current filter selection as JSON"
            >
              {exporting ? "Exporting…" : "Export JSON"}
            </Button>
            <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              Auto-refresh every 10 s
            </label>
          </div>
          {exportStatus ? (
            <p className="text-xs text-muted-foreground">{exportStatus}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Events</CardTitle>
          <CardDescription>
            Newest first. Click a row for full context JSON.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && items.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Loading…
            </p>
          ) : items.length === 0 ? (
            <div className="space-y-2 py-8 text-center">
              <p className="text-sm text-muted-foreground">
                No logs match the current filters.
              </p>
              {hasActive ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={clearFilters}
                >
                  Clear filters
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Time ({tz})</th>
                    <th className="py-2 pr-4 font-medium">Level</th>
                    <th className="py-2 pr-4 font-medium">Source</th>
                    <th className="py-2 pr-0 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr
                      key={row.id}
                      className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                      onClick={() => setSelected(row.id)}
                    >
                      <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                        {fmtTime(row.createdAt)}
                      </td>
                      <td className="py-2 pr-4">
                        <span
                          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${LEVEL_BADGE[row.level]}`}
                        >
                          {row.level}
                        </span>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{row.source}</td>
                      <td className="py-2 pr-0">{row.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {hasMore ? (
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() =>
                  setCursors((c) => [...c, lastPage?.data?.nextCursor ?? null])
                }
              >
                Load more
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {selected ? (
        <LogDetailDrawer
          detail={detailQuery.data ?? null}
          isLoading={detailQuery.isLoading}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function LogDetailDrawer({
  detail,
  isLoading,
  onClose,
}: {
  detail: LogDetail | null;
  isLoading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative z-10 h-full w-full max-w-xl overflow-y-auto border-l bg-background p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Log detail</h2>
            {detail ? (
              <p className="text-xs text-muted-foreground">
                {fmtTime(detail.createdAt)} · {detail.source}
              </p>
            ) : null}
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !detail ? (
          <p className="text-sm text-muted-foreground">Not found.</p>
        ) : (
          <div className="space-y-4 text-sm">
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                Level
              </div>
              <span
                className={`mt-1 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${LEVEL_BADGE[detail.level]}`}
              >
                {detail.level}
              </span>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                Message
              </div>
              <p className="mt-1 break-words">{detail.message}</p>
            </div>
            {detail.userId || detail.assessmentId || detail.jobId ? (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">
                  Correlators
                </div>
                <dl className="space-y-0.5 text-xs">
                  {detail.userId ? (
                    <div className="flex gap-2">
                      <dt className="w-28 text-muted-foreground">user</dt>
                      <dd className="font-mono">{detail.userId}</dd>
                    </div>
                  ) : null}
                  {detail.assessmentId ? (
                    <div className="flex gap-2">
                      <dt className="w-28 text-muted-foreground">assessment</dt>
                      <dd className="font-mono">{detail.assessmentId}</dd>
                    </div>
                  ) : null}
                  {detail.jobId ? (
                    <div className="flex gap-2">
                      <dt className="w-28 text-muted-foreground">job</dt>
                      <dd className="font-mono">{detail.jobId}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            ) : null}
            {detail.context != null ? (
              <div>
                <div className="text-xs font-medium text-muted-foreground">
                  Context
                </div>
                <pre className="mt-1 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
                  {JSON.stringify(detail.context, null, 2)}
                </pre>
              </div>
            ) : null}
            {detail.error ? (
              <div>
                <div className="text-xs font-medium text-muted-foreground">
                  Error
                </div>
                <pre className="mt-1 max-h-96 overflow-auto rounded-md bg-red-500/5 p-3 text-xs text-red-900 dark:text-red-300">
                  {detail.error}
                </pre>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
