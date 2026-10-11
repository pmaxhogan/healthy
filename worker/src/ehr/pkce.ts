/**
 * PKCE (RFC 7636) and the OAuth `state` nonce.
 *
 * Epic advertises S256 only -- `plain` is never offered and must never be sent.
 * The verifier is 64 characters, comfortably inside RFC 7636's 43..128 range,
 * drawn from a 64-character subset of the unreserved alphabet so that masking a
 * random byte with 63 is uniform and needs no rejection sampling.
 *
 * Nothing in here touches the environment: `crypto` is the Web Crypto global,
 * which both workerd and Node 26 provide.
 */

/** 64 unreserved characters (RFC 3986 `unreserved` minus `_` and `~`). */
const VERIFIER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-.";

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** RFC 4648 §5 base64url, no padding. Hand-rolled to avoid `btoa`/`Buffer`. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes.at(index) ?? 0;
    const b1 = bytes.at(index + 1) ?? 0;
    const b2 = bytes.at(index + 2) ?? 0;
    const remaining = bytes.length - index;
    out += BASE64URL_ALPHABET.charAt(b0 >> 2);
    out += BASE64URL_ALPHABET.charAt(((b0 & 0b11) << 4) | (b1 >> 4));
    if (remaining > 1) out += BASE64URL_ALPHABET.charAt(((b1 & 0b1111) << 2) | (b2 >> 6));
    if (remaining > 2) out += BASE64URL_ALPHABET.charAt(b2 & 0b11_1111);
  }
  return out;
}

/** A cryptographically random PKCE code verifier. Default 64 characters. */
export function randomVerifier(length = 64): string {
  if (length < 43 || length > 128) {
    throw new RangeError("a PKCE verifier must be 43..128 characters (RFC 7636 §4.1)");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) out += VERIFIER_ALPHABET.charAt(byte & 0b11_1111);
  return out;
}

/** `BASE64URL(SHA256(ASCII(verifier)))` -- the S256 challenge of RFC 7636 §4.2. */
export async function challengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** An opaque, unguessable OAuth `state`. 32 bytes -> 43 base64url characters. */
export function randomState(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** A fresh verifier/challenge pair. The verifier is what gets stored, sealed. */
export async function createPkce(verifierLength = 64): Promise<Pkce> {
  const verifier = randomVerifier(verifierLength);
  return { verifier, challenge: await challengeS256(verifier), method: "S256" };
}
