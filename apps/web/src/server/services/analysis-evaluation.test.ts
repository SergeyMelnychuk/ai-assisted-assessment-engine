import { describe, expect, it } from "vitest";

import {
  evaluateRetrievalCases,
  evaluateScoreBandCases,
} from "./analysis-evaluation";

describe("analysis evaluation harness", () => {
  it("computes aggregate retrieval metrics over a labeled fixture", () => {
    const summary = evaluateRetrievalCases([
      {
        name: "security-fixture",
        expectedEvidenceIds: ["ev-1", "ev-2"],
        retrievedEvidenceIds: ["ev-1", "ev-9", "ev-2", "ev-10"],
      },
      {
        name: "observability-fixture",
        expectedEvidenceIds: ["ev-7"],
        retrievedEvidenceIds: ["ev-3", "ev-7", "ev-8"],
      },
    ]);

    expect(summary.cases).toHaveLength(2);
    expect(summary.meanPrecisionAtK).toBeCloseTo((0.5 + 1 / 3) / 2, 5);
    expect(summary.meanRecallAtK).toBeCloseTo(1, 5);
    expect(summary.meanReciprocalRank).toBeCloseTo((1 + 0.5) / 2, 5);
  });

  it("computes score-band pass rate and distance-to-band", () => {
    const summary = evaluateScoreBandCases([
      {
        name: "security-score",
        actualScore: 3.5,
        expectedMin: 3,
        expectedMax: 4,
      },
      {
        name: "platform-score",
        actualScore: 2,
        expectedMin: 3,
        expectedMax: 4,
      },
    ]);

    expect(summary.cases).toHaveLength(2);
    expect(summary.passRate).toBeCloseTo(0.5, 5);
    expect(summary.meanDistanceToBand).toBeCloseTo(0.5, 5);
  });
});
