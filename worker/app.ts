// The Hono app: every non-MCP request lands here.
//
// The order of the `use` and route registrations below IS the security boundary.
// Hono composes handlers in registration order and a terminal handler
// short-circuits the rest, which is what lets the public routes sit in front of
// the gate. Read it top to bottom:
//
//   1. securityHeaders  -- CSP nonce in, hardening headers out. Everything.
//   2. publicRouter     -- /health /about /privacy /terms. Terminal, so the gate
//                          below never runs for them.
//   3. csrfGuard        -- /api/*, /auth/*, /authorize; mutating methods only.
//   4. ownerGate        -- Access, then (login routes aside) the password session.
//   5. /auth/login, /auth/logout
//   6. /authorize       -- the MCP consent page.
//   7. /api, /oauth     -- routers other changes fill in.
//   8. SPA fallback     -- env.ASSETS, last, so no asset is ever served ungated.
//
// Inserting a route above line 4 publishes it to the internet. Do not.

import { Hono } from "hono";

import { apiRouter } from "./api/index.ts";
import { csrfGuard } from "./auth/csrf.ts";
import { ownerGate, safeNextPath, type AppHonoEnv } from "./auth/gate.ts";
import { loginPage } from "./auth/login-page.ts";
import { MAX_PBKDF2_ITERATIONS, isCostUnsupported, verifyPassword } from "./auth/password.ts";
import {
  d1LoginAttemptStore,
  forgetLoginAttempts,
  hashClientIp,
  recordLoginAttempt,
} from "./auth/ratelimit.ts";
import { securityHeaders } from "./auth/security-headers.ts";
import { clearSessionCookie, issueSession } from "./auth/session.ts";
import { isAppError } from "./lib/errors.ts";
import { errorFields, logLine } from "./lib/log.ts";
import { consentDecision, consentPage } from "./mcp/consent-page.ts";
import { oauthRouter } from "./oauth/index.ts";
import { publicRouter } from "./public/pages.ts";

import type { ApiError } from "@shared/types.ts";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const app = new Hono<AppHonoEnv>();

// --- 1. Response hardening, on every route including the public ones ---------
app.use("*", securityHeaders);

// --- 2. Public routes, before the gate --------------------------------------
app.route("/", publicRouter);

// --- 3. CSRF, on every state-changing surface -------------------------------
app.use("/api/*", csrfGuard);
app.use("/auth/*", csrfGuard);
// /authorize matches neither pattern above, and its POST is the consent approval
// -- the most sensitive action in the app. Guarded explicitly rather than left for
// wave 2 to remember.
app.use("/authorize", csrfGuard);

// --- 4. The gate ------------------------------------------------------------
app.use("*", ownerGate);

// --- 5. The password endpoints (inside Access, outside the session check) ----

/**
 * Exchanges the admin password for a session cookie.
 *
 * The limiter runs before the password is read, and counts the attempt whether or
 * not it succeeds -- a success then clears the counter, so ordinary use never
 * accumulates. Deriving the PBKDF2 key is by far the most expensive thing this
 * Worker does on a request path, which is the whole reason the limiter is first.
 */
app.post("/auth/login", async (c) => {
  const nonce = c.get("nonce");
  const next = safeNextPath(c.req.query("next")) ?? undefined;

  const ipHash = await hashClientIp(c.req.raw, c.env);
  const store = d1LoginAttemptStore(c.env.DB);
  const decision = await recordLoginAttempt(store, ipHash, Math.floor(Date.now() / 1000));
  if (!decision.allowed) {
    return loginPage({
      nonce,
      next,
      error: "Too many attempts. Try again later.",
      status: 429,
      headers: { "retry-after": String(decision.retryAfterSeconds) },
    });
  }

  let form: FormData | null = null;
  try {
    form = await c.req.raw.formData();
  } catch {
    // A missing or unparseable body is simply a failed attempt, handled below.
  }
  const password = form?.get("password");
  const stored = c.env.PASSWORD_HASH;
  if (stored !== undefined && isCostUnsupported(stored)) {
    // Every attempt against this secret can only 500, and the owner's password is
    // not the problem, so "Wrong password." would be a lie they could not act on.
    // The count is not logged: it is in the secret, and the message says enough.
    logLine("error", "login.hash_cost_unsupported", {
      maxIterations: MAX_PBKDF2_ITERATIONS,
    });
    return loginPage({
      nonce,
      next,
      error: "Sign-in is misconfigured: re-run `npm run set-password`.",
      status: 500,
    });
  }
  // Declared without an initializer: every path out of the try/catch below either
  // assigns it or returns, and a dead `= false` is what `no-useless-assignment`
  // objects to.
  let ok: boolean;
  try {
    ok =
      typeof password === "string" &&
      stored !== undefined &&
      (await verifyPassword(password, stored));
  } catch (error) {
    // `verifyPassword` returns false for every malformed *envelope*, but the
    // runtime can still refuse a well-formed one: deployed workerd caps PBKDF2 at
    // 100,000 iterations and throws above it, which is how the first real login
    // 500'd. There is no SPA on this page, so an unhandled throw here reaches the
    // owner as `{"error":"internal_error"}` in the viewport. An HTML page with the
    // same 500 is the same signal, legibly.
    logLine("error", "login.verify_failed", errorFields(error));
    return loginPage({
      nonce,
      next,
      error: "Something went wrong signing in. Check the Worker logs.",
      status: 500,
    });
  }

  if (!ok) {
    // One message for every failure mode -- wrong password, missing field,
    // PASSWORD_HASH not configured. Distinguishing them tells an attacker
    // something about the deployment.
    return loginPage({ nonce, next, error: "Wrong password." });
  }

  await forgetLoginAttempts(store, ipHash);
  // 303 so the browser follows with a GET; a 302 after a form POST is re-POSTed
  // by some clients.
  return new Response(null, {
    status: 303,
    headers: {
      location: next ?? "/",
      "set-cookie": await issueSession(c.env),
      "cache-control": "no-store",
    },
  });
});

/**
 * Ends the session.
 *
 * Reachable without a valid session on purpose (see SESSION_EXEMPT_PATHS in
 * gate.ts): the useful case for "sign out" is a cookie the owner no longer trusts,
 * and answering that with a 401 would leave it in the browser.
 */
app.post("/auth/logout", () => {
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": clearSessionCookie(),
      "cache-control": "no-store",
    },
  });
});

// --- 6. The MCP consent page ------------------------------------------------

/**
 * Approving an MCP grant is the single most sensitive action in the app, and this
 * screen is what stands between a registered client and the whole medical record.
 * It is reached only after Cloudflare Access and the password session; its POST is
 * additionally Origin-checked by the guard registered above. See
 * `worker/mcp/consent-page.ts` for the rest of the reasoning.
 *
 * `@cloudflare/workers-oauth-provider` does NOT serve `/authorize` itself -- it
 * advertises the path in its metadata and forwards the request to this handler,
 * which is why the consent page lives inside the gated app rather than beside the
 * token endpoint.
 */
app.get("/authorize", (c) => consentPage(c.req.raw, c.env, c.get("nonce")));
app.post("/authorize", (c) => consentDecision(c.req.raw, c.env, c.get("nonce")));
app.all("/authorize", (c) =>
  c.json<ApiError>({ error: "method_not_allowed" }, 405, { "cache-control": "no-store" }),
);

// --- 7. The routers other changes fill in -----------------------------------
app.route("/api", apiRouter);
app.route("/oauth", oauthRouter);

// --- 8. The SPA ------------------------------------------------------------

/**
 * Last, so a request only reaches the built assets after clearing both gates.
 *
 * `run_worker_first: true` in wrangler.jsonc is what routes asset requests through
 * this Worker at all, and `not_found_handling: single-page-application` is what
 * makes an unknown path return index.html so the Vue router can own it.
 *
 * Caching, and the gotcha:
 *   - /assets/* are content-hashed by Vite, so they are immutable forever.
 *   - The 304 case has to be rewritten too. A revalidation response's headers
 *     REPLACE the ones the browser stored, so returning Workers Assets' default
 *     `max-age=0, must-revalidate` on a 304 silently downgrades an entry that was
 *     cached as immutable, and every later load pays a round trip again.
 *   - The content-type check keeps the SPA fallback from being marked immutable:
 *     a MISSING /assets/... path returns index.html with status 200, and freezing
 *     that for a year under an asset URL would be unrecoverable.
 *   - index.html itself is `no-store`. It names the hashed bundles, so a cached
 *     copy pins the app to an old deploy.
 *
 * The response is always re-wrapped: headers on a response that came from a
 * subrequest are immutable, and the securityHeaders middleware has to be able to
 * write to them on the way out.
 */
app.all("*", async (c) => {
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(asset.headers);
  const isImmutable =
    new URL(c.req.url).pathname.startsWith("/assets/") &&
    (asset.ok || asset.status === 304) &&
    !(headers.get("content-type") ?? "").includes("text/html");
  headers.set("cache-control", isImmutable ? "public, max-age=31536000, immutable" : "no-store");
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
});

app.notFound((c) => c.json<ApiError>({ error: "not_found" }, 404));

app.onError((error, c) => {
  // The body carries the stable error code and nothing else. An AppError's
  // message can quote an upstream response, and an upstream response here can
  // carry patient detail, so it never reaches the client.
  if (isAppError(error)) {
    // `errorCode`, not `code`: the redactor drops a bare `code` (it names the
    // OAuth authorization code), which would make every one of these read
    // "[redacted]".
    logLine("warn", "app_error", { errorCode: error.code });
    return c.json<ApiError>({ error: error.code }, error.status as ContentfulStatusCode, {
      "cache-control": "no-store",
    });
  }
  // Deliberately opaque for the same reason. The structured logger is the only
  // thing that gets to see the cause.
  // Through the redactor, not `console.error` directly: a non-`AppError` message
  // is upstream text -- a jose failure quoting the team domain, a RangeError
  // naming the time zone -- and Workers Logs is not the place for it.
  logLine("error", "unhandled", errorFields(error));
  return c.json<ApiError>({ error: "internal_error" }, 500, { "cache-control": "no-store" });
});
