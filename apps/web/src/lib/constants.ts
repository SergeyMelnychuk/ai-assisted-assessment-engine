/** Assessment domains that the system can evaluate */
export const ASSESSMENT_DOMAINS = {
  business_context: "Business Context",
  functional_scope: "Functional Scope & Capabilities",
  architecture: "Architecture",
  security_iam: "Security & IAM",
  integrations_apis: "Integrations & APIs",
  cloud_infrastructure: "Cloud & Infrastructure",
  devops_cicd: "DevOps / CI-CD",
  observability: "Observability",
  nfrs: "Non-Functional Requirements",
  delivery_strategy: "Delivery Strategy",
  test_strategy: "Test Strategy",
  data_distribution: "Data Distribution",
  storage_persistence: "Storage & Persistence",
  infrastructure_maturity: "Infrastructure Maturity",
  team_governance: "Team & Governance",
  risks_constraints: "Risks & Constraints",
} as const;

export type DomainKey = keyof typeof ASSESSMENT_DOMAINS;

/** Maturity levels used for domain scoring */
export const MATURITY_LEVELS = {
  AD_HOC: { label: "Ad Hoc", value: 1, description: "No formal process or structure" },
  INITIAL: { label: "Initial", value: 2, description: "Basic processes exist but inconsistent" },
  DEFINED: { label: "Defined", value: 3, description: "Processes are documented and standardized" },
  MANAGED: { label: "Managed", value: 4, description: "Processes are measured and controlled" },
  OPTIMIZED: { label: "Optimized", value: 5, description: "Continuous improvement is embedded" },
} as const;

/** Confidence thresholds for AI-generated content */
export const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.8,
  MODERATE: 0.5,
  LOW: 0.3,
} as const;

/** Assessment stages in order */
export const ASSESSMENT_STAGES = [
  "SETUP",
  "INTAKE",
  "QUESTIONING",
  "ANALYSIS",
  "DRAFTING",
  "REVIEW",
  "COMPLETED",
] as const;

/** Industries for engagement classification */
export const INDUSTRIES = [
  "Financial Services",
  "Healthcare",
  "E-commerce / Retail",
  "Technology / SaaS",
  "Manufacturing",
  "Energy & Utilities",
  "Media & Entertainment",
  "Telecommunications",
  "Government / Public Sector",
  "Education",
  "Logistics & Transportation",
  "Real Estate",
  "Other",
] as const;
