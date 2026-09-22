// The admin password gate: PBKDF2-SHA256 verification of the PASSWORD_HASH
// secret, in WebCrypto so it runs unchanged in workerd.
//
// The envelope format and its cost parameters live in shared/password.ts,
// because the Node script that mints the hash (scripts/hash-password.ts) and
// this verifier must agree and neither may import the other.

import {
  PASSWORD_HASH_PATTERN,
  PBKDF2_ITERATIONS,
  PBKDF2_KEY_BYTES,
  PBKDF2_SALT_BYTES,
} from "@shared/password.ts";

import { b64urlDecode, b64urlEncode, timingSafeEqual, utf8, type Bytes } from "./primitives.ts";

/**
 * Hashes below this cost are refused outright rather than verified.
 *
 * A stored hash carries its own iteration count, which is what lets the cost be
 * raised without invalidating the deployed secret -- but it also means an
 * attacker who can write PASSWORD_HASH could downgrade it to one iteration.
 * This floor makes that rewrite useless, and catches a hash minted by an older
 * or hand-rolled tool at a cost that is no longer acceptable.
 */
export const MIN_PBKDF2_ITERATIONS = 100_000;

/**
 * The most iterations this runtime will actually derive.
 *
 * Deployed workerd caps PBKDF2 at 100,000 and *throws* above it -- "iteration
 * counts above 100000 are not supported" -- while the workerd the vitest pool runs
 * accepts far more. That asymmetry is how a 600,000-iteration PASSWORD_HASH passed
 * every test and then 500'd the first real login (2026-09-22). Nothing local can
 * reproduce the throw, so the cap is asserted here as a value instead: see
 * `isCostUnsupported`, which turns it into a diagnosis the owner can read.
 *
 * Equal to the floor, which makes the cost of a valid hash exactly one number.
 * Raising either without proving a real deploy derives at the new cost is how the
 * same incident happens twice.
 */
export const MAX_PBKDF2_ITERATIONS = 100_000;

/**
 * Digests shorter than this are refused too, for a subtler reason.
 *
 * PBKDF2's output is a prefix: the first 16 bytes derived for a 16-byte key are
 * byte-for-byte the first 16 bytes derived for a 32-byte one. So a stored hash
 * *truncated* to a few bytes still verifies against the right password -- while
 * being brute-forceable in seconds. A 128-bit floor makes a truncated envelope a
 * hard failure instead of a silent downgrade.
 */
const MIN_DIGEST_BYTES = 16;

interface ParsedHash {
  iterations: number;
  salt: Bytes;
  expected: Bytes;
}

/**
 * Splits the `pbkdf2$sha256$<iter>$<salt>$<hash>` envelope, or returns null.
 *
 * Everything structural is rejected here -- wrong scheme, wrong digest,
 * unparseable cost, an iteration count under {@link MIN_PBKDF2_ITERATIONS},
 * undecodable base64url, empty salt or hash -- so the one place that derives a
 * key only ever sees well-formed input.
 */
function parseStoredHash(stored: string): ParsedHash | null {
  if (!PASSWORD_HASH_PATTERN.test(stored)) return null;
  const [scheme, digest, iterationsRaw, saltRaw, hashRaw] = stored.split("$", 5);
  if (scheme !== "pbkdf2" || digest !== "sha256") return null;

  const iterations = Number(iterationsRaw);
  if (!Number.isSafeInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS) return null;

  const salt = b64urlDecode(saltRaw ?? "");
  const expected = b64urlDecode(hashRaw ?? "");
  return !salt || !expected || salt.length < PBKDF2_SALT_BYTES || expected.length < MIN_DIGEST_BYTES
    ? null
    : { iterations, salt, expected };
}

/**
 * True when `stored` is well formed but names a cost this runtime cannot derive.
 *
 * Deliberately narrow. A missing, malformed or too-cheap PASSWORD_HASH is a failed
 * login and nothing more -- saying otherwise tells an attacker about the
 * deployment. This one case is different: the secret is exactly what the minting
 * script produced, the owner's password is right, and the only possible outcome is
 * a 500 on every attempt. That is a misconfiguration to report, not a refusal.
 */
export function isCostUnsupported(stored: string): boolean {
  if (!PASSWORD_HASH_PATTERN.test(stored)) return false;
  const iterations = Number(stored.split("$", 5)[2]);
  return Number.isSafeInteger(iterations) && iterations > MAX_PBKDF2_ITERATIONS;
}

async function deriveBits(
  password: string,
  salt: Bytes,
  iterations: number,
  lengthBytes: number,
): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Mints a hash in the PASSWORD_HASH storage format.
 *
 * The Worker never needs this at runtime -- `npm run set-password` mints the
 * real secret in Node -- but the tests do, and a verifier tested only against
 * hashes from a *different* implementation is not testing much. Keeping both
 * halves in one module is also what guarantees they cannot drift.
 */
export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await deriveBits(password, salt, iterations, PBKDF2_KEY_BYTES);
  return `pbkdf2$sha256$${String(iterations)}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

/**
 * Verifies `password` against a stored envelope in constant time.
 *
 * Returns false -- never throws -- for every kind of malformed input, so a
 * corrupted secret reads as a wrong password rather than a 500 that tells an
 * attacker the secret is broken.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const actual = await deriveBits(password, parsed.salt, parsed.iterations, parsed.expected.length);
  return timingSafeEqual(actual, parsed.expected);
}
