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
 *  - `resourceMetadata.resource` is required since 1.x (omitting it is a
 *    construction-time error) and it is what every access token's audience is
 *    bound to. It cannot be a single hardcoded value here: `/mcp`'s own bearer
 *    check independently recomputes "the resource this request just hit"
 *    (`${protocol}//${host}${pathname}`) and rejects a token whose audience
 *    disagrees, so a resource pinned to the production domain would 401 every
 *    call made through `wrangler dev` or a test origin -- both were, and still
 *    are, real deployments of this Worker, not lesser ones. `resourceFor()`
 *    below reproduces exactly what 0.x did automatically when
 *    `resourceMetadata` was left unset: derive the resource from the request
 *    that is actually being served. The provider is constructed per request
 *    (`worker/index.ts`) rather than once at module scope so this can happen at
 *    all; construction is synchronous config validation, not I/O, so the extra
 *    construction per request costs nothing meaningful in a single-user Worker.
 *  - `disallowPublicClientRegistration: false` is the library default, stated
 *    anyway: claude.ai registers itself through Dynamic Client Registration as a
 *    public client, and without DCR the connector cannot be added at all.
 *  - `allowPlainPKCE: false` requires S256, per OAuth 2.1.
 *  - `clientRegistrationTTL` is set well past the library's 90-day default: a
 *    registration expiring is what forces claude.ai to re-run DCR, which forces
 *    the owner back through the consent page. Refresh tokens already rotate and
 *    expire independently (`REFRESH_TOKEN_TTL`), so the registration itself does
 *    not need a short leash to keep access time-bounded.
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

/**
 * A syntactically valid resource used only when there is no request to derive
 * one from: `oauthHelpers()` called without a request, for the admin API's
 * grant listing and revocation. `listUserGrants`, `revokeGrant` and
 * `lookupClient` are resource-agnostic KV operations -- the library never
 * consults `resourceMetadata.resource` to serve them -- so this value is never
 * actually bound to or checked against a real token. It only has to satisfy
 * the provider constructor's syntax validation.
 */
const PLACEHOLDER_RESOURCE = "https://healthy.maxhogan.dev";

/**
 * The canonical resource (RFC 8707) for whichever origin `request` arrived on.
 *
 * The bare origin, not `${origin}${MCP_API_ROUTE}`: a resource with path `/`
 * covers every path under it (`audienceMatches`'s `pathname === "/"` case), so
 * a token audience still matches the real `/mcp` request, exactly as when 0.x
 * derived the resource from the request origin. It also keeps the protected
 * resource metadata document at the bare `/.well-known/oauth-protected-resource`
 * -- `getResourceMetadataUrl` only appends the resource's path when it isn't
 * `/` -- which is where this Worker's own wiring and clients expect it.
 */
export function resourceFor(request: Request): string {
  return new URL(request.url).origin;
}

/** One hour, matching the locked spec. */
const ACCESS_TOKEN_TTL = 3600;
/** Thirty days. */
const REFRESH_TOKEN_TTL = 30 * 24 * 3600;
/**
 * One year. The library defaults a dynamically-registered client to 90 days,
 * which would make claude.ai silently re-register -- and the owner re-approve
 * the consent page -- every three months even though nothing about the
 * connection changed. Refresh tokens still rotate and expire on their own
 * schedule (`REFRESH_TOKEN_TTL`), so lengthening this does not lengthen how
 * long a stolen token stays useful.
 */
const CLIENT_REGISTRATION_TTL = 365 * 24 * 3600;

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

/** Everything but the handlers and the resource. `worker/index.ts` adds those. */
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
  clientRegistrationTTL: CLIENT_REGISTRATION_TTL,
  tokenExchangeCallback: stampCallerProps,
};

/** `OAUTH_CORE` plus the one piece that has to vary per request: the resource. */
export function oauthCoreFor(resource: string): typeof OAUTH_CORE & {
  resourceMetadata: { resource: string; resource_name: string; scopes_supported: string[] };
} {
  return {
    ...OAUTH_CORE,
    resourceMetadata: {
      resource,
      resource_name: "Healthy",
      scopes_supported: [MCP_SCOPE],
    },
  };
}

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
 *
 * `request` matters only for the fallback, and only because `parseAuthRequest`
 * and `completeAuthorization` (the consent page's calls) bind a resource into
 * what they return -- a resource that must agree with whatever the *real*
 * per-request provider in `worker/index.ts` will later check a token against.
 * Passing the request lets the fallback derive the same resource
 * (`resourceFor`) instead of a placeholder. The admin API's grant listing and
 * revocation never bind or check a resource, so they can omit it.
 */
export function oauthHelpers(env: Env, request?: Request): OAuthHelpers {
  const resource = request ? resourceFor(request) : PLACEHOLDER_RESOURCE;
  return (
    (env as OAuthEnv).OAUTH_PROVIDER ??
    getOAuthApi<Env>(
      {
        ...oauthCoreFor(resource),
        apiRoute: MCP_API_ROUTE,
        apiHandler: UNROUTED,
        defaultHandler: UNROUTED,
      },
      env,
    )
  );
}
