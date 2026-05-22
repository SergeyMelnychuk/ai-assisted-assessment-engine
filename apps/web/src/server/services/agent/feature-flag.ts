import type { PrismaClient } from "@prisma/client";
import { getSetting, SETTING_KEYS } from "@/server/services/settings-service";

/**
 * Gate for Phase 4 agent harness (ADR-0014, ADR-0017).
 *
 * **Storage: DB only.** The flag lives in `Setting("features.agentEnabled")`
 * as a nullable boolean (`null` = never set → treated as off). An admin
 * toggles it from `/admin/settings?tab=ai-router` and it takes effect
 * on the next tRPC call — no redeploy. We deliberately do *not* layer
 * an env var on top: toggling via env would require a restart to apply
 * and would fight the DB row silently.
 *
 * **Server vs client reads.** This module is server-only — Prisma types
 * never ship to the client bundle. Client components read the same
 * flag via `trpc.features.list` (wrapped in `useFeatureFlags()`).
 * Both seams call `isAgentEnabled(db)` so there is exactly one source
 * of truth.
 *
 * When off, agent tRPC routes return NOT_FOUND and nav entries are
 * hidden. No persistence or queue changes — the flag only affects
 * surface visibility.
 */

/**
 * Read the effective agent-enabled state from the DB.
 *
 * Returns `false` when the setting row is absent (i.e. the flag has
 * never been toggled on an install) so a fresh deploy is safely off
 * by default. Settings-service caches the read for ~10 s per process,
 * keeping the flag cheap to check on the hot path.
 */
export async function isAgentEnabled(
  db: Pick<PrismaClient, "setting">,
): Promise<boolean> {
  const stored = await getSetting<boolean | null>(
    db,
    SETTING_KEYS.featureAgentEnabled,
    null,
  );
  return stored === true;
}

/**
 * Sub-flag for the agent **trace viewer** (the `AgentFlowDiagram`
 * card on the assessment runs panel). Distinct from `isAgentEnabled`:
 * the harness can keep producing runs while the UI hides their
 * trajectory. Defaults to ON when the row is missing so existing
 * deploys keep the v1 behaviour.
 *
 * Only meaningful when `features.agentEnabled` is also on — when the
 * agent feature is off, the trace viewer is hidden regardless.
 */
export async function isAgentFlowVisible(
  db: Pick<PrismaClient, "setting">,
): Promise<boolean> {
  const stored = await getSetting<boolean | null>(
    db,
    SETTING_KEYS.featureAgentFlowVisible,
    null,
  );
  // Missing row = ON (back-compat). Explicit false = OFF.
  return stored !== false;
}

/**
 * ADR-0027 hybrid retrieval gate. Default OFF — the cosine path
 * stays canonical until an admin opts in.
 */
export async function isHybridRetrievalEnabled(
  db: Pick<PrismaClient, "setting">,
): Promise<boolean> {
  const stored = await getSetting<boolean | null>(
    db,
    SETTING_KEYS.featureHybridRetrieval,
    null,
  );
  return stored === true;
}
