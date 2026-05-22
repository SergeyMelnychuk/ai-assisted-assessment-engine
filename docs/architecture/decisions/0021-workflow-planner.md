# ADR-0021: Workflow planner — graph of human-driven steps with re-planning

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Engineering
- **Related:**
  [ADR-0014](./0014-agent-harness-for-evidence-collection.md) (the
  autonomous tool-calling harness this is **distinct from**),
  [ADR-0017](./0017-dual-mode-evidence-collection.md) (workflow
  mode is the user-supervised half of the dual-mode design).

## Context

ADR-0014 defines an **agent harness** that picks autonomous tool
calls turn-by-turn (per-turn `planner.ts` LLM call → tool dispatch →
trajectory step → repeat until budget exhausted or terminal).

That works for fully autonomous runs. It does **not** work for the
user-supervised flow ADR-0017 calls *MANUAL + AGENTIC*: a human
expert wants to see the full sequence of steps the agent intends to
take, approve / edit it, and walk through the steps with the agent
holding their hand at each one. The autonomous harness has no notion
of "the whole plan" — by design, it never commits to one.

We need a separate planner that produces the entire **graph** up
front, persists it, lets the UI render it as a workflow popup with
per-step state (`pending` / `running` / `completed` / `blocked`), and
supports **re-planning** when a step's outcome invalidates a
downstream node (e.g. the agent learns the repo is a monorepo and
needs to insert sub-steps).

## Decision

A second planner — `apps/web/src/server/services/agent/workflow-planner.ts`
— produces a `WorkflowPlan` graph in **one LLM call** and persists
it as the run's first PLAN trajectory step. The planner is
deliberately distinct from `planner.ts`:

- **`planner.ts`** picks the next tool call inside the autonomous
  harness (ADR-0014). One LLM call per turn. No graph.
- **`workflow-planner.ts`** picks the entire graph of human-driven
  steps. One LLM call per planning event. Graph persisted on the
  run.

Graph shape (`workflow.ts`):

- **Nodes** — one per human-driven step. `WORKFLOW_STEP_TYPES`
  enumerates the legal step kinds (the same surface a reviewer would
  drive manually: `ASK_QUESTION`, `UPLOAD_DOCUMENT`,
  `LINK_REPOSITORY`, `RUN_ANALYSIS`, …).
- **Edges** — directional dependencies. A step's status flips to
  `pending` only when all parents are `completed`.
- **Per-step state** — held on the trajectory, not the node
  itself. The graph is the plan; the trajectory is the run history.

Re-planning (Slice 3): after each step's terminal event, the
workflow planner is invoked again with the updated trajectory and
the prior plan. It may **insert new nodes** or **mark existing
nodes** `obsolete`. Existing in-flight or completed nodes are never
mutated — the planner can only append the future. This keeps audit
replay deterministic and the UI animation sensible (steps fade
in / out; they don't change identity).

Both planners share the AI router (`callAi`, ADR-0015) and the
same trajectory schema, so the harness's tool-result contract,
budget gates, and Evidence-emitter are reused unchanged.

## Alternatives considered

- **Reuse `planner.ts` for workflow mode** with a "plan everything
  in one call" flag. Rejected — the per-turn planner's prompt is
  optimised for "what's the next single tool call" and adding a
  graph mode would bloat the prompt enough to hurt autonomous
  quality.
- **Skip planning, let the user place steps manually.** Rejected —
  the entire value proposition of workflow mode is "the AI shows you
  the path, you approve it". A blank canvas is what we already had.
- **Plan once, never re-plan.** Rejected — discovery work is
  inherently exploratory. The first plan is wrong by Step 3 of any
  real engagement; a static graph would be fiction.
- **Mutate nodes on re-plan instead of append-only.** Rejected —
  destroys the audit trail, makes the UI animation jarring, and
  means a re-plan can silently invalidate a completed step's
  recorded outputs.

## Consequences

**Positive**

- Workflow mode reads as a clear sibling of autonomous mode rather
  than a tangle of `if (workflow) { ... }` branches inside one
  planner.
- Re-planning is well-bounded — append-only, never mutates history,
  composable with the trajectory schema we already have.
- Reviewers see the AI's intent up front. They can edit it before
  any expensive step runs, and they have a UI artefact to comment
  on.
- The graph is data, not code. Adding a new step kind means adding
  to `WORKFLOW_STEP_SPECS` + a handler — the planner generalises.

**Negative**

- Two planners to maintain. Their prompts diverge over time, and
  the team has to remember which to update for which behaviour.
  Mitigation: the system-prompt files are co-located in
  `services/ai/prompts/` and named for their planner.
- Re-planning is an extra LLM call per completed step. Mitigated
  by caching (ADR-0012); the prompt prefix is identical across
  re-plans.
- Append-only re-plans can produce stale `obsolete` nodes the user
  has to mentally filter. The UI hides them by default with a
  toggle to surface them.

**Neutral**

- The workflow popup is the only UI consumer today. Future surfaces
  (a dedicated `/workflows/[id]` page, a print view) can read the
  same persisted graph without changes to the planner contract.

## Follow-ups

- Planner-produced confidence scores per node, surfaced in the
  popup so the user knows where to spend their review attention.
- Cross-run plan reuse — start a new engagement from a prior
  engagement's approved plan as a template.
