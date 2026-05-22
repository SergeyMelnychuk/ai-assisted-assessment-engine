"use client";

import { trpc } from "./trpc";

/**
 * Client-side read of the server's feature-flag surface.
 *
 * Wraps `trpc.features.list.useQuery()` with sensible defaults:
 * - `staleTime: Infinity` — flags don't change mid-session; one fetch
 *   per mount is enough and avoids refetch churn on every focus.
 * - `placeholderData` with everything off — so components can render
 *   their "flag off" branch without a loading flash while the first
 *   query resolves.
 *
 * Usage:
 *   const { agentEnabled } = useFeatureFlags();
 *   if (!agentEnabled) return null;
 *
 * Server components should call `isAgentEnabled()` directly from
 * `@/server/services/agent/feature-flag` — no round-trip needed.
 */
export function useFeatureFlags(): {
  agentEnabled: boolean;
  /**
   * Sub-flag: when off, the `AgentFlowDiagram` trace viewer hides
   * even when `agentEnabled` is on. Default true so existing deploys
   * keep showing the diagram unless an admin explicitly hides it.
   */
  agentFlowVisible: boolean;
  /**
   * ADR-0027 hybrid retrieval. Default off — when on, the RAG
   * retriever fuses pgvector cosine with Postgres-native lexical
   * search via Reciprocal Rank Fusion. Read by the Evidence
   * Explorer's empty-state hint copy.
   */
  hybridRetrieval: boolean;
} {
  const placeholder = {
    agentEnabled: false,
    agentFlowVisible: true,
    hybridRetrieval: false,
  };
  const { data } = trpc.features.list.useQuery(undefined, {
    staleTime: Infinity,
    placeholderData: placeholder,
  });
  return data ?? placeholder;
}
