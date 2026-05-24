import { describe, expect, it } from "vitest";
import { resolveEngineField, type EngineOutputs } from "./engine-outputs";

// Pure unit test for `resolveEngineField`. We don't touch
// `loadEngineOutputs` here — that one talks to Prisma and is covered
// by integration tests.

function fixture(overrides: Partial<EngineOutputs> = {}): EngineOutputs {
  return {
    roles: [
      {
        roleName: "PM",
        seniority: "Senior",
        count: 1,
        hoursLow: 100,
        hoursHigh: 120,
        hourlyRate: 200,
        costLow: 20000,
        costHigh: 24000,
        justification: "drives delivery",
        responsibilities: "owns plan",
        phase: "DISCOVERY",
      },
      {
        roleName: "Backend Engineer",
        seniority: "Mid",
        count: 2,
        hoursLow: 300,
        hoursHigh: 360,
        hourlyRate: 150,
        costLow: 45000,
        costHigh: 54000,
        justification: "builds APIs",
        responsibilities: "writes services",
        phase: null,
      },
    ],
    totals: {
      effortHoursLow: 400,
      effortHoursHigh: 480,
      costLow: 65000,
      costHigh: 78000,
      scenarioName: "Greenfield MVP",
      assumptions: "no legacy data",
      confidence: 0.7,
      currency: "USD",
    },
    project: {
      name: "Acme Migration",
      industry: "Finance",
      description: "modernize core banking",
      businessGoals: "reduce TCO",
      expectedTimeline: "6 months",
      budgetSensitivity: "MEDIUM",
      complianceRequirements: ["SOC2", "PCI"],
    },
    engagement: { name: "Eng-A", clientName: "Acme Corp" },
    assessment: {
      findingsCount: 3,
      risksCount: 2,
      recommendationsCount: 4,
      activeDomains: ["security", "data"],
    },
    findings: { bulletList: "- [HIGH/security] X" ,
      rows: [],
    },
    risks: { bulletList: "- [HIGH/tech] Y" ,
      rows: [],
    },
    recommendations: { bulletList: "- [P1/security] Z" ,
      rows: [],
    },
    section: {},
    generated: { date: "2026-05-07", timestamp: "2026-05-07T00:00:00Z" },
    ...overrides,
  };
}

describe("resolveEngineField", () => {
  it("resolves a flat string path", () => {
    const out = fixture();
    expect(resolveEngineField(out, "totals.scenarioName")).toBe(
      "Greenfield MVP",
    );
    expect(resolveEngineField(out, "engagement.clientName")).toBe("Acme Corp");
  });

  it("resolves a flat numeric path as a number", () => {
    const out = fixture();
    const v = resolveEngineField(out, "totals.effortHoursLow");
    expect(v).toBe(400);
    expect(typeof v).toBe("number");
  });

  it("returns undefined for a missing nested path", () => {
    const out = fixture();
    // `totals.nope` doesn't exist
    expect(resolveEngineField(out, "totals.nope")).toBeUndefined();
    // top-level missing
    expect(resolveEngineField(out, "doesNotExist.field")).toBeUndefined();
    // walking into a primitive should also stop and return undefined
    expect(
      resolveEngineField(out, "totals.scenarioName.length"),
    ).toBeUndefined();
  });

  it("expands roles[*].field into an array of values", () => {
    const out = fixture();
    const names = resolveEngineField(out, "roles[*].roleName");
    expect(names).toEqual(["PM", "Backend Engineer"]);

    const counts = resolveEngineField(out, "roles[*].count");
    expect(counts).toEqual([1, 2]);
  });

  it("coerces mixed/unknown values in the iterator to empty strings", () => {
    // `phase` is sometimes null — current resolver coerces non-string,
    // non-number values to "" when expanding.
    const out = fixture();
    const phases = resolveEngineField(out, "roles[*].phase");
    expect(phases).toEqual(["DISCOVERY", ""]);
  });

  it("returns an array of empty strings when the iterator field is unknown", () => {
    const out = fixture();
    const v = resolveEngineField(out, "roles[*].nope");
    expect(v).toEqual(["", ""]);
  });

  it("returns an array of strings for a flat string-array path", () => {
    const out = fixture();
    const domains = resolveEngineField(out, "assessment.activeDomains");
    expect(domains).toEqual(["security", "data"]);
  });
});
