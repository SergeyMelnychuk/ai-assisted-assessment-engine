"use client";

import { useState } from "react";
import Link from "next/link";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Tier 3 inspection panel for a single agent step.
 *
 * Slides in from the right when a node on the flow diagram is
 * selected. Renders everything we have for that step:
 *
 *   - PLAN: the planner's full reasoning + the decision payload.
 *   - TOOL_CALL: tool name, arg JSON, output JSON, error class +
 *     message, retry count, duration, and links to the Evidence rows
 *     it emitted.
 *   - SYSTEM: bookkeeping kind + reason.
 *   - USER_INPUT: credential supply context.
 *
 * The diagram nodes themselves stay compact; this panel is where the
 * deep audit material lives. Close button + outside-click handler
 * both clear the selection.
 */

type RunDetail = RouterOutputs["agentRun"]["get"];
type RunStep = RunDetail["steps"][number];

export function AgentStepPanel({
  step,
  assessmentId,
  onClose,
}: {
  step: RunStep | null;
  assessmentId: string;
  onClose: () => void;
}) {
  if (!step) return null;
  const payload = (step.payload ?? {}) as Record<string, unknown>;
  return (
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l bg-card">
      <header className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Step #{step.idx} · {step.kind}
          </p>
          <p className="mt-0.5 text-sm font-medium">
            {summariseStep(step)}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {new Date(step.createdAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "medium",
            })}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">
          ×
        </Button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3 text-xs">
        {step.kind === "PLAN" ? <PlanBody payload={payload} /> : null}
        {step.kind === "TOOL_CALL" ? (
          <ToolBody step={step} assessmentId={assessmentId} />
        ) : null}
        {step.kind === "SYSTEM" || step.kind === "ASSISTANT" ? (
          <SystemBody payload={payload} />
        ) : null}
        {step.kind === "USER_INPUT" ? <UserBody payload={payload} /> : null}

        <Section title="Tokens & cost">
          <KV label="Input tokens" value={step.inputTokens.toLocaleString()} />
          <KV label="Output tokens" value={step.outputTokens.toLocaleString()} />
        </Section>

        <AnnotationsBlock step={step} />

        {step.kind === "TOOL_CALL" ? <ReplayBlock step={step} /> : null}

        <Section title="Raw payload" collapsibleByDefault>
          <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-2 text-[10px] leading-snug">
            {JSON.stringify(step.payload, null, 2)}
          </pre>
        </Section>
      </div>
    </aside>
  );
}

// ─── Tier 5 — Annotations ──────────────────────────────────────────

function AnnotationsBlock({ step }: { step: RunStep }) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState("");
  const add = trpc.agentRun.addAnnotation.useMutation({
    onSuccess: async () => {
      setDraft("");
      // Refresh the parent run so the new note appears immediately.
      await utils.agentRun.get.invalidate();
    },
  });
  const resolve = trpc.agentRun.resolveAnnotation.useMutation({
    onSuccess: () => utils.agentRun.get.invalidate(),
  });
  const annotations = (step as RunStep & { annotations?: Array<{
    id: string;
    body: string;
    createdAt: Date | string;
    resolvedAt: Date | string | null;
  }> }).annotations ?? [];

  return (
    <Section title={`Notes (${annotations.length})`}>
      <ul className="space-y-1">
        {annotations.map((a) => (
          <li
            key={a.id}
            className={
              "rounded border px-2 py-1 " +
              (a.resolvedAt
                ? "border-border bg-muted/40 text-muted-foreground line-through"
                : "border-amber-500/40 bg-amber-500/10")
            }
          >
            <p className="whitespace-pre-wrap">{a.body}</p>
            <div className="mt-0.5 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>{new Date(a.createdAt).toLocaleString()}</span>
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() =>
                  resolve.mutate({
                    annotationId: a.id,
                    resolved: a.resolvedAt === null,
                  })
                }
              >
                {a.resolvedAt ? "Reopen" : "Resolve"}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-2 space-y-1">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Add a note for follow-up…"
          className="text-xs"
        />
        <Button
          size="sm"
          disabled={!draft.trim() || add.isPending}
          onClick={() =>
            add.mutate({ stepId: step.id, body: draft.trim() })
          }
        >
          {add.isPending ? "Saving…" : "Add note"}
        </Button>
        {add.error ? (
          <p className="text-[10px] text-destructive">{add.error.message}</p>
        ) : null}
      </div>
    </Section>
  );
}

// ─── Tier 5 — Replay tool call ─────────────────────────────────────

function ReplayBlock({ step }: { step: RunStep }) {
  const utils = trpc.useUtils();
  const call = step.toolCalls[0];
  const [draft, setDraft] = useState<string>(
    JSON.stringify(call?.argsJson ?? {}, null, 2),
  );
  const [parseError, setParseError] = useState<string | null>(null);
  const replay = trpc.agentRun.replayToolCall.useMutation({
    onSuccess: () => utils.agentRun.get.invalidate(),
  });
  if (!call) return null;
  const submit = () => {
    setParseError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft);
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : "Invalid JSON",
      );
      return;
    }
    replay.mutate({ stepId: step.id, argsOverride: parsed });
  };
  return (
    <Section title="Replay tool call" collapsibleByDefault>
      <p className="text-[10px] text-muted-foreground">
        Re-dispatches <code className="font-mono">{call.toolName}</code>{" "}
        with the args below. Result appears as a new step on this run.
      </p>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={6}
        spellCheck={false}
        className="mt-1 font-mono text-[10px]"
      />
      {parseError ? (
        <p className="text-[10px] text-destructive">JSON: {parseError}</p>
      ) : null}
      <Button
        size="sm"
        variant="secondary"
        disabled={replay.isPending}
        onClick={submit}
      >
        {replay.isPending ? "Queueing…" : "Replay"}
      </Button>
      {replay.error ? (
        <p className="text-[10px] text-destructive">{replay.error.message}</p>
      ) : null}
    </Section>
  );
}

// ─── Per-kind body panels ──────────────────────────────────────────

function PlanBody({ payload }: { payload: Record<string, unknown> }) {
  const reason = typeof payload.reason === "string" ? payload.reason : null;
  const decision = (payload.decision ?? {}) as {
    kind?: string;
    tool?: string;
    args?: Record<string, unknown>;
    reason?: string;
  };
  return (
    <>
      <Section title="Planner reasoning">
        <p className="whitespace-pre-wrap leading-relaxed text-foreground">
          {reason ?? "(no reasoning captured)"}
        </p>
      </Section>
      <Section title="Decision">
        <KV
          label="Kind"
          value={decision.kind ?? "—"}
        />
        {decision.tool ? <KV label="Tool" value={decision.tool} /> : null}
        {decision.reason ? (
          <KV label="Reason" value={decision.reason} multiline />
        ) : null}
        {decision.args ? (
          <pre className="mt-1 max-h-48 overflow-auto rounded-md border bg-muted/30 p-2 text-[10px]">
            {JSON.stringify(decision.args, null, 2)}
          </pre>
        ) : null}
      </Section>
    </>
  );
}

function ToolBody({
  step,
  assessmentId,
}: {
  step: RunStep;
  assessmentId: string;
}) {
  const call = step.toolCalls[0];
  if (!call) {
    return (
      <Section title="Tool call">
        <p className="text-muted-foreground">No tool-call row for this step.</p>
      </Section>
    );
  }
  return (
    <>
      <Section title="Tool">
        <KV label="Name" value={call.toolName} />
        <KV label="Status" value={call.status} />
        {call.durationMs != null ? (
          <KV label="Duration" value={`${call.durationMs} ms`} />
        ) : null}
        {call.startedAt ? (
          <KV
            label="Started"
            value={new Date(call.startedAt).toLocaleTimeString()}
          />
        ) : null}
        {call.errorClass ? (
          <KV label="Error class" value={call.errorClass} />
        ) : null}
      </Section>
      <Section title="Arguments">
        <pre className="max-h-48 overflow-auto rounded-md border bg-muted/30 p-2 text-[10px]">
          {JSON.stringify(call.argsJson, null, 2)}
        </pre>
      </Section>
      <Section title="Result">
        {call.resultJson ? (
          <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-2 text-[10px]">
            {JSON.stringify(call.resultJson, null, 2)}
          </pre>
        ) : (
          <p className="text-muted-foreground">
            {call.status === "FAILED" || call.status === "TIMED_OUT"
              ? "(no result — call failed)"
              : "(no result captured)"}
          </p>
        )}
      </Section>
      {call.evidenceIds.length > 0 ? (
        <Section title={`Evidence emitted (${call.evidenceIds.length})`}>
          <Link
            href={`/engagements/_/evidence?assessmentId=${assessmentId}&evidenceIds=${call.evidenceIds.join(",")}`}
            className="text-primary underline-offset-2 hover:underline"
          >
            Open in Evidence Explorer →
          </Link>
          <ul className="mt-1 list-inside list-disc text-muted-foreground">
            {call.evidenceIds.slice(0, 10).map((id) => (
              <li key={id} className="truncate font-mono text-[10px]">
                {id}
              </li>
            ))}
            {call.evidenceIds.length > 10 ? (
              <li className="text-[10px]">
                …and {call.evidenceIds.length - 10} more
              </li>
            ) : null}
          </ul>
        </Section>
      ) : null}
    </>
  );
}

function SystemBody({ payload }: { payload: Record<string, unknown> }) {
  return (
    <Section title="System">
      {typeof payload.kind === "string" ? (
        <KV label="Kind" value={payload.kind} />
      ) : null}
      {typeof payload.reason === "string" ? (
        <KV label="Reason" value={payload.reason} multiline />
      ) : null}
    </Section>
  );
}

function UserBody({ payload }: { payload: Record<string, unknown> }) {
  return (
    <Section title="User input">
      {typeof payload.scope === "string" ? (
        <KV label="Credential scope" value={payload.scope} />
      ) : null}
      {typeof payload.note === "string" ? (
        <KV label="Note" value={payload.note} multiline />
      ) : null}
    </Section>
  );
}

// ─── Layout primitives ─────────────────────────────────────────────

function Section({
  title,
  children,
  collapsibleByDefault,
}: {
  title: string;
  children: React.ReactNode;
  collapsibleByDefault?: boolean;
}) {
  if (collapsibleByDefault) {
    return (
      <details className="rounded-md border bg-muted/20 p-2">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </summary>
        <div className="mt-2 space-y-1">{children}</div>
      </details>
    );
  }
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <div className="mt-1 space-y-1">{children}</div>
    </div>
  );
}

function KV({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span
        className={
          "min-w-0 grow text-foreground " +
          (multiline ? "whitespace-pre-wrap" : "truncate")
        }
      >
        {value}
      </span>
    </div>
  );
}

function summariseStep(step: RunStep): string {
  if (step.kind === "PLAN") {
    const d = (
      (step.payload ?? {}) as { decision?: { kind?: string; tool?: string } }
    ).decision;
    if (d?.kind === "tool" && d.tool) return `Plan → ${d.tool}`;
    if (d?.kind === "stop") return "Plan → stop";
    return "Planning";
  }
  if (step.kind === "TOOL_CALL") {
    return step.toolCalls[0]?.toolName ?? "(no tool)";
  }
  if (step.kind === "USER_INPUT") return "User input";
  return "System";
}
