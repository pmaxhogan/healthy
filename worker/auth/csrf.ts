// CSRF defence for state-changing requests under /api and /auth.
//
// Three independent layers, so no single browser quirk is load-bearing:
//   1. The session cookie is `SameSite=Strict` (session.ts), so a cross-site
//      request does not carry credentials at all in a current browser.
//   2. A same-origin proof: `Origin` equal to this origin, or `Sec-Fetch-Site:
//      same-origin`. Browsers send `Origin` on every POST and refuse to let
//      script set either header, so a forged cross-site request cannot fake it.
//   3. A custom request header, `x-healthy-csrf: 1`. A cross-origin `fetch` that
//      sets a custom header is a preflighted request, and the Worker sends no
//      CORS headers, so the preflight fails before the real request is made.
//
// Layer 3 has one documented exception. `POST /auth/login` is submitted by the
// server-rendered login form, and an HTML form cannot set a request header. The
// alternatives were worse: a nonce'd inline script (the CSP deliberately allows
// nonces for styles only) or a hidden token (which needs the server-side state
// this design does not have). Login therefore requires layers 1 and 2 only --
// and "login CSRF" at worst logs the owner in to their own account.

import { createMiddleware } from "hono/factory";

import { AppError } from "../lib/errors.ts";

/** The header the SPA must send on every state-changing request. */
export const CSRF_HEADER = "x-healthy-csrf";

/** ...with exactly this value. */
export const CSRF_HEADER_VALUE = "1";

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Paths that are checked with the same-origin proof alone. See the header note.
 *
 * Both are server-rendered HTML forms, and an HTML form cannot set a header.
 * `/authorize` is the MCP consent page (wave 2): its GET is a cross-site
 * navigation from the client that wants the grant, which is a safe method and so
 * is not checked at all; its POST is the owner approving, same-origin, from the
 * form this Worker rendered.
 */
const HEADER_EXEMPT_PATHS = new Set(["/auth/login", "/authorize"]);

/** True for the methods that can change state, and so need a CSRF check. */
export function isStateChanging(method: string): boolean {
  return STATE_CHANGING.has(method.toUpperCase());
}

/**
 * True when the request proves it came from this origin.
 *
 * Either signal alone is sufficient, and a request carrying neither is rejected:
 * an absent `Origin` on a POST means a client too old to be trusted with the
 * admin surface, not a request to wave through.
 */
export function hasSameOriginProof(request: Request): boolean {
  const origin = request.headers.get("origin");
  const originMatches = origin !== null && origin === new URL(request.url).origin;
  return originMatches || request.headers.get("sec-fetch-site") === "same-origin";
}

export interface CsrfOptions {
  /** Whether the `x-healthy-csrf` header is required as well. Default true. */
  requireHeader?: boolean;
}

/** The whole check for one request. Safe methods always pass. */
export function checkCsrf(request: Request, options: CsrfOptions = {}): boolean {
  if (!isStateChanging(request.method)) return true;
  const headerOk =
    options.requireHeader === false || request.headers.get(CSRF_HEADER) === CSRF_HEADER_VALUE;
  return hasSameOriginProof(request) && headerOk;
}

/**
 * Hono middleware form. Mount it on `/api/*` and `/auth/*`.
 *
 * Rejection is a 403 `forbidden` AppError rather than a bespoke response so it
 * renders through the app's single error handler like every other failure.
 */
export const csrfGuard = createMiddleware(async (c, next) => {
  const request = c.req.raw;
  if (isStateChanging(request.method)) {
    const pathname = new URL(request.url).pathname;
    const requireHeader = !HEADER_EXEMPT_PATHS.has(pathname);
    if (!checkCsrf(request, { requireHeader })) {
      throw new AppError("forbidden", "csrf_check_failed");
    }
  }
  await next();
});
