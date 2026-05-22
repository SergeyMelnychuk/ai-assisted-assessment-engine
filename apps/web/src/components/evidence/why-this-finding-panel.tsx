"use client";

import type { ReactElement } from "react";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EvidenceChunkPreview } from "./evidence-chunk-preview";

const MAX_CITED_PREVIEW = 5;

/**
 * "Why this finding?" panel (Phase 3 Week 7, ADR-0011).
 *
 * Triggered from any finding / risk / recommendation row. Expands
 * inline (no modal library dep — keeping bundle small) and shows:
 *
 *   - Top 3-5 cited chunks (what the model surfaced).
 *   - Any *retrieved-but-not-cited* chunks as a secondary list — this
 *     is the "what the AI had in context" disclosure that separates
 *     us from black-box LLM outputs.
 *
 * The finding trail is fetched lazily on first open so we don't pay
 * the round-trip for every row on the findings list.
 */
export function WhyThisFindingPanel({
  findingId,
}: {
  findingId: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const query = trpc.evidenceExplorer.findingTrail.useQuery(
    { findingId },
    { enabled: open, staleTime: 5 * 60_000 },
  );

  return (
    <div className="mt-2 border-t pt-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className="h-7 px-2 text-xs"
      >
        {open ? "Hide evidence" : "Why this finding?"}
      </Button>
      {open && (
        <div className="mt-3 space-y-3">
          {query.isLoading && <Skeleton className="h-16 w-full" />}
          {query.error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {query.error.message}
            </p>
          )}
          {query.data && (
            <>
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Cited by the AI ({query.data.cited.length})
                </h4>
                {query.data.cited.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    The model produced this finding without citing a
                    specific chunk. See the retrieved context below
                    for what it had available.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {query.data.cited.slice(0, MAX_CITED_PREVIEW).map((c) => (
                      <EvidenceChunkPreview
                        key={c.evidenceId}
                        trail={c.trail}
                        content={c.content}
                        evidenceId={c.evidenceId}
                      />
                    ))}
                  </div>
                )}
              </section>
              {query.data.retrieved.length > 0 && (
                <section>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Retrieved but not cited ({query.data.retrieved.length})
                  </h4>
                  <div className="space-y-2">
                    {query.data.retrieved.slice(0, MAX_CITED_PREVIEW).map((c) => (
                      <EvidenceChunkPreview
                        key={c.evidenceId}
                        trail={c.trail}
                        content={c.content}
                        evidenceId={c.evidenceId}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
