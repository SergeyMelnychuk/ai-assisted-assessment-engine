"use client";

import type { TemplateKind } from "@prisma/client";
import { trpc } from "@/lib/trpc";

/**
 * Renders a "Download populated …" link that points at the latest
 * `TemplateFill.outputDocument` for the given assessment + kind. Hides
 * itself when no successful fill exists yet.
 *
 * The download endpoint is the regular Document download route —
 * `/api/documents/[id]/download` with `?download=1` to force the
 * Content-Disposition: attachment header.
 */
export function TemplateFillDownload({
  assessmentId,
  kind,
  className,
}: {
  assessmentId: string;
  kind: TemplateKind;
  className?: string;
}) {
  // Light polling so a freshly-completed fill appears without a manual
  // refresh after the worker finishes.
  const fillQuery = trpc.template.latestFillForAssessment.useQuery(
    { assessmentId, kind },
    { refetchInterval: 10_000 },
  );

  const fill = fillQuery.data;
  if (!fill || !fill.outputDocument) return null;

  const sizeKb = (fill.outputDocument.fileSize / 1024).toFixed(0);
  const label =
    kind === "ESTIMATION"
      ? "Download populated WBS"
      : "Download populated deliverable";

  return (
    <div
      className={
        "rounded-md border bg-muted/20 p-3 text-sm " + (className ?? "")
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <a
            href={`/api/documents/${fill.outputDocument.id}/download?download=1`}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {label}
          </a>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {fill.template.name} {fill.template.version} ·{" "}
            {fill.outputDocument.filename} · {sizeKb} KB
          </div>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {new Date(fill.filledAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </span>
      </div>
    </div>
  );
}
