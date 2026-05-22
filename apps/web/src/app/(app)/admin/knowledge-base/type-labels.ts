/**
 * Display metadata for every `KnowledgeArtifactType` enum value.
 * Shared between the admin list page (server component) and the editor
 * (client component) — extracted so both sides stay in sync.
 */
export const TYPE_LABELS: Record<
  string,
  { label: string; description: string; seedPath?: string }
> = {
  QUESTION_TEMPLATE: {
    label: "Question templates",
    description:
      "Baseline intake questions per domain — seed the initial question set on every new assessment.",
    seedPath: "packages/knowledge-seed/question-templates/*.json",
  },
  RISK_PATTERN: {
    label: "Risk patterns",
    description:
      "Reusable risk signatures fed into the analysis engine as prompt context.",
    seedPath: "packages/knowledge-seed/risk-patterns/*.json",
  },
  RECOMMENDATION_PATTERN: {
    label: "Recommendation patterns",
    description:
      "Matching patterns for common recommendations (paired with risk patterns).",
  },
  FRAMEWORK: {
    label: "Assessment frameworks",
    description:
      "Domain catalogs + 1-5 maturity rubrics used by the scoring service.",
    seedPath: "packages/knowledge-seed/frameworks/*.json",
  },
  CHECKLIST: {
    label: "Checklists",
    description: "Structured walk-throughs for specific review scenarios.",
  },
  TEMPLATE: {
    label: "Report templates",
    description:
      "Deliverable section/structure templates (see also assessment-report.json).",
  },
  HEURISTIC: {
    label: "Heuristics",
    description: "Rules of thumb that sharpen AI prompts.",
  },
  ROLE_CATALOG: {
    label: "Role catalogs",
    description:
      "Canonical role menu the estimation engine picks from when proposing a team.",
    seedPath: "packages/knowledge-seed/role-catalog/*.json",
  },
  RATE_CARD: {
    label: "Rate cards (artifacts)",
    description:
      "Historical rate-card snapshots. The live default is managed under Rate Cards.",
  },
  TECHNOLOGY_OPTION: {
    label: "Technology options",
    description: "Known-good tech choices with trade-offs.",
  },
  PLATFORM_GUIDANCE: {
    label: "Platform guidance",
    description: "Cloud/platform-specific best practices.",
  },
  CAPABILITY_MODEL: {
    label: "Capability models",
    description: "Domain capability maps for greenfield discoveries.",
  },
  SCORING_MODEL: {
    label: "Scoring models",
    description: "Alternate scoring rubrics beyond the standard framework.",
  },
  INDUSTRY_OVERLAY: {
    label: "Industry overlays",
    description: "Industry-specific question + risk adjustments.",
  },
  CLOUD_OVERLAY: {
    label: "Cloud overlays",
    description: "Provider-specific overrides (AWS/Azure/GCP flavours).",
  },
};

export const ARTIFACT_TYPES = [
  "FRAMEWORK",
  "CHECKLIST",
  "TEMPLATE",
  "HEURISTIC",
  "RISK_PATTERN",
  "RECOMMENDATION_PATTERN",
  "ROLE_CATALOG",
  "RATE_CARD",
  "TECHNOLOGY_OPTION",
  "PLATFORM_GUIDANCE",
  "CAPABILITY_MODEL",
  "SCORING_MODEL",
  "INDUSTRY_OVERLAY",
  "CLOUD_OVERLAY",
  "QUESTION_TEMPLATE",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
