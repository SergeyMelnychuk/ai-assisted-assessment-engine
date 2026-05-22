"use client";

import { cn } from "@/lib/utils";
import { domainLabel as prettyDomain } from "@/lib/domain-labels";

/**
 * Progress bar for per-domain question coverage. Uses a hybrid meter that
 * overlays the CRITICAL subset on the overall bar so reviewers can see
 * at a glance whether the answered ratio is load-bearing or trivia.
 */
export function CoverageBar({
  domain,
  answered,
  total,
  criticalAnswered,
  criticalTotal,
  active = false,
  onToggle,
}: {
  domain: string;
  answered: number;
  total: number;
  criticalAnswered: number;
  criticalTotal: number;
  /** When provided, renders the label as a toggle filter pill. */
  active?: boolean;
  onToggle?: (domain: string) => void;
}) {
  const ratio = total === 0 ? 0 : answered / total;
  const criticalRatio =
    criticalTotal === 0 ? 0 : criticalAnswered / criticalTotal;

  const pct = Math.round(ratio * 100);
  const critPct = Math.round(criticalRatio * 100);

  // Domain label map is duplicated with assessment-setup-form; keep thin.
  const label = prettyDomain(domain);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        {onToggle ? (
          <button
            type="button"
            onClick={() => onToggle(domain)}
            aria-pressed={active}
            className={cn(
              "rounded px-1 -mx-1 text-left font-medium transition-colors",
              "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "text-primary underline underline-offset-4"
                : "text-foreground",
            )}
          >
            {label}
          </button>
        ) : (
          <span className="font-medium">{label}</span>
        )}
        <span className="text-xs text-muted-foreground">
          {answered}/{total}
          {criticalTotal > 0 ? (
            <span className="ml-2">
              critical {criticalAnswered}/{criticalTotal}
            </span>
          ) : null}
        </span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full bg-primary/60 transition-all",
          )}
          style={{ width: `${pct}%` }}
        />
        {criticalTotal > 0 ? (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-primary transition-all"
            style={{ width: `${(critPct / 100) * (criticalTotal / total) * 100}%` }}
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  );
}
