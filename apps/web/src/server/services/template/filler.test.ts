import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import yazl from "yazl";
import yauzl from "yauzl-promise";
import { fillTemplate } from "./filler";
import type { BindingDocument } from "./binding";
import type { EngineOutputs } from "./engine-outputs";

// ─── Fixtures ──────────────────────────────────────────────────────

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
    section: {},
    generated: { date: "2026-05-07", timestamp: "2026-05-07T00:00:00Z" },
    ...overrides,
  };
}

async function buildXlsxFixture(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Cover");
  sheet.getCell("A1").value = "Project";
  sheet.getCell("B1").value = "PLACEHOLDER";
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

async function zipBufferFromEntries(
  entries: Array<{ name: string; content: string }>,
): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const e of entries) {
    zip.addBuffer(Buffer.from(e.content, "utf8"), e.name);
  }
  zip.end();
  return await new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    zip.outputStream.on("data", (c) => parts.push(c as Buffer));
    zip.outputStream.on("end", () => resolve(Buffer.concat(parts)));
    zip.outputStream.on("error", reject);
  });
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

function buildDocxFixture(): Promise<Buffer> {
  const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Project: {{project_name}}</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  return zipBufferFromEntries([
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "word/document.xml", content: documentXml },
  ]);
}

function buildPptxFixture(): Promise<Buffer> {
  const slideXml = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody>
      <a:p><a:r><a:t>Project: {{project_name}}</a:t></a:r></a:p>
    </p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`;
  return zipBufferFromEntries([
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "ppt/slides/slide1.xml", content: slideXml },
  ]);
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("fillTemplate (xlsx)", () => {
  it("writes a value into an xlsx.cell target", async () => {
    const buf = await buildXlsxFixture();
    const binding: BindingDocument = {
      version: 1,
      templateKind: "ESTIMATION",
      entries: [
        {
          field: "project.name",
          target: { kind: "xlsx.cell", sheet: "Cover", cell: "B1" },
        },
      ],
    };
    const result = await fillTemplate({
      templateBuffer: buf,
      templateMimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      binding,
      outputs: baseOutputs(),
    });
    expect(result.filledEntryCount).toBe(1);
    expect(result.warnings).toEqual([]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.buffer as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Cover")!;
    expect(sheet.getCell("B1").value).toBe("Acme Migration");
  });
});

describe("fillTemplate (docx)", () => {
  it("replaces a {{token}} inside word/document.xml", async () => {
    const buf = await buildDocxFixture();
    const binding: BindingDocument = {
      version: 1,
      templateKind: "DELIVERABLE_REPORT",
      entries: [
        {
          field: "project.name",
          target: { kind: "docx.placeholder", token: "{{project_name}}" },
        },
      ],
    };
    const result = await fillTemplate({
      templateBuffer: buf,
      templateMimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      binding,
      outputs: baseOutputs(),
    });
    expect(result.filledEntryCount).toBeGreaterThanOrEqual(1);
    const xml = await readZipEntry(result.buffer, "word/document.xml");
    expect(xml).toBeDefined();
    expect(xml).toContain("Acme Migration");
    expect(xml).not.toContain("{{project_name}}");
  });
});

describe("fillTemplate (pptx)", () => {
  it("replaces a {{token}} inside ppt/slides/slide1.xml", async () => {
    const buf = await buildPptxFixture();
    const binding: BindingDocument = {
      version: 1,
      templateKind: "DELIVERABLE_PRESENTATION",
      entries: [
        {
          field: "project.name",
          target: { kind: "docx.placeholder", token: "{{project_name}}" },
        },
      ],
    };
    const result = await fillTemplate({
      templateBuffer: buf,
      templateMimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      binding,
      outputs: baseOutputs(),
    });
    expect(result.filledEntryCount).toBe(1);
    const xml = await readZipEntry(result.buffer, "ppt/slides/slide1.xml");
    expect(xml).toBeDefined();
    expect(xml).toContain("Acme Migration");
    expect(xml).not.toContain("{{project_name}}");
  });

  it("warns and skips docx.bookmark targets, still applies placeholders", async () => {
    const buf = await buildPptxFixture();
    const binding: BindingDocument = {
      version: 1,
      templateKind: "DELIVERABLE_PRESENTATION",
      entries: [
        {
          field: "project.name",
          target: { kind: "docx.bookmark", name: "ProjectName" },
        },
        {
          field: "project.name",
          target: { kind: "docx.placeholder", token: "{{project_name}}" },
        },
      ],
    };
    const result = await fillTemplate({
      templateBuffer: buf,
      templateMimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      binding,
      outputs: baseOutputs(),
    });
    expect(result.filledEntryCount).toBe(1);
    expect(
      result.warnings.some((w) => w.includes("docx.bookmark")),
    ).toBe(true);
    const xml = await readZipEntry(result.buffer, "ppt/slides/slide1.xml");
    expect(xml).toContain("Acme Migration");
  });
});
