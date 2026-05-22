"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useFeatureFlags } from "@/lib/use-feature-flags";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AgentFlowHeader } from "./agent-flow-header";
import { AgentStepPanel } from "./agent-step-panel";

/**
 * React Flow trace viewer for an agent run.
 *
 * Composition:
 *   - `AgentFlowHeader` — Tier 1 context band (goal, status, totals,
 *     budget, halt reason).
 *   - Canvas — Tier 2 nodes (args / result preview / evidence badge),
 *     Tier 4 minimap + turn-group dividers + cost sparkline + replay
 *     scrubber, Tier 5 branching layout when a step fans out multiple
 *     tool calls.
 *   - `AgentStepPanel` — Tier 3 inspection side panel (slides in on
 *     node selection).
 *
 * Layout: vertical stack by `step.idx`. When a single PLAN step
 * dispatches multiple parallel tool calls, the calls fan out
 * horizontally beneath the PLAN node — the layout function in
 * `buildGraph` recognises this via `step.toolCalls.length > 1`.
 *
 * Read-only by design: nodes are not draggable, no edge editing, no
 * connection handles wired beyond the visual stubs React Flow needs to
 * render edges.
 */

const NODE_WIDTH = 280;
const NODE_VERTICAL_GAP = 110;
const NODE_HORIZONTAL_GAP = 32;

type RunDetail = RouterOutputs["agentRun"]["get"];
type RunStep = RunDetail["steps"][number];
type RunToolCall = RunStep["toolCalls"][number];

export function AgentFlowDiagram({
  runId,
  assessmentId,
  height = 600,
}: {
  runId: string | null;
  assessmentId: string;
  height?: number;
}) {
  // Skip the query when no run is selected, or when the agent feature
  // is off entirely — both produce the same "nothing to show" outcome
  // but only one of them needs to bark in the console.
  const { agentEnabled, agentFlowVisible } = useFeatureFlags();
  const { data, isLoading, error } = trpc.agentRun.get.useQuery(
    { id: runId ?? "" },
    {
      enabled: !!runId && agentEnabled && agentFlowVisible,
      // Poll while the run is non-terminal so the diagram grows in
      // step with the trajectory. Once the run settles we let the
      // cache go stale.
      refetchInterval: (q) => {
        const r = q.state.data;
        if (!r) return false;
        const live =
          r.status === "PROPOSED" ||
          r.status === "APPROVED" ||
          r.status === "RUNNING" ||
          r.status === "AWAITING_USER";
        return live ? 3_000 : false;
      },
      retry: (failures, err) =>
        err.data?.code !== "NOT_FOUND" && failures < 1,
    },
  );

  // Admin-controlled sub-flag (ADR-0026): hide the trace viewer
  // without touching the harness itself. Hooks above must still run
  // unconditionally — early return only past the hooks.
  if (!agentFlowVisible) return null;

  // NOT_FOUND happens cleanly when the focused run was archived /
  // deleted in another tab. We render the same "no diagram" state
  // we use for the no-run case rather than letting an error card
  // pile on top of the workflow surface.
  if (error?.data?.code === "NOT_FOUND") return null;

  if (!runId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent flow</CardTitle>
          <CardDescription>
            Start an agent run above to see its trajectory here.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-0">
        <CardTitle className="text-base">Agent flow</CardTitle>
        <CardDescription>
          Goal, status, and a step-by-step trace of the planner&apos;s
          decisions (blue), tool calls they dispatch (green / red /
          amber), and credential prompts (orange). Click any node for
          the full payload.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <Skeleton className="m-4 h-[500px] w-[calc(100%-2rem)]" />
        ) : data ? (
          <FlowShell data={data} assessmentId={assessmentId} height={height} />
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─── Outer shell: header + canvas + side panel + scrubber ─────────

function FlowShell({
  data,
  assessmentId,
  height,
}: {
  data: RunDetail;
  assessmentId: string;
  height: number;
}) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  // Tier 4 replay scrubber: when set, hide every step whose idx is
  // greater than `replayIdx` so the diagram shows the run state at
  // that point in time. Null = show everything.
  const [replayIdx, setReplayIdx] = useState<number | null>(null);

  const visibleSteps = useMemo(() => {
    if (replayIdx === null) return data.steps;
    return data.steps.filter((s) => s.idx <= replayIdx);
  }, [data.steps, replayIdx]);

  const selectedStep =
    visibleSteps.find((s) => s.id === selectedStepId) ?? null;

  return (
    <div className="flex flex-col">
      <AgentFlowHeader run={data} />
      <CostSparkline steps={data.steps} replayIdx={replayIdx} />
      <div className="flex">
        <FlowCanvas
          steps={visibleSteps}
          height={height}
          selectedStepId={selectedStepId}
          onSelect={setSelectedStepId}
        />
        {selectedStep ? (
          <AgentStepPanel
            step={selectedStep}
            assessmentId={assessmentId}
            onClose={() => setSelectedStepId(null)}
          />
        ) : null}
      </div>
      <ReplayScrubber
        total={data.steps.length}
        value={replayIdx}
        onChange={setReplayIdx}
      />
    </div>
  );
}

// ─── Canvas ─────────────────────────────────────────────────────────

function FlowCanvas({
  steps,
  height,
  selectedStepId,
  onSelect,
}: {
  steps: RunStep[];
  height: number;
  selectedStepId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { nodes, edges } = useMemo(
    () => buildGraph(steps, selectedStepId),
    [steps, selectedStepId],
  );

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      // Group / divider nodes have no underlying step row.
      const data = node.data as { step?: RunStep } | undefined;
      if (data?.step) onSelect(node.id);
    },
    [onSelect],
  );

  if (nodes.length === 0) {
    return (
      <div className="grow py-12 text-center text-sm text-muted-foreground">
        No steps yet — the run is queued.
      </div>
    );
  }

  return (
    <div className="grow bg-background" style={{ height }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={onNodeClick}
        onPaneClick={() => onSelect(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        edgesFocusable={false}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
      >
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeStrokeWidth={2}
          nodeColor={(n) => {
            const tone = (n.data as { tone?: string } | undefined)?.tone;
            if (tone?.includes("blue")) return "#3b82f6";
            if (tone?.includes("green")) return "#22c55e";
            if (tone?.includes("destructive")) return "#ef4444";
            if (tone?.includes("amber")) return "#f59e0b";
            return "#9ca3af";
          }}
        />
      </ReactFlow>
    </div>
  );
}

// ─── Graph construction ────────────────────────────────────────────

interface BuildGraphResult {
  nodes: Node[];
  edges: Edge[];
}

function buildGraph(
  steps: RunStep[],
  selectedId: string | null,
): BuildGraphResult {
  const sorted = [...steps].sort((a, b) => a.idx - b.idx);
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  let cursorY = 0;
  let prevAnchorId: string | null = null;
  let turnIdx = 0;

  for (let i = 0; i < sorted.length; i++) {
    const step = sorted[i];
    const isFirst = i === 0;
    const isLast = i === sorted.length - 1;
    const tone = toneForStep(step);
    const selected = step.id === selectedId;

    // Tier 4: insert a thin "Turn N" divider before each PLAN node
    // (other than the very first), so a long PLAN→TOOL→PLAN→TOOL run
    // reads as discrete iterations.
    if (step.kind === "PLAN" && !isFirst) {
      turnIdx += 1;
      const dividerId = `divider-${step.id}`;
      nodes.push({
        id: dividerId,
        type: "divider",
        position: { x: 0, y: cursorY },
        data: { label: `Turn ${turnIdx + 1}` },
        selectable: false,
        focusable: false,
      });
      cursorY += 36;
      if (prevAnchorId) {
        edges.push({
          id: `${prevAnchorId}-${dividerId}`,
          source: prevAnchorId,
          target: dividerId,
          type: "smoothstep",
        });
      }
      prevAnchorId = dividerId;
    }

    // Tier 5: branching layout. A PLAN step's tool calls live on the
    // NEXT step (TOOL_CALL kind). But if a single TOOL_CALL step has
    // multiple toolCalls rows (parallel dispatch), we fan them out
    // horizontally.
    if (step.kind === "TOOL_CALL" && step.toolCalls.length > 1) {
      const count = step.toolCalls.length;
      const rowWidth = count * NODE_WIDTH + (count - 1) * NODE_HORIZONTAL_GAP;
      const startX = -rowWidth / 2 + NODE_WIDTH / 2;
      step.toolCalls.forEach((call, j) => {
        const subId = `${step.id}::${call.id}`;
        nodes.push({
          id: subId,
          type: "tool",
          position: { x: startX + j * (NODE_WIDTH + NODE_HORIZONTAL_GAP), y: cursorY },
          data: {
            step,
            call,
            tone: toneForToolCall(call),
            selected,
            isFirst,
            isLast,
          } as StepNodeData,
          selected,
        });
        if (prevAnchorId) {
          edges.push({
            id: `${prevAnchorId}-${subId}`,
            source: prevAnchorId,
            target: subId,
            type: "smoothstep",
          });
        }
      });
      // Synthesize a converge node (invisible) so the next step has a
      // single ancestor to connect to.
      cursorY += NODE_VERTICAL_GAP;
      const convergeId = `${step.id}::converge`;
      nodes.push({
        id: convergeId,
        type: "converge",
        position: { x: 0, y: cursorY },
        data: { step },
        selectable: false,
        focusable: false,
      });
      step.toolCalls.forEach((call) => {
        const subId = `${step.id}::${call.id}`;
        edges.push({
          id: `${subId}-${convergeId}`,
          source: subId,
          target: convergeId,
          type: "smoothstep",
        });
      });
      cursorY += 24;
      prevAnchorId = convergeId;
      continue;
    }

    // Standard single-column node.
    nodes.push({
      id: step.id,
      type: nodeTypeForKind(step.kind),
      position: { x: 0, y: cursorY },
      data: {
        step,
        call: step.toolCalls[0],
        tone,
        selected,
        isFirst,
        isLast,
      } as StepNodeData,
      selected,
    });
    if (prevAnchorId) {
      edges.push({
        id: `${prevAnchorId}-${step.id}`,
        source: prevAnchorId,
        target: step.id,
        type: "smoothstep",
      });
    }
    prevAnchorId = step.id;
    cursorY += NODE_VERTICAL_GAP;
  }

  return { nodes, edges };
}

function nodeTypeForKind(kind: RunStep["kind"]): string {
  switch (kind) {
    case "PLAN":
      return "plan";
    case "TOOL_CALL":
      return "tool";
    case "USER_INPUT":
      return "user";
    case "SYSTEM":
    case "ASSISTANT":
    default:
      return "system";
  }
}

function toneForStep(step: RunStep): string {
  switch (step.kind) {
    case "PLAN":
      return "border-blue-500/40 bg-blue-500/10";
    case "TOOL_CALL":
      return toneForToolCall(step.toolCalls[0]);
    case "USER_INPUT":
      return "border-amber-500/40 bg-amber-500/10";
    default:
      return "border-border bg-muted";
  }
}

function toneForToolCall(call: RunToolCall | undefined): string {
  if (!call) return "border-border bg-muted";
  switch (call.status) {
    case "SUCCEEDED":
      return "border-green-500/40 bg-green-500/10";
    case "FAILED":
    case "TIMED_OUT":
      return "border-destructive/40 bg-destructive/10";
    case "CANCELLED":
      return "border-muted-foreground/30 bg-muted";
    case "PENDING":
    case "RUNNING":
    default:
      return "border-amber-500/40 bg-amber-500/10";
  }
}

// ─── Node components ───────────────────────────────────────────────

interface StepNodeData extends Record<string, unknown> {
  step: RunStep;
  call?: RunToolCall;
  tone: string;
  selected: boolean;
  isFirst: boolean;
  isLast: boolean;
}

function PlanNode({ data }: NodeProps) {
  const { step, tone, selected } = data as StepNodeData;
  const noteCount = countOpenAnnotations(step);
  const payload = (step.payload ?? {}) as {
    reason?: string;
    decision?: { kind?: string; tool?: string; reason?: string; args?: Record<string, unknown> };
  };
  const decision = payload.decision;
  const title = decision
    ? decision.kind === "tool"
      ? `→ ${decision.tool ?? "(no tool)"}`
      : decision.kind === "stop"
        ? "Stop"
        : (decision.kind ?? "thinking")
    : "Thinking…";
  const subtitle =
    decision?.kind === "tool" && decision.args
      ? summariseArgs(decision.args)
      : decision?.reason
        ? truncate(decision.reason, 80)
        : payload.reason
          ? truncate(payload.reason, 80)
          : null;
  return (
    <NodeShell
      tone={tone}
      selected={selected}
      label="PLAN"
      idx={step.idx}
      title={title}
      subtitle={subtitle}
      meta={
        step.inputTokens + step.outputTokens > 0
          ? `${formatTok(step.inputTokens)}↓ ${formatTok(step.outputTokens)}↑`
          : null
      }
      noteCount={noteCount}
    />
  );
}

function ToolNode({ data }: NodeProps) {
  const { step, call, tone, selected } = data as StepNodeData;
  const noteCount = countOpenAnnotations(step);
  if (!call) {
    return (
      <NodeShell
        tone="border-border bg-muted"
        selected={selected}
        label="TOOL"
        idx={step.idx}
        title="(no tool)"
        noteCount={noteCount}
      />
    );
  }
  const argsSummary = call.argsJson
    ? summariseArgs(call.argsJson as Record<string, unknown>)
    : null;
  const resultSummary = summariseToolResult(call);
  const evidenceCount = call.evidenceIds?.length ?? 0;
  const meta =
    call.durationMs != null
      ? `${call.durationMs} ms`
      : call.status === "RUNNING"
        ? "running…"
        : null;
  return (
    <NodeShell
      tone={tone}
      selected={selected}
      label="TOOL"
      idx={step.idx}
      title={call.toolName}
      subtitle={argsSummary}
      detail={resultSummary}
      badge={evidenceCount > 0 ? `→ ${evidenceCount} evidence` : null}
      meta={meta}
      footer={call.errorClass ? `error: ${call.errorClass}` : null}
      noteCount={noteCount}
    />
  );
}

function SystemNode({ data }: NodeProps) {
  const { step, tone, selected } = data as StepNodeData;
  const noteCount = countOpenAnnotations(step);
  const payload = (step.payload ?? {}) as { kind?: string; reason?: string };
  const title = payload.reason
    ? truncate(payload.reason, 60)
    : (payload.kind ?? "system");
  return (
    <NodeShell
      tone={tone}
      selected={selected}
      label="SYSTEM"
      idx={step.idx}
      title={title}
      subtitle={payload.kind && payload.reason ? payload.kind : null}
      noteCount={noteCount}
    />
  );
}

function UserNode({ data }: NodeProps) {
  const { step, tone, selected } = data as StepNodeData;
  const noteCount = countOpenAnnotations(step);
  const payload = (step.payload ?? {}) as { scope?: string; note?: string };
  return (
    <NodeShell
      tone={tone}
      selected={selected}
      label="USER"
      idx={step.idx}
      title={payload.scope ?? "Credential supplied"}
      subtitle={payload.note ? truncate(payload.note, 80) : null}
      noteCount={noteCount}
    />
  );
}

function DividerNode({ data }: NodeProps) {
  const { label } = data as { label: string };
  return (
    <div
      className="flex items-center justify-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
      style={{ width: NODE_WIDTH, height: 24 }}
    >
      <span className="h-px grow bg-border" />
      <span className="px-2">{label}</span>
      <span className="h-px grow bg-border" />
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function ConvergeNode() {
  // Invisible converge node — exists only so successor steps have a
  // single parent in the edge list when a parallel TOOL fan-out
  // happens.
  return (
    <div style={{ width: NODE_WIDTH, height: 1 }}>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

const NODE_TYPES = {
  plan: PlanNode,
  tool: ToolNode,
  system: SystemNode,
  user: UserNode,
  divider: DividerNode,
  converge: ConvergeNode,
};

// ─── Shared shell ──────────────────────────────────────────────────

function NodeShell({
  tone,
  selected,
  label,
  idx,
  title,
  subtitle,
  detail,
  badge,
  meta,
  footer,
  noteCount,
}: {
  tone: string;
  selected?: boolean;
  label: string;
  idx: number;
  title: string;
  subtitle?: string | null;
  detail?: string | null;
  badge?: string | null;
  meta?: string | null;
  footer?: string | null;
  noteCount?: number;
}) {
  return (
    <div
      className={
        "rounded-md border px-3 py-2 text-xs shadow-sm transition-shadow " +
        tone +
        (selected ? " ring-2 ring-ring ring-offset-1" : "")
      }
      style={{ width: NODE_WIDTH }}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>
          #{idx} · {label}
        </span>
        {meta ? <span>{meta}</span> : null}
      </div>
      <p className="mt-1 truncate font-medium text-foreground">{title}</p>
      {subtitle ? (
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
          {subtitle}
        </p>
      ) : null}
      {detail ? (
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {detail}
        </p>
      ) : null}
      {badge ? (
        <span className="mt-1 mr-1 inline-block rounded-full border border-green-500/40 bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium">
          {badge}
        </span>
      ) : null}
      {noteCount && noteCount > 0 ? (
        <span
          className="mt-1 inline-block rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium"
          title="Reviewer note(s) attached"
        >
          📌 {noteCount}
        </span>
      ) : null}
      {footer ? (
        <p className="mt-0.5 truncate text-[10px] text-destructive">{footer}</p>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

// ─── Tier 4: cost sparkline + replay scrubber ──────────────────────

function CostSparkline({
  steps,
  replayIdx,
}: {
  steps: RunStep[];
  replayIdx: number | null;
}) {
  // Cost per step is unknown without re-joining the audit log; we
  // approximate with token count which correlates strongly. Renders
  // as a thin row of bars proportional to combined input+output
  // tokens, so expensive steps pop visually.
  if (steps.length === 0) return null;
  const sorted = [...steps].sort((a, b) => a.idx - b.idx);
  const max = Math.max(
    1,
    ...sorted.map((s) => s.inputTokens + s.outputTokens),
  );
  return (
    <div className="flex items-end gap-px border-b bg-card px-4 py-1.5">
      <span className="mr-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        Token spend per step
      </span>
      <div className="flex h-6 grow items-end gap-px">
        {sorted.map((s) => {
          const tok = s.inputTokens + s.outputTokens;
          const h = Math.max(2, Math.round((tok / max) * 24));
          const dim = replayIdx !== null && s.idx > replayIdx;
          return (
            <span
              key={s.id}
              title={`#${s.idx} · ${tok.toLocaleString()} tokens`}
              className={
                "flex-1 rounded-t-sm " +
                (dim ? "bg-muted-foreground/20" : "bg-primary/60")
              }
              style={{ height: h }}
            />
          );
        })}
      </div>
    </div>
  );
}

function ReplayScrubber({
  total,
  value,
  onChange,
}: {
  total: number;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  if (total <= 1) return null;
  const active = value !== null;
  return (
    <div className="flex items-center gap-3 border-t bg-card px-4 py-2">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Replay
      </span>
      <input
        type="range"
        min={0}
        max={total - 1}
        value={value ?? total - 1}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="grow"
        aria-label="Replay scrubber"
      />
      <span className="tabular-nums text-[11px] text-muted-foreground">
        {active ? `step ${value + 1}` : "live"} / {total}
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onChange(null)}
        disabled={!active}
      >
        Live
      </Button>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────

function summariseArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const parts: string[] = [];
  for (const [k, v] of entries) {
    if (parts.length >= 3) {
      parts.push("…");
      break;
    }
    parts.push(`${k}=${summariseValue(v)}`);
  }
  return parts.join(" ");
}

function summariseValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return truncate(v, 32);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  return "{…}";
}

function summariseToolResult(call: RunToolCall): string | null {
  if (!call.resultJson) {
    if (call.status === "FAILED" || call.status === "TIMED_OUT") {
      return "(failed)";
    }
    return null;
  }
  const r = call.resultJson as Record<string, unknown>;
  if (typeof r.summary === "string") return truncate(r.summary, 60);
  if (typeof r.count === "number") return `${r.count} items`;
  if (Array.isArray((r as { items?: unknown }).items)) {
    return `${(r as { items: unknown[] }).items.length} items`;
  }
  if (typeof r.message === "string") return truncate(r.message, 60);
  // Generic shape — show top-level keys so the user gets *some* signal.
  const keys = Object.keys(r).slice(0, 3);
  return keys.length ? `keys: ${keys.join(", ")}` : null;
}

function formatTok(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function countOpenAnnotations(step: RunStep): number {
  const list = (step as RunStep & {
    annotations?: Array<{ resolvedAt: Date | string | null }>;
  }).annotations;
  if (!list) return 0;
  return list.filter((a) => !a.resolvedAt).length;
}
