import { describe, expect, it } from "vitest";
import { estimateCostUsd, PRICING, PRICING_VERSION } from "./pricing";

/**
 * Pricing calculator tests — Phase 3 Week 8 (ADR-0012).
 *
 * The cost math is dead simple but load-bearing: every row in
 * /admin/cost and every assertion in smoke-cost.sh depends on these
 * numbers being right. These tests pin the formula against a couple
 * of explicit token-count fixtures so a well-meaning refactor can't
 * silently change the bill.
 */

describe("estimateCostUsd", () => {
  it("computes claude-sonnet-4-5 cost from input + output tokens", () => {
    // 1000 in, 500 out on the current Sonnet 4.5 list price:
    //   1 × $0.003  +  0.5 × $0.015  =  $0.003 + $0.0075 = $0.0105
    const cost = estimateCostUsd("claude-sonnet-4-5", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it("applies cache read/write rates when cache counters are present", () => {
    // Scenario: 400 uncached input, 1000 cache-read, 200 cache-write,
    // 300 output. Matches the second-call shape of a cached per-domain
    // analysis (system prompt served from cache).
    //
    //   input  : 0.4  × $0.003    = $0.00120
    //   output : 0.3  × $0.015    = $0.00450
    //   read   : 1.0  × $0.0003   = $0.00030
    //   write  : 0.2  × $0.00375  = $0.00075
    //   total                      = $0.00675
    const cost = estimateCostUsd("claude-sonnet-4-5", {
      inputTokens: 400,
      outputTokens: 300,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 200,
    });
    expect(cost).toBeCloseTo(0.00675, 6);
  });

  it("computes text-embedding-3-small cost from input tokens only", () => {
    // Embedding models have outputPer1K = 0 — any output count is
    // ignored. Proves the output term doesn't accidentally contribute.
    const cost = estimateCostUsd("text-embedding-3-small", {
      inputTokens: 100_000,
      outputTokens: 999_999, // deliberately absurd — should be ignored
    });
    // 100 × $0.00002 = $0.002
    expect(cost).toBeCloseTo(0.002, 6);
  });

  it("returns 0 for unknown models without throwing", () => {
    // Critical property: unknown models must not break the AI call.
    // The audit path swallows the row but the foreground API call
    // continues. This test also documents that pricing is additive —
    // adding a new SKU is a one-liner in PRICING.
    const cost = estimateCostUsd("made-up-model-id", {
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(cost).toBe(0);
  });

  it("treats negative tokens as zero so bad fixtures can't produce negative cost", () => {
    const cost = estimateCostUsd("claude-sonnet-4-5", {
      inputTokens: -500,
      outputTokens: -500,
    });
    expect(cost).toBe(0);
  });

  it("exposes a pinned pricing version", () => {
    // Version string feeds `AuditLog.details.pricingVersion`. Bump it
    // whenever the table moves so historical rows stay recostable.
    expect(PRICING_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICING["claude-sonnet-4-5"]).toBeDefined();
    expect(PRICING["text-embedding-3-small"]).toBeDefined();
  });
});
