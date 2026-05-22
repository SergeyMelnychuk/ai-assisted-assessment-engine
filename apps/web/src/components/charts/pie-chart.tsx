"use client";

import { useState } from "react";

/**
 * Dependency-free SVG pie chart. Renders a donut-less pie with one
 * `<path>` per segment, computing arc sweeps from cumulative angle
 * math. We deliberately avoid a chart library — a pie is ~50 lines
 * of SVG and adding recharts/victory would bloat the bundle for the
 * one tab that needs it (ADR-worthy if ever reused heavily).
 *
 * Accessibility: the SVG is `aria-hidden` and the same data is
 * mirrored as a `<table>` legend below (pattern lifted from
 * `bar-chart.tsx`) so screen readers read the numbers, not the
 * shape. The native `<title>` child on each `<path>` stays as the
 * SR/keyboard-focus fallback; the *visual* hover tooltip is a
 * cursor-following div (zero delay, consistent styling) — native
 * SVG `<title>` fires on a ~1 s hold which users read as "no tooltip".
 *
 * Edge cases we explicitly handle:
 *   - Empty input → placeholder ("no usage yet"), not a crash.
 *   - Single 100% slice → drawn as a full circle (two half-arcs
 *     can't represent a 360° sweep because start == end angle).
 *   - Zero-total (all segments value 0) → placeholder too; a pie
 *     of zeros would be a blank box.
 */

export type PieSegment = {
  label: string;
  value: number;
  color: string;
};

interface HoverState {
  x: number;
  y: number;
  text: string;
}

/**
 * Exported for tests — converts a cumulative-angle pair into an
 * SVG `path` `d` attribute. Kept pure (no DOM, no React) so the
 * arc math is unit-testable without rendering.
 */
export function arcPath(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): string {
  // Full-circle sweep — two 180° arcs because a single path from
  // start to same-point start would have zero length.
  if (endAngle - startAngle >= Math.PI * 2 - 1e-9) {
    const midAngle = startAngle + Math.PI;
    const p1x = cx + r * Math.cos(startAngle);
    const p1y = cy + r * Math.sin(startAngle);
    const p2x = cx + r * Math.cos(midAngle);
    const p2y = cy + r * Math.sin(midAngle);
    return `M ${p1x} ${p1y} A ${r} ${r} 0 1 1 ${p2x} ${p2y} A ${r} ${r} 0 1 1 ${p1x} ${p1y} Z`;
  }
  const x1 = cx + r * Math.cos(startAngle);
  const y1 = cy + r * Math.sin(startAngle);
  const x2 = cx + r * Math.cos(endAngle);
  const y2 = cy + r * Math.sin(endAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  // `sweepFlag=1` for clockwise — matches the cumulative-angle
  // convention the caller uses (angles grow positively).
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
}

export function PieChart({
  segments,
  size = 180,
  legend = true,
  emptyLabel = "No data",
  ariaLabel,
}: {
  segments: PieSegment[];
  /** Square SVG edge in px. Pie fits with a small inset so the
   *  stroke (if any) is never clipped. */
  size?: number;
  legend?: boolean;
  emptyLabel?: string;
  /** Required for screen readers — describe what's being split. */
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<HoverState | null>(null);

  const total = segments.reduce((a, s) => a + s.value, 0);
  if (segments.length === 0 || total <= 0) {
    return (
      <p className="rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 2;

  let cursor = -Math.PI / 2; // start at 12 o'clock so the eye lands there
  const paths = segments.map((seg) => {
    const sweep = (seg.value / total) * Math.PI * 2;
    const start = cursor;
    const end = cursor + sweep;
    cursor = end;
    const d = arcPath(cx, cy, r, start, end);
    const pct = (seg.value / total) * 100;
    return { seg, d, pct };
  });

  function onMove(text: string) {
    return (e: React.MouseEvent<SVGElement>) => {
      // Position is relative to the SVG wrapper so the tooltip div
      // (absolutely positioned inside the same relative container)
      // lines up with the cursor regardless of page scroll.
      const container = (e.currentTarget.ownerSVGElement ??
        e.currentTarget) as SVGSVGElement;
      const rect = container.getBoundingClientRect();
      setHover({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        text,
      });
    };
  }

  return (
    <div
      className="flex flex-col items-start gap-3 sm:flex-row sm:items-center"
      aria-label={ariaLabel}
    >
      <div className="relative flex-shrink-0">
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-hidden
          onMouseLeave={() => setHover(null)}
        >
          {paths.map(({ seg, d, pct }) => {
            const tooltipText = `${seg.label}: ${seg.value.toFixed(4)} (${pct.toFixed(1)}%)`;
            return (
              <path
                key={seg.label}
                d={d}
                fill={seg.color}
                onMouseMove={onMove(tooltipText)}
                className="transition-opacity hover:opacity-80"
              >
                <title>{tooltipText}</title>
              </path>
            );
          })}
        </svg>
        {hover ? (
          <div
            className="pointer-events-none absolute z-20 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
            role="tooltip"
          >
            {hover.text}
          </div>
        ) : null}
      </div>
      {legend ? (
        <table className="w-full border-separate border-spacing-y-1 text-xs">
          <tbody>
            {paths.map(({ seg, pct }) => (
              <tr key={seg.label}>
                <th scope="row" className="pr-2 text-left font-normal">
                  <span className="inline-flex items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: seg.color }}
                    />
                    <span className="truncate" title={seg.label}>
                      {seg.label}
                    </span>
                  </span>
                </th>
                <td className="text-right tabular-nums text-muted-foreground">
                  {pct.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
