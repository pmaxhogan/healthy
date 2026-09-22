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
import { makeLogger } from "./lib/log.ts";

import type { Env } from "./env.ts";

const cronLogger = makeLogger({ src: "cron" });

// Re-exported because wrangler resolves Durable Object classes from the
// configured `main` module, not from wherever the class happens to live.
export { HealthyMcp } from "./mcp/server.ts";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  scheduled(controller: ScheduledController, _env: Env, _ctx: ExecutionContext): void {
    // Logged, then returns. Wave 2 dispatches on the exact cron string, which is
    // why the string is the only thing recorded here: the two expressions in
    // wrangler.jsonc are the dispatch keys, so seeing which one fired is what
    // makes a missing branch a visible no-op rather than a silent one.
    //
    // TODO(wave2): "7 * * * *"  -> hourly Encounter-only calendar sync + token
    //              keepalive; "23 6 * * *" -> daily full-scope refresh of the MCP
    //              read cache plus retention pruning (mcp_audit > 365d, expired
    //              oauth_states). UTC, both of them -- never translated to local
    //              time in a comment, because that would leak the timezone.
    cronLogger.info("cron.received", { cron: controller.cron });
  },
} satisfies ExportedHandler<Env>;
