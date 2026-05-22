"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { domainLabel } from "@/lib/domain-labels";

/**
 * Shared bits for the analysis-tab dashboards: KPI strip, filter bar
 * primitives, empty state. Kept here so the per-entity dashboard
 * components stay thin — they just wire up data + pick the right
 * filter controls.
 */

export function KpiStrip({
  items,
}: {
  items: Array<{ label: string; value: string | number; hint?: string }>;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((it) => (
        <Card key={it.label}>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {it.label}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">
              {it.value}
            </div>
            {it.hint ? (
              <p className="mt-1 text-xs text-muted-foreground">{it.hint}</p>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * Multi-select pill list. Callers provide raw option values; we render
 * each via `renderLabel` (defaults to `domainLabel` for domains). Raw
 * values stay in the selected set so backend-shape identifiers aren't
 * ever beautified in props.
 */
export function MultiSelectPills({
  label,
  options,
  selected,
  onChange,
  renderLabel,
}: {
  label: string;
  options: readonly string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  renderLabel?: (v: string) => string;
}) {
  const display = renderLabel ?? ((v: string) => v);
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = selected.has(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => {
                const next = new Set(selected);
                if (next.has(opt)) next.delete(opt);
                else next.add(opt);
                onChange(next);
              }}
              aria-pressed={active}
              className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                active
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-muted/40"
              }`}
            >
              {display(opt)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DomainMultiSelect({
  options,
  selected,
  onChange,
}: {
  options: readonly string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  return (
    <MultiSelectPills
      label="Domain"
      options={options}
      selected={selected}
      onChange={onChange}
      renderLabel={domainLabel}
    />
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search titles & descriptions",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Search
      </label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8"
      />
    </div>
  );
}

export function ConfidenceSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Min confidence: {Math.round(value * 100)}%
      </label>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </div>
  );
}

export function ClearFiltersButton({
  onClear,
  disabled,
}: {
  onClear: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={onClear}
      disabled={disabled}
    >
      Clear filters
    </Button>
  );
}

export function DashboardEmpty({
  label,
  onClear,
}: {
  label: string;
  onClear: () => void;
}) {
  return (
    <div className="rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 p-4 text-center text-sm text-muted-foreground">
      <p>{label}</p>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onClear}
        className="mt-2"
      >
        Clear filters
      </Button>
    </div>
  );
}

export function ChartCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * Severity palette shared by Findings + Risks. Keeps the dashboard in
 * sync with the row badges (see `review-badges.tsx`).
 */
export const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
export const SEVERITY_SEGMENT_CLASS: Record<string, string> = {
  CRITICAL: "bg-destructive/70",
  HIGH: "bg-amber-500/70",
  MEDIUM: "bg-muted-foreground/60",
  LOW: "bg-muted-foreground/40",
  INFO: "bg-muted-foreground/20",
};

export const PRIORITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

export function countBy<T, K extends string>(
  rows: readonly T[],
  key: (row: T) => K | null | undefined,
): Map<K, number> {
  const out = new Map<K, number>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}
