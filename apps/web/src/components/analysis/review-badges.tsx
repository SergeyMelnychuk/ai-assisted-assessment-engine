/**
 * Pure display helpers for the analysis lists. Kept in one file so the
 * tone palette stays consistent across findings / risks / recommendations.
 */
import { domainLabel } from "@/lib/domain-labels";

// All tinted-background badges use `text-muted-foreground` — colored text
// on 10%-tint backgrounds (even deep -900 shades) lacks contrast in
// light mode. The category still reads from border + background hue;
// only the label copy goes near-black (light) / near-white (dark).
// Matches the treatment in `failure-banner.tsx`. `text-destructive`
// is kept where used because it's a full-strength token already.
const REVIEW_TONES: Record<string, string> = {
  DRAFT: "border-border bg-muted text-muted-foreground",
  IN_REVIEW: "border-blue-500/40 bg-blue-500/10 text-muted-foreground",
  APPROVED: "border-green-500/40 bg-green-500/10 text-muted-foreground",
  REJECTED: "border-destructive/40 bg-destructive/10 text-destructive",
  NEEDS_REVISION: "border-amber-500/40 bg-amber-500/10 text-muted-foreground",
};

const SEVERITY_TONES: Record<string, string> = {
  CRITICAL: "border-destructive/40 bg-destructive/10 text-destructive",
  HIGH: "border-amber-500/40 bg-amber-500/10 text-muted-foreground",
  MEDIUM: "border-border bg-muted text-muted-foreground",
  LOW: "border-border bg-muted/60 text-muted-foreground",
  INFO: "border-border bg-muted/40 text-muted-foreground",
};

export function ReviewBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${REVIEW_TONES[status] ?? REVIEW_TONES.DRAFT}`}
    >
      {status.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_TONES[severity] ?? SEVERITY_TONES.MEDIUM}`}
    >
      {severity}
    </span>
  );
}

export function ConfidenceBadge({ value }: { value: number }) {
  // Three-tier map: <0.4 = low (destructive-ish), 0.4–0.7 = medium, >0.7 = high.
  const tone =
    value >= 0.7
      ? "border-green-500/40 bg-green-500/10 text-muted-foreground"
      : value >= 0.4
        ? "border-amber-500/40 bg-amber-500/10 text-muted-foreground"
        : "border-destructive/40 bg-destructive/10 text-destructive";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      confidence {Math.round(value * 100)}%
    </span>
  );
}

/**
 * Re-exports the shared `domainLabel` helper under the legacy name used
 * by the analysis list components. The curated label map lives in
 * `@/lib/domain-labels` so every surface (findings, risks, recs, per-
 * domain status badges, scoring, questions, setup form) renders the
 * same human-readable strings.
 */
export function prettyDomain(key: string): string {
  return domainLabel(key);
}
