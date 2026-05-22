"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BaseEdge,
  Controls,
  type Edge,
  type EdgeProps,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  getStraightPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";

import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useFeatureFlags } from "@/lib/use-feature-flags";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WorkflowStepPopup } from "./workflow-step-popup";

/**
 * Read-only React Flow diagram of the agent's *workflow plan*.
 *
 * Distinct from `AgentFlowDiagram` (which renders a tool-call run's
 * trajectory). This component renders the workflow planner's output:
 * human-driven steps with status derived from the assessment data.
 *
 * Slice 1 ships:
 *   - polled `agentRun.workflowSnapshot` query
 *   - per-node status badge (PENDING / IN_PROGRESS / COMPLETED / BLOCKED)
 *   - "Open" button on each node deep-links to the existing tab route
 *     with `?assessmentId=…` pinned
 *   - read-only canvas (no editing, no connections)
 *
 * Slice 2 will swap the deep-link for an in-place dialog and add the
 * explicit user-driven completion lock; the props/data shape doesn't
 * change.
 */

// Approximate render dimensions of `<NodeShell>` once a 2-line title
// + 2-line note fit. Dagre uses these as the bounding box when it
// computes the layout — too small and edges cut through nodes, too
// large and the diagram wastes screen real estate. Tune in lock-step
// with the shell's CSS.
const NODE_WIDTH = 280;
const NODE_HEIGHT = 140;
// Spacing knobs:
//   - RANKSEP: vertical gap between rows. Wider gap = edges have
//     more room to slope between rows without clipping a sibling
//     node.
//   - NODESEP: horizontal gap between siblings. Same idea on the
//     X axis.
//   - EDGESEP: gap between parallel edges within a rank — keeps two
//     fan-in arrows from sharing a path through the same node.
// Bumped from prior values because the previous combo allowed edges
// to clip through nodes when a row had 3+ siblings.
const RANKSEP = 160;
const NODESEP = 120;
const EDGESEP = 30;

type Snapshot = RouterOutputs["agentRun"]["workflowSnapshot"];
type WorkflowNode = NonNullable<Snapshot>["nodes"][number];

export function AgentWorkflowDiagram({
  engagementId,
  assessmentId,
  height = 640,
}: {
  engagementId: string;
  assessmentId: string;
  height?: number;
}) {
  const { agentEnabled } = useFeatureFlags();
  const { data, isLoading } = trpc.agentRun.workflowSnapshot.useQuery(
    { assessmentId },
    {
      enabled: agentEnabled,
      // Poll while the snapshot is non-final — i.e. the run that
      // produced the plan is still being acted on. We use a coarse
      // 5 s interval so the status badges catch up after the user
      // uploads a doc / answers questions / etc., without hammering.
      refetchInterval: agentEnabled ? 5_000 : false,
      retry: (failures, err) =>
        err.data?.code !== "NOT_FOUND" && failures < 1,
    },
  );

  if (!agentEnabled) return null;
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Assessment workflow</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[420px] w-full" />
        </CardContent>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Assessment workflow</CardTitle>
          <CardDescription>
            No workflow plan yet. Use the form above to describe a goal —
            the agent will draft a plan you can drive from this diagram.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Assessment workflow</CardTitle>
            <CardDescription>
              {data.nodes.length} steps · revision {data.revision} · goal:{" "}
              <span className="text-foreground">{data.goal}</span>
            </CardDescription>
          </div>
          <DiscardPlanButton
            runId={data.runId}
            assessmentId={assessmentId}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <RevisionBumpBanner revision={data.revision} />
        <WorkflowCanvas
          engagementId={engagementId}
          assessmentId={assessmentId}
          snapshot={data}
          height={height}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Archives the workflow run that's backing this diagram. Once
 * archived the snapshot query falls back to the next non-archived
 * workflow run (or shows the empty state if none) — so the user can
 * draft a fresh plan without the stale one cluttering the screen.
 */
function DiscardPlanButton({
  runId,
  assessmentId,
}: {
  runId: string;
  assessmentId: string;
}) {
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState(false);
  const archive = trpc.agentRun.archive.useMutation({
    onSuccess: () =>
      Promise.all([
        utils.agentRun.workflowSnapshot.invalidate({ assessmentId }),
        utils.agentRun.getByAssessment.invalidate({ assessmentId }),
      ]),
  });
  return (
    <div className="flex items-center gap-2">
      {archive.error ? (
        <span className="text-xs text-destructive" role="alert">
          {archive.error.message}
        </span>
      ) : null}
      {confirm ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={archive.isPending}
            onClick={() => setConfirm(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={archive.isPending}
            onClick={() => archive.mutate({ id: runId })}
          >
            {archive.isPending ? "Discarding…" : "Really discard?"}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setConfirm(true)}
          title="Archive this plan; you can draft a fresh one above."
        >
          Discard plan
        </Button>
      )}
    </div>
  );
}

/**
 * Tiny inline banner that flashes when the workflow plan's revision
 * bumps (i.e. the agent re-planned after a step completion). Auto-
 * hides after 6 s. Rolling our own instead of pulling in a toast
 * library — single use-case, this is simpler.
 */
function RevisionBumpBanner({ revision }: { revision: number }) {
  const [visible, setVisible] = useState(false);
  const lastSeenRevision = useRef<number | null>(null);

  useEffect(() => {
    if (lastSeenRevision.current === null) {
      // First mount — record the current revision but don't fire the
      // banner. Otherwise everyone who lands on the page sees a
      // "Plan updated" they didn't trigger.
      lastSeenRevision.current = revision;
      return;
    }
    if (revision > lastSeenRevision.current) {
      lastSeenRevision.current = revision;
      setVisible(true);
      const t = setTimeout(() => setVisible(false), 6000);
      return () => clearTimeout(t);
    }
  }, [revision]);

  if (!visible) return null;
  return (
    <div
      role="status"
      className="rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-xs"
    >
      <span className="font-medium">Plan updated to revision {revision}.</span>{" "}
      <span className="text-muted-foreground">
        The agent revised the workflow based on what you just completed.
      </span>
    </div>
  );
}

// ─── Canvas ────────────────────────────────────────────────────────

function WorkflowCanvas({
  engagementId,
  assessmentId,
  snapshot,
  height,
}: {
  engagementId: string;
  assessmentId: string;
  snapshot: NonNullable<Snapshot>;
  height: number;
}) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const { nodes, edges } = useMemo(
    () => buildGraph(snapshot.nodes, setSelectedNodeId),
    [snapshot.nodes],
  );

  const selectedNode =
    selectedNodeId !== null
      ? snapshot.nodes.find((n) => n.id === selectedNodeId) ?? null
      : null;

  if (nodes.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Plan emitted no recognised steps.
      </p>
    );
  }

  return (
    <>
      <div className="rounded-md border bg-background" style={{ height }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          edgesFocusable={false}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.0 }}
        >
          {/* Background component intentionally removed — the wrapper
           *  div's solid bg-background tone is cleaner than a dot
           *  pattern for this use-case (a procedural workflow, not
           *  a free-form whiteboard). */}
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {selectedNode ? (
        <WorkflowStepPopup
          open
          onOpenChange={(open) => {
            if (!open) setSelectedNodeId(null);
          }}
          engagementId={engagementId}
          assessmentId={assessmentId}
          runId={snapshot.runId}
          node={selectedNode}
        />
      ) : null}
    </>
  );
}

// ─── Graph layout ──────────────────────────────────────────────────

interface BuildResult {
  nodes: Node[];
  edges: Edge[];
}

interface WorkflowNodePayload extends Record<string, unknown> {
  node: WorkflowNode;
  onOpen: (id: string) => void;
}

/**
 * Dagre-based auto-layout. Beats the hand-rolled depth-by-rank
 * version we had previously: dagre handles edge crossings, sibling
 * spacing, and ranks-with-mixed-ancestors cleanly. Top-to-bottom
 * direction matches the workflow's "do this then this" feel.
 *
 * The function is pure — same inputs always produce the same
 * positions — so it's safe to memoise via the parent's `useMemo`.
 */
function buildGraph(
  rawNodes: readonly WorkflowNode[],
  onOpen: (id: string) => void,
): BuildResult {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "TB",
    ranksep: RANKSEP,
    nodesep: NODESEP,
    edgesep: EDGESEP,
    // `network-simplex` produces tighter, more balanced layouts
    // than the default `tight-tree`, which tends to skew long
    // chains off to one side and forces edges through siblings.
    ranker: "network-simplex",
    marginx: 24,
    marginy: 24,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of rawNodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const n of rawNodes) {
    for (const dep of n.dependsOn) {
      // Skip edges to nodes that don't exist (planner emitted a stale
      // predecessor id). Without this dagre throws.
      if (g.hasNode(dep)) g.setEdge(dep, n.id);
    }
  }

  dagre.layout(g);

  const nodes: Node[] = rawNodes.map((n) => {
    const { x, y } = g.node(n.id);
    // Dagre returns the node's CENTER; React Flow expects the
    // top-left. Adjust by half the node dimensions so the rendered
    // box lands where dagre placed it.
    return {
      id: n.id,
      type: "workflow",
      position: {
        x: x - NODE_WIDTH / 2,
        y: y - NODE_HEIGHT / 2,
      },
      data: { node: n, onOpen } satisfies WorkflowNodePayload,
    };
  });

  // Edge color follows the target node's status — so an arrow into a
  // PENDING node uses the PENDING fill color, an arrow into BLOCKED
  // uses BLOCKED, etc. This makes the diagram read as "this is what
  // unlocks once the upstream finishes" rather than "this is where
  // we came from."
  const targetStatusById = new Map<string, WorkflowNode["status"]>();
  for (const n of rawNodes) targetStatusById.set(n.id, n.status);

  const edges: Edge[] = [];
  for (const n of rawNodes) {
    for (const dep of n.dependsOn) {
      if (!g.hasNode(dep)) continue;
      const color = edgeColorForTargetStatus(
        targetStatusById.get(n.id) ?? "PENDING",
      );
      // Dagre computes a polyline that ROUTES AROUND nodes during
      // layout. React Flow's built-in edges ignore those bend points
      // and draw their own path source→target — which is why edges
      // cut through siblings. Stash dagre's points on the edge and
      // render them via the custom `dagre` edge type below.
      const dagreEdge = g.edge(dep, n.id);
      const points = dagreEdge?.points ?? [];
      edges.push({
        id: `${dep}->${n.id}`,
        source: dep,
        target: n.id,
        type: "dagre",
        data: { points },
        style: { stroke: color, strokeWidth: 2 },
        // Filled arrow head, same color as the line.
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 18,
          height: 18,
        },
      });
    }
  }
  return { nodes, edges };
}

/**
 * Map a node's status to the edge color used for any arrow LANDING
 * on it. Always the node's BORDER color — gives the line enough
 * contrast against the white canvas to read as a connector while
 * still belonging to the same color family as the destination box.
 */
function edgeColorForTargetStatus(status: WorkflowNode["status"]): string {
  switch (status) {
    case "COMPLETED":
      return "#82B366";
    case "IN_PROGRESS":
      return "#D79B00";
    case "BLOCKED":
      return "#B85450";
    case "PENDING":
    default:
      return "#6C8EBF";
  }
}

// ─── Node ──────────────────────────────────────────────────────────

function WorkflowNodeView({ data }: NodeProps) {
  const { node, onOpen } = data as WorkflowNodePayload;
  const tone = toneForStatus(node.status);
  const blocked = node.status === "BLOCKED";
  const explicitTag = node.explicit
    ? node.explicit.status === "COMPLETED"
      ? "✓ user-marked"
      : "user in progress"
    : null;
  return (
    <div
      className={`rounded-lg border-2 px-3 py-2.5 text-xs shadow-sm ${tone}`}
      style={{ width: NODE_WIDTH }}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>{node.spec.label}</span>
        <StatusBadge status={node.status} />
      </div>
      <p className="mt-1 line-clamp-2 text-sm font-medium text-foreground">
        {node.spec.description}
      </p>
      {node.explicit?.note ? (
        <p className="mt-1 line-clamp-2 text-[10px] italic text-muted-foreground">
          “{node.explicit.note}”
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground">
          {explicitTag ?? node.spec.description}
        </span>
        <button
          type="button"
          onClick={() => onOpen(node.id)}
          className={`shrink-0 rounded border bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-accent hover:text-accent-foreground ${
            blocked ? "opacity-60" : ""
          }`}
          // Even BLOCKED nodes are clickable — the popup explains what
          // predecessor needs completing first. That's better than a
          // dead-link that gives no context.
        >
          Open →
        </button>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

const NODE_TYPES = { workflow: WorkflowNodeView };

/**
 * Custom edge that follows the polyline dagre computed during
 * layout. Dagre's `g.edge(s, t).points` is a list of `{x, y}`
 * coordinates that already routes AROUND every node in the layout
 * — using them directly stops edges from cutting through siblings.
 *
 * We stitch the points with quadratic bezier curves through the mid-
 * points, so corners are softened (looks better than raw 90° polys
 * without changing the routing).
 */
function DagreEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, style, markerEnd } = props;
  const points = (props.data as { points?: Array<{ x: number; y: number }> })
    ?.points;

  let path: string;
  if (!points || points.length < 2) {
    // Fallback: dagre didn't return points (shouldn't happen, but
    // be defensive). Use a straight line.
    [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  } else {
    path = pointsToSmoothPath(points);
  }
  return (
    <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
  );
}

/** Stitch a list of points with quadratic bezier curves at each
 *  bend, so the edge looks smooth without veering off the dagre-
 *  computed routing. First & last points are anchored exactly. */
function pointsToSmoothPath(
  pts: ReadonlyArray<{ x: number; y: number }>,
): string {
  if (pts.length === 2) {
    return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  }
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const cur = pts[i];
    const next = pts[i + 1];
    const midX = (cur.x + next.x) / 2;
    const midY = (cur.y + next.y) / 2;
    // Curve toward `cur` (the actual bend) then to the midpoint
    // between this bend and the next. Smooths corners without
    // straying from dagre's planned route.
    d += ` Q ${cur.x} ${cur.y} ${midX} ${midY}`;
  }
  // Straight finish to the last point (the target's connection
  // point) so the arrow head lands flush.
  d += ` L ${pts[pts.length - 1].x} ${pts[pts.length - 1].y}`;
  return d;
}

const EDGE_TYPES = { dagre: DagreEdge };

/**
 * draw.io-style pastel palette: light fill + matching darker border.
 * Each status pairs a bg hex with the standard "outline" hex from the
 * same colorway so they read as obviously-related variants.
 *
 *   PENDING      #DAE8FC fill, #6C8EBF outline   (light blue)
 *   IN_PROGRESS  #FFE6CC fill, #D79B00 outline   (light orange)
 *   COMPLETED    #D5E8D4 fill, #82B366 outline   (light green)
 *   BLOCKED      #F8CECC fill, #B85450 outline   (light red/pink)
 *
 * `text-foreground` everywhere — these fills are pale enough that
 * the default text color reads cleanly in both light and dark modes
 * without per-tone overrides.
 */
function toneForStatus(status: WorkflowNode["status"]): string {
  switch (status) {
    case "COMPLETED":
      return "bg-[#D5E8D4] border-[#82B366] text-foreground";
    case "IN_PROGRESS":
      return "bg-[#FFE6CC] border-[#D79B00] text-foreground";
    case "BLOCKED":
      return "bg-[#F8CECC] border-[#B85450] text-foreground opacity-90";
    case "PENDING":
    default:
      return "bg-[#DAE8FC] border-[#6C8EBF] text-foreground";
  }
}

function StatusBadge({ status }: { status: WorkflowNode["status"] }) {
  // Same palette but with the darker outline carrying both border AND
  // text color, so the pill reads as a stronger version of the card
  // tone rather than a separate visual element.
  const cls = (() => {
    switch (status) {
      case "COMPLETED":
        return "bg-[#D5E8D4] border-[#82B366] text-[#3F6B33]";
      case "IN_PROGRESS":
        return "bg-[#FFE6CC] border-[#D79B00] text-[#7A5500]";
      case "BLOCKED":
        return "bg-[#F8CECC] border-[#B85450] text-[#7A2E2A]";
      case "PENDING":
      default:
        return "bg-[#DAE8FC] border-[#6C8EBF] text-[#2F4D77]";
    }
  })();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
