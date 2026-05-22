"use client";

import { useState } from "react";

/**
 * Minimal, dependency-free CSS bar chart. Horizontal bars with an
 * inline numeric label and a gridline at the max-value tick. We keep
 * this small on purpose — the dashboard tabs don't need a real charting
 * library (ADR-worthy if we ever add one). Every row has an accessible
 * `<th scope="row">` + `<td>` under the hood so screen readers don't
 * get a mystery block of colored divs.
 *
 * `segments` is an optional stacked-bar overlay. When present, each row
 * is split into coloured segments whose widths sum to `row.value`. The
 * legend is rendered by the caller (it's cheap to inline and lets the
 * caller pick its own label order).
 *
 * Hover affordance: the raw `title` attribute route fires the native OS
 * tooltip, which has a ~1 s delay and styling users often don't notice
 * as "this is interactive". We render a cursor-following div tooltip on
 * hover instead — zero-delay, dark pill, matches the rest of the UI.
 * `title` is still emitted on the underlying elements so screen readers
 * and keyboard-focus flows keep working.
 */
export type BarRow = {
  key: string;
  label: string;
  value: number;
  segments?: Array<{ key: string; value: number; className?: string }>;
};

interface HoverState {
  x: number;
  y: number;
  text: string;
}

export function BarChart({
  rows,
  maxValue,
  emptyLabel = "No data",
  ariaLabel,
}: {
  rows: BarRow[];
  /** Optional cap — defaults to max(row.value) so a single row fills the track. */
  maxValue?: number;
  emptyLabel?: string;
  /** Required for screen readers — describe what's being counted. */
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<HoverState | null>(null);

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }
  const max = Math.max(1, maxValue ?? Math.max(...rows.map((r) => r.value)));

  function onMove(text: string) {
    return (e: React.MouseEvent<HTMLElement>) => {
      const container = e.currentTarget.closest(
        "[data-bar-chart]",
      ) as HTMLElement | null;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setHover({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        text,
      });
    };
  }

  return (
    <div className="relative" data-bar-chart onMouseLeave={() => setHover(null)}>
      <table
        className="w-full border-separate border-spacing-y-1 text-sm"
        aria-label={ariaLabel}
      >
        <tbody>
          {rows.map((r) => {
            const pct = (r.value / max) * 100;
            const rowTooltip = `${r.label}: ${r.value}`;
            return (
              <tr key={r.key}>
                <th
                  scope="row"
                  className="w-1/3 min-w-0 pr-3 text-left text-xs font-normal text-muted-foreground"
                >
                  <span className="block truncate" title={r.label}>
                    {r.label}
                  </span>
                </th>
                <td className="relative">
                  <div
                    className="relative h-5 overflow-hidden rounded-sm bg-muted/40"
                    onMouseMove={
                      r.segments && r.segments.length > 0
                        ? undefined
                        : onMove(rowTooltip)
                    }
                    onMouseLeave={() => setHover(null)}
                    aria-hidden
                  >
                    {r.segments && r.segments.length > 0 ? (
                      <div
                        className="flex h-full"
                        style={{ width: `${pct}%` }}
                      >
                        {r.segments.map((seg, i) => {
                          const segPct =
                            r.value === 0 ? 0 : (seg.value / r.value) * 100;
                          const segTooltip = `${r.label} · ${seg.key}: ${seg.value}`;
                          return (
                            <div
                              key={`${seg.key}-${i}`}
                              className={`h-full ${seg.className ?? "bg-primary/70"}`}
                              style={{ width: `${segPct}%` }}
                              title={`${seg.key}: ${seg.value}`}
                              onMouseMove={onMove(segTooltip)}
                              onMouseLeave={() => setHover(null)}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <div
                        className="h-full bg-primary/70"
                        style={{ width: `${pct}%` }}
                        title={rowTooltip}
                      />
                    )}
                  </div>
                </td>
                <td className="w-12 pl-3 text-right text-xs tabular-nums text-foreground">
                  {r.value}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {hover ? (
        <div
          className="pointer-events-none absolute z-20 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md"
          style={{
            // Offset so the pill doesn't sit under the cursor and
            // flicker when the mouse crosses its own edge.
            left: hover.x + 12,
            top: hover.y + 12,
          }}
          role="tooltip"
        >
          {hover.text}
        </div>
      ) : null}
    </div>
  );
}
