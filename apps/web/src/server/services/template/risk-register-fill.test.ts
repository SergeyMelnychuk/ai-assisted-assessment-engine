import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { fillTemplate } from "./filler";
import { bindingDocumentSchema, type BindingDocument } from "./binding";
import type { EngineOutputs } from "./engine-outputs";

// ─── Fixture path resolution ──────────────────────────────────────
//
// vitest runs with `process.cwd() === apps/web` (matches the
// existing `deliverable-generator.ts` convention), so we anchor the
// seed-shell paths off that.

const SHELLS_DIR = path.resolve(
  process.cwd(),
  "../../packages/knowledge-seed/deliverable-shells",
);
const XLSX_PATH = path.join(SHELLS_DIR, "risk-register-v1.xlsx");
const BINDING_PATH = path.join(SHELLS_DIR, "risk-register-v1.binding.json");
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Mirror of `baseOutputs` in filler.test.ts — keeping a local copy
// keeps this test independent of fixture changes in the sibling file.
function baseOutputs(overrides: Partial<EngineOutputs> = {}): EngineOutputs {
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
        justification: "",
        responsibilities: "",
        phase: null,
      },
    ],
    totals: {
      effortHoursLow: 100,
      effortHoursHigh: 120,
      costLow: 20000,
      costHigh: 24000,
      scenarioName: "Default",
      assumptions: "",
      confidence: 0.7,
      currency: "USD",
    },
    project: {
      name: "Acme Migration",
      industry: "Finance",
      description: "",
      businessGoals: "",
      expectedTimeline: "",
      budgetSensitivity: "",
      complianceRequirements: [],
    },
    engagement: { name: "Eng", clientName: "Acme" },
    assessment: {
      findingsCount: 0,
      risksCount: 3,
      recommendationsCount: 0,
      activeDomains: [],
    },
    findings: { bulletList: "" },
    risks: {
      bulletList:
        "- [HIGH/SECURITY] Unpatched dependency drift\n" +
        "- [MEDIUM/OPERATIONS] No documented rollback plan\n" +
        "- [LOW/PROCESS] Manual release cadence",
    },
    recommendations: { bulletList: "" },
    generated: { date: "2026-05-10", timestamp: "2026-05-10T00:00:00Z" },
    ...overrides,
  };
}

describe("risk-register-v1 workspace-default template", () => {
  it("ships a binding sidecar that parses against bindingDocumentSchema", () => {
    const raw = JSON.parse(fs.readFileSync(BINDING_PATH, "utf8"));
    const parsed = bindingDocumentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `risk-register binding failed schema validation: ${parsed.error.message}`,
      );
    }
    expect(parsed.data.templateKind).toBe("RISK_REGISTER");
    expect(parsed.data.entries.length).toBeGreaterThan(0);
  });

  it("fills cleanly with no warnings and rewrites at least one «bind» cell", async () => {
    const templateBuffer = fs.readFileSync(XLSX_PATH);
    const binding = JSON.parse(
      fs.readFileSync(BINDING_PATH, "utf8"),
    ) as BindingDocument;
    const outputs = baseOutputs();

    const result = await fillTemplate({
      templateBuffer,
      templateMimeType: XLSX_MIME,
      binding,
      outputs,
    });

    expect(result.warnings).toEqual([]);
    expect(result.filledEntryCount).toBeGreaterThan(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.buffer as unknown as ArrayBuffer);
    expect(wb.getWorksheet("Cover")).toBeDefined();

    // At least one binding-targeted cell on Cover no longer holds the
    // «bind» token. A specific assertion (B4 === "Acme Migration") is
    // tempting but couples the test to the exact cell layout — the
    // looser invariant is what matters: the engine actually wrote.
    const replaced = binding.entries.filter((e) => {
      if (e.target.kind !== "xlsx.cell") return false;
      const sheet = wb.getWorksheet(e.target.sheet);
      if (!sheet) return false;
      const v = sheet.getCell(e.target.cell).value;
      return v !== "«bind»" && v !== null && v !== undefined && v !== "";
    });
    expect(replaced.length).toBeGreaterThan(0);
  });
});
