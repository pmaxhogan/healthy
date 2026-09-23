import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { MCP_SANDBOX_PATH } from "@shared/mcp-sandbox.ts";

import {
  contentSecurityPolicy,
  sandboxContentSecurityPolicy,
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

function sandboxDirectives(nonce = NONCE): Map<string, string> {
  const map = new Map<string, string>();
  for (const directive of sandboxContentSecurityPolicy(nonce).split("; ")) {
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

  // The one exception to "this app has no unsafe-inline anywhere" is
  // `sandboxContentSecurityPolicy()`, a different function for a different
  // route -- this one, the whole app's default, must never gain it by accident.
  it("never allows unsafe-inline or unsafe-eval in style-src, under any nonce", () => {
    expect(directives().get("style-src")).not.toContain("unsafe-inline");
    expect(contentSecurityPolicy(NONCE)).not.toContain("unsafe-inline");
    expect(contentSecurityPolicy(NONCE)).not.toContain("unsafe-eval");
  });
});

describe("sandboxContentSecurityPolicy", () => {
  it("is the one place this app allows an inline style, and allows nothing else inline", () => {
    expect(sandboxDirectives().get("style-src")).toBe("'unsafe-inline'");
    expect(sandboxContentSecurityPolicy(NONCE)).not.toContain("unsafe-eval");
  });

  // Regression test: the sandbox page is a single, self-contained HTML file
  // (vite.sandbox.config.ts) with no <script src> at all -- an ES module
  // fetched that way is always CORS-mode with credentials "same-origin", and
  // this page's sandboxed, opaque origin makes that fetch genuinely
  // cross-origin, so it is sent with no cookie and ownerGate answers with the
  // login page instead of the script. Inlining the script sidesteps that, but
  // an inline script still needs a nonce (or 'unsafe-inline', which this app
  // never uses for script-src). worker/app.ts stamps this same nonce onto the
  // <script> tag with HTMLRewriter.
  it("carries the nonce in script-src, never 'self' or unsafe-inline", () => {
    expect(sandboxDirectives().get("script-src")).toBe(`'nonce-${NONCE}'`);
    expect(sandboxDirectives().get("script-src")).not.toContain("'self'");
    expect(sandboxDirectives().get("script-src")).not.toContain("unsafe-inline");
    // frame-ancestors is unaffected and stays 'self': it is checked against the
    // embedding page's (never opaque) origin, not this document's own.
    expect(sandboxDirectives().get("frame-ancestors")).toBe("'self'");
  });

  it("permits no fetch of any kind and no form submission", () => {
    expect(sandboxDirectives().get("default-src")).toBe("'none'");
    expect(sandboxDirectives().get("connect-src")).toBe("'none'");
    expect(sandboxDirectives().get("img-src")).toBe("'none'");
    expect(sandboxDirectives().get("font-src")).toBe("'none'");
    expect(sandboxDirectives().get("form-action")).toBe("'none'");
  });

  it("is framable only by this origin -- it exists to be embedded, not visited", () => {
    expect(sandboxDirectives().get("frame-ancestors")).toBe("'self'");
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

  it("gives every path but the sandbox the strict default CSP and DENY", () => {
    for (const path of [
      undefined,
      "/",
      "/connectors",
      "/tool-sandbox.html",
      "/tool-sandbox/nope",
    ]) {
      const entries = securityHeaderEntries(NONCE, path);
      expect(entries["content-security-policy"], String(path)).toBe(contentSecurityPolicy(NONCE));
      expect(entries["x-frame-options"], String(path)).toBe("DENY");
    }
  });

  it("gives exactly MCP_SANDBOX_PATH the sandbox CSP and SAMEORIGIN", () => {
    const entries = securityHeaderEntries(NONCE, MCP_SANDBOX_PATH);

    expect(entries["content-security-policy"]).toBe(sandboxContentSecurityPolicy(NONCE));
    expect(entries["x-frame-options"]).toBe("SAMEORIGIN");
  });
});

function appWith(handler: (nonce: string) => Response): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", securityHeaders);
  app.get("/", (c) => handler(c.get("nonce")));
  app.get(MCP_SANDBOX_PATH, (c) => handler(c.get("nonce")));
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

  it("serves the sandbox CSP and SAMEORIGIN on MCP_SANDBOX_PATH, end to end", async () => {
    const app = appWith(() => new Response("ok"));

    const response = await app.request(MCP_SANDBOX_PATH);
    const nonce = response.headers.get("content-security-policy")?.match(/'nonce-([^']+)'/u)?.[1];

    expect(nonce).toBeTruthy();
    expect(response.headers.get("content-security-policy")).toBe(
      sandboxContentSecurityPolicy(nonce ?? ""),
    );
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("still serves the strict default CSP and DENY everywhere else, end to end", async () => {
    const app = appWith(() => new Response("ok"));

    const response = await app.request("/");

    expect(response.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
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
