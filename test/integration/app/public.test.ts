// The public surface and the response hardening, in real workerd.
//
// These routes are the only ones an unauthenticated stranger can reach, so what
// they DO NOT say matters as much as what they do.
//
// The app is driven by calling `app.fetch` with an env of this test's own making
// rather than through `SELF`, for one reason: `DEV_MODE` is "false" in
// wrangler.jsonc (it must be -- that file is what production deploys from) and the
// Access secrets are secrets, so a `SELF` request cannot get past gate 1. Real D1
// and the real asset binding still come from `cloudflare:test`.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { app } from "../../../worker/app.ts";

import type { Env } from "../../../worker/env.ts";

const ORIGIN = "https://healthy.example";

/**
 * The real bindings plus the vars and secrets this test needs.
 *
 * The cast is load-bearing only for `HEALTHY_MCP`: `wrangler types` narrows it to
 * `DurableObjectNamespace<HealthyMcp>`, which is not assignable to the
 * unparameterised `DurableObjectNamespace` that worker/env.ts declares. Typing
 * `overrides` as `Partial<Env>` keeps the values under test checked, so the cast
 * cannot hide a typo in one of them.
 */
function testEnv(overrides: Partial<Env>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

// No Cloudflare Access in front of a test runner; the password gate still applies.
const TEST_ENV = testEnv({ DEV_MODE: "true" });

async function get(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(ORIGIN + path, init), TEST_ENV, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("GET /health", () => {
  it("is public and says only that the Worker is up", async () => {
    const response = await get("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ ok: true });
  });
});

describe("the public pages", () => {
  const paths = ["/about", "/privacy", "/terms"];

  it("are reachable with no session", async () => {
    for (const path of paths) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
      // No auth wall marker: these are real content, not a gate.
      expect(response.headers.get("x-healthy-auth"), path).toBeNull();
    }
  });

  it("describe the software, never its operator", async () => {
    for (const path of paths) {
      const response = await get(path);
      const body = await response.text();
      const html = body.toLowerCase();

      // The repository is public and the deployment is one person's medical
      // record. Nothing that identifies either may appear on a page a stranger can
      // read: no health system, no location, no timezone, no Access team domain.
      //
      // The EHR vendor ("Epic MyChart") is named deliberately and is not a leak --
      // it is the software this integrates with, it is already in package.json and
      // in the worker/providers/epic/ path, and the vendor's own app review reads
      // /about. What must never appear is a particular hospital or clinic.
      for (const leak of ["hospital", "@gmail", "cloudflareaccess", "america/"]) {
        expect(html, `${path}: ${leak}`).not.toContain(leak);
      }
      // An email address anywhere here would be personal data; contact is via the
      // public issue tracker instead.
      // Bounded character classes: a class containing `.` followed by a literal
      // `.` backtracks, which the lint rules reject.
      expect(html, path).not.toMatch(/@[\dA-Za-z-]+\.[a-z]{2,}/u);
    }
  });

  it("say what the project is, that it is MIT, and where the source is", async () => {
    const response = await get("/about");
    const about = await response.text();

    expect(about).toContain("https://github.com/pmaxhogan/healthy");
    expect(about).toContain("MIT");
    expect(about.toLowerCase()).toContain("read-only");
  });

  it("explain the data handling on /privacy", async () => {
    const response = await get("/privacy");
    const body = await response.text();
    const privacy = body.toLowerCase();

    expect(privacy).toContain("encrypted");
    expect(privacy).toContain("analytics");
    expect(privacy).toContain("github.com/pmaxhogan/healthy/issues");
  });

  it("disclaim warranty on /terms", async () => {
    const response = await get("/terms");
    const body = await response.text();
    const terms = body.toLowerCase();

    expect(terms).toContain("without warranty");
    expect(terms).toContain("mit");
  });
});

describe("security headers", () => {
  it("are on the public pages too", async () => {
    const response = await get("/about");

    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("put a live nonce in the CSP that matches the page's inline style block", async () => {
    const response = await get("/about");
    const policy = response.headers.get("content-security-policy") ?? "";
    const html = await response.text();

    const nonce = /'nonce-([\w-]+)'/u.exec(policy)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain(`<style nonce="${nonce ?? ""}">`);
  });

  it("are on the JSON surfaces as well", async () => {
    const response = await get("/health");

    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("/authorize", () => {
  it("is gated, not public", async () => {
    // Approving an MCP grant is the most sensitive action in the app. The route is
    // registered ahead of its implementation precisely so its gating is settled.
    const response = await get("/authorize");

    expect(response.status).toBe(401);
    expect(response.headers.get("x-healthy-auth")).toBe("required");
  });
});
