// Response hardening, applied to every route in the app -- the public pages
// included, because /about and /privacy are the pages a stranger reads and they
// should not be the weak link.
//
// Split out from gate.ts on purpose: nothing here touches a binding or a secret,
// so this module needs no `Env` and can be exercised from the plain-Node unit
// project rather than only from workerd.

import { createMiddleware } from "hono/factory";

import { b64urlEncode } from "./primitives.ts";

/** Request-scoped values the middleware publishes to handlers. */
export interface AuthVariables {
  /** Per-response CSP nonce. Any inline <style> block must carry it. */
  nonce: string;
}

/**
 * Content-Security-Policy.
 *
 * `style-src` carries a nonce so the server-rendered pages (login wall, /about,
 * /privacy, /terms) can inline their one <style> block without a round trip.
 *
 * NOTE FOR THE SPA: a nonce in `style-src` does NOT re-enable inline
 * `style="..."` attributes. Those need `unsafe-inline`, which is not here and must
 * not be added -- it would also re-enable every injected style. Vue's `:style`
 * binding writes through CSSOM and is unaffected; a literal `style=""` attribute
 * in a template is not, and a Vite-emitted stylesheet under /assets is covered by
 * `'self'`.
 *
 * The two directives doing the least obvious work:
 *   frame-ancestors 'none' -- the admin UI cannot be framed, so it cannot be
 *                             clickjacked into approving an MCP grant.
 *   base-uri 'none'        -- an injected <base> cannot re-point every relative
 *                             URL (including the login form's action) elsewhere.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * Every hardening header, in one place.
 *
 * `Permissions-Policy` denies rather than enumerates: this is an admin form and a
 * data dashboard, so no powerful browser feature is wanted and an empty allowlist
 * is the honest expression of that.
 */
export function securityHeaderEntries(nonce: string): Record<string, string> {
  return {
    "content-security-policy": contentSecurityPolicy(nonce),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    // Redundant with frame-ancestors in a current browser; kept for older ones.
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": [
      "accelerometer=()",
      "camera=()",
      "display-capture=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "payment=()",
      "usb=()",
    ].join(", "),
    // One year, subdomains included. The Worker is only ever served over TLS on
    // its custom domain, so there is no plaintext deployment for this to break.
    "strict-transport-security": "max-age=31536000; includeSubDomains",
  };
}

/** 128 bits, base64url. Fresh per response: a reused nonce is no nonce. */
function randomNonce(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Mints the nonce, publishes it to handlers as `c.get("nonce")`, and stamps the
 * hardening headers on the way out.
 *
 * Headers are mutated in place, which needs a mutable `Headers` object. A response
 * that came back from a subrequest has immutable headers, so any handler
 * returning one (the SPA asset fallback) must re-wrap it first. app.ts does.
 */
export const securityHeaders = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const nonce = randomNonce();
  c.set("nonce", nonce);
  await next();
  const entries = Object.entries(securityHeaderEntries(nonce));
  for (const [name, value] of entries) {
    c.res.headers.set(name, value);
  }
});
