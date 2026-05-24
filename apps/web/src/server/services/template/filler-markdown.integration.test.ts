import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yauzl from "yauzl-promise";
import ExcelJS from "exceljs";
import { fillTemplate } from "./filler";
import { bindingDocumentSchema } from "./binding";
import type { EngineOutputs } from "./engine-outputs";

/**
 * End-to-end smoke for the markdown-aware filler.
 *
 * The unit tests in `markdown-to-ooxml.test.ts` lock in the parser +
 * renderers. This file proves the **integration** — when the filler
 * runs against a real workspace shell and an `EngineOutputs.section`
 * value containing markdown, the output file carries native OOXML
 * structures (a:buChar / w:b / RichText runs) rather than the literal
 * markdown characters that v1's string-replace would have left.
 *
 * Each test picks one workspace template that has a section binding
 * we know about (roadmap pptx, assessment-report docx, risk-register
 * xlsx) and feeds it a section value with bullets + bold. Then it
 * verifies (a) the literal markdown characters are NOT in the output
 * and (b) the expected native structures ARE.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = path.resolve(
  HERE,
  "../../../../../../packages/knowledge-seed/deliverable-shells",
);

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function baseOutputs(
  overrides: Partial<EngineOutputs> = {},
): EngineOutputs {
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
      name: "Acme",
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
    findings: { bulletList: "", rows: [] },
    risks: { bulletList: "", rows: [] },
    recommendations: { bulletList: "", rows: [] },
    section: {},
    generated: { date: "2026-05-24", timestamp: "2026-05-24T00:00:00Z" },
    ...overrides,
  };
}

async function readZipText(buf: Buffer, fileFilter: (n: string) => boolean): Promise<string> {
  const zip = await yauzl.fromBuffer(buf);
  const parts: string[] = [];
  for await (const entry of zip) {
    if (!fileFilter(entry.filename)) continue;
    const stream = await entry.openReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    parts.push(Buffer.concat(chunks).toString("utf8"));
  }
  return parts.join("\n");
}

describe("markdown-aware filler integration", () => {
  it("renders pptx section markdown as native bullets + bold (Roadmap)", async () => {
    const templateBuffer = await readFile(
      path.join(SHELL_DIR, "roadmap-v1.pptx"),
    );
    const binding = bindingDocumentSchema.parse(
      JSON.parse(
        await readFile(
          path.join(SHELL_DIR, "roadmap-v1.binding.json"),
          "utf8",
        ),
      ),
    );

    const result = await fillTemplate({
      templateBuffer,
      templateMimeType: PPTX_MIME,
      binding,
      outputs: baseOutputs({
        section: {
          phase_1_scope:
            "Foundation locks down auth + observability before any new build work.",
          phase_2_scope: "Build wave.",
          phase_3_scope: "Scale wave.",
          milestones_owners:
            "- **Identity baseline** — SSO + MFA enforced\n- **Payment go-live** — first wave of merchants\n- Observability stack adopted",
        },
      }),
    });
    expect(result.warnings).toEqual([]);

    const slidesXml = await readZipText(result.buffer, (n) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(n),
    );

    // Milestones panel should render as PowerPoint bullets, not literal
    // `- ` markers — that's the user-visible regression we're fixing.
    expect(slidesXml).not.toContain("- **Identity baseline**");
    expect(slidesXml).toContain("<a:buChar char=\"•\"/>");
    // Bold runs land as native b="1" — `**` characters gone.
    expect(slidesXml).toContain("b=\"1\"");
    expect(slidesXml).not.toContain("**Identity baseline**");
    // The text content survives.
    expect(slidesXml).toContain("Identity baseline");
  });

  it("renders docx section markdown as native paragraphs (Assessment Report)", async () => {
    const templateBuffer = await readFile(
      path.join(SHELL_DIR, "assessment-report-v1.docx"),
    );
    const binding = bindingDocumentSchema.parse(
      JSON.parse(
        await readFile(
          path.join(SHELL_DIR, "assessment-report-v1.binding.json"),
          "utf8",
        ),
      ),
    );

    const result = await fillTemplate({
      templateBuffer,
      templateMimeType: DOCX_MIME,
      binding,
      outputs: baseOutputs({
        section: {
          executive_summary: "Top-level summary paragraph.",
          engagement_context: "Context paragraph.",
          current_state: "Current state.",
          key_findings:
            "- **Auth posture** weak across the admin tier\n- **No observability** on the critical payment path",
          risks: "Risk narrative.",
          recommendations: "Recommendations narrative.",
          target_state: "Target state.",
          team_and_estimate: "Team narrative.",
        },
      }),
    });
    expect(result.warnings).toEqual([]);

    const docXml = await readZipText(
      result.buffer,
      (n) => n === "word/document.xml",
    );

    // No literal markdown leftover where the bulleted-section landed.
    expect(docXml).not.toContain("- **Auth posture**");
    expect(docXml).not.toContain("**Auth posture**");
    // Bold runs land as native <w:b/>.
    expect(docXml).toContain("<w:b/>");
    expect(docXml).toContain("Auth posture");
    // Bullet character prefix is present on the rendered list items.
    expect(docXml).toContain("•");
  });

  it("renders xlsx markdown as RichText runs (Risk Register Cover overview)", async () => {
    const templateBuffer = await readFile(
      path.join(SHELL_DIR, "risk-register-v1.xlsx"),
    );
    const binding = bindingDocumentSchema.parse(
      JSON.parse(
        await readFile(
          path.join(SHELL_DIR, "risk-register-v1.binding.json"),
          "utf8",
        ),
      ),
    );

    const result = await fillTemplate({
      templateBuffer,
      templateMimeType: XLSX_MIME,
      binding,
      outputs: baseOutputs({
        section: {
          risk_overview:
            "Five risks identified. Two **HIGH** severity centre on auth + rollback maturity.\n\n- Identity & access\n- Operational readiness",
        },
      }),
    });
    expect(result.warnings).toEqual([]);

    // Round-trip the filled xlsx and inspect Cover!A15 — the cell
    // bound to `section.risk_overview`.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.buffer as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Cover");
    expect(sheet).toBeDefined();
    const cell = sheet!.getCell("A15");
    // RichText cell value shape — `{ richText: [...] }` — confirms we
    // took the markdown path. A plain string would mean v1 behaviour.
    expect(typeof cell.value).toBe("object");
    const rich = cell.value as { richText?: Array<{ text?: string; font?: { bold?: boolean } }> };
    expect(Array.isArray(rich.richText)).toBe(true);

    const joined = rich.richText!.map((r) => r.text ?? "").join("");
    // `**HIGH**` characters gone from the rendered text.
    expect(joined).not.toContain("**HIGH**");
    expect(joined).toContain("HIGH");
    // Bullet prefixes present, leading `- ` markers removed.
    expect(joined).toContain("• Identity & access");
    expect(joined).not.toContain("- Identity & access");

    // At least one run is bold (the **HIGH** text).
    expect(rich.richText!.some((r) => r.font?.bold === true)).toBe(true);

    // Cell wrap is on so multi-line content displays.
    expect(cell.alignment?.wrapText).toBe(true);
  });

  it("falls back to inline string replace + stripped markdown when token is mid-sentence", async () => {
    // Synthesize a docx-shaped XML snippet that embeds a token mid-
    // paragraph. The filler shouldn't splice paragraphs in that case
    // — it should strip the markdown chars from the value instead.
    // Use a tiny throwaway template constructed in-memory so we
    // don't have to ship a fixture file.
    const yazl = await import("yazl");
    const zip = new yazl.ZipFile();
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t xml:space="preserve">Before {{section_inline}} after.</w:t></w:r></w:p>
  </w:body>
</w:document>`;
    zip.addBuffer(Buffer.from(doc, "utf8"), "word/document.xml");
    zip.end();
    const templateBuffer: Buffer = await new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      zip.outputStream.on("data", (c) => parts.push(c as Buffer));
      zip.outputStream.on("end", () => resolve(Buffer.concat(parts)));
      zip.outputStream.on("error", reject);
    });

    const result = await fillTemplate({
      templateBuffer,
      templateMimeType: DOCX_MIME,
      binding: {
        version: 1,
        templateKind: "DELIVERABLE_REPORT",
        entries: [
          {
            field: "section.inline",
            target: {
              kind: "docx.placeholder",
              token: "{{section_inline}}",
            },
            format: "auto",
          },
        ],
      },
      outputs: baseOutputs({
        section: {
          inline: "the **important** word",
        },
      }),
    });
    expect(result.warnings).toEqual([]);
    const docXml = await readZipText(
      result.buffer,
      (n) => n === "word/document.xml",
    );
    // Token gone, asterisks stripped, surrounding text preserved.
    expect(docXml).toContain("Before the important word after.");
    expect(docXml).not.toContain("**important**");
    expect(docXml).not.toContain("{{section_inline}}");
  });
});
