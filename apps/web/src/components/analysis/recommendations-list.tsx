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
import { Skeleton } from "@/components/ui/skeleton";
import { ConfidenceBadge, ReviewBadge, prettyDomain } from "./review-badges";
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

// `text-foreground` on tinted backgrounds — see `review-badges.tsx`.
const PRIORITY_TONES: Record<string, string> = {
  CRITICAL: "border-destructive/40 bg-destructive/10 text-destructive",
  HIGH: "border-amber-500/40 bg-amber-500/10 text-foreground",
  MEDIUM: "border-border bg-muted text-foreground",
  LOW: "border-border bg-muted/60 text-foreground",
};

const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const REVIEW_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "NEEDS_REVISION",
  "REJECTED",
] as const;

export function RecommendationsList({
  assessmentId,
  engagementId,
}: {
  assessmentId: string;
  /** Optional — enables "See evidence" cross-page linkage (Week 7). */
  engagementId?: string;
}) {
  const utils = trpc.useUtils();
  const urlDomain = useDomainFilter();
  const [localDomain, setLocalDomain] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [priorities, setPriorities] = useState<string[]>([]);
  const [reviewStatuses, setReviewStatuses] = useState<string[]>([]);
  const [minConfidence, setMinConfidence] = useState(0);

  const toggle = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const clearLocalFilters = () => {
    setSearch("");
    setPriorities([]);
    setReviewStatuses([]);
    setMinConfidence(0);
    setLocalDomain(null);
  };

  // No background polling — the parent shell's "Refresh" button
  // invalidates this query on demand.
  const query = trpc.recommendation.listByAssessment.useQuery({ assessmentId });
  const canMutateQuery = trpc.analysis.canMutateOutputs.useQuery({
    assessmentId,
  });
  const canMutate = canMutateQuery.data ?? false;
  const updateMutation = trpc.recommendation.update.useMutation({
    onSuccess: async () => {
      await utils.recommendation.listByAssessment.invalidate({ assessmentId });
    },
  });
  const deleteMutation = trpc.recommendation.delete.useMutation({
    onSuccess: async () => {
      await utils.recommendation.listByAssessment.invalidate({ assessmentId });
      await utils.analysis.summary.invalidate({ assessmentId });
      // Refresh per-domain status — clearing every rec for a domain
      // should flip that domain's badge off in the header strip.
      await utils.analysis.perDomainStatus.invalidate({ assessmentId });
    },
  });

  const allRecs = useMemo(() => query.data ?? [], [query.data]);
  const effectiveDomain = localDomain ?? urlDomain ?? null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const minConf = minConfidence / 100;
    return allRecs.filter((r) => {
      if (effectiveDomain && r.domain !== effectiveDomain) return false;
      if (priorities.length > 0 && !priorities.includes(r.priority))
        return false;
      if (
        reviewStatuses.length > 0 &&
        !reviewStatuses.includes(r.reviewStatus)
      )
        return false;
      if (r.confidence < minConf) return false;
      if (q) {
        const hay = `${r.title}\n${r.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    allRecs,
    effectiveDomain,
    priorities,
    reviewStatuses,
    minConfidence,
    search,
  ]);

  const domainOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRecs) set.add(r.domain);
    return Array.from(set).sort();
  }, [allRecs]);

  const hasLocalFilters =
    search.length > 0 ||
    priorities.length > 0 ||
    reviewStatuses.length > 0 ||
    minConfidence > 0 ||
    localDomain !== null;

  if (query.isLoading) return <Skeleton className="h-24 w-full" />;
  if (query.error) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {query.error.message}
      </p>
    );
  }

  if (allRecs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No recommendations yet</CardTitle>
          <CardDescription>
            Recommendations are generated alongside findings and risks. Run
            analysis once you&apos;ve got some evidence. If a run has already
            been triggered and nothing appears after ~60s, the worker
            probably failed — check its stdout for the cause.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunAnalysisButton assessmentId={assessmentId} />
        </CardContent>
      </Card>
    );
  }

  const recs = filtered;

  return (
    <div className="space-y-3">
      <FilterCard
        matched={recs.length}
        total={allRecs.length}
        hasLocalFilters={hasLocalFilters}
        onClearLocal={clearLocalFilters}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <SearchInput
            id="recs-search"
            value={search}
            onChange={setSearch}
            placeholder="e.g. caching, rotate keys, runbook…"
          />
          <MinConfidenceSlider
            id="recs-confidence"
            value={minConfidence}
            onChange={setMinConfidence}
          />
        </div>
        {domainOptions.length > 0 ? (
          <DomainSelect
            id="recs-domain"
            value={effectiveDomain}
            onChange={setLocalDomain}
            options={domainOptions}
            prettify={prettyDomain}
          />
        ) : null}
        <FilterChipRow
          label="Priority"
          options={PRIORITIES}
          selected={priorities}
          onToggle={(v) => setPriorities((a) => toggle(a, v))}
        />
        <FilterChipRow
          label="Review"
          options={REVIEW_STATUSES}
          selected={reviewStatuses}
          onToggle={(v) => setReviewStatuses((a) => toggle(a, v))}
          prettify={(v) => v.replace(/_/g, " ").toLowerCase()}
        />
      </FilterCard>

      {recs.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              No recommendations match
            </CardTitle>
            <CardDescription>
              Loosen the filters above — {allRecs.length} recommendation
              {allRecs.length === 1 ? "" : "s"} exist for this assessment.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        recs.map((r) => (
          <Card key={r.id}>
            <CardHeader className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${PRIORITY_TONES[r.priority] ?? ""}`}
                >
                  priority {r.priority.toLowerCase()}
                </span>
                <ConfidenceBadge value={r.confidence} />
                <ReviewBadge status={r.reviewStatus} />
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {prettyDomain(r.domain)}
                </span>
                {r.effortIndication ? (
                  <span className="inline-flex items-center rounded-full border border-input bg-background px-2 py-0.5 text-xs text-muted-foreground">
                    effort: {r.effortIndication}
                  </span>
                ) : null}
              </div>
              <CardTitle className="text-base leading-snug">
                {r.title}
              </CardTitle>
              <CardDescription className="whitespace-pre-wrap text-sm text-foreground">
                {r.description}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {r.relatedRiskIds.length} linked risk
                  {r.relatedRiskIds.length === 1 ? "" : "s"}
                </span>
                {engagementId ? (
                  <Link
                    href={buildEvidenceExplorerHref({
                      engagementId,
                      assessmentId,
                      q: r.title,
                      domain: r.domain,
                    })}
                    className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                  >
                    See evidence →
                  </Link>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <ReviewStatusSelect
                  value={r.reviewStatus}
                  disabled={updateMutation.isPending}
                  onChange={(next) =>
                    updateMutation.mutate({ id: r.id, reviewStatus: next })
                  }
                />
                <DeleteRowButton
                  label="Delete recommendation"
                  disabled={!canMutate}
                  pending={
                    deleteMutation.isPending &&
                    deleteMutation.variables?.id === r.id
                  }
                  onDelete={() => deleteMutation.mutate({ id: r.id })}
                />
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
