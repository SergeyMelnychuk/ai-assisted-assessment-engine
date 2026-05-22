"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ConfidenceBadge,
  ReviewBadge,
  SeverityBadge,
  prettyDomain,
} from "./review-badges";
import { ReviewStatusSelect } from "./review-status-select";
import { RunAnalysisButton } from "./run-analysis-button";
import { buildEvidenceExplorerHref } from "./evidence-link";
import { DeleteRowButton } from "./row-delete-button";
import { useDomainFilter } from "./use-domain-filter";
import {
  DomainSelect,
  FilterCard,
  FilterChipRow,
  MinConfidenceSlider,
  SearchInput,
} from "./list-filter-bar";

// `text-muted-foreground` on tinted backgrounds — see `review-badges.tsx`
// for the rationale. Category hue stays on border + bg only.
const FINDING_TYPE_TONES: Record<string, string> = {
  STRENGTH: "border-green-500/40 bg-green-500/10 text-muted-foreground",
  WEAKNESS: "border-destructive/40 bg-destructive/10 text-destructive",
  GAP: "border-amber-500/40 bg-amber-500/10 text-muted-foreground",
  OBSERVATION: "border-border bg-muted text-muted-foreground",
  OPPORTUNITY: "border-blue-500/40 bg-blue-500/10 text-muted-foreground",
};

// Canonical filter option sets. Mirrors the Prisma enums but declared
// here so the filter bar doesn't need a round-trip to enumerate them.
// If the enums grow, this list grows too — caught by the switchboard
// above which uses the same keys for tone lookup.
const FINDING_TYPES = ["STRENGTH", "WEAKNESS", "GAP", "OBSERVATION", "OPPORTUNITY"] as const;
const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
const REVIEW_STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED", "NEEDS_REVISION", "REJECTED"] as const;

export function FindingsList({
  assessmentId,
  engagementId,
}: {
  assessmentId: string;
  /**
   * Optional — when provided, each finding row gets a "See evidence"
   * link that deep-links into the Evidence Explorer with `q` + `domain`
   * pre-filled (Phase 3 Week 7 cross-page linkage).
   */
  engagementId?: string;
}) {
  const utils = trpc.useUtils();
  // URL-driven domain filter (the page-shell's clickable badges set
  // this). Inside popups it's null — the local domain dropdown in the
  // filter bar covers that case. Effective filter = local ?? url.
  const urlDomain = useDomainFilter();
  const [localDomain, setLocalDomain] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [severities, setSeverities] = useState<string[]>([]);
  const [reviewStatuses, setReviewStatuses] = useState<string[]>([]);
  // "All" = empty string. Kept as a 0–100 int so the slider step and
  // the display match without float drift.
  const [minConfidence, setMinConfidence] = useState(0);

  const toggle = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const clearLocalFilters = () => {
    setSearch("");
    setTypes([]);
    setSeverities([]);
    setReviewStatuses([]);
    setMinConfidence(0);
    setLocalDomain(null);
  };

  // No background polling — the parent shell's "Refresh" button
  // invalidates this query on demand.
  const query = trpc.finding.listByAssessment.useQuery({ assessmentId });
  // Gate for the per-row trash icon — OWNER or ADMIN only. Cached;
  // the analysis-page shell's Refresh button invalidates it alongside
  // the lists it belongs to.
  const canMutateQuery = trpc.analysis.canMutateOutputs.useQuery({
    assessmentId,
  });
  const canMutate = canMutateQuery.data ?? false;
  const updateMutation = trpc.finding.update.useMutation({
    onSuccess: async () => {
      await utils.finding.listByAssessment.invalidate({ assessmentId });
    },
  });
  const deleteMutation = trpc.finding.delete.useMutation({
    onSuccess: async () => {
      await utils.finding.listByAssessment.invalidate({ assessmentId });
      // Domain scores / summary counts can shift after a deletion too
      // (e.g. empty-state banner, evidence counts). Invalidate the
      // lightweight summary query + the per-domain status so the
      // header badges reflect domains that no longer have any
      // surviving output.
      await utils.analysis.summary.invalidate({ assessmentId });
      await utils.analysis.perDomainStatus.invalidate({ assessmentId });
    },
  });

  // Hoisted above the loading/error early-returns so hook order stays
  // constant across renders — React's Rules of Hooks. The memo reads
  // `query.data ?? []` directly so it's safe to run before the query
  // has resolved.
  const findings = query.data ?? [];

  // All client-side. The row count per assessment is small (dozens,
  // max low hundreds) so we filter in memory rather than round-trip
  // on every keystroke. Memoised so typing in the search box only
  // re-runs the filter, not every card's render.
  const effectiveDomain = localDomain ?? urlDomain ?? null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const minConf = minConfidence / 100;
    return findings.filter((f) => {
      if (effectiveDomain && f.domain !== effectiveDomain) return false;
      if (types.length > 0 && !types.includes(f.findingType)) return false;
      if (severities.length > 0 && !severities.includes(f.severity)) return false;
      if (
        reviewStatuses.length > 0 &&
        !reviewStatuses.includes(f.reviewStatus)
      )
        return false;
      if (f.confidence < minConf) return false;
      if (q) {
        const hay = `${f.title}\n${f.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    findings,
    effectiveDomain,
    types,
    severities,
    reviewStatuses,
    minConfidence,
    search,
  ]);

  const domainOptions = useMemo(() => {
    const set = new Set<string>();
    for (const f of findings) set.add(f.domain);
    return Array.from(set).sort();
  }, [findings]);

  const hasLocalFilters =
    search.length > 0 ||
    types.length > 0 ||
    severities.length > 0 ||
    reviewStatuses.length > 0 ||
    minConfidence > 0 ||
    localDomain !== null;

  if (query.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (query.error) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {query.error.message}
      </p>
    );
  }

  if (findings.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No findings yet</CardTitle>
          <CardDescription>
            Run analysis once you&apos;ve captured enough evidence — uploaded
            documents, answered baseline questions, and (ideally) a diagram or
            two. If you already clicked <em>Run analysis</em> and nothing shows
            up after ~60s, the worker probably failed — check its stdout
            (Anthropic 529 / billing errors are the usual cause).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunAnalysisButton assessmentId={assessmentId} />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <FindingsFilterBar
        search={search}
        onSearchChange={setSearch}
        types={types}
        onToggleType={(v) => setTypes((a) => toggle(a, v))}
        severities={severities}
        onToggleSeverity={(v) => setSeverities((a) => toggle(a, v))}
        reviewStatuses={reviewStatuses}
        onToggleReviewStatus={(v) => setReviewStatuses((a) => toggle(a, v))}
        minConfidence={minConfidence}
        onMinConfidenceChange={setMinConfidence}
        domain={effectiveDomain}
        onDomainChange={setLocalDomain}
        domainOptions={domainOptions}
        hasLocalFilters={hasLocalFilters}
        onClearLocal={clearLocalFilters}
        matched={filtered.length}
        total={findings.length}
      />
      {filtered.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              No findings match the current filters
            </CardTitle>
            <CardDescription>
              {effectiveDomain
                ? "Clear the domain filter above or widen the local filters."
                : "Widen the filters below to see more findings."}
            </CardDescription>
          </CardHeader>
          {hasLocalFilters ? (
            <CardContent>
              <Button size="sm" variant="secondary" onClick={clearLocalFilters}>
                Clear filters
              </Button>
            </CardContent>
          ) : null}
        </Card>
      ) : null}
      {filtered.map((f) => (
        <Card key={f.id}>
          <CardHeader className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${FINDING_TYPE_TONES[f.findingType] ?? ""}`}
              >
                {f.findingType.toLowerCase()}
              </span>
              <SeverityBadge severity={f.severity} />
              <ConfidenceBadge value={f.confidence} />
              <ReviewBadge status={f.reviewStatus} />
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {prettyDomain(f.domain)}
              </span>
            </div>
            <CardTitle className="text-base leading-snug">{f.title}</CardTitle>
            <CardDescription className="whitespace-pre-wrap text-sm text-foreground">
              {f.description}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {f.evidenceIds.length} evidence link
                {f.evidenceIds.length === 1 ? "" : "s"}
              </span>
              {engagementId ? (
                <Link
                  href={buildEvidenceExplorerHref({
                    engagementId,
                    assessmentId,
                    q: f.title,
                    domain: f.domain,
                  })}
                  className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                >
                  See evidence →
                </Link>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <ReviewStatusSelect
                value={f.reviewStatus}
                disabled={updateMutation.isPending}
                onChange={(next) =>
                  updateMutation.mutate({ id: f.id, reviewStatus: next })
                }
              />
              <DeleteRowButton
                label="Delete finding"
                disabled={!canMutate}
                pending={
                  deleteMutation.isPending &&
                  deleteMutation.variables?.id === f.id
                }
                onDelete={() => deleteMutation.mutate({ id: f.id })}
              />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * Filter bar for the findings list. Domain is NOT owned here — it
 * lives in `?domain=…` and is driven by the clickable badges in the
 * page shell, so it stays shareable and survives tab switches. The
 * other axes are cheap client-side filters that don't warrant round-
 * tripping through the URL.
 */
function FindingsFilterBar({
  search,
  onSearchChange,
  types,
  onToggleType,
  severities,
  onToggleSeverity,
  reviewStatuses,
  onToggleReviewStatus,
  minConfidence,
  onMinConfidenceChange,
  domain,
  onDomainChange,
  domainOptions,
  hasLocalFilters,
  onClearLocal,
  matched,
  total,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  types: string[];
  onToggleType: (v: string) => void;
  severities: string[];
  onToggleSeverity: (v: string) => void;
  reviewStatuses: string[];
  onToggleReviewStatus: (v: string) => void;
  minConfidence: number;
  onMinConfidenceChange: (v: number) => void;
  domain: string | null;
  onDomainChange: (v: string | null) => void;
  domainOptions: readonly string[];
  hasLocalFilters: boolean;
  onClearLocal: () => void;
  matched: number;
  total: number;
}) {
  return (
    <FilterCard
      matched={matched}
      total={total}
      hasLocalFilters={hasLocalFilters}
      onClearLocal={onClearLocal}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <SearchInput
          id="findings-search"
          value={search}
          onChange={onSearchChange}
        />
        <MinConfidenceSlider
          id="findings-confidence"
          value={minConfidence}
          onChange={onMinConfidenceChange}
        />
      </div>
      {domainOptions.length > 0 ? (
        <DomainSelect
          id="findings-domain"
          value={domain}
          onChange={onDomainChange}
          options={domainOptions}
          prettify={(v) => v}
        />
      ) : null}

      <FilterChipRow
        label="Type"
        options={FINDING_TYPES}
        selected={types}
        onToggle={onToggleType}
      />
      <FilterChipRow
        label="Severity"
        options={SEVERITIES}
        selected={severities}
        onToggle={onToggleSeverity}
      />
      <FilterChipRow
        label="Review"
        options={REVIEW_STATUSES}
        selected={reviewStatuses}
        onToggle={onToggleReviewStatus}
        prettify={(v) => v.replace(/_/g, " ").toLowerCase()}
      />
    </FilterCard>
  );
}

// Local FilterChipRow kept for backward-compat; the shared one is
// imported below for new bars but Findings still uses this until we
// finish migrating. Identical behaviour either way.
function FilterChipRowLegacy({
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
