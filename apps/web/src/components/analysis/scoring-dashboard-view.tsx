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
  DashboardEmpty,
  KpiStrip,
  MultiSelectPills,
  SearchInput,
} from "./dashboard-parts";
import { useDomainFilter } from "./use-domain-filter";

const MATURITY_ORDER = [
  "AD_HOC",
  "INITIAL",
  "DEFINED",
  "MANAGED",
  "OPTIMIZED",
] as const;

export function ScoringDashboardView({
  assessmentId,
}: {
  assessmentId: string;
}) {
  const query = trpc.scoring.listByAssessment.useQuery({ assessmentId });

  // Domain filter is driven by the clickable badges in the page shell
  // (URL `?domain=…`).
  const activeDomain = useDomainFilter();
  const [levels, setLevels] = useState<Set<string>>(new Set());
  const [minConfidence, setMinConfidence] = useState(0);
  const [search, setSearch] = useState("");

  const scores = query.data ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scores.filter((s) => {
      if (activeDomain && s.domain !== activeDomain) return false;
      if (levels.size > 0 && !levels.has(s.maturityLevel)) return false;
      if (s.confidence < minConfidence) return false;
      if (q) {
        const hay = `${s.domain}\n${s.scoringRationale ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [scores, activeDomain, levels, minConfidence, search]);

  if (query.isLoading) return <Skeleton className="h-48 w-full" />;
  if (query.error) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {query.error.message}
      </p>
    );
  }

  const clearFilters = () => {
    setLevels(new Set());
    setMinConfidence(0);
    setSearch("");
  };
  const anyFilter =
    levels.size > 0 || minConfidence > 0 || search.length > 0;

  const total = filtered.length;
  const meanScore =
    total === 0 ? 0 : filtered.reduce((a, s) => a + s.score, 0) / total;
  const meanConfidence =
    total === 0 ? 0 : filtered.reduce((a, s) => a + s.confidence, 0) / total;

  const byDomain: BarRow[] = [...filtered]
    .sort((a, b) => b.score - a.score)
    .map((s) => ({ key: s.domain, label: domainLabel(s.domain), value: s.score }));

  const byLevel: BarRow[] = MATURITY_ORDER.map((l) => ({
    key: l,
    label: l.replace(/_/g, " ").toLowerCase(),
    value: filtered.filter((s) => s.maturityLevel === l).length,
  })).filter((r) => r.value > 0);

  return (
    <div className="space-y-4">
      <KpiStrip
        items={[
          { label: "Scored domains", value: total },
          {
            label: "Mean score",
            value: meanScore.toFixed(2),
            hint: "0–5 scale",
          },
          {
            label: "Mean confidence",
            value: `${Math.round(meanConfidence * 100)}%`,
          },
          {
            label: "At or above DEFINED",
            value: filtered.filter((s) =>
              ["DEFINED", "MANAGED", "OPTIMIZED"].includes(s.maturityLevel),
            ).length,
          },
        ]}
      />

      <div className="grid gap-3 rounded-md border bg-muted/10 p-3 md:grid-cols-2 lg:grid-cols-3">
        <MultiSelectPills
          label="Maturity level"
          options={MATURITY_ORDER}
          selected={levels}
          onChange={setLevels}
          renderLabel={(v) => v.replace(/_/g, " ").toLowerCase()}
        />
        <ConfidenceSlider value={minConfidence} onChange={setMinConfidence} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search rationale"
        />
        <div className="flex items-end">
          <ClearFiltersButton onClear={clearFilters} disabled={!anyFilter} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <DashboardEmpty
          label="No scores match the current filters"
          onClear={clearFilters}
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <ChartCard title="Score by domain" description="0–5 scale.">
            <BarChart rows={byDomain} ariaLabel="Score per domain" maxValue={5} />
          </ChartCard>
          <ChartCard title="Count by maturity level">
            <BarChart rows={byLevel} ariaLabel="Domains per maturity level" />
          </ChartCard>
        </div>
      )}
    </div>
  );
}
