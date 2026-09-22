/**
 * App-layer encryption for the `_enc` columns.
 *
 * Envelope: `v1:` + base64url(iv(12) || ciphertext||tag), AES-GCM-256, key from
 * the `DATA_KEY` secret (base64 of 32 bytes).
 *
 * The AAD is not decoration. It binds a ciphertext to exactly one
 * `<table>.<column>.<rowId>`, so a value copied from one row to another -- say a
 * revoked provider's client secret pasted over a live one, or a cached payload
 * moved between patients -- fails to open rather than quietly decrypting. Every
 * caller must therefore pass the same `aadFor(...)` on open as it did on seal.
 *
 * Why app-layer at all, when D1 is encrypted at rest: at-rest encryption protects
 * the disks, not a database dump, a mis-scoped read from another Worker, or an
 * accidental log of a row. Tokens, patient identifiers and cached clinical
 * payloads need to be unreadable in all of those.
 *
 * The imported CryptoKey is cached in module scope, keyed by the secret string,
 * so a warm isolate imports once however many rows it touches. Keying on the
 * secret (rather than a single slot) means a test that swaps `DATA_KEY` gets a
 * different key instead of the previous one.
 */

import { AppError } from "../lib/errors.ts";

/**
 * Either the raw base64 key or anything carrying a `DATA_KEY`, which `Env` is.
 * Declared structurally on purpose: it keeps this module importable from the
 * plain-Node unit tests, which have no Worker runtime types.
 */
export type KeySource = string | { DATA_KEY?: string | undefined };

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

const keyCache = new Map<string, Promise<CryptoKey>>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cryptoError(message: string, cause?: unknown): AppError {
  return new AppError("crypto", message, undefined, cause === undefined ? {} : { cause });
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Decode base64 or base64url into bytes.
 *
 * The return type is `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`: the
 * WebCrypto signatures require a view over a plain ArrayBuffer (not a
 * SharedArrayBuffer), and allocating the buffer here is what proves it. A
 * `Uint8Array.from(...)` result is `ArrayBufferLike` and will not type-check
 * against `crypto.subtle`.
 */
function fromBase64(value: string, what: string): Uint8Array<ArrayBuffer> {
  const normalised = value.replaceAll("-", "+").replaceAll("_", "/");
  let binary: string;
  try {
    binary = atob(normalised);
  } catch (error) {
    throw cryptoError(`${what} is not valid base64`, error);
  }
  const bytes = new Uint8Array(binary.length);
  // atob yields one code unit per byte, so a code-point read is exact here.
  bytes.set(Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0));
  return bytes;
}

function secretOf(source: KeySource): string {
  const secret = typeof source === "string" ? source : source.DATA_KEY;
  // A missing key is a deployment mistake, but it surfaces here, so it gets the
  // same code as every other crypto failure rather than a 500 with no clue.
  if (!secret) throw cryptoError("DATA_KEY is not configured");
  return secret;
}

async function importKey(secret: string): Promise<CryptoKey> {
  const raw = fromBase64(secret, "DATA_KEY");
  if (raw.length !== KEY_BYTES) {
    throw cryptoError(`DATA_KEY must decode to ${String(KEY_BYTES)} bytes`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function keyFor(source: KeySource): Promise<CryptoKey> {
  const secret = secretOf(source);
  let pending = keyCache.get(secret);
  if (pending === undefined) {
    pending = importKey(secret);
    keyCache.set(secret, pending);
    // Never cache a failure: a malformed key should be re-reported, not turned
    // into a permanently poisoned isolate.
    void pending.catch(() => keyCache.delete(secret));
  }
  return pending;
}

/**
 * The AAD for one cell. `rowId` is whatever uniquely names the row in its table:
 * a primary key, or a composite like `<providerId>:<type>:<id>` for the cache.
 */
export function aadFor(table: string, column: string, rowId: string | number): string {
  return `${table}.${column}.${String(rowId)}`;
}

/** Encrypt `plaintext` for one cell. */
export async function seal(source: KeySource, plaintext: string, aad: string): Promise<string> {
  const key = await keyFor(source);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
      key,
      encoder.encode(plaintext),
    );
  } catch (error) {
    throw cryptoError("seal failed", error);
  }
  const envelope = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  envelope.set(iv, 0);
  envelope.set(new Uint8Array(ciphertext), IV_BYTES);
  return `${VERSION}:${toBase64Url(envelope)}`;
}

/**
 * Decrypt one cell.
 *
 * Throws `AppError("crypto")` for a wrong key, a wrong AAD, a tampered
 * ciphertext and a malformed envelope alike -- deliberately one code, because
 * telling those cases apart to a caller is an oracle and none of them is
 * recoverable.
 */
export async function open(source: KeySource, sealed: string, aad: string): Promise<string> {
  const key = await keyFor(source);
  const separator = sealed.indexOf(":");
  if (separator === -1 || sealed.slice(0, separator) !== VERSION) {
    throw cryptoError("unrecognised sealed envelope");
  }
  const bytes = fromBase64(sealed.slice(separator + 1), "sealed envelope");
  if (bytes.length <= IV_BYTES) throw cryptoError("sealed envelope is too short");
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(0, IV_BYTES),
        additionalData: encoder.encode(aad),
      },
      key,
      bytes.subarray(IV_BYTES),
    );
    return decoder.decode(plaintext);
  } catch (error) {
    throw cryptoError("open failed: wrong key, wrong AAD, or tampered ciphertext", error);
  }
}

/** `open`, but a NULL column stays null instead of throwing. */
export async function openOrNull(
  source: KeySource,
  sealed: string | null,
  aad: string,
): Promise<string | null> {
  return sealed === null ? null : open(source, sealed, aad);
}

/** True if `value` looks like something this module produced. */
export function isSealed(value: string): boolean {
  return value.startsWith(`${VERSION}:`);
}
