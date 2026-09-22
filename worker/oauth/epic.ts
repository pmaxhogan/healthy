/**
 * The Epic standalone patient launch: `/oauth/epic/start` and `/oauth/callback`.
 *
 * Four details here are Epic-specific and each one fails silently if it is wrong,
 * which is why they are stated rather than inferred:
 *
 *  - **`aud` is the FHIR base, byte for byte.** Epic compares it as a string. A
 *    trailing slash added or removed produces an authorize page that never
 *    redirects back, with no error anywhere the owner can see. The value goes
 *    straight from `providers.fhir_base_url` to the URL, untouched.
 *  - **The redirect URI is locked.** `/oauth/callback` -- exactly what is
 *    registered in the Epic developer portal, for both the deployed origin and
 *    `http://localhost:8787`. It is built from the request's own origin so both
 *    work from one build, and it must be identical on the authorize request and
 *    the code exchange or the exchange is refused.
 *  - **The client id depends on the environment.** Epic issues a non-production id
 *    for the sandbox and a production id after "Ready for Production", and they are
 *    different strings for the same app.
 *  - **Scopes are asked for in full.** Epic silently drops any scope the app is not
 *    registered for, so the effective grant is the intersection of what was
 *    requested and what was registered; `scope` on the token response is the only
 *    honest account of what was granted, and it is stored.
 *
 * The state row is what makes the callback safe: 10 minutes, single use (a
 * `DELETE ... RETURNING`), and it carries the sealed PKCE verifier. A replayed
 * callback finds nothing.
 */

import { Hono } from "hono";

import { afterResponse } from "../api/http.ts";
import { getPorts } from "../api/ports.ts";
import { isLiveProvider } from "../api/routes/providers.ts";
import { reposFor } from "../db/index.ts";
import { SEARCH_REGISTRY } from "../fhir/search-registry.ts";
import { AppError } from "../lib/errors.ts";
import { makeLogger } from "../lib/log.ts";
import { createPkce } from "../providers/pkce.ts";
import { adapterFor } from "../providers/registry.ts";

import { discoverCached } from "./discovery.ts";
import { invalidStatePage, oauthPage, providerRefusedPage } from "./pages.ts";

import type { AppHonoEnv } from "../auth/gate.ts";
import type { ProviderRow } from "../db/rows.ts";
import type { Env } from "../env.ts";
import type { Context } from "hono";

/** Registered with Epic. Changing this string means re-registering the app. */
const EPIC_CALLBACK_PATH = "/oauth/callback";

/** How long a start link is good for. Long enough to sign in, short enough to matter. */
export const STATE_TTL_MS = 10 * 60 * 1000;

const VENDOR = "epic";

export const epicRouter = new Hono<AppHonoEnv>();

/** Every resource type the registry knows, which is what the app asks scopes for. */
function allResourceTypes(): string[] {
  return [...new Set(SEARCH_REGISTRY.map((entry) => entry.resourceType))];
}

/**
 * The client id for one provider's Epic environment.
 *
 * Missing is a deployment fault, not a user error, so it renders a 500 page: there
 * is nothing the owner can do in the UI about an unset Worker secret, and a 400
 * would suggest there was.
 */
function clientIdFor(env: Env, environment: ProviderRow["environment"]): string {
  const clientId = environment === "sandbox" ? env.EPIC_CLIENT_ID_NONPROD : env.EPIC_CLIENT_ID_PROD;
  if (clientId === undefined || clientId === "") {
    throw new AppError("internal", "epic_client_id_not_configured", { environment });
  }
  return clientId;
}

function callbackUri(requestUrl: string): string {
  return new URL(EPIC_CALLBACK_PATH, requestUrl).href;
}

function epicAdapter(fetchImpl: typeof fetch): ReturnType<typeof adapterFor> {
  return adapterFor(VENDOR, {
    fetchImpl,
    logger: makeLogger({ src: "oauth.epic" }),
    now: Date.now,
  });
}

/** The 500 page for an unset Epic client id. */
function clientIdMissingPage(c: Context<AppHonoEnv>): Response {
  return oauthPage({
    nonce: c.get("nonce"),
    heading: "Epic client id not configured",
    detail:
      "This deployment has no Epic client id for that environment. Set EPIC_CLIENT_ID_NONPROD (sandbox) or EPIC_CLIENT_ID_PROD (production) as a Worker secret and try again.",
    code: "epic_client_id_not_configured",
    status: 500,
  });
}

/**
 * `GET /oauth/epic/start?provider=<id>`
 *
 * Ends in a 302 to the organisation's authorize endpoint. Everything before that
 * redirect is preparation that must be durable, because the browser leaves: the
 * state row is written before the redirect is issued, never after.
 */
epicRouter.get("/epic/start", async (c) => {
  const nonce = c.get("nonce");
  const providerId = c.req.query("provider") ?? "";
  const repos = reposFor(c.env.DB, c.env, { log: makeLogger({ src: "oauth.epic" }) });

  const provider = providerId === "" ? null : await repos.providers.get(providerId);
  if (!isLiveProvider(provider)) {
    return oauthPage({
      nonce,
      heading: "No such connection",
      detail:
        "That connection does not exist, or it has been removed. Add it again from the dashboard.",
      code: "provider_not_found",
      status: 404,
    });
  }

  let clientId: string;
  try {
    clientId = clientIdFor(c.env, provider.environment);
  } catch {
    return clientIdMissingPage(c);
  }

  const ports = getPorts();
  const config = await discoverCached(provider.vendor, provider.fhir_base_url, {
    fetchImpl: ports.fetch,
  });
  const pkce = await createPkce();
  const state = await repos.oauthStates.put({
    kind: "epic",
    providerId: provider.id,
    codeVerifier: pkce.verifier,
    ttlMs: STATE_TTL_MS,
  });

  const authorizeUrl = epicAdapter(ports.fetch).buildAuthorizeUrl({
    authorizeUrl: config.authorizeUrl,
    clientId,
    redirectUri: callbackUri(c.req.url),
    scopes: epicAdapter(ports.fetch).scopesFor(allResourceTypes()),
    state,
    codeChallenge: pkce.challenge,
    // Exactly as stored. See the module comment.
    aud: provider.fhir_base_url,
  });
  return c.redirect(authorizeUrl, 302);
});

/**
 * `GET /oauth/callback` -- Epic's redirect back.
 *
 * The order of the failure checks is the order of increasing trust: an `error`
 * parameter is handled before the state is consumed, so a provider that refused the
 * request does not burn the owner's state row for a flow they may retry.
 */
epicRouter.get("/callback", async (c) => {
  const nonce = c.get("nonce");
  const error = c.req.query("error");
  const providerHint = c.req.query("provider") ?? "";
  if (error !== undefined && error !== "") {
    // The code only. `error_description` is third-party text landing in a document.
    return providerRefusedPage(
      nonce,
      error,
      providerHint === "" ? "/" : `/oauth/epic/start?provider=${encodeURIComponent(providerHint)}`,
    );
  }

  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  if (code === "" || state === "") return invalidStatePage(nonce);

  const log = makeLogger({ src: "oauth.epic" });
  const repos = reposFor(c.env.DB, c.env, { log });
  const consumed = await repos.oauthStates.consume(state);
  // `kind` is checked as well as existence: a Google state must not be redeemable
  // at the Epic callback, even though only this app ever mints either.
  if (consumed?.kind !== "epic" || consumed.providerId === null) {
    return invalidStatePage(nonce);
  }

  const provider = await repos.providers.get(consumed.providerId);
  if (!isLiveProvider(provider)) {
    return oauthPage({
      nonce,
      heading: "No such connection",
      detail: "That connection was removed while the sign-in was in progress.",
      code: "provider_not_found",
      status: 404,
    });
  }

  let clientId: string;
  try {
    clientId = clientIdFor(c.env, provider.environment);
  } catch {
    return clientIdMissingPage(c);
  }

  const clientSecret = await repos.providers.getClientSecret(provider.id);
  if (clientSecret === null) {
    return oauthPage({
      nonce,
      heading: "This connection has no client secret yet",
      detail:
        "Epic issues a separate client secret for each organisation, and this one has not been added. Paste it into the connection's settings, then start the connection again.",
      code: "client_secret_missing",
      status: 409,
      retryPath: "/",
    });
  }

  const ports = getPorts();
  const config = await discoverCached(provider.vendor, provider.fhir_base_url, {
    fetchImpl: ports.fetch,
  });
  const tokens = await epicAdapter(ports.fetch).exchangeCode({
    tokenUrl: config.tokenUrl,
    clientId,
    clientSecret,
    code,
    // Identical to the authorize request's, or Epic refuses the exchange.
    redirectUri: callbackUri(c.req.url),
    codeVerifier: consumed.codeVerifier,
    tokenAuthMethods: config.tokenAuthMethods,
  });

  const connection = await repos.connections.upsertTokens(provider.id, {
    patientFhirId: tokens.patientId,
    accessToken: tokens.accessToken,
    // TokenSet.expiresAt is epoch milliseconds; the column is a unix second.
    accessExpiresAt: Math.floor(tokens.expiresAt / 1000),
    ...(tokens.refreshToken !== null && { refreshToken: tokens.refreshToken }),
    scope: tokens.scope,
    status: "connected",
  });
  await repos.connections.markConnected(connection.id);

  // Both of these are best effort: the connection is already good, and neither a
  // Trello outage nor an unwired sync engine is a reason to tell the owner that
  // reconnecting failed when it did not.
  try {
    await ports.sync.resolveReconnectAlert(repos.ctx, { providerId: provider.id });
  } catch {
    log.warn("oauth.epic.alert_not_resolved", { providerId: provider.id });
  }
  afterResponse(c, "oauth.epic.sync", () =>
    ports.sync.runCalendarSync(repos.ctx, { providerIds: [provider.id], trigger: "manual" }),
  );

  return c.redirect(`/?connected=${encodeURIComponent(provider.id)}`, 302);
});
