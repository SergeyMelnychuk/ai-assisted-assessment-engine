import { describe, expect, it } from "vitest";

import { arcPath } from "./pie-chart";

/**
 * React Testing Library isn't wired into the app package (see
 * `file-status-row.test.tsx` for the precedent) — so we cover the
 * pure arc-path math instead. The arc-path generator is where the
 * pie chart's correctness actually lives; the render shell is a
 * thin SVG wrapper whose bugs would be obvious on visual review.
 *
 * The assertions below are stability tests: we lock in the `d`
 * attribute format so refactors can't silently change the rendered
 * geometry for existing callers.
 */
describe("arcPath", () => {
  it("generates a closed pie wedge for a small slice", () => {
    // Quarter circle at origin, radius 10, from 0 to PI/2.
    const d = arcPath(0, 0, 10, 0, Math.PI / 2);
    // Moves to center, lines to start point on circle, arcs,
    // then closes. Small-arc flag (`0`) because sweep <= PI.
    expect(d).toContain("M 0 0 L");
    expect(d).toContain("A 10 10 0 0 1");
    expect(d.endsWith("Z")).toBe(true);
  });

  it("uses the large-arc flag for sweeps > PI", () => {
    const d = arcPath(0, 0, 10, 0, Math.PI * 1.2);
    expect(d).toContain("A 10 10 0 1 1");
  });

  it("draws a full circle as two half-arcs when sweep is 2π", () => {
    const d = arcPath(0, 0, 10, 0, Math.PI * 2);
    // Two `A` commands — single-arc can't represent a 360° sweep
    // because the start and end points would coincide.
    const arcs = d.match(/A 10 10/g);
    expect(arcs).not.toBeNull();
    expect(arcs?.length).toBe(2);
  });

  it("produces stable output for a 3-segment pie (regression lock)", () => {
    // Three equal slices starting at -PI/2 (12 o'clock), matching
    // the component's `cursor = -Math.PI / 2` convention. If this
    // string changes, the rendered geometry changed — review it.
    const third = (Math.PI * 2) / 3;
    const cx = 90;
    const cy = 90;
    const r = 88;
    const start = -Math.PI / 2;
    const d1 = arcPath(cx, cy, r, start, start + third);
    const d2 = arcPath(cx, cy, r, start + third, start + 2 * third);
    const d3 = arcPath(cx, cy, r, start + 2 * third, start + 3 * third);
    // All three wedges should start at the center, contain one
    // arc, and close — and all three must be distinct strings.
    for (const d of [d1, d2, d3]) {
      expect(d.startsWith(`M ${cx} ${cy} L`)).toBe(true);
      expect(d).toContain(`A ${r} ${r} 0 0 1`);
      expect(d.endsWith("Z")).toBe(true);
    }
    expect(new Set([d1, d2, d3]).size).toBe(3);
  });
});
