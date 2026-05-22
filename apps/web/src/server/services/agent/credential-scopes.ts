/**
 * Credential-scope catalog — ADR-0014 §8.
 *
 * Scopes are the stable string identifiers tools declare via
 * `requiresCredentials`, and that the vault keys its rows on. Keeping
 * them in one file (a) gives the planner a closed set to reason over,
 * (b) gives the UI a place to look up human-readable labels for the
 * credential-request modal, and (c) makes adding a new adapter a one-
 * file delta the executor picks up for free.
 *
 * Slice 1 lists only `github.pat`. The shape supports AWS / GCP / CI
 * additions without schema changes — Slice 2+ lands them.
 */

/**
 * What the UI needs to render a "please provide this credential" ask
 * without a round-trip to the backend. `provider` groups scopes by
 * SaaS / platform so the modal can show a single icon and label.
 * `secretKind` tells the UI what widget to render (password vs. ARN
 * vs. JSON upload) and what to validate shape-wise before submit.
 */
export interface CredentialScopeSpec {
  /** Stable id — e.g. "github.pat". Matches `AgentCredential.scope`. */
  id: string;
  /** Grouping for the modal ("GitHub", "AWS"). */
  provider: string;
  /** One-line label shown in the modal header. */
  label: string;
  /** One or two sentences describing what and why, shown under the header. */
  description: string;
  /** Drives the input widget: `password` masks, `arn` shows a mono-space
   *  text field, `json` shows a textarea with JSON hint. */
  secretKind: "password" | "arn" | "json";
  /**
   * Provider-side scopes the user must grant when minting the secret.
   * Presented as a bullet list so the user knows what to tick when
   * creating a fine-grained PAT or assume-role policy.
   */
  recommendedScopes: readonly string[];
  /**
   * Documentation anchor the modal deep-links to ("how do I create
   * this?"). Relative to the admin guides root.
   */
  docHref?: string;
  /**
   * Default TTL in hours. `undefined` means "no expiry unless the
   * caller sets one". Scopes for high-blast-radius creds (cloud role
   * ARNs) should set this; a PAT typically doesn't.
   */
  defaultTtlHours?: number;
}

/**
 * Registry of every credential scope the harness understands. New
 * adapters add entries here.
 */
export const CREDENTIAL_SCOPES = {
  "github.pat": {
    id: "github.pat",
    provider: "GitHub",
    label: "GitHub personal access token",
    description:
      "Used by the agent's repository and CI tools to read repositories, " +
      "directory listings, file contents, and workflow run history in " +
      "the engagement's GitHub org. Read-only — no write operations are " +
      "performed.",
    secretKind: "password",
    recommendedScopes: [
      "repo:read",
      "workflow:read",
      "actions:read",
      "metadata:read",
    ],
    docHref: "/admin/guides/ai-router#autonomous-evidence-collection",
    defaultTtlHours: 24,
  },
} as const satisfies Record<string, CredentialScopeSpec>;

/** Compile-time union of every registered scope id. */
export type CredentialScopeId = keyof typeof CREDENTIAL_SCOPES;

/** Runtime guard — `true` if the argument is a registered scope id. */
export function isKnownCredentialScope(
  scope: string,
): scope is CredentialScopeId {
  return Object.prototype.hasOwnProperty.call(CREDENTIAL_SCOPES, scope);
}

/**
 * Look up a scope spec by id. Throws (loudly) on unknown scopes — this
 * is always a programming error (the registry is authoritative) rather
 * than user input, so a cheap crash here beats "silent empty modal".
 */
export function getCredentialScope(scope: string): CredentialScopeSpec {
  if (!isKnownCredentialScope(scope)) {
    throw new Error(
      `Unknown credential scope: ${scope}. Register it in credential-scopes.ts.`,
    );
  }
  return CREDENTIAL_SCOPES[scope];
}
