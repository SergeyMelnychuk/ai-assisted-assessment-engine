/**
 * Workflow step registry — Phase 4 Slice 1 of the agent-orchestrated
 * assessment surface.
 *
 * The workflow planner emits a graph whose nodes are *user-driven*
 * activities (upload documents, answer questions, run analysis, …),
 * not autonomous tool calls. This module is the single source of
 * truth for:
 *
 *   - the closed set of step types the planner may emit
 *     (`WORKFLOW_STEP_TYPES`),
 *   - the human label / description / icon hint for each type,
 *   - the deep-link route (Slice 1 — popup containers land in Slice 2),
 *   - the predicate that decides whether a given assessment satisfies
 *     a step (`COMPLETED` vs `IN_PROGRESS` vs `PENDING`).
 *
 * Keeping all of that in one file means adding a new step type is a
 * single-file delta the planner picks up automatically (the type list
 * is also rendered into the planner's user-turn block as the catalog
 * of valid actions, so a new entry here is immediately legal output).
 *
 * v1 status derivation is **soft** — we look at counts, not at an
 * explicit "user marked complete" flag. Slice 2's popup containers
 * add the explicit `COMPLETED` lock; until then a workflow step is
 * IN_PROGRESS while there's any data and COMPLETED when it crosses a
 * meaningful threshold (the `derive` function below). This keeps the
 * diagram useful immediately without blocking Slice 2.
 */

import type { PrismaClient } from "@prisma/client";

/** Closed set of action verbs the workflow planner may emit. */
export const WORKFLOW_STEP_TYPES = [
  "SETUP",
  "UPLOAD_DOCUMENTS",
  "CONNECT_REPOSITORY",
  "GATHER_REPOSITORY_EVIDENCE",
  "ANSWER_QUESTIONS",
  "RUN_ANALYSIS",
  "REVIEW_FINDINGS",
  "REVIEW_RISKS",
  "REVIEW_RECOMMENDATIONS",
  "REVIEW_SCORING",
  "TEAM_ESTIMATE",
  "GENERATE_DELIVERABLES",
  "EVIDENCE_REVIEW",
  "EXPORT",
] as const;
export type WorkflowStepType = (typeof WORKFLOW_STEP_TYPES)[number];

/** Soft state machine for a workflow node — see file header. */
export type WorkflowStepStatus =
  | "PENDING" // No data yet
  | "IN_PROGRESS" // Some data; below the completion threshold
  | "COMPLETED" // Threshold crossed (or explicit user lock in Slice 2)
  | "BLOCKED"; // A predecessor isn't complete (computed by the consumer)

export interface WorkflowStepSpec {
  type: WorkflowStepType;
  /** UI label (one or two words). */
  label: string;
  /** One-sentence description shown on the node + in the planner catalog. */
  description: string;
  /**
   * Slice 1 deep-link target relative to the engagement. The diagram
   * appends `?assessmentId=…` so the destination skips its picker.
   */
  routeSlug: string;
}

export const WORKFLOW_STEP_SPECS: Record<WorkflowStepType, WorkflowStepSpec> = {
  SETUP: {
    type: "SETUP",
    label: "Setup",
    description: "Capture project context — industry, cloud, timeline, goals.",
    routeSlug: "setup",
  },
  UPLOAD_DOCUMENTS: {
    type: "UPLOAD_DOCUMENTS",
    label: "Documents",
    description: "Upload existing artefacts (RFPs, architecture diagrams, SOPs).",
    routeSlug: "documents",
  },
  CONNECT_REPOSITORY: {
    type: "CONNECT_REPOSITORY",
    label: "Repositories",
    description: "Link one or more GitHub repositories with a fine-grained PAT.",
    routeSlug: "documents", // Repo links live alongside docs today.
  },
  GATHER_REPOSITORY_EVIDENCE: {
    type: "GATHER_REPOSITORY_EVIDENCE",
    label: "Repo evidence",
    description:
      "Run autonomous evidence collection on a connected repository (the agent reads files and emits Evidence rows).",
    // No standalone route — this step has no equivalent tab page.
    // The popup-mode body is the canonical surface for it.
    routeSlug: "documents",
  },
  ANSWER_QUESTIONS: {
    type: "ANSWER_QUESTIONS",
    label: "Questions",
    description: "Answer baseline + agent-generated questions across active domains.",
    routeSlug: "questions",
  },
  RUN_ANALYSIS: {
    type: "RUN_ANALYSIS",
    label: "Run analysis",
    description: "Synthesise evidence + answers into findings, risks, and scores.",
    routeSlug: "findings",
  },
  REVIEW_FINDINGS: {
    type: "REVIEW_FINDINGS",
    label: "Findings",
    description: "Review and approve generated findings.",
    routeSlug: "findings",
  },
  REVIEW_RISKS: {
    type: "REVIEW_RISKS",
    label: "Risks",
    description: "Review risk register with severity and likelihood.",
    routeSlug: "risks",
  },
  REVIEW_RECOMMENDATIONS: {
    type: "REVIEW_RECOMMENDATIONS",
    label: "Recommendations",
    description: "Review prioritised recommendations.",
    routeSlug: "recommendations",
  },
  REVIEW_SCORING: {
    type: "REVIEW_SCORING",
    label: "Scoring",
    description: "Inspect per-domain maturity scores.",
    routeSlug: "scoring",
  },
  TEAM_ESTIMATE: {
    type: "TEAM_ESTIMATE",
    label: "Team & estimate",
    description: "Generate role mix + hour estimate from findings + rate card.",
    routeSlug: "team-estimate",
  },
  GENERATE_DELIVERABLES: {
    type: "GENERATE_DELIVERABLES",
    label: "Deliverables",
    description: "Generate the final deliverables (assessment report sections + diagrams).",
    routeSlug: "deliverables",
  },
  EVIDENCE_REVIEW: {
    type: "EVIDENCE_REVIEW",
    label: "Evidence",
    description: "Browse evidence with provenance + dedupe view.",
    routeSlug: "evidence",
  },
  EXPORT: {
    type: "EXPORT",
    label: "Export",
    description: "Export the deliverable bundle.",
    routeSlug: "export",
  },
};

/** Runtime guard for parser code. */
export function isWorkflowStepType(s: string): s is WorkflowStepType {
  return (WORKFLOW_STEP_TYPES as readonly string[]).includes(s);
}

/**
 * Persisted shape of one workflow node. Lives inside the `AgentRun`'s
 * latest `PLAN` step payload as `{ workflow: WorkflowPlan }`. Slice 2
 * extends this with `{ explicitStatus: WorkflowStepStatus }` once the
 * popup container ships the user-driven completion lock.
 */
export interface WorkflowNode {
  /** Stable id within the plan — `workflow:<idx>:<type>`. */
  id: string;
  type: WorkflowStepType;
  /** Planner's reason for emitting this node — shown on the node tooltip. */
  reason: string;
  /**
   * Other node ids this one waits on. Empty array = root. The diagram
   * uses these as edges; the consumer derives BLOCKED status from
   * predecessors.
   */
  dependsOn: readonly string[];
}

export interface WorkflowPlan {
  /** Planner-emitted version of the plan. Bumped on each re-plan (Slice 3). */
  revision: number;
  /** Goal text the user entered, captured for diagram context. */
  goal: string;
  /** Optional initial repository hints (Slice 1: not yet wired into nodes). */
  repositories: ReadonlyArray<{ owner: string; repo: string; ref?: string }>;
  nodes: readonly WorkflowNode[];
}

// ─── Status derivation ─────────────────────────────────────────────

/**
 * Aggregate counts the derivation queries against. Kept narrow so the
 * caller can cheaply hydrate it once and feed every node from the same
 * snapshot.
 */
export interface StatusSnapshot {
  documents: number;
  repositoryLinks: number;
  questionsTotal: number;
  questionsAnswered: number;
  findings: number;
  risks: number;
  recommendations: number;
  domainScores: number;
  estimates: number;
  deliverables: number;
  evidenceTotal: number;
  /**
   * Subset of `evidenceTotal` written by the agent harness's
   * evidence emitter (`Evidence.sourceType = "CONNECTOR"`). Drives
   * the soft-completion predicate for
   * `GATHER_REPOSITORY_EVIDENCE` — uploaded documents already
   * populate `evidenceTotal` and would otherwise auto-complete
   * that step the moment the user uploads anything, which is
   * wrong (the step is specifically about agent-collected repo
   * evidence).
   */
  connectorEvidenceTotal: number;
}

export async function loadStatusSnapshot(
  db: PrismaClient,
  assessmentId: string,
): Promise<StatusSnapshot> {
  const [
    documents,
    repositoryLinks,
    questionsTotal,
    questionsAnswered,
    findings,
    risks,
    recommendations,
    domainScores,
    estimates,
    deliverables,
    evidenceTotal,
    connectorEvidenceTotal,
  ] = await Promise.all([
    db.document.count({ where: { assessmentId } }),
    db.repositoryLink.count({ where: { assessmentId } }),
    db.question.count({ where: { assessmentId } }),
    db.question.count({ where: { assessmentId, isAnswered: true } }),
    db.finding.count({ where: { assessmentId } }),
    db.risk.count({ where: { assessmentId } }),
    db.recommendation.count({ where: { assessmentId } }),
    db.domainScore.count({ where: { assessmentId } }),
    db.estimate.count({ where: { assessmentId } }),
    db.deliverable.count({ where: { assessmentId } }),
    db.evidence.count({ where: { assessmentId } }),
    db.evidence.count({ where: { assessmentId, sourceType: "CONNECTOR" } }),
  ]);
  return {
    documents,
    repositoryLinks,
    questionsTotal,
    questionsAnswered,
    findings,
    risks,
    recommendations,
    domainScores,
    estimates,
    deliverables,
    evidenceTotal,
    connectorEvidenceTotal,
  };
}

/**
 * Soft completion predicate per step type — based on data presence,
 * not an explicit user lock. Returns IN_PROGRESS when partial data
 * exists; COMPLETED when the meaningful threshold is crossed; PENDING
 * when nothing's there.
 *
 * BLOCKED is computed by the consumer from `dependsOn` — this fn only
 * looks at the data.
 */
export function deriveStepStatus(
  type: WorkflowStepType,
  s: StatusSnapshot,
): Exclude<WorkflowStepStatus, "BLOCKED"> {
  switch (type) {
    case "SETUP":
      // Setup is COMPLETED once any project-context-derived signal
      // exists. v1 proxy: questions seeded (which happens on first
      // setup save) OR docs uploaded.
      if (s.questionsTotal > 0 || s.documents > 0) return "COMPLETED";
      return "PENDING";
    case "UPLOAD_DOCUMENTS":
      if (s.documents === 0) return "PENDING";
      return s.documents >= 1 ? "COMPLETED" : "IN_PROGRESS";
    case "CONNECT_REPOSITORY":
      if (s.repositoryLinks === 0) return "PENDING";
      return "COMPLETED";
    case "GATHER_REPOSITORY_EVIDENCE":
      // Soft completion = at least one `CONNECTOR`-sourced Evidence
      // row exists (i.e. the agent harness's evidence emitter has
      // written something). Counting the global `evidenceTotal`
      // here was wrong — every uploaded document writes
      // `DOCUMENT`-sourced rows, which auto-completed this step
      // before the user ever ran the agent, and made Roll back a
      // no-op (the explicit lock was deleted but the soft signal
      // kept the step marked COMPLETED).
      return s.connectorEvidenceTotal > 0 ? "COMPLETED" : "PENDING";
    case "ANSWER_QUESTIONS": {
      if (s.questionsTotal === 0) return "PENDING";
      const ratio = s.questionsAnswered / s.questionsTotal;
      if (ratio >= 0.8) return "COMPLETED";
      return s.questionsAnswered > 0 ? "IN_PROGRESS" : "PENDING";
    }
    case "RUN_ANALYSIS":
      // Run analysis is COMPLETED once any of the synthesis outputs
      // are present (findings/risks/recs are co-emitted).
      if (s.findings === 0 && s.risks === 0 && s.recommendations === 0)
        return "PENDING";
      return "COMPLETED";
    case "REVIEW_FINDINGS":
      return s.findings > 0 ? "COMPLETED" : "PENDING";
    case "REVIEW_RISKS":
      return s.risks > 0 ? "COMPLETED" : "PENDING";
    case "REVIEW_RECOMMENDATIONS":
      return s.recommendations > 0 ? "COMPLETED" : "PENDING";
    case "REVIEW_SCORING":
      return s.domainScores > 0 ? "COMPLETED" : "PENDING";
    case "TEAM_ESTIMATE":
      return s.estimates > 0 ? "COMPLETED" : "PENDING";
    case "GENERATE_DELIVERABLES":
      return s.deliverables > 0 ? "COMPLETED" : "PENDING";
    case "EVIDENCE_REVIEW":
      return s.evidenceTotal > 0 ? "COMPLETED" : "PENDING";
    case "EXPORT":
      // No DB signal yet for "export happened". Slice 2 popup adds
      // an explicit lock.
      return "PENDING";
  }
}

/**
 * Apply BLOCKED gating: a node is BLOCKED when any of its `dependsOn`
 * predecessors hasn't reached COMPLETED. The function operates on the
 * already-derived statuses so callers don't pay for two passes.
 */
export function applyDependencies(
  nodes: readonly WorkflowNode[],
  statuses: ReadonlyMap<string, WorkflowStepStatus>,
): Map<string, WorkflowStepStatus> {
  const out = new Map<string, WorkflowStepStatus>(statuses);
  // Iterate in topological order — but our nodes carry their own
  // predecessor list, so a single pass works as long as the planner
  // emitted them in order. (Slice 3's re-planner enforces this.)
  for (const node of nodes) {
    const blocked = node.dependsOn.some((dep) => {
      const dst = out.get(dep);
      return dst !== "COMPLETED";
    });
    if (blocked) {
      out.set(node.id, "BLOCKED");
    }
  }
  return out;
}

/**
 * Combine the *explicit* per-step status (from `WorkflowStepStatus`
 * rows — set when the user clicked Mark complete or Save) with the
 * *soft* status derived from assessment data. Explicit always wins.
 *
 * The soft status remains useful as a default (a step naturally
 * progresses to COMPLETED when its underlying outputs land) and as a
 * fallback when the user hasn't engaged with the popup yet. The
 * explicit row exists to give the user authoritative control:
 * "I'm calling this done even if the heuristic disagrees" or
 * "this is in progress, the heuristic prematurely marked it done."
 *
 * Roll-back = delete the explicit row → soft status takes back over.
 */
export function combineExplicitAndSoftStatus(
  type: WorkflowStepType,
  snapshot: StatusSnapshot,
  explicit?: { status: "IN_PROGRESS" | "COMPLETED" } | null,
): Exclude<WorkflowStepStatus, "BLOCKED"> {
  if (explicit) return explicit.status;
  return deriveStepStatus(type, snapshot);
}
