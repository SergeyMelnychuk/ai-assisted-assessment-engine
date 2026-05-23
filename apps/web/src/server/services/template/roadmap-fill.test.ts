import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yauzl from "yauzl-promise";
import { fillTemplate } from "./filler";
import {
  bindingDocumentSchema,
  type BindingDocument,
} from "./binding";
import type { EngineOutputs } from "./engine-outputs";

/**
 * E2E proof for the workspace-default Roadmap template.
 *
 * Reads the shipped `.pptx` + sibling `.binding.json` from
 * `packages/knowledge-seed/deliverable-shells/`, runs the filler
 * against a realistic engine-output fixture, and asserts:
 *   - the binding parses cleanly,
 *   - the fill produces no warnings,
 *   - every `{{token}}` from the binding is gone from every slide
 *     XML in the output.
 *
 * Per-phase scope (slides 3-5) is filled with AI-written narrative via
 * the `section.phase_<N>_scope` fields, which `loadEngineOutputs`
 * populates from the latest `Deliverable.sections` row for the
 * assessment. The milestones panel on slide 6 is filled with an AI-
 * written milestones list via `section.milestones_owners`.
 */

// Resolve paths relative to this test file so vitest's cwd doesn't
// matter. The shells live two packages over.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = path.resolve(
  HERE,
  "../../../../../../packages/knowledge-seed/deliverable-shells",
);
const PPTX_PATH = path.join(SHELL_DIR, "roadmap-v1.pptx");
const BINDING_PATH = path.join(SHELL_DIR, "roadmap-v1.binding.json");

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// Mirror of the `baseOutputs` fixture in filler.test.ts. Duplicated
// rather than imported so the test file stays self-contained — when
// the shape evolves we want the per-template tests to fail
// independently and surface the diff at the call site.
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
      assumptions: "Vendor SDK upgrade lands on schedule.",
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
    findings: { bulletList: "- [HIGH/security] MFA missing on admin tier" },
    risks: { bulletList: "- [HIGH/delivery] Vendor dependency on legacy SDK" },
    recommendations: {
      bulletList: "- [P1/security] Roll out MFA across the admin estate",
    },
    section: {
      phase_1_scope:
        "Foundation: lock down auth + observability before any new build work.",
      phase_2_scope:
        "Build: ship the new payment integration and harden the API gateway.",
      phase_3_scope:
        "Scale: ops handoff, SLO governance, retire legacy adapters.",
      milestones_owners:
        "- Phase 1 · Identity baseline — SSO + MFA enforced\n- Phase 2 · Payment go-live — first wave of merchants",
    },
    generated: { date: "2026-05-10", timestamp: "2026-05-10T00:00:00Z" },
    ...overrides,
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

describe("roadmap-v1 (workspace-default pptx shell)", () => {
  it("fills every binding token on every slide without warnings", async () => {
    const [templateBuffer, bindingRaw] = await Promise.all([
      readFile(PPTX_PATH),
      readFile(BINDING_PATH, "utf8"),
    ]);
    const parsedBinding = bindingDocumentSchema.parse(
      JSON.parse(bindingRaw),
    ) as BindingDocument;

    expect(parsedBinding.templateKind).toBe("ROADMAP");
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
    // The deck ships as cover + phasing rationale + 3 phase slides +
    // milestones/owners = 6 slides. Asserting on the count keeps a
    // future "deleted a slide" regression from sliding through.
    expect(slides.length).toBe(6);

    // Collect tokens from the binding (placeholder targets only — the
    // schema allows other kinds but this template uses placeholders).
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
