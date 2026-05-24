/**
 * Markdown → OOXML converter.
 *
 * The AI section pass emits markdown bullet lists, bold inline text,
 * and the occasional numbered list. The template filler used to do
 * raw string substitution, which left the literal `**`, `-`, and `1.`
 * characters in the downloaded `.docx` / `.pptx` / `.xlsx` files — see
 * ADR-0029. This module gives the filler a way to detect markdown in
 * a section value and emit native OOXML structures instead.
 *
 * Scope, deliberately narrow:
 *   - Bold (`**text**`)
 *   - Italic (`_text_` / `*text*`)
 *   - Bulleted lists (`- item`, `* item`)
 *   - Numbered lists (`1. item`)
 *   - Paragraph breaks (blank line)
 *
 * Out of scope (handle in a follow-up when first needed):
 *   - Headings (`# Heading`) — our section prompts don't emit them
 *     and the slide/section title already heads the slot.
 *   - Links, images, code blocks, blockquotes, tables.
 *
 * Hand-rolled rather than pulling a markdown library so we avoid
 * adding a new transitive dependency for a tightly-scoped subset
 * we fully control.
 */

import { escapeXml } from "./xml-escape";

// ─── AST ──────────────────────────────────────────────────────────

export type Run =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string };

export type Block =
  | { type: "paragraph"; runs: Run[] }
  | { type: "bulletItem"; runs: Run[] }
  | { type: "numberedItem"; index: number; runs: Run[] };

// ─── Public API ───────────────────────────────────────────────────

/**
 * Does this string contain anything our parser would treat as markdown?
 * Filler call sites use this as a fast gate: when false, they keep the
 * existing string-replace path (cheaper, no XML splicing).
 */
export function containsMarkdownSyntax(s: string): boolean {
  if (!s) return false;
  // Bold or italic with at least one non-marker char between.
  if (/\*\*[^\s*][^*]*\*\*/.test(s)) return true;
  if (/(?:^|[\s(])\*[^\s*][^*]*\*(?:$|[\s).,])/.test(s)) return true;
  if (/(?:^|[\s(])_[^\s_][^_]*_(?:$|[\s).,])/.test(s)) return true;
  // Bullet or numbered list marker at line start.
  if (/(?:^|\n)\s*[-*]\s+\S/.test(s)) return true;
  if (/(?:^|\n)\s*\d+\.\s+\S/.test(s)) return true;
  return false;
}

/**
 * Parse our markdown subset into a flat list of blocks. Lines are
 * grouped into list/paragraph runs; consecutive non-list non-blank
 * lines become a single paragraph (markdown-style — soft line breaks
 * within a paragraph are joined with a space).
 */
export function parseMarkdown(input: string): Block[] {
  const lines = input.split(/\r?\n/);
  const blocks: Block[] = [];
  let paragraphBuffer: string[] = [];

  function flushParagraph(): void {
    if (paragraphBuffer.length === 0) return;
    const text = paragraphBuffer.join(" ");
    blocks.push({ type: "paragraph", runs: parseInlineRuns(text) });
    paragraphBuffer = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }
    const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph();
      blocks.push({
        type: "bulletItem",
        runs: parseInlineRuns(bulletMatch[1]),
      });
      continue;
    }
    const numberedMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (numberedMatch) {
      flushParagraph();
      blocks.push({
        type: "numberedItem",
        index: parseInt(numberedMatch[1], 10),
        runs: parseInlineRuns(numberedMatch[2]),
      });
      continue;
    }
    paragraphBuffer.push(line);
  }
  flushParagraph();

  return blocks;
}

/**
 * Strip markdown syntax characters but preserve the text content.
 * Used by the filler when a placeholder is mid-sentence (inline) —
 * we can't splice paragraphs there, but we can at least keep the
 * literal `**` / `_` characters out of the output.
 */
export function stripMarkdownSyntax(input: string): string {
  return input
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?:^|(?<=\s|\())\*([^*\s][^*]*)\*(?=$|\s|[.,)])/g, "$1")
    .replace(/(?:^|(?<=\s|\())_([^_\s][^_]*)_(?=$|\s|[.,)])/g, "$1")
    .replace(/(?:^|\n)\s*[-*]\s+/g, (m) => (m.startsWith("\n") ? "\n• " : "• "))
    .replace(/(?:^|\n)\s*(\d+)\.\s+/g, (m, num) =>
      m.startsWith("\n") ? `\n${num}. ` : `${num}. `,
    );
}

// ─── Inline parser ────────────────────────────────────────────────

/**
 * Parse a single line into runs. Handles `**bold**`, `*italic*`,
 * `_italic_`. Nested formatting is NOT supported (`**_both_**` would
 * render as bold-only with the underscores stripped) — our prompts
 * don't generate it and supporting it doubles the parser complexity.
 */
function parseInlineRuns(text: string): Run[] {
  const runs: Run[] = [];
  let i = 0;
  let plainStart = 0;

  function pushPlain(end: number): void {
    if (end > plainStart) {
      runs.push({ kind: "text", text: text.slice(plainStart, end) });
    }
  }

  while (i < text.length) {
    // Bold: **text**
    if (
      text[i] === "*" &&
      text[i + 1] === "*" &&
      i + 2 < text.length &&
      text[i + 2] !== "*"
    ) {
      const closeIdx = text.indexOf("**", i + 2);
      if (closeIdx > i + 2 && text[closeIdx - 1] !== " ") {
        pushPlain(i);
        runs.push({ kind: "bold", text: text.slice(i + 2, closeIdx) });
        i = closeIdx + 2;
        plainStart = i;
        continue;
      }
    }
    // Italic: *text* or _text_ (single delimiter, not part of bold).
    if (
      (text[i] === "*" || text[i] === "_") &&
      text[i + 1] !== text[i] && // not ** or __
      (i === 0 ||
        text[i - 1] === " " ||
        text[i - 1] === "(" ||
        text[i - 1] === "\n") &&
      i + 1 < text.length &&
      text[i + 1] !== " "
    ) {
      const marker = text[i];
      const closeIdx = text.indexOf(marker, i + 1);
      if (
        closeIdx > i + 1 &&
        text[closeIdx - 1] !== " " &&
        (closeIdx === text.length - 1 ||
          /[\s.,)]/.test(text[closeIdx + 1] ?? ""))
      ) {
        pushPlain(i);
        runs.push({ kind: "italic", text: text.slice(i + 1, closeIdx) });
        i = closeIdx + 1;
        plainStart = i;
        continue;
      }
    }
    i++;
  }
  pushPlain(text.length);
  return runs;
}

// ─── docx renderer ────────────────────────────────────────────────

/**
 * Render an AST to a sequence of `<w:p>` paragraph elements. The
 * caller is responsible for splicing these into the document.xml in
 * place of the original placeholder paragraph.
 *
 * `paragraphPropsXml` is the original `<w:pPr>` content from the
 * paragraph the placeholder sat in — preserved so font, alignment
 * etc. carry over to all the generated paragraphs (otherwise rich
 * sections look out-of-style next to the surrounding doc).
 */
export function renderBlocksToDocx(
  blocks: Block[],
  paragraphPropsXml: string,
): string {
  const W = "w:";
  return blocks
    .map((b) => renderDocxBlock(b, paragraphPropsXml, W))
    .join("");
}

function renderDocxBlock(
  block: Block,
  pPrInner: string,
  prefix: string,
): string {
  if (block.type === "paragraph") {
    return `<${prefix}p>${wrapPPr(pPrInner, prefix)}${block.runs
      .map((r) => renderDocxRun(r, prefix))
      .join("")}</${prefix}p>`;
  }
  // Lists: we don't rely on `<w:numPr>` because the bullets would need
  // a matching definition in `word/numbering.xml`, which varies per
  // template. A literal `•` (or `1. `) prefix is more portable and
  // visually identical for our use case.
  const marker =
    block.type === "bulletItem" ? "• " : `${block.index}. `;
  const runs = [
    { kind: "text" as const, text: marker },
    ...block.runs,
  ];
  return `<${prefix}p>${wrapPPr(pPrInner, prefix)}${runs
    .map((r) => renderDocxRun(r, prefix))
    .join("")}</${prefix}p>`;
}

function wrapPPr(inner: string, prefix: string): string {
  if (!inner) return "";
  return `<${prefix}pPr>${inner}</${prefix}pPr>`;
}

function renderDocxRun(run: Run, prefix: string): string {
  const text = escapeXml(run.text);
  if (run.kind === "bold") {
    return `<${prefix}r><${prefix}rPr><${prefix}b/></${prefix}rPr><${prefix}t xml:space="preserve">${text}</${prefix}t></${prefix}r>`;
  }
  if (run.kind === "italic") {
    return `<${prefix}r><${prefix}rPr><${prefix}i/></${prefix}rPr><${prefix}t xml:space="preserve">${text}</${prefix}t></${prefix}r>`;
  }
  return `<${prefix}r><${prefix}t xml:space="preserve">${text}</${prefix}t></${prefix}r>`;
}

// ─── pptx renderer ────────────────────────────────────────────────

/**
 * Render an AST to a sequence of `<a:p>` paragraph elements for
 * insertion into a slide's text body. PowerPoint paragraphs use a
 * different namespace from Word ones — the structure mirrors but
 * the prefix differs.
 *
 * `paragraphPropsXml` is the original `<a:pPr>` from the placeholder's
 * paragraph (preserved for font/alignment continuity).
 */
export function renderBlocksToPptx(
  blocks: Block[],
  paragraphPropsXml: string,
): string {
  return blocks.map((b) => renderPptxBlock(b, paragraphPropsXml)).join("");
}

function renderPptxBlock(block: Block, pPrInner: string): string {
  if (block.type === "paragraph") {
    return `<a:p>${pptxPPr(pPrInner, null)}${block.runs
      .map(renderPptxRun)
      .join("")}</a:p>`;
  }
  if (block.type === "bulletItem") {
    return `<a:p>${pptxPPr(pPrInner, "bullet")}${block.runs
      .map(renderPptxRun)
      .join("")}</a:p>`;
  }
  // Numbered — PowerPoint's <a:buAutoNum> has many type options;
  // arabicPeriod ("1.") matches what the AI emits.
  return `<a:p>${pptxPPr(pPrInner, "number")}${block.runs
    .map(renderPptxRun)
    .join("")}</a:p>`;
}

/**
 * Build the `<a:pPr>` element. Preserves the original's inner
 * properties (alignment, indent, font size hints) and tacks on the
 * bullet marker for list items. PowerPoint requires the bullet
 * element to come AFTER the existing pPr children, so we emit the
 * preserved inner first.
 */
function pptxPPr(
  preservedInner: string,
  list: "bullet" | "number" | null,
): string {
  if (!preservedInner && !list) return "";
  let bullet = "";
  if (list === "bullet") {
    bullet = `<a:buChar char="•"/>`;
  } else if (list === "number") {
    bullet = `<a:buAutoNum type="arabicPeriod"/>`;
  }
  return `<a:pPr>${preservedInner}${bullet}</a:pPr>`;
}

function renderPptxRun(run: Run): string {
  const text = escapeXml(run.text);
  if (run.kind === "bold") {
    return `<a:r><a:rPr lang="en-US" b="1"/><a:t>${text}</a:t></a:r>`;
  }
  if (run.kind === "italic") {
    return `<a:r><a:rPr lang="en-US" i="1"/><a:t>${text}</a:t></a:r>`;
  }
  return `<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r>`;
}

// ─── xlsx renderer ────────────────────────────────────────────────

/**
 * Render an AST to an exceljs `RichTextValue`-compatible structure.
 * Cells can carry inline bold/italic via the `richText` runs array
 * but have no native concept of paragraph/list — so we flatten:
 * bullets are emitted as `\n`-separated lines with a leading `•`,
 * numbered items with their leading number+period. The caller should
 * also set `cell.alignment.wrapText = true` so multi-line content
 * displays correctly.
 */
export interface XlsxRichText {
  richText: Array<{
    font?: { bold?: boolean; italic?: boolean };
    text: string;
  }>;
}

export function renderBlocksToXlsx(blocks: Block[]): XlsxRichText {
  const out: XlsxRichText["richText"] = [];
  blocks.forEach((b, i) => {
    if (i > 0) {
      // Separate blocks by a newline so paragraphs / list items
      // appear on their own rows visually within the cell.
      out.push({ text: "\n" });
    }
    if (b.type === "bulletItem") {
      out.push({ text: "• " });
    } else if (b.type === "numberedItem") {
      out.push({ text: `${b.index}. ` });
    }
    for (const r of b.runs) {
      const text = r.text;
      if (r.kind === "bold") out.push({ font: { bold: true }, text });
      else if (r.kind === "italic") out.push({ font: { italic: true }, text });
      else out.push({ text });
    }
  });
  // exceljs requires at least one run; an empty value should fall back
  // to a plain empty string at the call site.
  if (out.length === 0) out.push({ text: "" });
  return { richText: out };
}
