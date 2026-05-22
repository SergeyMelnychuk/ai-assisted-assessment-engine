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
  "generated.date": "ISO date the fill ran",
  "generated.timestamp": "ISO timestamp the fill ran",
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

  const userTurn = buildTemplateBindingPrompt({
    templateKind: input.templateKind,
    engineFieldsCatalog: fieldCatalog,
    structureJson,
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

  // Drop entries whose field isn't in the closed list (defensive — the
  // prompt forbids it but the model can still hallucinate).
  const knownFields = new Set<string>(ENGINE_OUTPUT_FIELDS);
  const filtered = parsed.data.entries.filter((e) => knownFields.has(e.field));
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
