import type { ReactElement } from "react";
import type { RouterOutputs } from "@/lib/trpc";

// The trail shape returned by every evidenceExplorer endpoint is
// identical, so we key off the `trail` (router output type) on the
// lightest of the three — `findingTrail.cited[0].trail`. That way
// this component renders consistent output whether it's fed from a
// clustered search result, a trail hydration, or a finding trail.
export type EvidenceTrail =
  RouterOutputs["evidenceExplorer"]["findingTrail"]["cited"][number]["trail"];

/**
 * Renders the source trail for a single evidence chunk as a compact
 * inline phrase:
 *
 *   • from architecture.md §Security Architecture
 *   • from repo:acme/platform · src/auth.ts (ts)
 *
 * Pure presentational — no data fetching. Used both client-side
 * (`EvidenceChunkPreview`, `WhyThisFindingPanel`) and server-side
 * (DOCX export, in the trail paragraph under each finding/risk).
 */
export function EvidenceSourceTrail({
  trail,
  className,
}: {
  trail: EvidenceTrail;
  className?: string;
}): ReactElement {
  const parts: string[] = [];

  if (trail.repoUrl) {
    // Strip protocol + trailing slash — `github.com/owner/repo` reads
    // cleaner than the full `https://…` in a dense list.
    const repo = trail.repoUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "");
    const path = trail.path ? ` · ${trail.path}` : "";
    const lang = trail.language ? ` (${trail.language})` : "";
    parts.push(`from repo:${repo}${path}${lang}`);
  } else if (trail.documentName) {
    const heading = trail.heading ? ` §${trail.heading}` : "";
    const page = trail.page !== null ? ` p.${trail.page}` : "";
    parts.push(`from ${trail.documentName}${heading}${page}`);
  } else if (trail.path) {
    parts.push(`from ${trail.path}`);
  } else {
    parts.push("source unavailable");
  }

  return (
    <span
      className={`text-xs text-muted-foreground ${className ?? ""}`.trim()}
    >
      {parts.join(" · ")}
    </span>
  );
}

/**
 * Server-safe stringifier of the same trail for the DOCX renderer.
 * Keeps the formatting in one place — the React component above and
 * the DOCX string below are two renderers of one function.
 */
export function renderEvidenceTrailString(trail: {
  documentName: string | null;
  heading: string | null;
  page: number | null;
  language: string | null;
  repoUrl: string | null;
  path: string | null;
}): string {
  if (trail.repoUrl) {
    const repo = trail.repoUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "");
    const path = trail.path ? ` · ${trail.path}` : "";
    const lang = trail.language ? ` (${trail.language})` : "";
    return `from repo:${repo}${path}${lang}`;
  }
  if (trail.documentName) {
    const heading = trail.heading ? ` §${trail.heading}` : "";
    const page = trail.page !== null ? ` p.${trail.page}` : "";
    return `from ${trail.documentName}${heading}${page}`;
  }
  if (trail.path) return `from ${trail.path}`;
  return "source unavailable";
}
