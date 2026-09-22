import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  contentSecurityPolicy,
  securityHeaderEntries,
  securityHeaders,
  type AuthVariables,
} from "../../../worker/auth/security-headers.ts";

const NONCE = "test-nonce";

function directives(nonce = NONCE): Map<string, string> {
  const map = new Map<string, string>();
  for (const directive of contentSecurityPolicy(nonce).split("; ")) {
    const space = directive.indexOf(" ");
    map.set(directive.slice(0, space), directive.slice(space + 1));
  }
  return map;
}

describe("contentSecurityPolicy", () => {
  it("locks every fetch directive to this origin by default", () => {
    expect(directives().get("default-src")).toBe("'self'");
    expect(directives().get("connect-src")).toBe("'self'");
    expect(directives().get("font-src")).toBe("'self'");
  });

  it("allows no inline or remote script whatsoever", () => {
    // No nonce and no hash for scripts, deliberately: every page this Worker
    // renders itself is script-free, and the SPA's bundles come from /assets.
    expect(directives().get("script-src")).toBe("'self'");
  });

  it("allows inline styles only through the per-response nonce", () => {
    expect(directives().get("style-src")).toBe(`'self' 'nonce-${NONCE}'`);
    expect(contentSecurityPolicy(NONCE)).not.toContain("unsafe-inline");
    expect(contentSecurityPolicy(NONCE)).not.toContain("unsafe-eval");
  });

  it("allows data: images, for inline SVG and icons, and nothing else remote", () => {
    expect(directives().get("img-src")).toBe("'self' data:");
  });

  it("blocks framing, plugins, base rewriting and off-origin form posts", () => {
    expect(directives().get("frame-ancestors")).toBe("'none'");
    expect(directives().get("object-src")).toBe("'none'");
    expect(directives().get("base-uri")).toBe("'none'");
    expect(directives().get("form-action")).toBe("'self'");
  });

  it("carries the nonce it was given", () => {
    expect(contentSecurityPolicy("abc123")).toContain("'nonce-abc123'");
    expect(contentSecurityPolicy("abc123")).not.toContain(NONCE);
  });
});

describe("securityHeaderEntries", () => {
  it("sends no referrer anywhere", () => {
    expect(securityHeaderEntries(NONCE)["referrer-policy"]).toBe("no-referrer");
  });

  it("forbids content-type sniffing", () => {
    expect(securityHeaderEntries(NONCE)["x-content-type-options"]).toBe("nosniff");
  });

  it("denies every powerful browser feature", () => {
    const policy = securityHeaderEntries(NONCE)["permissions-policy"] ?? "";

    for (const feature of ["camera", "geolocation", "microphone", "payment", "usb"]) {
      expect(policy, feature).toContain(`${feature}=()`);
    }
    // An allowlist with anything in it would be a bug; every entry must be empty.
    expect(policy).not.toMatch(/=\((?!\))/u);
  });

  it("asks for HSTS for a year, subdomains included", () => {
    expect(securityHeaderEntries(NONCE)["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });
});

function appWith(handler: (nonce: string) => Response): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", securityHeaders);
  app.get("/", (c) => handler(c.get("nonce")));
  return app;
}

describe("the securityHeaders middleware", () => {
  it("stamps every header on the response", async () => {
    const response = await appWith(() => new Response("ok")).request("/");
    const names = Object.keys(securityHeaderEntries(NONCE));

    for (const name of names) {
      expect(response.headers.get(name), name).not.toBeNull();
    }
  });

  it("publishes the same nonce to the handler that it puts in the CSP", async () => {
    let seen = "";
    const response = await appWith((nonce) => {
      seen = nonce;
      return new Response("ok");
    }).request("/");

    expect(seen).not.toBe("");
    expect(response.headers.get("content-security-policy")).toContain(`'nonce-${seen}'`);
  });

  it("mints a fresh nonce per response", async () => {
    const app = appWith(() => new Response("ok"));

    const first = await app.request("/");
    const second = await app.request("/");

    expect(first.headers.get("content-security-policy")).not.toBe(
      second.headers.get("content-security-policy"),
    );
  });
});
