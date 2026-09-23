// The password gate's session: a stateless HMAC cookie, no server-side store.
//
// The signed message binds the session to PASSWORD_HASH as well as to
// SESSION_SECRET, which makes revocation a one-liner with no bookkeeping:
// rotating *either* secret invalidates every outstanding session at once. That
// is the documented runbook for "I think a cookie leaked" and for "I changed
// the admin password".
//
// Because there is no store, a session cannot be revoked individually and its
// lifetime is exactly the signed `exp`. That is an accepted trade for a
// single-user admin surface that already sits behind Cloudflare Access.

import {
  b64urlDecode,
  b64urlEncode,
  hmacSha256,
  readCookie,
  timingSafeEqual,
} from "./primitives.ts";

/** The slice of Env this module reads. Narrow so it is unit-testable. */
export interface SessionEnv {
  PASSWORD_HASH?: string | undefined;
  SESSION_SECRET?: string | undefined;
}

export const SESSION_COOKIE_NAME = "healthy_session";

/** 30 days. Long enough that the owner is not re-typing a 24-character password. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Cookie attributes, all of them load-bearing:
 *   HttpOnly         -- script cannot read it, so an XSS cannot exfiltrate it
 *   Secure           -- never sent over plaintext
 *   SameSite=Lax     -- carried on top-level GET navigations only, which is what
 *                       the OAuth redirect back from a health system is; never on a
 *                       cross-site POST or subresource request. Strict was
 *                       tried first and dropped the cookie on every
 *                       /oauth/callback, bouncing each connect through the
 *                       password page (owner decision, 2026-09-22). Mutations
 *                       are still covered by the header + origin checks in
 *                       csrf.ts.
 *   Path=/           -- the whole admin surface is gated, so the whole origin
 */
const COOKIE_ATTRIBUTES = "HttpOnly; Secure; SameSite=Lax; Path=/";

/**
 * The signed message. `healthy.` is a domain separator so a secret shared with
 * another project could not produce a valid token here.
 */
function sessionMessage(env: SessionEnv, exp: number): string {
  return `healthy.${String(exp)}.${env.PASSWORD_HASH ?? ""}`;
}

/** Both secrets must be present; a missing one must never mean "no signature required". */
function secrets(env: SessionEnv): { secret: string } | null {
  return !env.SESSION_SECRET || !env.PASSWORD_HASH ? null : { secret: env.SESSION_SECRET };
}

/**
 * The bare cookie value, `${exp}.${sig}`.
 *
 * Exported for the tests, which need to tamper with the halves independently.
 * Production code wants {@link issueSession}.
 */
export async function mintSessionToken(
  env: SessionEnv,
  nowMs: number = Date.now(),
): Promise<string> {
  const keys = secrets(env);
  if (!keys) throw new Error("session secrets are not configured");
  const exp = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  const signature = b64urlEncode(await hmacSha256(keys.secret, sessionMessage(env, exp)));
  return `${String(exp)}.${signature}`;
}

/** A complete `Set-Cookie` value that starts a session. */
export async function issueSession(env: SessionEnv, nowMs: number = Date.now()): Promise<string> {
  const token = await mintSessionToken(env, nowMs);
  return `${SESSION_COOKIE_NAME}=${token}; Max-Age=${String(SESSION_TTL_SECONDS)}; ${COOKIE_ATTRIBUTES}`;
}

/** A complete `Set-Cookie` value that ends a session. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;
}

/**
 * True only for a cookie that is present, unexpired, and correctly signed under
 * the current pair of secrets. Every other case -- including secrets that are
 * not configured at all -- is false.
 */
export async function verifySession(
  request: Request,
  env: SessionEnv,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const keys = secrets(env);
  if (!keys) return false;

  const value = readCookie(request, SESSION_COOKIE_NAME);
  if (!value) return false;

  const dot = value.indexOf(".");
  if (dot === -1) return false;

  const exp = Number(value.slice(0, dot));
  if (!Number.isSafeInteger(exp) || exp <= 0) return false;
  // Checked before the HMAC so an expired cookie costs no crypto.
  if (exp * 1000 <= nowMs) return false;

  const presented = b64urlDecode(value.slice(dot + 1));
  if (!presented) return false;

  const expected = await hmacSha256(keys.secret, sessionMessage(env, exp));
  return timingSafeEqual(presented, expected);
}
