"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

type Category = "findings" | "risks" | "recommendations" | "scoring";

const CATEGORY_LABELS: Record<Category, { singular: string; plural: string }> =
  {
    findings: { singular: "finding", plural: "findings" },
    risks: { singular: "risk", plural: "risks" },
    recommendations: {
      singular: "recommendation",
      plural: "recommendations",
    },
    scoring: { singular: "domain score", plural: "domain scores" },
  };

/**
 * OWNER/ADMIN-only bulk-clear control for a single analysis category.
 * Lives in the analysis page shell; scoped to whichever tab is active.
 *
 * Flow: inline confirm panel (no modal lib in the codebase) with a
 * "Spare reviewed rows" checkbox. Default is wipe-everything per the
 * Phase-3 design decision — reviewers who've touched rows can opt in
 * to keep them via the checkbox.
 *
 * Hidden entirely for users without mutation privilege, same treatment
 * as the per-row DeleteRowButton — we don't tease actions we can't
 * honor.
 */
export function ClearAllButton({
  assessmentId,
  category,
}: {
  assessmentId: string;
  category: Category;
}) {
  const utils = trpc.useUtils();
  const [armed, setArmed] = useState(false);
  const [spareReviewed, setSpareReviewed] = useState(false);

  const canMutateQuery = trpc.analysis.canMutateOutputs.useQuery({
    assessmentId,
  });
  const canMutate = canMutateQuery.data ?? false;

  const invalidateActiveList = async () => {
    switch (category) {
      case "findings":
        await utils.finding.listByAssessment.invalidate({ assessmentId });
        break;
      case "risks":
        await utils.risk.listByAssessment.invalidate({ assessmentId });
        break;
      case "recommendations":
        await utils.recommendation.listByAssessment.invalidate({
          assessmentId,
        });
        break;
      case "scoring":
        await utils.scoring.listByAssessment.invalidate({ assessmentId });
        break;
    }
    await utils.analysis.summary.invalidate({ assessmentId });
  };

  const findingMut = trpc.finding.clearAll.useMutation({
    onSuccess: async () => {
      await invalidateActiveList();
      setArmed(false);
      setSpareReviewed(false);
    },
  });
  const riskMut = trpc.risk.clearAll.useMutation({
    onSuccess: async () => {
      await invalidateActiveList();
      setArmed(false);
      setSpareReviewed(false);
    },
  });
  const recMut = trpc.recommendation.clearAll.useMutation({
    onSuccess: async () => {
      await invalidateActiveList();
      setArmed(false);
      setSpareReviewed(false);
    },
  });
  const scoreMut = trpc.scoring.clearAll.useMutation({
    onSuccess: async () => {
      await invalidateActiveList();
      setArmed(false);
      setSpareReviewed(false);
    },
  });

  const pending =
    findingMut.isPending ||
    riskMut.isPending ||
    recMut.isPending ||
    scoreMut.isPending;

  if (!canMutate) return null;

  const labels = CATEGORY_LABELS[category];

  const run = () => {
    const payload = { assessmentId, spareReviewed };
    switch (category) {
      case "findings":
        findingMut.mutate(payload);
        break;
      case "risks":
        riskMut.mutate(payload);
        break;
      case "recommendations":
        recMut.mutate(payload);
        break;
      case "scoring":
        scoreMut.mutate(payload);
        break;
    }
  };

  if (!armed) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setArmed(true)}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        Clear all {labels.plural}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
      <div className="text-foreground">
        Delete every {labels.singular} on this assessment?
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 rounded border-input"
          checked={spareReviewed}
          onChange={(e) => setSpareReviewed(e.target.checked)}
          disabled={pending}
        />
        <span>
          Spare reviewed rows{" "}
          <span className="text-muted-foreground">
            (keep anything not in DRAFT)
          </span>
        </span>
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={pending}
          className="inline-flex items-center rounded-md border border-destructive/60 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
        >
          {pending ? "Clearing…" : `Confirm clear ${labels.plural}`}
        </button>
        <button
          type="button"
          onClick={() => {
            setArmed(false);
            setSpareReviewed(false);
          }}
          disabled={pending}
          className="text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
