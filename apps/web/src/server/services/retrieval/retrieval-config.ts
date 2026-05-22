/**
 * Retrieval tuning constants — Phase 3 Week 8 (ADR-0012).
 *
 * Surfaces the magic numbers that used to live inline in the retrieval
 * and analysis code. Keeping them here means a tuning pass (see the
 * ADR's "Follow-ups" for the deferred hyperparameter sweep) is one PR
 * that touches one file instead of a hunt-and-replace across six.
 *
 * The current values are the ones we shipped before Week 8's sweep got
 * cut — they are reasonable defaults, not measured optima. The sweep
 * is listed as post-Phase-3 work in the retrospective.
 */

/**
 * Top-K for domain analysis retrieval. 20 is wide enough to give the
 * per-domain Claude prompt diverse evidence without blowing the
 * context window on a busy engagement (8 domains × 20 chunks × ~300
 * tokens ≈ 48K input tokens before the rubric).
 */
export const TOP_K_ANALYSIS = 20;

/**
 * Top-K for follow-up question generation. Tighter than analysis
 * because follow-ups only need enough context to spot *gaps* — not to
 * reason end-to-end. 10 chunks keeps the prompt small and cheap on a
 * path that runs after every answer edit.
 */
export const TOP_K_FOLLOWUP = 10;

/**
 * Cosine-similarity floor. Chunks below this score are dropped rather
 * than padding top-K with near-random noise. 0.3 is the "obviously
 * related, could still be wrong" band — empirical feel from Week 4
 * smoke runs; the sweep should re-measure.
 */
export const MIN_COSINE_SIMILARITY = 0.3;
