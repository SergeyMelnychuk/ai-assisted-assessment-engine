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
  PRIORITY_ORDER,
  SearchInput,
} from "./dashboard-parts";
import { useDomainFilter } from "./use-domain-filter";

export function RecommendationsDashboardView({
  assessmentId,
}: {
  assessmentId: string;
}) {
  const query = trpc.recommendation.listByAssessment.useQuery({ assessmentId });

  // Domain filter is driven by the clickable badges in the page shell
  // (URL `?domain=…`) — single source of truth across list + dashboard.
  const activeDomain = useDomainFilter();
  const [priorities, setPriorities] = useState<Set<string>>(new Set());
  const [minConfidence, setMinConfidence] = useState(0);
  const [search, setSearch] = useState("");

  const recs = query.data ?? [];

  const effortOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of recs) if (r.effortIndication) s.add(r.effortIndication);
    return Array.from(s).sort();
  }, [recs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return recs.filter((r) => {
      if (activeDomain && r.domain !== activeDomain) return false;
      if (priorities.size > 0 && !priorities.has(r.priority)) return false;
      if (r.confidence < minConfidence) return false;
      if (q) {
        const hay = `${r.title}\n${r.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [recs, activeDomain, priorities, minConfidence, search]);

  if (query.isLoading) return <Skeleton className="h-48 w-full" />;
  if (query.error) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {query.error.message}
      </p>
    );
  }

  const clearFilters = () => {
    setPriorities(new Set());
    setMinConfidence(0);
    setSearch("");
  };
  const anyFilter =
    priorities.size > 0 || minConfidence > 0 || search.length > 0;

  const total = filtered.length;
  const withEvidence = filtered.filter(
    (r) => r.evidenceIds.length > 0 || r.relatedRiskIds.length > 0,
  ).length;

  const byDomain: BarRow[] = Array.from(countBy(filtered, (r) => r.domain))
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ key: k, label: domainLabel(k), value: v }));

  const byPriority: BarRow[] = PRIORITY_ORDER.map((p) => ({
    key: p,
    label: p,
    value: filtered.filter((r) => r.priority === p).length,
  })).filter((r) => r.value > 0);

  const byEffort: BarRow[] = effortOptions
    .map((e) => ({
      key: e,
      label: e,
      value: filtered.filter((r) => r.effortIndication === e).length,
    }))
    .filter((r) => r.value > 0);

  return (
    <div className="space-y-4">
      <KpiStrip
        items={[
          { label: "Total recommendations", value: total },
          {
            label: "Critical + high",
            value: filtered.filter(
              (r) => r.priority === "CRITICAL" || r.priority === "HIGH",
            ).length,
          },
          {
            label: "With evidence / linked risk",
            value:
              total === 0 ? "0%" : `${Math.round((withEvidence / total) * 100)}%`,
            hint: `${withEvidence} of ${total} cite evidence or a risk`,
          },
          {
            label: "Mean confidence",
            value: `${Math.round(
              (filtered.length === 0
                ? 0
                : filtered.reduce((a, r) => a + r.confidence, 0) /
                  filtered.length) * 100,
            )}%`,
          },
        ]}
      />

      <div className="grid gap-3 rounded-md border bg-muted/10 p-3 md:grid-cols-2 lg:grid-cols-3">
        <MultiSelectPills
          label="Priority"
          options={PRIORITY_ORDER}
          selected={priorities}
          onChange={setPriorities}
        />
        <ConfidenceSlider value={minConfidence} onChange={setMinConfidence} />
        <SearchInput value={search} onChange={setSearch} />
        <div className="flex items-end">
          <ClearFiltersButton onClear={clearFilters} disabled={!anyFilter} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <DashboardEmpty
          label="No recommendations match the current filters"
          onClear={clearFilters}
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <ChartCard title="Count by domain">
            <BarChart rows={byDomain} ariaLabel="Recommendations by domain" />
          </ChartCard>
          <ChartCard title="Count by priority">
            <BarChart rows={byPriority} ariaLabel="Recommendations by priority" />
          </ChartCard>
          {byEffort.length > 0 ? (
            <ChartCard title="Count by effort indication">
              <BarChart rows={byEffort} ariaLabel="Recommendations by effort" />
            </ChartCard>
          ) : null}
        </div>
      )}
    </div>
  );
}
