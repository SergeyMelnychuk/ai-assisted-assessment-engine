"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
// Static import: the dyn helper's prop inference trips when a module
// has multiple named component exports (analysis-page-shell exports
// both AnalysisPageShell and InFlightBanner). Importing directly is
// fine — the analysis tree is already on the main bundle via the
// standalone Findings page, so no extra weight.
import { InFlightBanner } from "@/components/analysis/analysis-page-shell";
import { EstimationInFlightBanner } from "@/components/assessment/estimation-in-flight-banner";
import { TemplateFillDownload } from "@/components/templates/template-fill-download";

/**
 * Embedded components are dynamically imported so each step's body
 * code only ships when the user actually opens that step's popup.
 * The closed popup adds nothing to the route's bundle. Each `dynamic`
 * call takes a one-off `loading` skeleton so the popup never flashes
 * empty.
 */

const Skel = () => <Skeleton className="h-40 w-full" />;
// Helper preserves the component's prop type by lifting it from the
// module's named export. Without this `dynamic` would default to
// `ComponentType<{}>` and every prop would error.
function dyn<P, K extends string>(
  loader: () => Promise<Record<K, React.ComponentType<P>>>,
  name: K,
) {
  return dynamic<P>(
    async () => (await loader())[name] as React.ComponentType<P>,
    { loading: Skel, ssr: false },
    // ssr:false: every popup body is a "use client" component anyway,
    // and many call hooks immediately — server-render would error.
  );
}

const DocumentsTab = dyn(
  () => import("@/components/assessment/documents-tab"),
  "DocumentsTab",
);
const QuestionList = dyn(
  () => import("@/components/questions/question-list"),
  "QuestionList",
);
const FindingsList = dyn(
  () => import("@/components/analysis/findings-list"),
  "FindingsList",
);
const RisksList = dyn(
  () => import("@/components/analysis/risks-list"),
  "RisksList",
);
const RecommendationsList = dyn(
  () => import("@/components/analysis/recommendations-list"),
  "RecommendationsList",
);
const ScoringList = dyn(
  () => import("@/components/analysis/scoring-list"),
  "ScoringList",
);
const TeamProposal = dyn(
  () => import("@/components/assessment/team-proposal"),
  "TeamProposal",
);
const EstimateSummary = dyn(
  () => import("@/components/assessment/estimate-summary"),
  "EstimateSummary",
);
const RunEstimationButton = dyn(
  () => import("@/components/assessment/run-estimation-button"),
  "RunEstimationButton",
);
const TemplatePicker = dyn(
  () => import("@/components/templates/template-picker"),
  "TemplatePicker",
);
const DeliverablesWorkspace = dyn(
  () => import("@/components/assessment/deliverables-workspace"),
  "DeliverablesWorkspace",
);
const EvidenceExplorer = dyn(
  () => import("@/components/evidence/evidence-explorer"),
  "EvidenceExplorer",
);
const ExportList = dyn(
  () => import("@/components/assessment/export-list"),
  "ExportList",
);
const ProjectContextForm = dyn(
  () => import("@/components/assessment/project-context-form"),
  "ProjectContextForm",
);
const RepositoryLinkPanel = dyn(
  () => import("@/components/assessment/repository-link-panel"),
  "RepositoryLinkPanel",
);
const RunAnalysisButton = dyn(
  () => import("@/components/analysis/run-analysis-button"),
  "RunAnalysisButton",
);
const GatherRepoEvidenceStep = dyn(
  () => import("@/components/assessment/gather-repo-evidence-step"),
  "GatherRepoEvidenceStep",
);

/**
 * Step popup container — renders the right embedded component for a
 * workflow node and exposes the Save / Mark complete / Roll back
 * controls in the dialog footer.
 *
 * Each step type maps to one (or a small composition of) existing
 * page-level components, called with the same props they take when
 * mounted on their dedicated route. The Explore agent established
 * that every component is already self-contained — we just import
 * and render. No page-level state to lift today.
 *
 * Status semantics:
 *   - PENDING / IN_PROGRESS: Mark complete + Save & close are both
 *     enabled. "Save" persists IN_PROGRESS so the diagram badge updates.
 *   - COMPLETED: only Roll back is offered; the user has already
 *     locked the step and can re-do it by rolling back first.
 *   - BLOCKED: dialog opens read-only with a banner explaining which
 *     predecessor needs completing first.
 */

type Snapshot = RouterOutputs["agentRun"]["workflowSnapshot"];
type WorkflowSnapshotNode = NonNullable<Snapshot>["nodes"][number];

export function WorkflowStepPopup({
  open,
  onOpenChange,
  engagementId,
  assessmentId,
  runId,
  node,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  engagementId: string;
  assessmentId: string;
  runId: string;
  node: WorkflowSnapshotNode;
}) {
  const utils = trpc.useUtils();
  const [note, setNote] = useState(node.explicit?.note ?? "");

  const markStep = trpc.agentRun.markStep.useMutation({
    onSuccess: () => {
      void Promise.all([
        utils.agentRun.workflowSnapshot.invalidate({ assessmentId }),
        utils.agentRun.getByAssessment.invalidate({ assessmentId }),
      ]);
    },
  });
  const rollbackStep = trpc.agentRun.rollbackStep.useMutation({
    onSuccess: () => {
      void Promise.all([
        utils.agentRun.workflowSnapshot.invalidate({ assessmentId }),
        utils.agentRun.getByAssessment.invalidate({ assessmentId }),
      ]);
    },
  });
  const busy = markStep.isPending || rollbackStep.isPending;
  const error = markStep.error ?? rollbackStep.error;

  // Roll back is offered whenever the user previously locked the step
  // (explicit row exists — either IN_PROGRESS from Save note, or
  // COMPLETED from Mark complete). Soft-derived COMPLETED has nothing
  // to roll back, so we still offer Mark complete there.
  const hasExplicitLock = node.explicit !== null;
  const isBlocked = node.status === "BLOCKED";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>{node.spec.label}</DialogTitle>
          <DialogDescription>{node.spec.description}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">

        {isBlocked ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            This step is blocked until{" "}
            {node.dependsOn.length === 1
              ? "its predecessor is"
              : "all predecessors are"}{" "}
            completed. The form below is read-only — finish the upstream
            steps first, then come back here.
          </div>
        ) : null}

        {/* When blocked we want EVERY action inside the embedded body
         *  (upload, link repo, run analysis, etc.) to be unclickable.
         *  Threading a per-component disabled prop into a dozen nested
         *  components would be invasive and easy to miss; instead we
         *  wrap the subtree with the modern `inert` attribute (blocks
         *  focus + clicks + a11y traversal across the whole tree) and
         *  add a visual dim. `inert` is the supported HTML5 way to
         *  freeze a subtree without per-control wiring. */}
        <div
          className={`rounded-md border bg-background p-3 ${
            isBlocked ? "pointer-events-none select-none opacity-60" : ""
          }`}
          aria-disabled={isBlocked}
          {...(isBlocked
            ? // React 19 expects `inert` as a boolean (older versions
              // accepted an empty string). Spread so the TS surface
              // stays happy across versions.
              ({ inert: true } as Record<string, unknown>)
            : {})}
        >
          <StepBody
            type={node.type}
            engagementId={engagementId}
            assessmentId={assessmentId}
          />
        </div>

        {/* Step-level note + its own Save button.
         *
         * Repos / documents / questions are handled by the embedded
         * body above — those save themselves the moment you submit.
         * The note is for THIS step's status card on the diagram
         * (e.g. "skipped TLS audit, customer uses GCP-managed certs").
         *
         * Two save paths:
         *   - **Save note** (right here, beside the textarea) — keeps
         *     the step at its current status; just persists the note.
         *     Falls back to IN_PROGRESS for steps that have no
         *     explicit status yet.
         *   - **Save & mark complete** in the footer — same write
         *     plus flips status to COMPLETED. */}
        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="step-note" className="text-sm">
              Step note (optional)
            </Label>
            <NoteSaveStatus
              currentNote={note}
              savedNote={node.explicit?.note ?? ""}
              hasExplicit={node.explicit !== null}
            />
          </div>
          <Textarea
            id="step-note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              isBlocked
                ? "Locked while the step is blocked."
                : "A short comment about how this step went — visible on the workflow diagram."
            }
            maxLength={2000}
            disabled={busy || isBlocked}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Shown on the diagram next to this step.
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={
                busy || isBlocked || note === (node.explicit?.note ?? "")
              }
              onClick={() =>
                markStep.mutate({
                  runId,
                  nodeId: node.id,
                  // Preserve the existing status if there's already
                  // an explicit one; otherwise this is the user's
                  // first engagement with the step → IN_PROGRESS.
                  status:
                    node.explicit?.status === "COMPLETED"
                      ? "COMPLETED"
                      : "IN_PROGRESS",
                  note: note.trim() || undefined,
                })
              }
            >
              {markStep.isPending &&
              markStep.variables?.status !== "COMPLETED"
                ? "Saving…"
                : "Save note"}
            </Button>
          </div>
        </div>

        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error.message}
          </p>
        ) : null}

        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Close
          </Button>
          {hasExplicitLock ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                rollbackStep.mutate({ runId, nodeId: node.id })
              }
              title={
                node.explicit?.status === "COMPLETED"
                  ? "Clear the COMPLETED lock — soft status takes back over"
                  : "Clear the IN_PROGRESS lock — soft status takes back over"
              }
            >
              {rollbackStep.isPending ? "Rolling back…" : "Roll back"}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={busy || isBlocked}
              onClick={() =>
                markStep.mutate({
                  runId,
                  nodeId: node.id,
                  status: "COMPLETED",
                  note: note.trim() || undefined,
                })
              }
              title={
                isBlocked
                  ? "Complete predecessor steps first"
                  : "Save note + mark this step COMPLETED on the diagram"
              }
            >
              {markStep.isPending && markStep.variables?.status === "COMPLETED"
                ? "Marking complete…"
                : "Mark complete"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Body dispatch ─────────────────────────────────────────────────

function StepBody({
  type,
  engagementId,
  assessmentId,
}: {
  type: WorkflowSnapshotNode["type"];
  engagementId: string;
  assessmentId: string;
}) {
  switch (type) {
    case "SETUP":
      return (
        <ProjectContextForm
          assessmentId={assessmentId}
          engagementId={engagementId}
        />
      );
    case "UPLOAD_DOCUMENTS":
      // Documents only — the repository-link panel renders in the
      // CONNECT_REPOSITORY step's popup. Keeping the two concerns
      // separated stops users seeing repos here when they came in
      // looking for a doc upload.
      return (
        <DocumentsTab
          assessmentId={assessmentId}
          includeRepositoryLinks={false}
        />
      );
    case "CONNECT_REPOSITORY":
      return <RepositoryLinkPanel assessmentId={assessmentId} />;
    case "GATHER_REPOSITORY_EVIDENCE":
      return <GatherRepoEvidenceStep assessmentId={assessmentId} />;
    case "ANSWER_QUESTIONS":
      return <QuestionList assessmentId={assessmentId} />;
    case "RUN_ANALYSIS":
      return <RunAnalysisStepBody assessmentId={assessmentId} />;
    case "REVIEW_FINDINGS":
      return <FindingsList assessmentId={assessmentId} />;
    case "REVIEW_RISKS":
      return <RisksList assessmentId={assessmentId} />;
    case "REVIEW_RECOMMENDATIONS":
      return <RecommendationsList assessmentId={assessmentId} />;
    case "REVIEW_SCORING":
      return <ScoringList assessmentId={assessmentId} />;
    case "TEAM_ESTIMATE":
      return (
        <TeamEstimateStepBody
          assessmentId={assessmentId}
          engagementId={engagementId}
        />
      );
    case "GENERATE_DELIVERABLES":
      return (
        <DeliverablesWorkspace
          assessmentId={assessmentId}
          engagementId={engagementId}
        />
      );
    case "EVIDENCE_REVIEW":
      return <EvidenceExplorer assessmentId={assessmentId} />;
    case "EXPORT":
      return <ExportList assessmentId={assessmentId} />;
    default:
      return (
        <p className="text-sm text-muted-foreground">
          No popup body wired for step type {String(type)}.
        </p>
      );
  }
}

/**
 * Small inline indicator next to the Step note label. Three states:
 *   - No saved note yet, field empty                → nothing shown
 *   - Field text differs from the saved version     → "Unsaved changes"
 *   - Field text matches the saved version          → "Saved"
 *
 * Mirrors the contract in the helper text below the textarea: clicking
 * Save (in progress) or Mark complete persists what's currently in
 * the field; reopening the popup pre-fills with the persisted value.
 */
function NoteSaveStatus({
  currentNote,
  savedNote,
  hasExplicit,
}: {
  currentNote: string;
  savedNote: string;
  hasExplicit: boolean;
}) {
  if (!hasExplicit && currentNote.trim().length === 0) {
    return (
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Not saved yet
      </span>
    );
  }
  if (currentNote === savedNote) {
    return (
      <span className="rounded-full border border-green-500/40 bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
        Saved
      </span>
    );
  }
  return (
    <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
      Unsaved
    </span>
  );
}

/**
 * Run-analysis step body. Surfaces the same in-flight progress banner
 * the standalone Findings page shows ("3 / 8 domains complete, 1
 * running") so users get live feedback inside the popup.
 *
 * Layout:
 *   - Live progress banner (renders only while a run is in flight)
 *   - One-line explainer
 *   - Run analysis button + Refresh button
 *
 * The button mutation already invalidates the right caches on
 * success; the explicit Refresh is a safety belt for "the worker
 * finished but the UI hasn't picked up yet" cases.
 */
/**
 * Team & Estimate body. Adds a template picker above the Run button
 * so customers with multiple APPROVED ESTIMATION templates can choose
 * which one the worker fills. The selected id flows through to the
 * `estimation.run` mutation; absent/no-options falls back to the
 * auto-resolver.
 */
function TeamEstimateStepBody({
  assessmentId,
  engagementId,
}: {
  assessmentId: string;
  engagementId: string;
}) {
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);
  return (
    <div className="space-y-3">
      <EstimationInFlightBanner assessmentId={assessmentId} />
      <TemplatePicker
        engagementId={engagementId}
        kind="ESTIMATION"
        value={templateId}
        onChange={setTemplateId}
        label="WBS / estimation template"
      />
      <RunEstimationButton
        assessmentId={assessmentId}
        templateId={templateId}
      />
      <TemplateFillDownload assessmentId={assessmentId} kind="ESTIMATION" />
      <TeamProposal assessmentId={assessmentId} />
      <EstimateSummary assessmentId={assessmentId} />
    </div>
  );
}

function RunAnalysisStepBody({ assessmentId }: { assessmentId: string }) {
  const utils = trpc.useUtils();
  const summaryQuery = trpc.analysis.summary.useQuery({ assessmentId });
  const refreshing = summaryQuery.isFetching;
  const refreshAll = async () => {
    await Promise.all([
      utils.analysis.invalidate(undefined, { refetchType: "active" }),
      utils.finding.listByAssessment.invalidate({ assessmentId }),
      utils.risk.listByAssessment.invalidate({ assessmentId }),
      utils.recommendation.listByAssessment.invalidate({ assessmentId }),
      utils.scoring.listByAssessment.invalidate({ assessmentId }),
    ]);
  };
  return (
    <div className="space-y-3">
      <InFlightBanner assessmentId={assessmentId} />
      <p className="text-sm text-muted-foreground">
        Run the synthesis pipeline. Findings, risks, recommendations,
        and scores are produced together — progress per domain shows
        above while the run is in flight.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <RunAnalysisButton assessmentId={assessmentId} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void refreshAll()}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
    </div>
  );
}
