"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

/**
 * Shared filter-bar primitives for the analysis lists (findings,
 * risks, recommendations, scoring). Each list builds its own
 * arrangement of facets — the components here are the building
 * blocks, not the assembled bar.
 *
 * Why extracted: the four lists need very similar UI (text search,
 * pill-toggle facet rows, a clear-filters affordance) but each has
 * different fields to filter on. Centralising the chrome means new
 * facets are a one-row addition per list rather than a re-skin.
 *
 * The components stay layout-only — state lives in the consuming
 * list. That keeps the URL-driven domain filter (`useDomainFilter`)
 * cleanly separable from the local-state chips, and makes the bar
 * re-usable inside the workflow-step popups where URL filtering
 * doesn't apply.
 */

export function FilterCard({
  matched,
  total,
  hasLocalFilters,
  onClearLocal,
  children,
}: {
  matched: number;
  total: number;
  hasLocalFilters: boolean;
  onClearLocal: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        {children}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            Showing{" "}
            <span className="font-medium text-foreground">{matched}</span> of{" "}
            {total}
          </span>
          {hasLocalFilters ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onClearLocal}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function SearchInput({
  id,
  value,
  onChange,
  placeholder = "e.g. auth, latency, vendor…",
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        Search (title &amp; description)
      </Label>
      <Input
        id={id}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function MinConfidenceSlider({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        Min. confidence: {value}%
      </Label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full"
      />
    </div>
  );
}

/**
 * Domain dropdown. Pulls its options from whatever the consumer
 * passes in (typically the unique set of domains across the row
 * data). Works inside popups too, since it doesn't read the URL.
 */
export function DomainSelect({
  id,
  value,
  onChange,
  options,
  prettify = (v) => v,
}: {
  id: string;
  value: string | null;
  onChange: (v: string | null) => void;
  options: readonly string[];
  prettify?: (v: string) => string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        Domain
      </Label>
      <select
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
      >
        <option value="">All domains</option>
        {options.map((d) => (
          <option key={d} value={d}>
            {prettify(d)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function FilterChipRow({
  label,
  options,
  selected,
  onToggle,
  prettify = (v) => v.toLowerCase(),
}: {
  label: string;
  options: readonly string[];
  selected: string[];
  onToggle: (v: string) => void;
  prettify?: (v: string) => string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onToggle(opt)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                active
                  ? "border-transparent bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              aria-pressed={active}
            >
              {prettify(opt)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
