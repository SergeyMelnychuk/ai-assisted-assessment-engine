import { Prisma, type PrismaClient } from "@prisma/client";
import { embed } from "./ai/embedding-service";
import { isHybridRetrievalEnabled } from "./agent/feature-flag";
import {
  MIN_COSINE_SIMILARITY,
  TOP_K_ANALYSIS,
} from "./retrieval/retrieval-config";

/**
 * Retrieval-Augmented Generation helper (Phase 3 Week 4, ADR-0006/0007).
 *
 * Every AI call that used to read `evidence.findMany({ take: 80 })` goes
 * through `retrieve()` instead. The query is embedded with the same model
 * used at ingest time (`text-embedding-3-small`, 1536-dim); the top-K
 * nearest chunks under cosine similarity are returned, scoped to an
 * assessment and optionally filtered by domain.
 *
 * Discipline:
 *   - Typed in/out; never `any`.
 *   - No automatic retries — consistent with ADR-0001/0003.
 *   - Hybrid fallback (widen-not-pad, ADR-0006): if the domain-filtered
 *     result underfills, re-run without the filter and merge so the AI
 *     always gets a non-trivial context.
 */

// ─── Public shapes ───────────────────────────────────────────────

export interface RetrieveArgs {
  assessmentId: string;
  query: string;
  /** Optional domain tag to scope to (e.g. `security`, `architecture`). */
  domain?: string;
  /**
   * Optional source-document filter. When set, only chunks whose
   * `Evidence.document_id` is in the provided list are returned.
   * Used by the Evidence Explorer "filter by source documents" UI;
   * not used by the analysis pipeline (which intentionally searches
   * across all documents). An empty array is treated the same as
   * undefined (no filter). The hybrid widen-on-underfill behavior is
   * **disabled** when this is set — the user explicitly scoped to a
   * subset, so silently broadening to the rest of the corpus would
   * defeat that.
   */
  documentIds?: readonly string[];
  /** Number of chunks to return. Defaults to 20. */
  topK?: number;
  /**
   * Cosine similarity floor (0..1). Chunks below are dropped. Defaults
   * to 0 (keep everything). See ADR-0006 for the policy discussion.
   */
  minSimilarity?: number;
}

export interface ChunkResult {
  evidenceId: string;
  content: string;
  /** Cosine similarity in [0, 1]; 1 = identical. */
  similarity: number;
  chunkIndex: number | null;
  chunkSource: unknown;
  sourceDocumentId: string | null;
  domain?: string;
  /**
   * Populated only when hybrid retrieval (ADR-0027) is enabled.
   * Reciprocal Rank Fusion score combining dense + lexical ranks.
   * Returned for diagnostics — callers that care about ranking
   * already get rows in `rrfScore DESC` order from the SQL.
   */
  rrfScore?: number;
  /**
   * Per-side rank when hybrid is on. `null` for the side that
   * didn't surface this chunk. Useful for the Evidence Explorer's
   * "matched on: semantic / lexical / both" affordance (follow-up
   * in ADR-0027).
   */
  denseRank?: number | null;
  lexicalRank?: number | null;
}

// ─── Internal row shape from raw SQL ─────────────────────────────

interface RawChunkRow {
  id: string;
  content: string;
  distance: number; // cosine distance in [0, 2]; similarity = 1 - distance
  chunk_index: number | null;
  chunk_source: unknown;
  source_document_id: string | null;
  domain: string | null;
}

// ─── Entry point ─────────────────────────────────────────────────

// Defaults sourced from `retrieval-config.ts` so all call sites share
// one set of tuning constants (ADR-0012).
const DEFAULT_TOP_K = TOP_K_ANALYSIS;
const DEFAULT_MIN_SIMILARITY = MIN_COSINE_SIMILARITY;

export async function retrieve(
  db: PrismaClient,
  args: RetrieveArgs,
): Promise<ChunkResult[]> {
  const {
    assessmentId,
    query,
    domain,
    documentIds,
    topK = DEFAULT_TOP_K,
    minSimilarity = DEFAULT_MIN_SIMILARITY,
  } = args;
  const docFilter =
    documentIds && documentIds.length > 0 ? documentIds : undefined;

  if (!query || !query.trim()) return [];
  if (topK <= 0) return [];

  // Embed the query via the same model used at ingest time. Single-call
  // batch of size 1; callers that want to amortise embedding cost across
  // many queries should wrap their own batching above this layer.
  //
  // ADR-0012: the embedding call is logged with `callType:
  // 'retrieval-query'` so the /admin/cost rollup can separate "AI spend
  // on each user search" from ingest embedding (which is logged per
  // Document at ingest time).
  const [queryVec] = await embed([query], {
    callType: "retrieval-query",
    entityId: assessmentId,
    entityType: "Assessment",
  });
  if (!queryVec) return [];

  // ADR-0027: when the admin has turned hybrid retrieval on, take
  // the fused-rank path. The widen-on-underfill fallback (ADR-0006)
  // is redundant here — lexical results usually fill in for an
  // underfilling cosine query — so the hybrid path returns once and
  // skips the widen step entirely.
  if (await isHybridRetrievalEnabled(db)) {
    const fused = await runHybridQuery(db, {
      assessmentId,
      query,
      queryVec,
      domain,
      documentIds: docFilter,
      topK,
    });
    // minSimilarity still applies on the dense-side cosine score so
    // callers that opt into a similarity floor (e.g. the analysis
    // engine) don't get noise even when lexical surfaced a row with
    // zero semantic signal.
    return fused.filter(
      (c) => c.denseRank == null || c.similarity >= minSimilarity,
    );
  }

  // Primary query — optionally domain-scoped and/or document-scoped.
  const primary = await runCosineQuery(db, {
    assessmentId,
    queryVec,
    domain,
    documentIds: docFilter,
    topK,
  });

  const keepFloor = primary.filter((c) => c.similarity >= minSimilarity);

  // Fallback trigger: the primary result underfills topK, OR the
  // similarity floor would drop below the widen-threshold. Policy in
  // ADR-0006: widen the filter instead of padding with noise.
  //
  // Document-scoped queries opt out of widening — the user explicitly
  // chose a subset; silently expanding to the whole corpus would
  // defeat the filter and surprise them with cross-doc results.
  const widenThreshold = Math.max(5, Math.floor(topK / 2));
  const needsFallback =
    docFilter === undefined &&
    domain !== undefined &&
    (primary.length < topK || keepFloor.length < widenThreshold);

  if (!needsFallback) return keepFloor;

  // Re-run without the domain filter. Merge preserving the primary order,
  // de-duplicated by evidenceId so the domain-scoped hits stay on top.
  const widened = await runCosineQuery(db, {
    assessmentId,
    queryVec,
    domain: undefined,
    documentIds: docFilter,
    topK,
  });

  const seen = new Set<string>();
  const merged: ChunkResult[] = [];
  for (const row of [...primary, ...widened]) {
    if (seen.has(row.evidenceId)) continue;
    if (row.similarity < minSimilarity) continue;
    seen.add(row.evidenceId);
    merged.push(row);
    if (merged.length >= topK) break;
  }
  return merged;
}

// ─── Raw cosine query ────────────────────────────────────────────

interface CosineQueryArgs {
  assessmentId: string;
  queryVec: number[];
  domain: string | undefined;
  documentIds: readonly string[] | undefined;
  topK: number;
}

async function runCosineQuery(
  db: PrismaClient,
  args: CosineQueryArgs,
): Promise<ChunkResult[]> {
  const { assessmentId, queryVec, domain, documentIds, topK } = args;

  // pgvector expects a `[0.1,0.2,...]` string literal cast to `vector`.
  // We build the literal here rather than interpolating floats directly
  // into SQL so Prisma's parameter binding stays in charge.
  const vectorLiteral = vectorToPgLiteral(queryVec);

  // Compose optional WHERE fragments via Prisma.sql — keeps parameter
  // binding intact (no string concatenation) while letting domain and
  // documentId filters layer independently. The HNSW index on
  // `embedding vector_cosine_ops` is picked up by the `<=>` operator
  // regardless of the extra equality predicates.
  const filters: Prisma.Sql[] = [
    Prisma.sql`assessment_id = ${assessmentId}`,
    Prisma.sql`embedding IS NOT NULL`,
  ];
  if (domain !== undefined) {
    // Match analysis-engine semantics: a domain filter accepts both
    // chunks tagged with that exact domain AND chunks in the
    // catch-all `"ingested"` bucket (the chunker's default for
    // anything it didn't classify per-domain). Without this, every
    // active domain would return zero rows because the chunker
    // doesn't tag per-domain at ingest time.
    filters.push(
      Prisma.sql`(domain = ${domain} OR domain = 'ingested')`,
    );
  }
  if (documentIds !== undefined && documentIds.length > 0) {
    // pgvector + Prisma: an IN-list with parameter binding is cleanest
    // via `Prisma.join` over an array of typed values. The HNSW index
    // still drives ranking; this just narrows the candidate set.
    filters.push(
      Prisma.sql`document_id IN (${Prisma.join(documentIds.map((id) => id))})`,
    );
  }
  const whereClause = Prisma.join(filters, " AND ");

  const rows = await db.$queryRaw<RawChunkRow[]>`
    SELECT
      id,
      content,
      embedding <=> ${vectorLiteral}::vector AS distance,
      chunk_index,
      chunk_source,
      document_id AS source_document_id,
      domain
    FROM evidences
    WHERE ${whereClause}
    ORDER BY embedding <=> ${vectorLiteral}::vector
    LIMIT ${topK}
  `;

  return rows.map((r) => ({
    evidenceId: r.id,
    content: r.content,
    // Cosine distance is in [0, 2]; 0 = identical, 1 = orthogonal.
    // Flip to a [-1, 1]-ish similarity and clamp into [0, 1] so call
    // sites can treat it as a confidence-ish score.
    similarity: clamp01(1 - Number(r.distance)),
    chunkIndex: r.chunk_index,
    chunkSource: r.chunk_source,
    sourceDocumentId: r.source_document_id,
    domain: r.domain ?? undefined,
  }));
}

// ─── Hybrid retrieval (ADR-0027) ─────────────────────────────────

interface HybridQueryArgs {
  assessmentId: string;
  /** Raw text — fed to `plainto_tsquery` server-side. */
  query: string;
  /** Same vector the cosine CTE ranks against. */
  queryVec: number[];
  domain: string | undefined;
  documentIds: readonly string[] | undefined;
  topK: number;
}

interface RawHybridRow {
  id: string;
  content: string;
  /** Cosine distance from the dense CTE, NULL when only lexical matched. */
  distance: number | null;
  chunk_index: number | null;
  chunk_source: unknown;
  source_document_id: string | null;
  domain: string | null;
  rrf_score: number;
  dense_rank: number | null;
  lexical_rank: number | null;
}

/**
 * Fused-rank retrieval: cosine + lexical, merged with Reciprocal
 * Rank Fusion (`k = 60`) in a single CTE query. Returns rows
 * already ordered by `rrf_score DESC`.
 *
 * The candidate pool per side is widened to `RRF_CANDIDATE_K` so
 * fusion has enough rows to combine — the original RRF paper notes
 * the merge benefits from a candidate pool 2-4× the final topK.
 *
 * Domain + document filters compose into both CTEs via the same
 * `Prisma.sql` fragment, so the two sides stay consistent.
 */
const RRF_K = 60;
const RRF_CANDIDATE_K = 50;

async function runHybridQuery(
  db: PrismaClient,
  args: HybridQueryArgs,
): Promise<ChunkResult[]> {
  const { assessmentId, query, queryVec, domain, documentIds, topK } = args;
  const vectorLiteral = vectorToPgLiteral(queryVec);

  // Shared filter fragment — applied identically inside each CTE so
  // both sides see the same scope. The cosine side additionally
  // requires `embedding IS NOT NULL`; lexical requires `search_vec
  // @@ q` (composed inline because the tsquery itself is the FROM
  // clause's expression).
  const baseFilters: Prisma.Sql[] = [
    Prisma.sql`assessment_id = ${assessmentId}`,
  ];
  if (domain !== undefined) {
    baseFilters.push(
      Prisma.sql`(domain = ${domain} OR domain = 'ingested')`,
    );
  }
  if (documentIds !== undefined && documentIds.length > 0) {
    baseFilters.push(
      Prisma.sql`document_id IN (${Prisma.join(documentIds.map((id) => id))})`,
    );
  }
  const baseWhere = Prisma.join(baseFilters, " AND ");
  const candidateK = Math.max(topK, RRF_CANDIDATE_K);

  const rows = await db.$queryRaw<RawHybridRow[]>`
    WITH dense AS (
      SELECT
        id,
        RANK() OVER (ORDER BY embedding <=> ${vectorLiteral}::vector) AS rnk,
        embedding <=> ${vectorLiteral}::vector AS distance
      FROM evidences
      WHERE ${baseWhere}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${candidateK}
    ),
    lex AS (
      SELECT
        e.id,
        RANK() OVER (
          ORDER BY ts_rank(e.search_vec, q) DESC
        ) AS rnk
      FROM evidences e, plainto_tsquery('english', ${query}) AS q
      WHERE ${baseWhere}
        AND e.search_vec @@ q
      ORDER BY ts_rank(e.search_vec, q) DESC
      LIMIT ${candidateK}
    )
    SELECT
      e.id,
      e.content,
      d.distance,
      e.chunk_index,
      e.chunk_source,
      e.document_id AS source_document_id,
      e.domain,
      COALESCE(1.0 / (${RRF_K} + d.rnk), 0)
        + COALESCE(1.0 / (${RRF_K} + l.rnk), 0) AS rrf_score,
      d.rnk AS dense_rank,
      l.rnk AS lexical_rank
    FROM evidences e
    LEFT JOIN dense d ON d.id = e.id
    LEFT JOIN lex   l ON l.id = e.id
    WHERE d.id IS NOT NULL OR l.id IS NOT NULL
    ORDER BY rrf_score DESC
    LIMIT ${topK}
  `;

  return rows.map((r) => ({
    evidenceId: r.id,
    content: r.content,
    similarity:
      r.distance != null ? clamp01(1 - Number(r.distance)) : 0,
    chunkIndex: r.chunk_index,
    chunkSource: r.chunk_source,
    sourceDocumentId: r.source_document_id,
    domain: r.domain ?? undefined,
    rrfScore: Number(r.rrf_score),
    denseRank: r.dense_rank == null ? null : Number(r.dense_rank),
    lexicalRank: r.lexical_rank == null ? null : Number(r.lexical_rank),
  }));
}

// ─── Helpers ─────────────────────────────────────────────────────

function vectorToPgLiteral(vec: number[]): string {
  // pgvector accepts `'[a,b,c]'`. We format with fixed precision to keep
  // the literal compact; full float precision isn't needed for cosine.
  return `[${vec.map((n) => (Number.isFinite(n) ? n.toString() : "0")).join(",")}]`;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
