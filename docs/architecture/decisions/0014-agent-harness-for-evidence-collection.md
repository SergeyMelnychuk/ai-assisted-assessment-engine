# ADR-0014: Agent harness for evidence collection

- **Status:** Accepted (Slice 1+ shipped — workflow planner, JIT
  credentials, BullMQ-backed harness, GitHub adapter, archive/restore/
  delete on AgentRun, per-step status state machine)
- **Date:** 2026-04-20 (proposed) · 2026-05-06 (accepted, post-Slice 3)
- **Deciders:** Engineering
- **Related:**
  [ADR-0001](./0001-decouple-ingest-from-analyse.md),
  [ADR-0002](./0002-per-domain-analysis-fan-out.md),
  [ADR-0009](./0009-pat-per-engagement-credentials.md),
  [ADR-0010](./0010-tarball-api-over-git-clone.md),
  [ADR-0011](./0011-evidence-traceability-first-class.md),
  [ADR-0012](./0012-prompt-caching-and-cost-instrumentation.md).

## Context

Today the `Evidence` table is populated by two passive paths:

1. **Uploaded documents.** User drops a PDF / DOCX / archive; the
   ingest worker extracts, chunks, embeds, writes `EvidenceSourceType
   = DOCUMENT` rows.
2. **Answers.** The user types answers into the questionnaire;
   `EvidenceSourceType = ANSWER`.

That's enough to generate a defensible assessment when the client
hands over a complete docset, but it covers a shrinking fraction of
real engagements. What consulting teams increasingly want is:

- Point the system at a GitHub org → it reads the repos
- Point it at an AWS account → it inspects IAM, Config, CloudTrail
- Point it at a CI system → it inspects workflow definitions and run
  histories
- When something's missing (no access, wrong scope, expired token) →
  it *asks the user for it* rather than silently degrading
- Everything it observes becomes evidence the existing per-domain
  analysis pipeline (ADR-0002) can cite

The existing synthesis layer is deliberately deterministic: one Claude
call per domain, bounded retrieval context, structured JSON output,
full `retrievedEvidenceIds` trail (ADR-0011). That discipline is what
gives us reviewability. We do **not** want to replace it with a
free-roaming agent; every finding, risk, score, and roadmap item must
remain traceable to a specific evidence row the reviewer can audit.

What we need is an **agentic evidence-collection phase** that sits
*upstream* of the synthesis pipeline. The agent plans, uses tools,
observes results, and emits typed `Evidence` rows. The downstream
pipeline is unchanged.

This ADR pins the harness contract before slice 1 ships, so tools
added in slices 2 and 3 plug in without re-litigating the shape.

## Decision

Introduce a first-class **agent harness** — a bounded plan-act-observe
loop that consumes credentialed access to external systems (repos,
CI, cloud) and emits `Evidence` rows typed as
`EvidenceSourceType = CONNECTOR` (already in the enum; reserved for
exactly this). The harness is a new job type on the existing BullMQ
queue, with full trajectory persistence, per-run budgets, and a
human-in-the-loop approval gate at launch.

### 1. Layering

```
┌──────────────────────────────────────────────────────────────────┐
│ Agent harness (NEW)                                              │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Planner loop (Claude + tool use)                          │  │
│  │    plan → select tool → call → observe → record → repeat   │  │
│  └────────────────────────────────────────────────────────────┘  │
│           │                                                      │
│           ▼                                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Tool registry (allowlist per plan)                        │  │
│  │    repo.*  ci.*  cloud.*  access.request  scratchpad.*     │  │
│  └────────────────────────────────────────────────────────────┘  │
│           │                                                      │
│           ▼                                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Evidence emitter  →  writes Evidence(sourceType=CONNECTOR)│  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                │
                ▼  (unchanged from today)
┌──────────────────────────────────────────────────────────────────┐
│ Per-domain analysis fan-out (ADR-0002) → Findings / Risks /       │
│ Recommendations / DomainScores with retrievedEvidenceIds trail    │
└──────────────────────────────────────────────────────────────────┘
```

The arrow between the two boxes is a database write, not an in-memory
hand-off. The agent finishes, its evidence is indexed and embedded,
and the next `run-analysis` invocation retrieves it like any other
row. This keeps the two phases independently runnable and testable.

### 2. Stack choices

| Concern | Choice | Why |
|---|---|---|
| Agent framework | **Vercel AI SDK** (`ai` + provider packages) with a hand-rolled state machine on top | Lightweight, TS-native, provider-agnostic (aligns with ADR-0015 once multi-provider lands), `generateText` + tool-calling + `maxSteps` gives us the step loop for free. LangGraph was considered; its graph model is overkill for the single-planner shape we want, and we'd own less of our core value. |
| Model routing | Primary: Claude Sonnet 4.7; fallback: GPT-5 (via the per-task model registry — see ADR-0015) | Sonnet's tool-use + long-context fit the shape. GPT-5 as failover for ITPM exhaustion on large repos. |
| Prompt caching | Cache the harness system prompt + tool catalog (`cacheSystem: true`) | System prompt is identical across every step of every run; caching is decisive on multi-hundred-step runs. Follows ADR-0012. |
| Sandboxed code execution | **Dagger + Firecracker microVMs** (hosted), or Docker-in-Docker with strict resource limits (self-hosted) | Required for `repo.run_linter`, `repo.run_sast`, `repo.exec` tools. Never exec untrusted customer code on the worker host. |
| Static analysis toolchain | `ripgrep`, `semgrep`, `tree-sitter`, `syft` (SBOM), `trivy` (vuln scan), `tfsec` / `checkov` (IaC), `gitleaks` (secrets) | All FOSS, all one-shot CLI, all sandbox-friendly. |
| Cloud SDKs | `@aws-sdk/*` (read-only role), `@google-cloud/*`, `@azure/arm-*` | Official SDKs; no shelling out to `aws` CLI inside the sandbox. |
| CI inspection | GitHub Octokit, GitLab Node SDK, Jenkins REST | Direct APIs; no scraping. |
| Credential storage | Existing `server/services/repo/credentials.ts` pattern — AES-GCM at rest, scoped per engagement | Already proven for repo tokens (ADR-0009); extends to cloud role ARNs and CI tokens with the same shape. |
| Budget enforcement | Hard caps on `maxSteps`, `maxTokens`, `maxDurationMs`, `maxToolCalls`, `maxSandboxSeconds`, `maxEvidenceRows` | Composed at job enqueue, enforced in the loop. A run that hits any cap ends with status `BUDGET_EXHAUSTED`, not a silent partial. |
| Trajectory storage | New `AgentRun` + `AgentStep` + `AgentToolCall` tables (Postgres) | Every run is fully replayable from these rows — central to the reviewability story. |
| Observability | LangSmith (or Braintrust, to be picked in follow-up) + existing `Log` table via `source='worker:agent'` | Traces go to the external tool; structured summaries go to our logs so operators see them alongside everything else. |
| Eval harness | Canned fixture engagements with recorded trajectories; regression replays on every agent-prompt change | No agent prompt ships without passing the replay suite. Implementation detail in the follow-ups. |
| Human-in-the-loop UI | New `Agent plan` page on the assessment shell: proposed tool scopes, credential status, estimated cost/time → "Approve & run" / "Edit scope" | No run starts without explicit user approval. Approval is itself audit-logged. |

### 3. Tool protocol

All agent tools implement the same TypeScript contract. One interface,
one registration path, one way to get invoked, one way to emit
evidence.

```ts
// apps/web/src/server/services/agent/tool.ts

export interface AgentToolContext {
  runId: string;
  assessmentId: string;
  engagementId: string;
  // Credentials scoped to this engagement; the harness resolves them
  // from the encrypted store before the step runs and passes only
  // what the tool declared in its `requiresCredentials`.
  credentials: Readonly<Record<string, unknown>>;
  // Logger pre-tagged with runId, stepIdx, toolName.
  log: StructuredLogger;
  // Bounded sandbox executor — rejects if the tool didn't declare
  // `requiresSandbox: true`.
  sandbox: SandboxRunner;
  // Emits an Evidence row scoped to this run. The harness dedupes by
  // contentSha (ADR-0011 compatible).
  emitEvidence: (row: EvidenceDraft) => Promise<{ evidenceId: string }>;
  // Allows a tool to ask the agent a clarifying question that blocks
  // the run until the user answers (e.g. "I see 12 repos — scope to
  // which?"). Writes an AgentStep with status = AWAITING_USER.
  ask: (prompt: string, options?: string[]) => Promise<string>;
  // Budget view — tools that are about to do something expensive
  // (clone a 4 GB repo) consult this and fail fast if they'd blow it.
  budget: BudgetSnapshot;
}

export interface AgentTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  /** Stable identifier surfaced to the planner, e.g. "repo.read_file". */
  name: string;
  /** One-line description shown to the model in the tool catalog. */
  description: string;
  /** Zod schema for input args. Validated before execution. */
  input: I;
  /** Zod schema for the returned value shown back to the model. */
  output: O;
  /** Credential scopes required to execute. Empty = public / no creds. */
  requiresCredentials: readonly CredentialScope[];
  /** True if this tool must run inside the sandbox. */
  requiresSandbox: boolean;
  /** Rough cost class for the planner + budget UI. */
  costClass: "cheap" | "moderate" | "expensive";
  /** Suggested per-call timeout. The harness enforces a hard cap regardless. */
  timeoutMs: number;
  /** The implementation. */
  execute: (
    input: z.infer<I>,
    ctx: AgentToolContext,
  ) => Promise<z.infer<O>>;
}

export interface EvidenceDraft {
  // One of the active domains on the assessment — the retriever keys
  // on this. `ingested` means "cross-domain" (rare; prefer a specific
  // domain).
  domain: string;
  // Human-readable excerpt. This is what reviewers see and what the
  // synthesis pipeline feeds back to Claude during per-domain retrieval.
  content: string;
  // Confidence the tool assigns (0..1). The clusterer uses this.
  confidence: number;
  // Provenance. At least one of repoRef / cloudRef / ciRef must be set.
  provenance: EvidenceProvenance;
}

export type EvidenceProvenance =
  | { kind: "repo"; repoRef: { url: string; commitSha: string; path?: string; lineRange?: [number, number] } }
  | { kind: "ci"; ciRef: { system: "github_actions" | "gitlab_ci" | "jenkins"; workflowPath?: string; runId?: string } }
  | { kind: "cloud"; cloudRef: { provider: "aws" | "gcp" | "azure"; accountId: string; region?: string; arn?: string; resourceId?: string } }
  | { kind: "tool"; toolRef: { name: string; invocation: string } };
```

Every tool is a pure function of `(input, context) → output` that may
additionally emit evidence as a side effect. Tools never read or
mutate assessment rows directly — that boundary stays with the
harness.

### 4. Initial tool suite

Slice 1 (repo inspection — ships first). Tools surface-normalized
across Git providers; credentials already covered by ADR-0009.

| Tool | Purpose | Sandboxed |
|---|---|---|
| `access.request` | Surface a missing-access gap to the user; blocks run until resolved. | no |
| `repo.list_refs` | List repos + default branch for a GitHub/GitLab org or user. | no |
| `repo.read_tree` | Directory listing at a commit, depth-bounded. | no |
| `repo.read_file` | Read a single file at a commit; byte-range supported. | no |
| `repo.grep` | `ripgrep` across a checkout with `--json` output. | yes |
| `repo.run_linter` | Language-native linter (eslint, ruff, golangci-lint, clippy…). | yes |
| `repo.run_sast` | `semgrep --config=auto`. | yes |
| `repo.scan_secrets` | `gitleaks detect --no-git`. | yes |
| `repo.scan_deps` | `syft` + `trivy` over the SBOM. | yes |
| `repo.scan_iac` | `tfsec`, `checkov`, `kube-linter`. | yes |
| `repo.git_stats` | Commit cadence, author diversity, bus factor (from shallow clone metadata). | yes |
| `scratchpad.note` | Write a private planning note (does not emit evidence). | no |
| `scratchpad.summarize` | Roll up a batch of observations into a single evidence row. | no |

Slice 2 — CI/CD:

| Tool | Purpose |
|---|---|
| `ci.list_workflows` | Pull workflow definitions. |
| `ci.run_stats` | Pass rate, duration trend, flakiness per workflow. |
| `ci.deployment_history` | Deploy frequency, lead time, MTTR from deploy events. |

Slice 3 — Cloud (read-only assumed role):

| Tool | Purpose |
|---|---|
| `cloud.aws.iam_audit` | IAM users/roles/policies, inline grants, MFA coverage. |
| `cloud.aws.config_findings` | AWS Config non-compliant rules. |
| `cloud.aws.securityhub` | Security Hub findings (rolled up). |
| `cloud.aws.cost_explorer` | 90-day spend by service, anomalies. |
| `cloud.aws.ct_sample` | CloudTrail sample for admin actions. |
| `cloud.gcp.*`, `cloud.azure.*` | Parity across clouds. |

### 5. Step / budget gates

The harness is a loop with hard caps composed at enqueue time:

```ts
export interface AgentRunBudget {
  maxSteps: number;           // Default 80. Hard stop after N planner turns.
  maxToolCalls: number;       // Default 200.
  maxTokens: number;          // Default 2_000_000 (input + output + cached).
  maxDurationMs: number;      // Default 30 * 60_000 (30 min).
  maxSandboxSeconds: number;  // Default 600.
  maxEvidenceRows: number;    // Default 500. Stops runaway emission.
  maxCostUsd: number;         // Derived from maxTokens × model pricing at enqueue.
}
```

Budgets are *enforced by the harness*, not the model. The model sees
a `BudgetSnapshot` on every step so it can plan economically, but any
tool call that would cross a cap is rejected before execution. A
rejected call records a `ToolCall { status: "BUDGET_DENIED" }` step
and the planner is told "over budget for X" and must wrap up. A run
that naturally finishes under budget ends `COMPLETED`; a run killed
by any cap ends `BUDGET_EXHAUSTED` with partial evidence preserved.

Approval flow: at enqueue, the UI shows the *plan* (scoped credential
list, tool allowlist, estimated cost/duration at p50 and p95) and the
run does not start without explicit user approval. A run can be
cancelled mid-flight via the existing `CANCEL_*` audit-log protocol
(ADR-0002, reused).

### 6. Trajectory schema

> **Errata (2026-04-24, Phase 4 Slice 0).** The schema that actually
> landed in migration `add_agent_harness_tables` differs from the
> draft below in a handful of field names. The intent and semantics
> are unchanged — the canonical source is now
> `apps/web/prisma/schema.prisma`; the draft below is kept for the
> reasoning it records. Concrete deltas:
>
> - `AgentStep.stepIdx` → **`idx`**. Same monotonic semantics; just
>   shorter.
> - `AgentStep.tokensIn` / `tokensOut` → **`inputTokens`** /
>   **`outputTokens`**. `tokensCached`, `costUsd`, `durationMs`
>   dropped from the step row; running totals live on
>   `AgentRun.usage` instead (one authoritative place, no
>   reconciliation).
> - `AgentStepKind.BUDGET_DENIED` → dropped. A budget-denied attempt
>   is recorded on the `AgentToolCall` side as
>   `status=FAILED` with `errorClass="BUDGET_EXHAUSTED"`. Added
>   `USER_INPUT` and `SYSTEM` step kinds (the draft had `USER_INPUT`
>   listed; `SYSTEM` is new — used for resumption breadcrumbs and
>   planner-boundary markers).
> - `AgentToolCall.input` / `output` → **`argsJson`** /
>   **`resultJson`**. `outputSha` dropped — dedup lives in the
>   harness's in-memory plan replay, not in SQL.
> - `AgentToolCall.status` values: **`PENDING` / `RUNNING` /
>   `SUCCEEDED` / `FAILED` / `TIMED_OUT` / `CANCELLED`**. The draft's
>   `OK` is `SUCCEEDED`; `TIMEOUT` is `TIMED_OUT`; `BUDGET_DENIED`
>   folded into `FAILED` + `errorClass`.
> - `AgentToolCall.error` → **`errorClass`** (string, classifier
>   output — same pattern as `processing-error-classifier`).
> - `AgentToolCall.sandboxUsed` → dropped. Sandbox usage is
>   per-scope, recorded on the tool registration, not per-row.
>   Revisits with ADR-0018 if that assumption breaks.
> - `AgentToolCall.createdAt` → **`startedAt`** / **`endedAt`** /
>   **`durationMs`**. Tool calls have a well-defined start/end; a
>   single timestamp lost too much.
>
> The status enum also picked up `AWAITING_USER` on `AgentRun` exactly
> as drafted below.

Three new tables. All rows carry `engagementId` via join to
`AgentRun` so the access-filter pattern
(`engagementAccessFilter`) works unchanged.

```prisma
model AgentRun {
  id              String          @id @default(cuid())
  assessmentId    String          @map("assessment_id")
  engagementId    String          @map("engagement_id")
  planName        String          @map("plan_name")   // "repo-inspection", "ci-probe", etc.
  status          AgentRunStatus  @default(PROPOSED)
  budget          Json            // AgentRunBudget above, frozen at enqueue
  usage           Json            @default("{}")      // Running tally: steps, tokens, tool calls, evidence rows, cost
  systemPrompt    String          @map("system_prompt")
  systemPromptSha String          @map("system_prompt_sha")  // Exact prompt version for replay
  model           String                                     // e.g. "claude-sonnet-4.7"
  modelFallback   String?         @map("model_fallback")
  approvedById    String?         @map("approved_by_id")
  approvedAt      DateTime?       @map("approved_at")
  startedAt       DateTime?       @map("started_at")
  endedAt         DateTime?       @map("ended_at")
  endReason       String?         @map("end_reason")         // COMPLETED | BUDGET_EXHAUSTED | CANCELLED | FAILED
  errorDetails    Json?           @map("error_details")
  createdAt       DateTime        @default(now()) @map("created_at")

  assessment Assessment  @relation(fields: [assessmentId], references: [id], onDelete: Cascade)
  engagement Engagement  @relation(fields: [engagementId], references: [id], onDelete: Cascade)
  steps      AgentStep[]

  @@index([assessmentId])
  @@index([engagementId, createdAt])
  @@map("agent_runs")
}

enum AgentRunStatus {
  PROPOSED        // Plan surfaced to user; awaiting approval
  APPROVED        // User approved; queued
  RUNNING
  AWAITING_USER   // Blocked on `access.request` or a clarifying question
  COMPLETED
  BUDGET_EXHAUSTED
  CANCELLED
  FAILED
}

model AgentStep {
  id          String          @id @default(cuid())
  runId       String          @map("run_id")
  stepIdx     Int             @map("step_idx")
  kind        AgentStepKind
  // For PLAN / ASSISTANT: the model's text + reasoning trace.
  // For TOOL_CALL: the decoded tool-call request before dispatch.
  // For USER_INPUT: the user's answer to an AWAITING_USER prompt.
  payload     Json
  tokensIn    Int?            @map("tokens_in")
  tokensOut   Int?            @map("tokens_out")
  tokensCached Int?           @map("tokens_cached")
  costUsd     Decimal?        @map("cost_usd") @db.Decimal(10, 6)
  durationMs  Int?            @map("duration_ms")
  createdAt   DateTime        @default(now()) @map("created_at")

  run       AgentRun         @relation(fields: [runId], references: [id], onDelete: Cascade)
  toolCalls AgentToolCall[]

  @@unique([runId, stepIdx])
  @@index([runId, createdAt])
  @@map("agent_steps")
}

enum AgentStepKind {
  PLAN            // Planner's internal reasoning (cached; cheap to replay)
  ASSISTANT       // Assistant text emitted to user (rare — agent mostly tools)
  TOOL_CALL       // Wraps one or more AgentToolCall rows
  USER_INPUT      // Resumption payload from an AWAITING_USER pause
  BUDGET_DENIED   // Planner tried a call that would blow budget
}

model AgentToolCall {
  id           String           @id @default(cuid())
  stepId       String           @map("step_id")
  toolName     String           @map("tool_name")
  input        Json
  output       Json?            // Full output captured for replay
  outputSha    String?          @map("output_sha")   // Dedup key for identical calls
  status       ToolCallStatus
  error        String?
  durationMs   Int?             @map("duration_ms")
  sandboxUsed  Boolean          @default(false) @map("sandbox_used")
  evidenceIds  String[]         @default([]) @map("evidence_ids")  // Rows emitted by this call
  createdAt    DateTime         @default(now()) @map("created_at")

  step AgentStep @relation(fields: [stepId], references: [id], onDelete: Cascade)

  @@index([stepId])
  @@index([toolName])
  @@map("agent_tool_calls")
}

enum ToolCallStatus {
  OK
  FAILED
  TIMEOUT
  BUDGET_DENIED
  CANCELLED
}
```

Replay invariant: for any `AgentRun`, the concatenation of its
`AgentStep` rows in `stepIdx` order plus the captured `output` on
each `AgentToolCall` is sufficient to reconstruct exactly what the
model saw at every turn. This is what makes evals + regression
testing possible.

### 7. Evidence-row contract

Agent-emitted rows are indistinguishable from document / answer rows
to the downstream retriever — they go through the same `Evidence`
table, the same embedding pass, the same hybrid retrieval (ADR-0006)
during per-domain analysis. What makes them distinct is metadata:

- `sourceType = CONNECTOR`
- `chunkSource` (existing `Json?` column) carries the provenance
  envelope:
  ```json
  {
    "connector": "repo.scan_iac",
    "runId": "cmo7…",
    "stepIdx": 42,
    "provenance": { "kind": "repo", "repoRef": { "url": "...", "commitSha": "...", "path": "...", "lineRange": [12, 34] } }
  }
  ```
- `contentSha` deduplicates across multiple runs and multiple tools
  producing the same excerpt.
- `confidence` seeded by the tool (e.g. `gitleaks` hits → 0.95; a
  Claude-summarized observation → 0.6) and feeds the clusterer.

No schema change to `Evidence` is required for slice 1 — the existing
`CONNECTOR` enum value, `chunkSource` JSON, and `contentSha` dedup
all already cover this. The reviewer UI (existing evidence-explorer)
grows a provenance badge that reads `chunkSource.connector` and
renders the appropriate deep-link (repo URL + line number, CI run
URL, AWS console URL).

### 8. Security surface

A deliberate enumeration, because this is where the biggest delta
from the current product sits:

- **Credential isolation.** Every credential scope is namespaced
  (`github.pat`, `aws.assume_role_arn`, `gcp.workload_identity`) and
  scoped per engagement (ADR-0009 pattern). The harness never sees
  the whole set — a tool receives only the scopes it declared in
  `requiresCredentials`.
- **Sandboxing.** Any tool that executes customer code — linters,
  SAST, grep over a checkout — runs inside a Firecracker / Dagger
  sandbox with:
  - No network except an allowlist (language registries for
    dependency resolution, nothing else).
  - Read-only mount of the checkout; writes to an ephemeral FS.
  - CPU / memory / disk / wall-clock caps.
  - Egress blocked by default; individual tools declare the specific
    hosts they need.
- **Least-privilege cloud roles.** Cloud connectors assume a
  read-only role the customer provisions (Terraform module supplied).
  The harness refuses to run if the assumed role grants any `*:Create`,
  `*:Put`, `*:Delete`, or `iam:*` action.
- **PII / secret redaction.** Everything written to `AgentToolCall.output`
  passes through a redactor (`gitleaks`-style patterns + custom rules)
  before persistence. The model sees the unredacted output in-memory
  during the turn, but trajectory storage is redacted. A separate
  `AgentToolCallFull` table gated behind admin-only role holds the
  raw output for 7 days for incident debugging, then truncates.
- **Prompt injection.** Every tool output is wrapped in a
  structured envelope (`<tool_output tool="..." id="...">…</tool_output>`)
  and the system prompt explicitly instructs the model to treat tool
  output as untrusted data, not instructions. The sandbox also
  strips ANSI, control characters, and anything that looks like a
  nested prompt.
- **Audit trail.** Every run is a `RUN_AGENT` audit-log row at end;
  every user approval / credential read / cancellation is its own
  row. Mirrors the existing `RUN_ANALYSIS` pattern.

### 9. Failure + resumption

- A step-level failure (tool timeout, 5xx from a provider) is
  presented to the planner on the next turn, which may retry with
  different args or move on. The step is preserved; the planner's
  reaction is a new step.
- A harness-level failure (DB down, out-of-memory) ends the run
  with `FAILED` and preserves whatever `AgentStep` rows had
  committed. Trajectory is still replayable up to the failure point.
- `AWAITING_USER` pauses persist the run; the BullMQ job returns.
  When the user answers, a new `USER_INPUT` step is appended and
  a resumption job re-enters the loop from there.

## Alternatives considered

- **Full LangGraph port.** A graph-based agent framework (TS) with
  first-class checkpointing, interrupt-resume, and human-in-the-loop
  primitives. Rejected: heavier dependency surface, opinionated
  state-model we'd fight against for a single-planner shape, and
  core-value work we'd rather own. We can adopt it if the hand-rolled
  state machine bloats past ~1.5k LOC.
- **OpenAI Agents SDK / Anthropic managed agents.** Vendor-coupled;
  conflicts with the multi-provider direction (ADR-0015 pending).
- **Free-roaming agent that authors findings directly.** Rejected
  explicitly — destroys the auditability story. Findings must come
  from the deterministic synthesis pipeline over evidence the agent
  deposited; the agent never emits a finding.
- **Tool calls via MCP (Model Context Protocol).** MCP gives us a
  standard wire format for tool registration and would let us reuse
  community servers (GitHub MCP, AWS MCP). Attractive, but (a) our
  tools need evidence-emission semantics MCP doesn't natively
  express, (b) we want full-fidelity trajectory capture, which MCP
  servers don't guarantee. Revisit: wrapping key MCP servers behind
  our tool adapter if the community ecosystem matures.
- **Skip sandboxing; run tools in the worker process.** Rejected on
  security grounds. Linting or scanning untrusted customer code in
  the same process that holds DB credentials is the kind of mistake
  that ends a company.
- **Store trajectories in an external trace store (LangSmith /
  Braintrust) and not in Postgres.** Attractive for debugging; fails
  on "trajectories are product data and must survive the vendor
  going away." We'll send *copies* to a trace tool for observability
  but Postgres is the source of truth.

## Consequences

**Positive**

- The product can assess engagements where the client hands over
  "here's our GitHub org, here's our AWS account" instead of a PDF
  docset. This materially enlarges the buyer persona.
- Every new evidence source plugs into the same synthesis pipeline
  unchanged — the audit / reviewability story stays intact.
- Per-tool pricing and quality become first-class observables from
  day one (`AgentToolCall.costUsd`, `AgentToolCall.durationMs`,
  evidence volume). We can retire tools that don't pull their
  weight.
- Replayable trajectories make prompt-engineering regressions
  detectable instead of inferred from user complaints.

**Negative**

- Cost per assessment rises sharply on the upper end — a 2,000-file
  repo inspection can be $5–$50 of Claude spend depending on
  depth. Budget caps are the lever, but customers must see and
  approve the estimate.
- Security surface is qualitatively different: we now hold customer
  cloud roles and CI tokens. Pen-testing and a SOC2 audit move from
  "nice to have" to "table stakes for enterprise deals."
- Sandbox infra is a new operational concern: Firecracker workers,
  egress policies, image build pipelines. Two weeks of SRE work
  conservatively.
- The agent's quality is now a first-class eval problem. Without a
  replay suite and fixture engagements, agent-prompt changes silently
  degrade output. The eval harness is non-optional and is a
  significant engineering investment.

**Neutral**

- A new surface area (AgentRun / AgentStep / AgentToolCall) the UI
  team maintains in parallel with the existing Finding / Risk /
  Recommendation views. Shared components where possible, but
  trajectories are a different shape than outputs.

## Follow-ups

- [ ] ADR-0015: Multi-provider LLM routing (blocks this ADR's
      `modelFallback` semantics).
- [ ] ADR-0016: Sandboxed tool execution (Firecracker vs Dagger
      vs hosted — pick one, pin versions).
- [ ] ADR-0017: Agent eval harness (fixture-engagement format,
      replay runner, regression CI job).
- [ ] Prisma migration: `agent_runs`, `agent_steps`,
      `agent_tool_calls` tables + enums.
- [ ] Service module: `apps/web/src/server/services/agent/` with
      `harness.ts`, `tool.ts`, `registry.ts`, `budget.ts`,
      `trajectory.ts`, `evidence-emitter.ts`.
- [ ] New job: `queue/jobs/run-agent.ts` keyed by
      `agent-${runId}` (dedupe on the same id, following the
      post-2026-04-19 pattern).
- [ ] tRPC router: `agentRouter` with `propose`, `approve`,
      `cancel`, `status`, `trajectory`, `evidenceProduced`.
- [ ] UI: `/engagements/:id/agents` tab with plan proposal page,
      running-run dashboard, trajectory viewer, evidence diff.
- [ ] Slice 1 tool suite: repo.* + access.request + scratchpad.*.
- [ ] Slice 2: ci.*.
- [ ] Slice 3: cloud.*. Starts only after slices 1 and 2 have shaken
      out credential handling in production.
- [ ] Security: Terraform module for the read-only AWS assume-role,
      published alongside slice 3.
- [ ] Observability: LangSmith vs Braintrust pick, wired to
      `source='worker:agent'` log stream.

## References

- ADR-0002 per-domain fan-out — the synthesis layer this decision
  explicitly leaves alone.
- ADR-0009 per-engagement credentials — the credential model this
  ADR extends.
- ADR-0011 evidence traceability first-class — the contract agent
  evidence must satisfy.
- ADR-0012 prompt caching & cost instrumentation — applied to the
  harness system prompt.
- Anthropic: "Building effective agents" (engineering blog,
  2024-12-20).
- Vercel AI SDK: `generateText` with `maxSteps` and tool calls.
- Firecracker: microVM docs; Dagger: pipeline sandbox.
- `semgrep`, `trivy`, `syft`, `tfsec`, `checkov`, `gitleaks` —
  all BSD/MIT-licensed, all CLI-driven.
