import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yauzl from "yauzl-promise";
import { fillTemplate } from "./filler";
import { bindingDocumentSchema, type BindingDocument } from "./binding";
import type { EngineOutputs } from "./engine-outputs";

/**
 * E2E proof for the workspace-default Target State v1 deck. Reads the
 * shipped `.pptx` + binding pair, runs the filler, and asserts every
 * `{{token}}` is resolved on every slide. A surviving token usually
 * means pptx split it across `<a:t>` runs (see filler.ts caveat).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = path.resolve(
  HERE,
  "../../../../../../packages/knowledge-seed/deliverable-shells",
);
const PPTX_PATH = path.join(SHELL_DIR, "target-state-v1.pptx");
const BINDING_PATH = path.join(SHELL_DIR, "target-state-v1.binding.json");
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

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
      description: "Lift the legacy core onto the modern platform.",
      businessGoals: "Reduce time-to-launch for new products.",
      expectedTimeline: "12-18 months",
      budgetSensitivity: "",
      complianceRequirements: [],
    },
    engagement: { name: "Eng", clientName: "Acme" },
    assessment: {
      findingsCount: 0,
      risksCount: 0,
      recommendationsCount: 0,
      activeDomains: [],
    },
    findings: { bulletList: "- [HIGH/Architecture] Monolithic core" },
    risks: { bulletList: "- [HIGH/Delivery] Limited platform skill" },
    recommendations: {
      bulletList: "- [HIGH/Architecture] Move to event-driven core",
    },
    section: {
      target_state_findings_drivers: "- Stale schemas slow every release.",
      target_state_risks_drivers: "- Vendor lock-in blocks the migration.",
      target_state_narrative: "Target-state architecture narrative.",
      target_state_recommendations: "- Adopt a schema registry.",
      target_state_transition_risks: "- Cutover risk during the migration.",
    },
    generated: { date: "2026-05-10", timestamp: "2026-05-10T00:00:00Z" },
    ...overrides,
  };
}

async function listSlideXml(buf: Buffer): Promise<Map<string, string>> {
  const zip = await yauzl.fromBuffer(buf);
  const slides = new Map<string, string>();
  for await (const entry of zip) {
    const stream = await entry.openReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    if (/^ppt\/slides\/slide\d+\.xml$/.test(entry.filename)) {
      slides.set(entry.filename, Buffer.concat(chunks).toString("utf8"));
    }
  }
  return slides;
}

describe("target-state-v1 (workspace-default pptx shell)", () => {
  it("fills every binding token on every slide without warnings", async () => {
    const [templateBuffer, bindingRaw] = await Promise.all([
      readFile(PPTX_PATH),
      readFile(BINDING_PATH, "utf8"),
    ]);
    const binding: BindingDocument = bindingDocumentSchema.parse(
      JSON.parse(bindingRaw),
    );
    expect(binding.templateKind).toBe("TARGET_STATE");
    expect(binding.entries.length).toBeGreaterThan(0);

    const result = await fillTemplate({
      templateBuffer,
      templateMimeType: PPTX_MIME,
      binding,
      outputs: baseOutputs(),
    });

    expect(result.warnings).toEqual([]);
    expect(result.filledEntryCount).toBeGreaterThan(0);

    const slides = await listSlideXml(result.buffer);
    expect(slides.size).toBeGreaterThanOrEqual(10);
    for (const [name, xml] of slides) {
      expect(xml, `${name} still has {{token}} markers`).not.toMatch(
        /\{\{[a-z_]+\}\}/i,
      );
    }
  });
});
