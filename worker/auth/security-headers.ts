// Response hardening, applied to every route in the app -- the public pages
// included, because /about and /privacy are the pages a stranger reads and they
// should not be the weak link.
//
// Split out from gate.ts on purpose: nothing here touches a binding or a secret,
// so this module needs no `Env` and can be exercised from the plain-Node unit
// project rather than only from workerd.
//
// One route is an exception to "every route gets the same policy":
// `MCP_SANDBOX_PATH` gets `sandboxContentSecurityPolicy()` instead, a narrower
// policy in every direction but `style-src`. See that function's own comment and
// `shared/mcp-sandbox.ts` for why, and SECURITY.md for the full picture.

import { createMiddleware } from "hono/factory";

import { MCP_SANDBOX_PATH } from "@shared/mcp-sandbox.ts";

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
 * The CSP for `MCP_SANDBOX_PATH` alone -- see `shared/mcp-sandbox.ts` for why this
 * page exists and SECURITY.md for the full picture.
 *
 * `'unsafe-inline'` in `style-src` is the one relaxation anywhere in this app's
 * CSP, and it is safe only because every other directive here is *more*
 * restrictive than the default policy above, not less: no fetch of any kind
 * (`default-src`/`connect-src`/`img-src`/`font-src` all `'none'`), no form
 * submission anywhere (`form-action 'none'`), and framable only by this origin
 * (`frame-ancestors 'self'` -- this page is never navigated to directly, only
 * embedded by `src/components/McpToolTester.vue` in a
 * `sandbox="allow-scripts"` iframe with no `allow-same-origin`, which gives the
 * loaded document an opaque origin: no cookies, no session, and `connect-src
 * 'none'` means it could not call `/api` even if that origin check did not
 * already stop it). There is nothing an inline style, or anything else this
 * page's script can do, that reaches beyond the iframe it is drawn in.
 *
 * `script-src` is a nonce, not `'self'` or an explicit origin: this page is
 * built by a second, separate Vite config (`vite.sandbox.config.ts`) that
 * inlines its one script and its CSS straight into the HTML, so there is no
 * `<script src>` for an origin-based rule to name in the first place -- and an
 * *inline* script needs a nonce or `'unsafe-inline'` regardless of origin.
 * `worker/app.ts`'s asset route stamps the matching nonce onto that `<script>`
 * tag with `HTMLRewriter`, using the same nonce this function is given.
 *
 * `style-src` cannot use a nonce for the same reason it cannot on the main
 * app's CSP above: CodeMirror injects its stylesheet at runtime with no nonce
 * of its own to carry, and a nonce present anywhere in `style-src` disables
 * `'unsafe-inline'` for the whole directive rather than narrowing it. Inlining
 * the module script is what makes `'unsafe-inline'` on `style-src` alone safe
 * to reach for here in the first place: there is no longer any `<script src>`
 * this page loads, inline or otherwise, for a style-only relaxation to expose.
 *
 * `frame-ancestors 'self'` is checked against the *embedding* page's origin
 * (`/connectors`, never opaque), not this document's own, so it is unaffected
 * by any of the above and stays a plain `'self'`.
 */
export function sandboxContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * Every hardening header, in one place.
 *
 * `Permissions-Policy` denies rather than enumerates: this is an admin form and a
 * data dashboard, so no powerful browser feature is wanted and an empty allowlist
 * is the honest expression of that.
 *
 * `path` selects the sandbox's own, narrower policy for exactly one route
 * (`MCP_SANDBOX_PATH`); everything else gets the strict default. `x-frame-options`
 * has to follow the same split as the CSP's `frame-ancestors`: the sandbox page
 * is embedded by this origin on purpose (`src/components/McpToolTester.vue`), and
 * `DENY` would block that in a browser old enough to honour X-Frame-Options over
 * `frame-ancestors`.
 *
 * The same `nonce` goes to whichever policy function is called: the sandbox
 * page's inline script needs it exactly like the default policy's inline
 * `<style>` blocks do.
 */
export function securityHeaderEntries(nonce: string, path?: string): Record<string, string> {
  const sandboxed = path === MCP_SANDBOX_PATH;
  return {
    "content-security-policy": sandboxed
      ? sandboxContentSecurityPolicy(nonce)
      : contentSecurityPolicy(nonce),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    // Redundant with frame-ancestors in a current browser; kept for older ones.
    "x-frame-options": sandboxed ? "SAMEORIGIN" : "DENY",
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
  const entries = Object.entries(securityHeaderEntries(nonce, c.req.path));
  for (const [name, value] of entries) {
    c.res.headers.set(name, value);
  }
});
