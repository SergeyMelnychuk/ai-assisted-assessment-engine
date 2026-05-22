/**
 * System + user-turn for the `template.binding_proposer` task.
 *
 * Input: the structural extract of the customer's template (named
 * ranges + sheets × first N rows for xlsx; placeholder list for
 * docx) and the closed list of engine output fields.
 *
 * Output: a `BindingDocument` (see `services/template/binding.ts`)
 * — JSON only, no commentary.
 */

export const TEMPLATE_BINDING_PROPOSER_PROMPT_VERSION = "0.1.0";

export const TEMPLATE_BINDING_PROPOSER_SYSTEM_PROMPT = `You map the engine's outputs to cells / placeholders in a customer-uploaded template.

Inputs you will receive in the user message:
- The template kind (ESTIMATION, DELIVERABLE_REPORT, DELIVERABLE_PRESENTATION).
- The list of engine output fields with short descriptions.
- A structural extract of the template:
  - For xlsx: defined names + per-sheet first ~30 rows with cell addresses and visible values.
  - For docx/pptx: a list of placeholder tokens found in the document body.

Output a single JSON document matching this schema:

{
  "version": 1,
  "templateKind": "ESTIMATION" | "DELIVERABLE_REPORT" | "DELIVERABLE_PRESENTATION",
  "entries": [
    {
      "field": "<engine output path, e.g. totals.scenarioName or roles[*].roleName>",
      "target": <one of the target shapes below>,
      "groupKey"?: "<shared key when multiple entries iterate the same array>",
      "format"?: "auto" | "currency" | "percent" | "date" | "iso" | "list",
      "note"?: "<optional one-liner explaining the choice>"
    }
  ]
}

Target shapes:
  Excel:
    { "kind": "xlsx.cell",       "sheet": "Sheet name", "cell": "B12" }
    { "kind": "xlsx.namedRange", "name": "DefinedName" }
    { "kind": "xlsx.tableRow",   "sheet": "Sheet name", "startCell": "A5", "column": "B" }
  Word / PowerPoint:
    { "kind": "docx.placeholder", "token": "{{token_name}}" }
    { "kind": "docx.bookmark",    "name": "BookmarkName" }

Hard rules:
- Output JSON ONLY. No prose, no markdown fences, no leading or trailing text.
- Every entry's \`field\` MUST come from the engine output field list. Do not invent fields.
- Every \`xlsx.cell\` reference MUST resolve to a sheet that exists and a cell address that's in A1 form.
- For array iterators (\`roles[*].x\`), every entry sharing the iteration MUST share a \`groupKey\` AND use \`xlsx.tableRow\`. \`startCell\` defines row 1 of the iteration; \`column\` is each per-row destination column.
- Bind only what you are confident about. It's better to leave a field unbound than to point it at a guess. Unbound fields do nothing; mis-bound fields produce broken deliverables for real customers.
- A defined name with a clear semantic match (e.g. \`TotalEffortHours\` → totals.effortHoursLow / High) is preferable to a raw cell ref — defined names survive layout edits.

Style:
- Be terse on \`note\` fields — one short sentence, not a paragraph.
- Order entries roughly top-to-bottom, sheet-by-sheet, so a reviewer can scan.

If the template appears unrelated to the requested kind (e.g. a slide deck submitted as an ESTIMATION), still output a valid skeleton with \`entries: []\` and a \`note\` explaining the mismatch — never throw or refuse.`;

export function buildTemplateBindingPrompt(input: {
  // Mirrors the Prisma `TemplateKind` enum: ESTIMATION + the legacy
  // generic deliverable kinds + the per-deliverable-type kinds.
  templateKind:
    | "ESTIMATION"
    | "DELIVERABLE_REPORT"
    | "DELIVERABLE_PRESENTATION"
    | "EXECUTIVE_SUMMARY"
    | "ASSESSMENT_REPORT"
    | "RISK_REGISTER"
    | "TARGET_STATE"
    | "ROADMAP"
    | "TEAM_PROPOSAL"
    | "ESTIMATE"
    | "ASSUMPTIONS_GAPS"
    | "SOW_DRAFT"
    | "GREENFIELD_DISCOVERY";
  engineFieldsCatalog: string;
  structureJson: string;
}): string {
  return `# Template kind
${input.templateKind}

# Engine output fields (closed list — every \`field\` in your output MUST come from here)
${input.engineFieldsCatalog}

# Template structural extract
${input.structureJson}

# Your turn
Return the binding JSON document. Output JSON only.`;
}
