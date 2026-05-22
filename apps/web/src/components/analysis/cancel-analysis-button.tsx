"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

/**
 * "Cancel run" — surfaces only while an analysis run is in-flight
 * (driven by `analysis.runStatus.inFlight`). OWNER/ADMIN-only, same
 * gating as delete / clearAll.
 *
 * Two-click arm-then-confirm to avoid fat-fingered cancels on long
 * runs (the button lives next to "Run analysis" so mis-clicks are
 * plausible). Once a cancel is in flight we leave the button visible
 * but disabled with a "Cancelling…" label — the worker checks
 * between domains, so the user can see work is winding down rather
 * than wondering if the click registered.
 */
export function CancelAnalysisButton({ assessmentId }: { assessmentId: string }) {
  const utils = trpc.useUtils();
  const [armed, setArmed] = useState(false);

  const canMutateQuery = trpc.analysis.canMutateOutputs.useQuery({
    assessmentId,
  });
  const canMutate = canMutateQuery.data ?? false;

  // Poll runStatus while a cancel is in flight so the "Cancelling…"
  // state self-clears the moment the worker writes the terminal
  // `RUN_ANALYSIS_CANCELLED` row. Without polling the banner stuck at
  // "Cancelling…" forever and the user had to hit Refresh to unstick
  // it — misread as "navigation is broken".
  const statusQuery = trpc.analysis.runStatus.useQuery(
    { assessmentId },
    {
      refetchInterval: (query) => {
        const d = query.state.data;
        return d?.inFlight && d?.cancelRequested ? 3000 : false;
      },
    },
  );
  const inFlight = statusQuery.data?.inFlight ?? false;
  const cancelRequested = statusQuery.data?.cancelRequested ?? false;

  const mutation = trpc.analysis.cancel.useMutation({
    onSuccess: async () => {
      // Only invalidate runStatus here — invalidating the whole
      // `analysis.*` namespace would re-fetch summary/lastFailure/
      // perDomainStatus too, which is unnecessary noise while the
      // cancel is still being honored. The polling above picks up
      // the terminal row; the final results-update invalidation
      // happens when the banner hides on its own.
      await utils.analysis.runStatus.invalidate({ assessmentId });
      setArmed(false);
    },
  });

  if (!canMutate || !inFlight) return null;

  if (cancelRequested || mutation.isPending) {
    return (
      <Button type="button" size="sm" variant="ghost" disabled>
        Cancelling…
      </Button>
    );
  }

  if (!armed) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setArmed(true)}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        Cancel run
      </Button>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => mutation.mutate({ assessmentId })}
        disabled={mutation.isPending}
        className="inline-flex items-center rounded-md border border-destructive/60 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
      >
        Confirm cancel
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        Keep running
      </button>
    </span>
  );
}
