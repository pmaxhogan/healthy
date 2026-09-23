/**
 * The sandboxed "Try a tool" JSON editor/viewer: where it is served from, and the
 * postMessage protocol between the admin SPA (`src/components/McpToolTester.vue`)
 * and the sandboxed page it embeds (`src/sandbox/SandboxApp.vue`).
 *
 * ### Why this exists
 *
 * CodeMirror 6 styles itself by injecting a stylesheet, and on a browser with no
 * `adoptedStyleSheets` support that fallback is an inline `<style>` tag -- which
 * needs `'unsafe-inline'` in `style-src`. Rather than loosen the whole admin
 * console's CSP for one component, the argument editor and the request/result
 * viewers run inside a second, tiny page (`MCP_SANDBOX_PATH`) with its own,
 * narrower CSP (`worker/auth/security-headers.ts`) that allows inline styles and
 * nothing this app's main CSP does not already forbid twice over: no fetch of any
 * kind, no form submission, framable only by this origin. See SECURITY.md.
 *
 * `src/components/McpToolTester.vue` embeds it as
 * `<iframe sandbox="allow-scripts">` -- deliberately with no `allow-same-origin`,
 * so the frame gets a fresh opaque origin every load. That is what makes the rest
 * of the design sound: an opaque-origin document has no cookies, no
 * `localStorage`, and cannot call `/api` (the sandbox's own `connect-src 'none'`
 * forbids it outright, and there is no session to send even if it tried). It can
 * only do what postMessage lets it do.
 *
 * ### Validating messages across the boundary
 *
 * An opaque origin's `event.origin` is the literal string `"null"` on every
 * message it sends, so origin-string comparison cannot tell one sandboxed frame's
 * message from another's. Both sides instead check `event.source` -- the actual
 * window object that called `postMessage`, which identity-compares correctly
 * regardless of origin opacity -- and, since even a same-source message could be
 * malformed, the shape of `event.data` with {@link isSandboxInboundMessage} /
 * {@link isSandboxOutboundMessage} before acting on it. Neither side ever
 * trusts a message it cannot fully validate.
 */

/**
 * Where the sandboxed page is served from. A real file Vite builds as a second
 * entry (`tool-sandbox.html`), but this is deliberately the extension-less
 * form -- two landmines, found by hand against the real dev server, neither of
 * which a type checker or a unit test can see:
 *
 *  1. It must not start with `/mcp`. `worker/index.ts` hands
 *     `@cloudflare/workers-oauth-provider` `apiRoute: "/mcp"`, matched as a
 *     *prefix* -- so a path like `/mcp-sandbox.html` is routed to the
 *     bearer-token-validated MCP API handler instead of ever reaching the
 *     Hono app or the asset fallback, answering every request with 401 and a
 *     `WWW-Authenticate: Bearer` header no browser navigating an iframe will
 *     ever satisfy.
 *  2. It must not carry `.html`. Workers Assets' default `html_handling`
 *     redirects a request for `/tool-sandbox.html` to `/tool-sandbox` (307),
 *     and `worker/auth/security-headers.ts` matches this constant against
 *     `c.req.path` *exactly* -- so requesting the `.html` form would land the
 *     sandbox's page on the strict default CSP after the redirect (no
 *     `unsafe-inline`, and `frame-ancestors 'none'`/`x-frame-options: DENY`,
 *     which would refuse to be framed at all). Embedding the extension-less
 *     path directly reaches the real file with no redirect and the right CSP
 *     in one request. `test/unit/shared/mcp-sandbox.test.ts` pins both rules.
 */
export const MCP_SANDBOX_PATH = "/tool-sandbox";

/**
 * Parent -> frame.
 *
 * `tool` carries everything the frame needs to reset its argument editor for a
 * newly-selected tool: the schema to validate against and a starting skeleton
 * (`src/lib/mcp-schema.ts`) to prefill it with. `result` and `call-error` are the
 * two possible outcomes of the one authenticated call the parent makes on the
 * frame's behalf, mirroring `McpToolCallResponse`'s `result` field and the shape
 * `ApiRequestError` carries, respectively (`shared/types.ts`, `src/api/client.ts`).
 */
export type SandboxInboundMessage =
  | {
      type: "tool";
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      skeleton: Record<string, unknown>;
    }
  | { type: "result"; isError: boolean; data: unknown; durationMs: number }
  | { type: "call-error"; message: string; issues?: string[] };

/**
 * Frame -> parent.
 *
 * `ready` is sent once, right after the frame attaches its own message
 * listener, so the parent knows it is safe to post the currently-selected tool
 * (a `tool` message sent before the frame is listening would simply be lost).
 * `run` carries the frame's own already-schema-validated arguments -- but the
 * parent treats them as untrusted input regardless: they cross a postMessage
 * boundary from a sandboxed document, and the Worker's own input-schema check
 * (`worker/mcp/admin-call.ts`) is the real authority either way.
 */
export type SandboxOutboundMessage =
  { type: "ready" } | { type: "run"; name: string; arguments: Record<string, unknown> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is one of the messages the frame answers, in the shape it declares. */
export function isSandboxOutboundMessage(value: unknown): value is SandboxOutboundMessage {
  return (
    isPlainObject(value) &&
    (value.type === "ready" ||
      (value.type === "run" && typeof value.name === "string" && isPlainObject(value.arguments)))
  );
}

/** Whether `value` is one of the messages the parent sends, in the shape it declares. */
export function isSandboxInboundMessage(value: unknown): value is SandboxInboundMessage {
  return (
    isPlainObject(value) &&
    ((value.type === "tool" &&
      typeof value.name === "string" &&
      typeof value.description === "string" &&
      isPlainObject(value.inputSchema) &&
      isPlainObject(value.skeleton)) ||
      (value.type === "result" &&
        typeof value.isError === "boolean" &&
        typeof value.durationMs === "number") ||
      (value.type === "call-error" && typeof value.message === "string"))
  );
}
