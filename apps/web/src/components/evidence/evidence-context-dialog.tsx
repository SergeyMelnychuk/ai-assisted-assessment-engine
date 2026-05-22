"use client";

import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { EvidenceCitation } from "./evidence-citation";

/**
 * Context-window dialog (ADR-0028).
 *
 * Opens when a reviewer clicks a chunk-preview body. Shows the chunk
 * itself plus the paragraphs *before* and *after* it from the same
 * source document, so the reviewer can read the chunk in context
 * before deciding whether it really supports the finding.
 *
 * Wraps a trigger element via children + asChild — keeps presentation
 * concerns inside this component while letting the chunk preview
 * decide what the clickable surface looks like.
 */
export function EvidenceContextDialog({
  evidenceId,
  trigger,
}: {
  evidenceId: string;
  trigger: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  // Fire the query only once the dialog opens — most chunks never get
  // expanded; no point paying the round-trip on render.
  const query = trpc.evidenceExplorer.contextWindow.useQuery(
    { evidenceId, before: 2, after: 2 },
    { enabled: open, staleTime: 5 * 60_000 },
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Chunk in context</DialogTitle>
          <DialogDescription>
            The retrieved chunk plus the paragraphs immediately before
            and after it. Reading the surrounding text usually answers
            “does this chunk actually support the finding?”.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {query.data ? (
            <>
              <EvidenceCitation trail={query.data.trail} interactive />
              <div className="space-y-2">
                {query.data.neighbours.map((n) => (
                  <article
                    key={n.evidenceId}
                    className={
                      "rounded-md border p-3 text-sm leading-relaxed " +
                      (n.isTarget
                        ? "border-primary/60 bg-primary/5 ring-1 ring-primary/40"
                        : "border-border bg-muted/20 text-muted-foreground")
                    }
                  >
                    <header className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide">
                      {n.isTarget ? (
                        <span className="rounded-full bg-primary px-1.5 py-0.5 font-semibold text-primary-foreground">
                          retrieved chunk
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          context
                        </span>
                      )}
                      {n.chunkIndex != null ? (
                        <span className="text-muted-foreground">
                          chunk {n.chunkIndex + 1}
                        </span>
                      ) : null}
                    </header>
                    <p className="whitespace-pre-wrap">{n.content}</p>
                  </article>
                ))}
              </div>
              {query.data.neighbours.length === 1 && (
                <p className="text-xs text-muted-foreground">
                  No adjacent chunks — this evidence isn’t associated
                  with a paginated source document.
                </p>
              )}
            </>
          ) : query.error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {query.error.message}
            </p>
          ) : (
            <div className="space-y-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
