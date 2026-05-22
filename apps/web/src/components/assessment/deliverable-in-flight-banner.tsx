"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

/**
 * In-flight banner for deliverable generation. Same pattern as the
 * estimation banner — pulsing amber dot + "in progress…" copy +
 * arm-then-confirm Cancel button. Polls every 3 s while a run is
 * active so the banner clears on its own once the worker writes the
 * terminal audit row.
 *
 * Worker-offline hint: deliverable generation is one batched AI call
 * with no per-section progress signal, and it legitimately takes
 * 1–3 min on heavy assessments (we even bumped the per-call timeout
 * to 240 s for that reason). So the "worker may not be running"
 * banner only appears AFTER the run has been pending longer than
 * the worst-case happy path — set to 5 min here. Below that, the
 * silence isn't diagnostic.
 */
const WORKER_OFFLINE_THRESHOLD_MS = 5 * 60 * 1000;
export function DeliverableInFlightBanner({
  assessmentId,
}: {
  assessmentId: string;
}) {
  const utils = trpc.useUtils();
  const statusQuery = trpc.deliverable.runStatus.useQuery(
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
  const enqueuedAt = statusQuery.data?.enqueuedAt
    ? new Date(statusQuery.data.enqueuedAt)
    : null;
  const ageMs = enqueuedAt ? Date.now() - enqueuedAt.getTime() : 0;
  const workerLikelyOffline =
    inFlight && ageMs > WORKER_OFFLINE_THRESHOLD_MS;
  const [armed, setArmed] = useState(false);

  const cancelMutation = trpc.deliverable.cancel.useMutation({
    onSuccess: async () => {
      await utils.deliverable.runStatus.invalidate({ assessmentId });
      setArmed(false);
    },
  });

  if (!inFlight) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
        <div className="flex items-center gap-2 text-foreground">
          <span
            aria-hidden
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500"
          />
          <span>
            Deliverable generation in progress — drafting sections + diagrams.
            Usually 1–3 min.
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

      {workerLikelyOffline ? (
        // Past the worst-case happy path. Most likely cause is the
        // BullMQ worker stopped (or the AI provider is wedged); the
        // hint surfaces the dev-mode "forgot to start the worker"
        // case explicitly because that's the failure mode we hit
        // most often.
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <p className="font-medium text-destructive">
            This run is taking longer than expected
          </p>
          <p className="mt-1 text-muted-foreground">
            Pending {Math.floor(ageMs / 60_000)} min with no result yet.
            Heavy assessments occasionally take longer than the 1–3 min
            envelope, but if the worker isn&apos;t running it would also
            look like this. In dev, start the worker in a separate
            terminal:
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-[11px]">
            pnpm --filter @copilot/web worker
          </pre>
        </div>
      ) : null}
    </div>
  );
}
