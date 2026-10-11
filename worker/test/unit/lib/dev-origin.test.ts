// `wrangler dev` presents local requests as plain http on the routed custom
// domain; in development they are put back on the loopback origin, and nowhere
// else is anything changed.

import { describe, expect, it } from "vitest";

import { toDevOrigin } from "../../../src/lib/dev-origin.ts";

/** What `wrangler dev` hands the Worker for a request to 127.0.0.1. */
function wranglerDevRequest(path = "/api/health", init: RequestInit = {}): Request {
  const routed = "https://routed.example.test".replace("https:", "http:");
  return new Request(`${routed}${path}?q=1`, {
    ...init,
    headers: { host: "routed.example.test", ...(init.headers as Record<string, string>) },
  });
}

describe("toDevOrigin", () => {
  it("re-addresses a dev request to the default loopback origin, path and query kept", () => {
    const served = toDevOrigin(wranglerDevRequest(), { DEV_MODE: "true" });
    expect(served.url).toBe("http://localhost:8787/api/health?q=1");
    expect(served.headers.get("host")).toBe("localhost:8787");
    // `resourceFor` builds the OAuth resource from this origin, and the provider
    // accepts http only on a loopback host: now it is one.
    expect(new URL(served.url).hostname).toBe("localhost");
  });

  it("uses DEV_ORIGIN for a Worker on another port", () => {
    const served = toDevOrigin(wranglerDevRequest(), {
      DEV_MODE: "true",
      DEV_ORIGIN: "http://localhost:8797",
    });
    expect(new URL(served.url).origin).toBe("http://localhost:8797");
  });

  it("keeps the method, headers and body", async () => {
    const served = toDevOrigin(
      wranglerDevRequest("/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://localhost:8787",
        },
        body: "password=x",
      }),
      { DEV_MODE: "true" },
    );
    expect(served.method).toBe("POST");
    expect(served.headers.get("origin")).toBe("http://localhost:8787");
    await expect(served.text()).resolves.toBe("password=x");
  });

  it("puts a rewritten Origin and Referer back on loopback, and leaves any other alone", () => {
    const routed = "https://routed.example.test".replace("https:", "http:");
    const served = toDevOrigin(
      wranglerDevRequest("/auth/login", {
        method: "POST",
        headers: { origin: routed, referer: `${routed}/auth/login?next=%2F` },
        body: "password=x",
      }),
      { DEV_MODE: "true" },
    );
    expect(served.headers.get("origin")).toBe("http://localhost:8787");
    expect(served.headers.get("referer")).toBe("http://localhost:8787/auth/login?next=%2F");

    const foreign = toDevOrigin(
      wranglerDevRequest("/auth/login", {
        method: "POST",
        headers: { origin: "https://elsewhere.example.test" },
        body: "password=x",
      }),
      { DEV_MODE: "true" },
    );
    expect(foreign.headers.get("origin")).toBe("https://elsewhere.example.test");
  });

  it("changes nothing outside development", () => {
    const request = wranglerDevRequest();
    expect(toDevOrigin(request, { DEV_MODE: "false" })).toBe(request);
    expect(toDevOrigin(request, {})).toBe(request);
  });

  it("never rewrites an https request, which is what production serves", () => {
    const request = new Request("https://routed.example.test/api/health");
    expect(toDevOrigin(request, { DEV_MODE: "true" })).toBe(request);
  });

  it("leaves a request already on loopback alone", () => {
    const request = new Request("http://127.0.0.1:8787/api/health");
    expect(toDevOrigin(request, { DEV_MODE: "true" })).toBe(request);
  });

  it("refuses a DEV_ORIGIN that is not loopback rather than pointing requests at it", () => {
    const request = wranglerDevRequest();
    expect(
      toDevOrigin(request, { DEV_MODE: "true", DEV_ORIGIN: "https://elsewhere.example.test" }),
    ).toBe(request);
  });
});
