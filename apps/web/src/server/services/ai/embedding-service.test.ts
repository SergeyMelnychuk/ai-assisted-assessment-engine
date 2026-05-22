import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the Week 3 embedding service (ADR-0003). Covers
// batching, empty-input short-circuit, fake-mode determinism, and the
// error surface we classify in `error-classifier.ts`.

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  // Keep live calls from ever happening by default; individual tests
  // opt back into live mode by setting a key + mocking the SDK.
  delete process.env.OPENAI_API_KEY;
  delete process.env.EMBEDDING_MODE;
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function load() {
  return await import("./embedding-service");
}

describe("embedTexts — fake mode", () => {
  it("returns an empty result without touching the SDK when input is empty", async () => {
    const { embedTexts } = await load();
    const result = await embedTexts([]);
    expect(result.vectors).toEqual([]);
    expect(result.inputTokens).toBe(0);
    expect(result.model).toContain("text-embedding-3-small");
  });

  it("derives deterministic 1536-dim vectors from SHA-256", async () => {
    const { embedTexts, EMBEDDING_DIMENSIONS, fakeVectorFor } = await load();
    const result = await embedTexts(["hello", "hello", "world"]);
    expect(result.vectors).toHaveLength(3);
    for (const v of result.vectors) {
      expect(v).toHaveLength(EMBEDDING_DIMENSIONS);
      for (const component of v) {
        expect(component).toBeGreaterThanOrEqual(-1);
        expect(component).toBeLessThanOrEqual(1);
      }
    }
    // Same input → same vector.
    expect(result.vectors[0]).toEqual(result.vectors[1]);
    // Different input → different vector.
    expect(result.vectors[0]).not.toEqual(result.vectors[2]);
    // Direct helper matches.
    expect(fakeVectorFor("hello")).toEqual(result.vectors[0]);
    // Reports inputTokens > 0 so the audit trail looks plausible.
    expect(result.inputTokens).toBeGreaterThan(0);
    // Model label carries the "+fake" suffix.
    expect(result.model).toMatch(/\+fake$/);
  });

  it("honours `EMBEDDING_MODE=fake` even when an API key is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.EMBEDDING_MODE = "fake";
    const { embedTexts } = await load();
    const result = await embedTexts(["a"]);
    expect(result.model).toMatch(/\+fake$/);
  });
});

describe("embedTexts — live mode batching + errors", () => {
  it("splits 3000 inputs into 2 API calls of <=2048 each", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.EMBEDDING_MODE = "live";

    const createSpy = vi.fn(async ({ input }: { input: string[] }) => ({
      data: input.map(() => ({ embedding: new Array(1536).fill(0) })),
      usage: { prompt_tokens: input.length },
    }));
    vi.doMock("openai", () => ({
      default: class {
        embeddings = { create: createSpy };
      },
    }));

    const { embedTexts } = await load();
    const inputs = Array.from({ length: 3000 }, (_, i) => `x${i}`);
    const result = await embedTexts(inputs);

    expect(result.vectors).toHaveLength(3000);
    // 3000 / 2048 → 2 calls (2048 + 952).
    expect(createSpy).toHaveBeenCalledTimes(2);
    const firstCall = createSpy.mock.calls[0][0];
    const secondCall = createSpy.mock.calls[1][0];
    expect(firstCall.input).toHaveLength(2048);
    expect(secondCall.input).toHaveLength(952);
  });

  it("surfaces a 401 as a classifiable EMBEDDING_AUTH_FAILED error", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.EMBEDDING_MODE = "live";

    vi.doMock("openai", () => ({
      default: class {
        embeddings = {
          create: vi.fn(async () => {
            throw new Error("OpenAI 401 Incorrect API key provided");
          }),
        };
      },
    }));

    const { embedTexts } = await load();
    const { classifyProcessingError } = await import("./error-classifier");

    let caught: unknown;
    try {
      await embedTexts(["alpha"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const classified = classifyProcessingError(caught);
    expect(classified.category).toBe("EMBEDDING_AUTH_FAILED");
    expect(classified.needsAdmin).toBe(true);
  });
});
