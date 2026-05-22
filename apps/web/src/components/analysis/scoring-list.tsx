"use client";

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
import { Textarea } from "@/components/ui/textarea";
import { ConfidenceBadge, ReviewBadge, prettyDomain } from "./review-badges";
import { ReviewStatusSelect } from "./review-status-select";
import { DeleteRowButton } from "./row-delete-button";
import { RunAnalysisButton } from "./run-analysis-button";
import { useDomainFilter } from "./use-domain-filter";
import {
  DomainSelect,
  FilterCard,
  FilterChipRow,
  SearchInput,
} from "./list-filter-bar";

const MATURITY_LEVELS = [
  "AD_HOC",
  "INITIAL",
  "DEFINED",
  "MANAGED",
  "OPTIMIZED",
] as const;

const REVIEW_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "NEEDS_REVISION",
  "REJECTED",
] as const;

// `text-foreground` on tinted backgrounds for max contrast — see
// badge contrast notes in `review-badges.tsx`. Category hue stays on
// border + background only. AD_HOC keeps `text-destructive` because
// that token is already a full-strength red.
const MATURITY_TONES: Record<string, string> = {
  AD_HOC: "border-destructive/40 bg-destructive/10 text-destructive",
  INITIAL: "border-amber-500/40 bg-amber-500/10 text-foreground",
  DEFINED: "border-border bg-muted text-foreground",
  MANAGED: "border-blue-500/40 bg-blue-500/10 text-foreground",
  OPTIMIZED: "border-green-500/40 bg-green-500/10 text-foreground",
};

export function ScoringList({ assessmentId }: { assessmentId: string }) {
  const utils = trpc.useUtils();
  const urlDomain = useDomainFilter();
  const [localDomain, setLocalDomain] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [maturityLevels, setMaturityLevels] = useState<string[]>([]);
  const [reviewStatuses, setReviewStatuses] = useState<string[]>([]);
  const [minScore, setMinScore] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);

  const toggle = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const clearLocalFilters = () => {
    setSearch("");
    setMaturityLevels([]);
    setReviewStatuses([]);
    setMinScore(0);
    setLocalDomain(null);
  };

  // No background polling — the parent shell's "Refresh" button
  // invalidates this query on demand.
  const query = trpc.scoring.listByAssessment.useQuery({ assessmentId });
  const canMutateQuery = trpc.analysis.canMutateOutputs.useQuery({
    assessmentId,
  });
  const canMutate = canMutateQuery.data ?? false;
  const updateMutation = trpc.scoring.update.useMutation({
    onSuccess: async () => {
      await utils.scoring.listByAssessment.invalidate({ assessmentId });
      setEditingId(null);
    },
  });
  const deleteMutation = trpc.scoring.delete.useMutation({
    onSuccess: async () => {
      await utils.scoring.listByAssessment.invalidate({ assessmentId });
      await utils.analysis.summary.invalidate({ assessmentId });
      // Refresh per-domain status — deleting a domain score should
      // flip that domain's `Scoring:ok` to `—` in the header strip.
      await utils.analysis.perDomainStatus.invalidate({ assessmentId });
    },
  });

  const allScores = useMemo(() => query.data ?? [], [query.data]);
  const effectiveDomain = localDomain ?? urlDomain ?? null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allScores.filter((s) => {
      if (effectiveDomain && s.domain !== effectiveDomain) return false;
      if (
        maturityLevels.length > 0 &&
        !maturityLevels.includes(s.maturityLevel)
      )
        return false;
      if (
        reviewStatuses.length > 0 &&
        !reviewStatuses.includes(s.reviewStatus)
      )
        return false;
      if (s.score < minScore) return false;
      if (q) {
        const hay =
          `${s.domain}\n${s.scoringRationale ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    allScores,
    effectiveDomain,
    maturityLevels,
    reviewStatuses,
    minScore,
    search,
  ]);

  const domainOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of allScores) set.add(s.domain);
    return Array.from(set).sort();
  }, [allScores]);

  const hasLocalFilters =
    search.length > 0 ||
    maturityLevels.length > 0 ||
    reviewStatuses.length > 0 ||
    minScore > 0 ||
    localDomain !== null;

  if (query.isLoading) return <Skeleton className="h-24 w-full" />;
  if (query.error) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {query.error.message}
      </p>
    );
  }

  if (allScores.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No scores yet</CardTitle>
          <CardDescription>
            Running analysis will produce an AI-suggested score per active
            domain that you can then adjust. If a run has already been
            triggered and nothing appears after ~60s, the worker probably
            failed — check its stdout for the cause.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunAnalysisButton assessmentId={assessmentId} />
        </CardContent>
      </Card>
    );
  }

  const scores = filtered;

  return (
    <div className="space-y-3">
      <FilterCard
        matched={scores.length}
        total={allScores.length}
        hasLocalFilters={hasLocalFilters}
        onClearLocal={clearLocalFilters}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <SearchInput
            id="scoring-search"
            value={search}
            onChange={setSearch}
            placeholder="Search domain or rationale…"
          />
          <div className="space-y-1">
            <Label
              htmlFor="scoring-min"
              className="text-xs text-muted-foreground"
            >
              Min. score: {minScore.toFixed(1)} / 5.0
            </Label>
            <input
              id="scoring-min"
              type="range"
              min={0}
              max={5}
              step={0.5}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="mt-2 w-full"
            />
          </div>
        </div>
        {domainOptions.length > 0 ? (
          <DomainSelect
            id="scoring-domain"
            value={effectiveDomain}
            onChange={setLocalDomain}
            options={domainOptions}
            prettify={prettyDomain}
          />
        ) : null}
        <FilterChipRow
          label="Maturity"
          options={MATURITY_LEVELS}
          selected={maturityLevels}
          onToggle={(v) => setMaturityLevels((a) => toggle(a, v))}
          prettify={(v) => v.replace(/_/g, " ").toLowerCase()}
        />
        <FilterChipRow
          label="Review"
          options={REVIEW_STATUSES}
          selected={reviewStatuses}
          onToggle={(v) => setReviewStatuses((a) => toggle(a, v))}
          prettify={(v) => v.replace(/_/g, " ").toLowerCase()}
        />
      </FilterCard>

      {scores.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No scores match</CardTitle>
            <CardDescription>
              Loosen the filters above — {allScores.length} score
              {allScores.length === 1 ? "" : "s"} exist for this assessment.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
      scores.map((s) => (
        <Card key={s.id}>
          <CardHeader className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${MATURITY_TONES[s.maturityLevel] ?? ""}`}
              >
                {s.maturityLevel.replace(/_/g, " ").toLowerCase()}
              </span>
              <span className="text-sm font-semibold">
                {s.score.toFixed(1)} / 5.0
              </span>
              <ConfidenceBadge value={s.confidence} />
              <ReviewBadge status={s.reviewStatus} />
            </div>
            <CardTitle className="text-base leading-snug">
              {prettyDomain(s.domain)}
            </CardTitle>
            {s.scoringRationale && editingId !== s.id ? (
              <CardDescription className="whitespace-pre-wrap text-sm text-foreground">
                {s.scoringRationale}
              </CardDescription>
            ) : null}
          </CardHeader>

          {editingId === s.id ? (
            <CardContent>
              <ScoreEditor
                score={s.score}
                maturityLevel={s.maturityLevel}
                rationale={s.scoringRationale ?? ""}
                busy={updateMutation.isPending}
                onCancel={() => setEditingId(null)}
                onSave={(next) =>
                  updateMutation.mutate({ id: s.id, ...next })
                }
              />
            </CardContent>
          ) : (
            <CardContent className="flex items-center justify-between">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEditingId(s.id)}
              >
                Edit score
              </Button>
              <div className="flex items-center gap-2">
                <ReviewStatusSelect
                  value={s.reviewStatus}
                  disabled={updateMutation.isPending}
                  onChange={(next) =>
                    updateMutation.mutate({ id: s.id, reviewStatus: next })
                  }
                />
                <DeleteRowButton
                  label="Delete score"
                  disabled={!canMutate}
                  pending={
                    deleteMutation.isPending &&
                    deleteMutation.variables?.id === s.id
                  }
                  onDelete={() => deleteMutation.mutate({ id: s.id })}
                />
              </div>
            </CardContent>
          )}
        </Card>
      ))
      )}
    </div>
  );
}

function ScoreEditor({
  score,
  maturityLevel,
  rationale,
  busy,
  onCancel,
  onSave,
}: {
  score: number;
  maturityLevel: string;
  rationale: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (next: {
    score: number;
    maturityLevel: (typeof MATURITY_LEVELS)[number];
    scoringRationale: string;
  }) => void;
}) {
  const [nextScore, setNextScore] = useState(String(score));
  const [nextLevel, setNextLevel] = useState(maturityLevel);
  const [nextRationale, setNextRationale] = useState(rationale);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Score (0–5)
          </label>
          <Input
            type="number"
            step="0.1"
            min={0}
            max={5}
            className="mt-1"
            value={nextScore}
            onChange={(e) => setNextScore(e.target.value)}
            disabled={busy}
          />
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Maturity level
          </label>
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            value={nextLevel}
            onChange={(e) => setNextLevel(e.target.value)}
            disabled={busy}
          >
            {MATURITY_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Rationale
        </label>
        <Textarea
          className="mt-1 min-h-[96px]"
          value={nextRationale}
          onChange={(e) => setNextRationale(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            const n = Number(nextScore);
            if (Number.isNaN(n)) return;
            onSave({
              score: Math.max(0, Math.min(5, n)),
              maturityLevel: nextLevel as (typeof MATURITY_LEVELS)[number],
              scoringRationale: nextRationale.trim(),
            });
          }}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
