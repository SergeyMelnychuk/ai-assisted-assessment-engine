import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yauzl from "yauzl-promise";
import { fillTemplate } from "./filler";
import { bindingDocumentSchema, type BindingDocument } from "./binding";
import type { EngineOutputs } from "./engine-outputs";

// E2E proof for the workspace-default Team Proposal docx shell.
// Loads the actual shipped file + binding from packages/knowledge-seed
// so any drift in either side is caught at type-check / test time.

const SHELL_DIR = path.resolve(
  __dirname,
  "../../../../../../packages/knowledge-seed/deliverable-shells",
);
const DOCX_PATH = path.join(SHELL_DIR, "team-proposal-v1.docx");
const BINDING_PATH = path.join(SHELL_DIR, "team-proposal-v1.binding.json");

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function baseOutputs(): EngineOutputs {
  // Three roles so the per-role array iteration is exercised. The
  // binding renders each per-role column as a comma-joined list, so
  // multiple entries land in a single placeholder.
  return {
    roles: [
      {
        roleName: "Engagement Lead",
        seniority: "Principal",
        count: 1,
        hoursLow: 120,
        hoursHigh: 160,
        hourlyRate: 250,
        costLow: 30000,
        costHigh: 40000,
        justification: "Owns delivery and stakeholder cadence.",
        responsibilities: "Delivery oversight, executive comms.",
        phase: null,
      },
      {
        roleName: "Solution Architect",
        seniority: "Senior",
        count: 1,
        hoursLow: 200,
        hoursHigh: 260,
        hourlyRate: 220,
        costLow: 44000,
        costHigh: 57200,
        justification: "Anchors target-state design and tech decisions.",
        responsibilities: "Architecture, integration patterns, NFRs.",
        phase: "Design",
      },
      {
        roleName: "Senior Engineer",
        seniority: "Senior",
        count: 2,
        hoursLow: 480,
        hoursHigh: 600,
        hourlyRate: 180,
        costLow: 86400,
        costHigh: 108000,
        justification: "Builds the highest-risk slices first.",
        responsibilities: "Implementation, code review, automated tests.",
        phase: "Build",
      },
    ],
    totals: {
      effortHoursLow: 800,
      effortHoursHigh: 1020,
      costLow: 160400,
      costHigh: 205200,
      scenarioName: "Recommended scenario",
      assumptions:
        "Team co-located in two time zones; CI/CD and shared dev infra in place at kickoff.",
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
    engagement: { name: "Phase 1 Discovery", clientName: "Acme Corp" },
    assessment: {
      findingsCount: 0,
      risksCount: 0,
      recommendationsCount: 0,
      activeDomains: [],
    },
    findings: { bulletList: "" },
    risks: { bulletList: "" },
    recommendations: { bulletList: "" },
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

describe("team-proposal-v1 workspace-default shell", () => {
  it("binding JSON validates against the schema", () => {
    const raw = JSON.parse(fs.readFileSync(BINDING_PATH, "utf8"));
    const parsed = bindingDocumentSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.templateKind).toBe("TEAM_PROPOSAL");
      // Every per-role field must use the [*] form — `roles[N].x` is
      // not supported by resolveEngineField and would silently warn.
      for (const entry of parsed.data.entries) {
        if (entry.field.startsWith("roles")) {
          expect(entry.field.startsWith("roles[*].")).toBe(true);
        }
      }
    }
  });

  it("fills every placeholder with no warnings", async () => {
    const templateBuffer = fs.readFileSync(DOCX_PATH);
    const binding = JSON.parse(
      fs.readFileSync(BINDING_PATH, "utf8"),
    ) as BindingDocument;

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

    // Every token defined in the binding must be substituted.
    for (const entry of binding.entries) {
      if (entry.target.kind === "docx.placeholder") {
        expect(xml).not.toContain(entry.target.token);
      }
    }

    // Spot-check a few values landed in the rendered xml. The filler
    // joins arrays with ", " — the docx escapes "&" but role names
    // here have none.
    expect(xml).toContain("Acme Migration");
    expect(xml).toContain("Acme Corp");
    expect(xml).toContain("Phase 1 Discovery");
    expect(xml).toContain("Recommended scenario");
    expect(xml).toContain(
      "Engagement Lead, Solution Architect, Senior Engineer",
    );
    expect(xml).toContain("Principal, Senior, Senior");
  });
});
