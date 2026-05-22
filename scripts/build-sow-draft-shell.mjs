/**
 * One-off generator for `packages/knowledge-seed/deliverable-shells/sow-draft-v1.docx`.
 *
 * Produces a Statement of Work (Draft) skeleton with hand-curated
 * legal-team boilerplate. The engine fills the small set of metadata
 * tokens via the sidecar binding (sow-draft-v1.binding.json); the
 * rest of the document is intentionally left for legal review — the
 * AI does not author SOW prose.
 *
 * Run: node scripts/build-sow-draft-shell.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// `docx` is hoisted under apps/web; resolve via createRequire so this
// generator can run from the repo root without symlink gymnastics.
import { createRequire } from "node:module";
const requireFromWeb = createRequire(
  fileURLToPath(new URL("../apps/web/package.json", import.meta.url)),
);
const {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
} = requireFromWeb("docx");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT = path.join(
  REPO_ROOT,
  "packages",
  "knowledge-seed",
  "deliverable-shells",
  "sow-draft-v1.docx",
);

// Helper: a normal paragraph with optional bold prefix.
const para = (text, opts = {}) =>
  new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text, ...opts })],
  });

// Helper: a "key: {{token}}" metadata line.
const meta = (label, token) =>
  new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({ text: `${label}: `, bold: true }),
      new TextRun({ text: token }),
    ],
  });

const heading = (text, level = HeadingLevel.HEADING_1) =>
  new Paragraph({
    heading: level,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, bold: true })],
  });

const bullet = (text) =>
  new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 60 },
    children: [new TextRun({ text })],
  });

const doc = new Document({
  styles: {
    default: {
      document: { run: { font: "Arial", size: 22 } }, // 11pt body
    },
    paragraphStyles: [
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 28, bold: true, font: "Arial" },
        paragraph: {
          spacing: { before: 280, after: 140 },
          outlineLevel: 0,
        },
      },
      {
        id: "Heading2",
        name: "Heading 2",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 24, bold: true, font: "Arial" },
        paragraph: {
          spacing: { before: 200, after: 100 },
          outlineLevel: 1,
        },
      },
    ],
  },
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: "•",
            alignment: AlignmentType.LEFT,
            style: {
              paragraph: { indent: { left: 720, hanging: 360 } },
            },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 }, // US Letter
          margin: {
            top: 1440,
            right: 1440,
            bottom: 1440,
            left: 1440,
          },
        },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [
                new TextRun({
                  text: "Statement of Work (Draft) — {{client_name}}",
                  italics: true,
                  size: 18,
                }),
              ],
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: "Page ", size: 18 }),
                new TextRun({ children: [PageNumber.CURRENT], size: 18 }),
                new TextRun({ text: " — generated ", size: 18 }),
                new TextRun({ text: "{{generated_date}}", size: 18 }),
              ],
            }),
          ],
        }),
      },
      children: [
        // Title block
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 240 },
          children: [
            new TextRun({ text: "STATEMENT OF WORK", bold: true, size: 40 }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 320 },
          children: [
            new TextRun({
              text: "(Draft for legal review)",
              italics: true,
              size: 22,
            }),
          ],
        }),

        // Metadata block — every binding-mapped token in one place so
        // the legal team can see the engine-supplied context up-front.
        heading("Engagement Summary", HeadingLevel.HEADING_1),
        meta("Client", "{{client_name}}"),
        meta("Engagement", "{{engagement_name}}"),
        meta("Project", "{{project_name}}"),
        meta("Industry", "{{project_industry}}"),
        meta("Scenario", "{{scenario_name}}"),
        meta("Expected timeline", "{{project_expected_timeline}}"),
        meta("Document date", "{{generated_date}}"),

        // 1. Parties
        heading("1. Parties", HeadingLevel.HEADING_1),
        para(
          "This Statement of Work (the \"SOW\") is entered into between {{client_name}} (\"Client\") and the service provider identified in the Master Services Agreement (\"Provider\"). This SOW is governed by and incorporated into that Master Services Agreement; capitalised terms not defined here have the meanings given to them there.",
        ),
        para(
          "[Legal team: confirm provider legal entity, address, and signatory details before circulation.]",
          { italics: true },
        ),

        // 2. Project description
        heading("2. Project Description", HeadingLevel.HEADING_1),
        meta("Engagement", "{{engagement_name}}"),
        meta("Project", "{{project_name}}"),
        para(
          "The Provider will deliver the services described below in support of the following project:",
        ),
        para("{{project_description}}"),
        para(
          "[Legal team: confirm wording reflects the commercial intent agreed during discovery.]",
          { italics: true },
        ),

        // 3. Scope
        heading("3. Scope of Services", HeadingLevel.HEADING_1),
        heading("3.1 In Scope", HeadingLevel.HEADING_2),
        para(
          "The services in scope of this SOW will be tracked against the deliverables enumerated in Section 4 and the assumptions set out in Section 7. [Legal team: enumerate the in-scope workstreams agreed at the project kick-off.]",
        ),
        heading("3.2 Out of Scope", HeadingLevel.HEADING_2),
        para(
          "Anything not expressly listed in Section 3.1 is out of scope and will only be undertaken via the change-control procedure in Section 8.",
        ),
        heading("3.3 Exclusions", HeadingLevel.HEADING_2),
        para(
          "[Legal team: list any specific exclusions — e.g. third-party software procurement, on-call support, regulatory filings — agreed with the Client.]",
          { italics: true },
        ),

        // 4. Deliverables
        heading("4. Deliverables", HeadingLevel.HEADING_1),
        para(
          "The Provider will produce and deliver the following items. Acceptance criteria, review windows, and rework allowances are governed by the Master Services Agreement unless varied in writing here.",
        ),
        bullet(
          "Discovery summary and finalised assumptions log (this document, once approved).",
        ),
        bullet(
          "Detailed work-breakdown structure and resource plan (separate workbook).",
        ),
        bullet(
          "[Legal team: list customer-specific deliverables — e.g. architecture report, target-state design, runbook — as agreed.]",
        ),

        // 5. Timeline
        heading("5. Timeline", HeadingLevel.HEADING_1),
        meta("Expected timeline", "{{project_expected_timeline}}"),
        para(
          "Detailed milestone dates and dependencies will be confirmed during the joint planning workshop following SOW signature. Schedule slippage caused by Client-side dependencies will be handled under Section 8 (Change Control).",
        ),

        // 6. Fees
        heading("6. Fees and Payment Terms", HeadingLevel.HEADING_1),
        meta("Effort estimate (low)", "{{effort_hours_low}} hours"),
        meta("Effort estimate (high)", "{{effort_hours_high}} hours"),
        meta("Fees (low)", "{{cost_low}} {{currency}}"),
        meta("Fees (high)", "{{cost_high}} {{currency}}"),
        meta("Estimate confidence", "{{confidence}}"),
        para(
          "The figures above are non-binding good-faith estimates produced from the discovery data captured for this engagement. Final fees will be set out in the Provider's invoices and are payable in {{currency}} on the schedule and net terms agreed in the Master Services Agreement.",
        ),
        para(
          "[Legal team: confirm payment cadence, milestone-based vs. monthly billing, late-payment language, expense reimbursement caps.]",
          { italics: true },
        ),

        // 7. Assumptions
        heading("7. Assumptions", HeadingLevel.HEADING_1),
        para(
          "This SOW is based on the following assumptions, which materially affect the fees and timeline. A material change in any of these triggers Section 8 (Change Control).",
        ),
        para("{{assumptions}}"),
        para(
          "[Legal team: review assumptions for items that should be promoted to client-acknowledged warranties or carved into a separate annex.]",
          { italics: true },
        ),

        // 8. Change control
        heading("8. Change Control", HeadingLevel.HEADING_1),
        para(
          "Any change to scope, schedule, deliverables, fees, or assumptions must be requested in writing and will be assessed for impact by the Provider. Approved changes are recorded in a Change Order signed by both parties; until that point, the Provider continues delivery against the existing SOW.",
        ),
        para(
          "[Legal team: confirm Change-Order template alignment with the Master Services Agreement.]",
          { italics: true },
        ),

        // 9. Confidentiality
        heading("9. Confidentiality", HeadingLevel.HEADING_1),
        para(
          "Each party will protect the other's Confidential Information in accordance with the confidentiality clauses of the Master Services Agreement. Information generated during this SOW relating to the Project (including discovery findings, risk registers, and recommendations) is treated as Client Confidential Information unless agreed otherwise in writing.",
        ),

        // 10. Acceptance & signatures
        heading("10. Acceptance and Signatures", HeadingLevel.HEADING_1),
        para(
          "By signing below, the parties accept the scope, fees, timeline, and assumptions set out in this Statement of Work and confirm that this SOW is incorporated into the Master Services Agreement.",
        ),
        new Paragraph({ spacing: { before: 240, after: 120 }, children: [] }),
        meta("For the Client", "{{client_name}}"),
        para("Name: ____________________________"),
        para("Title: ____________________________"),
        para("Signature: ________________________"),
        para("Date: _____________________________"),
        new Paragraph({ spacing: { before: 240, after: 120 }, children: [] }),
        meta("For the Provider", "[Legal team: provider entity]"),
        para("Name: ____________________________"),
        para("Title: ____________________________"),
        para("Signature: ________________________"),
        para("Date: _____________________________"),
      ],
    },
  ],
});

const rawBuffer = await Packer.toBuffer(doc);

// docx-js emits explicit directory entries (e.g. `word/`) in the zip.
// yazl — used by the docx filler — rejects entries whose name ends in
// `/`. Repack without those directory entries so the filler can pass
// the file through unchanged.
const yauzl = requireFromWeb("yauzl-promise");
const yazl = requireFromWeb("yazl");

const inZip = await yauzl.fromBuffer(rawBuffer);
const outZip = new yazl.ZipFile();
for await (const entry of inZip) {
  if (entry.filename.endsWith("/")) continue;
  const stream = await entry.openReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  outZip.addBuffer(Buffer.concat(chunks), entry.filename);
}
outZip.end();
const buffer = await new Promise((resolve, reject) => {
  const parts = [];
  outZip.outputStream.on("data", (c) => parts.push(c));
  outZip.outputStream.on("end", () => resolve(Buffer.concat(parts)));
  outZip.outputStream.on("error", reject);
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buffer);
console.log(`Wrote ${OUT} (${buffer.length} bytes)`);
