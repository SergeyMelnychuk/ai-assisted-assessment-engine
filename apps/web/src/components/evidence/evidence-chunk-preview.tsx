"use client";

import type { ReactElement } from "react";
import type { RouterOutputs } from "@/lib/trpc";
import { EvidenceCitation } from "./evidence-citation";
import { EvidenceContextDialog } from "./evidence-context-dialog";

type CitedTrail = RouterOutputs["evidenceExplorer"]["findingTrail"]["cited"][number];
type SearchResult = RouterOutputs["evidenceExplorer"]["search"][number];

interface CommonPreviewProps {
  /** Already-hydrated trail fields. */
  trail: CitedTrail["trail"];
  /** Chunk body. Truncated for display. */
  content: string;
  /** Cosine similarity in [0, 1], if we have it. */
  similarity?: number;
  /** Optional count of near-duplicate chunks merged into this one. */
  duplicateCount?: number;
  /**
   * Evidence id of the chunk. When present, the snippet body is
   * clickable and opens the context-window dialog (ADR-0028) so the
   * reviewer can read the chunk's neighbours. Omit to render a
   * non-interactive card.
   */
  evidenceId?: string;
  /**
   * Hybrid-retrieval ranks for the chunk (ADR-0027). Drive the
   * `matched: semantic/lexical/both` chip in the citation. Null
   * (or missing) → chip not rendered.
   */
  denseRank?: number | null;
  lexicalRank?: number | null;
}

const MAX_PREVIEW_CHARS = 360;

/**
 * Shared preview card for an evidence chunk. Used in:
 *
 *   - Evidence Explorer results list
 *   - "Why this finding?" popover (cited + retrieved lists)
 *
 * Citation row renders the ADR-0028 `EvidenceCitation`; the snippet
 * body is a button that opens the context-window dialog so reviewers
 * can read the chunk in its surrounding paragraphs.
 */
export function EvidenceChunkPreview(props: CommonPreviewProps): ReactElement {
  const snippet =
    props.content.length > MAX_PREVIEW_CHARS
      ? `${props.content.slice(0, MAX_PREVIEW_CHARS - 1)}…`
      : props.content;

  const body = (
    <p className="mt-2 whitespace-pre-wrap text-sm leading-snug text-foreground">
      {snippet}
    </p>
  );

  return (
    <div className="rounded-md border bg-card p-3 text-sm shadow-sm">
      <EvidenceCitation
        trail={props.trail}
        similarity={props.similarity}
        denseRank={props.denseRank}
        lexicalRank={props.lexicalRank}
        interactive
      />
      {props.evidenceId ? (
        <EvidenceContextDialog
          evidenceId={props.evidenceId}
          trigger={
            <button
              type="button"
              title="Open chunk in context"
              className="block w-full rounded-sm text-left transition-colors hover:bg-muted/40"
            >
              {body}
            </button>
          }
        />
      ) : (
        body
      )}
      {props.duplicateCount !== undefined && props.duplicateCount > 1 && (
        <p className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
          +{props.duplicateCount - 1} similar chunk
          {props.duplicateCount - 1 === 1 ? "" : "s"} from the same corpus
        </p>
      )}
    </div>
  );
}

/** Convenience wrapper for the Evidence Explorer search results list. */
export function ClusteredChunkPreview({
  cluster,
}: {
  cluster: SearchResult;
}): ReactElement {
  return (
    <EvidenceChunkPreview
      trail={cluster.trail}
      content={cluster.content}
      similarity={cluster.similarity}
      duplicateCount={cluster.duplicateCount}
      evidenceId={cluster.representativeId}
      denseRank={cluster.denseRank}
      lexicalRank={cluster.lexicalRank}
    />
  );
}
