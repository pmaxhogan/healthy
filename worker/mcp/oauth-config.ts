/**
 * The OAuth provider's configuration, in one place and free of handlers.
 *
 * Split out from `worker/index.ts` on purpose. The consent page and the grant
 * helpers both need `OAuthHelpers`, and on a request that came through the
 * provider they get it for free -- the library injects `env.OAUTH_PROVIDER` before
 * it calls the default handler. But the admin API's tests (and any code path that
 * calls the Hono app directly) have no such injection, so there has to be a way to
 * build the helpers from the configuration alone. Putting that configuration here,
 * rather than next to the handlers, is what keeps `consent-page.ts -> index.ts ->
 * app.ts -> consent-page.ts` from being an import cycle.
 *
 * Choices worth knowing about:
 *
 *  - `resourceMetadata.resource` is deliberately NOT set. Configuring it pins
 *    every access token's audience to that exact URL, which would break both
 *    `wrangler dev` on localhost and the integration tests. Left unset, the
 *    library derives the resource from the request origin, which is right at
 *    every origin this Worker is ever served from.
 *  - `disallowPublicClientRegistration: false` is the library default, stated
 *    anyway: claude.ai registers itself through Dynamic Client Registration as a
 *    public client, and without DCR the connector cannot be added at all.
 *  - `allowPlainPKCE: false` requires S256, per OAuth 2.1.
 */

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";

import type { Env } from "../env.ts";
import type {
  OAuthHelpers,
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";

/** The only scope this server issues. Read-only, and there is nothing else to be. */
export const MCP_SCOPE = "health:read";

/** The single user of a single-user deployment. Every grant is owned by them. */
export const OWNER_USER_ID = "owner";

export const MCP_API_ROUTE = "/mcp";
const AUTHORIZE_PATH = "/authorize";
const TOKEN_PATH = "/oauth/token";
const REGISTER_PATH = "/oauth/register";

/** One hour, matching the locked spec. */
const ACCESS_TOKEN_TTL = 3600;
/** Thirty days. */
const REFRESH_TOKEN_TTL = 30 * 24 * 3600;

/** `Env` as the provider hands it to the default handler. */
type OAuthEnv = Env & { OAUTH_PROVIDER?: OAuthHelpers };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Stamp the client and grant ids into the access token's props.
 *
 * This is the only moment they are both known: the consent page cannot record the
 * grant id, because `completeAuthorization` is what creates it. The MCP audit
 * trail needs both ("which client, under which grant, called which tool"), so they
 * are copied onto the token rather than looked up per call.
 *
 * `accessTokenProps` rather than `newProps`: the grant's own props stay as the
 * consent page wrote them, so a refresh re-derives these two from the authoritative
 * ids rather than from a copy that could go stale.
 */
function stampCallerProps(options: TokenExchangeCallbackOptions): TokenExchangeCallbackResult {
  const existing: unknown = options.props;
  return {
    accessTokenProps: {
      ...(isRecord(existing) && existing),
      clientId: options.clientId,
      grantId: options.grantId,
    },
  };
}

/** Everything but the handlers. `worker/index.ts` adds those. */
export const OAUTH_CORE = {
  authorizeEndpoint: AUTHORIZE_PATH,
  tokenEndpoint: TOKEN_PATH,
  clientRegistrationEndpoint: REGISTER_PATH,
  scopesSupported: [MCP_SCOPE],
  allowImplicitFlow: false,
  allowPlainPKCE: false,
  disallowPublicClientRegistration: false,
  accessTokenTTL: ACCESS_TOKEN_TTL,
  refreshTokenTTL: REFRESH_TOKEN_TTL,
  resourceMetadata: {
    resource_name: "Healthy",
    scopes_supported: [MCP_SCOPE],
  },
  tokenExchangeCallback: stampCallerProps,
};

/**
 * A handler that exists only to satisfy the provider's constructor.
 *
 * `getOAuthApi` builds the helpers by constructing a provider, and the constructor
 * insists on an api handler and a default handler even though nothing is going to
 * be routed. It is never reached: the object it belongs to is used for
 * `createOAuthHelpers` and then discarded.
 */
const UNROUTED = {
  fetch(): Response {
    return new Response("not routed", { status: 500 });
  },
};

/**
 * The OAuth helpers for this request.
 *
 * Prefers the instance the provider injected, and falls back to building one from
 * `OAUTH_CORE`. Both read and write the same `OAUTH_KV` namespace, so the fallback
 * is not a second, divergent view of the grants -- it is the same store reached
 * another way.
 */
export function oauthHelpers(env: Env): OAuthHelpers {
  return (
    (env as OAuthEnv).OAUTH_PROVIDER ??
    getOAuthApi<Env>(
      { ...OAUTH_CORE, apiRoute: MCP_API_ROUTE, apiHandler: UNROUTED, defaultHandler: UNROUTED },
      env,
    )
  );
}
