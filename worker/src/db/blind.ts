/**
 * Keyed blinding: deterministic HMAC-SHA256 for the values D1 has to compare but
 * never needs to read.
 *
 * Sealing (`crypto.ts`) is randomised, so two seals of one value differ and a
 * sealed column cannot be a primary key, an index, or an equality test. Some
 * upstream identifiers have to be all three -- an Epic resource id is the cache's
 * key, a visit number is what ties a calendar row to its portal visit, an event
 * key is what pairs a row with its Google event. For those, the column holds
 * `blind(value)`: an HMAC under a key only the Worker has. Equal values still
 * compare equal and still hit the index, but a D1 snapshot no longer carries the
 * patient's Epic id, the visit numbers, or the owner's email address, and a
 * guess cannot be confirmed without the key.
 *
 * The same primitive replaces every unkeyed sha256 digest the schema used to
 * store (cache and visit content hashes, the calendar fingerprint, the rate
 * limiter's IP hash). A plain sha256 of a guessable input is a confirmation
 * oracle; an HMAC is not.
 *
 * **The key is derived, never reused.** HKDF-SHA256 over `DATA_KEY` with the
 * info label below gives a separate 256-bit HMAC key. The AES key itself is
 * never used for anything but AES-GCM.
 *
 * **Domain separation.** Every call names a domain (`fhir_cache.resource_id`,
 * `portal.csn`, ...), which is hashed in front of the value, so the same Epic id
 * blinded for two purposes gives two unrelated strings. Callers that want two
 * columns to be joinable (a calendar row's encounter and its cache row) use the
 * same helper, and therefore the same domain, on purpose.
 *
 * **Output format.** `~` followed by unpadded base64url: 16 bytes (22 characters)
 * for an identifier, 32 bytes (43 characters) for a digest. `~` is outside the
 * alphabet of a FHIR id and of every value this app stored before blinding, so
 * "has this row been migrated?" is a prefix test (`isBlinded`), which is what the
 * backfill resumes on.
 *
 * Plain WebCrypto and no Worker types, so the pure sync modules and their
 * plain-Node unit tests can take a `Blinder` without a runtime.
 */

import { AppError } from "../lib/errors.ts";

import type { KeySource } from "./crypto.ts";

/** HKDF `info`: names what the derived key is for. Change it and every blind moves. */
const BLIND_INFO = "healthy/blind/v1";
/** The marker every blinded value starts with. */
const BLIND_MARK = "~";
/** Truncated HMAC length for identifiers. 128 bits: collision-free at any size this app will see. */
const ID_BYTES = 16;
/** Full HMAC length for digests. */
const DIGEST_BYTES = 32;
const KEY_BYTES = 32;

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * The keyed operations, bound to one `DATA_KEY`.
 *
 * An interface rather than free functions so a pure module (the calendar
 * mapping) can take one as an argument instead of reaching for `Env`.
 */
export interface Blinder {
  /** A 128-bit blind of `value` in `domain`, for a stored identifier. */
  id(domain: string, value: string): Promise<string>;
  /** A 256-bit keyed digest of `value` in `domain`, for change detection. */
  digest(domain: string, value: string): Promise<string>;
}

function blindError(message: string, cause?: unknown): AppError {
  return new AppError("crypto", message, undefined, cause === undefined ? {} : { cause });
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(secret.replaceAll("-", "+").replaceAll("_", "/"));
  } catch (error) {
    throw blindError("DATA_KEY is not valid base64", error);
  }
  const bytes = new Uint8Array(binary.length);
  bytes.set(Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0));
  if (bytes.length !== KEY_BYTES) {
    throw blindError(`DATA_KEY must decode to ${String(KEY_BYTES)} bytes`);
  }
  return bytes;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey("raw", secretBytes(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // A fixed, public salt: HKDF's salt is not a secret, and DATA_KEY is
      // already uniformly random, so a per-deployment salt would add nothing.
      salt: new Uint8Array(0),
      info: encoder.encode(BLIND_INFO),
    },
    master,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

function hmacKeyFor(source: KeySource): Promise<CryptoKey> {
  const secret = typeof source === "string" ? source : source.DATA_KEY;
  if (!secret) throw blindError("DATA_KEY is not configured");
  let pending = keyCache.get(secret);
  if (pending === undefined) {
    pending = deriveKey(secret);
    keyCache.set(secret, pending);
    void pending.catch(() => keyCache.delete(secret));
  }
  return pending;
}

async function mac(source: KeySource, domain: string, value: string): Promise<Uint8Array> {
  const key = await hmacKeyFor(source);
  // NUL between domain and value: no domain contains one, so no (domain, value)
  // pair can be re-split into a different pair with the same input.
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${domain}\u{0}${value}`));
  return new Uint8Array(signature);
}

/** A `Blinder` over one key source (`env`, or a raw base64 key in a test). */
export function blinderFor(source: KeySource): Blinder {
  return {
    async id(domain, value) {
      const bytes = await mac(source, domain, value);
      return `${BLIND_MARK}${toBase64Url(bytes.subarray(0, ID_BYTES))}`;
    },
    async digest(domain, value) {
      const bytes = await mac(source, domain, value);
      return `${BLIND_MARK}${toBase64Url(bytes.subarray(0, DIGEST_BYTES))}`;
    },
  };
}

/** True when `value` is something a `Blinder` produced (or a key built from one). */
export function isBlinded(value: string): boolean {
  return value.startsWith(BLIND_MARK);
}

// ---------------------------------------------------------------------------
// The named blinds. One helper per stored identifier, so that two columns meant
// to be joinable cannot drift into two different domains or input shapes. Every
// input includes the health system's row id: the same Epic id, or the same visit
// number, under two organisations blinds to two unrelated values, which is what
// stops a snapshot linking two accounts by equal ids.
// ---------------------------------------------------------------------------

/** `fhir_cache.resource_id`, and `calendar_events.encounter_id` for an Encounter. */
export function blindResourceId(
  blinder: Blinder,
  healthSystemId: string,
  resourceType: string,
  resourceId: string,
): Promise<string> {
  return blinder.id(
    "fhir_cache.resource_id",
    `${healthSystemId}\u{0}${resourceType}\u{0}${resourceId}`,
  );
}

/** `portal_visits.csn` and `calendar_events.portal_csn`. */
export function blindCsn(blinder: Blinder, healthSystemId: string, csn: string): Promise<string> {
  return blinder.id("portal.csn", `${healthSystemId}\u{0}${csn}`);
}

/** `calendar_events.calendar_id`: the owner's calendar id is usually their email address. */
export function blindCalendarId(blinder: Blinder, calendarId: string): Promise<string> {
  return blinder.id("calendar_events.calendar_id", calendarId);
}

/** The infix that marks a portal event key. Mirrors `portal-mapping.ts`. */
const PORTAL_KEY_INFIX = "csn:";

/**
 * The stored form of an event key -- the `calendar_events` primary key and the
 * `extendedProperties.private.key` marker on the Google event alike.
 *
 * `logicalKey` is what the key used to be: `<healthSystemId>:<encounterId>` or
 * `<healthSystemId>:csn:<csn>`. Only the upstream half is blinded, and the
 * structure is kept, because the sync partitions Google's listing by the
 * `<healthSystemId>:` prefix and tells portal keys from FHIR keys by `:csn:`. The
 * health system half is this app's own row id and names no one.
 *
 * Deterministic in the logical key alone, which is what lets the backfill turn
 * every pre-blinding key -- in D1 and on the calendar -- into the key the sync
 * now computes for the same appointment.
 */
export async function blindEventKey(blinder: Blinder, logicalKey: string): Promise<string> {
  const separator = logicalKey.indexOf(":");
  if (separator <= 0) throw blindError("event key has no health system prefix");
  const healthSystemId = logicalKey.slice(0, separator);
  const rest = logicalKey.slice(separator + 1);
  const blinded = await blinder.id("calendar_events.event_key", logicalKey);
  return rest.startsWith(PORTAL_KEY_INFIX)
    ? `${healthSystemId}:${PORTAL_KEY_INFIX}${blinded}`
    : `${healthSystemId}:${blinded}`;
}

/** True when an event key is already in its blinded form. */
export function isBlindedEventKey(key: string): boolean {
  const separator = key.indexOf(":");
  if (separator <= 0) return false;
  const rest = key.slice(separator + 1);
  return isBlinded(rest.startsWith(PORTAL_KEY_INFIX) ? rest.slice(PORTAL_KEY_INFIX.length) : rest);
}
