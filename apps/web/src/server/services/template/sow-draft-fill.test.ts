import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yauzl from "yauzl-promise";
import { fillTemplate } from "./filler";
import { bindingDocumentSchema, type BindingDocument } from "./binding";
import type { EngineOutputs } from "./engine-outputs";

// ─── Fixture (same shape as filler.test.ts) ────────────────────────

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
      effortHoursLow: 1200,
      effortHoursHigh: 1500,
      costLow: 240000,
      costHigh: 300000,
      scenarioName: "Phase 1 — Foundation",
      assumptions:
        "Single-region deployment; client provides SME availability.",
      confidence: 0.65,
      currency: "USD",
    },
    project: {
      name: "Acme Migration",
      industry: "Finance",
      description:
        "Replatform the customer onboarding suite onto a unified cloud-native stack.",
      businessGoals: "",
      expectedTimeline: "6 months",
      budgetSensitivity: "",
      complianceRequirements: [],
    },
    engagement: { name: "Onboarding 2026", clientName: "Acme Bank" },
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
      sow_scope: "Provider will deliver discovery, target-state design, and implementation guidance.",
      sow_deliverables_summary:
        "- Discovery summary\n- Target-state architecture\n- Implementation roadmap",
    },
    generated: { date: "2026-05-10", timestamp: "2026-05-10T00:00:00Z" },
    ...overrides,
  };
}

async function readZipEntry(
  buf: Buffer,
  filename: string,
): Promise<string | undefined> {
  const zip = await yauzl.fromBuffer(buf);
  for await (const entry of zip) {
    if (entry.filename !== filename) continue;
    const stream = await entry.openReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  return undefined;
}

const SHELLS_DIR = path.resolve(
  __dirname,
  "../../../../../../packages/knowledge-seed/deliverable-shells",
);
const DOCX_PATH = path.join(SHELLS_DIR, "sow-draft-v1.docx");
const BINDING_PATH = path.join(SHELLS_DIR, "sow-draft-v1.binding.json");

// ─── Tests ─────────────────────────────────────────────────────────

describe("sow-draft-v1 deliverable shell", () => {
  it("binding parses against bindingDocumentSchema", () => {
    const raw = JSON.parse(fs.readFileSync(BINDING_PATH, "utf8"));
    const result = bindingDocumentSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `Binding failed schema validation: ${result.error.message}`,
      );
    }
    expect(result.data.templateKind).toBe("SOW_DRAFT");
    // 15 engine-driven fields + 2 AI section fields (section.sow_scope,
    // section.sow_deliverables_summary) added in the deliverable-section
    // wiring work.
    expect(result.data.entries.length).toBe(17);
  });

  it("fills every {{token}} from the binding when run against the seeded shell", async () => {
    const buf = fs.readFileSync(DOCX_PATH);
    const binding = JSON.parse(
      fs.readFileSync(BINDING_PATH, "utf8"),
    ) as BindingDocument;

    const result = await fillTemplate({
      templateBuffer: buf,
      templateMimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      binding,
      outputs: baseOutputs(),
    });

    expect(result.warnings).toEqual([]);
    expect(result.filledEntryCount).toBeGreaterThan(0);

    const documentXml = await readZipEntry(result.buffer, "word/document.xml");
    expect(documentXml).toBeDefined();

    // Every token referenced by the binding must be replaced inside
    // word/document.xml — leftover tokens mean a split run or a typo
    // between the docx and the binding. The SOW shell only uses
    // docx.placeholder targets; assert that and check each token.
    for (const entry of binding.entries) {
      expect(entry.target.kind).toBe("docx.placeholder");
      if (entry.target.kind !== "docx.placeholder") continue;
      expect(documentXml).not.toContain(entry.target.token);
    }

    // Sanity check: a couple of high-leverage values landed.
    expect(documentXml).toContain("Acme Bank");
    expect(documentXml).toContain("Acme Migration");
  });
});
