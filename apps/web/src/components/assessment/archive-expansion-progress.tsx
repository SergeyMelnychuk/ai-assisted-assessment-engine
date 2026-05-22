"use client";

/**
 * Archive-card expansion progress indicator (Phase 3 Week 5 gap-fill).
 * Maps the archive-parent `Document`'s `ingestStatus` + child counts
 * into a human-readable sentence, driving the text next to the
 * parent archive row in the document list:
 *
 *   uploading                             → "Uploading…"
 *   EXTRACTING (parent, no children yet)  → "Extracting archive…"
 *   EXTRACTING (parent, N children)       → "Extracting: N children queued"
 *   READY (parent, children partly READY) → "Ingested M / N files"
 *   READY (all children READY/FAILED)     → "Ready · M of N ingested"
 *   FAILED (parent)                       → "Failed to extract archive"
 *
 * Kept as a pure mapping + a trivial render so the logic is unit-
 * testable without booting React Testing Library.
 */

export interface ArchiveProgress {
  parentIngestStatus:
    | "PENDING"
    | "EXTRACTING"
    | "CHUNKED"
    | "EMBEDDED"
    | "READY"
    | "FAILED";
  childTotal: number;
  childReady: number;
  childFailed: number;
}

/**
 * Pure mapping — archive parent + child tallies → display string.
 * Tested in `archive-expansion-progress.test.ts`.
 */
export function formatArchiveProgress(p: ArchiveProgress): string {
  if (p.parentIngestStatus === "FAILED") {
    return "Failed to extract archive";
  }
  if (p.parentIngestStatus === "PENDING") {
    return "Uploading…";
  }
  if (p.parentIngestStatus === "EXTRACTING") {
    if (p.childTotal === 0) return "Extracting archive…";
    return `Extracting: ${p.childTotal} children queued`;
  }
  // CHUNKED / EMBEDDED are transient for parent rows — treat like READY
  // from the user's perspective (extraction complete, children in-flight).
  const terminal = p.childReady + p.childFailed;
  if (p.childTotal === 0) return "Extracted (no ingestable files)";
  if (terminal < p.childTotal) {
    return `Ingested ${p.childReady} / ${p.childTotal} files`;
  }
  if (p.childFailed > 0) {
    return `Ready · ${p.childReady} of ${p.childTotal} ingested (${p.childFailed} failed)`;
  }
  return `Ready · ${p.childReady} of ${p.childTotal} ingested`;
}

export function ArchiveExpansionProgress(props: ArchiveProgress) {
  const label = formatArchiveProgress(props);
  const active =
    props.parentIngestStatus === "PENDING" ||
    props.parentIngestStatus === "EXTRACTING" ||
    (props.parentIngestStatus !== "FAILED" &&
      props.childReady + props.childFailed < props.childTotal);

  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      data-testid="archive-expansion-progress"
      data-status={props.parentIngestStatus}
    >
      {active ? (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      <span>{label}</span>
    </div>
  );
}
