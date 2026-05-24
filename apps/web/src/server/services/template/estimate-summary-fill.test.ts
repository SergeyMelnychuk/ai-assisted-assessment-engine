import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { fillTemplate } from "./filler";
import { bindingDocumentSchema } from "./binding";
import type { EngineOutputs } from "./engine-outputs";

/**
 * End-to-end fill of the workspace-default ESTIMATE shell — exercises
 * Cover scalar cells AND the Roles sheet's tableRow iteration with a
 * groupKey of "roles". Lives next to the binding so a reviewer who
 * tweaks the JSON sees this test fail before they ship a broken
 * default.
 */

const SHELL_DIR = path.join(
  __dirname,
  "../../../../../../packages/knowledge-seed/deliverable-shells",
);
const XLSX_PATH = path.join(SHELL_DIR, "estimate-summary-v1.xlsx");
const BINDING_PATH = path.join(SHELL_DIR, "estimate-summary-v1.binding.json");

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function baseOutputs(): EngineOutputs {
  // Three roles so the tableRow iteration is genuinely exercised
  // (one row would still pass but wouldn't catch off-by-one errors
  // in the column write loop).
  return {
    roles: [
      {
        roleName: "Engagement Lead",
        seniority: "Principal",
        count: 1,
        hoursLow: 80,
        hoursHigh: 100,
        hourlyRate: 320,
        costLow: 25600,
        costHigh: 32000,
        justification: "",
        responsibilities: "",
        phase: null,
      },
      {
        roleName: "Senior Engineer",
        seniority: "Senior",
        count: 2,
        hoursLow: 320,
        hoursHigh: 400,
        hourlyRate: 220,
        costLow: 70400,
        costHigh: 88000,
        justification: "",
        responsibilities: "",
        phase: null,
      },
      {
        roleName: "Cloud Architect",
        seniority: "Senior",
        count: 1,
        hoursLow: 120,
        hoursHigh: 160,
        hourlyRate: 280,
        costLow: 33600,
        costHigh: 44800,
        justification: "",
        responsibilities: "",
        phase: null,
      },
    ],
    totals: {
      effortHoursLow: 520,
      effortHoursHigh: 660,
      costLow: 129600,
      costHigh: 164800,
      scenarioName: "Baseline",
      assumptions:
        "Single region, no zero-downtime migration, business hours support.",
      confidence: 0.65,
      currency: "USD",
    },
    project: {
      name: "Acme Cloud Migration",
      industry: "Financial Services",
      description: "Lift-and-shift of three legacy apps to the cloud.",
      businessGoals: "",
      expectedTimeline: "",
      budgetSensitivity: "",
      complianceRequirements: [],
    },
    engagement: { name: "Q3 Cloud Discovery", clientName: "Acme Inc." },
    assessment: {
      findingsCount: 0,
      risksCount: 0,
      recommendationsCount: 0,
      activeDomains: [],
    },
    findings: { bulletList: "" ,
      rows: [],
    },
    risks: { bulletList: "" ,
      rows: [],
    },
    recommendations: { bulletList: "" ,
      rows: [],
    },
    section: {
      estimate_overview:
        "Mid-confidence estimate driven by security + identity work.",
    },
    generated: { date: "2026-05-10", timestamp: "2026-05-10T00:00:00Z" },
  };
}

describe("estimate-summary-v1 workspace-default shell", () => {
  it("binding JSON validates against bindingDocumentSchema", () => {
    const raw = JSON.parse(fs.readFileSync(BINDING_PATH, "utf8"));
    const parsed = bindingDocumentSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it("fills the Cover and Roles sheets without warnings", async () => {
    const buffer = fs.readFileSync(XLSX_PATH);
    const binding = JSON.parse(fs.readFileSync(BINDING_PATH, "utf8"));
    const outputs = baseOutputs();

    const result = await fillTemplate({
      templateBuffer: buffer,
      templateMimeType: XLSX_MIME,
      binding,
      outputs,
    });

    expect(result.warnings).toEqual([]);
    expect(result.filledEntryCount).toBeGreaterThan(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.buffer as unknown as ArrayBuffer);

    const cover = wb.getWorksheet("Cover");
    expect(cover).toBeDefined();
    // Equality (rather than just "not «bind»") proves the engine
    // wrote through the placeholder.
    expect(cover!.getCell("B5").value).toBe("Acme Cloud Migration");

    const roles = wb.getWorksheet("Roles");
    expect(roles).toBeDefined();
    // Data rows start at A4; the binding's tableRow group writes one
    // row per element of roles[*].
    expect(roles!.getCell("A4").value).toBe("Engagement Lead");
    expect(roles!.getCell("A5").value).toBe("Senior Engineer");
    expect(roles!.getCell("A6").value).toBe("Cloud Architect");
  });
});
