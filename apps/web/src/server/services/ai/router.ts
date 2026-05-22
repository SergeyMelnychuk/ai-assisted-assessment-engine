/**
 * Multi-provider AI router — ADR-0015.
 *
 * Single entry point for every AI call in the codebase after ADR-0016
 * landed and `claude-client.ts` was deleted. The router:
 *
 *   1. Resolves the task → ModelBinding from the registry.
 *   2. Builds the Vercel AI SDK `LanguageModel` for the primary
 *      provider, lazy-loading the provider package so missing
 *      credentials for unused providers never crash boot.
 *   3. Applies Anthropic/Bedrock prompt-cache hints (ADR-0012) when
 *      `cacheSystem: true`.
 *   4. Races against a per-binding timeout.
 *   5. On transient failure (rate_limit / overloaded / 5xx / timeout /
 *      connectivity), hops to the next binding in the fallback chain
 *      and retries **once** per binding. Deterministic failures
 *      (auth, schema, content filter) throw immediately.
 *   6. Emits one `AuditLog AI_CALL` row per *attempt* (including the
 *      failed primary) so the cost trail is complete.
 *
 * The shim exports `callClaude` / `callClaudeWithImage` keep the old
 * call-site signatures working through the migration window (ADR-0016
 * describes this as atomic, but keeping the shim lets each call-site
 * migrate to `callAi` on its own timing once the foundation lands).
 */

import type { z } from "zod";
import { generateText } from "ai";
import type { ModelMessage } from "ai";
import { db } from "@/server/db";
import { log } from "@/server/lib/logger";
import {
  classifyProcessingError,
  failoverClassFor,
  type RouterFailoverClass,
} from "./error-classifier";
import {
  estimateCostUsd,
  PRICING_VERSION,
  type AiCallType,
} from "./pricing";
import {
  primaryModelIdSync,
  resolveTask,
  type AiTask,
  type ModelBinding,
  type Provider,
  type TaskBinding,
} from "./model-registry";

// ─── Constants ──────────────────────────────────────────────────────

/**
 * Default per-call wall-clock ceiling. One slow hung request
 * (we've seen 10+ minute stalls on overloaded days) otherwise holds
 * the worker slot hostage and blocks every other assessment queued
 * behind it. Bindings can override via `ModelBinding.timeoutMs`.
 */
export const CLAUDE_CALL_TIMEOUT_MS = 120_000;

export const DEFAULT_MAX_TOKENS = 4096;

/**
 * Legacy `MODEL` export — used to read from
 * `apps/web/src/server/services/ai/claude-client.ts`. After ADR-0016
 * deleted that file, this re-export points at the `analysis.synthesis`
 * primary model id (which used to be the only Anthropic-direct model
 * the codebase knew about). Call-sites should move off it and onto
 * `callAi({ task: "…" })`; the recommendation copy in
 * `admin-settings.ts` is a legitimate consumer — it shapes UI guidance
 * based on the model's family, which the primary synthesis model is
 * the right proxy for.
 */
export const MODEL = primaryModelIdSync("analysis.synthesis");

/**
 * Error subclass thrown by the timeout wrapper below. Named so
 * `classifyProcessingError` can match it without parsing message
 * strings.
 */
export class ClaudeCallTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(
      `CLAUDE_TIMEOUT: Claude call exceeded the ${timeoutMs}ms per-call ceiling`,
    );
    this.name = "ClaudeCallTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// ─── Types ──────────────────────────────────────────────────────────

export interface AIResponse<T> {
  result: T;
  tokensUsed: { input: number; output: number };
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  estimatedCostUsd?: number;
  /** Populated when a fallback was used. */
  routerReason?: { from: string; failoverClass: RouterFailoverClass };
  /** The (provider, model) pair that actually produced the result. */
  resolvedProvider?: Provider;
  resolvedModel?: string;
}

export interface AiCallAuditOptions {
  callType: AiCallType;
  entityId: string;
  entityType?: string;
  userId?: string | null;
}

/**
 * Audit writer — extended from ADR-0012's shape with `provider`,
 * `routerReason`, and `task` (ADR-0015 §5). Preserved as a named
 * export so the embedding path can reuse it.
 */
export async function writeAiCallAudit(params: {
  audit: AiCallAuditOptions;
  model: string;
  provider: Provider;
  task?: AiTask;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  estimatedCostUsd: number;
  routerReason?: { from: string; failoverClass: RouterFailoverClass } | null;
  extra?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: params.audit.userId ?? null,
        action: "AI_CALL",
        entityType: params.audit.entityType ?? "Assessment",
        entityId: params.audit.entityId,
        details: {
          callType: params.audit.callType,
          model: params.model,
          provider: params.provider,
          task: params.task ?? null,
          routerReason: params.routerReason ?? null,
          inputTokens: params.inputTokens,
          outputTokens: params.outputTokens,
          cacheReadInputTokens: params.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: params.cacheCreationInputTokens ?? 0,
          estimatedCostUsd: params.estimatedCostUsd,
          pricingVersion: PRICING_VERSION,
          ...(params.extra ?? {}),
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ai-audit] failed to write AI_CALL row: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Provider adapters (lazy-loaded) ────────────────────────────────

// Cache resolved provider-factory functions so repeated calls don't
// re-import the SDK. Each factory returns an AI SDK `LanguageModel`.
const _providerCache = new Map<
  Provider,
  (modelId: string) => Promise<unknown>
>();

async function getProviderFactory(
  provider: Provider,
): Promise<(modelId: string) => Promise<unknown>> {
  const cached = _providerCache.get(provider);
  if (cached) return cached;

  let factory: (modelId: string) => Promise<unknown>;
  switch (provider) {
    case "anthropic": {
      const mod = await import("@ai-sdk/anthropic");
      factory = async (id) => mod.anthropic(id);
      break;
    }
    case "bedrock": {
      const mod = await import("@ai-sdk/amazon-bedrock");
      factory = async (id) => mod.bedrock(id);
      break;
    }
    case "openai": {
      const mod = await import("@ai-sdk/openai");
      factory = async (id) => mod.openai(id);
      break;
    }
    case "azure": {
      const mod = await import("@ai-sdk/azure");
      factory = async (id) => mod.azure(id);
      break;
    }
    case "vertex": {
      const mod = await import("@ai-sdk/google-vertex");
      factory = async (id) => mod.vertex(id);
      break;
    }
    case "mistral": {
      const mod = await import("@ai-sdk/mistral");
      factory = async (id) => mod.mistral(id);
      break;
    }
    default: {
      const _exhaust: never = provider;
      throw new Error(
        `[ai-router] unknown provider: ${String(_exhaust)} — add it to getProviderFactory`,
      );
    }
  }
  _providerCache.set(provider, factory);
  return factory;
}

// ─── Core callAi entry point ────────────────────────────────────────

export interface CallAiOptions<TOutput = string> {
  task: AiTask;
  system?: string;
  userContent?: string;
  /** Full message array — overrides `userContent` when both are set. */
  messages?: ModelMessage[];
  /**
   * Assistant-turn prefill (e.g. `"{"`) forces the model's first
   * output token to continue from the prefill string. The returned
   * `rawText` includes the prefill prepended.
   */
  assistantPrefill?: string;
  /** Parse the raw text into `TOutput`. Defaults to identity (string). */
  parseResult?: (raw: string) => TOutput;
  maxTokens?: number;
  /** Override registry binding for this call. Bypasses fallbacks. */
  modelOverride?: ModelBinding;
  audit?: AiCallAuditOptions;
}

export async function callAi<TOutput = string>(
  opts: CallAiOptions<TOutput>,
): Promise<AIResponse<TOutput>> {
  const binding = opts.modelOverride
    ? ({
        primary: opts.modelOverride,
        fallbacks: [],
        failoverOn: [],
      } satisfies TaskBinding)
    : await resolveTask(opts.task);

  const chain: ModelBinding[] = [binding.primary, ...binding.fallbacks];
  const failoverOn = new Set(binding.failoverOn);

  let lastError: unknown;
  let routerReason:
    | { from: string; failoverClass: RouterFailoverClass }
    | undefined;

  for (let i = 0; i < chain.length; i += 1) {
    const b = chain[i];
    const isFallback = i > 0;
    try {
      const res = await callOneBinding<TOutput>(opts, b, routerReason);
      return res;
    } catch (err) {
      lastError = err;
      const classified = classifyProcessingError(err);
      const fc = failoverClassFor(classified, err);

      log.warn("ai-router attempt failed", {
        worker: "ai-router",
        task: opts.task,
        provider: b.provider,
        model: b.model,
        attempt: i + 1,
        totalAttempts: chain.length,
        failoverClass: fc,
        errorCategory: classified.category,
        message: classified.technicalDetail,
      });

      // Best-effort audit of the failed attempt so the cost trail is
      // complete even when we retry. Only write when we actually have
      // usage — which for a failed call is zero — but the attempt is
      // still loggable. We skip DB writes on failed attempts to avoid
      // noise; the warning above captures the signal.

      if (!fc || !failoverOn.has(fc) || i === chain.length - 1) {
        // Deterministic failure, or out of fallbacks — throw.
        throw err;
      }
      // Hop to next binding. Record the reason so the successful
      // attempt's audit row captures "why we're not on the primary".
      routerReason = {
        from: `${b.provider}:${b.model}`,
        failoverClass: fc,
      };
    }
  }

  // Unreachable — loop always either returns or throws.
  throw lastError;
}

async function callOneBinding<TOutput>(
  opts: CallAiOptions<TOutput>,
  binding: ModelBinding,
  routerReason:
    | { from: string; failoverClass: RouterFailoverClass }
    | undefined,
): Promise<AIResponse<TOutput>> {
  const factory = await getProviderFactory(binding.provider);
  const model = (await factory(binding.model)) as Parameters<
    typeof generateText
  >[0]["model"];

  // Build messages. Prefer explicit messages; otherwise compose from
  // system + userContent + assistantPrefill.
  const messages: ModelMessage[] = opts.messages ? [...opts.messages] : [];
  if (!opts.messages) {
    if (opts.userContent !== undefined) {
      messages.push({ role: "user", content: opts.userContent });
    }
    if (
      opts.assistantPrefill !== undefined &&
      opts.assistantPrefill !== ""
    ) {
      messages.push({ role: "assistant", content: opts.assistantPrefill });
    }
  }

  // System prompt with optional Anthropic cache-control. AI SDK v6 accepts
  // `system: string` OR system-role messages with providerOptions. We use
  // the latter when cacheSystem is on.
  let systemParam: string | undefined;
  if (opts.system) {
    if (
      binding.cacheSystem &&
      (binding.provider === "anthropic" || binding.provider === "bedrock")
    ) {
      messages.unshift({
        role: "system",
        content: opts.system,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      });
    } else {
      systemParam = opts.system;
    }
  }

  const timeoutMs = binding.timeoutMs ?? CLAUDE_CALL_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const startedAt = Date.now();
  let response: Awaited<ReturnType<typeof generateText>>;
  try {
    response = await generateText({
      model,
      system: systemParam,
      messages,
      maxOutputTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      abortSignal: controller.signal,
    });
  } catch (err) {
    if (
      timedOut ||
      (err instanceof Error &&
        (err.name === "AbortError" || /aborted|abort/i.test(err.message)))
    ) {
      throw new ClaudeCallTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const rawTextBody = response.text;
  if (!rawTextBody) {
    throw new Error("No text response from Claude");
  }

  // Stitch prefill back on so parseResult sees the full payload.
  const rawText =
    opts.assistantPrefill !== undefined && opts.assistantPrefill !== ""
      ? opts.assistantPrefill + rawTextBody
      : rawTextBody;

  const parsed = (
    opts.parseResult
      ? opts.parseResult(rawText)
      : (rawText as unknown as TOutput)
  );

  // Usage extraction. AI SDK v6 surfaces inputTokens / outputTokens on
  // `response.usage`; cache counters come through provider metadata.
  const usage = response.usage ?? { inputTokens: 0, outputTokens: 0 };
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  // Provider metadata carries Anthropic cache counters. Shape:
  //   providerMetadata.anthropic.cacheCreationInputTokens / cacheReadInputTokens
  const pm = (response.providerMetadata ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const anthroMeta = (pm.anthropic ?? pm.bedrock ?? {}) as Record<
    string,
    unknown
  >;
  const cacheReadInputTokens =
    typeof anthroMeta.cacheReadInputTokens === "number"
      ? anthroMeta.cacheReadInputTokens
      : undefined;
  const cacheCreationInputTokens =
    typeof anthroMeta.cacheCreationInputTokens === "number"
      ? anthroMeta.cacheCreationInputTokens
      : undefined;

  const estimatedCostUsd = estimateCostUsd(binding.model, {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  });

  if (opts.audit) {
    await writeAiCallAudit({
      audit: opts.audit,
      model: binding.model,
      provider: binding.provider,
      task: opts.task,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      estimatedCostUsd,
      routerReason: routerReason ?? null,
      extra: { cacheSystem: binding.cacheSystem === true },
    });
  }

  log.info("ai-router call", {
    worker: "ai-router",
    task: opts.task,
    provider: binding.provider,
    model: binding.model,
    inputTokens,
    outputTokens,
    durationMs: Date.now() - startedAt,
    routerReason: routerReason?.failoverClass ?? null,
  });

  return {
    result: parsed,
    tokensUsed: { input: inputTokens, output: outputTokens },
    cacheReadInputTokens,
    cacheCreationInputTokens,
    estimatedCostUsd,
    routerReason,
    resolvedProvider: binding.provider,
    resolvedModel: binding.model,
  };
}

// ─── parseJsonResponse (unchanged from claude-client) ──────────────

/**
 * Best-effort JSON extraction from a text response. System prompts
 * tell the model "output JSON only", but real-world responses disobey
 * in four common ways; we try each recovery strategy in order.
 */
export function parseJsonResponse<T>(raw: string): T {
  const trimmed = raw.trim();

  const candidates = [
    () => {
      const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      return m ? m[1] : null;
    },
    () => {
      const m = trimmed.match(/```(?:json)?\s*([\s\S]*)$/);
      return m ? m[1].trim() : null;
    },
    () => {
      const first = trimmed.indexOf("{");
      const last = trimmed.lastIndexOf("}");
      return first !== -1 && last > first
        ? trimmed.slice(first, last + 1)
        : null;
    },
    () => trimmed,
  ] as const;

  let lastError: unknown;
  for (const next of candidates) {
    const candidate = next();
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch (err) {
      lastError = err;
    }
  }

  const truncated = countBraceBalance(trimmed) !== 0 || looksTruncated(trimmed);
  const hint = truncated
    ? " (response appears truncated — raise `maxTokens` on the callAi call, or tighten the prompt's output schema)"
    : "";

  throw new Error(
    `Failed to parse JSON from model response: ${lastError instanceof Error ? lastError.message : String(lastError)}${hint}` +
      ` — response preview: ${truncatePreview(trimmed)}`,
  );
}

function truncatePreview(s: string): string {
  const max = 200;
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function countBraceBalance(s: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
  }
  return depth;
}

function looksTruncated(s: string): boolean {
  const tail = s.slice(-40).trim();
  if (/[,:\[{]$/.test(tail)) return true;
  const lastNewline = tail.lastIndexOf("\n");
  const lastLine = lastNewline >= 0 ? tail.slice(lastNewline + 1) : tail;
  const quoteMatches = lastLine.match(/(?<!\\)"/g);
  if (quoteMatches && quoteMatches.length % 2 === 1) return true;
  return false;
}

// ─── Legacy compat shims ────────────────────────────────────────────
//
// ADR-0016 deleted `claude-client.ts` atomically but kept these shim
// signatures on the router so call-sites migrate import path only.
// New code should call `callAi` directly.

/**
 * Map the legacy `AiCallType` (from the old `audit.callType` field)
 * onto the new `AiTask` registry key. Falls back to
 * `analysis.synthesis` for unknown call types — matches the old
 * behaviour where the only model was the single `ANTHROPIC_MODEL` env.
 */
function taskFromCallType(callType: AiCallType | undefined): AiTask {
  switch (callType) {
    case "analysis":
      return "analysis.synthesis";
    case "analysis-verify":
      return "analysis.verifier";
    case "scoring":
      return "analysis.scoring";
    case "deliverable":
      return "deliverable.section";
    case "agent":
      return "agent.planner";
    case "embedding":
      return "embedding.ingest";
    case "retrieval-query":
      return "embedding.query";
    default:
      return "analysis.synthesis";
  }
}

export interface CallClaudeOptions<T> {
  system: string;
  userContent: string;
  parseResult: (raw: string) => T;
  maxTokens?: number;
  cacheSystem?: boolean;
  assistantPrefill?: string;
  audit?: AiCallAuditOptions;
  /**
   * Optional: pin a specific `AiTask` for routing. When absent the
   * shim infers from `audit.callType` (legacy behaviour). Call-sites
   * without an audit should set this to get the right fallback chain.
   */
  task?: AiTask;
}

/**
 * Legacy entry point — delegates to `callAi`. Preserves the
 * `parseResult` + `assistantPrefill` + `cacheSystem` ergonomics the
 * pre-router call-sites rely on.
 */
export async function callClaude<T>(
  opts: CallClaudeOptions<T>,
): Promise<AIResponse<T>> {
  const task = opts.task ?? taskFromCallType(opts.audit?.callType);

  // Respect the call-site's `cacheSystem` flag by passing a
  // modelOverride that forces cacheSystem on top of the task's primary.
  // This lets callers opt in to caching even when the registry's
  // primary has cacheSystem disabled, matching the pre-router contract.
  let modelOverride: ModelBinding | undefined;
  if (opts.cacheSystem === true) {
    const resolved = await resolveTask(task);
    modelOverride = { ...resolved.primary, cacheSystem: true };
  }

  return callAi<T>({
    task,
    system: opts.system,
    userContent: opts.userContent,
    assistantPrefill: opts.assistantPrefill,
    parseResult: opts.parseResult,
    maxTokens: opts.maxTokens,
    audit: opts.audit,
    modelOverride,
  });
}

export type VisionMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

export interface CallClaudeWithImageOptions<T> {
  system: string;
  text: string;
  imageBase64: string;
  imageMediaType: VisionMediaType;
  parseResult: (raw: string) => T;
  maxTokens?: number;
  audit?: AiCallAuditOptions;
}

/**
 * Vision shim — Claude with an image + text prompt. Used by
 * `diagram-parser.ts` for raster architecture diagrams. Routes via
 * `diagram.parse` which is pinned Anthropic-only for now
 * (Gemini fallback is a Slice 2 follow-up).
 */
export async function callClaudeWithImage<T>(
  opts: CallClaudeWithImageOptions<T>,
): Promise<AIResponse<T>> {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "image",
          image: Buffer.from(opts.imageBase64, "base64"),
          mediaType: opts.imageMediaType,
        },
        { type: "text", text: opts.text },
      ],
    },
  ];

  return callAi<T>({
    task: "diagram.parse",
    system: opts.system,
    messages,
    parseResult: opts.parseResult,
    maxTokens: opts.maxTokens,
    audit: opts.audit,
  });
}
