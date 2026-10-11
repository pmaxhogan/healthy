/**
 * Sortable opaque row ids.
 *
 * The format is ULID: 26 characters of Crockford base32, the first 10 encoding
 * a 48-bit millisecond timestamp and the last 16 encoding 80 random bits. Two
 * properties earn it over a UUIDv4:
 *
 *   - lexicographic order is chronological order, so `ORDER BY id` is a free
 *     index on creation time for `mcp_audit` and `run_log`
 *   - it is a single case-insensitive token with no punctuation, so it is safe
 *     in a URL path, an HTML attribute and a log line untouched
 *
 * Randomness comes from `crypto.getRandomValues`, which both workerd and Node
 * provide. There is no monotonic counter: ids minted in the same millisecond
 * sort arbitrarily among themselves, which is fine for every column that uses
 * one (nothing depends on intra-millisecond ordering).
 */

import { AppError } from "./errors.ts";

// Crockford base32: no I, L, O or U, so an id read aloud or retyped cannot be
// ambiguous and cannot accidentally spell a word.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10;

/** The shape every id this module mints has. */
export const ID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

/** Largest millisecond timestamp the 48-bit time field can hold (year 10889). */
const MAX_TIME_MS = 2 ** 48 - 1;

function encodeTime(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIME_MS) {
    throw new AppError("internal", "timestamp out of range for an id");
  }
  let value = ms;
  let out = "";
  for (let index = 0; index < TIME_CHARS; index++) {
    out = ALPHABET.charAt(value % 32) + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = "";
  for (let index = 0; index < RANDOM_CHARS; index++) {
    out = ALPHABET.charAt(Number(bits & 31n)) + out;
    bits >>= 5n;
  }
  return out;
}

/**
 * Mint a new id. `atMs` exists so a test can pin the time half; production
 * callers leave it alone.
 */
export function newId(atMs: number = Date.now()): string {
  return encodeTime(atMs) + encodeRandom();
}

/**
 * A high-entropy opaque token, lower-case hex.
 *
 * For the values whose only job is to be unguessable -- an OAuth `state`, a PKCE
 * verifier, a CSRF token, a lease owner. Deliberately *not* a sortable id: those
 * leak their creation time, and 80 bits of randomness is less than a CSRF token
 * should carry. At the default length the result is 64 characters, which the log
 * redactor recognises as opaque and collapses.
 */
export function newToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The millisecond timestamp encoded in an id.
 *
 * Useful for asserting ordering in tests and for reading the age of an audit row
 * without a second column. Throws on anything that is not one of our ids.
 */
export function idTimeMs(id: string): number {
  if (!ID_PATTERN.test(id)) throw new AppError("bad_request", "not a sortable id");
  let value = 0;
  for (const char of id.slice(0, TIME_CHARS)) value = value * 32 + ALPHABET.indexOf(char);
  return value;
}
