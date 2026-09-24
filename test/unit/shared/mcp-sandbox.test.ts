// The postMessage protocol between src/components/McpToolTester.vue and the
// sandboxed src/sandbox/SandboxApp.vue it embeds. See shared/mcp-sandbox.ts's
// module comment for why an opaque-origin frame needs shape validation on both
// sides instead of an origin check.

import { describe, expect, it } from "vitest";

import {
  MCP_SANDBOX_PATH,
  isSandboxInboundMessage,
  isSandboxOutboundMessage,
} from "../../../shared/mcp-sandbox.ts";

describe("MCP_SANDBOX_PATH", () => {
  // Regression test: worker/index.ts hands @cloudflare/workers-oauth-provider
  // apiRoute: "/mcp", matched as a PREFIX -- so a sandbox path starting with
  // "/mcp" (the original name, "/mcp-sandbox.html") is silently routed to the
  // bearer-token-validated MCP API handler instead of served as a static
  // asset, which answers every request with 401 and no CSP header at all. Only
  // discovered by curling the real dev server; nothing else would catch it.
  it("does not start with /mcp, which the OAuth provider matches as a prefix", () => {
    expect(MCP_SANDBOX_PATH.startsWith("/mcp")).toBe(false);
  });

  // Regression test: Workers Assets' default html_handling 307s a `.html`
  // request to the extension-less path, and worker/auth/security-headers.ts
  // matches this constant against `c.req.path` exactly -- so requesting the
  // `.html` form would serve the sandbox page under the strict default CSP
  // (and frame-ancestors 'none') after the redirect, discovered by curling the
  // real dev server. The constant has to name the path actually served, not
  // the file Vite builds it from.
  it("does not carry .html, which Workers Assets redirects away from", () => {
    expect(MCP_SANDBOX_PATH.endsWith(".html")).toBe(false);
  });
});

describe("isSandboxOutboundMessage", () => {
  it("accepts ready and a well-formed run", () => {
    expect(isSandboxOutboundMessage({ type: "ready" })).toBe(true);
    expect(isSandboxOutboundMessage({ type: "run", name: "get_conditions", arguments: {} })).toBe(
      true,
    );
  });

  it("refuses a run whose name or arguments is the wrong type", () => {
    expect(isSandboxOutboundMessage({ type: "run", name: 1, arguments: {} })).toBe(false);
    expect(isSandboxOutboundMessage({ type: "run", name: "x", arguments: [] })).toBe(false);
    expect(isSandboxOutboundMessage({ type: "run", name: "x", arguments: "not an object" })).toBe(
      false,
    );
    expect(isSandboxOutboundMessage({ type: "run", name: "x" })).toBe(false);
  });

  it("accepts a well-formed resize, including zero and a fraction", () => {
    expect(isSandboxOutboundMessage({ type: "resize", height: 480 })).toBe(true);
    expect(isSandboxOutboundMessage({ type: "resize", height: 0 })).toBe(true);
    expect(isSandboxOutboundMessage({ type: "resize", height: 123.5 })).toBe(true);
  });

  it("refuses a resize whose height is not a finite number", () => {
    expect(isSandboxOutboundMessage({ type: "resize", height: "480" })).toBe(false);
    expect(isSandboxOutboundMessage({ type: "resize", height: NaN })).toBe(false);
    expect(isSandboxOutboundMessage({ type: "resize", height: Infinity })).toBe(false);
    expect(isSandboxOutboundMessage({ type: "resize" })).toBe(false);
  });

  it("refuses anything with an unrecognised type, or no type at all", () => {
    expect(isSandboxOutboundMessage({ type: "tool" })).toBe(false);
    expect(isSandboxOutboundMessage({})).toBe(false);
  });

  it("refuses non-objects, including null and arrays", () => {
    for (const value of [null, undefined, "ready", 1, true, ["ready"]]) {
      expect(isSandboxOutboundMessage(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("isSandboxInboundMessage", () => {
  const tool = {
    type: "tool",
    name: "get_conditions",
    description: "Problem list.",
    inputSchema: { type: "object" },
    skeleton: {},
  };

  it("accepts a well-formed tool, result and call-error", () => {
    expect(isSandboxInboundMessage(tool)).toBe(true);
    expect(
      isSandboxInboundMessage({
        type: "result",
        isError: false,
        data: { items: [] },
        durationMs: 4,
      }),
    ).toBe(true);
    expect(isSandboxInboundMessage({ type: "call-error", message: "no such MCP tool" })).toBe(true);
    expect(
      isSandboxInboundMessage({ type: "call-error", message: "bad schema", issues: ["a: b"] }),
    ).toBe(true);
  });

  it("refuses a tool missing a required field or with the wrong type", () => {
    for (const key of ["name", "description", "inputSchema", "skeleton"]) {
      const rest: Record<string, unknown> = { ...tool };
      Reflect.deleteProperty(rest, key);
      expect(isSandboxInboundMessage(rest), key).toBe(false);
    }
    expect(isSandboxInboundMessage({ ...tool, inputSchema: "not an object" })).toBe(false);
  });

  it("refuses a result missing isError or durationMs, or with the wrong type", () => {
    expect(isSandboxInboundMessage({ type: "result", data: {}, durationMs: 4 })).toBe(false);
    expect(
      isSandboxInboundMessage({ type: "result", isError: "no", data: {}, durationMs: 4 }),
    ).toBe(false);
    expect(isSandboxInboundMessage({ type: "result", isError: false, data: {} })).toBe(false);
  });

  it("refuses a call-error whose message is not a string", () => {
    expect(isSandboxInboundMessage({ type: "call-error", message: 42 })).toBe(false);
    expect(isSandboxInboundMessage({ type: "call-error" })).toBe(false);
  });

  it("refuses anything with an unrecognised type, or no type at all", () => {
    expect(isSandboxInboundMessage({ type: "run" })).toBe(false);
    expect(isSandboxInboundMessage({})).toBe(false);
  });

  it("refuses non-objects, including null and arrays", () => {
    for (const value of [null, undefined, "tool", 1, true, [tool]]) {
      expect(isSandboxInboundMessage(value), JSON.stringify(value)).toBe(false);
    }
  });
});
