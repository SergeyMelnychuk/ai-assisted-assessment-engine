import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptCredential,
  encryptCredential,
  scrubCredential,
} from "./credentials";

/**
 * Week 6 (ADR-0009) — encryption round-trip + tamper detection.
 *
 * The happy-path test uses fake-mode (REPO_CREDENTIAL_MODE=fake) so
 * CI doesn't need a real key. The "missing key" test clears both and
 * asserts the service fails loud rather than defaulting to zeroes.
 */
describe("credentials", () => {
  const ORIGINAL_KEY = process.env.REPO_CREDENTIAL_KEY;
  const ORIGINAL_MODE = process.env.REPO_CREDENTIAL_MODE;

  beforeEach(() => {
    delete process.env.REPO_CREDENTIAL_KEY;
    process.env.REPO_CREDENTIAL_MODE = "fake";
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.REPO_CREDENTIAL_KEY;
    } else {
      process.env.REPO_CREDENTIAL_KEY = ORIGINAL_KEY;
    }
    if (ORIGINAL_MODE === undefined) {
      delete process.env.REPO_CREDENTIAL_MODE;
    } else {
      process.env.REPO_CREDENTIAL_MODE = ORIGINAL_MODE;
    }
  });

  it("round-trips a PAT unchanged", () => {
    const plain = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const enc = encryptCredential(plain);
    expect(enc.ciphertext.length).toBeGreaterThan(0);
    expect(enc.iv.length).toBe(12);
    expect(enc.tag.length).toBe(16);
    // Ciphertext must not contain the plaintext anywhere.
    expect(enc.ciphertext.toString("utf8")).not.toContain(plain);
    expect(decryptCredential(enc)).toBe(plain);
  });

  it("produces a different IV each call (non-deterministic)", () => {
    const a = encryptCredential("ghp_samevalue_1234567890abcdef1234");
    const b = encryptCredential("ghp_samevalue_1234567890abcdef1234");
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("detects tamper: flipping a ciphertext byte throws", () => {
    const enc = encryptCredential("ghp_realtoken_ABCDEFGHIJKLMNOPQRST");
    const tampered = {
      ...enc,
      ciphertext: Buffer.from(enc.ciphertext),
    };
    tampered.ciphertext[0] ^= 0x01;
    expect(() => decryptCredential(tampered)).toThrow(/auth tag mismatch/i);
  });

  it("detects tamper: flipping the auth tag throws", () => {
    const enc = encryptCredential("ghp_realtoken_ABCDEFGHIJKLMNOPQRST");
    const tampered = { ...enc, tag: Buffer.from(enc.tag) };
    tampered.tag[0] ^= 0xff;
    expect(() => decryptCredential(tampered)).toThrow(/auth tag mismatch/i);
  });

  it("fails loudly when REPO_CREDENTIAL_KEY is unset outside fake mode", () => {
    delete process.env.REPO_CREDENTIAL_KEY;
    delete process.env.REPO_CREDENTIAL_MODE;
    expect(() => encryptCredential("x")).toThrow(/REPO_CREDENTIAL_KEY/);
  });

  it("rejects an empty credential up-front", () => {
    expect(() => encryptCredential("")).toThrow(/empty credential/i);
  });

  describe("scrubCredential", () => {
    it("redacts a classic GitHub PAT from a nested details payload", () => {
      const pat = "ghp_TESTABCDEFGHIJKLMNOPQRSTUVWXYZ01";
      const details = {
        action: "CREATE",
        nested: { body: `Authorization: token ${pat}` },
        other: "nothing sensitive",
      };
      const scrubbed = scrubCredential(details);
      expect(JSON.stringify(scrubbed)).not.toContain(pat);
      expect(scrubbed.other).toBe("nothing sensitive");
    });

    it("redacts a fine-grained github_pat_ token", () => {
      const pat =
        "github_pat_11ABCDEFG0ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghij";
      const scrubbed = scrubCredential({ token: pat });
      expect(JSON.stringify(scrubbed)).not.toContain(pat);
    });

    it("redacts Bearer tokens in freeform strings", () => {
      const scrubbed = scrubCredential({
        header: "Bearer abcdefghij1234567890ABCDEFGH",
      });
      expect(JSON.stringify(scrubbed)).toMatch(/\[redacted\]/);
    });

    it("passes through primitives + nullish values", () => {
      expect(scrubCredential(null)).toBeNull();
      expect(scrubCredential(undefined)).toBeUndefined();
      expect(scrubCredential({ n: 5 })).toEqual({ n: 5 });
    });
  });
});
