/**
 * Template binding spec.
 *
 * A binding is a JSON document attached to a `Template` row. It maps
 * fields the engine produces (role hours, hourly rate, totals,
 * project-context summary, …) to *targets* inside the customer's
 * file.
 *
 * For an Excel workbook a target is a sheet + cell ref or named range.
 * For a Word/PowerPoint document a target is a placeholder token
 * (`{{token}}`) or a bookmark name. The filler service walks the
 * binding and writes each engine output to its target.
 *
 * Why JSON-with-a-schema instead of a templating language: customers
 * upload corporate workbooks they didn't write. They don't want
 * `{{# for role in roles }}` syntax in their cells. Cell refs and
 * placeholder tokens are what they already understand.
 *
 * The schema is intentionally permissive — we don't reject unknown
 * `kind` values at the type level so the AI proposer can output forms
 * we add later without an immediate code change. The filler service
 * skips entries it doesn't understand and logs a warning.
 */

import { z } from "zod";

// ─── Output types — what the engine can fill in ────────────────────

/**
 * Closed enumeration of fields the engine knows how to compute. The
 * filler service uses this enum to pull values out of the
 * `EngineOutputs` shape; the binding entries reference them by name.
 *
 * To add a new output field:
 *   1. Add it to this list
 *   2. Add the value path in `extractEngineOutput()` in filler.ts
 *   3. Document it in the binding-prompt user-turn block so the AI
 *      proposer knows it exists.
 */
export const ENGINE_OUTPUT_FIELDS = [
  // Per-role aggregates — array index = role order in the proposal.
  // The binding can target the array via `roles[*].field` (one row
  // per role) or `roles[N].field` (one specific role) or the rolled
  // up `roles.totalHoursLow` etc.
  "roles[*].roleName",
  "roles[*].seniority",
  "roles[*].count",
  "roles[*].hoursLow",
  "roles[*].hoursHigh",
  "roles[*].hourlyRate",
  "roles[*].costLow",
  "roles[*].costHigh",
  "roles[*].justification",
  "roles[*].responsibilities",
  "roles[*].phase",
  // Roll-ups
  "totals.effortHoursLow",
  "totals.effortHoursHigh",
  "totals.costLow",
  "totals.costHigh",
  "totals.scenarioName",
  "totals.assumptions",
  "totals.confidence",
  "totals.currency",
  // Project context — pulled from ProjectContext for cover sheets
  "project.name",
  "project.industry",
  "project.description",
  "project.businessGoals",
  "project.expectedTimeline",
  "project.budgetSensitivity",
  "project.complianceRequirements",
  // Engagement
  "engagement.name",
  "engagement.clientName",
  // Assessment summary (counts) — useful for cover stats
  "assessment.findingsCount",
  "assessment.risksCount",
  "assessment.recommendationsCount",
  "assessment.activeDomains",
  // Findings / risks / recs as joined strings (for Word templates;
  // Excel cells get truncated views instead).
  "findings.bulletList",
  "risks.bulletList",
  "recommendations.bulletList",
  // Per-row arrays — `X[*].field` iterates one row per item, matching
  // the existing `roles[*].field` pattern. The proposer should pick
  // these whenever the template has a per-item table (e.g. the Risks
  // sheet on a Risk Register, a Findings register, a Recommendations
  // matrix). Field names mirror the conventional spreadsheet column
  // headers reviewers actually type.
  "findings[*].title",
  "findings[*].domain",
  "findings[*].type",
  "findings[*].severity",
  "findings[*].description",
  "findings[*].confidence",
  "risks[*].title",
  "risks[*].category",
  "risks[*].severity",
  "risks[*].likelihood",
  "risks[*].impact",
  "risks[*].description",
  "risks[*].mitigation",
  "risks[*].owner",
  "risks[*].confidence",
  "recommendations[*].title",
  "recommendations[*].domain",
  "recommendations[*].priority",
  "recommendations[*].effort",
  "recommendations[*].description",
  "recommendations[*].confidence",
  // Generated date — convenience for cover blocks.
  "generated.date",
  "generated.timestamp",
  // AI-written deliverable section bodies — looked up by `sectionKey`
  // via the `section.<key>` field path. The exact keys live in each
  // template's deliverable-template JSON spec (e.g.
  // `packages/knowledge-seed/deliverable-templates/roadmap.json`); the
  // entries below are illustrative placeholders so the binding
  // proposer knows the field family exists. The resolver accepts any
  // `section.<key>` path regardless of whether it's listed here.
  "section.executive_summary",
  "section.engagement_context",
  "section.current_state",
  "section.target_state",
  "section.key_findings",
  "section.recommendations",
  "section.team_and_estimate",
  "section.assumptions_and_gaps",
  "section.phase_1_scope",
  "section.phase_2_scope",
  "section.phase_3_scope",
  "section.milestones_owners",
  "section.phasing_rationale",
] as const;

export type EngineOutputField = (typeof ENGINE_OUTPUT_FIELDS)[number];

// ─── Target types — where the value lands in the file ──────────────

/**
 * For Excel templates. Either a single cell, a named range, or a
 * "table" target where the engine fills one row per array element
 * (used for `roles[*].*`).
 */
export const xlsxTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("xlsx.cell"),
    sheet: z.string(),
    cell: z.string(), // A1 ref, e.g. "B12"
  }),
  z.object({
    kind: z.literal("xlsx.namedRange"),
    /** The defined-name (workbook-scoped). */
    name: z.string(),
  }),
  z.object({
    kind: z.literal("xlsx.tableRow"),
    sheet: z.string(),
    /** Top-left cell of the first data row. */
    startCell: z.string(),
    /** Column offset for each per-row field — order matches the
     *  binding entries that share this target's `groupKey`. */
    column: z.string(),
  }),
]);

/**
 * For Word/PowerPoint templates. Token-style placeholders like
 * `{{role_pm_hours}}` are the simplest convention; bookmarks +
 * content controls land later.
 */
export const docxTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("docx.placeholder"),
    /** The placeholder token, including curly braces. */
    token: z.string(),
  }),
  z.object({
    kind: z.literal("docx.bookmark"),
    name: z.string(),
  }),
]);

export const targetSchema = z.union([xlsxTargetSchema, docxTargetSchema]);
export type BindingTarget = z.infer<typeof targetSchema>;

// ─── Binding entry + document ──────────────────────────────────────

export const bindingEntrySchema = z.object({
  /** Engine output field this entry pulls from. */
  field: z.string(),
  /** Where the value lands in the file. */
  target: targetSchema,
  /**
   * Optional grouping key — when an `xlsx.tableRow` target is split
   * across columns (e.g. one row per role with separate columns for
   * roleName / hoursLow / hoursHigh), shared `groupKey` tells the
   * filler "iterate the array once, write each entry across these
   * columns".
   */
  groupKey: z.string().optional(),
  /**
   * Optional formatter hint. Defaults to "auto" (numbers as numbers,
   * strings as strings, dates as ISO). "currency" uses the engine's
   * currency code; "percent" multiplies by 100 + appends '%'.
   */
  format: z
    .enum(["auto", "currency", "percent", "date", "iso", "list"])
    .optional(),
  /** Free-form note from the binding author / AI proposer. */
  note: z.string().optional(),
});

export type BindingEntry = z.infer<typeof bindingEntrySchema>;

export const bindingDocumentSchema = z.object({
  /** Schema version — bump when the spec breaks. */
  version: z.literal(1),
  /** Mirror of `Template.kind` so the filler can fast-path which
   *  engine to use. */
  templateKind: z.enum([
    "ESTIMATION",
    // Legacy generic deliverable kinds (back-compat for existing
    // bindings authored before per-type kinds landed).
    "DELIVERABLE_REPORT",
    "DELIVERABLE_PRESENTATION",
    // Per-deliverable-type kinds — match the `TemplateKind` enum
    // additions in the Prisma schema 1:1.
    "EXECUTIVE_SUMMARY",
    "ASSESSMENT_REPORT",
    "RISK_REGISTER",
    "TARGET_STATE",
    "ROADMAP",
    "TEAM_PROPOSAL",
    "ESTIMATE",
    "ASSUMPTIONS_GAPS",
    "SOW_DRAFT",
    "GREENFIELD_DISCOVERY",
  ]),
  entries: z.array(bindingEntrySchema),
  /**
   * Optional shared notes for the AI proposer's reasoning, the
   * approver's comments, etc. Not consumed by the filler.
   */
  notes: z.string().optional(),
});

export type BindingDocument = z.infer<typeof bindingDocumentSchema>;
