/**
 * Shared, client-safe mapping from the snake_case domain keys stored in
 * `Assessment.activeDomains` / `Finding.domain` / `DomainScore.domain`
 * / `Recommendation.domain` / `Question.domain` to their human-readable
 * display labels.
 *
 * Source of truth: `apps/web/src/lib/constants.ts` (`ASSESSMENT_DOMAINS`),
 * which is aligned with the domain keys emitted by the scoring and
 * analysis prompts under `src/server/services/ai/prompts/*`. The two
 * should be kept in sync when a domain is added — but this helper also
 * falls back to a generic `snake_case → Title Case` beautifier so the
 * UI degrades gracefully if a new domain lands before the map catches up.
 *
 * Do NOT use this on raw-key props that feed React `key={…}` or backend
 * calls (tRPC inputs, URL query values). Only swap visible text.
 */

const DOMAIN_LABELS: Record<string, string> = {
  business_context: "Business Context", // ASSESSMENT_DOMAINS.business_context
  functional_scope: "Functional Scope & Capabilities", // ASSESSMENT_DOMAINS.functional_scope
  architecture: "Architecture", // ASSESSMENT_DOMAINS.architecture
  security_iam: "Security & IAM", // ASSESSMENT_DOMAINS.security_iam
  integrations_apis: "Integrations & APIs", // ASSESSMENT_DOMAINS.integrations_apis
  cloud_infrastructure: "Cloud & Infrastructure", // ASSESSMENT_DOMAINS.cloud_infrastructure
  devops_cicd: "DevOps & CI/CD", // ASSESSMENT_DOMAINS.devops_cicd
  observability: "Observability", // ASSESSMENT_DOMAINS.observability
  nfrs: "Non-Functional Requirements", // ASSESSMENT_DOMAINS.nfrs
  delivery_strategy: "Delivery Strategy", // ASSESSMENT_DOMAINS.delivery_strategy
  test_strategy: "Test Strategy", // ASSESSMENT_DOMAINS.test_strategy
  data_distribution: "Data Distribution", // ASSESSMENT_DOMAINS.data_distribution
  storage_persistence: "Storage & Persistence", // ASSESSMENT_DOMAINS.storage_persistence
  infrastructure_maturity: "Infrastructure Maturity", // ASSESSMENT_DOMAINS.infrastructure_maturity
  team_governance: "Team & Governance", // ASSESSMENT_DOMAINS.team_governance
  risks_constraints: "Risks & Constraints", // ASSESSMENT_DOMAINS.risks_constraints
};

/**
 * Return the human-readable label for a domain key. Unknown keys fall
 * back to a `snake_case → Title Case` beautifier — e.g. `foo_bar_baz`
 * becomes `Foo Bar Baz` — so the UI never prints a raw enum.
 */
export function domainLabel(key: string): string {
  if (!key) return "";
  const mapped = DOMAIN_LABELS[key];
  if (mapped) return mapped;
  return key
    .split("_")
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Stable list of every known domain key, in the canonical rubric order
 * used by the seed data. Intended for filter dropdowns — callers should
 * keep the raw key as the option `value` and render `domainLabel(key)`
 * as the visible label.
 */
export function knownDomains(): readonly string[] {
  return KNOWN_DOMAINS;
}

const KNOWN_DOMAINS: readonly string[] = Object.freeze(Object.keys(DOMAIN_LABELS));
