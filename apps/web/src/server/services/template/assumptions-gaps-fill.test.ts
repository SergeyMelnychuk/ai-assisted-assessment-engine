import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yauzl from "yauzl-promise";
import { fillTemplate } from "./filler";
import { bindingDocumentSchema, type BindingDocument } from "./binding";
import type { EngineOutputs } from "./engine-outputs";

// Sanity-fill the workspace-default ASSUMPTIONS_GAPS shell against
// the engine outputs. Mirrors what the worker does at runtime: load
// the shipped .docx + .binding.json, fill, expect zero warnings and a
// non-zero filled-entry count, and confirm no `{{token}}` from the
// binding survived.

const SHELLS_DIR = path.resolve(
  __dirname,
  "../../../../../../packages/knowledge-seed/deliverable-shells",
);
const TEMPLATE_PATH = path.join(SHELLS_DIR, "assumptions-gaps-v1.docx");
const BINDING_PATH = path.join(SHELLS_DIR, "assumptions-gaps-v1.binding.json");

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function baseOutputs(): EngineOutputs {
  return {
    roles: [],
    totals: {
      effortHoursLow: 0,
      effortHoursHigh: 0,
      costLow: 0,
      costHigh: 0,
      scenarioName: "Default scenario",
      assumptions:
        "We assume one production region, business-hours support, and that the client team handles end-user training.",
      confidence: 0.7,
      currency: "USD",
    },
    project: {
      name: "Acme Modernization",
      industry: "Finance",
      description:
        "Lift-and-shift the legacy mainframe estate onto a modern cloud platform.",
      businessGoals: "",
      expectedTimeline: "",
      budgetSensitivity: "",
      complianceRequirements: [],
    },
    engagement: { name: "Phase 1 Discovery", clientName: "Acme Corp" },
    assessment: {
      findingsCount: 4,
      risksCount: 3,
      recommendationsCount: 5,
      activeDomains: ["security", "data"],
    },
    findings: { bulletList: "" ,
      rows: [],
    },
    risks: { bulletList: "" ,
      rows: [],
    },
    recommendations: {
      bulletList:
        "- [HIGH/security] Establish baseline IAM controls\n- [MEDIUM/data] Inventory PII flows\n- [MEDIUM/architecture] Confirm tenancy model",
      rows: [],
    },
    section: {
      open_questions: "- Q1: Is region-pairing finalised?",
      dependencies: "- Vendor SDK upgrade window.",
      evidence_gaps: "- Observability layer has no recent runbooks.",
      next_discovery_activities: "- Workshop with platform team on Q-2.",
    },
    generated: { date: "2026-05-10", timestamp: "2026-05-10T00:00:00Z" },
  };
}

async function readZipEntry(
  buf: Buffer,
  filename: string,
): Promise<string | undefined> {
  const zip = await yauzl.fromBuffer(buf);
  for await (const entry of zip) {
    const stream = await entry.openReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    if (entry.filename === filename) {
      return Buffer.concat(chunks).toString("utf8");
    }
  }
  return undefined;
}

describe("assumptions-gaps-v1 workspace shell", () => {
  it("fills cleanly against representative engine outputs", async () => {
    const templateBuffer = fs.readFileSync(TEMPLATE_PATH);
    const bindingRaw = JSON.parse(fs.readFileSync(BINDING_PATH, "utf8"));
    const binding = bindingDocumentSchema.parse(bindingRaw) as BindingDocument;

    const result = await fillTemplate({
      templateBuffer,
      templateMimeType: DOCX_MIME,
      binding,
      outputs: baseOutputs(),
    });

    expect(result.warnings).toEqual([]);
    expect(result.filledEntryCount).toBeGreaterThan(0);

    const xml = await readZipEntry(result.buffer, "word/document.xml");
    expect(xml).toBeDefined();
    // Every token referenced in the binding must have been substituted.
    const tokens = binding.entries
      .map((e) =>
        e.target.kind === "docx.placeholder" ? e.target.token : null,
      )
      .filter((t): t is string => t !== null);
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(xml).not.toContain(token);
    }
    // Spot-check a couple of values landed.
    expect(xml).toContain("Acme Modernization");
    expect(xml).toContain("Acme Corp");
  });
});
