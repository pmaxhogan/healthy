/**
 * App-layer encryption for the `_enc` columns.
 *
 * Envelope: `v1:` + base64url(iv(12) || ciphertext||tag), AES-GCM-256, key from
 * the `DATA_KEY` secret (base64 of 32 bytes).
 *
 * `v2:` is the same envelope around a *padded* plaintext: a 4-byte big-endian
 * length, the UTF-8 bytes, then zeros up to a size bucket (64, 128, 256, ...
 * bytes). AES-GCM hides content but not length, so without padding the
 * ciphertext of a 15-character password says "15 characters" to anyone with a
 * D1 snapshot, and an 18-byte sealed sender matches an 18-character domain
 * stored elsewhere. Short, human-chosen values -- credentials, addresses,
 * URLs, names, subjects, settings -- are sealed with `{ pad: true }`. Bulk
 * payloads (cached FHIR resources, visits) are not: their size class is an
 * accepted leak (SECURITY.md), and doubling the cache is not worth hiding it.
 * `open` reads both versions, so no existing row has to be rewritten for this.
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
/** The padded envelope. See the module comment. */
const VERSION_PADDED = "v2";
const IV_BYTES = 12;
/** Bytes of the big-endian length prefix inside a padded plaintext. */
const LENGTH_BYTES = 4;
/** The smallest padded plaintext. Every bucket above it doubles. */
const MIN_PAD_BUCKET = 64;
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

export interface SealOptions {
  /**
   * Pad the plaintext to a size bucket before sealing (a `v2:` envelope), so the
   * ciphertext's length stops disclosing the value's exact length.
   */
  pad?: boolean;
}

/** The bucket a padded plaintext of `length` bytes (prefix included) fills. */
export function padBucket(length: number): number {
  let bucket = MIN_PAD_BUCKET;
  while (bucket < length) bucket *= 2;
  return bucket;
}

/** Length prefix, bytes, zeros to the bucket. */
function padPlaintext(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(padBucket(LENGTH_BYTES + bytes.length));
  new DataView(out.buffer).setUint32(0, bytes.length, false);
  out.set(bytes, LENGTH_BYTES);
  return out;
}

/** The inverse of `padPlaintext`. Throws on a prefix that overruns the buffer. */
function unpadPlaintext(bytes: Uint8Array): Uint8Array {
  if (bytes.length < LENGTH_BYTES) throw cryptoError("padded plaintext is too short");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (LENGTH_BYTES + length > bytes.length) throw cryptoError("padded plaintext is malformed");
  return bytes.subarray(LENGTH_BYTES, LENGTH_BYTES + length);
}

/** Encrypt `plaintext` for one cell. */
export async function seal(
  source: KeySource,
  plaintext: string,
  aad: string,
  options: SealOptions = {},
): Promise<string> {
  const key = await keyFor(source);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = encoder.encode(plaintext);
  const padded = options.pad === true;
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
      key,
      padded ? padPlaintext(encoded) : encoded,
    );
  } catch (error) {
    throw cryptoError("seal failed", error);
  }
  const envelope = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  envelope.set(iv, 0);
  envelope.set(new Uint8Array(ciphertext), IV_BYTES);
  return `${padded ? VERSION_PADDED : VERSION}:${toBase64Url(envelope)}`;
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
  const version = separator === -1 ? "" : sealed.slice(0, separator);
  if (version !== VERSION && version !== VERSION_PADDED) {
    throw cryptoError("unrecognised sealed envelope");
  }
  const bytes = fromBase64(sealed.slice(separator + 1), "sealed envelope");
  if (bytes.length <= IV_BYTES) throw cryptoError("sealed envelope is too short");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(0, IV_BYTES),
        additionalData: encoder.encode(aad),
      },
      key,
      bytes.subarray(IV_BYTES),
    );
  } catch (error) {
    throw cryptoError("open failed: wrong key, wrong AAD, or tampered ciphertext", error);
  }
  const opened = new Uint8Array(plaintext);
  return decoder.decode(version === VERSION_PADDED ? unpadPlaintext(opened) : opened);
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
  return value.startsWith(`${VERSION}:`) || value.startsWith(`${VERSION_PADDED}:`);
}

/** True for a `v1:` envelope: sealed, but before padding existed. */
export function isUnpadded(value: string): boolean {
  return value.startsWith(`${VERSION}:`);
}

/**
 * Seal a short, human-chosen value: always padded. The one call every such
 * column uses, so "is this one padded?" has a single answer per column.
 */
export async function sealShort(
  source: KeySource,
  plaintext: string,
  aad: string,
): Promise<string> {
  return seal(source, plaintext, aad, { pad: true });
}

/**
 * Open a column that may predate its sealing: a sealed value is opened, anything
 * else is returned as it is. For the columns 0007 started sealing in place
 * (settings, health-system identity, portal location) until the backfill has
 * rewritten every row -- after which the plaintext branch is dead.
 */
export async function openLegacy(source: KeySource, value: string, aad: string): Promise<string> {
  return isSealed(value) ? open(source, value, aad) : value;
}
