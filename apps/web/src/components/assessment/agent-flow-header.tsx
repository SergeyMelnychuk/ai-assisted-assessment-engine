"use client";

import { useMemo } from "react";
import type { RouterOutputs } from "@/lib/trpc";

/**
 * Tier 1 context band for the agent-flow trace viewer.
 *
 * Pulls everything an operator wants to know at a glance from the run
 * detail payload — goal, status, timing, totals, budget consumption,
 * halt reason — and renders it as a single horizontal strip above the
 * React Flow canvas. Without this, every "what is this run" question
 * required clicking through to per-step data.
 */

type RunDetail = RouterOutputs["agentRun"]["get"];

const STATUS_TONE: Record<string, string> = {
  PROPOSED: "border-border bg-muted text-foreground",
  APPROVED: "border-blue-500/40 bg-blue-500/10 text-foreground",
  RUNNING: "border-amber-500/40 bg-amber-500/10 text-foreground",
  AWAITING_USER: "border-amber-500/40 bg-amber-500/10 text-foreground",
  COMPLETED: "border-green-500/40 bg-green-500/10 text-foreground",
  BUDGET_EXHAUSTED:
    "border-destructive/40 bg-destructive/10 text-foreground",
  CANCELLED: "border-muted-foreground/30 bg-muted text-muted-foreground",
  FAILED: "border-destructive/40 bg-destructive/10 text-foreground",
};

export function AgentFlowHeader({ run }: { run: RunDetail }) {
  const totals = useMemo(() => computeTotals(run), [run]);
  const budget = useMemo(() => readBudget(run), [run]);
  const halt = useMemo(() => readHaltReason(run), [run]);

  return (
    <div className="space-y-3 border-b bg-card px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 grow">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span>Goal</span>
            <span
              className={
                "rounded-full border px-1.5 py-0.5 text-[10px] font-medium " +
                (STATUS_TONE[run.status] ?? STATUS_TONE.PROPOSED)
              }
              aria-label={`Run status: ${run.status}`}
            >
              {run.status.replace(/_/g, " ")}
            </span>
            <span className="text-muted-foreground">· {run.planName}</span>
          </div>
          <p className="mt-1 text-sm font-medium text-foreground">
            {readGoal(run) ?? "(no goal recorded)"}
          </p>
        </div>
        <dl className="grid shrink-0 grid-cols-3 gap-x-4 gap-y-1 text-right text-xs sm:grid-cols-5">
          <Stat label="Steps" value={`${run.steps.length}`} />
          <Stat
            label="Tokens"
            value={fmt(totals.inputTokens + totals.outputTokens)}
            sub={`${fmt(totals.inputTokens)}↓ ${fmt(totals.outputTokens)}↑`}
          />
          <Stat
            label="Cost"
            value={formatUsd(run.cost.totalUsd)}
            sub={`${run.cost.calls} call${run.cost.calls === 1 ? "" : "s"}`}
          />
          <Stat label="Started" value={formatRelative(run.startedAt)} />
          <Stat label="Duration" value={formatDuration(run)} />
        </dl>
      </div>

      <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        <BudgetBar
          label="Turns"
          used={run.steps.length}
          max={budget.maxTurns}
        />
        <BudgetBar
          label="Tokens"
          used={totals.inputTokens + totals.outputTokens}
          max={budget.maxTokens}
        />
        {run.cost.cachedReadInputTokens > 0 ? (
          <span title="Cached read input tokens — Anthropic prompt-cache hits (ADR-0012)">
            Cache hits: {fmt(run.cost.cachedReadInputTokens)} tok read,{" "}
            {fmt(run.cost.cachedCreationInputTokens)} tok written
          </span>
        ) : null}
      </div>

      {halt ? (
        <div
          className={
            "rounded-md border px-3 py-2 text-xs " +
            (halt.severity === "error"
              ? "border-destructive/40 bg-destructive/10 text-foreground"
              : "border-border bg-muted text-foreground")
          }
        >
          <span className="font-medium uppercase tracking-wide text-[10px] text-muted-foreground">
            Halt reason
          </span>
          <p className="mt-0.5">{halt.message}</p>
        </div>
      ) : null}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="font-medium tabular-nums text-foreground">{value}</dd>
      {sub ? <dd className="text-[10px] text-muted-foreground">{sub}</dd> : null}
    </div>
  );
}

function BudgetBar({
  label,
  used,
  max,
}: {
  label: string;
  used: number;
  max: number | null;
}) {
  if (!max || max <= 0) {
    return (
      <span className="inline-flex items-baseline gap-1">
        {label}: <span className="text-foreground">{fmt(used)}</span>
      </span>
    );
  }
  const pct = Math.min(100, Math.round((used / max) * 100));
  const exhausted = pct >= 100;
  return (
    <span className="inline-flex items-center gap-2">
      <span>
        {label}: {fmt(used)}/{fmt(max)}
      </span>
      <span
        className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"
        aria-label={`${label} budget ${pct}%`}
      >
        <span
          className={
            "block h-full " +
            (exhausted
              ? "bg-destructive"
              : pct >= 80
                ? "bg-amber-500"
                : "bg-primary")
          }
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}

// ─── Data extraction helpers ───────────────────────────────────────

function computeTotals(run: RunDetail): {
  inputTokens: number;
  outputTokens: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const s of run.steps) {
    inputTokens += s.inputTokens;
    outputTokens += s.outputTokens;
  }
  return { inputTokens, outputTokens };
}

function readBudget(run: RunDetail): {
  maxTurns: number | null;
  maxTokens: number | null;
} {
  const b = (run.budget ?? {}) as Record<string, unknown>;
  return {
    maxTurns: typeof b.maxTurns === "number" ? b.maxTurns : null,
    maxTokens: typeof b.maxTokens === "number" ? b.maxTokens : null,
  };
}

function readGoal(run: RunDetail): string | null {
  // The goal lives in the first PLAN step's payload — the workflow
  // planner writes it as `goal` when it lays out the initial graph.
  const firstPlan = run.steps.find((s) => s.kind === "PLAN");
  const payload = (firstPlan?.payload ?? {}) as Record<string, unknown>;
  if (typeof payload.goal === "string") return payload.goal;
  if (typeof payload.prompt === "string") return payload.prompt;
  return null;
}

function readHaltReason(
  run: RunDetail,
): { message: string; severity: "error" | "info" } | null {
  if (run.status === "FAILED") {
    const err = (run.errorDetails ?? {}) as Record<string, unknown>;
    const msg =
      (typeof err.message === "string" && err.message) ||
      (typeof run.endReason === "string" && run.endReason) ||
      "Run failed without a recorded reason.";
    return { message: msg, severity: "error" };
  }
  if (run.status === "BUDGET_EXHAUSTED") {
    return {
      message:
        run.endReason ??
        "Budget exhausted — increase maxTurns / maxTokens and re-run.",
      severity: "error",
    };
  }
  if (run.status === "CANCELLED") {
    return {
      message: run.endReason ?? "Cancelled by user.",
      severity: "info",
    };
  }
  if (run.status === "COMPLETED") {
    // Surface the last PLAN's stop reason if it was a deliberate halt.
    const reversedPlans = [...run.steps]
      .reverse()
      .filter((s) => s.kind === "PLAN");
    const lastPlan = reversedPlans[0];
    const decision = (
      (lastPlan?.payload ?? {}) as { decision?: { kind?: string; reason?: string } }
    ).decision;
    if (decision?.kind === "stop" && decision.reason) {
      return { message: decision.reason, severity: "info" };
    }
  }
  return null;
}

// ─── Formatters ────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatUsd(n: number): string {
  if (n < 0.01) return "<$0.01";
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function formatRelative(ts: Date | string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDuration(run: RunDetail): string {
  if (!run.startedAt) return "—";
  const start = new Date(run.startedAt).getTime();
  const end = run.endedAt ? new Date(run.endedAt).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}
