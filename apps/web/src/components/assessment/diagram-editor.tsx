"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MermaidDiagram } from "./mermaid-diagram";

interface DiagramRow {
  id: string;
  title: string;
  diagramFormat: string;
  diagramType: string | null;
  sourceCode: string | null;
  description: string | null;
  direction: string;
}

/**
 * Inline editor for an AI-generated diagram: view/edit source, save,
 * regenerate with reviewer feedback, or open a pre-filled mermaid.live
 * tab for an interactive preview.
 *
 * Client-side Mermaid rendering is intentionally out of scope for MVP —
 * it would pull a ~500KB runtime bundle in. The "Preview on mermaid.live"
 * link covers the usability gap.
 */
export function DiagramEditor({ diagram }: { diagram: DiagramRow }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [source, setSource] = useState(diagram.sourceCode ?? "");
  const [title, setTitle] = useState(diagram.title);
  const [feedback, setFeedback] = useState("");

  const updateMutation = trpc.deliverable.updateDiagramSource.useMutation({
    onSuccess: async () => {
      await utils.deliverable.getById.invalidate();
      setEditing(false);
    },
  });
  const regenMutation = trpc.deliverable.regenerateDiagram.useMutation({
    onSuccess: async () => {
      await utils.deliverable.getById.invalidate();
      setRegenOpen(false);
      setFeedback("");
    },
  });

  const busy = updateMutation.isPending || regenMutation.isPending;
  const mermaidLiveUrl = buildMermaidLiveUrl(source || diagram.sourceCode || "");
  const isMermaid = diagram.diagramFormat === "MERMAID";

  return (
    <div className="rounded-md border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-input bg-background px-2 py-0.5 text-xs font-medium">
            {diagram.diagramFormat.toLowerCase()}
          </span>
          {diagram.diagramType ? (
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {diagram.diagramType.replace(/_/g, " ").toLowerCase()}
            </span>
          ) : null}
          <span className="text-sm font-semibold">{diagram.title}</span>
        </div>
        <div className="flex gap-2">
          {isMermaid && mermaidLiveUrl ? (
            <a
              href={mermaidLiveUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
            >
              Preview on mermaid.live ↗
            </a>
          ) : null}
          {!editing && !regenOpen ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEditing(true)}
              >
                Edit source
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setRegenOpen(true)}
              >
                Regenerate…
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {diagram.description ? (
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          {diagram.description}
        </p>
      ) : null}

      {editing ? (
        <div className="space-y-3 p-4">
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Title
            </label>
            <Input
              className="mt-1"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
            />
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Source
            </label>
            <Textarea
              className="mt-1 min-h-[240px] font-mono text-xs"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              disabled={busy}
              spellCheck={false}
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !source.trim()}
              onClick={() =>
                updateMutation.mutate({
                  diagramId: diagram.id,
                  sourceCode: source,
                  title: title.trim() || undefined,
                })
              }
            >
              {updateMutation.isPending ? "Saving…" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSource(diagram.sourceCode ?? "");
                setTitle(diagram.title);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            {updateMutation.error ? (
              <span className="text-xs text-destructive">
                {updateMutation.error.message}
              </span>
            ) : null}
          </div>
        </div>
      ) : regenOpen ? (
        <div className="space-y-3 p-4">
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Reviewer feedback (optional)
            </label>
            <Textarea
              className="mt-1 min-h-[96px]"
              placeholder='e.g. "Add the Redis cache between API and database" or "Make this much simpler".'
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                regenMutation.mutate({
                  diagramId: diagram.id,
                  feedback: feedback.trim() || undefined,
                })
              }
            >
              {regenMutation.isPending ? "Regenerating…" : "Regenerate"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setRegenOpen(false);
                setFeedback("");
              }}
            >
              Cancel
            </Button>
            {regenMutation.error ? (
              <span className="text-xs text-destructive">
                {regenMutation.error.message}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        // Visual preview for Mermaid (renders client-side via the
        // dynamic `mermaid` import). For non-Mermaid formats
        // (PlantUML, Structurizr DSL, …) we keep the source listing —
        // those don't have an in-browser renderer; the
        // "Preview on mermaid.live" link or the regenerate flow are
        // the available paths there.
        <div className="space-y-3 p-4">
          {isMermaid && diagram.sourceCode ? (
            <MermaidDiagram source={diagram.sourceCode} />
          ) : null}
          <details className="rounded-md border bg-background">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
              {isMermaid ? "Show source" : "Source"}
            </summary>
            <pre className="max-h-[400px] overflow-auto border-t bg-background p-4 text-xs">
              <code>
                {diagram.sourceCode ??
                  "(no source generated — try regenerating)"}
              </code>
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

/**
 * Build a shareable mermaid.live URL from Mermaid source. mermaid.live
 * expects a base64'd JSON object under the `#pako:` fragment — but we
 * don't want to pull in pako on the client just for a convenience link.
 * The simpler `#base64:` scheme below works for diagrams up to a few KB
 * and is what the mermaid-live editor accepts when pako isn't used.
 */
function buildMermaidLiveUrl(source: string): string | null {
  if (!source.trim()) return null;
  try {
    const payload = { code: source, mermaid: { theme: "default" } };
    const json = JSON.stringify(payload);
    // Browser-friendly base64url (no pako). mermaid.live tolerates this.
    const b64 =
      typeof btoa !== "undefined"
        ? btoa(unescape(encodeURIComponent(json)))
        : Buffer.from(json, "utf8").toString("base64");
    return `https://mermaid.live/edit#base64:${b64}`;
  } catch {
    return null;
  }
}
