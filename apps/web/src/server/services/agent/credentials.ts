/**
 * Agent credential vault — ADR-0014 §8, ADR-0009 pattern.
 *
 * Engagement-scoped encrypted store for the secrets agent tools need
 * to read external systems (GitHub PATs, AWS assume-role ARNs, …).
 * Reuses the exact crypto primitive (`encryptCredential` /
 * `decryptCredential`) that already protects `RepositoryLink` PATs —
 * same AES-256-GCM, same `REPO_CREDENTIAL_KEY` env — so key rotation
 * stays a single operational lever.
 *
 * Surface (deliberately small):
 *   - `getAgentCredential(db, engagementId, scope)` — resolve a secret
 *     if a non-expired, non-revoked row exists; otherwise null. The
 *     harness calls this at step-dispatch time.
 *   - `putAgentCredential(...)` — upsert on (engagement, scope). Used
 *     by the tRPC `agentRun.submitCredential` mutation after the user
 *     fulfills an `AgentCredentialRequest`.
 *   - `revokeAgentCredential(...)` — mark a row revoked without
 *     deleting it, preserving the audit trail.
 *
 * What this module does *not* do:
 *   - Decide whether a request is needed — that's the executor's job.
 *     Callers here always pass a known scope.
 *   - Accept plaintext in audit logs or returned shapes — decrypted
 *     secrets leave the module only via the returned string from
 *     `getAgentCredential`, and never via a lifecycle metadata object.
 */

import type { PrismaClient, Prisma } from "@prisma/client";
import {
  encryptCredential,
  decryptCredential,
  type EncryptedCredential,
} from "@/server/services/repo/credentials";
import {
  getCredentialScope,
  isKnownCredentialScope,
} from "./credential-scopes";

/**
 * Resolved credential handed back to the executor. `secret` is the
 * decrypted plaintext — callers MUST NOT persist it or stitch it into
 * any log/audit payload. `metadata` is the non-secret sidecar (org
 * name, account id, expires hint) the UI uses for display.
 */
export interface ResolvedAgentCredential {
  scope: string;
  secret: string;
  metadata: Record<string, unknown> | null;
  expiresAt: Date | null;
}

/**
 * Fetch the active credential for (engagement, scope) and decrypt.
 * Returns `null` when no row exists, the row is revoked, or the row
 * has expired. The harness treats a null return as "open a
 * CredentialRequest and pause" — it MUST NOT fall back to a lesser
 * credential or a zero key.
 */
export async function getAgentCredential(
  db: PrismaClient,
  engagementId: string,
  scope: string,
): Promise<ResolvedAgentCredential | null> {
  if (!isKnownCredentialScope(scope)) {
    // The scope registry is authoritative — an unknown scope here means
    // a tool declared something that isn't registered, which is a
    // programming error, not a user-fixable state.
    throw new Error(`Unknown credential scope: ${scope}`);
  }
  const row = await db.agentCredential.findUnique({
    where: { engagementId_scope: { engagementId, scope } },
  });
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  const enc: EncryptedCredential = {
    ciphertext: Buffer.from(row.encryptedSecret),
    iv: Buffer.from(row.secretIv),
    tag: Buffer.from(row.secretTag),
  };
  const secret = decryptCredential(enc);
  return {
    scope: row.scope,
    secret,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
    expiresAt: row.expiresAt,
  };
}

export interface PutAgentCredentialInput {
  engagementId: string;
  scope: string;
  secret: string;
  createdById: string;
  /** Non-secret sidecar — must never be used to carry the secret itself. */
  metadata?: Record<string, unknown>;
  /**
   * Absolute expiry. When omitted we apply the scope's `defaultTtlHours`
   * (if any). Pass `null` explicitly to force "no expiry" — rare, and
   * the caller should be sure.
   */
  expiresAt?: Date | null;
}

/**
 * Encrypt a new secret and upsert on (engagement, scope). Overwriting
 * is intentional: rotating a PAT should not produce a second row.
 * Callers are expected to wrap this in an audit-log write.
 */
export async function putAgentCredential(
  db: PrismaClient,
  input: PutAgentCredentialInput,
): Promise<{ id: string; expiresAt: Date | null }> {
  const spec = getCredentialScope(input.scope);
  const enc = encryptCredential(input.secret);

  let expiresAt: Date | null;
  if (input.expiresAt === null) {
    expiresAt = null;
  } else if (input.expiresAt) {
    expiresAt = input.expiresAt;
  } else if (spec.defaultTtlHours !== undefined) {
    expiresAt = new Date(Date.now() + spec.defaultTtlHours * 3600_000);
  } else {
    expiresAt = null;
  }

  const row = await db.agentCredential.upsert({
    where: {
      engagementId_scope: {
        engagementId: input.engagementId,
        scope: input.scope,
      },
    },
    create: {
      engagementId: input.engagementId,
      scope: input.scope,
      encryptedSecret: new Uint8Array(enc.ciphertext),
      secretIv: new Uint8Array(enc.iv),
      secretTag: new Uint8Array(enc.tag),
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      createdById: input.createdById,
      expiresAt,
    },
    update: {
      encryptedSecret: new Uint8Array(enc.ciphertext),
      secretIv: new Uint8Array(enc.iv),
      secretTag: new Uint8Array(enc.tag),
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      createdById: input.createdById,
      expiresAt,
      // Rotating a secret implicitly un-revokes — a revoked row that
      // gets re-granted is back in use. If the UX later diverges (e.g.
      // explicit re-grant required) this flips to null-preserving.
      revokedAt: null,
      revokedById: null,
    },
    select: { id: true, expiresAt: true },
  });
  return row;
}

/**
 * Mark a credential revoked without deleting it. The executor's
 * `getAgentCredential` treats revoked rows as missing; the row stays
 * on disk so the audit trail of "this PAT was used during run X"
 * remains readable.
 */
export async function revokeAgentCredential(
  db: PrismaClient,
  engagementId: string,
  scope: string,
  revokedById: string,
): Promise<void> {
  await db.agentCredential.updateMany({
    where: { engagementId, scope, revokedAt: null },
    data: { revokedAt: new Date(), revokedById },
  });
}
