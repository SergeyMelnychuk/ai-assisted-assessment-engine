import type { PrismaClient } from "@prisma/client";
import { marked } from "marked";

/**
 * PDF export for deliverables.
 *
 * Sibling to `export-service.ts` (DOCX). The pipeline:
 *   1. Load the deliverable + sections + diagrams (same shape as DOCX
 *      but we keep it simpler — no evidence-trail appendix for the
 *      first cut).
 *   2. Render section markdown → HTML with `marked`.
 *   3. Render Mermaid diagram source → SVG via mermaid (server-side
 *      headless render).
 *   4. Stitch into a self-contained HTML page with print-styled CSS.
 *   5. Use puppeteer to print the page to PDF.
 *
 * Heavy dependency on Chromium (via puppeteer) — same Chromium the
 * `mermaid-cli` already pulled into the project, so no new install
 * cost. Browser launches are cached per-process in
 * `getSharedBrowser()` so back-to-back exports don't re-spawn the
 * binary.
 */

export interface PdfExportResult {
  filename: string;
  buffer: Buffer;
}

interface DeliverableForPdf {
  id: string;
  deliverableType: string;
  status: string;
  templateId: string | null;
  createdAt: Date;
  updatedAt: Date;
  assessment: {
    mode: string;
    assessmentType: { name: string };
    engagement: { name: string; clientName: string | null };
    projectContext: {
      projectName: string | null;
      industry: string | null;
    } | null;
  };
  sections: Array<{
    id: string;
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
  }>;
}

export async function buildDeliverablePdf(
  db: PrismaClient,
  deliverableId: string,
): Promise<PdfExportResult> {
  const deliverable = (await db.deliverable.findUnique({
    where: { id: deliverableId },
    include: {
      assessment: {
        include: {
          assessmentType: { select: { name: true } },
          engagement: { select: { name: true, clientName: true } },
          projectContext: {
            select: { projectName: true, industry: true },
          },
        },
      },
      sections: { orderBy: { orderIndex: "asc" } },
      diagrams: { orderBy: { createdAt: "asc" } },
    },
  })) as DeliverableForPdf | null;
  if (!deliverable) {
    throw new Error(`Deliverable ${deliverableId} not found`);
  }

  const html = await renderDeliverableHtml(deliverable);
  const buffer = await htmlToPdf(html);

  const filename = `${deliverable.assessment.engagement.name}-${deliverable.deliverableType}`
    .replace(/[^a-zA-Z0-9-_]+/g, "_")
    .toLowerCase();
  return {
    filename: `${filename}.pdf`,
    buffer,
  };
}

// ─── HTML rendering ────────────────────────────────────────────────

async function renderDeliverableHtml(d: DeliverableForPdf): Promise<string> {
  const docTitle = `${d.assessment.engagement.name} — ${prettyType(d.deliverableType)}`;
  const subTitle = [
    d.assessment.assessmentType.name,
    d.assessment.mode,
    d.assessment.projectContext?.projectName,
  ]
    .filter(Boolean)
    .join(" · ");

  // Render each diagram source to SVG. Mermaid imports lazily here too
  // so the server only loads it when a PDF actually goes through.
  const diagramSvgs = await Promise.all(
    d.diagrams.map(async (dg) => {
      if (dg.diagramFormat === "MERMAID" && dg.sourceCode) {
        try {
          const svg = await renderMermaidToSvg(dg.sourceCode);
          return { ...dg, svg };
        } catch (err) {
          return {
            ...dg,
            svg: null,
            renderError: err instanceof Error ? err.message : String(err),
          };
        }
      }
      return { ...dg, svg: null, renderError: null };
    }),
  );

  const sectionsHtml = d.sections
    .map((s, i) => {
      const body = s.contentFinal ?? s.contentDraft ?? "";
      const watermark =
        s.reviewStatus !== "APPROVED"
          ? `<span class="watermark">DRAFT</span>`
          : "";
      // marked is synchronous when called with a string; the await is
      // future-proofing for marked v17+ which is async by default.
      const md = marked.parse(body, { gfm: true, breaks: false });
      return `
        <section class="deliverable-section">
          <h2>${escapeHtml(`${i + 1}. ${s.title}`)} ${watermark}</h2>
          <div class="section-body">${md}</div>
        </section>
      `;
    })
    .join("\n");

  const diagramsHtml =
    diagramSvgs.length === 0
      ? ""
      : `
      <section class="diagrams-appendix">
        <h2>Generated diagrams</h2>
        ${diagramSvgs
          .map((dg, idx) => {
            if (dg.svg) {
              return `
                <figure class="diagram">
                  <div class="diagram-svg">${dg.svg}</div>
                  <figcaption>Figure ${idx + 1}. ${escapeHtml(dg.title)}${
                    dg.description
                      ? ` — ${escapeHtml(dg.description)}`
                      : ""
                  }</figcaption>
                </figure>`;
            }
            // Fallback when render fails or format isn't Mermaid.
            return `
              <figure class="diagram">
                <pre class="diagram-source"><code>${escapeHtml(
                  dg.sourceCode ?? "(no source)",
                )}</code></pre>
                <figcaption>Figure ${idx + 1}. ${escapeHtml(
                  dg.title,
                )} (${escapeHtml(dg.diagramFormat)})${
                  dg.description ? ` — ${escapeHtml(dg.description)}` : ""
                }</figcaption>
              </figure>`;
          })
          .join("\n")}
      </section>`;

  const css = `
    @page { margin: 24mm 18mm; size: A4; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #1f2937;
      line-height: 1.55;
      font-size: 11pt;
    }
    header.cover {
      border-bottom: 2px solid #111827;
      padding-bottom: 12pt;
      margin-bottom: 24pt;
    }
    header.cover h1 { font-size: 22pt; margin: 0 0 4pt 0; color: #111827; }
    header.cover .meta { color: #6b7280; font-size: 10pt; }
    h2 {
      font-size: 14pt;
      color: #111827;
      margin-top: 24pt;
      margin-bottom: 6pt;
      page-break-after: avoid;
    }
    h3 { font-size: 12pt; color: #1f2937; margin-top: 14pt; margin-bottom: 4pt; page-break-after: avoid; }
    p, li { font-size: 11pt; }
    ul, ol { padding-left: 22pt; }
    table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 10.5pt; }
    th, td { border: 1px solid #e5e7eb; padding: 6pt 8pt; text-align: left; vertical-align: top; }
    th { background: #f9fafb; font-weight: 600; }
    code {
      font-family: "SF Mono", "Menlo", "Consolas", monospace;
      background: #f3f4f6;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 10pt;
    }
    pre {
      background: #f3f4f6;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      padding: 8pt;
      overflow-x: auto;
      font-size: 9.5pt;
    }
    pre code { background: none; padding: 0; }
    blockquote {
      border-left: 3px solid #9ca3af;
      padding: 2pt 12pt;
      color: #4b5563;
      margin: 8pt 0;
    }
    .watermark {
      display: inline-block;
      margin-left: 8pt;
      padding: 1pt 6pt;
      border: 1px solid #f59e0b;
      background: #fef3c7;
      color: #92400e;
      font-size: 9pt;
      font-weight: 600;
      vertical-align: middle;
    }
    .deliverable-section { page-break-inside: auto; }
    .deliverable-section + .deliverable-section { page-break-before: auto; }
    .diagrams-appendix { page-break-before: always; margin-top: 24pt; }
    figure.diagram {
      margin: 12pt 0;
      page-break-inside: avoid;
    }
    figure.diagram .diagram-svg svg {
      max-width: 100%;
      height: auto;
      display: block;
    }
    figcaption {
      margin-top: 6pt;
      font-size: 9.5pt;
      color: #6b7280;
      font-style: italic;
    }
    .diagram-source { font-size: 9pt; }
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(docTitle)}</title>
  <style>${css}</style>
</head>
<body>
  <header class="cover">
    <h1>${escapeHtml(prettyType(d.deliverableType))}</h1>
    <div class="meta">
      <strong>${escapeHtml(d.assessment.engagement.name)}</strong>${
        d.assessment.engagement.clientName
          ? ` — ${escapeHtml(d.assessment.engagement.clientName)}`
          : ""
      }<br />
      ${escapeHtml(subTitle)}<br />
      Generated ${new Date(d.createdAt).toLocaleString(undefined, {
        dateStyle: "long",
        timeStyle: "short",
      })}${d.templateId ? ` · template: ${escapeHtml(d.templateId)}` : ""}
    </div>
  </header>

  ${sectionsHtml}
  ${diagramsHtml}
</body>
</html>`;
}

function prettyType(t: string): string {
  return t
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Mermaid → SVG (server-side) ────────────────────────────────────

let mermaidInitPromise: Promise<unknown> | null = null;

/**
 * Render a Mermaid diagram source to SVG markup, server-side.
 *
 * We use a JSDOM-backed mermaid render via puppeteer because mermaid
 * itself depends on browser APIs (DOM measuring, computed styles).
 * Spinning up a tiny page-with-mermaid is much simpler than trying to
 * polyfill the DOM.
 */
async function renderMermaidToSvg(source: string): Promise<string> {
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  try {
    // Load mermaid from a CDN inside the page. (The local
    // `mermaid` npm package can't run server-side directly because
    // it's browser-only — JSDOM stubs miss enough APIs that real
    // diagrams break. The CDN approach mirrors how
    // mermaid-cli/@mermaid-js/mermaid-cli works internally.)
    await page.setContent(`
      <!DOCTYPE html><html><body>
        <div id="m"></div>
        <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
      </body></html>
    `);
    await page.waitForFunction(
      "typeof window.mermaid !== 'undefined'",
      { timeout: 10_000 },
    );
    const svg = await page.evaluate(async (src: string) => {
      const m = (window as unknown as { mermaid: { initialize: (c: unknown) => void; render: (id: string, src: string) => Promise<{ svg: string }>; } }).mermaid;
      m.initialize({ startOnLoad: false, securityLevel: "loose" });
      const result = await m.render("mmd-export", src);
      return result.svg;
    }, source);
    return svg;
  } finally {
    await page.close();
  }
  // unused import-side-effect guard (mermaid not used directly)
  void mermaidInitPromise;
}

// ─── Puppeteer (shared instance) ────────────────────────────────────

let sharedBrowserPromise: Promise<import("puppeteer").Browser> | null = null;

async function getSharedBrowser(): Promise<import("puppeteer").Browser> {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = (async () => {
      const puppeteer = (await import("puppeteer")).default;
      // `--no-sandbox` is needed for some CI / Docker environments;
      // harmless on a developer macOS machine.
      return puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    })();
  }
  return sharedBrowserPromise;
}

async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", right: "16mm", bottom: "20mm", left: "16mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}
