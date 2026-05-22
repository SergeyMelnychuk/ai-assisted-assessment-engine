import { createHash } from "node:crypto";
import { db } from "@/server/db";
import {
  estimateCostUsd,
  PRICING_VERSION,
  type AiCallType,
} from "./pricing";
import { resolveTask, type Provider } from "./model-registry";
import {
  classifyProcessingError,
  failoverClassFor,
  type RouterFailoverClass,
} from "./error-classifier";

/**
 * Embedding service for Phase 3 Week 3 (ADR-0003, ADR-0004).
 *
 * Wraps the OpenAI embeddings API with:
 *   - Batching — up to 2048 inputs per call (OpenAI's published ceiling).
 *   - Zero automatic retries — same discipline as `claude-client.ts`.
 *     Every retry re-bills tokens; we want every re-attempt to be a
 *     deliberate user action (the backfill script carves out a single
 *     rate-limit retry per batch, see ADR-0003).
 *   - A deterministic **fake mode** for CI and local tests. Enabled when
 *     either `EMBEDDING_MODE=fake` or `OPENAI_API_KEY` is unset. Vectors
 *     are derived from SHA-256 of the input so identical inputs yield
 *     identical vectors — exactly the property the backfill test relies
 *     on.
 *
 * Callers pass opaque strings and get back `number[][]` in the same
 * order. The service is free of Prisma / MinIO / Claude deps — the
 * tests can exercise it as a pure module.
 */

// 1536 is the native dimensionality of `text-embedding-3-small`. Kept
// as a constant so callers (Prisma migration, fake-mode expansion,
// tests) share one definition.
export const EMBEDDING_DIMENSIONS = 1536;

// OpenAI's batch ceiling for the embeddings endpoint. Hard-coded so the
// batching logic is reviewable without chasing SDK constants.
const MAX_INPUTS_PER_CALL = 2048;

export interface EmbedResult {
  vectors: number[][];
  model: string;
  inputTokens: number;
  estimatedCostUsd?: number;
}

/**
 * Audit options for cost instrumentation (ADR-0012). Caller-scoped so
 * ingest rows tie to a `Document` and retrieval-query rows tie to an
 * `Assessment`. Absent → no audit row (fake-mode tests, internal
 * helpers).
 */
export interface EmbeddingAuditOptions {
  callType: Extract<AiCallType, "embedding" | "retrieval-query">;
  entityId: string;
  entityType?: string;
  userId?: string | null;
}

export function getEmbeddingModel(): string {
  return process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
}

function isFakeMode(): boolean {
  if (process.env.EMBEDDING_MODE === "fake") return true;
  if (process.env.EMBEDDING_MODE === "live") return false;
  // Default: fall back to fake if there's no API key. Keeps CI + local
  // dev working without a funded account; opt-in to live is a matter of
  // setting the key.
  return !process.env.OPENAI_API_KEY;
}

/**
 * Embed a list of input strings. Returns an object keyed by `vectors`
 * (aligned with the input order), `model` (which model actually ran —
 * useful for audit), and `inputTokens` (sum across batches).
 *
 * ADR-0015 §3/§9: the ingest path has a Bedrock Titan v2 fallback
 * registered on the `embedding.ingest` task. If OpenAI throws a
 * transient class (rate_limit / 5xx / connectivity / overloaded) we
 * hop to Titan for the same batch. The query path has **no fallback**
 * — cache locality on retrieval beats failover, and swapping
 * embedding spaces mid-flight wrecks pgvector cosine scores.
 *
 * Dimensionality invariant: every vector written must be length
 * `EMBEDDING_DIMENSIONS` (1536). The embedding.ingest Titan fallback
 * uses `amazon.titan-embed-text-v2:0` which emits 1024 by default;
 * we assert 1536 on the response and throw `EMBEDDING_DIM_MISMATCH`
 * if we see anything else. Mixing dimensions across rows silently
 * corrupts the pgvector HNSW index.
 */
export async function embedTexts(
  inputs: string[],
  audit?: EmbeddingAuditOptions,
): Promise<EmbedResult> {
  const requestedModel = getEmbeddingModel();
  if (inputs.length === 0) {
    return { vectors: [], model: requestedModel, inputTokens: 0 };
  }

  if (isFakeMode()) {
    const fakeInputTokens = inputs.reduce(
      (acc, s) => acc + Math.ceil(s.length / 4),
      0,
    );
    const fakeCost = estimateCostUsd(requestedModel, {
      inputTokens: fakeInputTokens,
      outputTokens: 0,
    });
    if (audit) {
      await writeEmbeddingAudit({
        audit,
        model: `${requestedModel}+fake`,
        provider: "openai",
        inputTokens: fakeInputTokens,
        estimatedCostUsd: fakeCost,
      });
    }
    return {
      vectors: inputs.map(fakeVectorFor),
      model: `${requestedModel}+fake`,
      inputTokens: fakeInputTokens,
      estimatedCostUsd: fakeCost,
    };
  }

  // Route through the registry so admin overrides + Titan fallback
  // apply. `embedding.ingest` vs `embedding.query` differ in whether
  // fallbacks fire at all — see JSDoc on DEFAULT_REGISTRY in
  // model-registry.ts.
  const taskKey =
    audit?.callType === "retrieval-query"
      ? "embedding.query"
      : "embedding.ingest";
  const binding = await resolveTask(taskKey);
  const chain = [binding.primary, ...binding.fallbacks];
  const failoverOn = new Set(binding.failoverOn);

  let lastError: unknown;
  let routerReason:
    | { from: string; failoverClass: RouterFailoverClass }
    | undefined;

  for (let attempt = 0; attempt < chain.length; attempt += 1) {
    const b = chain[attempt];
    try {
      const res = await embedOneBinding(inputs, b.provider, b.model);
      assertEmbeddingDimensions(res.vectors, b.model);

      const estimatedCostUsd = estimateCostUsd(b.model, {
        inputTokens: res.inputTokens,
        outputTokens: 0,
      });
      if (audit) {
        await writeEmbeddingAudit({
          audit,
          model: b.model,
          provider: b.provider,
          inputTokens: res.inputTokens,
          estimatedCostUsd,
          routerReason: routerReason ?? null,
        });
      }
      return {
        vectors: res.vectors,
        model: b.model,
        inputTokens: res.inputTokens,
        estimatedCostUsd,
      };
    } catch (err) {
      lastError = err;
      const classified = classifyProcessingError(err);
      const fc = failoverClassFor(classified, err);
      if (!fc || !failoverOn.has(fc) || attempt === chain.length - 1) {
        throw err;
      }
      routerReason = {
        from: `${b.provider}:${b.model}`,
        failoverClass: fc,
      };
    }
  }

  throw lastError;
}

interface OneBindingResult {
  vectors: number[][];
  inputTokens: number;
}

async function embedOneBinding(
  inputs: string[],
  provider: Provider,
  model: string,
): Promise<OneBindingResult> {
  if (provider === "openai") {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 0,
    });
    const vectors: number[][] = [];
    let inputTokens = 0;
    for (let i = 0; i < inputs.length; i += MAX_INPUTS_PER_CALL) {
      const batch = inputs.slice(i, i + MAX_INPUTS_PER_CALL);
      const resp = await client.embeddings.create({ model, input: batch });
      for (const item of resp.data) vectors.push(item.embedding);
      inputTokens += resp.usage?.prompt_tokens ?? 0;
    }
    return { vectors, inputTokens };
  }

  if (provider === "bedrock") {
    // Titan v2 supports a `dimensions` parameter (256 / 512 / 1024).
    // We request 1024 explicitly — no, wait: our pgvector index is
    // 1536-dim. Titan v2 cannot match 1536; if the registry ever
    // points here as an actual fallback, the `assertEmbeddingDimensions`
    // guard will throw and the caller sees a classified
    // EMBEDDING_DIM_MISMATCH. This is deliberate — running a
    // mis-dimensioned backfill silently corrupts the index.
    //
    // A future Titan-compatible fallback requires a parallel 1024-dim
    // index (or a 1536-capable provider like Cohere embed-v3). Track
    // in ADR-0015 follow-ups.
    // Bedrock SDK is optional — not every deploy has AWS creds or the
    // package installed. We hide the module specifier behind an
    // indirection so Next.js's webpack build doesn't try to resolve it
    // at compile time (a plain `import("@aws-sdk/...")` trips
    // "Module not found" even inside a `.catch()`). The indirection
    // keeps the import purely runtime: if the package is absent the
    // catch returns null and the caller surfaces a clean error.
    const bedrockPkg = "@aws-sdk/client-bedrock-runtime";
    const dynamicImport = new Function(
      "spec",
      "return import(spec)",
    ) as (spec: string) => Promise<unknown>;
    const bedrockMod = (await dynamicImport(bedrockPkg).catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!bedrockMod) {
      throw new Error(
        "EMBEDDING_REQUEST_FAILED: @aws-sdk/client-bedrock-runtime is not installed. " +
          "Add it to apps/web/package.json to enable the Bedrock embedding fallback.",
      );
    }
    const { BedrockRuntimeClient, InvokeModelCommand } = bedrockMod as {
      BedrockRuntimeClient: new (opts: Record<string, unknown>) => {
        send: (cmd: unknown) => Promise<{ body: Uint8Array }>;
      };
      InvokeModelCommand: new (input: {
        modelId: string;
        body: string;
        contentType: string;
        accept: string;
      }) => unknown;
    };
    const client = new BedrockRuntimeClient({});
    const vectors: number[][] = [];
    let inputTokens = 0;
    for (const input of inputs) {
      const resp = await client.send(
        new InvokeModelCommand({
          modelId: model,
          body: JSON.stringify({ inputText: input, dimensions: 1024 }),
          contentType: "application/json",
          accept: "application/json",
        }),
      );
      const bodyText = new TextDecoder().decode(resp.body as Uint8Array);
      const parsed = JSON.parse(bodyText) as {
        embedding: number[];
        inputTextTokenCount?: number;
      };
      vectors.push(parsed.embedding);
      inputTokens += parsed.inputTextTokenCount ?? 0;
    }
    return { vectors, inputTokens };
  }

  throw new Error(
    `EMBEDDING_REQUEST_FAILED: provider ${provider} not supported for embeddings`,
  );
}

/**
 * Every embedding row written to pgvector must be exactly
 * `EMBEDDING_DIMENSIONS` floats long. Mixed dimensions silently
 * corrupt the HNSW index — cosine scores become meaningless. This
 * guard throws `EMBEDDING_DIM_MISMATCH` before any row write.
 */
function assertEmbeddingDimensions(
  vectors: number[][],
  model: string,
): void {
  for (let i = 0; i < vectors.length; i += 1) {
    const v = vectors[i];
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `EMBEDDING_DIM_MISMATCH: model "${model}" returned vector[${i}] of length ` +
          `${Array.isArray(v) ? v.length : typeof v}, expected ${EMBEDDING_DIMENSIONS}. ` +
          `Writing would corrupt the pgvector index (ADR-0015 §3 dimensionality invariant).`,
      );
    }
  }
}

/**
 * Best-effort audit-log writer for embedding calls (ADR-0012). Mirrors
 * `writeAiCallAudit` in `claude-client.ts` but scoped to embedding
 * call-types so the `/admin/cost` rollup can separate ingest costs from
 * analysis costs. Swallows errors — never breaks the foreground call.
 */
async function writeEmbeddingAudit(params: {
  audit: EmbeddingAuditOptions;
  model: string;
  provider: Provider;
  inputTokens: number;
  estimatedCostUsd: number;
  routerReason?: {
    from: string;
    failoverClass: RouterFailoverClass;
  } | null;
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: params.audit.userId ?? null,
        action: "AI_CALL",
        entityType: params.audit.entityType ?? "Document",
        entityId: params.audit.entityId,
        details: {
          callType: params.audit.callType,
          task:
            params.audit.callType === "retrieval-query"
              ? "embedding.query"
              : "embedding.ingest",
          provider: params.provider,
          model: params.model,
          inputTokens: params.inputTokens,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          estimatedCostUsd: params.estimatedCostUsd,
          pricingVersion: PRICING_VERSION,
          routerReason: params.routerReason ?? null,
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ai-audit] failed to write embedding AI_CALL row: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Legacy alias used by `rag-retriever.ts`. Returns vectors only —
 * matches the shape that the test mock for `./ai/embedding-service`
 * stubs. Kept as a thin wrapper so the audit path in `embedTexts`
 * still fires on the retrieval-query path when callers upgrade.
 */
export async function embed(
  inputs: string[],
  audit?: EmbeddingAuditOptions,
): Promise<number[][]> {
  const res = await embedTexts(inputs, audit);
  return res.vectors;
}

/**
 * Content hash for change detection on re-ingest. Same definition the
 * chunker uses; re-exported here so the ingest job can compute hashes
 * without pulling in the chunker module.
 */
export function computeContentSha(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

/**
 * Deterministic pseudo-vector derived from SHA-256 of the input.
 * Expands 32 hash bytes into 1536 floats in [-1, 1] by rehashing with
 * a counter. Not cryptographically meaningful — just stable and
 * reproducible across processes, OSes, Node versions.
 */
export function fakeVectorFor(text: string): number[] {
  const out = new Array<number>(EMBEDDING_DIMENSIONS);
  // Each SHA-256 digest gives 32 bytes = 8 floats (4 bytes each when
  // interpreted as a uint32). We need 1536 floats → 192 such digests,
  // chained by counter suffix.
  const bytesPerRound = 32;
  const floatsPerRound = bytesPerRound / 4; // 8
  const rounds = Math.ceil(EMBEDDING_DIMENSIONS / floatsPerRound);
  let cursor = 0;
  for (let r = 0; r < rounds; r += 1) {
    const digest = createHash("sha256")
      .update(`${text}::${r}`)
      .digest();
    for (let j = 0; j < floatsPerRound && cursor < EMBEDDING_DIMENSIONS; j += 1) {
      const u32 = digest.readUInt32BE(j * 4);
      // Map to [-1, 1]. 2^32 − 1 = 4294967295.
      out[cursor] = (u32 / 0xffffffff) * 2 - 1;
      cursor += 1;
    }
  }
  return out;
}
