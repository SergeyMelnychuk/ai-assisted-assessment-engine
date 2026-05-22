/**
 * Router unit tests — ADR-0015 §4.
 *
 * Covers three contracts:
 *   1. Fallback hop on transient failure — when the primary binding
 *      throws a rate-limit (429), the router hops to the next binding
 *      and the successful attempt's response carries the routerReason.
 *   2. Deterministic-error short-circuit — an auth error (401) on the
 *      primary must throw immediately without trying the fallback;
 *      fallback won't fix missing credentials and we refuse to waste
 *      tokens on a second attempt.
 *   3. Audit shape — the AuditLog row emitted for a successful call
 *      includes `provider`, `task`, and the resolved model id plus the
 *      router's extended ADR-0015 fields.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured: Array<{
  action: string;
  entityId: string;
  details: Record<string, unknown>;
}> = [];

vi.mock("@/server/db", () => ({
  db: {
    auditLog: {
      create: vi.fn(async ({ data }: { data: any }) => {
        captured.push({
          action: data.action,
          entityId: data.entityId,
          details: data.details,
        });
        return { id: `audit-${captured.length}` };
      }),
    },
    aiModelOverride: { findMany: vi.fn(async () => []) },
  },
}));

// Programmable generateText mock — tests push handlers onto a queue.
type GenHandler = (opts: unknown) => Promise<unknown> | unknown;
const genQueue: GenHandler[] = [];

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn(async (opts: unknown) => {
      const handler = genQueue.shift();
      if (!handler) {
        throw new Error(
          "generateText called but no handler queued — test setup incomplete",
        );
      }
      return handler(opts);
    }),
  };
});

vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: vi.fn((id: string) => ({ modelId: id, _provider: "anthropic" })),
}));
vi.mock("@ai-sdk/amazon-bedrock", () => ({
  bedrock: vi.fn((id: string) => ({ modelId: id, _provider: "bedrock" })),
}));
vi.mock("@ai-sdk/openai", () => ({
  openai: vi.fn((id: string) => ({ modelId: id, _provider: "openai" })),
}));

function ok(text: string, inputTokens = 100, outputTokens = 20) {
  return {
    text,
    usage: { inputTokens, outputTokens },
    providerMetadata: {},
  };
}

function rateLimitError() {
  const e = new Error("rate_limit_error: 429 Too Many Requests") as Error & {
    status?: number;
  };
  e.status = 429;
  return e;
}

function authError() {
  const e = new Error("authentication_error: 401 Unauthorized") as Error & {
    status?: number;
  };
  e.status = 401;
  return e;
}

describe("router fallback + audit behaviour", () => {
  beforeEach(() => {
    captured.length = 0;
    genQueue.length = 0;
  });

  afterEach(() => {
    expect(genQueue.length).toBe(0); // every queued handler must have been used
  });

  it("hops to the fallback on a transient rate_limit and tags the routerReason", async () => {
    // Primary rejects with 429; the openai fallback succeeds.
    genQueue.push(() => {
      throw rateLimitError();
    });
    genQueue.push(() => ok('{"answer":"from-fallback"}'));

    const { callAi } = await import("./router");

    const res = await callAi<{ answer: string }>({
      task: "analysis.synthesis",
      system: "sys",
      userContent: "analyse",
      parseResult: (raw) => JSON.parse(raw) as { answer: string },
      audit: {
        callType: "analysis",
        entityId: "asmt-1",
        entityType: "Assessment",
      },
    });

    expect(res.result.answer).toBe("from-fallback");
    expect(res.routerReason?.failoverClass).toBe("rate_limit");
    // Primary for analysis.synthesis is Anthropic; first fallback is Bedrock.
    expect(res.routerReason?.from).toBe("anthropic:claude-sonnet-4-7");
    expect(res.resolvedProvider).toBe("bedrock");

    // Exactly one audit row — the successful attempt. Failed attempts
    // warn to the log but don't emit AI_CALL rows (avoids noise).
    const aiCalls = captured.filter((c) => c.action === "AI_CALL");
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0].details.provider).toBe("bedrock");
    expect(aiCalls[0].details.task).toBe("analysis.synthesis");
    expect(aiCalls[0].details.model).toBe("anthropic.claude-sonnet-4-7");
    expect(aiCalls[0].details.routerReason).toMatchObject({
      from: "anthropic:claude-sonnet-4-7",
      failoverClass: "rate_limit",
    });
  });

  it("short-circuits on a deterministic auth error — does NOT try the fallback", async () => {
    // Only a single handler queued; a second `generateText` call would
    // throw "no handler queued" and also fail the afterEach assertion.
    genQueue.push(() => {
      throw authError();
    });

    const { callAi } = await import("./router");

    const err = await callAi({
      task: "analysis.synthesis",
      system: "sys",
      userContent: "hi",
      audit: {
        callType: "analysis",
        entityId: "asmt-2",
        entityType: "Assessment",
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/401|auth/i);

    // No AI_CALL row — the only attempt failed.
    const aiCalls = captured.filter((c) => c.action === "AI_CALL");
    expect(aiCalls).toHaveLength(0);
  });

  it("emits a complete audit row with provider/task/routerReason=null on a clean primary success", async () => {
    genQueue.push(() => ok('{"k":1}', 500, 100));

    const { callAi } = await import("./router");

    const res = await callAi<{ k: number }>({
      task: "analysis.scoring",
      system: "s",
      userContent: "score",
      parseResult: (raw) => JSON.parse(raw) as { k: number },
      audit: {
        callType: "scoring",
        entityId: "asmt-3",
        entityType: "Assessment",
      },
    });

    expect(res.result.k).toBe(1);
    expect(res.routerReason).toBeUndefined();

    const aiCalls = captured.filter((c) => c.action === "AI_CALL");
    expect(aiCalls).toHaveLength(1);
    const row = aiCalls[0];
    expect(row.details).toMatchObject({
      callType: "scoring",
      task: "analysis.scoring",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 500,
      outputTokens: 100,
      routerReason: null,
    });
    expect(typeof row.details.estimatedCostUsd).toBe("number");
    expect(row.details.pricingVersion).toBeTruthy();
  });
});
