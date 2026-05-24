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
- The template kind (ESTIMATION, DELIVERABLE_REPORT, DELIVERABLE_PRESENTATION, or one of the per-deliverable kinds).
- The list of engine output fields with short descriptions (closed list).
- (Optional, only when the template kind has a deliverable spec) An "AI section keys" catalog listing the prose narratives the engine will write for this deliverable type. Each entry is a \`section.<key>\` you may bind to placeholders that should hold AI-authored prose (the catalog is open — only these keys exist for this kind).
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
- Every entry's \`field\` MUST come from either (a) the engine output field list, or (b) the "AI section keys" catalog as \`section.<key>\`. Do not invent fields outside those two sources. If a \`section.*\` catalog is provided you may bind any key from it; if no catalog is provided, do NOT propose \`section.*\` fields at all.
- Every \`xlsx.cell\` reference MUST resolve to a sheet that exists and a cell address that's in A1 form.
- For array iterators (\`roles[*].x\`), every entry sharing the iteration MUST share a \`groupKey\` AND use \`xlsx.tableRow\`. \`startCell\` defines row 1 of the iteration; \`column\` is each per-row destination column.
- Bind only what you are confident about. It's better to leave a field unbound than to point it at a guess. Unbound fields do nothing; mis-bound fields produce broken deliverables for real customers.
- A defined name with a clear semantic match (e.g. \`TotalEffortHours\` → totals.effortHoursLow / High) is preferable to a raw cell ref — defined names survive layout edits.
- Prefer \`section.<key>\` over raw \`findings.bulletList\` / \`risks.bulletList\` / \`recommendations.bulletList\` for any placeholder that should hold prose / curated narrative. The bullet-list engine fields are pre-formatted dumps with internal severity/domain prefixes — they read poorly in sponsor-facing copy. Section keys carry AI-written narrative tailored to the deliverable.
- Re-propose flow: if a \`# Prior binding\` block is provided, REFINE that binding rather than starting fresh. Keep entries the reviewer didn't flag, revisit only what their feedback called out, and add entries for slots the prior binding missed. If no prior binding is provided, generate a binding from scratch — the reviewer is asking you to forget what was there before (typically because the prior binding was corrupted or far off).

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
  /**
   * Optional per-deliverable-type AI section keys catalog. Empty when
   * the TemplateKind has no matching `deliverable-templates/*.json`
   * spec (ESTIMATION, legacy generic kinds). When non-empty, the AI
   * may bind any `section.<key>` from this catalog.
   */
  sectionCatalog?: string;
  structureJson: string;
  /**
   * Optional reviewer feedback for a re-propose run. Free-form text
   * the reviewer wrote in the "what to change" box on the UI. The
   * prompt instructs the AI to take it as a direction, not a strict
   * order — e.g. if the reviewer says "bind X to project.industry"
   * but project.industry doesn't suit X semantically, the AI is
   * allowed to push back. Combined with `priorBindingJson` for the
   * refine flow; alone, it's a hint for a from-scratch re-propose.
   */
  feedback?: string;
  /**
   * Optional prior binding JSON for the refine flow. When present,
   * the prompt tells the AI to start from this binding rather than
   * generate one fresh — keeping entries the reviewer didn't flag,
   * revisiting the ones the feedback called out, and filling slots
   * that were previously missed. Omit for from-scratch re-proposes.
   */
  priorBindingJson?: string;
}): string {
  const sectionsBlock =
    input.sectionCatalog && input.sectionCatalog.trim().length > 0
      ? `\n# AI section keys for this deliverable type (open list — use \`section.<key>\` to bind narrative placeholders to AI-written prose)\n${input.sectionCatalog}\n`
      : "";
  const priorBlock = input.priorBindingJson
    ? `\n# Prior binding (REFINE this — keep entries the reviewer didn't flag, revisit the ones they called out, and fill slots you previously missed; do NOT start from scratch)\n\`\`\`json\n${input.priorBindingJson}\n\`\`\`\n`
    : "";
  const feedbackBlock =
    input.feedback && input.feedback.trim().length > 0
      ? `\n# Reviewer feedback\n${input.feedback.trim()}\n\nTreat this as the reviewer's direction. If a request would conflict with the hard rules (e.g. bind to a field outside the catalog), follow the rules and skip the conflicting part — don't fight the catalog.\n`
      : "";
  return `# Template kind
${input.templateKind}

# Engine output fields (closed list — every \`field\` in your output MUST come from here unless it's a section key from the block below)
${input.engineFieldsCatalog}
${sectionsBlock}# Template structural extract
${input.structureJson}
${priorBlock}${feedbackBlock}
# Your turn
Return the binding JSON document. Output JSON only.`;
}
