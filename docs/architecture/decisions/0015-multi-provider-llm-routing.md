# ADR-0015: Multi-provider LLM routing

- **Status:** Accepted (§9 migration path amended by [ADR-0016](./0016-delete-legacy-claude-client-outright.md))
- **Date:** 2026-04-21
- **Deciders:** Engineering
- **Related:**
  [ADR-0003](./0003-embedding-model-choice.md),
  [ADR-0012](./0012-prompt-caching-and-cost-instrumentation.md),
  [ADR-0013](./0013-analysis-mode-and-verifier-pass.md),
  [ADR-0014](./0014-agent-harness-for-evidence-collection.md),
  [ADR-0029](./0029-deliverable-section-field-family.md) — the
  `deliverable.section` AI task this ADR registered now lands in
  output files via the `section.<key>` binding family.

## Context

Every AI call today goes through one of two single-vendor clients:

- **Anthropic direct** via `@anthropic-ai/sdk` in
  `apps/web/src/server/services/ai/claude-client.ts`. Used by per-domain
  analysis, per-domain verifier (ADR-0013), per-domain scoring,
  deliverable section authoring, follow-up question generation.
- **OpenAI direct** via the embedding client in `embedding-service.ts`.
  Used for ingest embeddings and retrieval-query embeddings.

Both clients are wired in directly: model ID flows from a single env
var (`ANTHROPIC_MODEL`, `OPENAI_EMBEDDING_MODEL`), pricing is a
single-provider lookup (`pricing.ts`), and every call-site imports the
concrete client. The architecture has served us well while we were an
MVP with one Claude tier and one embedding model.

Four forces push against that shape now:

1. **Production-reliability exposure.** Anthropic ITPM throttling and
   `overloaded_error` bursts during Claude-family incidents take the
   entire pipeline offline even though the work itself is embarrassingly
   parallel. We watched two such incidents in April wedge every queued
   assessment; there was no failover path.
2. **Per-task model selection.** Different call-sites want different
   quality / cost / latency trade-offs. Follow-up questions want a fast
   cheap model (Haiku or GPT-5 mini). Per-domain synthesis wants a
   capable reasoning model (Sonnet 4.7, GPT-5, Gemini 2.5 Pro). The
   upcoming agent harness (ADR-0014) wants tool-use-capable long-context
   (Sonnet 4.7 primary, GPT-5 fallback). One env var can't express this.
3. **Enterprise procurement.** Some prospective buyers require data to
   transit their existing cloud contract — AWS Bedrock, Azure OpenAI,
   Vertex AI — rather than a new Anthropic-direct vendor relationship.
   A single-vendor coupling blocks those deals.
4. **ADR-0014 blocks on this.** The agent harness declares
   `modelFallback` on every `AgentRun` and the per-tool cost class
   estimates depend on a pricing table keyed by (provider, model, call
   kind). That contract only makes sense if there's actually a router
   underneath.

"Do nothing" is not on the table. "Write our own OpenAPI-style abstraction"
is overkill and duplicates something the ecosystem has already solved.

## Decision

Adopt **Vercel AI SDK** (`ai` + `@ai-sdk/*` provider packages) as the
provider-abstraction layer, introduce a **task-keyed model registry**,
and thread a **router with deterministic fallback chains** in front of
every AI call-site. The existing `claude-client.ts` becomes one adapter
behind the router, not the one place call-sites import.

The delivery is strangler-style: the router ships first with one task
(`followups`) routed through it end-to-end; the other call-sites migrate
over two follow-up tickets. No big-bang rewrite.

### 1. Layering

```
Call-site (analysis router, worker job, agent harness)
        │
        ▼
┌──────────────────────────────────────────────────────────────────┐
│ callAi({ task, input, schema? })     (NEW — single entry point)  │
│   1. Resolve task → ModelBinding from registry                   │
│   2. Pick primary provider; build fallback chain                 │
│   3. Apply prompt cache hints (ADR-0012)                         │
│   4. Wrap with timeout, retry-on-failover-only policy            │
│   5. Emit AuditLog AI_CALL with {provider, model, routerReason}  │
└──────────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────┐
│ Vercel AI SDK                                                    │
│   generateText / generateObject / embed                          │
│   Tool-calling surface (for ADR-0014)                            │
└──────────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────┐
│ Provider adapters (one package each)                             │
│   @ai-sdk/anthropic   anthropic-direct                           │
│   @ai-sdk/amazon-bedrock   Anthropic via Bedrock + Titan embeds  │
│   @ai-sdk/openai          OpenAI-direct GPT + embeddings         │
│   @ai-sdk/azure           Azure OpenAI (enterprise tenants)      │
│   @ai-sdk/google-vertex   Gemini 2.5 Pro / Flash                 │
│   @ai-sdk/mistral         Mistral Large / Small (cost-sensitive) │
└──────────────────────────────────────────────────────────────────┘
```

### 2. Provider matrix

| Provider | Transport | Why we want it | Ships in |
|---|---|---|---|
| **Anthropic direct** | `@ai-sdk/anthropic` | Primary today; prompt caching maturity; fastest-moving Claude capabilities. | Slice 1 |
| **AWS Bedrock** | `@ai-sdk/amazon-bedrock` | Enterprise procurement path; data plane in customer's AWS region; commit-burn pricing for volume; Claude parity. | Slice 1 |
| **OpenAI direct** | `@ai-sdk/openai` | GPT-5 for Sonnet fallback; we already use OpenAI for embeddings (ADR-0003); lowest-latency embedding API in production. | Slice 1 |
| **Azure OpenAI** | `@ai-sdk/azure` | Enterprise tenants whose compliance stack is Microsoft-only; region-pinned data residency. | Slice 2 |
| **Google Vertex** | `@ai-sdk/google-vertex` | Gemini 2.5 Pro competitive on long-context; GCP-native buyers. | Slice 2 |
| **Mistral** | `@ai-sdk/mistral` | Cost floor for bulk follow-up / clustering calls; EU data-residency option. | Slice 3 |

Selection criteria for "which provider ships when":

- Slice 1 covers every task the product runs today **plus** the agent
  harness's primary + fallback. This is the blocking set for ADR-0014.
- Slice 2 covers procurement-driven tenants (Azure, Vertex) — no new
  capabilities, just billing / residency paths.
- Slice 3 is cost optimisation.

### 3. Task registry

Every call-site identifies itself by a stable `task` string. The
registry maps task → primary model binding + ordered fallback chain:

```ts
// apps/web/src/server/services/ai/model-registry.ts

export type AiTask =
  | "analysis.synthesis"       // Per-domain generator (ADR-0002)
  | "analysis.verifier"        // Per-domain verifier (ADR-0013)
  | "analysis.scoring"         // Per-domain scorer
  | "deliverable.section"      // Deliverable section authoring
  | "followups.generate"       // Follow-up question generation
  | "agent.planner"            // Agent harness (ADR-0014)
  | "embedding.ingest"         // Document ingest embeddings
  | "embedding.query";         // Retrieval-query embeddings

export interface ModelBinding {
  provider: "anthropic" | "bedrock" | "openai" | "azure" | "vertex" | "mistral";
  model: string;                 // Provider-specific model id
  maxTokens?: number;
  temperature?: number;
  cacheSystem?: boolean;         // Applied by the router (ADR-0012)
  // When this binding is used as a fallback, the router records the
  // originating failure class on the AuditLog row.
}

export interface TaskBinding {
  primary: ModelBinding;
  fallbacks: ModelBinding[];     // Ordered; empty = no failover
  // Which error classes trigger a fallback hop. Transient (429, 5xx,
  // overloaded) yes; deterministic (auth, schema, content filter) no —
  // a fallback won't fix them and we'd just burn more tokens.
  failoverOn: readonly FailoverClass[];
}

export type FailoverClass =
  | "rate_limit"
  | "overloaded"
  | "provider_5xx"
  | "timeout"
  | "connectivity";
```

Default registry (frozen at boot; DB overrides merge on top):

```ts
export const DEFAULT_REGISTRY: Record<AiTask, TaskBinding> = {
  "analysis.synthesis": {
    primary:   { provider: "anthropic", model: "claude-sonnet-4-7", cacheSystem: true },
    fallbacks: [{ provider: "bedrock", model: "anthropic.claude-sonnet-4-7" },
                { provider: "openai",  model: "gpt-5" }],
    failoverOn: ["rate_limit", "overloaded", "provider_5xx", "timeout"],
  },
  "analysis.verifier": {
    primary:   { provider: "anthropic", model: "claude-sonnet-4-7", cacheSystem: true },
    fallbacks: [{ provider: "bedrock", model: "anthropic.claude-sonnet-4-7" }],
    failoverOn: ["rate_limit", "overloaded", "provider_5xx", "timeout"],
  },
  "analysis.scoring": {
    primary:   { provider: "anthropic", model: "claude-haiku-4-5" },
    fallbacks: [{ provider: "openai", model: "gpt-5-mini" }],
    failoverOn: ["rate_limit", "overloaded", "provider_5xx", "timeout"],
  },
  "deliverable.section": {
    primary:   { provider: "anthropic", model: "claude-sonnet-4-7", cacheSystem: true },
    fallbacks: [{ provider: "openai", model: "gpt-5" }],
    failoverOn: ["rate_limit", "overloaded", "provider_5xx", "timeout"],
  },
  "followups.generate": {
    primary:   { provider: "anthropic", model: "claude-haiku-4-5" },
    fallbacks: [{ provider: "openai",  model: "gpt-5-mini" },
                { provider: "mistral", model: "mistral-small-latest" }],
    failoverOn: ["rate_limit", "overloaded", "provider_5xx", "timeout"],
  },
  "agent.planner": {
    primary:   { provider: "anthropic", model: "claude-sonnet-4-7", cacheSystem: true },
    fallbacks: [{ provider: "openai", model: "gpt-5" }],
    failoverOn: ["rate_limit", "overloaded", "provider_5xx", "timeout"],
  },
  "embedding.ingest": {
    primary:   { provider: "openai", model: "text-embedding-3-small" },
    fallbacks: [{ provider: "bedrock", model: "amazon.titan-embed-text-v2" }],
    failoverOn: ["rate_limit", "overloaded", "provider_5xx"],
  },
  "embedding.query": {
    primary:   { provider: "openai", model: "text-embedding-3-small" },
    fallbacks: [],   // Query path is on the hot request-response; cache hit-rate matters more than failover
    failoverOn: [],
  },
};
```

**Why embeddings keep their own primary.** Embeddings are indexed into
pgvector with a fixed dimensionality (1536). Silently failing over from
a 1536-dim model to a 1024-dim one corrupts the index. The Titan
fallback uses the v2 variant pinned to 1536; any other dimensionality
is a deliberate migration (ADR-0003 cadence), not a runtime fallback.

### 4. Router contract

One entry point replaces the direct Anthropic / OpenAI client imports
at call-sites:

```ts
// apps/web/src/server/services/ai/router.ts

export interface CallAiInput<TSchema extends z.ZodTypeAny | undefined> {
  task: AiTask;
  system?: string;           // Cached across calls for the same task if cacheSystem
  messages: CoreMessage[];   // Vercel AI SDK shape
  schema?: TSchema;          // When present, uses generateObject
  entityType?: string;       // For AuditLog tagging
  entityId?: string;
  engagementId?: string;
  /** Override the registry — ADR-0014 agent runs pin their own model. */
  modelOverride?: ModelBinding;
  abortSignal?: AbortSignal;
}

export interface CallAiResult<T> {
  value: T;
  provider: ModelBinding["provider"];
  model: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  costUsd: number;
  latencyMs: number;
  /** Non-null when a fallback was used; carries the failure class that triggered it. */
  routerReason?: { from: string; failoverClass: FailoverClass };
}

export function callAi<TSchema extends z.ZodTypeAny | undefined>(
  input: CallAiInput<TSchema>,
): Promise<CallAiResult<TSchema extends z.ZodTypeAny ? z.infer<TSchema> : string>>;
```

Execution path:

1. Resolve task → binding (primary + fallbacks). If `modelOverride`
   present, treat as pinned single-provider call with no fallback.
2. Build the Vercel AI SDK `LanguageModel` for the primary.
3. Attach prompt-cache hints (`experimental_providerMetadata.anthropic.cacheControl`
   for Anthropic / Bedrock) when `cacheSystem: true`.
4. Race against `CLAUDE_CALL_TIMEOUT_MS` (reused from the existing
   client so we don't regress).
5. On failure, run `classifyProcessingError` (already exists). If the
   class is in `failoverOn`, hop to the next binding and retry **once**
   per binding. Deterministic failures (auth, schema, content filter)
   throw immediately.
6. Emit one `AuditLog AI_CALL` row per *attempt* (including the failed
   primary) so the cost trail is complete. The `routerReason` shows up
   on the successful row.

### 5. AuditLog shape (evolution of ADR-0012)

`AuditLog.details.AI_CALL` gains three fields. Existing fields are
preserved; readers that don't know about the new fields keep working.

```jsonc
{
  // existing (ADR-0012) …
  "callType": "analysis" | "scoring" | …,
  "model":    "claude-sonnet-4-7" | …,
  "inputTokens": 1234,
  "outputTokens": 456,
  "cacheReadInputTokens": 800,
  "cacheCreationInputTokens": 0,
  "estimatedCostUsd": 0.0123,
  "pricingVersion": "2026-04-21",

  // new
  "provider":      "anthropic" | "bedrock" | "openai" | "azure" | "vertex" | "mistral",
  "routerReason":  null | { "from": "anthropic:claude-sonnet-4-7", "failoverClass": "overloaded" },
  "task":          "analysis.synthesis"      // The stable task key
}
```

### 6. Pricing table

`pricing.ts` grows a (provider, model) → price map. The existing
single-map shape stops working once the same model id (`claude-sonnet-4-7`)
can come from Anthropic *or* Bedrock at different rates. Keyed lookup:

```ts
export function priceFor(
  provider: ModelBinding["provider"],
  model: string,
): ModelPrice;
```

Bedrock rates inherit from Anthropic at list price but are patched per
active customer commitment. Titan embeddings are their own row. OpenAI,
Azure, Vertex, Mistral each carry their own. `PRICING_VERSION` bumps
whenever any cell changes — the AuditLog row pins the version so
historical cost reports stay consistent when rates change.

### 7. Configuration

Provider credentials follow the existing env-var pattern; nothing is
database-resident except the *override* layer. Required envs (only for
providers actually enabled):

```
ANTHROPIC_API_KEY            # existing
OPENAI_API_KEY               # existing
AWS_REGION                   # bedrock
AWS_BEDROCK_ROLE_ARN         # bedrock (optional — falls back to default chain)
AZURE_OPENAI_RESOURCE_NAME   # azure
AZURE_OPENAI_API_KEY         # azure
GOOGLE_VERTEX_PROJECT        # vertex
GOOGLE_APPLICATION_CREDENTIALS  # vertex (workload identity preferred)
MISTRAL_API_KEY              # mistral
```

**Runtime overrides.** A new `AiModelOverride` table lets an admin
swap the primary for a task without a redeploy. Useful for incident
response ("Anthropic is overloaded, pin `analysis.synthesis` to
Bedrock for the next hour") and A/B trials. Overrides are loaded on
router boot and on a `SIGHUP`-style invalidation event; no per-call DB
read.

```prisma
model AiModelOverride {
  id          String   @id @default(cuid())
  task        String   @unique             // AiTask key
  binding     Json                          // ModelBinding
  fallbacks   Json                          // ModelBinding[]
  reason      String                        // Human note — shows in AuditLog
  createdById String   @map("created_by_id")
  createdAt   DateTime @default(now()) @map("created_at")
  expiresAt   DateTime? @map("expires_at")  // Auto-revert after this time

  @@map("ai_model_overrides")
}
```

### 8. Observability

- Every call emits `AuditLog AI_CALL` (see §5) — the existing cost
  rollup views (`engagement.costSummary`, `assessment.costSummary`)
  grow a `provider` breakdown for free.
- Router decisions land in the structured log with
  `source='ai-router'`, tagged by `task`, `provider`, `failoverClass`.
- A new `/admin/ai-router` page surfaces: override table, last 24 h
  failover rate per task, cost by provider, current primary for every
  task. Admin-only (parallels the existing `/admin` tiles).

### 9. Migration path

Strangler, three steps, shippable independently:

1. **Plumbing.** Introduce the router, registry, and
   Vercel AI SDK dependencies. Migrate `followups.generate` through
   the router end-to-end — lowest-stakes call-site, real production
   exercise of the primary + fallback path. All other call-sites keep
   using `claude-client.ts` directly; it becomes an adapter callable
   both ways during the overlap window.
2. **Synthesis + verifier + scoring + deliverable.** Move the Claude-
   heavy call-sites behind `callAi`. Delete the direct
   `claude.messages.create` calls. This is the step that unlocks
   Bedrock-for-procurement and ADR-0014's `modelFallback` story.
3. **Embeddings.** Move `embedding-service.ts` behind
   `callAi({ task: "embedding.ingest" })`. Embeddings are the riskiest
   migration (dimensionality invariant — see §3); this ships last with
   a dimension-check guard that refuses to write a row whose vector
   length ≠ 1536.

Each step is independently revertable: keeping the old clients as
deprecated adapters for one release cycle means a bad router change
can be rolled back without re-threading call-sites.

## Alternatives considered

- **LangChain.js as the abstraction layer.** Has the widest provider
  surface but also the heaviest dependency cost and a chain-centric
  API we don't want bleeding into call-sites. Vercel AI SDK is lighter
  and its `generateText` / `generateObject` shape matches what we
  already call into Anthropic's SDK with. Re-evaluate if we ever want
  LangSmith's tracing as our primary observer.
- **Portkey / OpenRouter / LiteLLM as a hosted gateway.** A proxy in
  front of every LLM with routing + fallback + caching as a service.
  Attractive because someone else runs the fallback logic. Rejected
  for now: (a) enterprise buyers object to "your traffic flows through
  a third-party gateway" unless we can turn it off per tenant, (b)
  prompt caching needs a direct provider relationship to reliably hit
  cache — gateway proxies defeat cache locality. Revisit as an
  opt-in adapter alongside the direct ones; the router contract
  doesn't preclude it.
- **Home-grown provider abstraction.** We'd spend weeks shipping what
  the AI SDK already ships. Rejected on opportunity-cost alone.
- **Per-provider long-lived worker pool (sharded workers).** Run two
  BullMQ worker pools, one talking to Anthropic and one to Bedrock,
  with the queue dispatching per-domain. Solves reliability but not
  the per-task model selection or the embedding-provider question; and
  the ops complexity (two pool sizes to tune, two sets of credentials
  per worker) isn't worth it when a router covers both.
- **Stay single-provider with prompt caching + retry discipline.**
  The "do nothing bigger" option. Rejected because even with perfect
  cache hit rates, Anthropic-incident windows take the whole product
  offline, and ADR-0014 is explicitly blocked on multi-provider.

## Consequences

**Positive**

- A single Anthropic ITPM / overloaded burst no longer takes the
  pipeline down — Bedrock or OpenAI picks up the slack, and the
  failover shows up as a `routerReason` on the cost row rather than a
  failed job.
- Enterprise-procurement buyers who require Bedrock / Azure / Vertex
  as the data plane can be onboarded with a tenant-scoped override;
  no code change.
- Per-task model tuning becomes a one-line edit to the registry. We
  can cheapen bulk-follow-up runs with Mistral or Haiku without
  touching call-sites.
- ADR-0014 unblocks: `AgentRun.modelFallback` is now a real thing the
  router honours.
- Cost reporting gains a provider dimension for free.

**Negative**

- Six provider SDKs and their credentials are now ops surface. Even
  lazy-loaded, each one is a set of env vars to document and a failure
  mode to exercise. Provisioning checklist grows.
- Pricing table doubles in size; keeping it accurate requires one
  person to own "watch provider pricing pages, bump `PRICING_VERSION`
  when anything changes." Propose quarterly cadence + a CI alarm that
  checks listed prices against the public pricing pages.
- Evals get multi-provider: we need a regression suite per task that
  asserts primary and each fallback all produce acceptable output. A
  silent provider drift (Bedrock updating a model ID under the hood)
  would degrade assessment quality without any obvious signal.
- One more dependency surface (Vercel AI SDK) pinned in `package.json`
  with its own upgrade cadence.

**Neutral**

- `claude-client.ts` becomes an adapter not an entry point. Imports of
  `claude` or `MODEL` in new code stop being correct; lint rule will
  flag them during the migration window.
- The `CLAUDE_CALL_TIMEOUT_MS` constant moves to `ROUTER_CALL_TIMEOUT_MS`
  and becomes per-task-overridable (long agent-planner calls will
  need a higher ceiling than follow-up generation).

## Follow-ups

- [ ] Add `ai`, `@ai-sdk/anthropic`, `@ai-sdk/amazon-bedrock`,
      `@ai-sdk/openai` to `apps/web/package.json`.
- [ ] Create `apps/web/src/server/services/ai/router.ts`,
      `model-registry.ts`, and extend `pricing.ts` to (provider, model)
      keying. Pin `PRICING_VERSION` bump.
- [ ] Migrate `followups.generate` call-site through the router first
      (strangler step 1).
- [ ] Migrate synthesis / verifier / scoring / deliverable call-sites
      (strangler step 2). Delete direct `claude.messages.create` calls.
- [ ] Migrate embeddings (strangler step 3) with a dimensionality
      invariant check before any row write.
- [ ] Prisma migration: `ai_model_overrides` table + admin UI at
      `/admin/ai-router`.
- [ ] AuditLog reader updates: cost-summary views break out by
      `provider`; router-reason visible on per-call audit rows.
- [ ] Eval coverage: per-task regression suite that exercises the
      primary **and** each declared fallback; CI job that fails if a
      pinned provider returns schema-invalid output on the canned
      fixtures.
- [ ] Azure OpenAI + Google Vertex + Mistral adapters (slices 2 and 3);
      separate tickets with provisioning docs.
- [ ] Ops runbook: "Anthropic is down — pin synthesis to Bedrock"
      (admin override UX + how it's logged).
- [ ] Pricing-table freshness CI check (quarterly).

## References

- ADR-0003 Embedding model choice — dimensionality invariant this ADR
  must preserve.
- ADR-0012 Prompt caching & cost instrumentation — AuditLog shape this
  ADR extends.
- ADR-0013 Analysis mode & verifier pass — second Claude-heavy
  call-site to migrate.
- ADR-0014 Agent harness for evidence collection — the consumer that
  blocks on this ADR for `modelFallback` semantics.
- Vercel AI SDK: `generateText`, `generateObject`, provider metadata
  cache hints.
- AWS Bedrock: Anthropic model catalog, commit-burn pricing.
- Anthropic prompt caching docs: `cache_control` on system / user
  turns.
