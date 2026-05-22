# Phase 4 — Agentic AI Roadmap

> **Status:** ongoing — Slices 0, 1 and 3.5 shipped (with major
> deviations from the original slice plan, listed below). Slice 2 is
> partial. Slice 3 (cost guardrails) is not shipped; per-assessment
> `evidenceMode` picker is in place but the projector / ceiling /
> role gating did not land. Phase 4 also delivered a substantial body
> of work that wasn't on the original plan — see "Phase 4 work that
> landed outside the original slice plan" below. Updated 2026-05-13.
> **Duration:** ~6 weeks of focused solo work (parallelisable to ~4
> with a pair).
> **Outcome:** Assessments can opt into `evidenceMode=AGENTIC` at
> creation time. An approved agent run collects evidence from
> connected external systems (repos, CI, cloud read-only), emits
> `Evidence(sourceType=CONNECTOR)` rows that feed the existing
> deterministic synthesis pipeline unchanged, and produces a fully
> auditable trajectory (`AgentRun` / `AgentStep` / `AgentToolCall`).
> MANUAL stays the default and remains load-bearing.

This roadmap is the successor to Phase 3
([`phase-3-roadmap.md`](./phase-3-roadmap.md)), which delivered
retrieval-augmented, per-domain, real-world-volume analysis over
manually-provided evidence. Phase 4 keeps the synthesis layer exactly
as it is and adds a new evidence *source* upstream: an autonomous
agent harness.

The ADRs that underlie every slice below:

- [ADR-0014](../architecture/decisions/0014-agent-harness-for-evidence-collection.md)
  — agent harness contract (tool protocol, budget shape, trajectory
  tables).
- [ADR-0017](../architecture/decisions/0017-dual-mode-evidence-collection.md)
  — `EvidenceMode` per-assessment toggle, two-layer rollout (platform
  flag + per-assessment field), side-by-side not swap.
- [ADR-0015](../architecture/decisions/0015-multi-provider-llm-routing.md)
  — `agent.planner` is a registered task; no routing changes needed.
- [ADR-0013](../architecture/decisions/0013-analysis-mode-and-verifier-pass.md)
  — `evidenceMode × mode` compose orthogonally.
- [ADR-0011](../architecture/decisions/0011-evidence-traceability-first-class.md)
  — traceability guarantees the agent must preserve.
- **Sandbox/exec policy ADR (pending, not yet numbered).** ADR-0018
  was originally reserved for this; the number was reused for
  customer-uploadable templates instead. Slice 5 (exec-tier tools)
  is blocked on a new ADR covering sandboxing.

The short version:

1. **Agent is a source, not a replacement.** Deterministic per-domain
   synthesis (ADR-0002, ADR-0013) stays intact. The agent writes
   `Evidence` rows; synthesis consumes them the same way it consumes
   document- or answer-sourced evidence.
2. **Human-in-the-loop at the plan boundary.** Every `AgentRun` starts
   as `PENDING` with a rendered plan. Nothing executes until an admin
   (or, later, an engagement-scoped role) approves.
3. **Read-only by default.** Slice 1 ships with zero exec-tier tools.
   Exec/edit tools land only after the sandbox ADR (0018) is accepted
   and wired.
4. **Strict audit chain.** `Finding → Evidence → chunkSource →
   AgentToolCall → AgentStep → AgentRun`. No evidence row exists
   outside a tool call; no tool call runs without an approved run.

## How to use this doc

- Each task has a checkbox. Tick it (`- [x]`) when the task is done
  and merged. Commit the doc update in the same PR as the task.
- Slice summaries list an **acceptance criterion** — the thing you
  should be able to demo at end-of-slice. If that doesn't hold, the
  slice isn't done.
- Slices are ordered by dependency. Slice 0 is the foundation;
  Slice 1 delivers a working read-only harness; Slices 2–5 are layered
  capability, governance, and retirement prep.
- **Effort estimates are solo working-day guesses.** Halve them with
  a competent pair.

See the [dependency graph](#dependency-graph) at the bottom.

---

## Principles carried from Phase 3

Preserve these patterns. New Phase 4 code conforms:

- **Review-lock discipline** — AGENTIC-sourced evidence lands as
  `DRAFT` the same way every other evidence row does. Findings over
  agentic evidence are first-class DRAFT rows; human edits flip to
  `IN_REVIEW`.
- **Error classifier + FailureBanner** — every new worker / tool
  surface routes errors through `classifyProcessingError()` (extended
  with agent-specific classes: `BUDGET_EXHAUSTED`, `TOOL_TIMEOUT`,
  `SANDBOX_REFUSED`, `PLAN_REJECTED`).
- **Bounded polling** — agent run detail pages use
  `useBoundedPolling()`; no raw `refetchInterval`.
- **NOT_FOUND over FORBIDDEN** — every agent-tRPC route returns
  `NOT_FOUND` when `features.agentEnabled` is off, matching the admin
  route pattern.
- **No automatic retries on deterministic errors** — the router's
  rule applies to tools too: a tool that returns
  `errorClass: "AUTH"` short-circuits the step; transient classes
  (`RATE_LIMIT`, `TIMEOUT`) can retry within budget.
- **Docs, ADRs, tests land in the same PR** — no "we'll ADR it
  later". New tool scopes especially: scope escalation (read → write
  → exec) is an ADR-worthy decision.

---

## Rollout shape (from ADR-0017)

The two axes compose as:

| `evidenceMode` × `mode` | What runs |
|---|---|
| `MANUAL` × `FAST` | Today's baseline. |
| `MANUAL` × `THOROUGH` | Today's verifier mode. |
| `AGENTIC` × `FAST` | Agent pre-populates evidence, then one-shot synthesis. |
| `AGENTIC` × `THOROUGH` | Agent + verifier. Most expensive. |

Platform flag `features.agentEnabled` gates the whole feature until
Slice 3. Per-assessment `evidenceMode` becomes user-selectable in
Slice 3 once the cost guardrails ship.

---

## Slice 0 — Foundation (schema, skeleton, flag, prompt)

**Duration:** 3–4 days.
**Dependency:** none.
**Acceptance:** migrations applied on dev, `pnpm type-check` clean,
agent services importable but all stubs throw
`"not implemented — Slice 1"`; `isAgentEnabled()` reads env; planner
prompt + version constant exported.

This slice lands nothing user-visible. It's the foundation every
later slice assumes.

### Tasks

- [x] **Prisma schema** — add `AgentRun`, `AgentStep`,
      `AgentToolCall` tables, `EvidenceMode` enum on `Assessment`
      (default `MANUAL`), plus the status/kind enums. Migration name
      `add_agent_harness_tables`.
- [x] **Agent services skeleton** at
      `apps/web/src/server/services/agent/`:
      `types.ts`, `tool.ts`, `registry.ts`, `budget.ts`,
      `trajectory.ts`, `evidence-emitter.ts`, `harness.ts`,
      `index.ts`. All runtime stubs throw `"not implemented —
      Slice 1"`.
- [x] **Feature flag** — DB-backed `Setting("features.agentEnabled")`,
      `isAgentEnabled(db)` helper, admin toggle card on the AI Router
      tab, README note. No env var (redeploy-free by design).
- [x] **Planner system prompt** —
      `apps/web/src/server/services/ai/prompts/agent-planner.ts`
      with version constant `0.1.0`, static prompt (cache-friendly),
      `buildAgentPlannerPrompt(runContext)` composer.
- [x] **Documentation & tests**
  - [x] Update `docs/architecture/README.md` §7 with the new tables
        and the `EvidenceMode` axis.
  - [x] Reconcile ADR-0014 §6 field names with the shipped Prisma
        schema (idx/inputTokens/outputTokens/argsJson/resultJson/
        errorClass). Recorded in-place as an errata block at the top
        of §6.
  - [x] Add an "Agentic AI" stub section to
        `docs/architecture/README.md` §6 pointing at ADR-0014 /
        ADR-0017 / this roadmap.

---

## Slice 1 — Read-only harness MVP

**Duration:** 8–10 days.
**Dependency:** Slice 0.
**Acceptance:** with `features.agentEnabled=true` on dev, an admin
can POST a planned run against a test assessment, approve it, and
watch the harness loop call two read-only tools (HTTP GET + repo
metadata fetch), emit ≥1 `Evidence(sourceType=CONNECTOR)` row, and
write a complete trajectory. The evidence row is visible in the
existing evidence explorer. Synthesis over that evidence works
end-to-end.

### Tasks

- [x] **Trajectory service** — `trajectory.ts` with `createRun`,
      `appendStep`, `recordToolCall`, `updateToolCall`, `finishRun`.
      Writes transactional; `idx` monotonic per parent.
- [x] **Budget tracker** — `BudgetTracker` increments usage, throws
      `BudgetExhaustedError` when any ceiling crosses; surfaces to
      harness as a terminating condition.
- [x] **Evidence emitter** — `emitEvidence(ctx, drafts)` writes
      `Evidence(sourceType=CONNECTOR)` rows. `chunkSource` carries
      the originating step / tool-call ids.
- [x] **Harness loop** — plan → observe → dispatch → record.
      Planner call routed via `callAi({ task: "agent.planner" })`
      with prompt-caching on.
- [x] **Tool registry + first tool set** — `agent/tools/github.ts`
      exposes a small set of read-only repo metadata / file fetch
      operations. Reuses the engagement-scoped PAT from the
      `AgentCredential` vault (ADR-0022).
- [x] **tRPC routes** at `agentRun.ts` (kept on the per-engagement
      router rather than admin-only): `draft`, `start`, `cancel`,
      `get`, `getByAssessment`, `workflowSnapshot`, `markStep`,
      `rollbackStep`, `pendingCredentials`, `submitCredential`,
      `replayToolCall`, `addAnnotation`, `resolveAnnotation`,
      `archive`. All routes NOT_FOUND when `features.agentEnabled` is
      off (ADR-0023).
- [x] **BullMQ job** `agent-harness` — picks up APPROVED runs, calls
      `runAgent(runId)`, writes terminal state. `attempts: 1` (no
      auto-retry). Same shared `document-processing` queue, not a
      separate worker process.
- [x] **In-app UI** — shipped as a richer surface than the original
      `/admin/agent-runs` MVP. The workflow popup (per assessment)
      hosts agent-mode evidence collection per workflow step
      (ADR-0021); the `AgentFlowDiagram` provides five tiers of trace
      inspection (ADR-0026). The standalone admin agent-runs view
      remains optional.
- [x] **Assessment creation** — `Assessment.evidenceMode` is wired
      end-to-end; the picker is gated by `features.agentEnabled`.
- [x] **Documentation & tests**
  - [x] ADR-0014 (harness) + ADR-0017 (dual-mode) + ADR-0021
        (workflow planner) + ADR-0026 (trace viewer) document the
        delivered surface.
  - [x] Unit tests for `BudgetTracker`, plan parser, trajectory
        idx-monotonicity.
  - [ ] Integration test (Testcontainers): end-to-end PENDING →
        APPROVED → SUCCEEDED with a mock tool emitting evidence.
        Smoke scripts cover the live happy path; the
        Testcontainers-based version is still outstanding.

---

## Slice 2 — More read-only connectors + retrieval integration

**Duration:** 5–7 days.
**Dependency:** Slice 1.
**Acceptance:** an AGENTIC run over a seeded engagement produces
enough evidence that per-domain synthesis retrieves agent-emitted
chunks via the existing pgvector path. No deterministic behaviour
regressions on a MANUAL control assessment run against the same
seed.

### Tasks

- [ ] **`ci.status` tool** — read GitHub Actions / GitLab CI latest
      run summary per repo.
- [ ] **`cloud.readonly.inventory` tool** — read-only AWS inventory
      (configured accounts only, IAM read-only role). Returns a
      compact JSON summary; redacts ARNs in trajectory store.
- [x] **Chunking + embedding for agent-emitted evidence** — reused
      the ingest chunker; the emitter writes `Evidence(sourceType=CONNECTOR)`
      rows with embeddings via the same `embedding.ingest` AI-router
      task path. Synthesis retrieves agent-emitted chunks unchanged.
- [x] **Evidence explorer signal for agent-sourced rows** — surfaced
      via the per-domain tagging (ADR-0024) and the `EvidenceCitation`
      component (ADR-0028). A dedicated "Source: agent run #N" badge
      that links back to the run detail is still outstanding.
- [ ] **Documentation & tests**
  - [ ] Tool catalogue doc (`docs/guides/admin-agent-runs.md`) — not
        written; the workflow-popup-driven flow made the original
        admin-runs guide less central. Agent surface is described in
        ADR-0014 / 0021 / 0026 instead.
  - [ ] Integration test: synthesis run retrieves at least one
        agent-emitted chunk for a seeded domain.

---

## Slice 3 — Per-assessment rollout + cost guardrails

**Duration:** 4–5 days.
**Dependency:** Slice 2.
**Acceptance:** an engagement admin (not just platform admin) can
select `AGENTIC` when creating an assessment, sees the projected
cost, and is blocked from exceeding a configured ceiling. Platform
admin can still override on any assessment.

### Tasks

- [ ] **Cost projector** — not shipped.
- [ ] **Per-tenant cost ceiling** — not shipped. (Multi-tenancy
      itself is still on the post-Phase-3 backlog per architecture
      §15.)
- [ ] **Per-assessment budget override** — not shipped; the harness
      seeds `AgentRun.budget` from a hard-coded default
      (`defaultBudget()` in `agentRun.ts`).
- [ ] **Role gating** — not shipped; the agent flow is currently
      gated by the platform flag `features.agentEnabled` only, with
      the per-step explicit-lock model from ADR-0021 doing the
      governance work in practice.
- [x] **Per-assessment `evidenceMode` picker** — wired end-to-end
      and gated by the platform flag, even though the surrounding
      cost-guardrail scaffolding above didn't land.
- [ ] **Documentation & tests**
  - [ ] `docs/guides/agentic-evidence-mode.md` — not written.
  - [ ] Unit tests on the cost projector — N/A until the projector
        lands.

---

## Slice 3.5 — Comparison UI (parallel-running signal)

**Duration:** 3–4 days.
**Dependency:** Slice 3 (but can start in parallel with 3).
**Acceptance:** a reviewer can open an assessment that has both
MANUAL and AGENTIC evidence generations and see, per finding,
which evidence each generation would have cited.

This is the cheapest eval we'll ever have — classic output is the
oracle. Without it, ADR-0017's retirement criterion has nothing to
fire on.

### Tasks

- [ ] **Generation model** — `Evidence` does not carry a `generation`
      discriminator. Runs can be re-fired and the new evidence rows
      stack alongside old ones; nothing tags which generation
      produced what.
- [x] **Run-comparison view** — shipped as ADR-0026 Tier 5
      (`agent-run-compare.tsx`). Lets reviewers compare two agent
      runs against one another, including emitted evidence per step.
      The reframed scope is *run vs run*, not *MANUAL vs AGENTIC*;
      the latter still needs a parallel-run shape that wasn't built.
- [ ] **CSV export of comparison data** — not shipped.
- [ ] **Documentation & tests**
  - [x] ADR-0026 covers the comparison surface that landed; the
        "manual vs agentic" framing in the original slice description
        wasn't realised.

---

## Slice 4 — Eval harness

**Duration:** 5–7 days.
**Dependency:** Slice 3.5 (needs the comparison view's
generation-aware data model).
**Acceptance:** a recurring job runs the planner prompt against a
frozen set of 20 evaluation scenarios and emits a regression report
against the previous baseline. Regressions block the prompt-version
bump.

### Tasks

- [ ] **Scenario fixtures** — seeded engagements + expected-evidence
      rubrics under `packages/eval-seed/`.
- [ ] **Eval runner** — Vitest + Testcontainers; runs a full
      APPROVED → SUCCEEDED cycle per scenario with deterministic tool
      mocks.
- [ ] **Metrics** — precision / recall of emitted evidence against
      rubric; plan-step divergence from golden trajectories.
- [ ] **CI integration** — eval runs on any change under
      `services/agent/**` or `prompts/agent-planner.ts`; PRs with
      regressions need explicit "regression accepted" label to merge.
- [ ] **Documentation & tests**
  - [ ] ADR on the eval methodology (scenario design, rubric format,
        what counts as a regression).

---

## Phase 4 work that landed outside the original slice plan

The slice plan above predicted the agent-harness arc and stopped
there. In practice Phase 4 delivered substantial work that wasn't
on the slice list, mostly driven by user-facing gaps that emerged
once the harness was running. Each is a separate ADR:

| ADR | What landed | Why it wasn't in the slice plan |
|---|---|---|
| [0021](../architecture/decisions/0021-workflow-planner.md) — Workflow planner | A React-Flow graph of human-driven steps that an LLM planner emits and re-plans; the agent runs slot into specific nodes (e.g. `GATHER_REPOSITORY_EVIDENCE`). | The original plan envisioned a separate `/admin/agent-runs` route. Once we had the harness working, it became clear the planner UX needed to be inside the assessment flow, not in an admin sidebar. |
| [0022](../architecture/decisions/0022-agent-credential-vault.md) — Agent credential vault | Generalises the ADR-0009 PAT-per-engagement pattern to arbitrary scoped credentials; all PATs migrated off the legacy `RepositoryLink` columns. | Slice 3 referenced "PAT consolidation" obliquely; this ADR is the actual decision. |
| [0023](../architecture/decisions/0023-db-backed-feature-flags.md) — DB-backed feature flags | Moved `features.agentEnabled` (and three other flags) out of env vars into a `Setting` row, admin-toggleable without redeploy. | Slice 0 assumed an env flag; redeploy friction made that untenable. |
| [0024](../architecture/decisions/0024-per-domain-evidence-tagging.md) — Per-domain evidence tagging | Three complementary mechanisms (upload-time picker, AI auto-classifier, manual re-tag) so the Evidence Explorer's domain filter is meaningful. | Discovered while exercising the agent that the `"ingested"` catch-all was hiding real signal. |
| [0025](../architecture/decisions/0025-engagement-deletion-storage-sweep.md) — Engagement deletion + MinIO sweep | ADMIN-only cascade delete with best-effort MinIO key cleanup. | Production hygiene; not part of the agent slice plan. |
| [0026](../architecture/decisions/0026-agent-trace-viewer.md) — Agent trace viewer | Five-tier inspection surface (`AgentFlowDiagram` + side panel + minimap + replay + reviewer annotations + run-comparison dialog + replay-tool-call mutation). | Slice 1 listed a basic "detail view"; reviewers needed considerably richer inspection once real runs started failing in subtle ways. |
| [0027](../architecture/decisions/0027-hybrid-retrieval-rrf.md) — Hybrid retrieval | Postgres `tsvector` + cosine fused via Reciprocal Rank Fusion behind `features.hybridRetrieval`. | Closes the exact-string gap pure cosine had — version numbers, error codes, file paths, rare acronyms. Independent of the agent but shipped in Phase 4. |
| [0028](../architecture/decisions/0028-evidence-citations.md) — Evidence citations + context popup | Single `EvidenceCitation` component across every reviewer surface; click-to-open chunk context-window dialog; repo-archive children render as repo files with provider icons. | Flowed from agent-emitted evidence being harder to interpret without a richer citation surface. |

The original Slice 3 (cost guardrails) didn't land. Slices 4 and 5
were never started; the eval harness in particular remains a real
gap before the ADR-0017 retirement criterion can fire.

## Slice 5 — Exec-tier tools (blocked on sandbox ADR)

**Duration:** TBD. Scoped after the sandbox ADR lands.
**Dependency:** sandbox-policy ADR (originally reserved as ADR-0018,
re-numbering needed since 0018 is now templates) + Slice 4 (eval
harness to catch regressions from scope escalation).
**Acceptance:** **not planned for this phase.** This slice is
listed so the roadmap captures the full arc; it ships in a follow-on
phase once sandboxing is designed.

### Scope sketch (for ADR-0018 input, not commitments)

- `shell.run` with container-sandboxed, network-isolated exec; no
  host filesystem access; time/memory capped.
- `repo.clone` + bounded read of working tree for static analysis
  tools (semgrep, licensee, etc.).
- Per-tool network allowlists distinct from the read-only HTTP
  allowlist.

---

## Retirement prep (Phase 4 exit criterion)

Before Phase 5 can start, the ADR-0017 retirement criterion needs
either a "met" or "not met yet" determination with numbers behind
it. This is not a slice — it's a checklist run at end of phase:

- [ ] **Adoption** — % of net-new assessments picking AGENTIC (target
      per ADR-0017 follow-up: ≥60% after 6 months GA).
- [ ] **Eval parity** — Slice 4 regression reports across 3
      consecutive prompt bumps trending flat or better.
- [ ] **Support ticket rate** — AGENTIC ticket rate within 1.5×
      MANUAL.
- [ ] **Cost profile** — median AGENTIC cost within the
      per-engagement ceiling; p95 within 2× median.

If all four hold, file a deprecation ADR for MANUAL. If any doesn't,
extend dual-mode one more quarter and re-check.

---

## Cross-cutting tracks

Same three tracks as Phase 3 (documentation, testing, diagrams).
Phase-4-specific notes:

### Documentation
- Every new tool gets a row in `admin-agent-runs.md`'s tool
  catalogue with scope, inputs, outputs, failure modes.
- Every scope escalation (read → write → exec) is an ADR, not a PR
  description.

### Testing
- New tier: **eval tier** (Slice 4). Runs nightly + on planner-prompt
  changes.
- Agent integration tests always use mocked tool executors; real
  connectors live in smoke tests.

### Diagrams
- Sequence diagram for APPROVED → SUCCEEDED in
  `docs/architecture/diagrams/`.
- Update the engagement-flow overview tile set: add a branch
  arrow from "Intake" → "Agent run" → "Evidence" when
  `evidenceMode=AGENTIC`.

---

## Dependency graph

```
Slice 0 (foundation)
   │
   ▼
Slice 1 (read-only harness)
   │
   ▼
Slice 2 (more connectors + retrieval)
   │
   ├──────────────┐
   ▼              ▼
Slice 3         Slice 3.5
(rollout +      (comparison UI)
 guardrails)        │
   │                │
   └───────┬────────┘
           ▼
       Slice 4 (eval harness)
           │
           ▼
       [Sandbox ADR lands]
           │
           ▼
       Slice 5 (exec tier)  [follow-on phase]
           │
           ▼
   Retirement prep checklist
```

---

## References

- [ADR-0014 — Agent harness for evidence collection](../architecture/decisions/0014-agent-harness-for-evidence-collection.md)
- [ADR-0017 — Dual-mode evidence collection](../architecture/decisions/0017-dual-mode-evidence-collection.md)
- [ADR-0015 — Multi-provider LLM routing](../architecture/decisions/0015-multi-provider-llm-routing.md)
- [ADR-0013 — Analysis mode + verifier pass](../architecture/decisions/0013-analysis-mode-and-verifier-pass.md)
- [ADR-0011 — Evidence traceability first-class](../architecture/decisions/0011-evidence-traceability-first-class.md)
- [Phase 3 roadmap](./phase-3-roadmap.md) — predecessor.
