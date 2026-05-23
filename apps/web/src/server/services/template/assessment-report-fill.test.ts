import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import yauzl from "yauzl-promise";
import { fillTemplate } from "./filler";
import { bindingDocumentSchema, type BindingDocument } from "./binding";
import type { EngineOutputs } from "./engine-outputs";

// ─── Fixtures ──────────────────────────────────────────────────────
//
// `baseOutputs` mirrors the helper in `filler.test.ts`. We keep our
// own copy here so the test exercises the real ASSESSMENT_REPORT
// binding end-to-end without sharing state with the unit-level
// fixtures.

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
      assumptions: "Stable scope; no new regulatory drivers in flight.",
      confidence: 0.7,
      currency: "USD",
    },
    project: {
      name: "Acme Migration",
      industry: "Finance",
      description: "Migrate legacy mainframe ledgers to a cloud platform.",
      businessGoals: "Reduce run cost; unlock real-time reporting.",
      expectedTimeline: "9 months",
      budgetSensitivity: "",
      complianceRequirements: [],
    },
    engagement: { name: "Eng", clientName: "Acme" },
    assessment: {
      findingsCount: 4,
      risksCount: 3,
      recommendationsCount: 5,
      activeDomains: ["DATA", "SECURITY"],
    },
    findings: { bulletList: "- [HIGH/DATA] Stale schemas" },
    risks: { bulletList: "- [HIGH/COMPLIANCE] Audit gap" },
    recommendations: {
      bulletList: "- [HIGH/DATA] Adopt schema registry",
    },
    section: {
      executive_summary: "Two-paragraph sponsor summary.",
      engagement_context: "Engagement scope + approach narrative.",
      current_state: "Current-state architecture observations.",
      key_findings: "Top findings, prose form, no severity prefixes.",
      risks: "Top risks, prose form, with mitigations.",
      recommendations: "Prioritised recs in near/mid/long term buckets.",
      target_state: "Where the architecture should go.",
      team_and_estimate: "Proposed team narrative.",
    },
    generated: { date: "2026-05-10", timestamp: "2026-05-10T00:00:00Z" },
    ...overrides,
  };
}

// Locate the seeded template + binding via a path relative to this
// test file. The knowledge-seed lives at the repo root; six segments
// up from `apps/web/src/server/services/template/` lands there.
const SEED_DIR = path.resolve(
  __dirname,
  "../../../../../..",
  "packages/knowledge-seed/deliverable-shells",
);
const TEMPLATE_PATH = path.join(SEED_DIR, "assessment-report-v1.docx");
const BINDING_PATH = path.join(
  SEED_DIR,
  "assessment-report-v1.binding.json",
);

async function readDocumentXml(buf: Buffer): Promise<string> {
  const zip = await yauzl.fromBuffer(buf);
  for await (const entry of zip) {
    if (entry.filename !== "word/document.xml") continue;
    const stream = await entry.openReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("word/document.xml not found in filled buffer");
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("assessment-report-v1 (workspace default)", () => {
  it("ships a binding that parses against the schema", () => {
    const raw = JSON.parse(fs.readFileSync(BINDING_PATH, "utf8"));
    const result = bindingDocumentSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it("fills cleanly: no warnings, all binding tokens replaced", async () => {
    const templateBuffer = fs.readFileSync(TEMPLATE_PATH);
    const binding = JSON.parse(
      fs.readFileSync(BINDING_PATH, "utf8"),
    ) as BindingDocument;

    const result = await fillTemplate({
      templateBuffer,
      templateMimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      binding,
      outputs: baseOutputs(),
    });

    expect(result.warnings).toEqual([]);
    expect(result.filledEntryCount).toBeGreaterThan(0);

    const xml = await readDocumentXml(result.buffer);
    const tokens = binding.entries
      .map((e) =>
        e.target.kind === "docx.placeholder" ? e.target.token : null,
      )
      .filter((t): t is string => t !== null);
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(xml).not.toContain(token);
    }
    // Spot-check that filled values from baseOutputs() landed on the cover.
    expect(xml).toContain("Acme Migration");
    expect(xml).toContain("Acme");
  });
});
