"use client";

import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ReviewBadge } from "@/components/analysis/review-badges";

const STATUS_ORDER = [
  "APPROVED",
  "IN_REVIEW",
  "NEEDS_REVISION",
  "REJECTED",
  "DRAFT",
] as const;

/**
 * Review summary card. Pulls `review.deliverableProgress` for per-status
 * counts + blocking sections, and hosts the "Approve deliverable for
 * export" button whose gate lives in the service layer.
 */
export function ReviewDashboard({
  deliverableId,
}: {
  deliverableId: string;
}) {
  const utils = trpc.useUtils();
  const query = trpc.review.deliverableProgress.useQuery(
    { deliverableId },
    { refetchInterval: 4_000 },
  );
  const approveMutation = trpc.review.approveDeliverable.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.review.deliverableProgress.invalidate({ deliverableId }),
        utils.deliverable.listByAssessment.invalidate(),
        utils.deliverable.getById.invalidate({ id: deliverableId }),
      ]);
    },
  });

  if (query.isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }
  if (query.error) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {query.error.message}
      </p>
    );
  }

  const p = query.data;
  if (!p) return null;

  const approvedRatio =
    p.totalSections === 0 ? 0 : p.byStatus.APPROVED / p.totalSections;
  const approvedPct = Math.round(approvedRatio * 100);

  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Review progress</CardTitle>
          <span className="inline-flex items-center rounded-full border border-input bg-background px-2 py-0.5 text-xs font-medium">
            deliverable: {p.deliverableStatus.toLowerCase()}
          </span>
        </div>
        <CardDescription>
          {p.byStatus.APPROVED}/{p.totalSections} sections approved · export
          is {p.canApprove ? "unblocked" : "blocked"} until every section is
          approved.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-green-500/70 transition-all"
              style={{ width: `${approvedPct}%` }}
              aria-label={`${approvedPct}% approved`}
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {STATUS_ORDER.map((s) => {
              const n = p.byStatus[s];
              if (n === 0) return null;
              return (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
                >
                  <ReviewBadge status={s} />
                  <span className="text-muted-foreground">× {n}</span>
                </span>
              );
            })}
          </div>
        </div>

        {p.blockingSections.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Sections still blocking export
            </h4>
            <ul className="mt-2 space-y-1 text-sm">
              {p.blockingSections.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between rounded-md border px-3 py-1.5"
                >
                  <span>{s.title}</span>
                  <ReviewBadge status={s.reviewStatus} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            disabled={!p.canApprove || approveMutation.isPending || p.deliverableStatus === "APPROVED"}
            onClick={() => approveMutation.mutate({ deliverableId })}
          >
            {approveMutation.isPending
              ? "Approving…"
              : p.deliverableStatus === "APPROVED"
                ? "Already approved"
                : p.canApprove
                  ? "Approve deliverable for export"
                  : "Approve deliverable — blocked"}
          </Button>
          {approveMutation.error ? (
            <span className="text-xs text-destructive">
              {approveMutation.error.message}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
