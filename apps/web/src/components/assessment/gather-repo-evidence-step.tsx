"use client";

import { useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Body of the GATHER_REPOSITORY_EVIDENCE workflow step.
 *
 * Lets the user fire an autonomous evidence-collection run scoped to
 * one of the engagement's connected repositories. Repos are listed
 * from the existing `repositoryLink.list` query — no manual entry —
 * so the user can't accidentally point the agent at a repo they
 * haven't authenticated to. If no repos are connected, points the
 * user back at the CONNECT_REPOSITORY step.
 *
 * The run uses the existing `agentRun.draft` + `agentRun.start` path
 * with `mode: "tool"` (the tool-call planner) so it pauses for a
 * GitHub PAT if needed and emits Evidence directly. Recently-started
 * runs of this type appear below the form so the user can watch
 * their progress without leaving the popup.
 */

type RepoLink = {
  id: string;
  url: string;
};

function parseOwnerRepoFromUrl(url: string): {
  owner: string;
  repo: string;
} | null {
  const m = url.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  );
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export function GatherRepoEvidenceStep({
  assessmentId,
}: {
  assessmentId: string;
}) {
  const utils = trpc.useUtils();
  const repos = trpc.repositoryLink.list.useQuery({ assessmentId });
  const runs = trpc.agentRun.getByAssessment.useQuery(
    { assessmentId },
    {
      // Live-update so the user sees their just-started run flip
      // states (RUNNING → AWAITING_USER → COMPLETED).
      refetchInterval: (q) => {
        const rows = q.state.data ?? [];
        const live = rows.some(
          (r) =>
            r.status === "PROPOSED" ||
            r.status === "APPROVED" ||
            r.status === "RUNNING" ||
            r.status === "AWAITING_USER",
        );
        return live ? 3_000 : false;
      },
    },
  );
  const draft = trpc.agentRun.draft.useMutation();
  const start = trpc.agentRun.start.useMutation();

  const [selectedRepoId, setSelectedRepoId] = useState<string>("");
  const [goal, setGoal] = useState("");
  const busy = draft.isPending || start.isPending;
  const error = draft.error ?? start.error;

  const repoList: RepoLink[] = repos.data ?? [];
  const selectedRepo = repoList.find((r) => r.id === selectedRepoId);
  const parsed = selectedRepo ? parseOwnerRepoFromUrl(selectedRepo.url) : null;
  const goalEmpty = goal.trim().length === 0;
  const ready = !busy && !!parsed && !goalEmpty;
  const disabledHint = busy
    ? null
    : !selectedRepoId
      ? "Pick a connected repository above."
      : !parsed
        ? null /* the inline parse-error renders its own message */
        : goalEmpty
          ? "Add a sentence or two so the agent knows what to look for."
          : null;

  if (repos.isLoading) {
    return (
      <p className="text-sm text-muted-foreground">Loading repositories…</p>
    );
  }

  if (repoList.length === 0) {
    return (
      <div className="space-y-2 text-sm">
        <p>No repositories connected yet.</p>
        <p className="text-muted-foreground">
          Open the <strong>Repositories</strong> step first to connect at
          least one GitHub repository. Once connected, return here to ask
          the agent to gather evidence from it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ready || !parsed) return;
          const drafted = await draft.mutateAsync({
            assessmentId,
            planName: "github-evidence",
            mode: "tool",
            goal: goal.trim(),
            repository: parsed,
          });
          await start.mutateAsync({ id: drafted.id });
          setGoal("");
          await Promise.all([
            utils.agentRun.getByAssessment.invalidate({ assessmentId }),
            utils.agentRun.pendingCredentials.invalidate({ assessmentId }),
          ]);
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="gather-repo">Repository</Label>
          <select
            id="gather-repo"
            value={selectedRepoId}
            onChange={(e) => setSelectedRepoId(e.target.value)}
            disabled={busy}
            required
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">Pick a connected repository…</option>
            {repoList.map((r) => (
              <option key={r.id} value={r.id}>
                {r.url}
              </option>
            ))}
          </select>
          {selectedRepoId && !parsed ? (
            <p className="text-xs text-destructive" role="alert">
              That repository&apos;s URL isn&apos;t a recognised GitHub URL —
              re-link it from the Repositories step.
            </p>
          ) : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor="gather-goal">What should the agent look for?</Label>
          <Textarea
            id="gather-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Surface evidence about authentication and authorization across the codebase."
            rows={3}
            required
            maxLength={2000}
            disabled={busy}
          />
          <p className="text-xs text-muted-foreground">
            The agent will pause for a GitHub PAT the first time it needs
            one (the prompt appears above the workflow card).
          </p>
        </div>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error.message}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={!ready}>
            {busy ? "Starting…" : "Start evidence collection"}
          </Button>
          {disabledHint ? (
            <p className="text-xs text-muted-foreground">{disabledHint}</p>
          ) : null}
        </div>
      </form>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Recent autonomous runs
        </p>
        <RecentRuns
          runs={(runs.data ?? []).filter(
            (r) => r.model === "agent.harness.v1.planner",
          )}
        />
      </div>
    </div>
  );
}

function RecentRuns({
  runs,
}: {
  runs: ReadonlyArray<{
    id: string;
    status: string;
    createdAt: Date | string;
    endReason: string | null;
    _count: { steps: number };
  }>;
}) {
  if (runs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No autonomous runs yet for this assessment.
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-md border text-xs">
      {runs.slice(0, 5).map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-2 p-2">
          <span className="font-medium">{r.status}</span>
          <span className="text-muted-foreground">
            {r._count.steps} step{r._count.steps === 1 ? "" : "s"}
            {r.endReason ? ` · ${r.endReason}` : ""}
          </span>
          <Link
            href="#agent-runs-card"
            className="text-muted-foreground underline-offset-4 hover:underline"
          >
            View
          </Link>
        </li>
      ))}
    </ul>
  );
}
