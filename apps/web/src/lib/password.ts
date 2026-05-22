import bcrypt from "bcryptjs";

// 12 rounds ≈ ~250ms per hash on a modern Mac. Slow enough to blunt brute-force
// attacks against a stolen database, fast enough that login latency is fine.
const BCRYPT_ROUNDS = 12;

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

export function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
