# ADR-0017: Dual-mode evidence collection (MANUAL + AGENTIC)

- **Status:** Accepted (feature flag + UI shipped; agent path is
  the workflow planner described in ADR-0014)
- **Date:** 2026-04-24 (proposed) · 2026-05-06 (accepted)
- **Deciders:** Engineering
- **Related:**
  [ADR-0011](./0011-evidence-traceability-first-class.md),
  [ADR-0013](./0013-analysis-mode-and-verifier-pass.md),
  [ADR-0014](./0014-agent-harness-for-evidence-collection.md),
  [ADR-0015](./0015-multi-provider-llm-routing.md),
  [`docs/design/phase-4-agentic-ai.md`](../../design/phase-4-agentic-ai.md).

## Context

ADR-0014 specifies an agent harness that collects evidence from
external systems (repos, CI, cloud) and emits typed `Evidence` rows
that the existing per-domain synthesis pipeline consumes unchanged.
That design is sound — the question this ADR answers is **how to
roll it out** without betting the product on an untested autonomous
loop.

Three rollout shapes were on the table:

1. **Hard cutover.** Ship the agent, make it the only evidence path.
   Simplest code, worst risk: one regression on a live engagement and
   we lose customer trust.
2. **Flag-only rollout.** Platform-wide `features.agentEnabled` flag.
   Safer than cutover, but end-users can't self-select and we get no
   production comparison signal — everyone's either all-in or all-out.
3. **Dual-mode, per-assessment.** Agent runs alongside today's manual
   evidence intake. Each assessment carries an `evidenceMode` field
   (`MANUAL` | `AGENTIC`) picked at creation time. Both modes produce
   the same `Evidence` rows feeding the same synthesis pipeline.

Option 3 is what this ADR commits to. It pairs the platform flag
(from option 2) with a per-assessment toggle so the feature can ship
dark, be enabled per-tenant, and ultimately be exposed to end-users
per-engagement — without forcing a cutover and without losing the
comparison signal that validates the agent's ROI.

The surrounding discussion ("is the agent an *alternative* to gen
AI?") deserves a direct answer: **no.** The deterministic synthesis
pipeline (ADR-0002, ADR-0013) is not being replaced. The agent is an
additional evidence *source*, layered upstream. "Dual mode" refers
strictly to how evidence gets into the `Evidence` table — not to
anything downstream.

## Decision

Introduce an `EvidenceMode` enum and persist it on `Assessment`.
Default is `MANUAL` (today's behaviour). When `evidenceMode=AGENTIC`,
the assessment's lifecycle inserts one or more `AgentRun`s ahead of
`runAnalysis`; their emitted `Evidence(sourceType=CONNECTOR)` rows
then flow into synthesis exactly like document- or answer-sourced
evidence.

### Shape

```ts
enum EvidenceMode {
  MANUAL   // default — humans upload + answer questionnaire
  AGENTIC  // agent autonomously collects evidence upstream of synthesis
}

// apps/web/prisma/schema.prisma
model Assessment {
  // ... existing fields ...
  mode         AnalysisMode @default(FAST)     // ADR-0013
  evidenceMode EvidenceMode @default(MANUAL)   // this ADR
  agentRuns    AgentRun[]                      // ADR-0014
}
```

The two modes compose:

| `evidenceMode` × `mode` | What runs |
|---|---|
| `MANUAL` × `FAST` | Today's baseline. |
| `MANUAL` × `THOROUGH` | Today's verifier mode (ADR-0013). |
| `AGENTIC` × `FAST` | Agent pre-populates evidence, then one-shot synthesis. |
| `AGENTIC` × `THOROUGH` | Agent + verifier. Most expensive, highest confidence. |

### Two-layer toggle

1. **Platform flag** — `Setting("features.agentEnabled")`, a
   DB-backed boolean toggled from `/admin/settings?tab=ai-router`.
   Deliberately not env-backed: the whole point is that flipping
   applies on the next tRPC call without a redeploy, which an env
   var can't do without a restart (and would fight the DB row
   silently if both were honoured). Hides the `AGENTIC` option
   entirely when off. Every agent tRPC route returns `NOT_FOUND`
   when off, matching the role-probing-resistance pattern already
   used for admin routes.
2. **Per-assessment `evidenceMode`** — the user-facing choice once
   the platform flag is on. Picked at assessment creation; immutable
   after the first agent run starts (same rule as `mode` post-launch).

Both layers are needed. The platform flag is what lets us ship dark
and roll out per-tenant; the per-assessment field is what gives
tenants price-discrimination and per-engagement governance.

### Side-by-side, not swap

The two modes coexist in production indefinitely during rollout.
`MANUAL` stays the default until AGENTIC clears the retirement bar
(see Follow-ups). When both modes have run on the same assessment
(e.g. manual upload + later agent run), their evidence is
**unioned** in the same `Evidence` table; the synthesis pipeline
doesn't need to know which came from where — `sourceType` is the
only discriminator it needs.

### Audit + reviewability

Every AGENTIC run writes the full trajectory to the
`AgentRun`/`AgentStep`/`AgentToolCall` tables (ADR-0014 §6). A
reviewer on a finding can trace:

```
Finding.retrievedEvidenceIds
  → Evidence(sourceType=CONNECTOR)
    → chunkSource.agentToolCallId
      → AgentToolCall.stepId
        → AgentStep.runId
          → AgentRun.approvedById / createdAt / planName
```

No evidence row is ever created outside a tool call, and no tool
call runs without an approved `AgentRun`. The audit chain is strict.

## Alternatives considered

- **Hard cutover** — rejected. Regression risk on a live engagement
  wipes out quarters of trust-building. The existing deterministic
  path is load-bearing for current customers; we don't replace it
  until the agent has months of parallel-running data.
- **Global feature flag only** (no per-assessment field) — rejected.
  Can't A/B on real engagements; can't price-discriminate per client;
  a bad run on one tenant forces a global rollback. The
  per-assessment field is a tiny column change that buys a lot.
- **Per-engagement** (not per-assessment) — considered and folded in.
  An engagement default is useful for governance ("this client
  allows AGENTIC"), but the actionable choice is per-assessment
  because the same engagement may spawn several assessments of
  varying risk. We persist the field at the assessment level and
  may add an engagement-level default later as a UX nicety.
- **Replace the synthesis pipeline with a single agent** (everything
  agentic, including findings) — rejected. Loses ADR-0011's
  traceability guarantees and ADR-0013's verifier discipline. The
  deterministic synthesis layer is a feature, not a legacy.
- **Per-task mode** (each AI task independently generative/agentic)
  — rejected. Overkill for the problem. Only evidence collection
  benefits from autonomy; the other tasks are well-shaped one-shot
  prompts and should stay that way.

## Consequences

**Positive**
- Risk-free rollout: AGENTIC starts at zero users; MANUAL keeps
  every existing engagement untouched.
- Production A/B: running both modes on the same assessment gives
  the cheapest eval we'll ever have — classic output is the oracle.
- Governance: per-engagement / per-assessment approval aligns with
  the ADR-0014 human-in-the-loop gate without bolting on extra
  infrastructure.
- Sales lever: "autonomous evidence collection is a per-engagement
  opt-in" is a clean story for enterprise clients.
- Rollback granularity: a single misbehaving run is a per-assessment
  concern, not a platform incident.

**Negative**
- Permanent dual-path maintenance cost until a sunset lands. Two
  evidence-intake surfaces to keep running, two cost profiles to
  model, two failure-mode catalogues for support to learn.
- `evidenceMode × mode` is a 2×2 — ops needs a documented default
  matrix and sales needs guidance on when AGENTIC pays for itself.
  Without that, users pick the wrong cell and blame the product.
- The comparison UI (which is where most of the value lives) is not
  free — it has to reconcile the case where one assessment has two
  evidence generations with different timestamps.

**Neutral**
- Every new `Evidence` row already carries `sourceType`; AGENTIC
  simply uses `CONNECTOR`, which is already in the enum. No
  downstream consumer changes.
- Trajectory tables are append-only; retention + redaction policy
  inherits from `AuditLog` until we decide otherwise.

## Follow-ups

- [ ] **Retirement criterion.** Write into this ADR (amendment, not
      new ADR) the concrete bar for retiring MANUAL: e.g. "after 6
      months of GA, if AGENTIC is selected on ≥60% of net-new
      assessments AND eval parity holds AND support-ticket rate is
      within 1.5× MANUAL, propose a deprecation ADR." Without this,
      dual-mode becomes forever-mode.
- [ ] **Default matrix for ops.** Publish `evidenceMode × mode`
      defaults per engagement tier under `docs/operations/`.
- [ ] **Comparison UI** — evidence explorer extension showing which
      rows came from MANUAL vs AGENTIC, and which findings cite
      which. Tracked in Phase 4 roadmap Slice 3.5.
- [ ] **Cost guardrails.** AGENTIC runs can be 10×+ more expensive
      than MANUAL. Add per-tenant / per-engagement cost ceilings
      surfaced in the assessment creation UI before the user
      commits to AGENTIC. Roadmap Slice 3.
- [ ] **Engagement-level default.** Once AGENTIC has live traffic,
      add `Engagement.defaultEvidenceMode` so the assessment picker
      doesn't force the same choice per assessment.
- [ ] **Sandbox ADR (ADR-0018).** ADR-0014 defers sandbox choice;
      exec-tier tools block on it. Filing separately.

## References

- `docs/design/phase-4-agentic-ai.md` — sliced implementation plan.
- `docs/architecture/decisions/0014-agent-harness-for-evidence-collection.md`
  — the harness contract this ADR builds on.
- `docs/architecture/decisions/0013-analysis-mode-and-verifier-pass.md`
  — the `mode` enum pattern we're mirroring.
