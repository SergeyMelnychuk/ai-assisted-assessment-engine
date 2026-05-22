"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

/**
 * Same shape as the analysis-run button but for the team+estimate path.
 * Kept as its own component so the two runs stay visually distinct on
 * the team/estimate page.
 */
export function RunEstimationButton({
  assessmentId,
  variant = "default",
  templateId,
}: {
  assessmentId: string;
  variant?: "default" | "secondary";
  /** Optional override — when set, the worker fills this template
   * instead of the auto-resolver's pick. */
  templateId?: string;
}) {
  const utils = trpc.useUtils();
  const [justTriggered, setJustTriggered] = useState(false);

  const mutation = trpc.estimation.run.useMutation({
    onSuccess: async () => {
      setJustTriggered(true);
      await Promise.all([
        utils.estimation.listProposals.invalidate({ assessmentId }),
        utils.estimation.getLatestEstimate.invalidate({ assessmentId }),
        // Make the in-flight banner appear the moment the user clicks
        // Run, instead of waiting for the next 3 s poll tick.
        utils.estimation.runStatus.invalidate({ assessmentId }),
      ]);
      setTimeout(() => setJustTriggered(false), 4000);
    },
  });

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant={variant}
        size="sm"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate({ assessmentId, templateId })}
      >
        {mutation.isPending ? "Queueing…" : "Generate team & estimate"}
      </Button>
      {justTriggered ? (
        <span className="text-xs text-muted-foreground">
          queued — results will stream in
        </span>
      ) : null}
      {mutation.error ? (
        <span className="text-xs text-destructive">
          {mutation.error.message}
        </span>
      ) : null}
    </div>
  );
}
