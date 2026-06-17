"use client";

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const STATUS_TONES: Record<string, string> = {
  GENERATING: "border-border bg-muted text-muted-foreground",
  DRAFT: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  IN_REVIEW: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  APPROVED: "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300",
  EXPORTED: "border-primary/40 bg-primary/10 text-primary",
};

/**
 * Export-landing page list. One row per deliverable with an export
 * button whose label and tone depend on review progress:
 *   - APPROVED      → "Export DOCX" (primary)
 *   - EXPORTED      → "Re-export" (secondary)
 *   - anything else → "Export draft" (secondary + watermark warning)
 *
 * All exports go through the REST route so the download happens via a
 * plain anchor — no JS-managed blob needed, and the browser's native
 * download UI handles the filename from Content-Disposition.
 */
export function ExportList({ assessmentId }: { assessmentId: string }) {
  const query = trpc.export.listByAssessment.useQuery(
    { assessmentId },
    { refetchInterval: 5_000 },
  );

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (query.error) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {query.error.message}
      </p>
    );
  }

  const list = query.data ?? [];
  if (list.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nothing to export yet</CardTitle>
          <CardDescription>
            Generate a deliverable on the Deliverables tab first. Once its
            sections are drafted you can export a draft DOCX; once every
            section is approved the gate unlocks a clean (no-watermark)
            export.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {list.map((d) => {
        const ratio =
          d.totalSections === 0 ? 0 : d.approvedSections / d.totalSections;
        const pct = Math.round(ratio * 100);
        return (
          <Card key={d.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_TONES[d.status] ?? ""}`}
                  >
                    {d.status.toLowerCase()}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {d.approvedSections}/{d.totalSections} sections approved ({pct}%)
                  </span>
                  {d.canExportClean ? (
                    <span className="inline-flex items-center rounded-full border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-300">
                      ready to export
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300">
                      draft export only
                    </span>
                  )}
                </div>
                <CardTitle className="mt-2 text-base">
                  {d.deliverableType.replace(/_/g, " ").toLowerCase()}
                </CardTitle>
                <CardDescription>
                  {/* This is the engine's internal section-spec key (the
                      house layout the DOCX/PDF export renders from), not
                      the customer's uploaded template. Labelled "Layout"
                      so it's never mistaken for the branded template —
                      that one is the "populated template" download
                      below. */}
                  {d.layoutKey ? `Layout: ${d.layoutKey} · ` : ""}
                  Last updated{" "}
                  {new Date(d.updatedAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </CardDescription>
              </div>
              <div className="flex gap-2">
                {d.hasAnyContent ? (
                  <ExportMenu
                    deliverableId={d.id}
                    canExportClean={d.canExportClean}
                    alreadyExported={d.status === "EXPORTED"}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    (no sections)
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Branded customer-template fill. Distinct artifact from
                  the engine DOCX/PDF above — this is the uploaded
                  template populated with engine data + AI prose. Shown
                  here so the Export page is the one place that offers
                  both. */}
              {d.populatedFill ? (
                <div className="rounded-md border bg-muted/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">
                        Populated template
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {d.populatedFill.templateName}{" "}
                        {d.populatedFill.templateVersion} ·{" "}
                        {d.populatedFill.filename} ·{" "}
                        {(d.populatedFill.fileSize / 1024).toFixed(0)} KB
                      </div>
                    </div>
                    <a
                      href={`/api/documents/${d.populatedFill.documentId}/download?download=1`}
                      className="shrink-0 text-sm font-medium text-primary underline-offset-2 hover:underline"
                    >
                      Download
                    </a>
                  </div>
                  {/* Fill-health — surface a no-op fill loudly instead
                      of handing over a blank branded doc silently. */}
                  {d.populatedFill.isEmpty ? (
                    <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300">
                      ⚠ This template filled <strong>0 fields</strong> — it
                      has no recognised <code>{"{{placeholders}}"}</code>.
                      The download is effectively a blank copy. Add
                      placeholder tokens to the template and re-approve it
                      on the Templates tab.
                    </p>
                  ) : d.populatedFill.warnings.length > 0 ? (
                    <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300">
                      ⚠ Filled with {d.populatedFill.warnings.length} warning
                      {d.populatedFill.warnings.length === 1 ? "" : "s"} —
                      some fields didn&apos;t resolve. First:{" "}
                      {d.populatedFill.warnings[0]}
                    </p>
                  ) : d.populatedFill.filledEntryCount !== null ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Filled {d.populatedFill.filledEntryCount} field
                      {d.populatedFill.filledEntryCount === 1 ? "" : "s"}.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {!d.canExportClean && d.hasAnyContent ? (
                <p className="text-xs text-muted-foreground">
                  Draft exports include every section, with a DRAFT
                  watermark on anything not yet approved. Approve every
                  section on the Deliverables tab to unlock a clean
                  export.
                </p>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * Split-button menu: primary "Export" click reveals a dropdown with
 * format choices (PDF / DOCX). Each format hits its own REST route
 * which streams the binary back; the browser's native download
 * picker handles the save UX.
 *
 * Hand-rolled to avoid pulling Radix DropdownMenu in for one use —
 * follows the same pattern as the run-analysis Draft/Reviewed
 * chooser we already ship.
 */
function ExportMenu({
  deliverableId,
  canExportClean,
  alreadyExported,
}: {
  deliverableId: string;
  canExportClean: boolean;
  alreadyExported: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Outside-click + Escape close the menu (no full DropdownMenu
  // primitive needed for two options).
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

  const label = alreadyExported
    ? "Re-export"
    : canExportClean
      ? "Export"
      : "Export draft";

  return (
    <div className="relative inline-flex" ref={containerRef}>
      <Button
        type="button"
        variant={canExportClean ? "default" : "secondary"}
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label} ▾
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-32 rounded-md border border-border bg-background p-1 text-foreground shadow-md"
        >
          <FormatLink
            href={`/api/deliverables/${deliverableId}/export-pdf`}
            label="PDF"
            onPick={() => setOpen(false)}
          />
          <FormatLink
            href={`/api/deliverables/${deliverableId}/export`}
            label="DOCX"
            onPick={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}

function FormatLink({
  href,
  label,
  onPick,
}: {
  href: string;
  label: string;
  onPick: () => void;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      role="menuitem"
      onClick={onPick}
      className="block w-full rounded px-2 py-2 text-left text-sm font-medium hover:bg-accent hover:text-accent-foreground"
    >
      {label}
    </a>
  );
}
