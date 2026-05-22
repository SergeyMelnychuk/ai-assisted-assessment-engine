"use client";

import { useEffect, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useFeatureFlags } from "@/lib/use-feature-flags";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AgentFlowDiagram } from "./agent-flow-diagram";
import { AgentRunCompareDialog } from "./agent-run-compare";
import {
  RunDetailsPopup,
  modeFromModel,
  modeLabel,
} from "./run-details-popup";

/**
 * Agent runs surface for an assessment.
 *
 * v1 ships a minimal "probe a GitHub file" form alongside the run
 * history. The form drafts an `AgentRun` with a single `github.read_file`
 * step and starts it; if the engagement has no GitHub PAT yet, the run
 * pauses immediately and the credential prompt component renders the
 * input. Once the PAT is supplied the run resumes inline and the
 * resulting Evidence row appears in the assessment's evidence stream.
 *
 * Hidden when the agent feature flag is off (the parent skips
 * rendering this component when `pendingCredentials` returns
 * NOT_FOUND, but we belt-and-suspenders by also tolerating that error
 * here — the run history query may bark first).
 */
export function AgentRunsPanel({
  assessmentId,
  canMutate,
}: {
  assessmentId: string;
  canMutate: boolean;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [compareRunId, setCompareRunId] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  // Gate every agent tRPC call on the feature flag — when off, we
  // skip the queries entirely so the console doesn't fill with
  // expected NOT_FOUND errors.
  const { agentEnabled } = useFeatureFlags();
  const { data, error } = trpc.agentRun.getByAssessment.useQuery(
    { assessmentId, includeArchived },
    {
      enabled: agentEnabled,
      retry: (failures, err) =>
        err.data?.code !== "NOT_FOUND" && failures < 1,
      // Poll while any run is non-terminal so the UI catches a queued
      // run flipping to RUNNING / AWAITING_USER / COMPLETED without the
      // user having to refresh. Stops polling once all runs settle.
      refetchInterval: (query) => {
        if (!agentEnabled) return false;
        const rows = query.state.data ?? [];
        const hasLive = rows.some(
          (r) =>
            r.status === "PROPOSED" ||
            r.status === "APPROVED" ||
            r.status === "RUNNING" ||
            r.status === "AWAITING_USER",
        );
        return hasLive ? 3_000 : false;
      },
    },
  );

  // Default the diagram to the most recent run so users see something
  // immediately after starting a run; explicit click overrides.
  const runs = data ?? [];
  // If the selected run was archived (or otherwise dropped from the
  // list), clear the selection — otherwise `AgentFlowDiagram` would
  // query a stale id and surface a NOT_FOUND in the console.
  //
  // IMPORTANT: this hook must run on every render, including renders
  // where we end up returning `null` below. Hooks before early
  // returns; conditional return after.
  useEffect(() => {
    if (selectedRunId && !runs.some((r) => r.id === selectedRunId)) {
      setSelectedRunId(null);
    }
  }, [runs, selectedRunId]);

  // Two reasons to skip rendering: flag off (no panel needed) or the
  // server later returned NOT_FOUND because the flag was flipped while
  // the user had the page open.
  if (!agentEnabled || error?.data?.code === "NOT_FOUND") {
    return null;
  }

  const focusRunId =
    selectedRunId && runs.some((r) => r.id === selectedRunId)
      ? selectedRunId
      : runs[0]?.id ?? null;

  // Heuristic: a non-terminal run older than 30s with no work done is
  // strong evidence the BullMQ worker is offline. (The Next.js dev
  // server doesn't run the worker — that's a separate `pnpm worker`
  // process.) Better to call this out than let the user wonder.
  const stuckCandidates = runs.filter((r) => {
    const ageMs = Date.now() - new Date(r.createdAt).getTime();
    const noProgress = r._count.steps === 0;
    const live =
      r.status === "PROPOSED" ||
      r.status === "APPROVED" ||
      r.status === "RUNNING";
    return live && noProgress && ageMs > 30_000;
  });
  const workerLikelyOffline = stuckCandidates.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Agent runs</CardTitle>
        <CardDescription>
          The agent gathers evidence from external systems with credentials
          you supply at runtime. v1 supports read-only GitHub access; the
          token is encrypted at rest with the engagement vault key.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {workerLikelyOffline ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
            <p className="font-medium text-destructive">
              The agent worker may not be running
            </p>
            <p className="mt-1 text-muted-foreground">
              {stuckCandidates.length} run
              {stuckCandidates.length === 1 ? " has" : "s have"} been waiting
              over 30 s with no steps recorded. The Next.js dev server does
              not host the BullMQ worker — start it in a separate terminal:
            </p>
            <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-[11px]">
              pnpm --filter @copilot/web worker
            </pre>
          </div>
        ) : null}
        {canMutate ? (
          <NewWorkflowRunForm assessmentId={assessmentId} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Only engagement owners and admins can start agent runs.
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Run history
          </p>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="h-3 w-3"
            />
            Show archived
          </label>
        </div>
        <RunsList
          assessmentId={assessmentId}
          runs={runs}
          canMutate={canMutate}
          selectedRunId={focusRunId}
          onSelect={setSelectedRunId}
        />
        {focusRunId && runs.length > 1 ? (
          <div className="flex items-center gap-2 text-xs">
            <label className="text-muted-foreground" htmlFor="compare-run">
              Compare with
            </label>
            <select
              id="compare-run"
              value={compareRunId ?? ""}
              onChange={(e) => setCompareRunId(e.target.value || null)}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            >
              <option value="">— pick a run —</option>
              {runs
                .filter((r) => r.id !== focusRunId)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.planName} · {r.status} ·{" "}
                    {new Date(r.createdAt).toLocaleString(undefined, {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </option>
                ))}
            </select>
          </div>
        ) : null}
        <AgentFlowDiagram runId={focusRunId} assessmentId={assessmentId} />
        {focusRunId && compareRunId ? (
          <AgentRunCompareDialog
            open={true}
            onOpenChange={(o) => {
              if (!o) setCompareRunId(null);
            }}
            leftRunId={focusRunId}
            rightRunId={compareRunId}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─── New-run form ──────────────────────────────────────────────────

/**
 * Primary (and only) form: workflow-mode run.
 *
 * Drafts an `AgentRun` with `mode: "workflow"`. The workflow planner
 * produces a graph of human-driven steps; the user works through them
 * via the React Flow diagram below. Repositories are connected later
 * inside the CONNECT_REPOSITORY step's popup, so they don't appear
 * here.
 */
function NewWorkflowRunForm({ assessmentId }: { assessmentId: string }) {
  const utils = trpc.useUtils();
  const draft = trpc.agentRun.draft.useMutation();
  const start = trpc.agentRun.start.useMutation();
  const [goal, setGoal] = useState("");
  const busy = draft.isPending || start.isPending;
  const mutationError = draft.error ?? start.error;
  const ready = !busy && goal.trim().length >= 10;

  return (
    <form
      className="rounded-md border bg-muted/30 p-3 space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        const drafted = await draft.mutateAsync({
          assessmentId,
          planName: "github-evidence",
          mode: "workflow",
          goal: goal.trim(),
        });
        await start.mutateAsync({ id: drafted.id });
        setGoal("");
        await Promise.all([
          utils.agentRun.getByAssessment.invalidate({ assessmentId }),
          utils.agentRun.workflowSnapshot.invalidate({ assessmentId }),
          utils.agentRun.pendingCredentials.invalidate({ assessmentId }),
        ]);
      }}
    >
      <p className="text-sm font-medium">
        Ask the agent to orchestrate the assessment
      </p>
      <div className="space-y-1">
        <Label htmlFor="agent-workflow-goal">Goal</Label>
        <Textarea
          id="agent-workflow-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. Run a full assessment of acme-co's API platform with a focus on security and observability."
          rows={3}
          required
          minLength={10}
          maxLength={2000}
          disabled={busy}
        />
        <p className="text-xs text-muted-foreground">
          The agent drafts a workflow plan as a diagram below. Each
          step (upload documents, connect repos, answer questions, run
          analysis) opens in a popup when you click it.
        </p>
      </div>
      {mutationError ? (
        <p className="text-xs text-destructive" role="alert">
          {mutationError.message}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!ready}>
          {busy ? "Drafting plan…" : "Draft workflow plan"}
        </Button>
      </div>
    </form>
  );
}

// ─── Run history list ──────────────────────────────────────────────

type RunRow = RouterOutputs["agentRun"]["getByAssessment"][number];

function RunsList({
  assessmentId,
  runs,
  canMutate,
  selectedRunId,
  onSelect,
}: {
  assessmentId: string;
  runs: readonly RunRow[];
  canMutate: boolean;
  selectedRunId: string | null;
  onSelect: (id: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No agent runs yet.</p>
    );
  }
  return (
    <ul className="divide-y rounded-md border">
      {runs.map((r) => (
        <RunRowItem
          key={r.id}
          assessmentId={assessmentId}
          run={r}
          canMutate={canMutate}
          isSelected={r.id === selectedRunId}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function RunRowItem({
  assessmentId,
  run,
  canMutate,
  isSelected,
  onSelect,
}: {
  assessmentId: string;
  run: RunRow;
  canMutate: boolean;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const utils = trpc.useUtils();
  const invalidate = () =>
    Promise.all([
      utils.agentRun.getByAssessment.invalidate({ assessmentId }),
      utils.agentRun.pendingCredentials.invalidate({ assessmentId }),
      utils.agentRun.get.invalidate({ id: run.id }),
    ]);
  const cancel = trpc.agentRun.cancel.useMutation({ onSuccess: invalidate });
  const resume = trpc.agentRun.resume.useMutation({ onSuccess: invalidate });
  const archive = trpc.agentRun.archive.useMutation({
    onSuccess: () =>
      Promise.all([
        invalidate(),
        utils.agentRun.workflowSnapshot.invalidate({ assessmentId }),
      ]),
  });
  const restore = trpc.agentRun.restore.useMutation({
    onSuccess: () =>
      Promise.all([
        invalidate(),
        utils.agentRun.workflowSnapshot.invalidate({ assessmentId }),
      ]),
  });
  const del = trpc.agentRun.delete.useMutation({
    onSuccess: () =>
      Promise.all([
        invalidate(),
        utils.agentRun.workflowSnapshot.invalidate({ assessmentId }),
      ]),
  });
  // Two-step delete pattern: first click swaps the button into a
  // "Really delete?" red button; second click triggers the mutation.
  // Avoids window.confirm() while keeping the destructive path
  // behind a deliberate second action.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Cancel only makes sense on non-terminal rows. Terminal runs render
  // a static badge and no button — clicking "cancel" on a COMPLETED
  // row would be confusing.
  const isTerminal =
    run.status === "COMPLETED" ||
    run.status === "FAILED" ||
    run.status === "CANCELLED" ||
    run.status === "BUDGET_EXHAUSTED";
  const isArchived = run.archivedAt !== null;
  const busyMutation =
    archive.isPending || restore.isPending || del.isPending;
  const lifecycleError =
    cancel.error ?? resume.error ?? archive.error ?? restore.error ?? del.error;
  return (
    <li
      className={`flex items-center justify-between gap-3 p-3 text-sm ${
        isSelected ? "bg-muted/40" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(run.id)}
        className="min-w-0 flex-1 cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        aria-pressed={isSelected}
      >
        {/* Buttons can't legally contain <div>/<p>; use spans with
         *  block classes so the layout reads as stacked but the HTML
         *  stays valid. */}
        <span className="flex items-center gap-2">
          <RunStatusBadge status={run.status} />
          <span className="font-medium">
            {modeLabel(modeFromModel(run.model))}
          </span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {run._count.steps} step{run._count.steps === 1 ? "" : "s"}
          {" · "}created {new Date(run.createdAt).toLocaleString()}
          {run.endReason ? ` · ${run.endReason}` : ""}
        </span>
        {isArchived ? (
          <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
            Archived
          </span>
        ) : null}
        {lifecycleError ? (
          <span className="block text-xs text-destructive" role="alert">
            {lifecycleError.message}
          </span>
        ) : null}
      </button>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setDetailsOpen(true)}
          title="Show the original goal + repositories for this run"
        >
          Details
        </Button>
        <RunDetailsPopup
          runId={run.id}
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
        />
        {run.status === "AWAITING_USER" && !isArchived ? (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            Waiting on credential — see prompt above
          </span>
        ) : null}
        {canMutate && !isArchived && !isTerminal ? (
          <>
            {/* Resume only makes sense on AWAITING_USER (paused on a
             *  credential the user just supplied) or on RUNNING runs
             *  whose worker died — both render as "stuck" rows in the
             *  list. PROPOSED / APPROVED have nothing to resume. */}
            {(run.status === "AWAITING_USER" ||
              run.status === "RUNNING") && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={resume.isPending}
                onClick={() => resume.mutate({ id: run.id })}
                title="Re-enqueue this run on the BullMQ worker"
              >
                {resume.isPending ? "Resuming…" : "Resume"}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({ id: run.id })}
            >
              {cancel.isPending ? "Cancelling…" : "Cancel"}
            </Button>
          </>
        ) : null}
        {canMutate && !isArchived ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busyMutation}
            onClick={() => archive.mutate({ id: run.id })}
            title="Hide this run from the default list"
          >
            {archive.isPending ? "Archiving…" : "Archive"}
          </Button>
        ) : null}
        {canMutate && isArchived ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busyMutation}
              onClick={() => restore.mutate({ id: run.id })}
            >
              {restore.isPending ? "Restoring…" : "Restore"}
            </Button>
            {confirmDelete ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busyMutation}
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busyMutation}
                  onClick={() => del.mutate({ id: run.id })}
                >
                  {del.isPending ? "Deleting…" : "Really delete?"}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busyMutation}
                onClick={() => setConfirmDelete(true)}
                title="Cascade-delete this run and all its steps + tool calls"
              >
                Delete
              </Button>
            )}
          </>
        ) : null}
      </div>
    </li>
  );
}

function RunStatusBadge({ status }: { status: RunRow["status"] }) {
  const tone = (() => {
    switch (status) {
      case "RUNNING":
      case "AWAITING_USER":
        return "border-amber-500/40 bg-amber-500/10 text-foreground";
      case "COMPLETED":
        return "border-green-500/40 bg-green-500/10 text-foreground";
      case "FAILED":
      case "BUDGET_EXHAUSTED":
        return "border-destructive/40 bg-destructive/10 text-foreground";
      case "CANCELLED":
        return "border-muted-foreground/30 bg-muted text-muted-foreground";
      case "PROPOSED":
      case "APPROVED":
      default:
        return "border-border bg-muted text-foreground";
    }
  })();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
