// The admin password credential pair: a random password (shown once) and the
// PBKDF2 hash that becomes the PASSWORD_HASH Worker secret.
//
// Run directly to mint a fresh pair without touching Cloudflare:
//   npx tsx scripts/hash-password.ts            # random password
//   npx tsx scripts/hash-password.ts <password> # hash a chosen one
//
// `npm run set-password` wraps this and uploads the result.

import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  MAX_PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS,
  PBKDF2_KEY_BYTES,
  PBKDF2_SALT_BYTES,
} from "@shared/password.ts";

// Base58: unambiguous when read off a screen and retyped.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PASSWORD_LENGTH = 24;

/**
 * A random base58 password.
 *
 * Bytes at or above `limit` are discarded rather than folded with `%`, which
 * would make the first few characters of the alphabet more likely than the rest.
 */
export function generatePassword(): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  const chars: string[] = [];
  while (chars.length < PASSWORD_LENGTH) {
    // Over-draw so the common case needs a single pass even after rejections.
    const draw = randomBytes(PASSWORD_LENGTH * 2);
    for (const byte of draw) {
      if (byte >= limit || chars.length >= PASSWORD_LENGTH) continue;
      chars.push(ALPHABET.charAt(byte % ALPHABET.length));
    }
  }
  return chars.join("");
}

// base64url, so the whole envelope is safe in a URL, a header, or a shell
// argument without any escaping.
const encode = (b: Buffer): string => b.toString("base64url");

/**
 * Hashes a password into the PASSWORD_HASH storage format (see shared/password.ts).
 *
 * Refuses a cost above what deployed workerd derives: such a hash verifies fine
 * here and locks the owner out of the admin UI in production.
 */
export function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): string {
  if (iterations > MAX_PBKDF2_ITERATIONS) {
    throw new RangeError(
      `PBKDF2 iterations above ${String(MAX_PBKDF2_ITERATIONS)} are not supported by deployed Workers`,
    );
  }
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const hash = pbkdf2Sync(password, salt, iterations, PBKDF2_KEY_BYTES, "sha256");
  return `pbkdf2$sha256$${String(iterations)}$${encode(salt)}$${encode(hash)}`;
}

/** Constant-time verification of a password against a stored hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 5) return false;
  const [scheme, digest, iterationsRaw, saltRaw, hashRaw] = parts;
  if (scheme !== "pbkdf2" || digest !== "sha256") return false;

  const iterations = Number(iterationsRaw);
  if (!Number.isSafeInteger(iterations) || iterations <= 0) return false;

  const salt = Buffer.from(saltRaw ?? "", "base64url");
  const expected = Buffer.from(hashRaw ?? "", "base64url");
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = pbkdf2Sync(password, salt, iterations, expected.length, "sha256");
  return timingSafeEqual(actual, expected);
}

// Only print when run as a script. Importing this module (from set-password.ts
// or the unit tests) must have no side effects.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const password = process.argv[2] ?? generatePassword();
  console.log(`password: ${password}`);
  console.log(`hash:     ${hashPassword(password)}`);
}
