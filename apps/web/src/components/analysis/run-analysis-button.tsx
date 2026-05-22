"use client";

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import type { AnalysisMode } from "@/server/services/analysis-mode";

/**
 * Kicks off the background analysis run. On success we invalidate all
 * analysis-surface queries so the UI reflects the new in-flight state
 * immediately (including hiding any stale failure banner — the
 * `ENQUEUE_ANALYSIS` audit row now outranks the older `RUN_ANALYSIS_FAILED`
 * in `analysis.lastFailure`). The user can click "Refresh" once the
 * worker finishes to pull the final results.
 *
 * Week 9 (ADR-0013): a single "Run analysis" entry point that opens a
 * small chooser below the button. The user picks between:
 *
 *   - **Draft** — FAST mode. Generator only, ~16 Claude calls, 2-3 min.
 *     More items, looser evidence standard.
 *   - **Reviewed** — THOROUGH mode. Generator + per-domain verifier,
 *     ~24 Claude calls, 5-6 min, ~2× the cost. Stricter output: items
 *     without evidence citations are dropped, near-duplicates merged.
 *
 * The chooser layout (one button → expose both modes with their cost /
 * quality caption) makes the trade-off visible at the decision point
 * rather than hidden behind button copy. `mode` flows end-to-end and
 * lands in `ENQUEUE_ANALYSIS.details.mode` for later A/B attribution.
 */
export function RunAnalysisButton({
  assessmentId,
  variant = "default",
}: {
  assessmentId: string;
  variant?: "default" | "secondary";
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [justTriggered, setJustTriggered] = useState<AnalysisMode | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const mutation = trpc.analysis.run.useMutation({
    onSuccess: async (data) => {
      setOpen(false);
      setJustTriggered(data.mode);
      // Refetch everything analysis-related so the stale failure
      // banner hides (ENQUEUE_ANALYSIS is now the most-recent
      // terminal event) and the summary/list queries pick up the
      // pending state. We only invalidate active queries — no
      // background polling.
      await Promise.all([
        utils.analysis.invalidate(undefined, { refetchType: "active" }),
        utils.assessment.getById.invalidate({ id: assessmentId }),
        utils.finding.listByAssessment.invalidate({ assessmentId }),
        utils.risk.listByAssessment.invalidate({ assessmentId }),
        utils.recommendation.listByAssessment.invalidate({ assessmentId }),
        utils.scoring.listByAssessment.invalidate({ assessmentId }),
      ]);
      setTimeout(() => setJustTriggered(null), 8000);
    },
  });

  // Outside-click + Escape close the chooser. A full `DropdownMenu`
  // primitive would be over-kill for two options; we hand-roll the
  // dismissal behaviour instead of pulling in Radix.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pendingMode =
    mutation.isPending && mutation.variables
      ? mutation.variables.mode ?? null
      : null;

  return (
    <div className="relative inline-flex flex-col gap-2" ref={containerRef}>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={variant}
          size="sm"
          disabled={mutation.isPending}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          {mutation.isPending
            ? pendingMode === "THOROUGH"
              ? "Queueing Reviewed…"
              : "Queueing Draft…"
            : "Run analysis"}
        </Button>
        {justTriggered ? (
          <span className="text-xs text-muted-foreground">
            queued ({justTriggered === "THOROUGH" ? "Reviewed" : "Draft"}) —
            click Refresh in a minute to see results
          </span>
        ) : null}
        {mutation.error ? (
          <span className="text-xs text-destructive">
            {mutation.error.message}
          </span>
        ) : null}
      </div>

      {open ? (
        <div
          role="menu"
          // Fully opaque surface: the project's theme doesn't define a
          // `--popover` CSS var, so `bg-popover` resolved to a
          // transparent fallback and the menu sat ghosted over the
          // page behind it. Use the concrete `bg-background` token
          // (defined everywhere) with an explicit border so the chooser
          // is always readable regardless of what's underneath.
          className="absolute left-0 top-full z-20 mt-1 w-72 rounded-md border border-border bg-background p-1 text-foreground shadow-md"
        >
          <ModeOption
            label="Draft"
            caption="Generator only · ~2–3 min · lower cost"
            sub="More items, looser evidence standard. Use while iterating."
            disabled={mutation.isPending}
            onSelect={() => mutation.mutate({ assessmentId, mode: "FAST" })}
          />
          <ModeOption
            label="Reviewed"
            caption="Generator + verifier · ~5–6 min · ~2× cost"
            sub="Drops findings that aren't evidence-backed. Use for finals."
            disabled={mutation.isPending}
            onSelect={() =>
              mutation.mutate({ assessmentId, mode: "THOROUGH" })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function ModeOption({
  label,
  caption,
  sub,
  disabled,
  onSelect,
}: {
  label: string;
  caption: string;
  sub: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">{caption}</span>
      <span className="text-xs text-muted-foreground">{sub}</span>
    </button>
  );
}
