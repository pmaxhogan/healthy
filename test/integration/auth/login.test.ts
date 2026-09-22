// The login flow end to end, in real workerd against real D1.
//
// This is where the rate limiter's SQL is exercised: the UPSERT in
// worker/auth/ratelimit.ts runs against the actual `login_attempts` table created
// by migrations/0001_init.sql, so a schema change that breaks it breaks this file.
//
// `app.fetch` with a hand-built env rather than `SELF`, because wrangler.jsonc
// necessarily ships DEV_MODE="false" and PASSWORD_HASH is a secret. See the note
// in test/integration/app/public.test.ts.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../../../worker/app.ts";
import { MIN_PBKDF2_ITERATIONS, hashPassword } from "../../../worker/auth/password.ts";
import { hashClientIp } from "../../../worker/auth/ratelimit.ts";

import type { Env } from "../../../worker/env.ts";

const ORIGIN = "https://healthy.example";
const PASSWORD = "the-owners-password";
const CSRF = { "x-healthy-csrf": "1" };

// Minted here rather than hard-coded, at the documented floor: the verifier and
// the minter are the same module, so a format change cannot pass this file while
// breaking production. The production cost is asserted separately, against this
// same runtime, in test/integration/worker.test.ts.
const overrides: Partial<Env> = {
  DEV_MODE: "true",
  PASSWORD_HASH: await hashPassword(PASSWORD, MIN_PBKDF2_ITERATIONS),
  SESSION_SECRET: "integration-test-signing-material",
};

// The cast is load-bearing only for `HEALTHY_MCP`: `wrangler types` narrows it to
// `DurableObjectNamespace<HealthyMcp>`, which is not assignable to the
// unparameterised `DurableObjectNamespace` that worker/env.ts declares. The
// overrides above are typed, so it cannot hide a typo in one of them.
const TEST_ENV = { ...env, ...overrides } as unknown as Env;

/**
 * A distinct client IP per test.
 *
 * The rate limiter buckets by `cf-connecting-ip`, and the D1 row it writes
 * survives from one test in this file to the next -- so without this, a test that
 * spends its window would poison every test after it. Each test therefore gets its
 * own bucket, and the one test that exercises the limit still makes all of its
 * attempts from a single address.
 */
const client = { ip: "", counter: 0 };

beforeEach(() => {
  client.counter += 1;
  client.ip = `203.0.113.${String(client.counter)}`;
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(ORIGIN + path, init);
  request.headers.set("cf-connecting-ip", client.ip);
  const ctx = createExecutionContext();
  const response = await app.fetch(request, TEST_ENV, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function loginBody(password = PASSWORD): FormData {
  const form = new FormData();
  form.set("password", password);
  return form;
}

/** A same-origin form POST: `Origin` is what a browser sends, and it is the CSRF proof. */
function formPost(password = PASSWORD, path = "/auth/login"): Promise<Response> {
  return call(path, { method: "POST", headers: { origin: ORIGIN }, body: loginBody(password) });
}

/** The `login_attempts` key for this test's client, computed by production code. */
function currentIpHash(): Promise<string> {
  return hashClientIp(
    new Request(`${ORIGIN}/auth/login`, {
      method: "POST",
      headers: { "cf-connecting-ip": client.ip },
    }),
  );
}

/** Reads and discards a body, so nothing is left unconsumed between requests. */
async function drain(response: Response): Promise<void> {
  await response.text();
}

/** The session cookie out of a Set-Cookie header, ready to send back. */
function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";", 1)[0] ?? "";
}

describe("the gate, with no session", () => {
  it("answers /api/* with a JSON 401 and the auth marker", async () => {
    const response = await call("/api/whoami");

    expect(response.status).toBe(401);
    expect(response.headers.get("x-healthy-auth")).toBe("required");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toStrictEqual({ error: "unauthorized" });
  });

  it("answers a page request with the login form, not JSON", async () => {
    const response = await call("/settings");
    const html = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-healthy-auth")).toBe("required");
    expect(html).toContain('name="password"');
    // The path to return to travels on the form action, so signing in resumes it.
    expect(html).toContain("next=%2Fsettings");
  });

  it("keeps the query string in ?next, because an OAuth callback is nothing without it", async () => {
    // SameSite=Strict drops the cookie on the cross-site redirect back from a
    // provider, so the callback itself lands here and must be resumable whole.
    const response = await call("/oauth/google/callback?code=abc&state=xyz");
    const html = await response.text();

    expect(html).toContain("%3Fcode%3Dabc%26state%3Dxyz");
  });
});

describe("GET /auth/login", () => {
  it("is gated like any other page, and is not a way past the session check", async () => {
    // The session exemption is scoped to POST. Were it path-only, this GET would
    // fall through the gate to the SPA asset fallback and serve the admin UI to a
    // request with no session at all.
    const response = await call("/auth/login");
    const html = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-healthy-auth")).toBe("required");
    // A bookmarkable login URL, with no ?next -- safeNextPath refuses /auth/*, so
    // signing in here lands on the app root rather than looping back to the form.
    expect(html).toContain('action="/auth/login"');
  });
});

describe("POST /auth/login", () => {
  it("rejects the wrong password with a 401 and the same generic message", async () => {
    const response = await formPost("not-the-password");
    const html = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(html).toContain("Wrong password.");
  });

  it("accepts the right password, sets the session cookie, and 303s", async () => {
    const response = await formPost();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");

    const cookieHeader = response.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain("healthy_session=");
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("Secure");
    expect(cookieHeader).toContain("SameSite=Strict");
    expect(cookieHeader).toContain("Path=/");
  });

  it("returns to a same-origin ?next", async () => {
    const response = await call("/auth/login?next=%2Fsettings%3Ftab%3Dgoogle", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: loginBody(),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings?tab=google");
  });

  it("ignores a ?next that would leave the origin", async () => {
    for (const next of [
      "https://evil.example/",
      "//evil.example/",
      String.raw`/\evil.example`,
      "/auth/login",
    ]) {
      const response = await call(`/auth/login?next=${encodeURIComponent(next)}`, {
        method: "POST",
        headers: { origin: ORIGIN },
        body: loginBody(),
      });

      expect(response.status, next).toBe(303);
      expect(response.headers.get("location"), next).toBe("/");
    }
  });

  it("closes the gate after 10 attempts in the window and sends Retry-After", async () => {
    // One test, not several: the pool gives each test its own storage, so the
    // whole sequence has to share a single D1.
    for (let attempt = 1; attempt <= 10; attempt++) {
      const response = await formPost("wrong");
      expect(response.status, `attempt ${String(attempt)}`).toBe(401);
      await response.text();
    }

    const blocked = await formPost("wrong");
    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    const blockedHtml = await blocked.text();
    expect(blockedHtml).toContain("Too many attempts");

    // And the right password does not get through either, so the limiter cannot be
    // bypassed by finally guessing correctly.
    const correct = await formPost();
    expect(correct.status).toBe(429);
    expect(correct.headers.get("set-cookie")).toBeNull();
    await correct.text();
  });

  it("records attempts against a hash of the client IP, never the address", async () => {
    await drain(await formPost("wrong"));
    const ipHash = await currentIpHash();

    const row = await env.DB.prepare("SELECT ip_hash, count FROM login_attempts WHERE ip_hash = ?")
      .bind(ipHash)
      .first<{ ip_hash: string; count: number }>();

    expect(row?.count).toBe(1);
    expect(row?.ip_hash).toMatch(/^[0-9a-f]{64}$/u);
    // The address itself is personal data; the table is a lasting record of who
    // tried to log in, so it must hold only the digest.
    const anyAddress = await env.DB.prepare(
      "SELECT count(*) AS n FROM login_attempts WHERE ip_hash LIKE '%203.0.113%'",
    ).first<{ n: number }>();
    expect(anyAddress?.n).toBe(0);
  });

  it("clears the counter on success, so ordinary use never accumulates", async () => {
    const ipHash = await currentIpHash();
    const countFor = async (): Promise<number | undefined> => {
      const row = await env.DB.prepare("SELECT count(*) AS n FROM login_attempts WHERE ip_hash = ?")
        .bind(ipHash)
        .first<{ n: number }>();
      return row?.n;
    };

    for (let attempt = 0; attempt < 5; attempt++) await drain(await formPost("wrong"));
    expect(await countFor()).toBe(1);

    await formPost();

    expect(await countFor()).toBe(0);
  });
});

describe("a request carrying the session cookie", () => {
  it("reaches /api/whoami", async () => {
    const cookie = cookieFrom(await formPost());

    const response = await call("/api/whoami", { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ ok: true });
    expect(response.headers.get("x-healthy-auth")).toBeNull();
  });

  it("still gets a JSON 404 for an /api path that does not exist", async () => {
    // Never the SPA's index.html: an HTML body would turn a mistyped fetch into a
    // parse error instead of a clear 404.
    const cookie = cookieFrom(await formPost());

    const response = await call("/api/nope", { headers: { cookie } });

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({ error: "not_found" });
  });

  it("reaches the MCP consent page, which refuses a request with no OAuth parameters", async () => {
    // The consent page itself is covered in test/integration/mcp/; what matters
    // here is that a signed-in request gets past the gate to it at all.
    const cookie = cookieFrom(await formPost());

    const response = await call("/authorize", { headers: { cookie } });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("Cannot authorise");
  });

  it("reaches the SPA fallback, re-wrapped so the security headers stay writable", async () => {
    // The assertion is deliberately not about what ./dist holds -- it is empty on a
    // clean checkout, because `npm run check` runs the tests before the build. What
    // is under test is that the handler CLONES the response it got back from the
    // ASSETS subrequest: those headers are immutable, so without the clone the
    // securityHeaders middleware throws when it stamps the CSP on the way out.
    const cookie = cookieFrom(await formPost());

    const response = await call("/dashboard", { headers: { cookie } });
    await drain(response);

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("gets a JSON 404 from an unknown /oauth path", async () => {
    // The real routes under /oauth answer with a 302 or an HTML page; an unknown
    // path there is answered like any other unknown path. See
    // test/integration/oauth/ for the routes themselves.
    const cookie = cookieFrom(await formPost());

    const response = await call("/oauth/not-a-flow", { headers: { cookie } });

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({ error: "not_found" });
  });
});

describe("POST /auth/logout", () => {
  it("expires the cookie and redirects", async () => {
    const cookie = cookieFrom(await formPost());

    const response = await call("/auth/logout", {
      method: "POST",
      headers: { origin: ORIGIN, cookie, ...CSRF },
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    const cookieHeader = response.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain("healthy_session=;");
    expect(cookieHeader).toContain("Max-Age=0");
    expect(cookieHeader).toContain("SameSite=Strict");
  });

  it("works from a session that is already gone, so a distrusted cookie can be dropped", async () => {
    const response = await call("/auth/logout", {
      method: "POST",
      headers: { origin: ORIGIN, ...CSRF },
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("no longer opens /api/whoami with the cleared cookie value", async () => {
    const response = await call("/api/whoami", { headers: { cookie: "healthy_session=" } });

    expect(response.status).toBe(401);
  });
});

describe("with Cloudflare Access failing", () => {
  // DEV_MODE off and no Access secrets configured: verifyAccess fails closed,
  // which is the production posture for a request that did not come through
  // Access. This is the half of the gate the rest of the file cannot see, because
  // it runs with the Access check relaxed.
  const CLOSED_ENV = { ...env, ...overrides, DEV_MODE: "false" } as unknown as Env;

  async function callClosed(path: string, init: RequestInit = {}): Promise<Response> {
    const request = new Request(ORIGIN + path, init);
    request.headers.set("cf-connecting-ip", client.ip);
    const ctx = createExecutionContext();
    const response = await app.fetch(request, CLOSED_ENV, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("answers /api/* with a JSON 403, not a 401", async () => {
    // 403, not 401: the identity is wrong, and no password retry fixes that.
    const response = await callClosed("/api/whoami");

    expect(response.status).toBe(403);
    expect(response.headers.get("x-healthy-auth")).toBe("required");
    expect(await response.json()).toStrictEqual({ error: "forbidden" });
  });

  it("answers a page with a refusal, never the password form", async () => {
    const response = await callClosed("/settings");
    const html = await response.text();

    expect(response.status).toBe(403);
    expect(html).not.toContain('name="password"');
  });

  it("refuses POST /auth/login even with the correct password", async () => {
    // This is the ordering that matters: the password endpoint is INSIDE Access, so
    // it is not an oracle anyone on the internet can guess against.
    const response = await callClosed("/auth/login", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: loginBody(),
    });
    await drain(response);

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("still serves the public pages", async () => {
    const response = await callClosed("/about");
    await drain(response);

    expect(response.status).toBe(200);
  });
});

describe("CSRF", () => {
  it("rejects a state-changing /api request with no x-healthy-csrf header", async () => {
    const cookie = cookieFrom(await formPost());

    const response = await call("/api/settings", {
      method: "POST",
      headers: { origin: ORIGIN, cookie, "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toStrictEqual({ error: "forbidden" });
  });

  it("rejects /auth/logout with no x-healthy-csrf header", async () => {
    const cookie = cookieFrom(await formPost());

    const response = await call("/auth/logout", {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a cross-origin POST even with the header", async () => {
    const cookie = cookieFrom(await formPost());

    const response = await call("/api/settings", {
      method: "POST",
      headers: { origin: "https://evil.example", cookie, ...CSRF },
      body: "{}",
    });

    expect(response.status).toBe(403);
  });

  it("guards POST /authorize, which matches neither /api/* nor /auth/*", async () => {
    // POST /authorize is the MCP consent approval: the most sensitive POST in the
    // app. An HTML form cannot send the CSRF header, so the same-origin proof is
    // the whole defence and it has to hold.
    const cookie = cookieFrom(await formPost());

    const cross = await call("/authorize", {
      method: "POST",
      headers: { origin: "https://evil.example", cookie },
    });
    await drain(cross);
    expect(cross.status).toBe(403);

    // Same-origin gets through the guard to the consent handler, which then
    // refuses this particular body for having no authorisation request in it.
    const same = await call("/authorize", {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
    });
    expect(same.status).toBe(400);
    await drain(same);
  });

  it("rejects a cross-origin login form post", async () => {
    const response = await call("/auth/login", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: loginBody(),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a POST with no origin proof at all", async () => {
    const response = await call("/auth/login", { method: "POST", body: loginBody() });

    expect(response.status).toBe(403);
  });

  it("accepts Sec-Fetch-Site: same-origin in place of Origin", async () => {
    const response = await call("/auth/login", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: loginBody(),
    });

    expect(response.status).toBe(303);
  });

  it("leaves safe methods alone", async () => {
    const cookie = cookieFrom(await formPost());

    // No Origin, no CSRF header, and still fine: a GET changes nothing.
    const response = await call("/api/whoami", { headers: { cookie } });

    expect(response.status).toBe(200);
  });
});
