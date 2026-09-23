/**
 * The Worker's entry point: the OAuth provider wrapping everything else.
 *
 * Request topology, top to bottom. `OAuthProvider` looks at the path and the
 * ordering here is the whole of how the two worlds stay separate:
 *
 *   /.well-known/oauth-authorization-server   the provider, itself
 *   /.well-known/oauth-protected-resource*    the provider, itself
 *   POST /oauth/token                         the provider, itself (exact path)
 *   POST /oauth/register                      the provider, itself (exact path)
 *   /mcp*                                     bearer-validated, then HealthyMcp
 *   everything else                           the Hono app
 *
 * The route overlap is deliberate and it is exact, not prefixed: the provider
 * matches its token and registration endpoints with `===` on the pathname, so
 * `/oauth/callback`, `/oauth/google/*` and `/oauth/epic/*` -- every browser
 * redirect back from Epic or Google -- fall through to Hono untouched. Only
 * `/mcp` is matched as a prefix. There is an integration test asserting that
 * `/oauth/callback` reaches Hono, because getting this wrong would break
 * reconnection in a way nothing else would notice.
 *
 * Why the export is a hand-written object rather than the provider instance:
 * `OAuthProvider` exposes `fetch` and `purgeExpiredData`, and nothing else. It is
 * not an `ExportedHandler`, so a `scheduled` handler cannot be hung off it -- the
 * object below is the smallest wrapper that gives the Worker both.
 *
 * Cloudflare Access sits in front of all of this and is configured to let only
 * `/mcp*`, the two provider endpoints, `/.well-known/*` and the public pages past
 * it. Everything the Hono app gates -- the consent page included -- is behind
 * Access as well. That is configuration, not code, and it is described in the
 * README's setup table.
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import { app } from "./app.ts";
import { handleInboundEmail } from "./mail/handler.ts";
import { MCP_API_ROUTE, OAUTH_CORE } from "./mcp/oauth-config.ts";
import { HealthyMcp } from "./mcp/server.ts";
import { handleScheduled } from "./sync/index.ts";

import type { Env } from "./env.ts";

// Re-exported because wrangler resolves Durable Object classes from the
// configured `main` module, not from wherever the class happens to live.
export { HealthyMcp } from "./mcp/server.ts";
export { FullRefreshRunner } from "./sync/runner.ts";
export { PortalSignInRunner } from "./sync/portal-runner.ts";

/**
 * The library requires a non-optional `fetch` on the handlers it is given, while
 * `McpAgent.serve()` and a Hono app both type theirs differently. Wrapping both in
 * this shape is the same workaround the reference implementations use.
 */
interface HandlerWithFetch {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
}

/**
 * The Durable Object binding name is `HEALTHY_MCP` in wrangler.jsonc, which is not
 * the default `MCP_OBJECT` that `McpAgent.serve` assumes -- hence the explicit
 * `binding`. The class name and the binding name are both fixed by migration tag
 * v1 and must not be changed.
 */
const mcpHandler = HealthyMcp.serve(MCP_API_ROUTE, { binding: "HEALTHY_MCP" });

const mcpApiHandler: HandlerWithFetch = {
  fetch: (request, env, ctx) => mcpHandler.fetch(request, env, ctx),
};

const honoHandler: HandlerWithFetch = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
};

const healthSystem = new OAuthProvider<Env>({
  ...OAUTH_CORE,
  apiRoute: MCP_API_ROUTE,
  apiHandler: mcpApiHandler,
  defaultHandler: honoHandler,
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return healthSystem.fetch(request, env, ctx);
  },

  /**
   * Both cron expressions land here and the sync engine dispatches on the string:
   * `7 * * * *` is the hourly appointment sync plus the token keepalive, and
   * `23 6 * * *` is the daily full-scope refresh of the MCP read cache. UTC, both
   * of them -- never translated to local time in a comment, because that would
   * leak the timezone.
   */
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleScheduled(env, controller.cron, ctx);
  },

  /**
   * The 2FA mailbox: `2fa@<the Worker's own hostname>`, routed by Cloudflare
   * Email Routing straight to this Worker. See `worker/mail/handler.ts` for
   * the allowlist-then-classify pipeline and `docs/mail.md` for the setup.
   */
  email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleInboundEmail(message, env, ctx);
  },
} satisfies ExportedHandler<Env>;
