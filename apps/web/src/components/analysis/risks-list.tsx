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
import { ConfidenceBadge, ReviewBadge, SeverityBadge } from "./review-badges";
import { domainLabel } from "@/lib/domain-labels";
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

const LIKELIHOOD_LABELS: Record<string, string> = {
  VERY_LIKELY: "very likely",
  LIKELY: "likely",
  POSSIBLE: "possible",
  UNLIKELY: "unlikely",
};

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
const LIKELIHOODS = [
  "VERY_LIKELY",
  "LIKELY",
  "POSSIBLE",
  "UNLIKELY",
] as const;
const REVIEW_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "NEEDS_REVISION",
  "REJECTED",
] as const;

export function RisksList({
  assessmentId,
  engagementId,
}: {
  assessmentId: string;
  /** Optional — enables "See evidence" cross-page linkage (Week 7). */
  engagementId?: string;
}) {
  const utils = trpc.useUtils();
  // URL-driven domain filter (the page-shell's clickable domain badges
  // set this). Inside popups it's null — the local domain dropdown in
  // the filter bar covers that case.
  const urlDomain = useDomainFilter();
  const [localDomain, setLocalDomain] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [severities, setSeverities] = useState<string[]>([]);
  const [likelihoods, setLikelihoods] = useState<string[]>([]);
  const [reviewStatuses, setReviewStatuses] = useState<string[]>([]);
  const [minConfidence, setMinConfidence] = useState(0);

  const toggle = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const clearLocalFilters = () => {
    setSearch("");
    setSeverities([]);
    setLikelihoods([]);
    setReviewStatuses([]);
    setMinConfidence(0);
    setLocalDomain(null);
  };

  // No background polling — the parent shell's "Refresh" button
  // invalidates this query on demand.
  const query = trpc.risk.listByAssessment.useQuery({ assessmentId });
  const canMutateQuery = trpc.analysis.canMutateOutputs.useQuery({
    assessmentId,
  });
  const canMutate = canMutateQuery.data ?? false;
  const updateMutation = trpc.risk.update.useMutation({
    onSuccess: async () => {
      await utils.risk.listByAssessment.invalidate({ assessmentId });
    },
  });
  const deleteMutation = trpc.risk.delete.useMutation({
    onSuccess: async () => {
      await utils.risk.listByAssessment.invalidate({ assessmentId });
      await utils.analysis.summary.invalidate({ assessmentId });
      // Refresh per-domain status — a domain whose risks/findings/recs
      // are all gone should stop showing `Analysis:ok` in the header.
      await utils.analysis.perDomainStatus.invalidate({ assessmentId });
    },
  });

  const allRisks = useMemo(() => query.data ?? [], [query.data]);

  // Effective domain filter: local dropdown wins (popup case), then
  // URL `?domain=`, then "no filter".
  const effectiveDomain = localDomain ?? urlDomain ?? null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const minConf = minConfidence / 100;
    return allRisks.filter((r) => {
      if (effectiveDomain && r.category !== effectiveDomain) return false;
      if (severities.length > 0 && !severities.includes(r.severity))
        return false;
      if (likelihoods.length > 0 && !likelihoods.includes(r.likelihood))
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
    allRisks,
    effectiveDomain,
    severities,
    likelihoods,
    reviewStatuses,
    minConfidence,
    search,
  ]);

  // Distinct domain set across the data — drives the domain dropdown.
  const domainOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRisks) set.add(r.category);
    return Array.from(set).sort();
  }, [allRisks]);

  const hasLocalFilters =
    search.length > 0 ||
    severities.length > 0 ||
    likelihoods.length > 0 ||
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

  if (allRisks.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No risks identified yet</CardTitle>
          <CardDescription>
            Run analysis to surface risks based on evidence, answered
            questions, and known patterns from the knowledge base. If a run
            has already been triggered and nothing appears after ~60s, the
            worker probably failed — check its stdout for the cause.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunAnalysisButton assessmentId={assessmentId} />
        </CardContent>
      </Card>
    );
  }

  const risks = filtered;

  return (
    <div className="space-y-3">
      <FilterCard
        matched={risks.length}
        total={allRisks.length}
        hasLocalFilters={hasLocalFilters}
        onClearLocal={clearLocalFilters}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <SearchInput
            id="risks-search"
            value={search}
            onChange={setSearch}
            placeholder="e.g. outage, vendor, drift…"
          />
          <MinConfidenceSlider
            id="risks-confidence"
            value={minConfidence}
            onChange={setMinConfidence}
          />
        </div>
        {domainOptions.length > 0 ? (
          <DomainSelect
            id="risks-domain"
            value={effectiveDomain}
            onChange={setLocalDomain}
            options={domainOptions}
            prettify={domainLabel}
          />
        ) : null}
        <FilterChipRow
          label="Severity"
          options={SEVERITIES}
          selected={severities}
          onToggle={(v) => setSeverities((a) => toggle(a, v))}
        />
        <FilterChipRow
          label="Likelihood"
          options={LIKELIHOODS}
          selected={likelihoods}
          onToggle={(v) => setLikelihoods((a) => toggle(a, v))}
          prettify={(v) => LIKELIHOOD_LABELS[v] ?? v.toLowerCase()}
        />
        <FilterChipRow
          label="Review"
          options={REVIEW_STATUSES}
          selected={reviewStatuses}
          onToggle={(v) => setReviewStatuses((a) => toggle(a, v))}
          prettify={(v) => v.replace(/_/g, " ").toLowerCase()}
        />
      </FilterCard>

      {risks.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No risks match</CardTitle>
            <CardDescription>
              Loosen the filters above — {allRisks.length} risk
              {allRisks.length === 1 ? "" : "s"} exist for this assessment.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        risks.map((r) => (
          <Card key={r.id}>
            <CardHeader className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={r.severity} />
                <span className="inline-flex items-center rounded-full border border-input bg-background px-2 py-0.5 text-xs">
                  impact {r.impact.toLowerCase()} ·{" "}
                  {LIKELIHOOD_LABELS[r.likelihood] ??
                    r.likelihood.toLowerCase()}
                </span>
                <ConfidenceBadge value={r.confidence} />
                <ReviewBadge status={r.reviewStatus} />
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {domainLabel(r.category)}
                </span>
              </div>
              <CardTitle className="text-base leading-snug">{r.title}</CardTitle>
              <CardDescription className="whitespace-pre-wrap text-sm text-foreground">
                {r.description}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {r.mitigationProposal ? (
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Proposed mitigation
                  </h4>
                  <p className="mt-1 whitespace-pre-wrap text-sm">
                    {r.mitigationProposal}
                  </p>
                </div>
              ) : null}
              {r.ownerSuggestion ? (
                <p className="text-xs text-muted-foreground">
                  Suggested owner:{" "}
                  <span className="font-medium">{r.ownerSuggestion}</span>
                </p>
              ) : null}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    {r.evidenceIds.length} evidence link
                    {r.evidenceIds.length === 1 ? "" : "s"}
                  </span>
                  {engagementId ? (
                    <Link
                      href={buildEvidenceExplorerHref({
                        engagementId,
                        assessmentId,
                        q: r.title,
                        domain: r.category,
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
                    label="Delete risk"
                    disabled={!canMutate}
                    pending={
                      deleteMutation.isPending &&
                      deleteMutation.variables?.id === r.id
                    }
                    onDelete={() => deleteMutation.mutate({ id: r.id })}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
