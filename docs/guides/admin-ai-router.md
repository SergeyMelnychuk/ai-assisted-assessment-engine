# AI Router — end-to-end admin guide

This guide is the one-page reference for operators tending to the
assessment engine's AI routing. It covers what the router does, when
and why to change it, and the step-by-step for every common operation.

> **Scope.** Everything below lives under `/admin/settings` →
> **AI Router** tab. It only changes *which* model answers each AI call
> — it does not change assessment logic, prompts, or scoring
> thresholds.

---

## 1. What the router does

Every AI call in the product — writing a finding, scoring a domain,
generating a diagram, producing an embedding — is tagged with a
**task**. Each task is wired to:

1. A **primary** model+provider pair that handles the call by default.
2. An ordered list of **fallbacks** that take over if the primary
   fails with a *transient* error (rate limit, provider outage,
   timeout, connectivity blip).
3. The list of error classes that count as "transient" for this task.

Transient errors → automatic retry on the next provider. Deterministic
errors (wrong API key, request rejected by content filter, malformed
model id) short-circuit immediately, because swapping providers would
only burn more tokens without changing the outcome.

Every attempt — successful or not — writes an audit row with
`provider`, `model`, `task`, `routerReason`, and the token cost, so
the trail survives even when a fallback kicks in.

---

## 2. Feature flags

Optional product features are turned on and off from a **Feature
flags** card at the top of the AI Router tab. Flags are workspace-wide
and apply within a few seconds — no restart or redeploy. Every change
is written to the audit log so you can see who turned what on and
when.

Today there is one flag:

### Autonomous evidence collection

> **Rollout status: v1 shipped, GitHub-only.** The flag, the runtime
> UI, the JIT credential vault, the BullMQ-backed harness, the LLM
> planner, and the read-only GitHub adapter are all live. AWS and CI
> adapters are registered placeholders — see
> [What works today vs. what's coming](#what-works-today-vs-whats-coming)
> at the bottom of this section for the exact breakdown.

**What it does.** When on, every assessment shows an **Agent runs**
panel on its detail page. From there an engagement owner or admin can
ask the agent to gather evidence from external systems you connect at
runtime. v1 supports **read-only GitHub** access — list directories,
read files — and emits typed `Evidence` rows the existing analysis
pipeline already understands.

**It is an additional evidence source, not a replacement.** The
existing analysis pipeline (writing findings, scoring domains,
building deliverables) is unchanged. Turning this on only changes
*how evidence gets in*. Assessments you've already created keep
working exactly the same; the change is invisible to them until
someone opens the panel and starts a run.

#### How an autonomous run works end-to-end

1. **Turn the flag on.** AI Router tab → **Feature flags** card →
   **Turn on** next to *Autonomous evidence collection*. Effective
   in seconds. Without the flag the **Agent runs** panel doesn't
   render and every agent tRPC procedure returns NOT_FOUND.

2. **Open any assessment.** The **Agent runs** card sits on the
   assessment detail page below the project context summary. No
   per-assessment "evidence mode" picker — every assessment can
   start an agent run while the flag is on; permissions enforce who
   can use it.

3. **Start a run.** Two surfaces, same harness:
   - **Ask the agent to gather evidence** (default). Pass an
     explicit **Repository** (`owner/repo`, `owner/repo@branch`, or a
     full GitHub URL) plus a free-form **Goal** — *"Surface evidence
     about authentication and authorization across the codebase.
     Focus on security_iam."* The LLM planner (task `agent.planner`)
     decides which tool calls to issue, in what order, scoped to that
     repository. The repository is required — the planner will not
     guess a target from the goal text.
   - **Probe a single file** (advanced disclosure). Pass an explicit
     `owner / repo / path / domain`. Bypasses the planner entirely
     and dispatches a single `github.read_file` call. Useful when
     you know exactly what you want and don't want to pay for
     planner tokens.

4. **The run pauses for credentials.** When the harness needs a
   secret it doesn't already have (e.g. a GitHub PAT for this
   engagement), it opens an `AgentCredentialRequest`, transitions
   the run to `AWAITING_USER`, and returns the worker job. An
   amber **Agent paused — needs a GitHub credential** card appears
   at the top of the assessment page. **You are not asked upfront.**
   The prompt is JIT — the agent only asks when a tool call
   actually needs it.

5. **Provide the credential once.** Paste a fine-grained GitHub
   PAT (recommended scopes: `Contents: Read`, `Metadata: Read` on
   the relevant repos). The token is encrypted at rest with the
   engagement vault key (AES-256-GCM, same `REPO_CREDENTIAL_KEY`
   the existing repository links use). The credential is **engagement-
   scoped** — every future agent run on the same engagement reuses
   it, no re-prompt — until it expires (default 24 h) or is
   revoked.

6. **Watch the planner work.** The **Agent flow** diagram below the
   runs list visualises the trajectory in React Flow:
   - **Blue PLAN nodes** show each planner decision and its token
     cost.
   - **Green / red / amber TOOL nodes** show each dispatched tool
     call and its outcome (`ok`, `failed · github.unauthorized`,
     `pending`).
   - **Grey SYSTEM nodes** show harness bookkeeping (validation
     failures, allowlist rejections, planner stops).

   The diagram polls every 3 s while the run is non-terminal so it
   grows in step with the trajectory. Pan, zoom, inspect — it's
   read-only.

7. **Cancel any time.** Each non-terminal run row has a **Cancel**
   button. Cancellation transitions the run to `CANCELLED`,
   supersedes any open credential requests so the prompt closes,
   and writes an audit row. The current step finishes; nothing
   spawns after.

8. **Evidence lands.** Every successful tool call emits typed
   `Evidence(sourceType=CONNECTOR)` rows tagged with the domain
   you asked about. The `chunkSource` JSON carries the run id +
   step id + GitHub `htmlUrl` so a reviewer can trace any finding
   back to the originating tool call. The evidence is dedup'd on
   `contentSha` — re-reading the same file twice doesn't double-
   insert.

9. **Analysis proceeds as normal.** Per-domain synthesis, scoring,
   and deliverable generation run over the collected evidence
   exactly as they do for evidence sourced from documents or
   answers. The review-lock discipline (draft → in review →
   approved) is unchanged.

**Governance built in.** Approvals: only engagement OWNER and ADMIN
roles can start runs, cancel runs, or supply credentials. Every
lifecycle event (drafted, started, cancelled, credential fulfilled)
writes to the audit log. Every Evidence row links back to the exact
step that produced it. The harness is **single-writer per run** and
the trajectory is fully replayable from the persisted `AgentStep` /
`AgentToolCall` rows.

**Read-only.** The v1 GitHub adapter only reads — `github.list_repo_files`
and `github.read_file`, both pure GETs. There is no write tool, no
shell sandbox, no commit / PR / issue mutation surface. If a leaked
PAT was scoped to `Contents: Read` (recommended), the blast radius
is bounded to read-only access on the repos the user selected.

**Cost.** Planner-mode runs cost real Claude tokens on every PLAN
turn. The harness has a defensive cap of 16 planner turns per run;
the underlying `AgentRun.budget` JSON is the production-grade cap
(see ADR-0014 §5). Static tool-call runs (the `task: [...]` envelope
the tRPC `agentRun.draft` procedure still accepts for tests) spend
zero AI tokens — they execute a fixed tool sequence and stop. There
is no UI for that path today; planner-driven runs are the only way
to start an agent run from the assessment page.

#### When to turn it on

- You want to gather code-level evidence (e.g. auth flow, IAM
  posture, observability config) that's slow to extract by hand.
- You're A/B-ing the autonomous output against a manually-run
  assessment on the same engagement to build confidence.
- You're piloting the agent surface with a small set of internal
  engagements before a wider rollout.

#### When to leave it off

- The engagement's client has not consented to automated read-only
  access of their GitHub repositories.
- You're mid-engagement and don't want to expose the surface to end
  users yet.
- Per-engagement cost ceilings matter to you and the budget enforcer
  (Phase 4 Slice 4) is not yet wired against the planner's token
  spend in your build.

#### What works today vs. what's coming

| Capability | Status today | Notes |
|---|---|---|
| Flag toggle (AI Router tab → Feature flags) | **Live.** | When off, the panel and all `agentRun.*` tRPC procedures return NOT_FOUND. |
| Agent runs panel on assessment detail | **Live.** | Visible to every user with read access; only OWNER/ADMIN can start, cancel, or supply credentials. Single goal-input form (no Advanced disclosures). |
| Workflow planner (default) | **Live.** | Uses `agent.workflow_planner` task. Emits a graph of human-driven steps (UPLOAD_DOCUMENTS, CONNECT_REPOSITORY, GATHER_REPOSITORY_EVIDENCE, ANSWER_QUESTIONS, RUN_ANALYSIS, REVIEW_*, TEAM_ESTIMATE, GENERATE_DELIVERABLES, EVIDENCE_REVIEW, EXPORT) rendered as an interactive React-Flow diagram. Auto re-plans when a step is marked complete. |
| Tool-call planner (autonomous evidence on one repo) | **Live.** | Uses `agent.planner` task. Emitted by the workflow planner as a GATHER_REPOSITORY_EVIDENCE step body, or driven directly by the static `task: [...]` tRPC envelope (no UI form for that today). Defensive cap: 16 planner turns / run. |
| GitHub read tools | **Live.** | `github.read_file`, `github.list_repo_files`. Bearer-auth GETs against `api.github.com`, classified error mapping (401 / 403 / 404 / 422 / 5xx). |
| Per-step status state machine | **Live.** | `WorkflowStepStatus` row per `(runId, nodeId)`. Save note / Mark complete / Roll back. BLOCKED gating enforced server-side. Soft status falls back to data-derived signal when no explicit lock exists. |
| JIT credential prompt | **Live.** | Inline amber card at the top of the assessment page. Polls every 5 s. Encrypts the PAT with the engagement vault key. |
| Engagement-scoped vault | **Live.** | One row per `(engagementId, scope)`. 24 h default TTL. Soft-revoke (audit-preserving). |
| BullMQ-backed harness | **Live.** | One job per dispatch (start + each credential resume). Stable jobId per run collapses concurrent enqueues. |
| Cancel button | **Live.** | Per-row on non-terminal runs. Supersedes pending credential requests. |
| React Flow trajectory diagram | **Live.** | Read-only. Polls while the run is non-terminal so it grows live. |
| Evidence in the explorer | **Live.** | Rows land as `sourceType=CONNECTOR` with `chunkSource = { origin: "agent", runId, stepId, provenance }`. Dedup on `contentSha`. |
| Synthesis / scoring / deliverable | **Live.** | No changes required — the pipeline consumes evidence identically regardless of how it got in. |
| Vector embeddings on agent-emitted evidence | **Coming.** | v1 lands rows without embeddings; keyword/domain retrieval surfaces them, vector search misses them until backfill. |
| AWS adapter (`aws.assume_role_arn` scope) | **Coming.** | Credential scope registered; tools not implemented. |
| CI adapter (Jenkins / GitHub Actions tokens) | **Coming.** | Same — slot reserved, no tools registered. |
| Per-engagement cost ceilings | **Coming.** | The harness honours `AgentRun.budget.maxSteps` defensively; planner-token enforcement against `maxTokens` is Phase 4 Slice 4. |
| `access.request` / clarifying questions | **Coming.** | `ToolContext.ask` is stubbed and throws; the planner can't yet ask a free-form question of the user mid-run (only credential prompts pause the run today). |
| Streaming planner output | **Coming.** | Planner round-trips one full response per turn (~2–5 s on Claude Sonnet 4.7). Streaming + early dispatch is a future optimization. |
| Resume short-circuit | **Coming.** | When a planner-mode run pauses on a credential and resumes, the planner is called again from turn 0 (it sees the prior PLAN step in the trajectory and usually re-emits the same decision — costs one extra planner call per pause). |

---

## 3. The task catalogue

| Task                | Purpose                                                              | Cost profile |
| ------------------- | -------------------------------------------------------------------- | ------------ |
| `analysis.synthesis`| Main per-domain analysis: reads evidence, writes findings/risks      | 🔴 high      |
| `analysis.verifier` | Second-opinion pass that flags ungrounded claims                     | 🟡 medium    |
| `analysis.scoring`  | 1–5 maturity score + short rationale per domain                      | 🟢 low       |
| `deliverable.section` | Narrative writeups for the final client deliverable                | 🟡 medium    |
| `diagram.generate`  | Mermaid source for architecture/data-flow diagrams                   | 🟢 low       |
| `diagram.parse`     | Vision: extract structure from an uploaded diagram image             | 🟡 medium    |
| `estimation`        | Draft role/hours estimate from findings + rate card                  | 🟢 low       |
| `followups.generate`| Targeted follow-up questions to close evidence gaps                  | 🟢 low       |
| `agent.planner`     | Agent harness planner — picks the next tool call (ADR-0014)          | 🟡 medium    |
| `embedding.ingest`  | Document chunk → 1536-dim vector for pgvector                        | 🟢 low       |
| `embedding.query`   | Query string → vector at retrieval time                              | 🟢 low       |

"Cost profile" is a rough indicator of how much each call contributes
to an assessment's total spend — swapping the model on a 🔴 task has
far more budget impact than on a 🟢 one.

---

## 4. Common operations

### 3a. Pin a task to a specific model (override)

Use this when:

- Anthropic has a noisy deploy and you want to force GPT-5 for 24 h.
- You're running an A/B quality check on a new model snapshot.
- A model id has been deprecated and the provider returns 404 — pin
  the task to a known-good snapshot until the registry default is
  updated.

Steps:

1. Open **Admin → Settings → AI Router**.
2. Find the task card you want to change.
3. Pick the **Provider** from the dropdown.
4. Enter the exact **Model id** the provider expects
   (`claude-sonnet-4-7`, `gpt-5-mini`, `anthropic.claude-haiku-4-5`, …).
5. Write a **Reason** (≥ 3 chars). This is the audit trail — future
   you will thank present you.
6. Click **Set override**.

The change is effective on the next `callAi()`. No redeploy.

### 3b. Revert an override

On any task card that has "Manual override active", click
**Revert to default**. The row is deleted and the task returns to the
shipped default.

### 3c. Inspect routing decisions

Every AI call emits an `AI_CALL` audit row containing:

- `task` — which task handled the call
- `provider`, `model` — what actually ran
- `routerReason` — `null` for a clean primary success, or
  `{from: "anthropic:claude-sonnet-4-7", failoverClass: "rate_limit"}`
  when a fallback took over
- `inputTokens`, `outputTokens`, `estimatedCostUsd`

Query them from **Admin → Settings → AI Usage**, or directly in the
database (`AuditLog WHERE action = 'AI_CALL'`).

---

## 5. Decision guide — when to change what

### 4.1 "Anthropic is throwing 429s"
**No action needed.** The router already treats 429 as transient and
hops to Bedrock/OpenAI for affected tasks. Watch the **AI Usage** tab
— if `routerReason = rate_limit` rows dominate for more than a few
minutes, raise the rate tier with Anthropic rather than pinning an
override.

### 4.2 "We're over budget this month"
Swap heavy tasks (🔴/🟡) to cheaper models for the rest of the cycle.
Candidates:

- `analysis.synthesis` → `claude-haiku-4-5` (~3× cheaper, ~20% weaker
  on complex domains — monitor finding quality).
- `deliverable.section` → `gpt-5-mini` or `mistral-large-latest`.
- `analysis.scoring` is already on Haiku — no room to save there.

### 4.3 "A new model just shipped, we want to try it"
Set an override on **one** task at a time (start with
`analysis.scoring` or `followups.generate` — low blast radius), run a
fresh assessment, eyeball the output, then promote to bigger tasks if
happy.

### 4.4 "A provider API key is missing in prod"
Don't set overrides to "fix" this — the router will short-circuit on
the auth error either way. Fix the key in the env and let the defaults
stand.

---

## 6. Fallback chains at a glance

The shipped defaults (ADR-0015) are:

- **Analysis + deliverable + diagram + agent** →
  Anthropic → Bedrock (same Claude) → OpenAI GPT-5
- **Scoring + follow-ups** →
  Anthropic Haiku → OpenAI GPT-5 mini (+ Mistral Small for follow-ups)
- **Embedding (ingest)** →
  OpenAI text-embedding-3-small → Amazon Titan v2
- **Embedding (query)** →
  OpenAI only. **No fallback** — mixing embedding spaces across
  ingest/query corrupts cosine similarity; fallback would do more
  harm than good.
- **Diagram (vision)** →
  Anthropic only for now. Vertex Gemini 2.5 Pro is the planned
  second-line once credentials are provisioned.

---

## 7. Provider credentials (env-only)

Provider credentials are **not** stored in the database. Each provider
adapter reads its keys from environment variables at call time, using
the Vercel AI SDK's standard variable names:

| Provider         | Env vars (minimum to be "configured")                                                     |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Anthropic        | `ANTHROPIC_API_KEY`                                                                        |
| AWS Bedrock      | `AWS_REGION` + one of `AWS_ACCESS_KEY_ID` / `AWS_PROFILE` / `AWS_ROLE_ARN`                 |
| OpenAI           | `OPENAI_API_KEY`                                                                           |
| Azure OpenAI     | `AZURE_API_KEY` (or `AZURE_OPENAI_API_KEY`) **and** `AZURE_RESOURCE_NAME`                  |
| Google Vertex    | `GOOGLE_VERTEX_PROJECT` **and** (`GOOGLE_APPLICATION_CREDENTIALS` or workload identity)    |
| Mistral          | `MISTRAL_API_KEY`                                                                          |

The AI Router tab shows a **Provider credentials** panel listing each
provider with a "Configured / Not configured" badge driven by a
server-side env probe. Providers that aren't configured are
**disabled** in the override dropdown, and the tRPC `upsert` refuses
to save an override pointing at an unconfigured provider — so the
failure is visible in the admin UI rather than at assessment time.

**Adding a new provider in production:** set the env vars on the
deployment, redeploy (or restart), and the badge flips to
"Configured". There is no in-app vault — a DB-backed credential store
is deliberately out of scope for this product's single-tenant model.

---

## 8. Concurrency &amp; pacing

At the bottom of the AI Router tab there's a **Concurrency & pacing**
section with two knobs:

- **Per-domain analysis concurrency** (1–8, default 1): how many
  per-domain `analysis.synthesis` calls run in parallel per
  assessment.
- **Inter-call delay (ms)** (0–30 000, default 0): pause inserted
  between consecutive analysis calls.

These throttle the *analysis-engine's* worker pool, **not** a
specific provider. A single pool is shared across the fallback chain:
if a call flips from Anthropic → Bedrock → OpenAI, it still occupies
one slot the whole time. That's why there is one global knob rather
than one per provider — a per-provider split would lead to surprising
ceilings during failover.

The recommendation panel computes a suggested pairing from the
reference model's Anthropic tier. Today that reference is
`ANTHROPIC_MODEL` (env var); if/when `analysis.synthesis` stops
being served primarily by Anthropic, the recommendation should
re-derive from the effective binding — that's a known follow-up.

These settings used to live under a separate `?tab=settings`
"Concurrency" tab; the URL still resolves and now lands on the AI
Router tab.

---

## 9. Safety rails worth knowing

- **Dimension invariant on embeddings.** The pgvector index is pinned
  at 1536 dimensions. If an operator points `embedding.ingest` at a
  model that returns a different size (e.g. Titan v2 default 1024),
  the router **refuses to write** and surfaces
  `EMBEDDING_DIM_MISMATCH`. This is intentional — silent index
  corruption would poison every future retrieval.
- **No retry on deterministic errors.** Auth / schema / content-filter
  failures throw immediately. The retry budget exists for outages,
  not for misconfiguration.
- **Per-call timeout.** 120 s hard cap per attempt. A hung provider
  can't hold a worker slot indefinitely.
- **Prompt caching.** Anthropic ephemeral cache is on for
  `analysis.synthesis`, `analysis.verifier`, `deliverable.section`,
  and `agent.planner` so long system prompts are read-cached across
  calls at ~10% the input-token cost.

---

## 10. FAQ

**Q: I set an override — do I need to redeploy or restart?**
No. The in-process registry cache is invalidated when you save, and
every subsequent `callAi()` sees the new binding.

**Q: What happens during an active assessment if I change a binding?**
In-flight calls finish on whatever they started with. Any call that
starts *after* the save picks up the new binding. The audit row
records exactly which model served each call.

**Q: Can I set overrides to expire automatically?**
The schema supports `expiresAt`, but the current UI doesn't expose it
yet. Use the DB directly (`AiModelOverride.expiresAt`) if you need a
time-boxed pin — the router already respects it.

**Q: Can I change *fallbacks* (not just the primary)?**
Not from this UI yet — set the primary only. Fallback-chain edits
require a deploy (they live in the default registry) unless you use
the DB directly.

**Q: How do I know an override is actually in effect?**
Look at the task card: it will show an amber "Manual override active"
banner with your reason. Cross-check by triggering an assessment and
inspecting the latest `AI_CALL` audit row for that task.
