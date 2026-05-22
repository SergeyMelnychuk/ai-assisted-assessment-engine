import ExcelJS from "exceljs";

/**
 * Pull a compact structural extract from an uploaded `.xlsx` file —
 * the input the AI binding proposer needs to suggest cell mappings.
 *
 * What we send the model:
 *   - the workbook's defined names (named ranges)
 *   - per-sheet, the first ~30 rows × 8 cols, with cell addresses
 *   - cell types where they help disambiguate ("Total cost: $___")
 *
 * What we DON'T send: cell formulas, formatting, comments. Those
 * blow up the prompt without changing the binding output.
 */

export interface XlsxStructureExtract {
  definedNames: Array<{ name: string; ranges: string[] }>;
  sheets: Array<{
    name: string;
    rowCount: number;
    columnCount: number;
    rows: Array<{
      rowIndex: number;
      cells: Array<{ address: string; value: string }>;
    }>;
  }>;
}

const MAX_ROWS_PER_SHEET = 30;
const MAX_COLS_PER_SHEET = 10;
const MAX_CELL_VALUE_CHARS = 80;

export async function extractXlsxStructure(
  buffer: Buffer,
): Promise<XlsxStructureExtract> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const definedNames: XlsxStructureExtract["definedNames"] = [];
  // exceljs exposes defined names via wb.definedNames — iterate via its
  // internal map. There's no public list-all, so we read the model.
  const dnModel = (wb as unknown as {
    definedNames: { matrixMap: Record<string, unknown> };
  }).definedNames?.matrixMap;
  if (dnModel) {
    for (const name of Object.keys(dnModel)) {
      const r = wb.definedNames.getRanges(name);
      if (r?.ranges) {
        definedNames.push({ name, ranges: r.ranges as string[] });
      }
    }
  }

  const sheets: XlsxStructureExtract["sheets"] = wb.worksheets.map((ws) => {
    const rows: XlsxStructureExtract["sheets"][number]["rows"] = [];
    const rowMax = Math.min(ws.rowCount || 0, MAX_ROWS_PER_SHEET);
    const colMax = Math.min(ws.columnCount || 0, MAX_COLS_PER_SHEET);
    for (let r = 1; r <= rowMax; r++) {
      const row = ws.getRow(r);
      const cells: Array<{ address: string; value: string }> = [];
      for (let c = 1; c <= colMax; c++) {
        const cell = row.getCell(c);
        const v = cellValueToText(cell.value);
        if (v.trim().length > 0) {
          cells.push({ address: cell.address, value: v });
        }
      }
      if (cells.length > 0) rows.push({ rowIndex: r, cells });
    }
    return {
      name: ws.name,
      rowCount: ws.rowCount,
      columnCount: ws.columnCount,
      rows,
    };
  });

  return { definedNames, sheets };
}

function cellValueToText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    return String(v).slice(0, MAX_CELL_VALUE_CHARS);
  if (typeof v === "object") {
    if ("text" in v && typeof v.text === "string") {
      return v.text.slice(0, MAX_CELL_VALUE_CHARS);
    }
    if ("richText" in v && Array.isArray((v as { richText: unknown[] }).richText)) {
      return (v as { richText: { text: string }[] }).richText
        .map((r) => r.text)
        .join("")
        .slice(0, MAX_CELL_VALUE_CHARS);
    }
    if ("result" in v) {
      const r = (v as { result: unknown }).result;
      if (typeof r === "string" || typeof r === "number") {
        return String(r).slice(0, MAX_CELL_VALUE_CHARS);
      }
    }
    if ("formula" in v) {
      // We don't want formulas in the prompt — they aren't useful for
      // binding decisions and cost tokens. Emit a stub.
      return "(formula)";
    }
  }
  return "";
}
