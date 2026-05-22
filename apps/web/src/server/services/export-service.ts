import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TextRun,
} from "docx";
import type { PrismaClient } from "@prisma/client";
import { getObjectBuffer } from "@/server/storage/minio";
import {
  renderMarkdownToDocxBlocks,
  renderEvidenceTrailParagraphs,
  type EvidenceTrailInput,
} from "./markdown-to-docx";

/**
 * Build a DOCX buffer for a deliverable. The output structure:
 *
 *   - Cover page: title + assessment context + date
 *   - TOC-shaped list of sections (plain, not a live TOC field)
 *   - Each section renders its contentFinal (or contentDraft) through
 *     the markdown→docx renderer.
 *   - Generated diagrams appear in a dedicated appendix at the end so
 *     the section narrative stays uninterrupted; any referenced diagram
 *     is also called out in the section text by title.
 *   - Uploaded image diagrams are embedded inline as PNG/JPEG; text
 *     diagrams (Mermaid / PlantUML / Structurizr) are embedded as
 *     monospace code blocks with a caption plus a "render on mermaid.live"
 *     note — server-side rendering is deferred (needs Chromium).
 *
 * Non-APPROVED sections get a visible "DRAFT" watermark paragraph before
 * the content so reviewers of the exported doc know which parts haven't
 * been signed off yet.
 */

interface DeliverableWithChildren {
  id: string;
  deliverableType: string;
  status: string;
  templateId: string | null;
  createdAt: Date;
  assessment: {
    id: string;
    mode: string;
    assessmentType: { name: string };
    engagement: { id: string; name: string; clientName: string };
    projectContext: {
      projectName: string | null;
      industry: string | null;
      description: string | null;
    } | null;
  };
  sections: Array<{
    id: string;
    sectionKey: string;
    title: string;
    orderIndex: number;
    contentDraft: string | null;
    contentFinal: string | null;
    reviewStatus: string;
  }>;
  diagrams: Array<{
    id: string;
    title: string;
    description: string | null;
    diagramFormat: string;
    sourceCode: string | null;
    imageStoragePath: string | null;
  }>;
  /**
   * Week 7 (ADR-0011). Per-finding / per-risk evidence trails for the
   * DOCX appendix. Empty array ⇒ no appendix rendered. Populated by
   * {@link buildDeliverableDocx}; tests can seed it directly.
   */
  evidenceTrails?: Array<{
    kind: "finding" | "risk";
    title: string;
    trails: EvidenceTrailInput[];
  }>;
}

export interface ExportResult {
  filename: string;
  buffer: Buffer;
}

/**
 * Load the deliverable with everything we need to render, then hand off
 * to the builder. Pulled apart from the builder so unit tests can seed
 * fixture data without touching the DB.
 */
export async function buildDeliverableDocx(
  db: PrismaClient,
  deliverableId: string,
): Promise<ExportResult> {
  const deliverable = await db.deliverable.findUnique({
    where: { id: deliverableId },
    include: {
      assessment: {
        include: {
          assessmentType: { select: { name: true } },
          engagement: { select: { id: true, name: true, clientName: true } },
          projectContext: {
            select: { projectName: true, industry: true, description: true },
          },
        },
      },
      sections: { orderBy: { orderIndex: "asc" } },
      diagrams: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!deliverable) {
    throw new Error(`Deliverable ${deliverableId} not found`);
  }

  // Week 7 (ADR-0011). Load the finding + risk trails once so the
  // DOCX appendix can cite source docs under each. We only pull the
  // bits the trail renderer needs — no chunk text, no embedding. The
  // evidence rows are keyed back through `evidenceIds` (model cited)
  // and `retrievedEvidenceIds` (full retriever set); the DOCX appendix
  // shows the cited set to keep the deliverable focused, but the
  // retrieved set is still one click away in the Evidence Explorer.
  const assessmentId = deliverable.assessmentId;
  const [findings, risks] = await Promise.all([
    db.finding.findMany({
      where: { assessmentId },
      select: { id: true, title: true, evidenceIds: true },
      orderBy: [{ severity: "asc" }, { domain: "asc" }],
    }),
    db.risk.findMany({
      where: { assessmentId },
      select: { id: true, title: true, evidenceIds: true },
      orderBy: [{ severity: "asc" }, { category: "asc" }],
    }),
  ]);
  const allIds = Array.from(
    new Set([
      ...findings.flatMap((f) => f.evidenceIds),
      ...risks.flatMap((r) => r.evidenceIds),
    ]),
  );
  const trailRows = allIds.length
    ? await db.evidence.findMany({
        where: { id: { in: allIds } },
        select: {
          id: true,
          chunkSource: true,
          document: { select: { filename: true } },
        },
      })
    : [];
  const trailById = new Map<string, EvidenceTrailInput>();
  for (const r of trailRows) {
    const src = (r.chunkSource ?? {}) as Record<string, unknown>;
    trailById.set(r.id, {
      documentName: r.document?.filename ?? null,
      heading: typeof src.heading === "string" ? src.heading : null,
      page: typeof src.page === "number" ? src.page : null,
      language: typeof src.language === "string" ? src.language : null,
      repoUrl: typeof src.repoUrl === "string" ? src.repoUrl : null,
      path: typeof src.path === "string" ? src.path : null,
    });
  }
  const evidenceTrails = [
    ...findings.map((f) => ({
      kind: "finding" as const,
      title: f.title,
      trails: f.evidenceIds
        .map((id) => trailById.get(id))
        .filter((t): t is EvidenceTrailInput => t !== undefined),
    })),
    ...risks.map((r) => ({
      kind: "risk" as const,
      title: r.title,
      trails: r.evidenceIds
        .map((id) => trailById.get(id))
        .filter((t): t is EvidenceTrailInput => t !== undefined),
    })),
  ].filter((e) => e.trails.length > 0);

  const hydrated = {
    ...(deliverable as unknown as DeliverableWithChildren),
    evidenceTrails,
  };
  return buildDocxFromDeliverable(hydrated);
}

/**
 * Pure function version of the builder — takes a fully-loaded
 * deliverable shape and returns the DOCX buffer plus a recommended
 * filename.
 */
export async function buildDocxFromDeliverable(
  deliverable: DeliverableWithChildren,
): Promise<ExportResult> {
  const engagement = deliverable.assessment.engagement;
  const docTitle = prettyType(deliverable.deliverableType);
  const clientName = engagement.clientName || engagement.name;

  // ── Cover + TOC ─────────────────────────────────────────────
  const cover: Array<Paragraph> = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 1600, after: 240 },
      children: [
        new TextRun({ text: docTitle, bold: true, size: 56 }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: clientName, size: 32, color: "444444" }),
      ],
      spacing: { after: 240 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `${deliverable.assessment.assessmentType.name} · ${prettyMode(deliverable.assessment.mode)}`,
          size: 24,
          color: "666666",
        }),
      ],
      spacing: { after: 120 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: formatDate(deliverable.createdAt),
          size: 22,
          color: "888888",
        }),
      ],
      spacing: { after: 480 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `Status: ${deliverable.status.replace(/_/g, " ").toLowerCase()}`,
          size: 20,
          italics: true,
          color: deliverable.status === "APPROVED" ? "1b7a3a" : "aa6500",
        }),
      ],
    }),
    new Paragraph({
      children: [new TextRun(""), new PageBreak()],
    }),
  ];

  // ── Table of contents (flat list — not a live Word TOC field) ──
  const toc: Array<Paragraph> = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: "Contents", bold: true })],
      spacing: { after: 240 },
    }),
    ...deliverable.sections.map(
      (s, idx) =>
        new Paragraph({
          children: [
            new TextRun({
              text: `${idx + 1}. ${s.title}${s.reviewStatus !== "APPROVED" ? "  (draft)" : ""}`,
            }),
          ],
          spacing: { after: 60 },
        }),
    ),
    new Paragraph({ children: [new PageBreak()] }),
  ];

  // ── Sections ────────────────────────────────────────────────
  const sectionBlocks: Array<Paragraph | Table> = [];
  for (const section of deliverable.sections) {
    sectionBlocks.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: section.title })],
        spacing: { before: 480, after: 160 },
      }),
    );
    if (section.reviewStatus !== "APPROVED") {
      sectionBlocks.push(draftWatermark(section.reviewStatus));
    }
    const body = section.contentFinal ?? section.contentDraft ?? "";
    if (body.trim().length === 0) {
      sectionBlocks.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "(no content — section was not drafted)",
              italics: true,
              color: "888888",
            }),
          ],
        }),
      );
    } else {
      sectionBlocks.push(...renderMarkdownToDocxBlocks(body));
    }
  }

  // ── Diagram appendix ────────────────────────────────────────
  const diagramBlocks: Array<Paragraph | Table> = [];
  if (deliverable.diagrams.length > 0) {
    diagramBlocks.push(
      new Paragraph({ children: [new PageBreak()] }),
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "Diagrams" })],
        spacing: { after: 240 },
      }),
    );
    for (const [idx, diagram] of deliverable.diagrams.entries()) {
      diagramBlocks.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [
            new TextRun({
              text: `Figure ${idx + 1}. ${diagram.title}`,
            }),
          ],
          spacing: { before: 240, after: 120 },
        }),
      );
      if (diagram.description) {
        diagramBlocks.push(
          new Paragraph({
            children: [
              new TextRun({
                text: diagram.description,
                italics: true,
                color: "555555",
              }),
            ],
            spacing: { after: 160 },
          }),
        );
      }
      const embedded = await embedDiagram(diagram);
      diagramBlocks.push(...embedded);
    }
  }

  // ── Evidence trail appendix (Week 7, ADR-0011) ──────────────
  // Compact per-finding / per-risk trail paragraph citing source doc
  // names (not full chunk text). Reviewers get provenance in the
  // exported deliverable without bloating the narrative.
  const evidenceAppendix: Array<Paragraph> = [];
  if (deliverable.evidenceTrails && deliverable.evidenceTrails.length > 0) {
    evidenceAppendix.push(
      new Paragraph({ children: [new PageBreak()] }),
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "Evidence trail" })],
        spacing: { after: 240 },
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: "Source documents cited for each finding and risk. The full chunk text and retrieval context is available in the Evidence Explorer.",
            italics: true,
            color: "555555",
          }),
        ],
        spacing: { after: 160 },
      }),
    );
    for (const entry of deliverable.evidenceTrails) {
      evidenceAppendix.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          children: [
            new TextRun({
              text: `${entry.kind === "finding" ? "Finding" : "Risk"}: ${entry.title}`,
            }),
          ],
          spacing: { before: 200, after: 60 },
        }),
        ...renderEvidenceTrailParagraphs(entry.trails, {
          label: "Sources",
        }),
      );
    }
  }

  const doc = new Document({
    creator: "Assessment Co-pilot",
    title: `${docTitle} · ${clientName}`,
    description: `Assessment deliverable for ${clientName}`,
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 }, // 11pt
        },
      },
    },
    sections: [
      {
        properties: {},
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: `${docTitle} · ${clientName}`,
                    size: 18,
                    color: "888888",
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
                  new TextRun({
                    text: "Page ",
                    size: 18,
                    color: "888888",
                  }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    size: 18,
                    color: "888888",
                  }),
                  new TextRun({ text: " of ", size: 18, color: "888888" }),
                  new TextRun({
                    children: [PageNumber.TOTAL_PAGES],
                    size: 18,
                    color: "888888",
                  }),
                ],
              }),
            ],
          }),
        },
        children: [...cover, ...toc, ...sectionBlocks, ...diagramBlocks, ...evidenceAppendix],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = buildFilename(
    clientName,
    docTitle,
    deliverable.createdAt,
  );
  return { filename, buffer };
}

// ─── Helpers ────────────────────────────────────────────────────

function draftWatermark(reviewStatus: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: `⚠ DRAFT — ${reviewStatus.replace(/_/g, " ").toLowerCase()}. Content below has not been approved for publication.`,
        bold: true,
        color: "AA6500",
      }),
    ],
    shading: { type: ShadingType.CLEAR, color: "auto", fill: "FFF4D6" },
    spacing: { before: 120, after: 240 },
  });
}

/**
 * Embed one diagram. For uploaded raster images we pull the S3 object
 * and drop it in as an ImageRun; for text-based diagrams we inline the
 * source code with a caption pointing at mermaid.live for an interactive
 * render. SVG is text-based but not embeddable as an ImageRun — handled
 * as text.
 */
async function embedDiagram(diagram: {
  title: string;
  diagramFormat: string;
  sourceCode: string | null;
  imageStoragePath: string | null;
}): Promise<Array<Paragraph | Table>> {
  const format = diagram.diagramFormat.toUpperCase();

  // Uploaded raster (PNG / JPEG) — ImageRun supports these directly.
  if (
    diagram.imageStoragePath &&
    (format === "PNG" || format === "JPEG")
  ) {
    try {
      const buffer = await getObjectBuffer(diagram.imageStoragePath);
      const imageType = format === "JPEG" ? "jpg" : "png";
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: buffer,
              transformation: { width: 560, height: 360 },
              type: imageType,
            } as ConstructorParameters<typeof ImageRun>[0]),
          ],
          spacing: { after: 240 },
        }),
      ];
    } catch (err) {
      return [
        new Paragraph({
          children: [
            new TextRun({
              text: `(image could not be loaded: ${err instanceof Error ? err.message : String(err)})`,
              italics: true,
              color: "AA0000",
            }),
          ],
        }),
      ];
    }
  }

  // Text-based diagram (Mermaid / PlantUML / Structurizr / SVG) — embed
  // source as monospace block. Reviewers can paste into mermaid.live
  // until we add server-side rendering.
  if (diagram.sourceCode) {
    const paragraphs: Paragraph[] = [
      new Paragraph({
        children: [
          new TextRun({
            text: `${format} source. Preview at mermaid.live / plantuml.com / a Structurizr CLI depending on format.`,
            italics: true,
            color: "666666",
            size: 18,
          }),
        ],
        spacing: { after: 120 },
      }),
    ];
    paragraphs.push(
      ...diagram.sourceCode.split("\n").map(
        (line) =>
          new Paragraph({
            children: [
              new TextRun({
                text: line || " ",
                font: "Consolas",
                size: 18,
              }),
            ],
            shading: {
              type: ShadingType.CLEAR,
              color: "auto",
              fill: "F5F5F5",
            },
          }),
      ),
    );
    return paragraphs;
  }

  return [
    new Paragraph({
      children: [
        new TextRun({
          text: "(diagram has neither source nor image — nothing to embed)",
          italics: true,
          color: "888888",
        }),
      ],
    }),
  ];
}

function prettyType(t: string): string {
  return t
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function prettyMode(m: string): string {
  return m
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function buildFilename(
  clientName: string,
  docTitle: string,
  date: Date,
): string {
  const safeClient = clientName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "deliverable";
  const safeTitle = docTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const iso = date.toISOString().slice(0, 10);
  return `${safeClient}-${safeTitle}-${iso}.docx`;
}
