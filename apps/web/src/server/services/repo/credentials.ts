/**
 * Credential encryption for `RepositoryLink` (Phase 3 Week 6, ADR-0009).
 *
 * Personal Access Tokens (PATs) are the consultant's proof they can
 * read a repo. We never want them in plaintext at rest — an audit-log
 * leak, a DB snapshot sent to the wrong place, a casual `SELECT *`
 * from a reviewer's shell, any of those would expose org-wide code
 * access. AES-256-GCM gives us confidentiality *and* tamper-detection
 * via the auth tag.
 *
 * The key lives in `REPO_CREDENTIAL_KEY` — a 32-byte base64 string.
 * We deliberately do NOT derive from `NEXTAUTH_SECRET` (rejected in
 * ADR-0009): isolating the key means rotating one doesn't nuke
 * sessions, and a stolen session secret doesn't decrypt PATs.
 *
 * Fake-mode escape hatch: if the key is unset AND
 * `REPO_CREDENTIAL_MODE=fake`, we use a fixed test key so local dev
 * + CI can exercise the round-trip without a real secret. Any other
 * missing-key state throws — silent "encrypted with a zero key" is
 * the worst-of-both-worlds outcome.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV is the GCM sweet spot.
const KEY_BYTES = 32;
const TAG_BYTES = 16;

// Fixed 32-byte key used only when REPO_CREDENTIAL_MODE=fake. Never
// ship this on a live key — it's in the open source. Lets the smoke
// script + unit tests round-trip without piping a real secret.
const FAKE_KEY = Buffer.alloc(KEY_BYTES, 0x42);

export interface EncryptedCredential {
  /** AES-256-GCM ciphertext. Same byte length as plaintext. */
  ciphertext: Buffer;
  /** Randomly-generated 96-bit IV. */
  iv: Buffer;
  /** 128-bit GCM auth tag. Flipping a byte here throws on decrypt. */
  tag: Buffer;
}

/**
 * Resolve the symmetric key. Throws (loudly) if unset outside fake
 * mode — we refuse to silently encrypt with zeroes.
 */
function resolveKey(): Buffer {
  const raw = process.env.REPO_CREDENTIAL_KEY;
  if (!raw) {
    if (process.env.REPO_CREDENTIAL_MODE === "fake") {
      return FAKE_KEY;
    }
    throw new Error(
      "REPO_CREDENTIAL_KEY is not set. Generate a 32-byte base64 key " +
        "(`openssl rand -base64 32`) and set it in .env, or export " +
        "REPO_CREDENTIAL_MODE=fake for local/CI use.",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `REPO_CREDENTIAL_KEY must decode to ${KEY_BYTES} bytes, got ${buf.length}`,
    );
  }
  return buf;
}

export function encryptCredential(plain: string): EncryptedCredential {
  if (plain.length === 0) {
    throw new Error("Refusing to encrypt an empty credential");
  }
  const key = resolveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

export function decryptCredential(enc: EncryptedCredential): string {
  const key = resolveKey();
  if (enc.iv.length !== IV_BYTES) {
    throw new Error(`IV must be ${IV_BYTES} bytes, got ${enc.iv.length}`);
  }
  if (enc.tag.length !== TAG_BYTES) {
    throw new Error(`tag must be ${TAG_BYTES} bytes, got ${enc.tag.length}`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, enc.iv);
  decipher.setAuthTag(enc.tag);
  // `final()` throws if the tag doesn't match — exactly the tamper
  // detection we want. We wrap so the upstream caller sees a clean
  // classified error string, not the node-internal "Unsupported state"
  // text which leaks nothing useful.
  try {
    const plain = Buffer.concat([
      decipher.update(enc.ciphertext),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    throw new Error(
      "Failed to decrypt credential — auth tag mismatch or key rotation " +
        "without re-encrypting. Delete and re-create the repository link.",
    );
  }
}

/**
 * Scrub a value that might contain a PAT before it lands in an audit
 * log or error message. The classifier in `error-classifier.ts` calls
 * this on every RepositoryLink audit row's `details` payload.
 *
 * Implementation is deliberately broad: any GitHub-style PAT (classic
 * `ghp_…`, fine-grained `github_pat_…`) is replaced with `[redacted]`.
 * We stringify-and-regex so nested objects get scrubbed too — the
 * cost is one extra JSON round-trip per audit row, which is cheap at
 * our scale.
 */
export function scrubCredential<T>(details: T): T {
  if (details === null || details === undefined) return details;
  const json = JSON.stringify(details);
  const scrubbed = json
    // GitHub classic + fine-grained PATs.
    .replace(/gh[pousr]_[A-Za-z0-9]{20,255}/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]{20,255}/g, "[redacted]")
    // Generic `Authorization: Bearer <token>` pairs if any sneak in.
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "$1[redacted]");
  return JSON.parse(scrubbed) as T;
}
