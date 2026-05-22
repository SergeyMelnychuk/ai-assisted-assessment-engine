/**
 * Evidence emitter — ADR-0014 §3, §7.
 *
 * Converts a batch of `EvidenceDraft` objects from a tool into
 * `Evidence(sourceType=CONNECTOR)` rows, deduping on `contentSha`
 * (ADR-0011 compatible). The `chunkSource` column carries the
 * provenance envelope the reviewer UI turns into deep-links.
 *
 * v1 deliberately skips embedding: evidence rows land without vector
 * embeddings so the agent path doesn't block on the embedding service
 * being available. The retrieval pass tolerates `embedding IS NULL`
 * rows (they fall out of vector search but still surface via keyword /
 * domain filters), and a follow-up backfill can fill them in. Once the
 * agent path is in regular use we'll route emitted rows through the
 * same `insertEvidenceRowsWithEmbeddings` path the document ingest
 * worker uses.
 *
 * Dedup is on `contentSha`: if a tool emits the same blob twice (e.g.
 * the planner re-reads a file across two steps) we keep one row and
 * return the existing id for both call sites.
 */

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { EvidenceDraft, ToolContext } from "./types";

interface EmitterDeps {
  db: PrismaClient;
}

/**
 * Persist evidence drafts. Returns the list of Evidence row IDs in
 * draft order (one id per draft — duplicates resolve to the existing
 * row's id, never to `undefined`, so call-sites can zip the returned
 * array against their input by index).
 */
export async function emitEvidence(
  ctx: ToolContext,
  drafts: EvidenceDraft[],
  deps: EmitterDeps,
): Promise<string[]> {
  if (drafts.length === 0) return [];
  const { db } = deps;
  const out: string[] = new Array(drafts.length);

  // Single sequential pass — agent runs emit a handful of rows per step,
  // not thousands. Splitting into a transaction would buy us atomicity
  // but cost throughput; partial-batch failure here is recoverable
  // because dedup-on-sha means a re-run won't double-insert.
  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i];
    const sha = draft.contentSha ?? sha256Hex(draft.content);

    const existing = await db.evidence.findFirst({
      where: { assessmentId: ctx.assessmentId, contentSha: sha },
      select: { id: true },
    });
    if (existing) {
      out[i] = existing.id;
      continue;
    }

    const created = await db.evidence.create({
      data: {
        assessmentId: ctx.assessmentId,
        sourceType: "CONNECTOR",
        content: draft.content,
        domain: draft.domain,
        confidence: draft.confidence,
        contentSha: sha,
        chunkSource: serialiseProvenance(
          draft,
          ctx.runId,
          ctx.stepId,
        ) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    out[i] = created.id;
  }
  return out;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Pack the draft's provenance envelope plus the harness-side run/step
 * ids into the `chunkSource` JSON. The reviewer UI uses these to
 * deep-link to the originating tool call.
 */
function serialiseProvenance(
  draft: EvidenceDraft,
  runId: string,
  stepId: string,
): Record<string, unknown> {
  return {
    origin: "agent",
    runId,
    stepId,
    provenance: draft.provenance,
  };
}
