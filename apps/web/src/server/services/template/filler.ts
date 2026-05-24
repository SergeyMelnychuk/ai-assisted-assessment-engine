import ExcelJS from "exceljs";
import {
  bindingDocumentSchema,
  type BindingDocument,
  type BindingEntry,
} from "./binding";
import {
  resolveEngineField,
  type EngineOutputs,
} from "./engine-outputs";
import { escapeXml } from "./xml-escape";
import {
  containsMarkdownSyntax,
  parseMarkdown,
  renderBlocksToDocx,
  renderBlocksToPptx,
  renderBlocksToXlsx,
  stripMarkdownSyntax,
} from "./markdown-to-ooxml";

/**
 * Template filler.
 *
 * v1 supports `.xlsx` (the high-leverage WBS workbook case) and
 * Word/PowerPoint placeholder substitution (`{{token}}`). Bindings
 * that reference targets we don't recognise log a warning and skip;
 * a partially-filled output is more useful to the reviewer than a
 * hard failure.
 */

export interface FillerInput {
  templateBuffer: Buffer;
  templateMimeType: string;
  binding: BindingDocument | unknown;
  outputs: EngineOutputs;
}

export interface FillerResult {
  buffer: Buffer;
  /** Warnings the binding produced — unresolved fields, missing
   *  named ranges, unsupported targets, etc. Surfaced on the
   *  TemplateFill row so the reviewer can spot bindings that
   *  silently skipped. */
  warnings: string[];
  filledEntryCount: number;
}

const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);
const DOCX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
]);
const PPTX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
]);

export async function fillTemplate(
  input: FillerInput,
): Promise<FillerResult> {
  // Validate the binding eagerly so a malformed JSON column never
  // turns into "filler crashed mid-fill". A failed parse is a no-op
  // fill — the original file is returned untouched.
  const parsed = bindingDocumentSchema.safeParse(input.binding);
  if (!parsed.success) {
    return {
      buffer: input.templateBuffer,
      warnings: [
        `Binding JSON failed schema validation: ${parsed.error.message}`,
      ],
      filledEntryCount: 0,
    };
  }
  const binding = parsed.data;

  if (XLSX_MIME_TYPES.has(input.templateMimeType)) {
    return fillXlsx(input.templateBuffer, binding, input.outputs);
  }
  if (DOCX_MIME_TYPES.has(input.templateMimeType)) {
    return fillDocxPlaceholders(
      input.templateBuffer,
      binding,
      input.outputs,
    );
  }
  if (PPTX_MIME_TYPES.has(input.templateMimeType)) {
    return fillPptxPlaceholders(
      input.templateBuffer,
      binding,
      input.outputs,
    );
  }
  return {
    buffer: input.templateBuffer,
    warnings: [
      `No filler registered for mime type ${input.templateMimeType} — returning the original file.`,
    ],
    filledEntryCount: 0,
  };
}

// ─── Xlsx ──────────────────────────────────────────────────────────

async function fillXlsx(
  templateBuffer: Buffer,
  binding: BindingDocument,
  outputs: EngineOutputs,
): Promise<FillerResult> {
  const wb = new ExcelJS.Workbook();
  // exceljs.xlsx.load accepts ArrayBuffer at runtime; the cast keeps
  // the TS narrow signature happy.
  await wb.xlsx.load(templateBuffer as unknown as ArrayBuffer);

  const warnings: string[] = [];
  let filled = 0;

  // Group entries by groupKey so per-array iterations write across
  // sibling columns from the SAME row index. e.g. roles iterator:
  // hoursLow → col B, hoursHigh → col C, all share groupKey "roles".
  const groups = new Map<string, BindingEntry[]>();
  const standalone: BindingEntry[] = [];
  for (const e of binding.entries) {
    if (e.groupKey) {
      if (!groups.has(e.groupKey)) groups.set(e.groupKey, []);
      groups.get(e.groupKey)!.push(e);
    } else {
      standalone.push(e);
    }
  }

  // Standalone entries — single value, single target.
  for (const entry of standalone) {
    const value = resolveEngineField(outputs, entry.field);
    if (value === undefined) {
      warnings.push(`Field "${entry.field}" did not resolve.`);
      continue;
    }
    const ok = writeXlsxTarget(wb, entry, value, warnings);
    if (ok) filled++;
  }

  // Grouped entries — array iteration. Each group produces N rows
  // (N = array length); column comes from the entry's target.
  for (const [groupKey, entries] of groups) {
    if (
      entries.some((e) => e.target.kind !== "xlsx.tableRow")
    ) {
      warnings.push(
        `Group "${groupKey}" must use xlsx.tableRow targets only.`,
      );
      continue;
    }
    // All entries should reference the same array; we extract the
    // length from the first entry's resolved value.
    const firstValue = resolveEngineField(outputs, entries[0].field);
    if (!Array.isArray(firstValue)) {
      warnings.push(
        `Group "${groupKey}" first field "${entries[0].field}" did not resolve to an array.`,
      );
      continue;
    }
    const rows = firstValue.length;
    for (const entry of entries) {
      const target = entry.target as Extract<
        BindingEntry["target"],
        { kind: "xlsx.tableRow" }
      >;
      const values = resolveEngineField(outputs, entry.field);
      if (!Array.isArray(values)) {
        warnings.push(
          `Group "${groupKey}" field "${entry.field}" did not resolve to an array.`,
        );
        continue;
      }
      const sheet = wb.getWorksheet(target.sheet);
      if (!sheet) {
        warnings.push(`Sheet "${target.sheet}" not found.`);
        continue;
      }
      const start = sheet.getCell(target.startCell);
      // cell.row is sometimes typed `string | number` by ExcelJS depending
      // on how the cell was constructed; coerce.
      const startRow =
        typeof start.row === "number" ? start.row : Number(start.row);
      const colLetter = target.column;
      for (let i = 0; i < rows; i++) {
        const cell = sheet.getCell(`${colLetter}${startRow + i}`);
        cell.value = formatValue(values[i], entry.format);
      }
      filled++;
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(out as ArrayBuffer),
    warnings,
    filledEntryCount: filled,
  };
}

function writeXlsxTarget(
  wb: ExcelJS.Workbook,
  entry: BindingEntry,
  value: string | number | string[] | number[],
  warnings: string[],
): boolean {
  if (entry.target.kind === "xlsx.cell") {
    const sheet = wb.getWorksheet(entry.target.sheet);
    if (!sheet) {
      warnings.push(`Sheet "${entry.target.sheet}" not found.`);
      return false;
    }
    const cell = sheet.getCell(entry.target.cell);
    const v = Array.isArray(value) ? value.join(", ") : value;
    // Markdown-aware: when the value is a string with bullet / bold
    // syntax, write a RichText cell value so the reader sees
    // formatted runs and bullet-prefixed lines instead of literal
    // `**`, `-` characters. Plain values keep the simple
    // `cell.value = formatValue(...)` path.
    if (typeof v === "string" && containsMarkdownSyntax(v)) {
      const blocks = parseMarkdown(v);
      cell.value = renderBlocksToXlsx(blocks) as never;
      cell.alignment = { ...(cell.alignment ?? {}), wrapText: true };
      return true;
    }
    cell.value = formatValue(v, entry.format);
    return true;
  }
  if (entry.target.kind === "xlsx.namedRange") {
    // exceljs exposes named ranges via `wb.definedNames`. Resolve to
    // the underlying ranges and fill the first cell of the first
    // range — a minimal but useful interpretation that matches how
    // most cover-sheet "name → cell" mappings are used.
    const ranges = wb.definedNames.getRanges(entry.target.name);
    const firstRange = ranges?.ranges?.[0];
    if (!firstRange) {
      warnings.push(`Named range "${entry.target.name}" not found.`);
      return false;
    }
    // Format: "SheetName!$B$2:$B$2" or just "SheetName!$B$2".
    const m = firstRange.match(/^(?:'?([^'!]+)'?)!(\$?[A-Z]+\$?\d+)/);
    if (!m) {
      warnings.push(
        `Named range "${entry.target.name}" has unexpected format: ${firstRange}`,
      );
      return false;
    }
    const [, sheetName, addr] = m;
    const sheet = wb.getWorksheet(sheetName);
    if (!sheet) {
      warnings.push(`Sheet "${sheetName}" not found for named range.`);
      return false;
    }
    const cell = sheet.getCell(addr.replace(/\$/g, ""));
    const v = Array.isArray(value) ? value.join(", ") : value;
    // Same markdown branch as the `xlsx.cell` path above.
    if (typeof v === "string" && containsMarkdownSyntax(v)) {
      const blocks = parseMarkdown(v);
      cell.value = renderBlocksToXlsx(blocks) as never;
      cell.alignment = { ...(cell.alignment ?? {}), wrapText: true };
      return true;
    }
    cell.value = formatValue(v, entry.format);
    return true;
  }
  // tableRow targets are handled in the grouped path; standalone
  // entries shouldn't use it.
  if (entry.target.kind === "xlsx.tableRow") {
    warnings.push(
      `Entry "${entry.field}" uses xlsx.tableRow but has no groupKey — skipping.`,
    );
    return false;
  }
  // docx target on an xlsx workbook → silently skip; the binding is
  // probably mis-tagged but not worth a hard failure.
  warnings.push(
    `Entry "${entry.field}" target kind "${entry.target.kind}" not supported in xlsx.`,
  );
  return false;
}

function formatValue(
  v: string | number | undefined,
  format: BindingEntry["format"],
): string | number {
  if (v === undefined) return "";
  if (format === "currency" && typeof v === "number") {
    return v.toFixed(2);
  }
  if (format === "percent" && typeof v === "number") {
    return `${(v * 100).toFixed(1)}%`;
  }
  if (format === "date" && typeof v === "string") {
    return v.slice(0, 10);
  }
  return v;
}

// ─── Docx (placeholder substitution) ───────────────────────────────

/**
 * Naive find-and-replace inside the .docx OOXML. Good enough for
 * `{{token}}`-style placeholders; not for tables or repeating
 * regions (those need a real docx engine — punt to a Slice 5
 * follow-up).
 *
 * .docx is a zip — for first-cut we extract just `word/document.xml`,
 * substitute, repackage. For now we use docx via exceljs's underlying
 * yauzl/yazl chain by going through Buffer; this keeps the dep list
 * minimal at the cost of some lifting.
 */
async function fillDocxPlaceholders(
  templateBuffer: Buffer,
  binding: BindingDocument,
  outputs: EngineOutputs,
): Promise<FillerResult> {
  const yauzl = await import("yauzl-promise");
  const yazl = await import("yazl");

  // Build the substitution map.
  const subs: Array<{ token: string; value: string }> = [];
  const warnings: string[] = [];
  for (const entry of binding.entries) {
    if (entry.target.kind !== "docx.placeholder") {
      // bookmarks not yet supported
      if (entry.target.kind === "docx.bookmark") {
        warnings.push(
          `docx.bookmark target on "${entry.field}" not yet supported (Slice 5).`,
        );
      }
      continue;
    }
    const v = resolveEngineField(outputs, entry.field);
    if (v === undefined) {
      warnings.push(`Field "${entry.field}" did not resolve.`);
      continue;
    }
    subs.push({
      token: entry.target.token,
      value: Array.isArray(v) ? v.join(", ") : String(v),
    });
  }

  if (subs.length === 0) {
    return {
      buffer: templateBuffer,
      warnings: warnings.concat("No docx placeholders bound."),
      filledEntryCount: 0,
    };
  }

  // Read the docx zip, rewrite document.xml, repack.
  const inZip = await yauzl.fromBuffer(templateBuffer);
  const outZip = new yazl.ZipFile();
  let filled = 0;
  for await (const entry of inZip) {
    const stream = await entry.openReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    let content = Buffer.concat(chunks);
    if (entry.filename === "word/document.xml") {
      let text = content.toString("utf8");
      for (const { token, value } of subs) {
        const { xml, hit } = substituteWithMarkdown({
          xml: text,
          token,
          value,
          format: "docx",
        });
        text = xml;
        if (hit) filled++;
      }
      content = Buffer.from(text, "utf8");
    }
    outZip.addBuffer(content, entry.filename);
  }
  outZip.end();

  const buf = await new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    outZip.outputStream.on("data", (c) => parts.push(c as Buffer));
    outZip.outputStream.on("end", () => resolve(Buffer.concat(parts)));
    outZip.outputStream.on("error", reject);
  });
  return { buffer: buf, warnings, filledEntryCount: filled };
}

// ─── Pptx (placeholder substitution) ───────────────────────────────

/**
 * Same naive find-and-replace approach as the docx branch, applied to
 * the slide / layout / notes XML inside a `.pptx` zip. Targets reuse
 * the docx schemas (`docx.placeholder` / `docx.bookmark`) — pptx
 * tokens use the same `{{token}}` convention and pptx has no real
 * bookmark equivalent (we warn + skip those).
 *
 * Limitation: PowerPoint may split a logical token across multiple
 * `<a:t>` runs (e.g. when the user edited mid-token). v1 does a flat
 * string replace per XML file, so genuinely split tokens are missed.
 * Authors should retype tokens in a single edit to keep them in one
 * run — a real run-merging pass is a Slice 5 follow-up.
 */
async function fillPptxPlaceholders(
  templateBuffer: Buffer,
  binding: BindingDocument,
  outputs: EngineOutputs,
): Promise<FillerResult> {
  const yauzl = await import("yauzl-promise");
  const yazl = await import("yazl");

  const subs: Array<{ token: string; value: string }> = [];
  const warnings: string[] = [];
  for (const entry of binding.entries) {
    if (entry.target.kind === "docx.bookmark") {
      warnings.push(
        `docx.bookmark target on "${entry.field}" not supported in pptx — skipping.`,
      );
      continue;
    }
    if (entry.target.kind !== "docx.placeholder") {
      // xlsx.* targets on a pptx are mis-tagged bindings — log + skip.
      warnings.push(
        `Entry "${entry.field}" target kind "${entry.target.kind}" not supported in pptx.`,
      );
      continue;
    }
    const v = resolveEngineField(outputs, entry.field);
    if (v === undefined) {
      warnings.push(`Field "${entry.field}" did not resolve.`);
      continue;
    }
    subs.push({
      token: entry.target.token,
      value: Array.isArray(v) ? v.join(", ") : String(v),
    });
  }

  if (subs.length === 0) {
    return {
      buffer: templateBuffer,
      warnings: warnings.concat("No pptx placeholders bound."),
      filledEntryCount: 0,
    };
  }

  const inZip = await yauzl.fromBuffer(templateBuffer);
  const outZip = new yazl.ZipFile();
  // Track which tokens we landed somewhere — count once per token,
  // not per XML file, so the entry count matches "bindings applied".
  const hitTokens = new Set<string>();
  for await (const entry of inZip) {
    const stream = await entry.openReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    let content = Buffer.concat(chunks);
    if (isPptxTextEntry(entry.filename)) {
      let text = content.toString("utf8");
      for (const { token, value } of subs) {
        const { xml, hit } = substituteWithMarkdown({
          xml: text,
          token,
          value,
          format: "pptx",
        });
        text = xml;
        if (hit) hitTokens.add(token);
      }
      content = Buffer.from(text, "utf8");
    }
    outZip.addBuffer(content, entry.filename);
  }
  outZip.end();
  const filled = hitTokens.size;

  const buf = await new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    outZip.outputStream.on("data", (c) => parts.push(c as Buffer));
    outZip.outputStream.on("end", () => resolve(Buffer.concat(parts)));
    outZip.outputStream.on("error", reject);
  });
  return { buffer: buf, warnings, filledEntryCount: filled };
}

function isPptxTextEntry(filename: string): boolean {
  return (
    /^ppt\/slides\/slide\d+\.xml$/.test(filename) ||
    /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(filename) ||
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(filename)
  );
}

// ─── Markdown-aware substitution ──────────────────────────────────

/**
 * Substitute a placeholder token into OOXML, rendering native
 * paragraph/run structures when the value contains markdown.
 *
 * Strategy:
 *   - No markdown syntax in the value → plain string replace,
 *     XML-escaped (preserves the existing v1 behaviour). Cheap.
 *   - Markdown syntax present, and the token sits alone inside its
 *     containing paragraph (`<w:p>` for docx, `<a:p>` for pptx) →
 *     splice in rendered paragraph(s) and preserve the parent's
 *     `<w:pPr>` / `<a:pPr>` so font/alignment carry over.
 *   - Markdown syntax present but the token is mid-sentence → fall
 *     back to plain string replace with markdown syntax stripped, so
 *     we don't leak orphan `**` characters into the output.
 *
 * The paragraph match uses non-greedy `[\s\S]*?` because OOXML
 * paragraphs don't nest. PowerPoint's "split run" edge case
 * (`{{` and `token}}` ending up in separate `<a:t>` elements after
 * a manual edit) still falls back to the inline path — same as the
 * pre-markdown filler. Authors should keep tokens in a single run.
 */
function substituteWithMarkdown(args: {
  xml: string;
  token: string;
  value: string;
  format: "docx" | "pptx";
}): { xml: string; hit: boolean } {
  const { token, value, format } = args;
  let { xml } = args;

  // Fast path — no markdown means no XML restructuring.
  if (!containsMarkdownSyntax(value)) {
    const before = xml;
    xml = xml.split(token).join(escapeXml(value));
    return { xml, hit: xml !== before };
  }

  const blocks = parseMarkdown(value);
  const pTag = format === "docx" ? "w:p" : "a:p";
  const pPrTag = format === "docx" ? "w:pPr" : "a:pPr";
  // Non-greedy paragraph match. `\b` after the opening tag stops
  // mistaken matches against `<w:pPr>` etc.
  const paraRe = new RegExp(
    `<${pTag}\\b[^>]*>([\\s\\S]*?)</${pTag}>`,
    "g",
  );

  let hit = false;
  let result = "";
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(xml)) !== null) {
    const para = m[0];
    const inner = m[1];
    result += xml.slice(lastIndex, m.index);
    lastIndex = m.index + para.length;

    if (!inner.includes(token)) {
      // No token in this paragraph — pass through untouched.
      result += para;
      continue;
    }
    hit = true;

    // Does the token stand alone inside this paragraph? Strip all
    // tags and compare against the token. Tolerates surrounding
    // whitespace, which OOXML paragraphs commonly carry inside
    // text-preserving runs.
    const textOnly = inner.replace(/<[^>]+>/g, "").trim();
    if (textOnly === token) {
      // Preserve the original `<w:pPr>` / `<a:pPr>` contents so the
      // generated paragraphs inherit the author's font / alignment.
      const pPrMatch = inner.match(
        new RegExp(`<${pPrTag}\\b[^>]*>([\\s\\S]*?)</${pPrTag}>`),
      );
      const pPrInner = pPrMatch ? pPrMatch[1] : "";
      const rendered =
        format === "docx"
          ? renderBlocksToDocx(blocks, pPrInner)
          : renderBlocksToPptx(blocks, pPrInner);
      result += rendered;
    } else {
      // Mid-sentence — keep the existing inline string replacement
      // but strip the markdown syntax characters so the output reads
      // cleanly (no orphan `**` chars).
      const stripped = stripMarkdownSyntax(value);
      result += para.split(token).join(escapeXml(stripped));
    }
  }
  result += xml.slice(lastIndex);

  // Edge case — token appears in the XML but outside any paragraph
  // (unusual, but e.g. in `<w:sectPr>`). Fall back to whole-string
  // replace with stripped markdown so we still hit it.
  if (!hit && xml.includes(token)) {
    const stripped = stripMarkdownSyntax(value);
    const before = result;
    result = result.split(token).join(escapeXml(stripped));
    hit = result !== before;
  }

  return { xml: result, hit };
}

