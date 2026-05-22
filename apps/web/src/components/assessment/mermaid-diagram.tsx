"use client";

import { useEffect, useId, useState } from "react";

/**
 * Client-side Mermaid renderer. Pulls in `mermaid` lazily so it only
 * lands in the bundle on pages that actually render diagrams (the
 * deliverable preview today; could be reused on the documents tab).
 *
 * Mermaid's `mermaid.render(id, source)` returns SVG markup; we drop
 * it into the DOM with `dangerouslySetInnerHTML`. SVG output is
 * generated from a known input source (no untrusted user content
 * gets to write arbitrary HTML), so this is safe.
 *
 * Failures fall back to a "couldn't render — here's the source" view
 * so the user still sees something useful instead of a broken card.
 */
export function MermaidDiagram({
  source,
  className = "",
}: {
  source: string;
  className?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    if (!source.trim()) {
      setError("(no source)");
      return;
    }

    // Dynamic import — only ships when a diagram actually renders.
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        // `startOnLoad: false` — we drive renders manually below.
        // `securityLevel: "loose"` matches mermaid.live so links and
        // class definitions in the diagram source don't get stripped.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: "default",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        });
        // Mermaid throws on invalid syntax — surface it cleanly.
        const { svg: out } = await mermaid.render(`mmd-${id}`, source);
        if (!cancelled) setSvg(out);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, id]);

  if (error) {
    return (
      <div
        className={`rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs ${className}`}
      >
        <p className="font-medium text-destructive">
          Couldn&apos;t render this diagram
        </p>
        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
          {error}
        </p>
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 text-[11px]">
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div
        className={`flex items-center justify-center rounded-md border bg-muted/20 p-6 text-xs text-muted-foreground ${className}`}
      >
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className={`mermaid-diagram-host overflow-auto rounded-md border bg-white p-3 dark:bg-white ${className}`}
      // SVG is generated from the user-provided diagram source by the
      // mermaid library client-side. No external HTML is interpolated;
      // dangerouslySetInnerHTML is the standard way to inject mermaid's
      // SVG output.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
