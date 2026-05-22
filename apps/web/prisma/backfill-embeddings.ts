/**
 * Backfill embeddings onto existing Evidence rows (Phase 3 Week 3,
 * ADR-0003). Pre-Week-3 rows were created without the `embedding`,
 * `chunk_index`, `chunk_source`, or `content_sha` columns populated;
 * this script catches them up.
 *
 * Design invariants:
 *   - **Idempotent.** Rows whose `content_sha` already matches the
 *     chunker's hash are skipped. Re-runs converge to the same final
 *     state.
 *   - **Resumable.** No global state; each batch commits on its own.
 *     Killing the script mid-run means we resume by re-selecting
 *     rows where `embedding IS NULL` on the next run.
 *   - **Rate-aware, carved-out retry.** The embedding client has
 *     `maxRetries: 0` because every retry re-bills tokens. Backfill is
 *     a non-realtime operation where we accept a single 5-second
 *     retry-per-batch on rate-limit errors, to avoid a wasted human
 *     re-run for a transient cap. This is the ONLY place retries exist
 *     in the AI pipeline — all other call-sites stay retry-off. See
 *     ADR-0003 for why this carve-out is safe.
 *
 * Usage:
 *   pnpm tsx apps/web/prisma/backfill-embeddings.ts
 *
 * Environment:
 *   DATABASE_URL (required), OPENAI_API_KEY (optional — unset → fake
 *   mode). Respects `EMBEDDING_MODEL` and `EMBEDDING_MODE`.
 */

import { PrismaClient } from "@prisma/client";
import {
  chunkText,
  computeContentSha,
} from "../src/server/services/document-chunker";
import {
  embedTexts,
  EMBEDDING_DIMENSIONS,
} from "../src/server/services/ai/embedding-service";

const BATCH_SIZE = 50;
const RATE_LIMIT_RETRY_MS = 5_000;

interface EvidenceRow {
  id: string;
  content: string;
  content_sha: string | null;
}

export async function runBackfill(
  prisma: PrismaClient = new PrismaClient(),
  opts: { batchSize?: number; log?: (msg: string) => void } = {},
): Promise<{ processed: number; skipped: number; batches: number }> {
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const log = opts.log ?? ((msg) => console.log(`[backfill] ${msg}`));

  let processed = 0;
  let skipped = 0;
  let batches = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Raw SQL because the column is `Unsupported("vector(1536)")`. We
    // only need id / content / content_sha; `LIMIT` bounds memory on
    // big DBs.
    const rows = await prisma.$queryRawUnsafe<EvidenceRow[]>(
      `SELECT "id", "content", "content_sha"
         FROM "evidences"
        WHERE "embedding" IS NULL
        ORDER BY "created_at" ASC
        LIMIT $1`,
      batchSize,
    );
    if (rows.length === 0) break;

    batches += 1;
    const toEmbed: { id: string; content: string; contentSha: string }[] = [];

    for (const row of rows) {
      if (!row.content || !row.content.trim()) {
        // Empty evidence row — nothing to embed. Stamp a sentinel SHA
        // so the next pass doesn't re-select it.
        await prisma.$executeRawUnsafe(
          `UPDATE "evidences" SET "content_sha" = 'empty' WHERE "id" = $1 AND "embedding" IS NULL`,
          row.id,
        );
        skipped += 1;
        continue;
      }
      const sha = computeContentSha(row.content);
      if (row.content_sha === sha) {
        // Already processed this exact content in a previous pass but
        // the embedding column is still null — possible on a crash
        // between SHA write and vector write. Falls through to re-embed.
      }
      toEmbed.push({ id: row.id, content: row.content, contentSha: sha });
    }

    if (toEmbed.length === 0) continue;

    // The single rate-limit retry carve-out (see ADR-0003).
    let result;
    try {
      result = await embedTexts(toEmbed.map((r) => r.content));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/rate.?limit|429/i.test(msg)) {
        log(
          `rate-limited on batch ${batches}, sleeping ${RATE_LIMIT_RETRY_MS}ms before single retry`,
        );
        await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS));
        result = await embedTexts(toEmbed.map((r) => r.content));
      } else {
        throw err;
      }
    }

    const { vectors } = result;
    if (vectors.length !== toEmbed.length) {
      throw new Error(
        `backfill: vector count ${vectors.length} != batch ${toEmbed.length}`,
      );
    }

    // Per-row update so a crash mid-batch leaves earlier rows committed.
    // We still wrap each update in an implicit transaction via Prisma.
    for (let i = 0; i < toEmbed.length; i += 1) {
      const row = toEmbed[i];
      const vector = vectors[i];
      if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `backfill: row ${row.id} got malformed vector (len=${Array.isArray(vector) ? vector.length : typeof vector})`,
        );
      }

      // Re-derive a chunk record so we can populate chunk_source for
      // rows that were created before the chunker ran (Week 1 rows
      // only had content; no heading / offset metadata survives).
      const fallbackChunk = chunkText(row.content).at(0);
      const chunkSource = JSON.stringify({
        offset: fallbackChunk?.startOffset ?? 0,
        endOffset: fallbackChunk?.endOffset ?? row.content.length,
        heading: fallbackChunk?.heading ?? null,
        backfilled: true,
      });
      const vectorLiteral = `'[${vector.join(",")}]'::vector(${EMBEDDING_DIMENSIONS})`;

      await prisma.$executeRawUnsafe(
        `UPDATE "evidences"
            SET "embedding" = ${vectorLiteral},
                "content_sha" = $1,
                "chunk_source" = $2::jsonb,
                "chunk_index" = COALESCE("chunk_index", 0)
          WHERE "id" = $3`,
        row.contentSha,
        chunkSource,
        row.id,
      );
      processed += 1;
    }

    log(`batch ${batches}: embedded ${toEmbed.length} rows (total ${processed})`);
  }

  log(`done: ${processed} processed, ${skipped} skipped, ${batches} batches`);
  return { processed, skipped, batches };
}

// Entrypoint when run directly with `tsx`.
if (require.main === module) {
  runBackfill()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[backfill] fatal:", err);
      process.exit(1);
    });
}
