import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yauzl from "yauzl-promise";
import { fillTemplate } from "./filler";
import { bindingDocumentSchema } from "./binding";
import type { EngineOutputs } from "./engine-outputs";

/**
 * E2E proof for the workspace-default Executive Summary template:
 * reads the shipped `.pptx` + sibling binding JSON, runs the filler,
 * and asserts that every `{{token}}` from the binding is gone from
 * every slide. A surviving token usually means PowerPoint split it
 * across `<a:t>` runs (see the pptx caveat in `filler.ts`).
 */

// Resolve relative to this test file — vitest's cwd is unreliable.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = path.resolve(
  HERE,
  "../../../../../../packages/knowledge-seed/deliverable-shells",
);
const PPTX_PATH = path.join(SHELL_DIR, "executive-summary-v1.pptx");
const BINDING_PATH = path.join(SHELL_DIR, "executive-summary-v1.binding.json");

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function baseOutputs(): EngineOutputs {
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
      risksCount: 0,
      recommendationsCount: 0,
      activeDomains: [],
    },
    findings: { bulletList: "- [HIGH/security] MFA missing on admin tier" ,
      rows: [],
    },
    risks: { bulletList: "- [HIGH/delivery] Vendor dependency on legacy SDK" ,
      rows: [],
    },
    recommendations: {
      bulletList: "- [P1/security] Roll out MFA across the admin estate",
      rows: [],
    },
    section: {
      headline_findings:
        "- Auth lacks MFA across admin tier.\n- API gateway has no rate limits.",
      top_risks:
        "- Vendor SDK upgrade — schedule slip if dropped.\n- Single-region DB — RTO unmet.",
      executive_recommendations:
        "- Lock down identity first.\n- Add baseline observability.\n- Plan the multi-region cutover.",
    },
    generated: { date: "2026-05-10", timestamp: "2026-05-10T00:00:00Z" },
  };
}

async function listSlideXml(buf: Buffer): Promise<string[]> {
  const zip = await yauzl.fromBuffer(buf);
  const xmls: string[] = [];
  for await (const entry of zip) {
    const stream = await entry.openReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    if (/^ppt\/slides\/slide\d+\.xml$/.test(entry.filename)) {
      xmls.push(Buffer.concat(chunks).toString("utf8"));
    }
  }
  return xmls;
}

describe("executive-summary-v1 (workspace-default pptx shell)", () => {
  it("fills every binding token on every slide without warnings", async () => {
    const [templateBuffer, bindingRaw] = await Promise.all([
      readFile(PPTX_PATH),
      readFile(BINDING_PATH, "utf8"),
    ]);
    const parsedBinding = bindingDocumentSchema.parse(JSON.parse(bindingRaw));

    expect(parsedBinding.templateKind).toBe("EXECUTIVE_SUMMARY");
    expect(parsedBinding.entries.length).toBeGreaterThan(0);

    const result = await fillTemplate({
      templateBuffer,
      templateMimeType: PPTX_MIME,
      binding: parsedBinding,
      outputs: baseOutputs(),
    });

    expect(result.warnings).toEqual([]);
    expect(result.filledEntryCount).toBeGreaterThan(0);

    const slides = await listSlideXml(result.buffer);
    expect(slides.length).toBeGreaterThan(0);

    const tokens = parsedBinding.entries
      .map((e) =>
        e.target.kind === "docx.placeholder" ? e.target.token : null,
      )
      .filter((t): t is string => t !== null);

    for (const xml of slides) {
      for (const token of tokens) {
        expect(
          xml.includes(token),
          `Token ${token} survived in a slide XML — likely split across <a:t> runs.`,
        ).toBe(false);
      }
    }
  });
});
