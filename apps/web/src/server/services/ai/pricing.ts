/**
 * AI pricing table — Phase 3 Week 8 (ADR-0012), extended for multi-
 * provider routing (ADR-0015 §6).
 *
 * Centralises per-1K-token prices for every model the router can
 * dispatch to. The `/admin/cost` rollup and the router's
 * `estimatedCostUsd` audit field both key off this table.
 *
 * Keying: **model id only**. Same-model-different-provider (e.g.
 * `claude-sonnet-4-7` via Anthropic-direct vs AWS Bedrock) uses the
 * same list price today; commit-burn discounts on Bedrock land as a
 * `bedrockDiscount` multiplier rather than a full split of the table
 * (keeps backward-compat with existing `AuditLog.details.model` readers
 * that don't know about providers). See ADR-0015 §6.
 *
 * Update procedure when a provider reprices:
 *   1. Adjust the table below.
 *   2. Bump `PRICING_VERSION` so historical audit rows can be re-
 *      costed with the price list current when the call was made
 *      (we store `pricingVersion` alongside the cost).
 *   3. Note the change in ADR-0012's References section.
 */

export const PRICING_VERSION = "2026-04-21";

/** Known callers of the AI. Drives grouping in the cost dashboard.
 *
 * `analysis-verify` is the optional second Claude pass that filters a
 * domain's candidate findings/risks/recs/assumptions down to the
 * evidence-backed subset (ADR-0013).
 *
 * ADR-0015 §5 adds a `task` dimension to AuditLog.details; `callType`
 * stays for backward-compat with existing cost dashboards. New
 * call-sites pass `task` (stable registry key); legacy shims continue
 * passing `callType`. */
export type AiCallType =
  | "analysis"
  | "analysis-verify"
  | "embedding"
  | "scoring"
  | "deliverable"
  | "retrieval-query"
  // Per-chunk domain classification at ingest time. Same cost
  // bucket as ingest embedding for rollups, but distinct so
  // operators can see classifier spend independently.
  | "ingest"
  // ADR-0015: agent-harness calls surface as their own callType so
  // the cost dashboard can split "assessment AI" from "agent AI" spend.
  | "agent";

export interface ModelPrice {
  /** USD per 1,000 input tokens. */
  inputPer1K: number;
  /** USD per 1,000 output tokens. Embedding models charge only for input. */
  outputPer1K: number;
  /**
   * Optional — per-1K cost to *write* to the prompt cache. Anthropic
   * charges a premium on first write (typically 1.25× input rate).
   */
  cacheWritePer1K?: number;
  /**
   * Optional — per-1K cost to *read* from the prompt cache. Anthropic
   * discounts to ~0.1× input rate.
   */
  cacheReadPer1K?: number;
}

/**
 * Price catalogue. Keyed by the exact model id the SDK sees. Rolling
 * aliases, dated snapshots, and Bedrock model IDs all map here — same
 * prices apply since AWS list-price-matches Anthropic on Claude.
 *
 * List prices (Apr 2026):
 *   - Claude Sonnet 4.5 / 4.7: $3 / $15 per MTok
 *   - Claude Haiku 4.5: $1 / $5 per MTok
 *   - Claude Opus 4.5: $15 / $75 per MTok
 *   - GPT-5: $2.5 / $10 per MTok (placeholder — confirm at launch)
 *   - GPT-5-mini: $0.15 / $0.6 per MTok (placeholder)
 *   - Gemini 2.5 Pro: $1.25 / $5 per MTok
 *   - Mistral Large: $2 / $6 per MTok
 *   - Mistral Small: $0.2 / $0.6 per MTok
 *   - text-embedding-3-small: $0.02 per MTok
 *   - amazon.titan-embed-text-v2: $0.02 per MTok
 */
export const PRICING: Record<string, ModelPrice> = {
  // ── Anthropic / Bedrock — Sonnet family ─────────────────────────
  "claude-sonnet-4-7": {
    inputPer1K: 0.003,
    outputPer1K: 0.015,
    cacheWritePer1K: 0.00375,
    cacheReadPer1K: 0.0003,
  },
  "claude-sonnet-4-5": {
    inputPer1K: 0.003,
    outputPer1K: 0.015,
    cacheWritePer1K: 0.00375,
    cacheReadPer1K: 0.0003,
  },
  "claude-sonnet-4-5-20250929": {
    inputPer1K: 0.003,
    outputPer1K: 0.015,
    cacheWritePer1K: 0.00375,
    cacheReadPer1K: 0.0003,
  },
  // Bedrock model IDs resolve to the same price. Duplicating rather
  // than doing string manipulation at lookup time keeps the cost path
  // branch-free and the table greppable.
  "anthropic.claude-sonnet-4-7": {
    inputPer1K: 0.003,
    outputPer1K: 0.015,
    cacheWritePer1K: 0.00375,
    cacheReadPer1K: 0.0003,
  },
  "anthropic.claude-sonnet-4-5": {
    inputPer1K: 0.003,
    outputPer1K: 0.015,
    cacheWritePer1K: 0.00375,
    cacheReadPer1K: 0.0003,
  },

  // ── Anthropic / Bedrock — Haiku family ──────────────────────────
  "claude-haiku-4-5": {
    inputPer1K: 0.001,
    outputPer1K: 0.005,
    cacheWritePer1K: 0.00125,
    cacheReadPer1K: 0.0001,
  },
  "anthropic.claude-haiku-4-5": {
    inputPer1K: 0.001,
    outputPer1K: 0.005,
    cacheWritePer1K: 0.00125,
    cacheReadPer1K: 0.0001,
  },

  // ── Anthropic / Bedrock — Opus family ───────────────────────────
  "claude-opus-4-5": {
    inputPer1K: 0.015,
    outputPer1K: 0.075,
    cacheWritePer1K: 0.01875,
    cacheReadPer1K: 0.0015,
  },

  // ── OpenAI — GPT-5 family (placeholder list prices) ─────────────
  "gpt-5": { inputPer1K: 0.0025, outputPer1K: 0.01 },
  "gpt-5-mini": { inputPer1K: 0.00015, outputPer1K: 0.0006 },

  // ── Google Vertex — Gemini 2.5 ─────────────────────────────────
  "gemini-2.5-pro": { inputPer1K: 0.00125, outputPer1K: 0.005 },
  "gemini-2.5-flash": { inputPer1K: 0.0003, outputPer1K: 0.0012 },

  // ── Mistral ────────────────────────────────────────────────────
  "mistral-large-latest": { inputPer1K: 0.002, outputPer1K: 0.006 },
  "mistral-small-latest": { inputPer1K: 0.0002, outputPer1K: 0.0006 },

  // ── Embeddings ─────────────────────────────────────────────────
  "text-embedding-3-small": { inputPer1K: 0.00002, outputPer1K: 0 },
  "text-embedding-3-large": { inputPer1K: 0.00013, outputPer1K: 0 },
  "amazon.titan-embed-text-v2:0": { inputPer1K: 0.00002, outputPer1K: 0 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt-cache reads (usage.cache_read_input_tokens). */
  cacheReadInputTokens?: number;
  /** Anthropic prompt-cache writes (usage.cache_creation_input_tokens). */
  cacheCreationInputTokens?: number;
}

/**
 * Compute the USD cost for a single AI call given the model id and
 * token usage. Unknown models return `0` and log a warning once per
 * process — we'd rather under-report than crash the audit path.
 *
 * Cache tokens, when present, are priced at their cache-specific
 * rates and added on top of the base `inputTokens` cost. Anthropic's
 * `usage.input_tokens` already excludes cache reads/writes, so no
 * double-counting.
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const price = PRICING[model];
  if (!price) {
    warnOnceUnknownModel(model);
    return 0;
  }
  const input = Math.max(0, usage.inputTokens) / 1000;
  const output = Math.max(0, usage.outputTokens) / 1000;
  const cacheRead = Math.max(0, usage.cacheReadInputTokens ?? 0) / 1000;
  const cacheWrite = Math.max(0, usage.cacheCreationInputTokens ?? 0) / 1000;

  const base = input * price.inputPer1K + output * price.outputPer1K;
  const cacheCost =
    cacheRead * (price.cacheReadPer1K ?? price.inputPer1K) +
    cacheWrite * (price.cacheWritePer1K ?? price.inputPer1K);
  return round6(base + cacheCost);
}

const _warnedUnknownModels = new Set<string>();
function warnOnceUnknownModel(model: string): void {
  if (_warnedUnknownModels.has(model)) return;
  _warnedUnknownModels.add(model);
  // eslint-disable-next-line no-console
  console.warn(
    `[pricing] unknown model "${model}" — estimateCostUsd returning 0. ` +
      `Add it to apps/web/src/server/services/ai/pricing.ts.`,
  );
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
