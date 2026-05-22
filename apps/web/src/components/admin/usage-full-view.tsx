"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Client-side rendering of the AI-usage model-rollup dashboard.
 *
 * Originally the body of `/admin/usage/page.tsx` (a server component
 * with direct SQL access). Extracted to a client component so the
 * same UI can be rendered inline inside the settings usage tab's
 * "Full usage page" inner tab. Data now flows through the
 * `cost.modelRollup` tRPC procedure instead of raw DB access.
 *
 * Filter state lives locally rather than in the URL because the
 * outer tab state already uses `?tab=usage&view=full` and adding a
 * third, filter-owned layer to the same querystring fights the
 * settings-page tab switcher. The standalone `/admin/usage` route
 * forwards its initial `searchParams` in as `initialFilters` so
 * deep links keep behaving.
 */

export interface UsageFullViewProps {
  /** Initial filter values (e.g. from URL searchParams on first load). */
  initialFilters?: {
    from?: string;
    to?: string;
    model?: string;
    callType?: string;
    provider?: string;
    engagement?: string;
  };
}

type Provider = "Anthropic" | "OpenAI" | "Unknown";
const PROVIDERS: readonly Provider[] = ["Anthropic", "OpenAI", "Unknown"];

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}
function fmtTok(n: number): string {
  return n.toLocaleString();
}
/**
 * Render a UTC timestamp (server always stores UTC) in the admin's
 * *local* zone. `toLocaleString(undefined, …)` uses the browser's
 * zone by default; the options lock the shape so the column stays
 * scannable across locales.
 */
function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
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

/**
 * Parse a `<input type="datetime-local">` value (`yyyy-MM-ddTHH:mm`,
 * optional `:ss`) as a `Date` in the browser's local zone, and return
 * its UTC ISO string. We build the Date from parts so the local-zone
 * interpretation is unambiguous (the ECMAScript rule "no-offset =
 * local" has been quietly wrong in some runtimes). Empty in → empty
 * out so callers can hand this straight to the form→query pipeline.
 */
function localDatetimeToUtcIso(v: string): string {
  if (!v) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return v; // let the server's fallback parse decide
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
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * Normalise the various shapes `initialFilters.from`/`to` might arrive
 * in (bare date `YYYY-MM-DD`, a datetime-local string, or an ISO
 * instant) to the `yyyy-MM-ddTHH:mm` form the `datetime-local` input
 * expects — always in the *local* zone. Bare dates become local
 * midnight; ISO instants are re-expressed in local wall time.
 */
function toDatetimeLocalValue(v: string | undefined): string {
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) {
    // already a local datetime-local shape — strip any seconds tail
    return v.slice(0, 16);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function UsageFullView({ initialFilters }: UsageFullViewProps) {
  const tz = localTzName();
  // Two state slices: `form` is what the inputs reflect as the user
  // types; `applied` is what the query actually runs against. Clicking
  // Apply (or changing a select) copies form→applied. Keeps tRPC
  // round-trips to one per apply rather than one per keystroke.
  //
  // `from` / `to` are held as `yyyy-MM-ddTHH:mm` local strings so the
  // `datetime-local` input can round-trip them cleanly. We only
  // convert to a UTC ISO string at the edge (just before the tRPC
  // call) — the server stores UTC so the filter comparison is always
  // apples-to-apples instants regardless of who's looking.
  const [form, setForm] = useState(() => ({
    from: toDatetimeLocalValue(initialFilters?.from),
    to: toDatetimeLocalValue(initialFilters?.to),
    model: initialFilters?.model ?? "",
    callType: initialFilters?.callType ?? "",
    provider: initialFilters?.provider ?? "",
    engagement: initialFilters?.engagement ?? "",
  }));
  const [applied, setApplied] = useState(form);

  const query = trpc.cost.modelRollup.useQuery(
    {
      from: localDatetimeToUtcIso(applied.from) || undefined,
      to: localDatetimeToUtcIso(applied.to) || undefined,
      model: applied.model || undefined,
      callType: applied.callType || undefined,
      provider: applied.provider || undefined,
      engagement: applied.engagement || undefined,
    },
    { refetchOnWindowFocus: false },
  );

  const data = query.data;
  const modelRows = data?.rows ?? [];
  const modelOptions = data?.modelOptions ?? [];
  const callTypeOptions = data?.callTypeOptions ?? [];
  const engagementOptions = data?.engagementOptions ?? [];
  const engagementDetail = data?.engagementDetail ?? null;

  const totalsByProvider = useMemo(() => {
    return PROVIDERS.map((p) => {
      const subset = modelRows.filter((r) => r.provider === p);
      return {
        provider: p,
        calls: subset.reduce((a, b) => a + b.calls, 0),
        inputTokens: subset.reduce((a, b) => a + b.inputTokens, 0),
        outputTokens: subset.reduce((a, b) => a + b.outputTokens, 0),
        cacheReadTokens: subset.reduce((a, b) => a + b.cacheReadTokens, 0),
        cost: subset.reduce((a, b) => a + b.cost, 0),
        modelCount: new Set(subset.map((r) => r.model)).size,
      };
    }).filter((t) => t.calls > 0);
  }, [modelRows]);

  const grandTotal = modelRows.reduce((a, r) => a + r.cost, 0);
  const grandCalls = modelRows.reduce((a, r) => a + r.calls, 0);

  const anthropic = modelRows.filter((r) => r.provider === "Anthropic");
  const anthropicInput = anthropic.reduce((a, b) => a + b.inputTokens, 0);
  const anthropicCacheRead = anthropic.reduce(
    (a, b) => a + b.cacheReadTokens,
    0,
  );
  const anthropicCacheCreation = anthropic.reduce(
    (a, b) => a + b.cacheCreationTokens,
    0,
  );
  const cacheHitRatio =
    anthropicInput + anthropicCacheRead === 0
      ? 0
      : anthropicCacheRead / (anthropicInput + anthropicCacheRead);

  const hasActiveFilter =
    !!applied.from ||
    !!applied.to ||
    !!applied.model ||
    !!applied.callType ||
    !!applied.provider ||
    !!applied.engagement;

  function onApply(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setApplied(form);
  }
  function onClear() {
    const empty = {
      from: "",
      to: "",
      model: "",
      callType: "",
      provider: "",
      engagement: "",
    };
    setForm(empty);
    setApplied(empty);
  }

  return (
    <div className="space-y-6">
      {/* Filters — client-side form submit so we can re-render the
          same page with a new `applied` state without navigating. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription>
            Narrow the rollup by date range, provider, model, or call
            type. Leave a field blank to ignore it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={onApply}
            className="grid gap-3 md:grid-cols-3 lg:grid-cols-6 md:items-end"
          >
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">From ({tz})</span>
              <input
                type="datetime-local"
                value={form.from}
                onChange={(e) =>
                  setForm((f) => ({ ...f, from: e.target.value }))
                }
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">To ({tz})</span>
              <input
                type="datetime-local"
                value={form.to}
                onChange={(e) =>
                  setForm((f) => ({ ...f, to: e.target.value }))
                }
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Provider</span>
              <select
                value={form.provider}
                onChange={(e) =>
                  setForm((f) => ({ ...f, provider: e.target.value }))
                }
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">All providers</option>
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Model</span>
              <select
                value={form.model}
                onChange={(e) =>
                  setForm((f) => ({ ...f, model: e.target.value }))
                }
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm font-mono text-xs"
              >
                <option value="">All models</option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Call type</span>
              <select
                value={form.callType}
                onChange={(e) =>
                  setForm((f) => ({ ...f, callType: e.target.value }))
                }
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">All call types</option>
                {callTypeOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Engagement</span>
              <select
                value={form.engagement}
                onChange={(e) =>
                  setForm((f) => ({ ...f, engagement: e.target.value }))
                }
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">All engagements</option>
                {engagementOptions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.clientName}
                  </option>
                ))}
              </select>
            </label>
            <div className="md:col-span-3 lg:col-span-6 flex items-center gap-2">
              <Button type="submit" size="sm">
                Apply
              </Button>
              {hasActiveFilter ? (
                <button
                  type="button"
                  onClick={onClear}
                  className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Clear
                </button>
              ) : null}
              {hasActiveFilter ? (
                <span className="text-xs text-muted-foreground">
                  Filtered view — showing {fmtTok(grandCalls)} matching
                  call{grandCalls === 1 ? "" : "s"}.
                </span>
              ) : null}
              {query.isFetching ? (
                <span className="text-xs text-muted-foreground">Loading…</span>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      {engagementDetail ? (
        <Card>
          <CardHeader>
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <CardTitle className="text-base">
                  {engagementDetail.name}
                </CardTitle>
                <CardDescription>
                  Client: {engagementDetail.clientName}
                  {engagementDetail.industry
                    ? ` · ${engagementDetail.industry}`
                    : ""}{" "}
                  · Status: {engagementDetail.status} ·{" "}
                  {engagementDetail.assessmentCount} assessment
                  {engagementDetail.assessmentCount === 1 ? "" : "s"} ·
                  Created {fmtDate(engagementDetail.createdAt)}
                </CardDescription>
              </div>
              <Link
                href={`/engagements/${engagementDetail.id}`}
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Open engagement →
              </Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                Owner{engagementDetail.owners.length === 1 ? "" : "s"}
              </div>
              {engagementDetail.owners.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  No OWNER assigned — assign one via the engagement
                  members page.
                </p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {engagementDetail.owners.map((u) => (
                    <li key={u.id} className="tabular-nums">
                      <span className="font-medium">{u.name}</span>{" "}
                      <span className="text-muted-foreground">
                        ({u.email})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {engagementDetail.otherMembers.length > 0 ? (
              <div>
                <div className="text-xs font-medium text-muted-foreground">
                  Other members
                </div>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {engagementDetail.otherMembers.map((m) => (
                    <li key={m.id}>
                      <span className="font-medium">{m.name}</span>{" "}
                      <span className="text-muted-foreground">
                        ({m.email}) · {m.role}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : applied.engagement ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Engagement not found
            </CardTitle>
            <CardDescription>
              The selected engagement id doesn&apos;t exist anymore. It
              may have been deleted. Clear the filter to see all data.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {query.isLoading ? (
        <Card>
          <CardHeader>
            <CardTitle>Loading…</CardTitle>
            <CardDescription>
              Computing the model-by-callType rollup.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : modelRows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {hasActiveFilter ? "No rows match" : "No AI activity yet"}
            </CardTitle>
            <CardDescription>
              {hasActiveFilter ? (
                <>
                  No <code>AI_CALL</code> audit rows match the current
                  filter. Widen the date range or clear a field above.
                </>
              ) : (
                <>
                  Run an analysis, upload a document, or generate a
                  deliverable to populate this view. If you&apos;ve
                  done those already and nothing appears, the worker
                  may be running in fake embedding mode — check{" "}
                  <code>OPENAI_API_KEY</code> and restart it.
                </>
              )}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {totalsByProvider.map((t) => (
              <Card key={t.provider}>
                <CardHeader>
                  <div className="flex items-baseline justify-between gap-2">
                    <CardTitle className="text-base">{t.provider}</CardTitle>
                    <span className="text-xs text-muted-foreground">
                      {t.modelCount} model{t.modelCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <CardDescription>
                    {t.calls.toLocaleString()} call
                    {t.calls === 1 ? "" : "s"} · {fmtUsd(t.cost)}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-1 text-xs text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Input tokens</span>
                    <span className="tabular-nums">
                      {fmtTok(t.inputTokens)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Output tokens</span>
                    <span className="tabular-nums">
                      {fmtTok(t.outputTokens)}
                    </span>
                  </div>
                  {t.cacheReadTokens > 0 ? (
                    <div className="flex justify-between">
                      <span>Cache-read tokens</span>
                      <span className="tabular-nums">
                        {fmtTok(t.cacheReadTokens)}
                      </span>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Grand total</CardTitle>
              <CardDescription>
                {fmtTok(grandCalls)} tracked call
                {grandCalls === 1 ? "" : "s"} · {fmtUsd(grandTotal)} estimated
                USD.
                {anthropic.length > 0 && anthropicCacheRead > 0 ? (
                  <>
                    {" "}
                    Anthropic prompt-cache hit ratio:{" "}
                    <span className="font-medium text-foreground">
                      {(cacheHitRatio * 100).toFixed(1)}%
                    </span>{" "}
                    ({fmtTok(anthropicCacheRead)} read /{" "}
                    {fmtTok(anthropicCacheCreation)} created).
                  </>
                ) : null}
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>By model × call type</CardTitle>
              <CardDescription>
                One row per (model, callType). Sorted by cost
                descending. Fake-mode embedding rows (no API key) are
                merged with live rows for the same model.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-2 pr-4 font-medium">Provider</th>
                      <th className="py-2 pr-4 font-medium">Model</th>
                      <th className="py-2 pr-4 font-medium">Call type</th>
                      <th className="py-2 pr-4 font-medium text-right">
                        Calls
                      </th>
                      <th className="py-2 pr-4 font-medium text-right">
                        Input
                      </th>
                      <th className="py-2 pr-4 font-medium text-right">
                        Output
                      </th>
                      <th className="py-2 pr-4 font-medium text-right">
                        Cache-read
                      </th>
                      <th className="py-2 pr-4 font-medium text-right">
                        Cost
                      </th>
                      <th className="py-2 pr-0 font-medium text-right">
                        Last call ({tz})
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelRows.map((r) => (
                      <tr
                        key={`${r.model}::${r.callType}`}
                        className="border-b last:border-0"
                      >
                        <td className="py-2 pr-4">{r.provider}</td>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {r.model}
                        </td>
                        <td className="py-2 pr-4">{r.callType}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {fmtTok(r.calls)}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {fmtTok(r.inputTokens)}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {fmtTok(r.outputTokens)}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                          {r.cacheReadTokens > 0
                            ? fmtTok(r.cacheReadTokens)
                            : "—"}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums font-medium">
                          {fmtUsd(r.cost)}
                        </td>
                        <td className="py-2 pr-0 text-right text-xs text-muted-foreground">
                          {fmtDate(r.lastSeen)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
