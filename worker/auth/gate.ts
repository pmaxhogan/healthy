// The two gates, composed.
//
// Order is Access, then the login routes, then the session -- never the other way
// round. Putting `/auth/login` outside the Access gate would publish a password
// oracle to the internet: anyone could guess against it, and the rate limiter
// would be the only thing in the way. Inside Access, an attacker has to defeat
// Google SSO for one specific identity first.
//
// Response hardening (CSP and friends) is separate: see security-headers.ts.

import { createMiddleware } from "hono/factory";

import { htmlPage, htmlResponse } from "../public/html.ts";

import { verifyAccess } from "./access.ts";
import { AUTH_REQUIRED_HEADER, AUTH_REQUIRED_VALUE, loginPage } from "./login-page.ts";
import { safeNextPath } from "./safe-next-path.ts";
import { verifySession } from "./session.ts";

import type { AuthVariables } from "./security-headers.ts";
import type { Env } from "../env.ts";
import type { ApiError } from "@shared/types.ts";

/** The Hono environment every router in this app is typed against. */
export interface AppHonoEnv {
  Bindings: Env;
  Variables: AuthVariables;
}

/**
 * `POST /auth/login` and `POST /auth/logout` clear Access but skip the *session*
 * step: login is how a session is obtained, and logout must work from an expired
 * one (otherwise "sign out" answers 401 and leaves the stale cookie in place).
 *
 * The METHOD is part of the exemption, not just the path. Only `app.post`
 * registers these two, so exempting every method would let `GET /auth/login` fall
 * through the gate to the SPA asset fallback and serve the admin UI with no
 * session -- which is the one thing app.ts's route order exists to prevent.
 */
const SESSION_EXEMPT_PATHS = new Set(["/auth/login", "/auth/logout"]);

function isSessionExempt(request: Request, pathname: string): boolean {
  return request.method === "POST" && SESSION_EXEMPT_PATHS.has(pathname);
}

function wantsJson(pathname: string): boolean {
  // /api only. It is the SPA's data plane, fetched by script, and an HTML login
  // page there is a parse error at the other end rather than a prompt.
  //
  // /oauth deliberately is NOT in this list: every route under it is a top-level
  // browser navigation redirected back from a health system, so the right answer to a
  // missing session is the login form with `?next=` pointing at the full callback
  // URL. (The machine-facing /oauth/token and /oauth/register are served by
  // @cloudflare/workers-oauth-health system, outside this app and outside this gate.)
  return pathname === "/api" || pathname.startsWith("/api/");
}

/** The path (with query) the login form should return to. */
function currentPath(request: Request): string | undefined {
  const url = new URL(request.url);
  // Query included deliberately: if the session has expired mid-flow, the
  // request that lands on the login page can be `/oauth/callback?code=...&state=...`
  // and re-login has to resume the *whole* URL or the flow is lost.
  return safeNextPath(url.pathname + url.search) ?? undefined;
}

/**
 * Gate 1 + gate 2.
 *
 * Access failure is 403 (the identity is wrong; no amount of retrying the
 * password helps). Session failure is 401 with `x-healthy-auth: required` for the
 * JSON surfaces and the login page everywhere else.
 */
export const ownerGate = createMiddleware<AppHonoEnv>(async (c, next) => {
  const request = c.req.raw;
  const pathname = new URL(request.url).pathname;

  if (!(await verifyAccess(request, c.env))) {
    if (wantsJson(pathname)) {
      return c.json<ApiError>({ error: "forbidden" }, 403, {
        "cache-control": "no-store",
        [AUTH_REQUIRED_HEADER]: AUTH_REQUIRED_VALUE,
      });
    }
    // Not the login page: the password is irrelevant when the identity is wrong,
    // and offering a form here would invite guessing at the wrong gate.
    const body = `<main>
<h1>Not available</h1>
<p>This deployment is restricted to its operator. Sign in with the authorised identity and try again.</p>
<p><a href="/about">About this software</a></p>
</main>`;
    return htmlResponse(htmlPage({ title: "Healthy", nonce: c.get("nonce"), body }), 403, {
      [AUTH_REQUIRED_HEADER]: AUTH_REQUIRED_VALUE,
    });
  }

  if (isSessionExempt(request, pathname)) {
    await next();
    return;
  }

  if (await verifySession(request, c.env)) {
    await next();
    return;
  }

  if (wantsJson(pathname)) {
    return c.json<ApiError>({ error: "unauthorized" }, 401, {
      "cache-control": "no-store",
      [AUTH_REQUIRED_HEADER]: AUTH_REQUIRED_VALUE,
    });
  }
  return loginPage({ nonce: c.get("nonce"), next: currentPath(request) });
});

// Re-exported (rather than only imported above) so `worker/app.ts`'s existing
// `import { ownerGate, safeNextPath, ... } from "./auth/gate.ts"` keeps
// working unchanged -- the validation logic itself moved to
// ./safe-next-path.ts so it stays free of the `Env` import gate.ts needs for
// `AppHonoEnv`, which is what let `test/unit/auth/gate.test.ts` unit-test it
// without pulling worker-configuration.d.ts into the plain-Node tsconfig.
export { safeNextPath } from "./safe-next-path.ts";
