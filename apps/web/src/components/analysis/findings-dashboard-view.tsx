"use client";

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, type BarRow } from "@/components/charts/bar-chart";
import { domainLabel } from "@/lib/domain-labels";
import {
  ChartCard,
  ClearFiltersButton,
  ConfidenceSlider,
  countBy,
  DashboardEmpty,
  KpiStrip,
  MultiSelectPills,
  SEVERITY_ORDER,
  SEVERITY_SEGMENT_CLASS,
  SearchInput,
} from "./dashboard-parts";
import { useDomainFilter } from "./use-domain-filter";

const FINDING_TYPES = [
  "STRENGTH",
  "WEAKNESS",
  "GAP",
  "OBSERVATION",
  "OPPORTUNITY",
] as const;

export function FindingsDashboardView({
  assessmentId,
}: {
  assessmentId: string;
}) {
  const query = trpc.finding.listByAssessment.useQuery({ assessmentId });

  // Domain filter is driven by the clickable badges in the page shell
  // (URL `?domain=…`), not a local MultiSelect — one source of truth
  // across both list and dashboard views.
  const activeDomain = useDomainFilter();
  const [severities, setSeverities] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [minConfidence, setMinConfidence] = useState(0);
  const [search, setSearch] = useState("");

  const findings = query.data ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return findings.filter((f) => {
      if (activeDomain && f.domain !== activeDomain) return false;
      if (severities.size > 0 && !severities.has(f.severity)) return false;
      if (types.size > 0 && !types.has(f.findingType)) return false;
      if (f.confidence < minConfidence) return false;
      if (q) {
        const hay = `${f.title}\n${f.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [findings, activeDomain, severities, types, minConfidence, search]);

  if (query.isLoading) return <Skeleton className="h-48 w-full" />;
  if (query.error) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {query.error.message}
      </p>
    );
  }

  // Domain filter lives in the URL and is cleared by re-clicking the
  // active badge in the shell — so the local "Clear filters" only
  // clears the local axes.
  const clearFilters = () => {
    setSeverities(new Set());
    setTypes(new Set());
    setMinConfidence(0);
    setSearch("");
  };

  const anyFilter =
    severities.size > 0 ||
    types.size > 0 ||
    minConfidence > 0 ||
    search.length > 0;

  // KPIs computed on filtered data so the strip tracks the current view.
  const total = filtered.length;
  const withEvidence = filtered.filter((f) => f.evidenceIds.length > 0).length;
  const meanConfidence =
    filtered.length === 0
      ? 0
      : filtered.reduce((a, f) => a + f.confidence, 0) / filtered.length;
  const topSeverity = (() => {
    for (const s of SEVERITY_ORDER) {
      const n = filtered.filter((f) => f.severity === s).length;
      if (n > 0) return { sev: s, n };
    }
    return null;
  })();

  const byDomain: BarRow[] = Array.from(countBy(filtered, (f) => f.domain))
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ key: k, label: domainLabel(k), value: v }));

  const bySeverity: BarRow[] = SEVERITY_ORDER.map((s) => ({
    key: s,
    label: s,
    value: filtered.filter((f) => f.severity === s).length,
  })).filter((r) => r.value > 0);

  const domainSeverityStacked: BarRow[] = byDomain.map((row) => {
    const items = filtered.filter((f) => f.domain === row.key);
    return {
      key: row.key,
      label: row.label,
      value: row.value,
      segments: SEVERITY_ORDER.map((s) => ({
        key: s,
        value: items.filter((f) => f.severity === s).length,
        className: SEVERITY_SEGMENT_CLASS[s],
      })).filter((seg) => seg.value > 0),
    };
  });

  return (
    <div className="space-y-4">
      <KpiStrip
        items={[
          { label: "Total findings", value: total },
          {
            label: "With evidence",
            value:
              total === 0 ? "0%" : `${Math.round((withEvidence / total) * 100)}%`,
            hint: `${withEvidence} of ${total} cite evidence`,
          },
          {
            label: "Mean confidence",
            value: `${Math.round(meanConfidence * 100)}%`,
          },
          {
            label: "Top severity",
            value: topSeverity
              ? `${topSeverity.sev} · ${topSeverity.n}`
              : "—",
          },
        ]}
      />

      <div className="grid gap-3 rounded-md border bg-muted/10 p-3 md:grid-cols-2 lg:grid-cols-3">
        <MultiSelectPills
          label="Severity"
          options={SEVERITY_ORDER}
          selected={severities}
          onChange={setSeverities}
        />
        <MultiSelectPills
          label="Finding type"
          options={FINDING_TYPES}
          selected={types}
          onChange={setTypes}
          renderLabel={(v) => v.toLowerCase()}
        />
        <ConfidenceSlider value={minConfidence} onChange={setMinConfidence} />
        <SearchInput value={search} onChange={setSearch} />
        <div className="flex items-end">
          <ClearFiltersButton onClear={clearFilters} disabled={!anyFilter} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <DashboardEmpty
          label="No findings match the current filters"
          onClear={clearFilters}
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <ChartCard title="Count by domain">
            <BarChart rows={byDomain} ariaLabel="Findings by domain" />
          </ChartCard>
          <ChartCard title="Count by severity">
            <BarChart rows={bySeverity} ariaLabel="Findings by severity" />
          </ChartCard>
          <ChartCard
            title="Domain × severity"
            description="Each bar is stacked by severity (critical → info)."
          >
            <BarChart
              rows={domainSeverityStacked}
              ariaLabel="Findings by domain and severity"
            />
          </ChartCard>
        </div>
      )}
    </div>
  );
}
