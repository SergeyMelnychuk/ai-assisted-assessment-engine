import { createRouter, publicProcedure } from "../trpc";
import {
  isAgentEnabled,
  isAgentFlowVisible,
  isHybridRetrievalEnabled,
} from "@/server/services/agent/feature-flag";

/**
 * Public feature-flag surface for the client.
 *
 * Flags live in the `Setting` table (server-only) and are handed to
 * the client via tRPC so React components can gate UI without a
 * server round-trip per render.
 *
 * Keep the payload shape flat + additive — the client caches it for the
 * session and a nested shape complicates invalidation. Add new flags as
 * new boolean fields here, default them to `false`, and they light up
 * automatically wherever `trpc.features.list.useQuery()` is bound.
 *
 * Intentionally `publicProcedure`: the flags themselves carry no
 * secret, and the gated UI (e.g. an AGENTIC option in assessment
 * creation) is already behind `protectedProcedure` on the mutation
 * side. Gating this query would just prevent the login form from
 * deciding whether to render a "Try the agent" CTA.
 */
export const featuresRouter = createRouter({
  list: publicProcedure.query(async ({ ctx }) => {
    const [agentEnabled, agentFlowVisible, hybridRetrieval] =
      await Promise.all([
        isAgentEnabled(ctx.db),
        isAgentFlowVisible(ctx.db),
        isHybridRetrievalEnabled(ctx.db),
      ]);
    return { agentEnabled, agentFlowVisible, hybridRetrieval };
  }),
});
