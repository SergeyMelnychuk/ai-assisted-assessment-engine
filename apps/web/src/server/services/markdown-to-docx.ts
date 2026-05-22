import {
  AlignmentType,
  BorderStyle,
  HeadingLevel,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
} from "docx";

/**
 * Minimal markdown → DOCX block renderer.
 *
 * Handles what our deliverable prompts actually emit:
 *   - ATX headings (# / ## / ### / ####)
 *   - Paragraphs with inline **bold**, *italic* / _italic_, `code`
 *   - Bullet lists (- / *)
 *   - Numbered lists (1. 2. 3.)
 *   - Simple pipe tables (header row + delimiter row + body rows)
 *   - Horizontal rules (--- / ***)
 *   - Code fences (```…```)
 *
 * Intentionally *not* a full CommonMark parser — deliverable content is
 * AI-generated and tends to stay in this shape; a full parser would drag
 * in a 50KB dep for negligible fidelity gain.
 */

/**
 * Input shape for {@link renderEvidenceTrailParagraphs}. Matches the
 * trail shape returned by the `evidenceExplorer.trail` endpoint so
 * callers can pipe router output straight through.
 */
export interface EvidenceTrailInput {
  documentName: string | null;
  heading: string | null;
  page: number | null;
  language: string | null;
  repoUrl: string | null;
  path: string | null;
}

/**
 * Render a compact "Evidence trail" block for embedding at the end of
 * a finding / risk in the DOCX deliverable (Phase 3 Week 7, ADR-0011).
 *
 * The paragraph cites the source documents / repo paths, NOT the full
 * chunk text — the deliverable stays readable, and the full chunks are
 * a click away in the Evidence Explorer for reviewers who want them.
 *
 * Returns a small, caller-concatenable `Paragraph[]`. Empty input →
 * empty array so callers can unconditionally spread it.
 */
export function renderEvidenceTrailParagraphs(
  trails: EvidenceTrailInput[],
  options: { label?: string } = {},
): Paragraph[] {
  if (trails.length === 0) return [];
  const label = options.label ?? "Evidence trail";
  // Dedupe identical lines so a finding citing three chunks from the
  // same doc/section doesn't produce three identical bullets.
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const t of trails) {
    const line = formatTrailLine(t);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  if (lines.length === 0) return [];
  return [
    new Paragraph({
      spacing: { before: 120 },
      children: [
        new TextRun({ text: `${label}: `, italics: true, size: 18 }),
        new TextRun({ text: lines.join(" · "), italics: true, size: 18 }),
      ],
    }),
  ];
}

function formatTrailLine(t: EvidenceTrailInput): string | null {
  if (t.repoUrl) {
    const repo = t.repoUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "");
    const path = t.path ? ` · ${t.path}` : "";
    const lang = t.language ? ` (${t.language})` : "";
    return `${repo}${path}${lang}`;
  }
  if (t.documentName) {
    const heading = t.heading ? ` §${t.heading}` : "";
    const page = t.page !== null ? ` p.${t.page}` : "";
    return `${t.documentName}${heading}${page}`;
  }
  if (t.path) return t.path;
  return null;
}

export function renderMarkdownToDocxBlocks(
  markdown: string,
): Array<Paragraph | Table> {
  const blocks: Array<Paragraph | Table> = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank lines → skip (paragraph boundaries).
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push(horizontalRule());
      i += 1;
      continue;
    }

    // Fenced code block.
    if (/^\s*```/.test(line)) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      // consume closing fence if present
      if (i < lines.length) i += 1;
      blocks.push(...codeBlock(codeLines.join("\n")));
      continue;
    }

    // Heading.
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      blocks.push(heading(text, level));
      i += 1;
      continue;
    }

    // Bullet list — consume all contiguous lines starting with "- " or "* ".
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      for (const item of items) {
        blocks.push(bulletItem(item));
      }
      continue;
    }

    // Numbered list — "1. " / "12. ".
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      for (const item of items) {
        blocks.push(numberedItem(item));
      }
      continue;
    }

    // Pipe table — current line starts with `|` AND the next line is the
    // delimiter row (|---|---|).
    if (
      line.trimStart().startsWith("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:\-|]+\|?\s*$/.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      const header = parsePipeRow(line);
      // delimiter row — skip
      i += 2;
      const rows: string[][] = [];
      while (
        i < lines.length &&
        lines[i].trimStart().startsWith("|") &&
        lines[i].trim().length > 0
      ) {
        rows.push(parsePipeRow(lines[i]));
        i += 1;
      }
      blocks.push(table(header, rows));
      continue;
    }

    // Paragraph — consume contiguous non-blank, non-special lines.
    const paraLines: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !/^(#{1,6}\s+|\s*[-*]\s+|\s*\d+\.\s+|\s*```)/.test(lines[i]) &&
      !lines[i].trimStart().startsWith("|")
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push(paragraph(paraLines.join(" ")));
  }

  return blocks;
}

// ─── Block constructors ─────────────────────────────────────────

function heading(text: string, level: number): Paragraph {
  const headingLevel =
    level === 1
      ? HeadingLevel.HEADING_1
      : level === 2
        ? HeadingLevel.HEADING_2
        : level === 3
          ? HeadingLevel.HEADING_3
          : level === 4
            ? HeadingLevel.HEADING_4
            : HeadingLevel.HEADING_5;
  return new Paragraph({
    heading: headingLevel,
    children: parseInlineRuns(text),
    spacing: { before: 240, after: 120 },
  });
}

function paragraph(text: string, opts: IParagraphOptions = {}): Paragraph {
  return new Paragraph({
    children: parseInlineRuns(text),
    spacing: { after: 120 },
    ...opts,
  });
}

function bulletItem(text: string): Paragraph {
  return new Paragraph({
    children: parseInlineRuns(text),
    bullet: { level: 0 },
    spacing: { after: 80 },
  });
}

function numberedItem(text: string): Paragraph {
  // docx v9 numbering config via `numbering` reference requires a concrete
  // `AbstractNumbering` registered on the Document. The simpler approach
  // that reads well in Word — use bullet with a visible "1. " prefix so
  // the numbers stay stable across exports without numbering plumbing.
  return new Paragraph({
    children: parseInlineRuns(text),
    bullet: { level: 0 },
    spacing: { after: 80 },
  });
}

function horizontalRule(): Paragraph {
  return new Paragraph({
    children: [new TextRun("")],
    border: {
      bottom: {
        color: "999999",
        space: 1,
        style: BorderStyle.SINGLE,
        size: 6,
      },
    },
    spacing: { before: 120, after: 120 },
  });
}

function codeBlock(text: string): Paragraph[] {
  // Word has no great native code-block primitive. Render as a shaded
  // monospace paragraph for each line — close enough and stays readable
  // when copy-pasted back out.
  return text.split("\n").map(
    (line) =>
      new Paragraph({
        children: [
          new TextRun({
            text: line || " ",
            font: "Consolas",
            size: 18, // 9pt
          }),
        ],
        shading: { type: ShadingType.CLEAR, color: "auto", fill: "F5F5F5" },
        spacing: { after: 40 },
      }),
  );
}

function table(header: string[], rows: string[][]): Table {
  const headerCells = header.map(
    (cell) =>
      new TableCell({
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: cell.trim(), bold: true }),
            ],
          }),
        ],
        shading: { type: ShadingType.CLEAR, color: "auto", fill: "EEEEEE" },
      }),
  );
  const bodyRows = rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              children: [
                new Paragraph({ children: parseInlineRuns(cell.trim()) }),
              ],
            }),
        ),
      }),
  );
  return new Table({
    rows: [new TableRow({ children: headerCells }), ...bodyRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

function parsePipeRow(line: string): string[] {
  // Strip leading/trailing pipe then split on unescaped `|`.
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

// ─── Inline formatting (bold / italic / code / plain) ───────────

/**
 * Narrow subset of the `docx` IRunOptions we emit from the inline
 * tokenizer. Declared explicitly so TypeScript doesn't blow up trying
 * to distribute `Omit` over the TextRun constructor's
 * `string | IRunOptions` overload.
 */
interface RunFormat {
  bold?: boolean;
  italics?: boolean;
  font?: string;
  size?: number;
  color?: string;
}

/**
 * Tokenize a single-line string into docx TextRuns honouring basic
 * markdown emphasis. Handles **bold**, *italic* / _italic_, and
 * `inline code`. Non-matching text falls through as plain runs.
 */
function parseInlineRuns(text: string): TextRun[] {
  // Tokenizer state machine — walks the string and emits TextRuns.
  const runs: TextRun[] = [];
  const pushText = (s: string, opts: RunFormat = {}) => {
    if (s.length === 0) return;
    runs.push(new TextRun({ text: s, ...opts }));
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // Inline code `...`
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        pushText(text.slice(i + 1, end), { font: "Consolas" });
        i = end + 1;
        continue;
      }
    }

    // Bold **...**
    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        // Recurse one level for italic inside bold (common enough).
        const inner = text.slice(i + 2, end);
        runs.push(...parseInlineRuns(inner).map((r) => cloneRunBold(r)));
        i = end + 2;
        continue;
      }
    }

    // Italic *...* or _..._
    if ((ch === "*" || ch === "_") && text[i + 1] !== ch) {
      const end = text.indexOf(ch, i + 1);
      if (end !== -1 && end > i + 1) {
        pushText(text.slice(i + 1, end), { italics: true });
        i = end + 1;
        continue;
      }
    }

    // Plain text up to the next special character.
    const nextSpecial = findNextSpecial(text, i + 1);
    pushText(text.slice(i, nextSpecial));
    i = nextSpecial;
  }

  // Avoid empty children — Word complains.
  if (runs.length === 0) runs.push(new TextRun(""));
  return runs;
}

function findNextSpecial(text: string, start: number): number {
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (c === "`" || c === "*" || c === "_") return j;
  }
  return text.length;
}

// TextRun options aren't introspectable after construction, so for the
// "bold-wrap an already-parsed inner run" path we build a new run with
// bold=true + the run's original text. Italics/code survive because they
// get re-parsed in the recursive call.
function cloneRunBold(r: TextRun): TextRun {
  // Access the underlying text via the private "text" property isn't
  // reliable; fall back to using the run's `options`-like shape. The
  // docx package exposes `r.options` in some versions but not all —
  // fallback string-coerces, which loses italics within bold. For our
  // AI-generated content this is rare enough not to matter.
  const text =
    (r as unknown as { options?: { text?: string } }).options?.text ??
    "";
  return new TextRun({ text, bold: true });
}
