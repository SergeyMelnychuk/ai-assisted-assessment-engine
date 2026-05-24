import fs from "node:fs";
import path from "node:path";
import { callAi, parseJsonResponse } from "../ai/router";
import {
  TEMPLATE_BINDING_PROPOSER_SYSTEM_PROMPT,
  buildTemplateBindingPrompt,
} from "../ai/prompts/template-binding";
import {
  bindingDocumentSchema,
  ENGINE_OUTPUT_FIELDS,
  type BindingDocument,
} from "./binding";
import { extractXlsxStructure } from "./structure-extract";
import type { TemplateKind } from "@prisma/client";

/**
 * Open-ended `section.<key>` path validator. Section keys are NOT part
 * of the closed `ENGINE_OUTPUT_FIELDS` list — they come from the
 * per-deliverable-type spec under
 * `packages/knowledge-seed/deliverable-templates/`. A customer's
 * uploaded template can reference any key declared there; this regex
 * lets the proposer's post-filter accept those novel keys so they
 * don't get silently dropped.
 */
const SECTION_FIELD_PATH = /^section\.[A-Za-z0-9_]+$/;

/**
 * Load the section specs for the deliverable-template JSON that backs
 * this TemplateKind. Returns `[]` for kinds that don't correspond to a
 * deliverable type (ESTIMATION + legacy generic kinds) or when the
 * spec file is missing — callers handle the empty list gracefully.
 *
 * Kept narrow on purpose: the proposer needs section key + title +
 * purpose to teach the AI the menu of valid `section.<key>` paths.
 * The full deliverable-template schema (target lengths, audiences,
 * diagrams) is the deliverable-generator's concern.
 */
function loadSectionSpecsForKind(kind: TemplateKind): Array<{
  key: string;
  title: string;
  purpose: string;
}> {
  // Map TemplateKind → the JSON spec filename. Kept here rather than
  // imported from `deliverable-generator` to avoid a worker → web-only
  // service circular dep.
  const FILENAME_BY_KIND: Partial<Record<TemplateKind, string>> = {
    EXECUTIVE_SUMMARY: "executive-summary.json",
    ASSESSMENT_REPORT: "assessment-report.json",
    RISK_REGISTER: "risk-register.json",
    TARGET_STATE: "target-state.json",
    ROADMAP: "roadmap.json",
    TEAM_PROPOSAL: "team-proposal.json",
    ESTIMATE: "estimate-summary.json",
    ASSUMPTIONS_GAPS: "assumptions-gaps.json",
    SOW_DRAFT: "sow-draft.json",
    GREENFIELD_DISCOVERY: "greenfield-discovery.json",
  };
  const filename = FILENAME_BY_KIND[kind];
  if (!filename) return [];
  const spec_path = path.resolve(
    process.cwd(),
    "../../packages/knowledge-seed/deliverable-templates",
    filename,
  );
  if (!fs.existsSync(spec_path)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(spec_path, "utf8")) as {
      sections?: Array<{ key: string; title: string; purpose: string }>;
    };
    return raw.sections ?? [];
  } catch {
    // Malformed spec — degrade silently to no-section guidance. The
    // proposer will still produce a valid binding for engine fields.
    return [];
  }
}

/**
 * Proposes a `BindingDocument` for an uploaded template by handing
 * the file's structural extract + the engine's field catalog to
 * `template.binding_proposer`. Returns the parsed-and-validated
 * binding (or a tiny placeholder when the model output fails
 * validation — never crashes the upload flow).
 */
export interface ProposeBindingInput {
  templateKind: TemplateKind;
  templateMimeType: string;
  templateBuffer: Buffer;
  /** Forwarded to the AI router's audit row for cost attribution. */
  audit?: { templateId: string };
  /**
   * Optional reviewer feedback — free-form text describing what the
   * reviewer wants improved about the prior binding. Passed verbatim
   * to the AI under a dedicated "Reviewer feedback" prompt block.
   * Ignored by the AI unless `priorBinding` is also set, because
   * feedback without a prior binding has nothing to act on.
   */
  feedback?: string;
  /**
   * Optional prior binding — when present, the AI is instructed to
   * **refine** this binding (keep entries the reviewer didn't flag,
   * revisit the ones they did, fill slots that were previously
   * missed) rather than start fresh. Omit it to force a from-scratch
   * proposal (used when the existing binding is corrupted past the
   * point where refining would help).
   */
  priorBinding?: BindingDocument;
}

export interface ProposeBindingResult {
  binding: BindingDocument;
  warnings: string[];
  tokens: { input: number; output: number };
}

const ENGINE_FIELD_DESCRIPTIONS: Record<string, string> = {
  "roles[*].roleName": "role name (e.g. 'Backend Engineer')",
  "roles[*].seniority": "seniority (JUNIOR/MID/SENIOR/LEAD/PRINCIPAL)",
  "roles[*].count": "number of people in this role",
  "roles[*].hoursLow": "low end of hours estimate",
  "roles[*].hoursHigh": "high end of hours estimate",
  "roles[*].hourlyRate": "blended hourly rate (currency from totals)",
  "roles[*].costLow": "low cost = hoursLow × hourlyRate × count",
  "roles[*].costHigh": "high cost = hoursHigh × hourlyRate × count",
  "roles[*].justification": "AI-written rationale",
  "roles[*].responsibilities": "AI-written responsibilities",
  "roles[*].phase": "phase tag (DISCOVERY/IMPLEMENTATION/...) or null",
  "totals.effortHoursLow": "rolled-up low hours across all roles",
  "totals.effortHoursHigh": "rolled-up high hours across all roles",
  "totals.costLow": "rolled-up low cost",
  "totals.costHigh": "rolled-up high cost",
  "totals.scenarioName": "AI-named scenario (e.g. 'Greenfield MVP')",
  "totals.assumptions": "free-form assumptions block",
  "totals.confidence": "0–1 confidence score",
  "totals.currency": "ISO 4217 currency code",
  "project.name": "project name",
  "project.industry": "industry/vertical",
  "project.description": "project description",
  "project.businessGoals": "business goals",
  "project.expectedTimeline": "expected timeline (free text)",
  "project.budgetSensitivity": "LOW/MEDIUM/HIGH",
  "project.complianceRequirements": "list of compliance tags",
  "engagement.name": "engagement name",
  "engagement.clientName": "client display name",
  "assessment.findingsCount": "count of findings",
  "assessment.risksCount": "count of risks",
  "assessment.recommendationsCount": "count of recommendations",
  "assessment.activeDomains": "list of active domain keys",
  "findings.bulletList": "joined bullet list of all findings",
  "risks.bulletList": "joined bullet list of all risks",
  "recommendations.bulletList": "joined bullet list of all recs",
  // Per-row arrays — pick these for spreadsheets with per-item tables
  // (Risks sheet on a Risk Register, Findings register, Recommendations
  // matrix). Iterate with `xlsx.tableRow` + a shared `groupKey`. The
  // bullet-list form above is for narrative slots (Word / slide
  // bodies) where one cell holds the whole formatted list.
  "findings[*].title": "finding title (one per row, iterate via xlsx.tableRow)",
  "findings[*].domain": "finding domain",
  "findings[*].type": "FindingType (STRENGTH/WEAKNESS/GAP/OBSERVATION/OPPORTUNITY)",
  "findings[*].severity": "CRITICAL/HIGH/MEDIUM/LOW",
  "findings[*].description": "finding description (long)",
  "findings[*].confidence": "0–1 confidence score",
  "risks[*].title": "risk title (one per row, iterate via xlsx.tableRow)",
  "risks[*].category": "risk category",
  "risks[*].severity": "CRITICAL/HIGH/MEDIUM/LOW",
  "risks[*].likelihood": "VERY_LIKELY/LIKELY/POSSIBLE/UNLIKELY",
  "risks[*].impact": "CRITICAL/HIGH/MEDIUM/LOW",
  "risks[*].description": "risk description (long)",
  "risks[*].mitigation": "suggested mitigation (may be empty)",
  "risks[*].owner": "suggested owner (may be empty)",
  "risks[*].confidence": "0–1 confidence score",
  "recommendations[*].title": "recommendation title (one per row, iterate via xlsx.tableRow)",
  "recommendations[*].domain": "recommendation domain",
  "recommendations[*].priority": "Priority enum (CRITICAL/HIGH/MEDIUM/LOW)",
  "recommendations[*].effort": "effort indication (free text, may be empty)",
  "recommendations[*].description": "recommendation description (long)",
  "recommendations[*].confidence": "0–1 confidence score",
  "generated.date": "ISO date the fill ran",
  "generated.timestamp": "ISO timestamp the fill ran",
  "section.<key>":
    "AI-written deliverable section body keyed by `sectionKey` (defined in the deliverable-template JSON spec). Substitute `<key>` with the actual section key, e.g. `section.executive_summary`, `section.phase_1_scope`. Use this for any placeholder that should hold prose narrative the AI writes, not raw engine data.",
};

export async function proposeTemplateBinding(
  input: ProposeBindingInput,
): Promise<ProposeBindingResult> {
  // Build the structural extract — only xlsx supported in v1; docx
  // gets a placeholder-token-list extract.
  let structureJson: string;
  if (
    input.templateMimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    input.templateMimeType === "application/vnd.ms-excel"
  ) {
    const extract = await extractXlsxStructure(input.templateBuffer);
    structureJson = JSON.stringify(extract, null, 2);
  } else {
    // For docx/pptx in v1 we surface the raw text body so the model
    // can pick out `{{token}}` placeholders.
    const text = input.templateBuffer.toString("utf8", 0, 64_000);
    const tokens = Array.from(text.matchAll(/\{\{[^}]+\}\}/g)).map(
      (m) => m[0],
    );
    structureJson = JSON.stringify(
      { placeholderTokens: Array.from(new Set(tokens)) },
      null,
      2,
    );
  }

  const fieldCatalog = ENGINE_OUTPUT_FIELDS.map(
    (f) => `- \`${f}\` — ${ENGINE_FIELD_DESCRIPTIONS[f] ?? ""}`,
  ).join("\n");

  // Section catalog — the per-deliverable-type list of AI-written
  // section keys the engine will populate at run-time. The customer's
  // template can use ANY of these keys via `field: "section.<key>"`;
  // we feed the list to the AI so it can map narrative-shaped tokens
  // confidently instead of guessing from the small illustrative
  // `section.*` entries in `ENGINE_OUTPUT_FIELDS`.
  const sectionSpecs = loadSectionSpecsForKind(input.templateKind);
  const sectionCatalog =
    sectionSpecs.length === 0
      ? ""
      : sectionSpecs
          .map(
            (s) =>
              `- \`section.${s.key}\` — ${s.title}. ${s.purpose}`,
          )
          .join("\n");

  // Optional re-propose inputs. Both are independent — feedback can
  // be passed in either mode (fresh / refine), but `priorBinding` is
  // what tells the AI to refine vs. start over.
  const priorBindingJson = input.priorBinding
    ? JSON.stringify(input.priorBinding, null, 2)
    : undefined;

  const userTurn = buildTemplateBindingPrompt({
    templateKind: input.templateKind,
    engineFieldsCatalog: fieldCatalog,
    sectionCatalog,
    structureJson,
    feedback: input.feedback,
    priorBindingJson,
  });

  let res;
  try {
    res = await callAi<unknown>({
      task: "template.binding_proposer",
      system: TEMPLATE_BINDING_PROPOSER_SYSTEM_PROMPT,
      userContent: userTurn,
      assistantPrefill: "{",
      parseResult: (raw) => parseJsonResponse<unknown>(raw),
      maxTokens: 4_000,
      audit: input.audit
        ? {
            callType: "deliverable",
            entityType: "Template",
            entityId: input.audit.templateId,
          }
        : undefined,
    });
  } catch (err) {
    // Hard router failure (timeout, both providers down, etc.) — return
    // an empty binding skeleton so the upload completes. The user can
    // re-trigger the proposer from the UI later.
    return {
      binding: emptyBinding(input.templateKind),
      warnings: [
        "AI binding proposer failed: " +
          (err instanceof Error ? err.message : String(err)),
      ],
      tokens: { input: 0, output: 0 },
    };
  }

  // Validate the model's output against the binding schema. On failure
  // we keep the raw output around in `warnings` so the reviewer can
  // see what came back.
  const parsed = bindingDocumentSchema.safeParse(res.result);
  if (!parsed.success) {
    return {
      binding: emptyBinding(input.templateKind),
      warnings: [
        "AI binding proposer returned an invalid document. " +
          `Parse error: ${parsed.error.message}. ` +
          `Raw: ${JSON.stringify(res.result).slice(0, 500)}`,
      ],
      tokens: {
        input: res.tokensUsed?.input ?? 0,
        output: res.tokensUsed?.output ?? 0,
      },
    };
  }

  // Drop entries whose field is neither in the engine catalog nor a
  // well-formed `section.<key>` path. The section family is open-ended:
  // a customer template can declare any key in its deliverable-template
  // spec (we don't enforce membership here — missing keys surface as
  // runtime warnings from the filler, which is more diagnostic than a
  // silent post-AI drop).
  const knownFields = new Set<string>(ENGINE_OUTPUT_FIELDS);
  const filtered = parsed.data.entries.filter(
    (e) => knownFields.has(e.field) || SECTION_FIELD_PATH.test(e.field),
  );
  const dropped = parsed.data.entries.length - filtered.length;
  return {
    binding: {
      ...parsed.data,
      entries: filtered,
    },
    warnings:
      dropped > 0
        ? [
            `Dropped ${dropped} entry/ies whose \`field\` wasn't in the engine output catalog.`,
          ]
        : [],
    tokens: {
      input: res.tokensUsed?.input ?? 0,
      output: res.tokensUsed?.output ?? 0,
    },
  };
}

function emptyBinding(kind: TemplateKind): BindingDocument {
  return {
    version: 1,
    templateKind: kind,
    entries: [],
    notes:
      "Binding proposer did not return a usable document. Edit this binding manually before approving.",
  };
}
