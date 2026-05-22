# ADR-0026: Agent trace viewer — five tiers of run inspection

- **Status:** Accepted
- **Date:** 2026-05-10
- **Deciders:** Engineering
- **Related:**
  [ADR-0014](./0014-agent-harness-for-evidence-collection.md) (the
  harness that produces `AgentStep` / `AgentToolCall` rows),
  [ADR-0017](./0017-dual-mode-evidence-collection.md) (MANUAL +
  AGENTIC dual mode — this is the audit surface for the agentic
  half),
  [ADR-0021](./0021-workflow-planner.md) (the workflow-graph planner
  whose plans appear as the first PLAN step on workflow-mode runs),
  [ADR-0012](./0012-prompt-caching-and-cost-instrumentation.md)
  (`AI_CALL` audit rows are the cost-rollup source).

## Context

The agent harness records every turn as an `AgentStep` row with an
optional `AgentToolCall` child. The v0 of the on-page diagram
(`AgentFlowDiagram`) showed each step as a 280-pixel rectangle with
`#idx · KIND` + a one-line title. For a real run with 30+ steps the
diagram looked busy but conveyed almost nothing: no goal, no
totals, no budget context, no tool args, no result, no evidence
emitted, no halt reason. A reviewer looking at a stuck run had no
way to learn what happened without dropping into Prisma Studio.

The schema already holds the answers — `payload.decision.reason`,
`AgentToolCall.argsJson`, `resultJson`, `evidenceIds`,
`AuditLog AI_CALL` cost rows, `AgentRun.budget`, `endReason`,
`errorDetails`. The viewer just wasn't surfacing them.

## Decision

Restructure the trace viewer into five layered tiers, each of which
turns existing data into UI affordances. Implementation lives in
three components plus four new tRPC procedures:

| Tier | Surface | Files |
|---|---|---|
| 1 — Context band | Goal, status pill, totals, duration, budget bars, halt reason | `agent-flow-header.tsx` |
| 2 — Richer nodes | Planner reason + chosen tool/args, tool arg summary, result preview, error class, evidence badge | `agent-flow-diagram.tsx` (PlanNode, ToolNode, SystemNode, UserNode) |
| 3 — Inspection panel | Click-to-open right rail: full reasoning, full args JSON, full result JSON, error details, per-step token roll-up, evidence-id list | `agent-step-panel.tsx` |
| 4 — Long-run UX | Token-spend sparkline above the canvas, turn dividers between PLAN nodes, replay scrubber, built-in React Flow minimap | `agent-flow-diagram.tsx` (CostSparkline, ReplayScrubber, DividerNode, MiniMap) |
| 5 — Future-facing | Parallel tool-call fan-out (horizontal layout when `step.toolCalls.length > 1`), run comparison diff, reviewer annotations, replay-step-with-edited-args | `agent-run-compare.tsx`, `agent-step-panel.tsx` (AnnotationsBlock, ReplayBlock), new tRPC procedures |

### tRPC additions

- `agentRun.get` extended with a `cost` rollup (sums
  `estimatedCostUsd` / cache-token counters across the run's
  `AI_CALL` audit rows). One round-trip; the dashboard's cost page
  already does the same math.
- `agentRun.addAnnotation`, `resolveAnnotation` — write/resolve
  reviewer notes pinned to a step. New `AgentStepAnnotation` table
  (migration `20260510211714_agent_step_annotations`).
- `agentRun.compareRuns` — server-side summary diff between two
  runs of the same assessment (status, totals, evidence count,
  halt reason, per-tool ok/fail counts). UI calls it from the
  compare dialog.
- `agentRun.replayToolCall` — queue a re-dispatch of one tool with
  an overridden args JSON. Result lands as a new step on the same
  run; harness queue is the actual executor (the mutation just
  files the request via a SYSTEM step + audit row, never executes
  tools inline).

### Branching layout (Tier 5)

The graph builder special-cases steps where
`step.toolCalls.length > 1`: it fans the calls out horizontally
(centred on x=0), then inserts an invisible "converge" node so the
next step has a single parent to attach an edge to. Single-call
steps stay in the linear column. The DividerNode + ConvergeNode
types are both `selectable: false`, `focusable: false`, and render
as either a thin label or a 1-pixel box — they exist only to keep
the edge graph well-formed.

### Visibility flag

The trace viewer is gated by a DB-backed sub-flag
`features.agentFlowVisible` (ADR-0023 pattern). Distinct from
`features.agentEnabled`:

- `agentEnabled = on, agentFlowVisible = on` (default) — harness runs +
  diagram renders.
- `agentEnabled = on, agentFlowVisible = off` — harness keeps running,
  but the `AgentFlowDiagram` card returns `null` so the assessment
  runs panel collapses past it. Useful when reviewers find the trace
  noisy or when we ship a temporary regression and want to suppress
  the surface without redeploying.
- `agentEnabled = off` — diagram hidden regardless (the harness
  itself is gone).

Missing row = ON, so deploys that pre-date the flag keep their
existing v1 behaviour. Toggled from
`/admin/settings?tab=ai-router`.

### Authz

- `addAnnotation` / `resolveAnnotation` go through
  `assertAssessmentAccess` (anyone with read access on the parent
  assessment may write — the principle: a stuck note shouldn't
  block teammates).
- `compareRuns` requires both runs to belong to the same assessment
  and goes through the same gate.
- `replayToolCall` requires assessment access; the executed tool
  goes through the existing harness queue + credential vault
  (ADR-0022), so no new auth surface.

## Alternatives considered

- **Skip the side panel; cram everything onto the nodes.** Rejected
  — 30-step runs become unreadable, and the full JSON payloads
  don't fit a node card. The side panel is a clean separation: the
  node carries the at-a-glance signal, the panel carries the
  deep audit material.
- **Pre-compute a static SVG / image per run.** Rejected — runs
  evolve while they're live, the diagram needs to update as steps
  land. React Flow's pan/zoom/minimap are basically free for the
  cost of taking the dependency, which the workflow planner
  already pulled in.
- **Render the trace from the audit log instead of `AgentStep`
  rows.** Rejected — the audit log is a flat append-only stream;
  modelling parents (PLAN → TOOL_CALL) and grouping (turn
  iterations) is much cleaner off the typed `AgentStep` table.
- **One run per page, no comparison view.** Rejected — debugging a
  stuck run almost always means comparing to a known-good run.
  The comparison dialog is a small modal; it doesn't justify a
  whole route.
- **Annotations as a free-text field on `AgentStep`.** Rejected —
  multi-reviewer notes need their own rows for authorship +
  resolve-status. A new `AgentStepAnnotation` table is the right
  cost.

## Consequences

**Positive**

- A stuck run is now diagnosable from the UI without dropping
  into Prisma Studio. Halt reason, budget exhaustion, missing
  credentials, tool errors all surface in the header band.
- Cost transparency: the run's spend is one glance away, sourced
  from the same `AI_CALL` rows the platform-wide rollup uses.
- Branching layout is in place for the future "parallel tool
  dispatch" planner mode — no further graph-builder work needed
  when that capability ships.
- Annotations + comparison dialog give reviewers a workflow for
  flagging interesting runs without leaving the assessment.

**Negative**

- The viewer pulls more data per fetch (`AI_CALL` audit rows,
  annotations). One extra query and a small `Map` build — neg-
  ligible at the scales we run at, but worth knowing.
- The replay path is a deliberate stub: the mutation writes a
  SYSTEM step requesting a replay but the harness side that
  *actually* re-dispatches one tool with edited args isn't wired
  yet. The audit trail records intent; follow-up work in the
  harness will pick the SYSTEM step up. Documented as a follow-up
  below so a future contributor doesn't ship a dialog that looks
  productive but never produces a TOOL_CALL row.
- Side-panel JSON dumps can be large for chunked tool results.
  We cap the preview height with `max-h-*` + scroll, which is fine
  for inspection but doesn't paginate. A virtualised viewer is a
  follow-up once we see a real run that exceeds the cap.

**Neutral**

- Token sparkline approximates cost with token-count bars
  (combined input + output). The header band shows true cost USD
  via `AI_CALL`. Two metrics is intentional — per-step exact cost
  requires re-joining audit rows to step ids which the harness
  doesn't currently emit; tokens are a clean proxy.

## Follow-ups

- Harness-side handler for the SYSTEM `tool_replay_requested` step
  emitted by `replayToolCall`. Until that lands, the mutation
  records intent without producing a new TOOL_CALL row.
- Virtualised side-panel JSON viewer for tool results > 100kB.
- Per-step cost roll-up exposed directly on `AgentStep` rows (add
  `estimatedCostUsd` Decimal column, populate from the harness
  when it writes `AI_CALL`). Removes the audit-log join from the
  hot path.
- Compare-runs: per-step diff (right now we only diff totals +
  per-tool counts). Useful when "the two runs have the same shape
  but step 12 went differently" is the real question.
