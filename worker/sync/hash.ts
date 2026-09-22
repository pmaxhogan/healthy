/**
 * sha256, lower-case hex. The calendar fingerprint's only primitive.
 *
 * Deliberately not reused from `worker/db/client.ts`, which has an identical
 * function: that module's signatures name `D1Database` and `D1PreparedStatement`,
 * which exist only in the Worker's generated globals, so importing it would make
 * `mapping.ts` (and its plain-Node unit suite) fail to type-check. This file
 * touches nothing but WebCrypto, which both workerd and Node provide.
 */

/** sha256 of a UTF-8 string as 64 lower-case hex characters. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
