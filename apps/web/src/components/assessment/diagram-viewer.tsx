"use client";

import type { ExtractedDiagramEntities } from "@/server/services/diagram-parser";
import { MermaidDiagram } from "./mermaid-diagram";

interface DiagramLike {
  id: string;
  diagramFormat: string;
  diagramType: string | null;
  title: string;
  extractedSummary: string | null;
  sourceCode: string | null;
  extractedEntities: unknown;
}

/**
 * Renders the parsed diagram view: visual preview on top (image for
 * PNG/JPEG, source listing for text-based formats) plus the structured
 * entity breakdown below.
 *
 * The extractedEntities blob comes from Prisma as `Json` — typed as
 * `unknown` at the boundary. We narrow defensively because old rows from
 * before the parser contract stabilized may still be around in dev DBs.
 */
export function DiagramViewer({
  diagram,
  documentId,
}: {
  diagram: DiagramLike;
  documentId: string;
}) {
  const entities = narrowEntities(diagram.extractedEntities);
  const isImage = ["PNG", "JPEG"].includes(diagram.diagramFormat);

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-muted/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold">{diagram.title}</h4>
            <p className="text-xs text-muted-foreground">
              {diagram.diagramFormat}
              {diagram.diagramType ? ` · ${diagram.diagramType}` : ""}
            </p>
          </div>
        </div>

        {isImage ? (
          <div className="mt-3 overflow-auto rounded border bg-white p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/documents/${documentId}/download`}
              alt={diagram.title}
              className="mx-auto max-h-[480px]"
            />
          </div>
        ) : diagram.sourceCode ? (
          <div className="mt-3 space-y-3">
            {diagram.diagramFormat === "MERMAID" ? (
              // Visual render for Mermaid uploads — the in-browser
              // renderer matches what mermaid.live shows.
              <MermaidDiagram source={diagram.sourceCode} />
            ) : null}
            <details className="rounded-md border bg-background">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
                {diagram.diagramFormat === "MERMAID"
                  ? "Show source"
                  : "Source"}
              </summary>
              <pre className="max-h-[480px] overflow-auto border-t bg-background p-3 text-xs">
                <code>{diagram.sourceCode}</code>
              </pre>
            </details>
          </div>
        ) : null}
      </div>

      {entities ? (
        <div className="grid gap-3 md:grid-cols-2">
          <EntityList
            heading="Components"
            rows={entities.entities.components.map((c) => ({
              primary: c.name,
              secondary:
                [c.type, c.technology].filter(Boolean).join(" · ") || null,
              tertiary: c.description ?? null,
            }))}
          />
          <EntityList
            heading="Connections"
            rows={entities.entities.connections.map((c) => ({
              primary: `${c.from} → ${c.to}`,
              secondary: c.protocol ?? null,
              tertiary: c.description ?? null,
            }))}
          />
          <EntityList
            heading="Datastores"
            rows={entities.entities.datastores.map((d) => ({
              primary: d.name,
              secondary: d.type,
              tertiary:
                d.connectedTo.length > 0
                  ? `connected to ${d.connectedTo.join(", ")}`
                  : null,
            }))}
          />
          <EntityList
            heading="External systems"
            rows={entities.entities.externalSystems.map((e) => ({
              primary: e.name,
              secondary: e.type,
              tertiary:
                e.connectedTo.length > 0
                  ? `connected to ${e.connectedTo.join(", ")}`
                  : null,
            }))}
          />
          {entities.entities.boundaries.length > 0 ? (
            <EntityList
              heading="Boundaries"
              rows={entities.entities.boundaries.map((b) => ({
                primary: b.name,
                secondary: null,
                tertiary:
                  b.contains.length > 0
                    ? `contains ${b.contains.join(", ")}`
                    : null,
              }))}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function EntityList({
  heading,
  rows,
}: {
  heading: string;
  rows: Array<{ primary: string; secondary: string | null; tertiary: string | null }>;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-md border bg-card p-3">
      <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
        <span className="ml-2 font-normal">({rows.length})</span>
      </h5>
      <ul className="mt-2 space-y-1.5 text-sm">
        {rows.map((r, i) => (
          <li key={i}>
            <div className="font-medium">{r.primary}</div>
            {r.secondary ? (
              <div className="text-xs text-muted-foreground">{r.secondary}</div>
            ) : null}
            {r.tertiary ? (
              <div className="text-xs text-muted-foreground">{r.tertiary}</div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Narrow Prisma's Json blob into our shape. Returns null on anything
// unexpected so the UI degrades gracefully rather than crashing on a
// malformed row.
function narrowEntities(
  raw: unknown,
): ExtractedDiagramEntities | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { entities?: { components?: unknown } };
  if (!obj.entities || typeof obj.entities !== "object") return null;
  // Trust the shape past this point — the parser writes it with the AI
  // prompt's schema and Prisma round-trips JSON untouched.
  return raw as ExtractedDiagramEntities;
}
