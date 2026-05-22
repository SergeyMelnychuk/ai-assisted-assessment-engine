import Link from "next/link";

/**
 * Shared brand mark — used both in the sidebar (when expanded) and in
 * the top bar (when the sidebar is collapsed) so the wordmark "stays
 * as is" regardless of sidebar state. Same typography + spacing in
 * both placements; only the host container changes.
 *
 * Now a wordmark instead of an image: clicking returns the user to
 * the engagements landing inside the app, rather than out to a
 * vendor site.
 */
export function BrandLogo() {
  return (
    <Link
      href="/engagements"
      className="flex items-baseline gap-1.5 text-foreground"
      aria-label="Assessment Co-Pilot"
    >
      <span className="text-lg font-semibold tracking-tight">
        Assessment
      </span>
      <span className="text-lg font-semibold tracking-tight text-primary">
        Co-Pilot
      </span>
    </Link>
  );
}
