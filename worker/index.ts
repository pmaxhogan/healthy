// Worker entry point.
//
// TODO(wave2): the default export becomes
//   new OAuthProvider({
//     apiRoute: "/mcp",
//     apiHandler: HealthyMcp.serve("/mcp"),
//     defaultHandler: app,
//     authorizeEndpoint: "/authorize",
//     tokenEndpoint: "/oauth/token",
//     clientRegistrationEndpoint: "/oauth/register",
//     scopesSupported: ["health:read"],
//     allowImplicitFlow: false,
//     allowPlainPKCE: false,
//     accessTokenTTL: 3600,
//   })
// with `scheduled` kept alongside it. Until the MCP server and the consent page
// exist, wrapping everything in the OAuth provider would expose token and
// registration endpoints that lead nowhere, so the Hono app is the whole
// handler for now.

import { app } from "./app.ts";

import type { Env } from "./env.ts";

// Re-exported because wrangler resolves Durable Object classes from the
// configured `main` module, not from wherever the class happens to live.
export { HealthyMcp } from "./mcp/server.ts";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  scheduled(controller: ScheduledController, _env: Env, _ctx: ExecutionContext): void {
    // The two cron expressions in wrangler.jsonc are dispatched here by exact
    // string match, so a cron added to the config without a branch here is a
    // visible no-op rather than a silent one.
    switch (controller.cron) {
      case "7 * * * *": {
        // TODO(wave2): hourly Encounter-only calendar sync + token keepalive.
        break;
      }
      case "23 6 * * *": {
        // TODO(wave2): daily full-scope refresh of the MCP read cache, plus
        // retention pruning (mcp_audit > 365d, expired oauth_states).
        break;
      }
      default: {
        console.warn("unhandled cron", { cron: controller.cron });
        break;
      }
    }
  },
} satisfies ExportedHandler<Env>;
