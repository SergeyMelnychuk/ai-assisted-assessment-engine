import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yauzl from "yauzl-promise";
import { fillTemplate } from "./filler";
import {
  bindingDocumentSchema,
  type BindingDocument,
} from "./binding";
import type { EngineOutputs } from "./engine-outputs";

/**
 * Lockstep check between the Greenfield Discovery v1 docx and its
 * sidecar binding. The two must agree: every token the binding
 * declares has to disappear from `word/document.xml` after fill.
 */

const SHELLS_DIR = path.resolve(
  __dirname,
  "../../../../../../packages/knowledge-seed/deliverable-shells",
);
const DOCX_PATH = path.join(SHELLS_DIR, "greenfield-discovery-v1.docx");
const BINDING_PATH = path.join(
  SHELLS_DIR,
  "greenfield-discovery-v1.binding.json",
);

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
      effortHoursLow: 1200,
      effortHoursHigh: 1600,
      costLow: 240000,
      costHigh: 320000,
      scenarioName: "Phase 1 — Foundations",
      assumptions:
        "Single-region deployment; off-the-shelf identity provider; no legacy data migration in scope.",
      confidence: 0.65,
      currency: "USD",
    },
    project: {
      name: "Acme Greenfield Platform",
      industry: "Financial services",
      description:
        "A new customer-facing platform replacing a manual, paper-based onboarding process.",
      businessGoals:
        "Reduce onboarding time by 50%, support self-service for 80% of journeys, and meet regulator-mandated audit trails.",
      expectedTimeline: "9 months to first production release",
      budgetSensitivity: "Medium — fixed annual envelope, willing to phase scope",
      complianceRequirements: ["GDPR", "SOC2"],
    },
    engagement: { name: "Acme — Discovery FY26", clientName: "Acme Bank" },
    assessment: {
      findingsCount: 0,
      risksCount: 2,
      recommendationsCount: 2,
      activeDomains: ["architecture", "security"],
    },
    findings: { bulletList: "" },
    risks: {
      bulletList:
        "- [HIGH/security] Identity provider lock-in\n- [MEDIUM/architecture] Single-region failover gap",
    },
    recommendations: {
      bulletList:
        "- [HIGH/architecture] Adopt event-driven core\n- [MEDIUM/security] Externalise secrets",
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

describe("greenfield-discovery v1 shell + binding", () => {
  it("validates against the binding schema", async () => {
    const raw = JSON.parse(await readFile(BINDING_PATH, "utf8")) as unknown;
    const parsed = bindingDocumentSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.templateKind).toBe("GREENFIELD_DISCOVERY");
      expect(parsed.data.entries.length).toBeGreaterThan(0);
    }
  });

  it("fills every bound {{token}} in the seeded docx", async () => {
    const templateBuffer = await readFile(DOCX_PATH);
    const binding = JSON.parse(
      await readFile(BINDING_PATH, "utf8"),
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
    // Every token the binding references must be gone from the
    // filled document.
    for (const entry of binding.entries) {
      if (entry.target.kind === "docx.placeholder") {
        expect(
          xml!.includes(entry.target.token),
          `token ${entry.target.token} (field ${entry.field}) was not substituted`,
        ).toBe(false);
      }
    }

    // Spot-check that representative resolved values landed in the
    // document — covers the project-context fields specifically.
    expect(xml).toContain("Acme Greenfield Platform");
    expect(xml).toContain("Acme Bank");
    expect(xml).toContain("Financial services");
    // complianceRequirements is a string[] joined with ", " for a
    // single-placeholder target.
    expect(xml).toContain("GDPR, SOC2");
  });
});
