/**
 * Evidence clusterer (Phase 3 Week 7, ADR-0011).
 *
 * A retrieval pass over a real engagement turns up near-duplicate
 * chunks all the time — the same paragraph quoted in three docs, the
 * same README copy-pasted into a wiki, the same policy echoed across
 * archive members. Showing them as N separate rows in the Evidence
 * Explorer / "Why this finding?" panel buries the genuinely distinct
 * signal. This module does a small greedy cosine-threshold cluster pass
 * so the UI can collapse duplicates into a single "representative +
 * member count" row.
 *
 * Pure function. No Prisma / IO / embedding calls — callers feed in
 * already-retrieved chunks (with their embeddings attached) and we
 * cluster in O(N²) which is fine for the N ≤ a few hundred topK regime.
 * If the retriever ever returns thousands of chunks per query we'll
 * swap this for an ANN-backed bucketing pass; for now N² is cheaper
 * than the code to justify anything else.
 */

/**
 * Default cosine similarity threshold for near-duplicate clustering.
 * Exported so the unit tests can verify the exact boundary and so the
 * router layer can pass a matching value explicitly when it wants to.
 *
 * 0.95 is the number the roadmap pinned: tight enough that we don't
 * merge genuinely different policies sharing terminology, loose enough
 * that a paragraph quoted across two docs lands in one cluster.
 */
export const DEFAULT_DUPLICATE_COSINE = 0.95;

export interface RankedChunk {
  evidenceId: string;
  content: string;
  /** Unit-length recommended but not required — we normalise per-pair. */
  embedding: number[];
  /** Similarity to the original retrieval query, in [0, 1]. */
  similarity: number;
  /**
   * Opaque source marker — e.g. the source document id, or a repo link
   * id. Used to count how many distinct sources the cluster spans so
   * the UI can say "from 3 sources" rather than "from 3 chunks".
   */
  source?: string;
  /**
   * Hybrid-retrieval rank carry-throughs (ADR-0027). Present only
   * when the chunk came back via the hybrid path; the cosine-only
   * path leaves both unset. The cluster's representative keeps these
   * so the citation can render the `matched: semantic/lexical/both`
   * chip (ADR-0028).
   */
  denseRank?: number | null;
  lexicalRank?: number | null;
}

export interface ClusteredChunk {
  /** Evidence id of the cluster's representative (first-seen chunk). */
  representativeId: string;
  /** Evidence ids of every chunk in the cluster, representative first. */
  memberIds: string[];
  /** The representative chunk itself — kept so the UI doesn't re-lookup. */
  representative: RankedChunk;
  /** Total member count including the representative. */
  duplicateCount: number;
  /** Distinct `source` values seen in the cluster (including missing). */
  sources: string[];
}

export interface ClusterOptions {
  /**
   * Minimum cosine similarity (inclusive) for two chunks to end up in
   * the same cluster. Defaults to {@link DEFAULT_DUPLICATE_COSINE}.
   * Values outside [0, 1] are clamped — NaN is treated as the default.
   */
  threshold?: number;
}

/**
 * Greedy cluster pass. The input is assumed sorted by descending
 * similarity (that's what `retrieve()` returns); we walk it in order
 * and assign each chunk to the first existing cluster whose
 * representative is ≥ threshold similar. Ties go to the earlier
 * cluster — this preserves the retriever's own ranking, which is the
 * property the roadmap asked for ("first chunk = highest similarity
 * becomes the representative").
 */
export function clusterChunks(
  chunks: RankedChunk[],
  options: ClusterOptions = {},
): ClusteredChunk[] {
  const threshold = normalizeThreshold(options.threshold);
  const clusters: ClusteredChunk[] = [];

  for (const chunk of chunks) {
    let merged = false;
    for (const cluster of clusters) {
      const sim = cosineSimilarity(cluster.representative.embedding, chunk.embedding);
      if (sim >= threshold) {
        cluster.memberIds.push(chunk.evidenceId);
        cluster.duplicateCount += 1;
        const src = chunk.source;
        if (src !== undefined && !cluster.sources.includes(src)) {
          cluster.sources.push(src);
        }
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({
        representativeId: chunk.evidenceId,
        memberIds: [chunk.evidenceId],
        representative: chunk,
        duplicateCount: 1,
        sources: chunk.source !== undefined ? [chunk.source] : [],
      });
    }
  }

  return clusters;
}

// ─── Helpers ─────────────────────────────────────────────────────

function normalizeThreshold(raw: number | undefined): number {
  if (raw === undefined || Number.isNaN(raw)) return DEFAULT_DUPLICATE_COSINE;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

/**
 * Cosine similarity on two equal-length vectors. Returns 0 on a length
 * mismatch or a zero-norm vector rather than throwing — the clusterer
 * is pure and the caller is downstream of a best-effort retriever, so
 * a defensive 0 (= "don't merge") is the safe default.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
