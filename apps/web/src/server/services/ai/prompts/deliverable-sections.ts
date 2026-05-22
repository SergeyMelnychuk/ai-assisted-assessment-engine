export const DELIVERABLE_SECTIONS_SYSTEM_PROMPT = `You are a senior technology consultant drafting a client-facing assessment report.

You will receive:
- The assessment context (mode, domains, project context)
- The analysis outputs (findings, risks, recommendations, domain scores, team proposal + estimate)
- A section manifest — a list of sections you must draft, each with a stated purpose and audience

Your job is to draft ALL sections in one response as concise, professional markdown.

Writing principles:
- Write for the section's stated audience (sponsor, engineering leadership, etc.).
- Be concrete: reference specific findings, risks, or evidence rather than generic industry statements.
- Respect target length: "short" = 2–4 paragraphs; "medium" = 4–8 paragraphs or a structured list of equivalent weight.
- Use headings (##, ###) sparingly — the section title is added automatically; start the body directly below.
- Use tables for risk registers, tabular data, and rate/effort summaries.
- Use bullet lists for enumerations (findings, recommendations), not prose.
- Do NOT repeat the section title inside the content.
- Do NOT fabricate data — if a section has no supporting input, say so plainly (e.g. "No risks were identified in this run — the analysis has not been executed yet.").
- When the section manifest says a section "includesDiagrams", reference the diagram by title somewhere in the prose but DO NOT try to embed the image or source — the renderer does that.

Output ONLY valid JSON:
{
  "sections": [
    {
      "key": "exact section key from the manifest",
      "content": "markdown body, no leading title"
    }
  ]
}`;

/**
 * Single-section variant. Produces the body of ONE section so each
 * AI call is small enough to fit comfortably in the per-call timeout
 * + token budget. The orchestrator fans out one call per section and
 * stitches the results.
 *
 * Same writing principles as the batched version; the output schema
 * is the only meaningful change — a single object with a `content`
 * field instead of a wrapping `sections` array.
 */
export const DELIVERABLE_SINGLE_SECTION_SYSTEM_PROMPT = `You are a senior technology consultant drafting one section of a client-facing assessment report.

You will receive:
- The assessment context (mode, domains, project context)
- The analysis outputs (findings, risks, recommendations, domain scores, team proposal + estimate)
- The single section you must draft, with its purpose, audience, and target length

Writing principles:
- Write for the section's stated audience (sponsor, engineering leadership, etc.).
- Be concrete: reference specific findings, risks, or evidence rather than generic industry statements.
- Respect target length: "short" = 2–4 paragraphs; "medium" = 4–8 paragraphs or a structured list of equivalent weight.
- Use headings (##, ###) sparingly — the section title is added automatically; start the body directly below.
- Use tables for risk registers, tabular data, and rate/effort summaries.
- Use bullet lists for enumerations (findings, recommendations), not prose.
- Do NOT repeat the section title inside the content.
- Do NOT fabricate data — if a section has no supporting input, say so plainly (e.g. "No risks were identified in this run — the analysis has not been executed yet.").
- When the section says it "includesDiagrams", reference the diagram by title somewhere in the prose but DO NOT try to embed the image or source — the renderer does that.

Output ONLY valid JSON:
{
  "content": "markdown body, no leading title"
}`;

export function buildDeliverableSingleSectionPrompt(opts: {
  assessmentMode: string;
  activeDomains: string[];
  projectContext: string;
  findings: string;
  risks: string;
  recommendations: string;
  domainScores: string;
  assumptions: string;
  teamProposal: string;
  estimate: string;
  diagrams: string;
  /** The single section we want drafted in this call. */
  section: {
    key: string;
    title: string;
    purpose: string;
    audience: string;
    targetLength: string;
    includesDiagrams?: boolean;
  };
  /** Optional retrieved-evidence blurb scoped to THIS section only. */
  sectionEvidence?: string;
}): string {
  return `Draft the section described below.

Assessment mode: ${opts.assessmentMode}
Active domains: ${opts.activeDomains.join(", ")}

Project context:
${opts.projectContext}

Findings:
${opts.findings}

Risks:
${opts.risks}

Recommendations:
${opts.recommendations}

Domain scores:
${opts.domainScores}

Assumptions:
${opts.assumptions}

Proposed team:
${opts.teamProposal}

Effort & cost estimate:
${opts.estimate}

Generated diagrams (references only — do not embed):
${opts.diagrams}

Section to draft:
- key: ${opts.section.key}
- title: ${opts.section.title}
- purpose: ${opts.section.purpose}
- audience: ${opts.section.audience}
- target length: ${opts.section.targetLength}
- includes diagrams: ${opts.section.includesDiagrams ? "yes" : "no"}
${
  opts.sectionEvidence
    ? `\nRetrieved evidence for this section:\n${opts.sectionEvidence}\n`
    : ""
}
Return JSON only, matching the schema in the system prompt.`;
}

export function buildDeliverableSectionsPrompt(opts: {
  assessmentMode: string;
  activeDomains: string[];
  projectContext: string;
  findings: string;
  risks: string;
  recommendations: string;
  domainScores: string;
  assumptions: string;
  teamProposal: string;
  estimate: string;
  diagrams: string;
  sectionManifest: string;
  /**
   * Per-section retrieved evidence blurbs (Phase 3 Week 4, ADR-0007).
   * Each entry is pre-formatted text that names the section and lists
   * the top retrieved chunks. Optional — callers on older paths can
   * still omit it and the prompt degrades gracefully.
   */
  sectionEvidence?: string;
}): string {
  return `Draft every section listed in the section manifest below.

Assessment mode: ${opts.assessmentMode}
Active domains: ${opts.activeDomains.join(", ")}

Project context:
${opts.projectContext}

Findings:
${opts.findings}

Risks:
${opts.risks}

Recommendations:
${opts.recommendations}

Domain scores:
${opts.domainScores}

Assumptions:
${opts.assumptions}

Proposed team:
${opts.teamProposal}

Effort & cost estimate:
${opts.estimate}

Generated diagrams (references only — do not embed):
${opts.diagrams}

Section manifest (every key must appear in your output, in the same order):
${opts.sectionManifest}
${
  opts.sectionEvidence
    ? `\nPer-section retrieved evidence (use the chunks relevant to each section's purpose):\n${opts.sectionEvidence}\n`
    : ""
}
Return JSON only, matching the schema in the system prompt.`;
}
