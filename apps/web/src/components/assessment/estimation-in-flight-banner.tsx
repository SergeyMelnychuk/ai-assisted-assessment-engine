"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

/**
 * Banner that appears while a team+estimate run is in flight, with a
 * Cancel button. Mirrors the analysis InFlightBanner pattern but
 * simpler: estimation is a single Claude call, so there's no per-
 * domain progress strip — just an animated dot + "in progress…" copy.
 *
 * Cancel semantics: writes a `CANCEL_ESTIMATION_REQUESTED` audit row
 * the worker checks BEFORE the Claude call. If the cancel lands
 * after the call started, it's effectively a no-op (the call runs to
 * completion); for a ~30s job that's the accepted trade-off and the
 * UI shows "Cancelling…" until the terminal row lands so the user
 * can see something is happening.
 */
export function EstimationInFlightBanner({
  assessmentId,
}: {
  assessmentId: string;
}) {
  const utils = trpc.useUtils();
  // Poll while in flight so the banner clears on its own once the
  // worker writes the terminal row.
  const statusQuery = trpc.estimation.runStatus.useQuery(
    { assessmentId },
    {
      refetchInterval: (q) => {
        const d = q.state.data;
        return d?.inFlight ? 3_000 : false;
      },
    },
  );
  const inFlight = statusQuery.data?.inFlight ?? false;
  const cancelRequested = statusQuery.data?.cancelRequested ?? false;
  const [armed, setArmed] = useState(false);

  const cancelMutation = trpc.estimation.cancel.useMutation({
    onSuccess: async () => {
      await utils.estimation.runStatus.invalidate({ assessmentId });
      setArmed(false);
    },
  });

  if (!inFlight) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-foreground">
        <span
          aria-hidden
          className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500"
        />
        <span>
          Team &amp; estimate in progress — generating role proposals + cost
          range. Usually 20–40 s.
        </span>
      </div>
      {cancelRequested || cancelMutation.isPending ? (
        <Button type="button" size="sm" variant="ghost" disabled>
          Cancelling…
        </Button>
      ) : armed ? (
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            onClick={() => cancelMutation.mutate({ assessmentId })}
            disabled={cancelMutation.isPending}
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
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setArmed(true)}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          Cancel run
        </Button>
      )}
    </div>
  );
}
