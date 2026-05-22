/**
 * Timeout-wrapper test — verifies `callAi` surfaces a
 * `ClaudeCallTimeoutError` (and that the classifier routes it to the
 * retryable `AI_TIMEOUT` bucket) when the provider hangs past
 * `CLAUDE_CALL_TIMEOUT_MS`. Uses `vi.useFakeTimers` so the test
 * completes in ms rather than real-time 120 s.
 *
 * Ported from `claude-client.timeout.test.ts` (ADR-0016 deleted the
 * old client); the SUT moved to the router but the contract
 * (ClaudeCallTimeoutError → AI_TIMEOUT → retryable) is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({
  db: {
    auditLog: { create: vi.fn(async () => ({ id: "noop" })) },
    aiModelOverride: { findMany: vi.fn(async () => []) },
  },
}));

// Stub the AI SDK's generateText to honour the AbortSignal: hang
// forever unless the signal fires, then reject with AbortError.
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn(
      (opts: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = opts?.abortSignal;
          if (signal) {
            if (signal.aborted) {
              const e = new Error("Request aborted.");
              e.name = "AbortError";
              reject(e);
              return;
            }
            signal.addEventListener("abort", () => {
              const e = new Error("Request aborted.");
              e.name = "AbortError";
              reject(e);
            });
          }
        }),
    ),
  };
});

vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: vi.fn(() => ({ modelId: "claude-sonnet-4-7-stub" })),
}));

// Force a single binding (no fallbacks) with a tiny timeoutMs so we
// can use real timers and finish in ms rather than mocking the clock.
// The 120 s default is still asserted as a separate constant check.
const TEST_TIMEOUT_MS = 50;
vi.mock("./model-registry", async () => {
  const actual =
    await vi.importActual<typeof import("./model-registry")>("./model-registry");
  return {
    ...actual,
    resolveTask: vi.fn(async () => ({
      primary: {
        provider: "anthropic",
        model: "claude-sonnet-4-7",
        timeoutMs: TEST_TIMEOUT_MS,
      },
      fallbacks: [],
      failoverOn: [],
    })),
  };
});

describe("router per-call timeout", () => {
  it("throws ClaudeCallTimeoutError when the provider hangs past the ceiling", async () => {
    const { callClaude, CLAUDE_CALL_TIMEOUT_MS, ClaudeCallTimeoutError } =
      await import("./router");

    // 120 s constant stays stable — changing it is an operational
    // decision that should show up in PR review.
    expect(CLAUDE_CALL_TIMEOUT_MS).toBe(120_000);

    const err = await callClaude({
      system: "sys",
      userContent: "hang",
      parseResult: (raw) => JSON.parse(raw) as unknown,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClaudeCallTimeoutError);
    expect((err as Error).name).toBe("ClaudeCallTimeoutError");
    expect((err as Error).message).toMatch(/CLAUDE_TIMEOUT/);
  });

  it("classifyProcessingError routes the timeout to retryable AI_TIMEOUT", async () => {
    const { ClaudeCallTimeoutError, CLAUDE_CALL_TIMEOUT_MS } = await import(
      "./router"
    );
    const { classifyProcessingError } = await import("./error-classifier");

    const classified = classifyProcessingError(
      new ClaudeCallTimeoutError(CLAUDE_CALL_TIMEOUT_MS),
    );
    expect(classified.category).toBe("AI_TIMEOUT");
    expect(classified.isRetryable).toBe(true);
    expect(classified.needsAdmin).toBe(false);
    expect(classified.label).toMatch(/timed out/i);
  });
});
