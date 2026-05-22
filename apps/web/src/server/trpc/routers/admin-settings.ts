import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import {
  getSetting,
  setSetting,
  SETTING_KEYS,
} from "@/server/services/settings-service";
import {
  DOMAIN_ANALYSIS_CONCURRENCY,
  DOMAIN_ANALYSIS_INTER_CALL_DELAY_MS,
} from "@/server/services/analysis-engine";
import { MODEL } from "@/server/services/ai/router";
import {
  isAgentEnabled,
  isAgentFlowVisible,
  isHybridRetrievalEnabled,
} from "@/server/services/agent/feature-flag";

/**
 * Admin-only router for the `/admin/settings` Settings tab.
 *
 * Surface is narrow on purpose — this router exposes exactly the
 * runtime-editable knobs the UI renders, not the full `Setting` table.
 * Adding a new knob is a three-step change (engine resolver + a row in
 * the SETTINGS_CATALOGUE below + a UI field) so we can't accidentally
 * expose an internal key via `get`.
 *
 * Auth pattern matches `admin-logs.ts`: the /admin layout already
 * role-gates server-side; we belt-and-braces here so a direct tRPC
 * mutation from a non-admin surfaces a NOT_FOUND rather than a 200.
 */

function assertAdmin(role: string): void {
  if (role !== "ADMIN") {
    // Intentionally NOT_FOUND — "FORBIDDEN" would leak that the
    // endpoint exists to anyone who probes the router by guessing names.
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

// ─── Recommendations ─────────────────────────────────────────────
//
// Recommendation copy is generated from the configured Anthropic model
// id — see `claude-client.ts` `MODEL`. Anthropic's ITPM ceiling differs
// by org tier, but at the per-assessment fan-out scale ours hits the
// small-tier (30k input-tokens-per-minute) bucket first. When / if we
// upgrade the org tier, add a `TIER` env and refine this logic.
//
// The frontend renders these verbatim — keep the copy actionable
// ("raise tier" vs just "don't"). See ADR-0002 for rationale.

interface Recommendation {
  concurrency: number;
  interCallDelayMs: number;
  rationale: string;
}

function recommendationsFor(modelId: string): Recommendation {
  // Sonnet 4.5 on small tier: one in-flight call saturates ITPM given a
  // 5–15k-token evidence prompt. Raising concurrency risks 429s.
  if (modelId.includes("sonnet")) {
    return {
      concurrency: 1,
      interCallDelayMs: 0,
      rationale:
        "Sonnet 4.5 on Anthropic's small tier (30k ITPM): concurrency=1 recommended. " +
        "Per-domain analysis prompts are 5–15k input tokens — two in flight blows the " +
        "bucket and surfaces as 429 rate_limit_error. Upgrade the org tier before " +
        "raising concurrency. Inter-call delay can stay at 0 at concurrency=1 because " +
        "each call's 30–60 s round-trip already paces the stream.",
    };
  }
  // Haiku is ~3× cheaper per token and ~2× faster — small tier can
  // sustain concurrency=2 comfortably, but we still cap the recommendation
  // conservatively because the engine's prompt budget is the same.
  if (modelId.includes("haiku")) {
    return {
      concurrency: 2,
      interCallDelayMs: 0,
      rationale:
        "Haiku 4.5 on small tier: concurrency=2 is safe — prompts are the same size " +
        "but round-trips are ~2× faster so ITPM stays under the 30k/min ceiling. Raise " +
        "to 3+ only after confirming no 429s in the logs over a full assessment run.",
    };
  }
  // Opus is slower and costlier — back off to sequential regardless of tier.
  if (modelId.includes("opus")) {
    return {
      concurrency: 1,
      interCallDelayMs: 2_000,
      rationale:
        "Opus: sequential dispatch recommended. Opus latency (90–180 s per domain) " +
        "combined with higher per-token cost makes concurrency > 1 a liability — a 429 " +
        "retry re-bills the full prompt. The 2 s inter-call delay damps burst spikes.",
    };
  }
  // Unknown model — play it safe with the strictest recommendation.
  return {
    concurrency: 1,
    interCallDelayMs: 0,
    rationale:
      "Unknown model id — defaulting to conservative recommendation. Review the " +
      "rate-limit posture of the configured model before changing.",
  };
}

// ─── Settings catalogue ──────────────────────────────────────────
//
// Shape of the payload the Settings tab renders. The catalogue pattern
// keeps defaults / clamps / descriptions co-located with the key so
// the UI can render a generic form; no per-key React glue required.
const CONCURRENCY_RANGE = { min: 1, max: 8 } as const;
const DELAY_RANGE_MS = { min: 0, max: 30_000 } as const;

function clampInt(n: unknown, min: number, max: number): number | null {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return null;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

const updateInput = z.discriminatedUnion("key", [
  z.object({
    key: z.literal(SETTING_KEYS.analysisDomainConcurrency),
    value: z
      .number()
      .int()
      .min(CONCURRENCY_RANGE.min)
      .max(CONCURRENCY_RANGE.max),
  }),
  z.object({
    key: z.literal(SETTING_KEYS.analysisInterCallDelayMs),
    value: z
      .number()
      .int()
      .min(DELAY_RANGE_MS.min)
      .max(DELAY_RANGE_MS.max),
  }),
]);

export const adminSettingsRouter = createRouter({
  get: protectedProcedure.query(async ({ ctx }) => {
    assertAdmin(ctx.session.user.role);

    // Read both knobs in parallel — settings-service's 10 s cache
    // usually makes the second read a hit, but parallelism keeps the
    // cold path tight too.
    const [concurrency, delayMs] = await Promise.all([
      getSetting<number>(
        ctx.db,
        SETTING_KEYS.analysisDomainConcurrency,
        DOMAIN_ANALYSIS_CONCURRENCY,
      ),
      getSetting<number>(
        ctx.db,
        SETTING_KEYS.analysisInterCallDelayMs,
        DOMAIN_ANALYSIS_INTER_CALL_DELAY_MS,
      ),
    ]);

    const recommendation = recommendationsFor(MODEL);

    return {
      model: { id: MODEL },
      recommendation,
      settings: {
        [SETTING_KEYS.analysisDomainConcurrency]: {
          key: SETTING_KEYS.analysisDomainConcurrency,
          label: "Per-domain analysis concurrency",
          description:
            "How many per-domain analysis calls run in parallel per assessment. " +
            "Applies across all providers — a call that fails over (Anthropic → " +
            "Bedrock → OpenAI) still occupies one slot. Raising this cuts wall " +
            "time but risks upstream 429 rate-limit errors on whichever provider " +
            "currently serves analysis.synthesis.",
          value:
            clampInt(concurrency, CONCURRENCY_RANGE.min, CONCURRENCY_RANGE.max) ??
            DOMAIN_ANALYSIS_CONCURRENCY,
          default: DOMAIN_ANALYSIS_CONCURRENCY,
          min: CONCURRENCY_RANGE.min,
          max: CONCURRENCY_RANGE.max,
          recommended: recommendation.concurrency,
        },
        [SETTING_KEYS.analysisInterCallDelayMs]: {
          key: SETTING_KEYS.analysisInterCallDelayMs,
          label: "Inter-call delay (ms)",
          description:
            "Pause inserted between consecutive per-domain analysis calls (any " +
            "provider). Useful at concurrency > 1 to damp token-bucket spikes; " +
            "at concurrency = 1 it adds pure idle time.",
          value:
            clampInt(delayMs, DELAY_RANGE_MS.min, DELAY_RANGE_MS.max) ??
            DOMAIN_ANALYSIS_INTER_CALL_DELAY_MS,
          default: DOMAIN_ANALYSIS_INTER_CALL_DELAY_MS,
          min: DELAY_RANGE_MS.min,
          max: DELAY_RANGE_MS.max,
          recommended: recommendation.interCallDelayMs,
        },
      },
    };
  }),

  update: protectedProcedure
    .input(updateInput)
    .mutation(async ({ ctx, input }) => {
      assertAdmin(ctx.session.user.role);
      // Zod already clamped to the valid range; the service layer
      // stores the value verbatim and the engine re-clamps on read as
      // a belt-and-braces against manual DB edits.
      await setSetting(ctx.db, input.key, input.value, ctx.session.user.id);
      return { ok: true };
    }),

  /**
   * Feature-flag read. Returns the current DB-backed state of every
   * flag the UI renders. Stays a single query even with one flag so
   * adding the next flag is one field, not another route.
   */
  getFeatureFlags: protectedProcedure.query(async ({ ctx }) => {
    assertAdmin(ctx.session.user.role);
    const [
      agentEnabled,
      autoClassifyChunks,
      agentFlowVisible,
      hybridRetrieval,
    ] = await Promise.all([
      isAgentEnabled(ctx.db),
      getSetting<boolean | null>(
        ctx.db,
        SETTING_KEYS.featureAutoClassifyChunks,
        null,
      ).then((v) => v === true),
      isAgentFlowVisible(ctx.db),
      isHybridRetrievalEnabled(ctx.db),
    ]);
    return {
      agentEnabled,
      autoClassifyChunks,
      agentFlowVisible,
      hybridRetrieval,
    };
  }),

  /**
   * Feature-flag write. Plain boolean — flags are DB-only, so there
   * is no "clear override" path. Off and on are the only states.
   */
  setFeatureFlag: protectedProcedure
    .input(
      z.object({
        key: z.union([
          z.literal(SETTING_KEYS.featureAgentEnabled),
          z.literal(SETTING_KEYS.featureAutoClassifyChunks),
          z.literal(SETTING_KEYS.featureAgentFlowVisible),
          z.literal(SETTING_KEYS.featureHybridRetrieval),
        ]),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertAdmin(ctx.session.user.role);
      await setSetting(
        ctx.db,
        input.key,
        input.enabled,
        ctx.session.user.id,
      );
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "FEATURE_FLAG_SET",
          entityType: "Setting",
          entityId: input.key,
          details: { key: input.key, enabled: input.enabled },
        },
      });
      return { ok: true };
    }),
});
