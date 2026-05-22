# ADR-0022: Agent credential vault — generalising ADR-0009 to arbitrary scopes

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Engineering
- **Related:**
  [ADR-0009](./0009-pat-per-engagement-credentials.md) (the
  per-engagement-PAT pattern this generalises),
  [ADR-0014](./0014-agent-harness-for-evidence-collection.md) §8
  (agent-tool credential contract).

## Context

ADR-0009 introduced **per-engagement PATs**: a GitHub token stored
on the `RepositoryLink` row, encrypted AES-256-GCM with
`REPO_CREDENTIAL_KEY`, decrypted at use-time inside the
`ingest-repository` worker.

Phase 4's agent harness needs the same shape but for more than just
GitHub:

- AWS assume-role ARN for cloud-evidence tools.
- Confluence / Jira API tokens for backlog scanning.
- Future scopes the harness adds without a new schema migration.

The harness also needs **just-in-time collection**: when a tool
needs a credential the engagement doesn't have yet, the run pauses
in `AWAITING_USER`, the UI prompts for the secret, and the run
resumes via `agentRun.submitCredential`.

We could shoehorn this onto `RepositoryLink`, but only the GitHub
ingest path lives there. We'd be polluting an integration table
with credentials that have nothing to do with repos.

## Decision

A new model `AgentCredential`, scoped on `(engagementId, scope)`,
holds the harness's credentials. Same crypto primitive
(`encryptCredential` / `decryptCredential`), same env key
(`REPO_CREDENTIAL_KEY`) — no new operational lever to manage.

Surface (`apps/web/src/server/services/agent/credentials.ts`):

- `getAgentCredential(db, engagementId, scope)` — resolve a non-
  expired, non-revoked row; return `null` otherwise. The harness
  calls this at step-dispatch time.
- `putAgentCredential(...)` — upsert on `(engagement, scope)`.
  Called by `agentRun.submitCredential` after the user fulfils an
  `AgentCredentialRequest`.
- `revokeAgentCredential(...)` — flag-based, not delete. Preserves
  the audit trail (who asked, when, who revoked).

Scope strings live in `credential-scopes.ts` as a closed enum
(`github_pat`, `aws_assume_role`, `confluence_token`, …) so the UI's
prompt copy and the harness's tool registry agree on names.

`RepositoryLink.encryptedPat` stays where it is. Migration is **not
forced** — the GitHub PAT is already used outside the harness
context (the `ingest-repository` worker doesn't go through the agent
trajectory) and consolidating now would force every repo-link reader
to detour through the vault. Future work can collapse the two if a
new caller wants the same secret from both surfaces.

## Alternatives considered

- **Extend `RepositoryLink` with a JSON `credentials` column.**
  Rejected — repos are one of many scope types and the table's name
  no longer fits. Schema search/visibility would also worsen.
- **Single workspace-level credential store.** Rejected — engagements
  are the access boundary the rest of the product uses. A workspace
  vault would let any engagement's run read another engagement's
  AWS keys; that's a customer-facing leak waiting to happen.
- **Store credentials in MinIO as encrypted blobs.** Rejected — the
  audit trail (who asked / fulfilled / revoked) belongs in
  Postgres next to the rest of the engagement state, and Postgres
  encryption-at-rest is already set up.
- **Use a third-party secrets manager (Vault, AWS SM).** Rejected
  for the MVP — the operational complexity isn't justified by the
  current credential volume. Easy to swap later: the surface above
  is a small interface around storage.

## Consequences

**Positive**

- New scopes are a string addition + a tool registration. No
  schema migration per credential type.
- One key, one rotation procedure across the whole product.
- Engagement-scoped by construction — the agent harness can never
  accidentally pull a credential from another engagement, because
  `getAgentCredential` requires the engagement id.
- Audit trail composes with the existing `AuditLog` rows for
  `AGENT_CREDENTIAL_REQUESTED`, `AGENT_CREDENTIAL_PROVIDED`,
  `AGENT_CREDENTIAL_REVOKED`.

**Negative**

- Two credential surfaces today (`RepositoryLink.encryptedPat` and
  `AgentCredential`). A future contributor adding a PAT-using tool
  has to choose; the convention is "agent harness uses
  `AgentCredential`, anything else uses the integration's own
  table". Documented here so the choice is explicit.
- Just-in-time collection adds UX surface area — the workflow popup
  has an `AWAITING_USER` state and a credential-prompt component.
  Worth it; documented in ADR-0017.
- Revoked rows accumulate. Mitigation: a future cleanup job can
  hard-delete revoked rows older than N days; the audit log keeps
  the history regardless.

**Neutral**

- The vault is engagement-scoped, not user-scoped. A different
  user on the same engagement reuses the credential the first user
  provided. This matches the rest of the product's authz model and
  is documented in the workflow-popup credential-prompt copy.

## Follow-ups

- Credential expiry surfaced in the UI before tool dispatch, so a
  run doesn't pause for a token the user already knows is dead.
- One-time-use scopes (e.g. `aws_session_token`) — the vault
  currently treats every row as long-lived; ephemeral scopes need
  a `singleUse: true` flag and a delete-on-consume helper.
