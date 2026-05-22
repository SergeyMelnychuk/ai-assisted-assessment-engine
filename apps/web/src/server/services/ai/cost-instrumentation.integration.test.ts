/**
 * Cost instrumentation integration test — ADR-0012 + ADR-0015.
 *
 * Verifies that the AuditLog `AI_CALL` rows emitted by a mini analysis
 * run sum to within ±10% of the expected cost computed from
 * `pricing.ts` × the fixed token counts × the number of per-domain
 * calls.
 *
 * Shape:
 *   1. Mock Prisma: capture every `AuditLog.create`.
 *   2. Mock the Vercel AI SDK's `generateText` so every invocation
 *      returns a fixed `{inputTokens: 1500, outputTokens: 500}` usage
 *      block. (The router is what we're testing; we stub one level
 *      deeper.)
 *   3. Mock the `@ai-sdk/anthropic` provider so the router doesn't
 *      need real credentials.
 *   4. Drive `callClaude` twice with `audit: { callType: 'analysis' }`
 *      — simulating an assessment with 2 active domains.
 *   5. Sum `details.estimatedCostUsd` across captured audit rows.
 *   6. Compute expected cost from `estimateCostUsd(MODEL, usage) × 2`
 *      and assert |sum - expected| / expected < 0.10.
 *
 * Also spot-checks the ADR-0015 audit extension: `provider` and
 * `task` are non-null on each row.
 */

import { describe, expect, it, vi } from "vitest";
import { estimateCostUsd, PRICING } from "./pricing";

// Capture every AuditLog.create payload.
const capturedAuditRows: Array<{
  action: string;
  entityId: string;
  details: Record<string, unknown>;
}> = [];

vi.mock("@/server/db", () => ({
  db: {
    auditLog: {
      create: vi.fn(async ({ data }: { data: any }) => {
        capturedAuditRows.push({
          action: data.action,
          entityId: data.entityId,
          details: data.details,
        });
        return { id: `audit-${capturedAuditRows.length}` };
      }),
    },
    aiModelOverride: {
      findMany: vi.fn(async () => []),
    },
  },
}));

const FIXED_INPUT_TOKENS = 1500;
const FIXED_OUTPUT_TOKENS = 500;

// Stub the AI SDK's generateText to return a deterministic response.
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn(async () => ({
      text: '{"ok":true}',
      usage: {
        inputTokens: FIXED_INPUT_TOKENS,
        outputTokens: FIXED_OUTPUT_TOKENS,
      },
      providerMetadata: {},
    })),
  };
});

// Stub the Anthropic provider factory so the router doesn't need creds.
vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: vi.fn(() => ({ modelId: "claude-sonnet-4-7-stub" })),
}));

describe("cost instrumentation ±10% integration", () => {
  it("audit log cost sum matches pricing × token counts × 2 calls within ±10%", async () => {
    capturedAuditRows.length = 0;

    const { callClaude, MODEL } = await import("./router");

    expect(PRICING[MODEL]).toBeDefined();

    for (const domain of ["security", "architecture"]) {
      await callClaude({
        system: "sys",
        userContent: `analyse ${domain}`,
        parseResult: (raw) => JSON.parse(raw) as { ok: boolean },
        audit: {
          callType: "analysis",
          entityId: "asmt-cost-test",
          entityType: "Assessment",
        },
      });
    }

    const aiCallRows = capturedAuditRows.filter((r) => r.action === "AI_CALL");
    expect(aiCallRows).toHaveLength(2);

    // ADR-0015 fields on every row.
    for (const row of aiCallRows) {
      expect(row.details.provider).toBe("anthropic");
      expect(row.details.task).toBe("analysis.synthesis");
      expect(row.details.routerReason).toBeNull();
    }

    const sumRecorded = aiCallRows.reduce((acc, r) => {
      const cost = (r.details as { estimatedCostUsd?: number })
        .estimatedCostUsd;
      return acc + (typeof cost === "number" ? cost : 0);
    }, 0);

    const expectedPerCall = estimateCostUsd(MODEL, {
      inputTokens: FIXED_INPUT_TOKENS,
      outputTokens: FIXED_OUTPUT_TOKENS,
    });
    const expectedTotal = expectedPerCall * 2;

    expect(expectedTotal).toBeGreaterThan(0);
    const drift = Math.abs(sumRecorded - expectedTotal) / expectedTotal;
    expect(drift).toBeLessThan(0.1);
  });
});
