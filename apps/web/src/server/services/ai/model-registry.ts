/**
 * Task-keyed model registry — ADR-0015 §3.
 *
 * Every AI call-site identifies itself by a stable `AiTask` key. The
 * registry maps task → primary `ModelBinding` + ordered fallback chain
 * + which error classes trigger a failover hop. The router
 * (`router.ts`) reads this registry at call time and emits one
 * `AuditLog AI_CALL` row per attempt.
 *
 * Overrides layer on top in this order (later wins):
 *   1. `DEFAULT_REGISTRY` — the table in this file.
 *   2. `process.env.ANTHROPIC_MODEL` — legacy single-model knob from
 *      the pre-router era. When set, overrides **every** Anthropic /
 *      Bedrock binding's `model` so operators can pin a specific
 *      Claude snapshot without editing code. Unchanged from ADR-0012.
 *   3. `AiModelOverride` DB rows — admin-settable runtime overrides
 *      (ADR-0015 §7). Loaded lazily by `loadOverrides()` and cached in
 *      process; the admin UI invalidates the cache after a write.
 *
 * Model IDs follow the ADR verbatim (`claude-sonnet-4-7`, `gpt-5`,
 * `gpt-5-mini`). If a provider 404s the ID, the router's
 * `AI_MODEL` error class blocks further fallback (the deterministic
 * class — fallback only helps for transient classes). Operators then
 * use an `AiModelOverride` or env to pin to a known-good snapshot
 * without redeploying.
 */

export type Provider =
  | "anthropic"
  | "bedrock"
  | "openai"
  | "azure"
  | "vertex"
  | "mistral";

/**
 * Stable task identifiers. Adding a task is a three-step change:
 *   1. Add the string to this union.
 *   2. Add a row to `DEFAULT_REGISTRY`.
 *   3. Pass the task through to `callAi({ task: "…" })` at the call-site.
 *
 * We enumerate the AiTask strings rather than accept arbitrary strings
 * so a typo at a call-site is a compile error, not a silent
 * "use the synthesis defaults" surprise at runtime.
 */
export type AiTask =
  // ── Analysis pipeline (ADR-0002 / ADR-0013) ────
  | "analysis.synthesis"
  | "analysis.verifier"
  | "analysis.scoring"
  // ── Downstream generation ─────────────────────
  | "deliverable.section"
  | "diagram.generate"
  | "diagram.parse" // Claude-vision on raster diagrams
  | "estimation"
  | "followups.generate"
  // ── Agent harness (ADR-0014) ──────────────────
  | "agent.planner"
  // Workflow orchestrator: emits the user-driven step graph
  // (UPLOAD_DOCUMENTS, CONNECT_REPOSITORY, ANSWER_QUESTIONS, …) for
  // the React-Flow workflow surface. Distinct from `agent.planner`
  // which picks autonomous tool calls.
  | "agent.workflow_planner"
  // Customer-uploadable template binding proposer (Phase 4 Slice 4):
  // reads a workbook / docx structural extract and proposes a JSON
  // mapping from engine output fields → cell refs / placeholders.
  | "template.binding_proposer"
  // Per-chunk domain classifier — fans batches of chunk text +
  // an active-domains list to the model and gets a domain key per
  // chunk. Used after ingest to backfill `Evidence.domain` so the
  // Explorer's domain filter is meaningful.
  | "ingest.domain_classifier"
  // ── Embeddings (ADR-0003) ─────────────────────
  | "embedding.ingest"
  | "embedding.query";

export type FailoverClass =
  | "rate_limit"
  | "overloaded"
  | "provider_5xx"
  | "timeout"
  | "connectivity";

export interface ModelBinding {
  provider: Provider;
  /** Provider-specific model id the SDK sees. */
  model: string;
  /** Override per-task max output tokens. Router default is 4096. */
  maxTokens?: number;
  /** Override per-task temperature. Router defaults to provider default. */
  temperature?: number;
  /**
   * Opt-in to Anthropic ephemeral prompt caching on the system prompt
   * (ADR-0012). Ignored for non-Anthropic/Bedrock providers — they
   * don't implement compatible cache-control semantics.
   */
  cacheSystem?: boolean;
  /** Per-binding timeout override (ms). Router default: 120_000. */
  timeoutMs?: number;
}

export interface TaskBinding {
  primary: ModelBinding;
  /** Ordered fallback chain. Empty = no failover. */
  fallbacks: readonly ModelBinding[];
  /**
   * Which router-visible error classes trigger a fallback hop.
   * Deterministic failures (auth, schema, content filter) always
   * short-circuit regardless of this set — fallback wouldn't fix them
   * and we'd just burn more tokens. See ADR-0015 §4 step 5.
   */
  failoverOn: readonly FailoverClass[];
}

const ANY_TRANSIENT: readonly FailoverClass[] = [
  "rate_limit",
  "overloaded",
  "provider_5xx",
  "timeout",
  "connectivity",
] as const;

/**
 * Default registry. Model IDs come verbatim from ADR-0015 §3 — the
 * operator's responsibility to pin to a known-good snapshot via
 * `ANTHROPIC_MODEL` or `AiModelOverride` if the verbatim IDs aren't
 * yet available on their account.
 *
 * **Why embedding.query has no fallback:** cache locality on the
 * retrieval-query path beats failover. A provider hop mid-flight
 * changes embedding-space and would wreck pgvector cosine scores
 * against a corpus indexed with the primary. A 429 on query is
 * better surfaced as a classified error to the UI than silently
 * routed through a different embedding space. (ADR-0015 §3 note.)
 *
 * **Why embedding.ingest's fallback is Titan v2 not v1:** v2 is the
 * 1536-dim Amazon-Titan variant; v1 is 1024-dim and would corrupt
 * the pgvector index. The router's `embedding.ingest` path asserts
 * dimensionality == 1536 before any row write to catch a misconfig.
 */
export const DEFAULT_REGISTRY: Readonly<Record<AiTask, TaskBinding>> = {
  "analysis.synthesis": {
    primary: {
      provider: "anthropic",
      model: "claude-sonnet-4-7",
      cacheSystem: true,
    },
    fallbacks: [
      { provider: "bedrock", model: "anthropic.claude-sonnet-4-7" },
      { provider: "openai", model: "gpt-5" },
    ],
    failoverOn: ANY_TRANSIENT,
  },
  "analysis.verifier": {
    primary: {
      provider: "anthropic",
      model: "claude-sonnet-4-7",
      cacheSystem: true,
    },
    fallbacks: [
      { provider: "bedrock", model: "anthropic.claude-sonnet-4-7" },
    ],
    failoverOn: ANY_TRANSIENT,
  },
  "analysis.scoring": {
    primary: { provider: "anthropic", model: "claude-haiku-4-5" },
    fallbacks: [{ provider: "openai", model: "gpt-5-mini" }],
    failoverOn: ANY_TRANSIENT,
  },
  "deliverable.section": {
    // Heaviest single call in the system: one batched generation
    // produces ~9 sections (`maxTokens: 6000`) with full project
    // context + findings + risks + recs + scores + assumptions in
    // the prompt. Sonnet output speed is ~50–100 tok/s, so 6k tokens
    // alone takes ~60–120 s before any input processing — right at
    // the 120 s router default. Bump to 240 s so heavy assessments
    // don't trip the timeout. Both primary and fallback override.
    primary: {
      provider: "anthropic",
      model: "claude-sonnet-4-7",
      cacheSystem: true,
      timeoutMs: 240_000,
    },
    fallbacks: [
      { provider: "openai", model: "gpt-5", timeoutMs: 240_000 },
    ],
    failoverOn: ANY_TRANSIENT,
  },
  "diagram.generate": {
    primary: { provider: "anthropic", model: "claude-sonnet-4-7" },
    fallbacks: [{ provider: "openai", model: "gpt-5" }],
    failoverOn: ANY_TRANSIENT,
  },
  "diagram.parse": {
    // Vision — kept Anthropic-only for now. Vertex (Gemini 2.5 Pro)
    // has parity and is the intended Slice 2 fallback; adding it is a
    // one-line registry edit once Vertex creds are provisioned.
    primary: { provider: "anthropic", model: "claude-sonnet-4-7" },
    fallbacks: [],
    failoverOn: [],
  },
  estimation: {
    primary: { provider: "anthropic", model: "claude-sonnet-4-7" },
    fallbacks: [{ provider: "openai", model: "gpt-5" }],
    failoverOn: ANY_TRANSIENT,
  },
  "followups.generate": {
    primary: { provider: "anthropic", model: "claude-haiku-4-5" },
    fallbacks: [
      { provider: "openai", model: "gpt-5-mini" },
      { provider: "mistral", model: "mistral-small-latest" },
    ],
    failoverOn: ANY_TRANSIENT,
  },
  "agent.planner": {
    primary: {
      provider: "anthropic",
      model: "claude-sonnet-4-7",
      cacheSystem: true,
    },
    fallbacks: [{ provider: "openai", model: "gpt-5" }],
    failoverOn: ANY_TRANSIENT,
  },
  "agent.workflow_planner": {
    primary: {
      provider: "anthropic",
      model: "claude-sonnet-4-7",
      cacheSystem: true,
    },
    fallbacks: [{ provider: "openai", model: "gpt-5" }],
    failoverOn: ANY_TRANSIENT,
  },
  "template.binding_proposer": {
    primary: {
      provider: "anthropic",
      model: "claude-sonnet-4-7",
    },
    fallbacks: [{ provider: "openai", model: "gpt-5" }],
    failoverOn: ANY_TRANSIENT,
  },
  "ingest.domain_classifier": {
    // Lightweight classification — Haiku tier is the right cost/quality
    // trade. The classifier is best-effort; if both providers fail
    // we silently leave the chunks in the catch-all bucket.
    primary: {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      cacheSystem: true,
    },
    fallbacks: [{ provider: "openai", model: "gpt-5" }],
    failoverOn: ANY_TRANSIENT,
  },
  "embedding.ingest": {
    primary: { provider: "openai", model: "text-embedding-3-small" },
    fallbacks: [{ provider: "bedrock", model: "amazon.titan-embed-text-v2:0" }],
    failoverOn: ["rate_limit", "overloaded", "provider_5xx"],
  },
  "embedding.query": {
    primary: { provider: "openai", model: "text-embedding-3-small" },
    fallbacks: [], // See JSDoc above.
    failoverOn: [],
  },
};

/**
 * In-process override cache. Loaded on first `resolveTask` call and
 * refreshed whenever the admin UI writes a row (via `invalidateOverrides`).
 * Not a per-request DB hit — the registry is hot-path and must be
 * near-zero cost.
 */
let _overrides: Map<AiTask, TaskBinding> | null = null;
let _overridesLoadedAt = 0;

export async function loadOverrides(): Promise<Map<AiTask, TaskBinding>> {
  if (_overrides) return _overrides;
  try {
    // Dynamic import to keep the prisma client out of any test path
    // that imports this module for pure type-level work.
    const { db } = await import("@/server/db");
    const rows = await db.aiModelOverride.findMany({
      where: {
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    const m = new Map<AiTask, TaskBinding>();
    for (const r of rows) {
      // Row shape is user-authored JSON; tolerate partial matches.
      const binding = r.binding as unknown as ModelBinding;
      const fallbacks = Array.isArray(r.fallbacks)
        ? (r.fallbacks as unknown as ModelBinding[])
        : [];
      m.set(r.task as AiTask, {
        primary: binding,
        fallbacks,
        failoverOn: ANY_TRANSIENT,
      });
    }
    _overrides = m;
    _overridesLoadedAt = Date.now();
    return m;
  } catch (err) {
    // On DB failure, fall back to empty overrides — the router still
    // works with DEFAULT_REGISTRY. Log once.
    if (Date.now() - _overridesLoadedAt > 60_000) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ai-registry] failed to load overrides, using defaults only: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      _overridesLoadedAt = Date.now();
    }
    _overrides = new Map();
    return _overrides;
  }
}

/** Called by the admin override mutation after writing a row. */
export function invalidateOverrides(): void {
  _overrides = null;
}

/**
 * Resolve a task to its effective binding, applying layered overrides.
 * Returns the *frozen* primary + fallbacks for the router to iterate.
 *
 * Env knobs applied:
 *   - `ANTHROPIC_MODEL` — rewrites every Anthropic/Bedrock binding's
 *     `model` field. Preserves the existing ADR-0012 behaviour where
 *     operators can pin a snapshot without touching the registry.
 */
export async function resolveTask(task: AiTask): Promise<TaskBinding> {
  const base = DEFAULT_REGISTRY[task];
  const overrides = await loadOverrides();
  const overridden = overrides.get(task) ?? base;
  const anthropicEnv = process.env.ANTHROPIC_MODEL;

  function applyEnv(b: ModelBinding): ModelBinding {
    if (!anthropicEnv) return b;
    if (b.provider === "anthropic") return { ...b, model: anthropicEnv };
    if (b.provider === "bedrock" && b.model.startsWith("anthropic.")) {
      // Re-prefix the env-specified Anthropic model with the Bedrock
      // namespace so operators only need to set one env.
      return { ...b, model: `anthropic.${anthropicEnv}` };
    }
    return b;
  }

  return {
    primary: applyEnv(overridden.primary),
    fallbacks: overridden.fallbacks.map(applyEnv),
    failoverOn: overridden.failoverOn,
  };
}

/**
 * Synchronous snapshot of the primary model id for a task — used by
 * the legacy `MODEL` export in `router.ts` and by any callers that
 * need a best-effort label without awaiting the DB override layer.
 * Does NOT apply DB overrides, only the env knob.
 */
export function primaryModelIdSync(task: AiTask): string {
  const base = DEFAULT_REGISTRY[task];
  const env = process.env.ANTHROPIC_MODEL;
  if (env && base.primary.provider === "anthropic") return env;
  return base.primary.model;
}
