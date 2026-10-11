/**
 * The bearer token a paired phone presents to `POST /ingest/health-connect`.
 *
 * Shape: `hcd1.<deviceId>.<secret>` -- a version tag, this app's own row id for
 * the device, and 32 random bytes as unpadded base64url. The device id is in
 * the token on purpose: it lets the route load exactly one row by primary key
 * and compare digests in constant time, rather than search a table by a value
 * an unauthenticated caller chose.
 *
 * Only `sha256(token)` is stored (`devices.token_hash`). The secret half is 256
 * bits from the CSPRNG, so an unkeyed digest is not the confirmation oracle it
 * would be for a guessable value, and there is nothing to gain from a slow
 * hash: a password stretcher defends a small search space, and this has none.
 *
 * The token is shown once, when it is minted, and is not recoverable after
 * that: rotating mints a new one and the old digest is overwritten.
 *
 * Plain WebCrypto and no Worker types, so the unit project can run it.
 */

import { b64urlEncode, timingSafeEqual, utf8 } from "../auth/primitives.ts";
import { ID_PATTERN } from "../lib/ids.ts";

import type { Bytes } from "../auth/primitives.ts";

const TOKEN_VERSION = "hcd1";
const SECRET_BYTES = 32;
/** 32 bytes as unpadded base64url. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
/**
 * The longest `Authorization` value worth parsing. A real one is well under
 * 100 characters; anything longer is refused before it is split or hashed.
 */
const MAX_HEADER_LENGTH = 256;
const BEARER_PREFIX = "Bearer ";

export interface ParsedDeviceToken {
  deviceId: string;
  /** The whole token, exactly as presented: this is what gets hashed. */
  token: string;
}

/** A new token for `deviceId`. The caller stores `hashDeviceToken` of it and nothing else. */
export function mintDeviceToken(deviceId: string): string {
  const secret = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  return `${TOKEN_VERSION}.${deviceId}.${b64urlEncode(secret)}`;
}

/**
 * Split a presented token, or null for anything that is not exactly one.
 *
 * Strict on every part so that a malformed token never reaches the database:
 * the version, an id of the shape this app mints, a secret of the exact length.
 */
export function parseDeviceToken(token: string): ParsedDeviceToken | null {
  if (token.length > MAX_HEADER_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, deviceId, secret] = parts;
  const wellFormed =
    version === TOKEN_VERSION &&
    deviceId !== undefined &&
    secret !== undefined &&
    ID_PATTERN.test(deviceId) &&
    SECRET_PATTERN.test(secret);
  return wellFormed ? { deviceId, token } : null;
}

/** The token out of an `Authorization: Bearer ...` header, or null. */
export function bearerDeviceToken(header: string | null | undefined): ParsedDeviceToken | null {
  const usable =
    typeof header === "string" &&
    header.length <= MAX_HEADER_LENGTH &&
    header.startsWith(BEARER_PREFIX);
  return usable ? parseDeviceToken(header.slice(BEARER_PREFIX.length)) : null;
}

async function sha256(value: string): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(value)));
}

/** `devices.token_hash`: SHA-256 of the whole token, unpadded base64url. */
export async function hashDeviceToken(token: string): Promise<string> {
  return b64urlEncode(await sha256(token));
}

/**
 * Whether `token` is the one whose digest is `storedHash`.
 *
 * Both sides are hashed to a fixed width before the comparison, and the
 * comparison is constant-time, so neither the stored digest nor how much of a
 * guess matched it is observable from timing.
 */
export async function verifyDeviceToken(token: string, storedHash: string): Promise<boolean> {
  const presented = utf8(await hashDeviceToken(token));
  return timingSafeEqual(presented, utf8(storedHash));
}
