"use client";

import { trpc } from "@/lib/trpc";
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
import { Button } from "@/components/ui/button";

/**
 * Read-only popup that shows what the user originally asked the agent
 * to do. Reads from `agentRun.get` and parses the persisted task
 * envelope (`systemPrompt` JSON).
 *
 * Three shapes possible:
 *   - **Workflow**: `{ mode: "workflow", goal, repositories }` — show
 *     the goal text + initial repos.
 *   - **Autonomous tool-call**: `{ goal, repository }` — show goal +
 *     single target repo.
 *   - **Static probe**: `{ task: [...] }` — show the explicit tool
 *     calls the user pre-baked.
 */

type RunMode = "workflow" | "autonomous" | "probe" | "unknown";

const MODEL_TO_MODE: Record<string, RunMode> = {
  "agent.harness.v1.workflow": "workflow",
  "agent.harness.v1.planner": "autonomous",
  "agent.harness.v1.static-task": "probe",
};

export function modeFromModel(model: string | null | undefined): RunMode {
  if (!model) return "unknown";
  return MODEL_TO_MODE[model] ?? "unknown";
}

const MODE_LABELS: Record<RunMode, string> = {
  workflow: "Workflow plan",
  autonomous: "Autonomous evidence collection",
  probe: "Single-file probe",
  unknown: "Agent run",
};

export function modeLabel(mode: RunMode): string {
  return MODE_LABELS[mode];
}

export function RunDetailsPopup({
  runId,
  open,
  onOpenChange,
}: {
  runId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading, error } = trpc.agentRun.get.useQuery(
    { id: runId ?? "" },
    { enabled: !!runId && open, retry: false },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Agent run details</DialogTitle>
          <DialogDescription>
            What was originally requested + the run&apos;s current state.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">
              Couldn&apos;t load the run: {error.message}
            </p>
          ) : data ? (
            <RunDetailsBody run={data} />
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Body ──────────────────────────────────────────────────────────

interface ParsedTaskWorkflow {
  mode: "workflow";
  goal: string;
  repositories: ReadonlyArray<{ owner: string; repo: string; ref?: string }>;
}
interface ParsedTaskAutonomous {
  mode: "autonomous";
  goal: string;
  repository: { owner: string; repo: string; ref?: string };
}
interface ParsedTaskStatic {
  mode: "probe";
  task: Array<{ tool: string; args?: unknown }>;
}
type ParsedTask =
  | ParsedTaskWorkflow
  | ParsedTaskAutonomous
  | ParsedTaskStatic
  | { mode: "unknown"; raw: string };

function parseSystemPrompt(systemPrompt: string): ParsedTask {
  try {
    const obj = JSON.parse(systemPrompt) as Record<string, unknown>;
    if (obj?.mode === "workflow" && typeof obj.goal === "string") {
      return {
        mode: "workflow",
        goal: obj.goal,
        repositories: Array.isArray(obj.repositories)
          ? (obj.repositories as ParsedTaskWorkflow["repositories"])
          : [],
      };
    }
    if (typeof obj?.goal === "string" && obj.repository) {
      return {
        mode: "autonomous",
        goal: obj.goal,
        repository: obj.repository as ParsedTaskAutonomous["repository"],
      };
    }
    if (Array.isArray(obj?.task)) {
      return { mode: "probe", task: obj.task as ParsedTaskStatic["task"] };
    }
    return { mode: "unknown", raw: systemPrompt };
  } catch {
    return { mode: "unknown", raw: systemPrompt };
  }
}

function RunDetailsBody({
  run,
}: {
  run: {
    id: string;
    status: string;
    model: string;
    createdAt: Date | string;
    startedAt: Date | string | null;
    endedAt: Date | string | null;
    endReason: string | null;
    systemPrompt: string;
    archivedAt: Date | string | null;
  };
}) {
  const mode = modeFromModel(run.model);
  const parsed = parseSystemPrompt(run.systemPrompt);

  return (
    <div className="space-y-4 text-sm">
      <Row label="Run kind" value={modeLabel(mode)} />
      <Row label="Status" value={run.status.replace("_", " ")} />
      <Row
        label="Created"
        value={new Date(run.createdAt).toLocaleString()}
      />
      {run.startedAt ? (
        <Row
          label="Started"
          value={new Date(run.startedAt).toLocaleString()}
        />
      ) : null}
      {run.endedAt ? (
        <Row
          label="Ended"
          value={new Date(run.endedAt).toLocaleString()}
        />
      ) : null}
      {run.endReason ? <Row label="End reason" value={run.endReason} /> : null}
      {run.archivedAt ? (
        <Row
          label="Archived"
          value={new Date(run.archivedAt).toLocaleString()}
        />
      ) : null}

      <hr className="border-border" />

      <h3 className="text-sm font-semibold">Original request</h3>
      {parsed.mode === "workflow" ? (
        <>
          <Row label="Goal" multiline value={parsed.goal} />
          {parsed.repositories.length > 0 ? (
            <Row
              label="Initial repositories"
              value={parsed.repositories
                .map(
                  (r) =>
                    `${r.owner}/${r.repo}${r.ref ? `@${r.ref}` : ""}`,
                )
                .join("\n")}
              multiline
            />
          ) : null}
        </>
      ) : parsed.mode === "autonomous" ? (
        <>
          <Row label="Goal" multiline value={parsed.goal} />
          <Row
            label="Target repository"
            value={`${parsed.repository.owner}/${parsed.repository.repo}${
              parsed.repository.ref ? `@${parsed.repository.ref}` : ""
            }`}
          />
        </>
      ) : parsed.mode === "probe" ? (
        <Row
          label="Tool sequence"
          multiline
          value={parsed.task
            .map(
              (s, i) =>
                `${i + 1}. ${s.tool}\n   ${JSON.stringify(s.args, null, 2).replace(/\n/g, "\n   ")}`,
            )
            .join("\n")}
        />
      ) : (
        <Row
          label="Raw envelope"
          multiline
          value={parsed.raw}
        />
      )}
    </div>
  );
}

function Row({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={
          multiline
            ? "whitespace-pre-wrap font-mono text-xs"
            : "text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  );
}
