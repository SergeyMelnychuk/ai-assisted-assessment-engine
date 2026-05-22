# ADR-0009: Repository credentials — PAT per engagement, encrypted at rest

- **Status:** Accepted
- **Date:** 2026-04-18
- **Deciders:** Serhii Melnychuk (project lead), Claude agents during Phase 3 build
- **Related:** ADR-0010 (tarball API), `docs/design/phase-3-roadmap.md` §Week 6

## Context

Week 6 links a remote GitHub repository to an Assessment and ingests
its code into the same Evidence pipeline Week 3 built. To do that the
worker needs to authenticate against GitHub. The engagement model is
"one consulting team, one client's codebase for a bounded project" —
so the credential flavour has to match:

- Credentials are per-engagement, not per-user (a review needs to
  replay the same read view; a user-scoped OAuth token vanishes if the
  user rotates off).
- Credentials may be long-lived enough to survive a re-sync a week
  later, but short-lived enough that a leaked DB row is recoverable by
  rotating **one** token.
- The worker is headless — interactive OAuth dances, device-flow
  prompts, or browser redirects don't fit into a BullMQ job.
- We can't take a runtime dependency on the host client's GitHub App
  installation; MVP customers don't want to approve a vendor app on
  their org just to run an assessment.

Three credential families were plausible: a **PAT typed per link**, a
**per-user OAuth token**, and a **GitHub App installation per
customer org**. Each is the right answer eventually for some
customer — the question is which one ships in the MVP.

## Decision

Use **a Personal Access Token (PAT) per engagement**, encrypted at
rest with AES-256-GCM using a dedicated symmetric key
(`REPO_CREDENTIAL_KEY`). The consultant pastes the PAT once when
creating the first repository link; the plaintext is immediately
encrypted and stored in the engagement-scoped credential vault. Every
later repository link in the same engagement reuses the vault entry —
no duplicate encrypted blobs.

> **Update (2026-05-06, Phase 4 Slice 3 — PAT consolidation).** The
> original ADR proposed a per-`RepositoryLink` PAT (one encrypted
> blob per link row). Phase 4 introduced the engagement-scoped
> `AgentCredential` vault for the agent harness; we consolidated the
> two stores rather than maintain parallel encrypted columns. New
> shape: `AgentCredential` table holds the PAT (one row per
> `(engagementId, scope="github.pat")`); `RepositoryLink.agent_credential_id`
> FK points to it. The legacy in-row encrypted columns
> (`encryptedCredentials`, `credentialsIv`, `credentialsTag`) were
> backfilled into the vault and dropped in migration
> `20260427201500_drop_legacy_pat_cols`. The crypto primitives below
> are unchanged — both the historical RepositoryLink path and the
> new vault path use the same `encryptCredential` / `decryptCredential`
> helpers and the same `REPO_CREDENTIAL_KEY` env, so rotation stays
> a single operational lever.

Concrete shape (post-consolidation):

- Schema (Prisma migrations
  `20260420000000_repository_link` → `20260424212757_add_agent_credential_vault`
  → `20260427195835_workflow_steps_and_pat_consolidation` →
  `20260427201500_drop_legacy_pat_cols`):
  `AgentCredential { engagementId, scope, encryptedSecret Bytes,
  secretIv Bytes, secretTag Bytes, … }` keyed unique on
  `(engagementId, scope)`. `RepositoryLink { agent_credential_id String?, … }`
  — no plaintext, no in-row encrypted columns.
- Key source: `REPO_CREDENTIAL_KEY` — 32 bytes base64-encoded, loaded
  from the process env. **Not** derived from `NEXTAUTH_SECRET`.
  Rotating one must not invalidate the other.
- Encryption primitive:
  [`apps/web/src/server/services/repo/credentials.ts`](../../../apps/web/src/server/services/repo/credentials.ts)
  — `encryptCredential(plain)` / `decryptCredential({ciphertext, iv,
  tag})`. 96-bit random IV per call, 128-bit auth tag, tamper detection
  via GCM.
- Fake-mode escape hatch: if `REPO_CREDENTIAL_KEY` is unset **and**
  `REPO_CREDENTIAL_MODE=fake`, a fixed test key is used so local dev
  and CI can exercise the round-trip without a real secret. Any other
  missing-key state throws loudly — silent "encrypted with zeroes" is
  the worst-of-both-worlds outcome.
- Audit-log discipline:
  [`scrubCredential(details)`](../../../apps/web/src/server/services/repo/credentials.ts)
  is the only path that writes `RepositoryLink`-adjacent audit rows;
  it strips any field named `pat`, `token`, `credentials`,
  `authorization`, or matching the `ghp_…` / `github_pat_…` patterns.
  A unit test with a known test PAT asserts the raw string never
  appears in the stringified `details`.

## Alternatives considered

- **Per-user OAuth token (GitHub Apps user-to-server flow).**
  Rejected for MVP because (a) it requires a GitHub App registered
  with the vendor's identity — a one-way install that a prospective
  customer can't complete in a sales demo, (b) the token lives on the
  user, so a reviewer logging in weeks later can't resync the same
  link without interactive reauth, (c) revoking the consultant's
  company SSO would silently break every open engagement's code
  evidence.
- **GitHub App installation per customer org** (server-to-server JWT,
  rotating installation token). The **right** long-term answer for
  enterprise customers — granular repo-level permissions, audit trail
  on GitHub's side, no user-bound surface area. Rejected for MVP
  because installing a GitHub App touches customer IT and slows sales
  to a crawl. Written into the follow-ups below as the next step once
  we have two or three reference customers.
- **Credential key derived from `NEXTAUTH_SECRET`.** Rejected because
  the threat models are different — `NEXTAUTH_SECRET` signs session
  JWTs, `REPO_CREDENTIAL_KEY` decrypts PATs. A compromise of one
  shouldn't unlock the other, and rotation cadence is different (auth
  secret rarely; credential key on any suspicion of DB leak).
- **Plaintext in DB, rely on row-level authz.** Rejected on first
  principles — a DB snapshot sent to the wrong place, a casual
  `SELECT *`, or a log of a failing query all become PAT exfiltration.
  Encryption at rest is table stakes for a credential column.
- **Application-level hashing (one-way).** Doesn't work: the worker
  needs to *present* the PAT to GitHub, so we need reversibility, not
  comparison.

## Consequences

- **Positive.** The MVP ships without any customer-side configuration
  on GitHub's side. A consultant pastes a PAT, clicks Save, and ingest
  starts. Zero vendor-app install friction.
- **Positive.** Each `RepositoryLink` carries its own PAT — rotating
  one link's token doesn't touch any other link. Scoping the blast
  radius of a leak to a single engagement is the whole point.
- **Positive.** AES-256-GCM's auth tag gives us tamper detection for
  free — flipping a ciphertext byte throws on decrypt, which means a
  malicious DB edit doesn't let an attacker swap in their own PAT
  silently.
- **Negative.** The consultant is responsible for the PAT's scope. We
  document "read-only, single-repo" in the UI but can't enforce it.
  Future GitHub App path solves this.
- **Negative.** Key management is now a deployment concern —
  `REPO_CREDENTIAL_KEY` has to be generated, stored in whatever secret
  store the deploy uses, and rotated. Documented in the runbook; not
  automated in MVP.
- **Negative.** PATs expire. We don't proactively warn the consultant
  before a token's expiry; the first re-sync after expiry surfaces a
  classified `REPO_AUTH_FAILED` error and prompts for a new PAT. Good
  enough for MVP; expiry reminders are a polish item.
- **Neutral.** `credentials.ts` is the single choke point — anything
  that touches a PAT goes through `encryptCredential` /
  `decryptCredential` / `scrubCredential`. Adding a new provider
  (GitLab, Bitbucket) reuses the same three functions.

## Follow-ups

- [ ] Post-roadmap — register a GitHub App, keep PATs as a fallback
      auth method, migrate large customers to app installation.
- [ ] Post-roadmap — credential-expiry warning (`lastValidatedAt` +
      background probe on re-sync schedule).
- [ ] Post-roadmap — key rotation runbook: re-encrypt all rows under a
      new `REPO_CREDENTIAL_KEY` with the old key still readable during
      the cutover.
- [ ] Deploy runbook — document that `REPO_CREDENTIAL_KEY` is
      mandatory in prod; CI uses `REPO_CREDENTIAL_MODE=fake`.

## References

- `apps/web/src/server/services/repo/credentials.ts`
- `apps/web/src/server/services/repo/credentials.test.ts` — tamper
  detection + secret-scan assertion
- `apps/web/prisma/migrations/20260420000000_repository_link/migration.sql`
- `docs/design/phase-3-roadmap.md` §Week 6
- ADR-0010 — tarball-API provider choice (the caller side of this ADR)
