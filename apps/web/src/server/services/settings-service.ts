import type { PrismaClient } from "@prisma/client";

/**
 * Runtime settings — thin wrapper around the `Setting` key/value table.
 *
 * Purpose: let operators tune knobs (concurrency caps, pacing) without a
 * redeploy. The table is intentionally schemaless (Json `valueJson`) so a
 * single service handles every key — the engine code owns the shape/clamp
 * and supplies a default for when the row is missing.
 *
 * In-process cache: the analysis engine now resolves its concurrency
 * knob on *every* per-domain dispatch (so an admin's change takes effect
 * mid-run for the *next* run without a worker restart). Without a cache
 * that's one DB round-trip per domain per assessment — 8× amplification
 * on an assessment with 8 active domains. A 10-second TTL is long enough
 * to absorb a whole assessment's fan-out and short enough that "click
 * Save → trigger run" feels interactive. Cache is per-process — a Next.js
 * worker + web server each keep their own copy, which is fine for the
 * use case: both converge within 10 s of a write, and `setSetting`
 * invalidates the *local* cache immediately so the mutation's own RPC
 * response reflects the new value.
 */

const CACHE_TTL_MS = 10_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

// Module-global cache. Reset in tests via `__resetSettingsCacheForTests`.
// Keyed on setting key; stores the raw JSON value (the typed wrapper
// `getSetting<T>` casts on read).
const cache = new Map<string, CacheEntry>();

/**
 * Read a setting, falling back to `defaultValue` when the row is absent,
 * the cached copy is stale past the TTL, or the DB read throws. A throw
 * here is deliberate — we never let a settings-table outage wedge the
 * engine; worst case the caller runs on the compiled-in default.
 */
export async function getSetting<T>(
  db: Pick<PrismaClient, "setting">,
  key: string,
  defaultValue: T,
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }
  try {
    const row = await db.setting.findUnique({ where: { key } });
    const value = (row?.valueJson ?? defaultValue) as T;
    cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  } catch {
    // Swallow — stale cache beats a thrown RPC path. The caller already
    // supplied a compiled-in fallback; use it rather than propagate.
    return defaultValue;
  }
}

/**
 * Upsert a setting and invalidate the local cache entry so subsequent
 * reads in the same process reflect the new value immediately — other
 * processes catch up within `CACHE_TTL_MS`. `updatedBy` is the acting
 * admin's user id for the audit trail; it's nullable because some system
 * seeders might call this without a user context.
 */
export async function setSetting<T>(
  db: Pick<PrismaClient, "setting">,
  key: string,
  value: T,
  updatedBy: string | null,
): Promise<void> {
  await db.setting.upsert({
    where: { key },
    create: { key, valueJson: value as never, updatedBy: updatedBy ?? undefined },
    update: { valueJson: value as never, updatedBy: updatedBy ?? undefined },
  });
  // Invalidate rather than re-populate — the next read will hit the DB
  // and see the canonical post-upsert row (including the refreshed
  // `updatedAt`) without us having to synthesize it here.
  cache.delete(key);
}

/** Test-only: clear the module-level cache between cases so a test
 *  doesn't bleed a stubbed value into its neighbors. */
export function __resetSettingsCacheForTests(): void {
  cache.clear();
}

// ─── Known setting keys ─────────────────────────────────────────
//
// Centralised so routes, UI, and the engine can't drift on spelling.
// Defaults live next to each call-site (engine module constants) —
// this map is purely the naming contract.
export const SETTING_KEYS = {
  /** Per-domain Claude concurrency for `runAnalysis`. Integer 1..8. */
  analysisDomainConcurrency: "analysis.domainConcurrency",
  /** Inter-call pacing delay, ms. Integer 0..30000. */
  analysisInterCallDelayMs: "analysis.interCallDelayMs",
  /**
   * Platform-wide gate for the Phase 4 agent harness (ADR-0017).
   * DB-only (no env layer) so toggling takes effect on the next
   * tRPC call with no redeploy. Value is `boolean`; missing row is
   * treated as `false` (off on fresh deploys).
   */
  featureAgentEnabled: "features.agentEnabled",
  /**
   * Auto-classify document chunks into the assessment's active
   * domains at ingest time (Option B). Off by default — every chunk
   * lands in the catch-all bucket the analysis engine already
   * reads. When on, the ingest worker calls
   * `ingest.domain_classifier` after embedding and updates each
   * chunk's `domain` column. Best-effort: a classifier failure
   * leaves the chunk in the catch-all.
   */
  featureAutoClassifyChunks: "features.autoClassifyChunks",
  /**
   * Sub-flag of the agent feature: when ON (default), the
   * AgentFlowDiagram trace viewer renders alongside agent runs. Turn
   * OFF to hide the trace UI without disabling the harness itself —
   * useful when reviewers find the diagram noisy. Missing row → ON
   * (preserves the existing v1 behaviour for installs that pre-date
   * the flag).
   */
  featureAgentFlowVisible: "features.agentFlowVisible",
  /**
   * ADR-0027: hybrid retrieval. When ON, the RAG retriever fuses
   * pgvector cosine with Postgres-native lexical search (`tsvector`
   * + `ts_rank`) via Reciprocal Rank Fusion in a single CTE query.
   * Default OFF; flip per workspace at
   * `/admin/settings?tab=ai-router`. No cost to running with it off
   * — the cosine path is unchanged.
   */
  featureHybridRetrieval: "features.hybridRetrieval",
} as const;
