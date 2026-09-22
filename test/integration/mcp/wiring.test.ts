// How the two front doors divide the URL space.
//
// `worker/index.ts` wraps the whole Hono app in `OAuthProvider`, and the provider
// decides -- by path -- whether a request is its own, the MCP's, or the app's. Get
// that division wrong and either the OAuth endpoints disappear behind the password
// gate (no client can ever connect) or `/oauth/callback` stops reaching Hono (no
// health system can ever be reconnected). Neither failure is visible from the
// admin UI, so it is asserted here.
//
// The discriminator used throughout: the Hono app stamps
// `content-security-policy` on every response it produces, and the OAuth provider
// stamps none. Its presence or absence says which handler answered, independently
// of the status code.

import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { app } from "../../../worker/app.ts";
import { MIN_PBKDF2_ITERATIONS, hashPassword } from "../../../worker/auth/password.ts";

import type { Env } from "../../../worker/env.ts";

const ORIGIN = "https://healthy.example";
const PASSWORD = "the-owners-password";

/** DEV_MODE on, so the Access half of the gate is relaxed and the session is not. */
const GATED_ENV = {
  ...env,
  DEV_MODE: "true",
  PASSWORD_HASH: await hashPassword(PASSWORD, MIN_PBKDF2_ITERATIONS),
  SESSION_SECRET: "integration-test-signing-material",
} as unknown as Env;

async function gated(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(ORIGIN + path, init), GATED_ENV, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** A password session cookie, ready to send back. */
async function sessionCookie(): Promise<string> {
  const form = new FormData();
  form.set("password", PASSWORD);
  const response = await gated("/auth/login", {
    method: "POST",
    headers: { origin: ORIGIN },
    body: form,
  });
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
}

describe("the authorization server metadata", () => {
  it("is served publicly, as JSON, with this server's one scope", async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(body.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(body.scopes_supported).toStrictEqual(["health:read"]);
  });

  it("requires PKCE S256 and does not offer the implicit flow", async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    const body = await response.json<Record<string, unknown>>();

    expect(body.code_challenge_methods_supported).toStrictEqual(["S256"]);
    expect(body.response_types_supported).toStrictEqual(["code"]);
    expect(body.grant_types_supported).not.toContain("implicit");
  });

  it("is not gated -- a client has no Access identity and no password", async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);

    // The gate would have answered 403 here, and Hono would have stamped a CSP.
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("x-healthy-auth")).toBeNull();
  });
});

describe("the protected resource metadata", () => {
  it("names the resource and its scope", async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource`);
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(body.resource_name).toBe("Healthy");
    expect(body.scopes_supported).toStrictEqual(["health:read"]);
  });

  it("derives the resource from the request origin rather than a pinned URL", async () => {
    // Pinning `resourceMetadata.resource` would bind every token's audience to one
    // hostname and break both `wrangler dev` and this test file.
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource`);
    const body = await response.json<Record<string, unknown>>();

    expect(String(body.resource)).toContain("healthy.example");
  });
});

describe("/mcp", () => {
  it("refuses an unauthenticated call with 401 and a bearer challenge", async () => {
    const response = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    // The provider answered, not the Hono gate.
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("refuses a made-up bearer token", async () => {
    const response = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(401);
  });

  it("does not fall through to the SPA or the gate", async () => {
    const response = await SELF.fetch(`${ORIGIN}/mcp`);
    const body = await response.text();

    expect(body).not.toContain("<!doctype html>");
  });
});

describe("the provider's own endpoints", () => {
  it("claims POST /oauth/token exactly, and answers it itself", async () => {
    const response = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=nope",
    });
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(typeof body.error).toBe("string");
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("claims POST /oauth/register exactly, and answers it itself", async () => {
    const response = await SELF.fetch(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("content-security-policy")).toBeNull();
  });
});

describe("everything else still reaches Hono", () => {
  it("GET /oauth/callback -- the Epic redirect -- is the app's, not the provider's", async () => {
    // The one that would break silently. `/oauth/token` and `/oauth/register` are
    // matched by exact pathname, so the sibling callback routes must fall through.
    const response = await SELF.fetch(`${ORIGIN}/oauth/callback?code=abc&state=xyz`);
    const body = await response.text();

    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-healthy-auth")).toBe("required");
    expect(body).not.toContain("invalid_request");
  });

  it("GET /oauth/google/callback likewise", async () => {
    const response = await SELF.fetch(`${ORIGIN}/oauth/google/callback?code=abc`);
    await response.text();

    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("the /oauth router answers a signed-in request, not the provider", async () => {
    const cookie = await sessionCookie();

    const response = await gated("/oauth/callback?code=abc", { headers: { cookie } });
    const body = await response.text();

    // Whatever the app's callback route decides about an unknown `state`, the
    // headers say who answered: only Hono stamps a CSP, and an OAuth-provider
    // refusal would carry `error_description` and no CSP at all.
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(body).not.toContain("error_description");
  });

  it("GET /health is public, through the provider and past the gate", async () => {
    const response = await SELF.fetch(`${ORIGIN}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ ok: true });
  });
});

describe("/authorize", () => {
  it("answers the login form, not a consent page, with no session", async () => {
    const response = await gated("/authorize?response_type=code&client_id=whatever");
    const html = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("x-healthy-auth")).toBe("required");
    expect(html).toContain('name="password"');
    expect(html).not.toContain("Approve");
    // And the whole request survives in ?next, so signing in resumes the flow.
    expect(html).toContain("next=%2Fauthorize%3Fresponse_type%3Dcode");
  });

  it("refuses an unparseable authorisation request once signed in", async () => {
    const cookie = await sessionCookie();

    const response = await gated("/authorize", { headers: { cookie } });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("Cannot authorise");
    expect(html).not.toContain("Approve");
  });

  it("refuses an unregistered client rather than rendering consent for it", async () => {
    const cookie = await sessionCookie();

    const response = await gated(
      "/authorize?response_type=code&client_id=never-registered&redirect_uri=https%3A%2F%2Fevil.example%2Fcb",
      { headers: { cookie } },
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).not.toContain("evil.example");
  });

  it("rejects a cross-origin POST before it can approve anything", async () => {
    const cookie = await sessionCookie();

    const response = await gated("/authorize", {
      method: "POST",
      headers: { origin: "https://evil.example", cookie },
    });
    await response.text();

    expect(response.status).toBe(403);
  });

  it("answers 405 for a method that is neither GET nor POST", async () => {
    const cookie = await sessionCookie();

    const response = await gated("/authorize", {
      method: "PUT",
      headers: { origin: ORIGIN, cookie, "x-healthy-csrf": "1" },
    });

    expect(response.status).toBe(405);
    expect(await response.json()).toStrictEqual({ error: "method_not_allowed" });
  });
});
