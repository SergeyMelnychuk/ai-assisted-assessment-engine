"use client";

import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Tier 5 — side-by-side diff between two agent runs of the same
 * assessment. The user picks a "compare with" run from the list of
 * sibling runs; we pull a summary diff from the server and show:
 *
 *   - Headline metrics (status, steps, tokens, evidence count) with
 *     a delta column.
 *   - Per-tool counts with success/failure breakdown.
 *
 * Step-by-step diff is out of scope here — the scrubber + side panel
 * on each run already cover that drill-down.
 */

type CompareResult = RouterOutputs["agentRun"]["compareRuns"];

export function AgentRunCompareDialog({
  open,
  onOpenChange,
  leftRunId,
  rightRunId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leftRunId: string;
  rightRunId: string;
}) {
  const { data, isLoading, error } = trpc.agentRun.compareRuns.useQuery(
    { leftRunId, rightRunId },
    { enabled: open && !!leftRunId && !!rightRunId },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Compare runs</DialogTitle>
          <DialogDescription>
            Side-by-side summary of two runs on the same assessment.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : data ? (
          <CompareBody data={data} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CompareBody({ data }: { data: CompareResult }) {
  const rows: Array<{
    label: string;
    left: string;
    right: string;
    delta: string;
  }> = [
    {
      label: "Status",
      left: data.left.status,
      right: data.right.status,
      delta: data.left.status === data.right.status ? "—" : "changed",
    },
    {
      label: "Steps",
      left: `${data.left.steps}`,
      right: `${data.right.steps}`,
      delta: fmtDelta(data.delta.steps),
    },
    {
      label: "Input tokens",
      left: data.left.inputTokens.toLocaleString(),
      right: data.right.inputTokens.toLocaleString(),
      delta: fmtDelta(data.delta.inputTokens),
    },
    {
      label: "Output tokens",
      left: data.left.outputTokens.toLocaleString(),
      right: data.right.outputTokens.toLocaleString(),
      delta: fmtDelta(data.delta.outputTokens),
    },
    {
      label: "Evidence emitted",
      left: `${data.left.evidenceCount}`,
      right: `${data.right.evidenceCount}`,
      delta: fmtDelta(data.delta.evidenceCount),
    },
    {
      label: "Halt reason",
      left: data.left.endReason ?? "—",
      right: data.right.endReason ?? "—",
      delta:
        (data.left.endReason ?? "") === (data.right.endReason ?? "")
          ? "—"
          : "changed",
    },
  ];
  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="py-1">Metric</th>
            <th className="py-1">Left</th>
            <th className="py-1">Right</th>
            <th className="py-1 text-right">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t">
              <td className="py-1.5 text-muted-foreground">{r.label}</td>
              <td className="py-1.5 font-mono">{r.left}</td>
              <td className="py-1.5 font-mono">{r.right}</td>
              <td className="py-1.5 text-right font-mono">{r.delta}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.toolDiff.length > 0 ? (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Per-tool counts
          </h3>
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-1">Tool</th>
                <th className="py-1">Left ok/fail</th>
                <th className="py-1">Right ok/fail</th>
              </tr>
            </thead>
            <tbody>
              {data.toolDiff.map((t) => (
                <tr key={t.toolName} className="border-t">
                  <td className="py-1 font-mono">{t.toolName}</td>
                  <td className="py-1">
                    {t.left.ok}/{t.left.failed}
                  </td>
                  <td className="py-1">
                    {t.right.ok}/{t.right.failed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => navigator.clipboard?.writeText(JSON.stringify(data, null, 2))}
      >
        Copy diff JSON
      </Button>
    </div>
  );
}

function fmtDelta(n: number): string {
  if (n === 0) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}
