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

const LIKELIHOOD_ORDER = [
  "VERY_LIKELY",
  "LIKELY",
  "POSSIBLE",
  "UNLIKELY",
] as const;
const IMPACT_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;

// Numeric weights for a "mean likelihood × impact" KPI. The scale is
// ordinal — we're averaging for a single reviewer glanceable value,
// not doing real probability math.
const IMPACT_SCORE: Record<string, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 1,
};
const LIKELIHOOD_SCORE: Record<string, number> = {
  VERY_LIKELY: 4,
  LIKELY: 3,
  POSSIBLE: 2,
  UNLIKELY: 1,
};

export function RisksDashboardView({ assessmentId }: { assessmentId: string }) {
  const query = trpc.risk.listByAssessment.useQuery({ assessmentId });

  // Domain filter (Risk stores it as `category`) is driven by the
  // clickable badges in the page shell — URL `?domain=…`.
  const activeDomain = useDomainFilter();
  const [severities, setSeverities] = useState<Set<string>>(new Set());
  const [minConfidence, setMinConfidence] = useState(0);
  const [search, setSearch] = useState("");

  const risks = query.data ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return risks.filter((r) => {
      if (activeDomain && r.category !== activeDomain) return false;
      if (severities.size > 0 && !severities.has(r.severity)) return false;
      if (r.confidence < minConfidence) return false;
      if (q) {
        const hay = `${r.title}\n${r.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [risks, activeDomain, severities, minConfidence, search]);

  if (query.isLoading) return <Skeleton className="h-48 w-full" />;
  if (query.error) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {query.error.message}
      </p>
    );
  }

  const clearFilters = () => {
    setSeverities(new Set());
    setMinConfidence(0);
    setSearch("");
  };
  const anyFilter =
    severities.size > 0 || minConfidence > 0 || search.length > 0;

  const total = filtered.length;
  const meanRiskScore =
    filtered.length === 0
      ? 0
      : filtered.reduce(
          (a, r) =>
            a +
            (IMPACT_SCORE[r.impact] ?? 0) *
              (LIKELIHOOD_SCORE[r.likelihood] ?? 0),
          0,
        ) / filtered.length;
  const critical = filtered.filter((r) => r.severity === "CRITICAL").length;
  const high = filtered.filter((r) => r.severity === "HIGH").length;

  const byDomain: BarRow[] = Array.from(countBy(filtered, (r) => r.category))
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ key: k, label: domainLabel(k), value: v }));

  // Likelihood × impact matrix — one cell per (likelihood, impact) with
  // a count. Rendered as 4 stacked bars (one per likelihood row), each
  // split by impact. A real 2-D heatmap would need SVG; this preserves
  // the signal without adding a library.
  const matrixRows: BarRow[] = LIKELIHOOD_ORDER.map((lk) => {
    const cell = filtered.filter((r) => r.likelihood === lk);
    return {
      key: lk,
      label: lk.replace(/_/g, " ").toLowerCase(),
      value: cell.length,
      segments: IMPACT_ORDER.map((im) => ({
        key: im,
        value: cell.filter((r) => r.impact === im).length,
        className: SEVERITY_SEGMENT_CLASS[im],
      })).filter((s) => s.value > 0),
    };
  }).filter((r) => r.value > 0);

  return (
    <div className="space-y-4">
      <KpiStrip
        items={[
          { label: "Total risks", value: total },
          { label: "Critical", value: critical },
          { label: "High", value: high },
          {
            label: "Mean impact × likelihood",
            value: meanRiskScore.toFixed(1),
            hint: "impact (1–5) × likelihood (1–4)",
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
        <ConfidenceSlider value={minConfidence} onChange={setMinConfidence} />
        <SearchInput value={search} onChange={setSearch} />
        <div className="flex items-end">
          <ClearFiltersButton onClear={clearFilters} disabled={!anyFilter} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <DashboardEmpty
          label="No risks match the current filters"
          onClear={clearFilters}
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <ChartCard title="Count by domain / category">
            <BarChart rows={byDomain} ariaLabel="Risks by category" />
          </ChartCard>
          <ChartCard
            title="Likelihood × impact"
            description="Rows are likelihood (very-likely → unlikely); each bar stacks by impact."
          >
            <BarChart rows={matrixRows} ariaLabel="Risk matrix" />
          </ChartCard>
        </div>
      )}
    </div>
  );
}
