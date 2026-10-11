/**
 * The standalone patient launch for a health system: `/oauth/epic/start` and
 * `/oauth/callback`.
 *
 * Written for Epic and named for it -- the start path, the `epic` state kind and
 * this file -- but it drives whichever vendor the health system row names, through
 * `adapterFor`. The names stay because the callback path is registered with each
 * vendor and the state kind is a CHECK constraint; neither is worth a migration
 * to rename.
 *
 * Four details here came from Epic and each one fails silently if it is wrong,
 * which is why they are stated rather than inferred:
 *
 *  - **`aud` is the FHIR base, byte for byte.** Epic compares it as a string. A
 *    trailing slash added or removed produces an authorize page that never
 *    redirects back, with no error anywhere the owner can see. The value goes
 *    straight from `health_systems.fhir_base_url` to the URL, untouched.
 *  - **The redirect URI is locked.** `/oauth/callback` -- exactly what is
 *    registered in the Epic developer portal, for both the deployed origin and
 *    `http://localhost:8787`. It is built from the request's own origin so both
 *    work from one build, and it must be identical on the authorize request and
 *    the code exchange or the exchange is refused.
 *  - **The client id depends on the vendor and the environment.** Epic issues a
 *    non-production id for the sandbox and a production id after "Ready for
 *    Production", and they are different strings for the same app; ModMed issues
 *    one. `ehr/client-id.ts` picks.
 *  - **Scopes are the adapter's call.** Epic silently drops any scope the app is not
 *    registered for, so its adapter asks for everything; ModMed refuses the whole
 *    request over one, so its adapter asks only for what can be registered. Either
 *    way `scope` on the token response is the only honest account of what was
 *    granted, and it is stored.
 *
 * The state row is what makes the callback safe: 10 minutes, single use (a
 * `DELETE ... RETURNING`), and it carries the sealed PKCE verifier. A replayed
 * callback finds nothing.
 */

import { Hono } from "hono";

import { afterResponse } from "../api/http.ts";
import { getPorts } from "../api/ports.ts";
import { isLiveHealthSystem } from "../api/routes/health-systems.ts";
import { reposFor } from "../db/index.ts";
import { clientIdFor, clientIdSecretFor } from "../ehr/client-id.ts";
import { createPkce } from "../ehr/pkce.ts";
import { adapterFor } from "../ehr/registry.ts";
import { SEARCH_REGISTRY } from "../fhir/search-registry.ts";
import { makeLogger } from "../lib/log.ts";

import { discoverCached } from "./discovery.ts";
import { invalidStatePage, oauthPage, authorizationRefusedPage } from "./pages.ts";

import type { AppHonoEnv } from "../auth/gate.ts";
import type { HealthSystemRow } from "../db/rows.ts";
import type { EhrAdapter } from "../ehr/adapter.ts";
import type { Context } from "hono";

/** Registered with every vendor. Changing this string means re-registering each app. */
const EPIC_CALLBACK_PATH = "/oauth/callback";

/** How long a start link is good for. Long enough to sign in, short enough to matter. */
export const STATE_TTL_MS = 10 * 60 * 1000;

export const epicRouter = new Hono<AppHonoEnv>();

/** Every resource type the registry knows, which is what the app asks scopes for. */
function allResourceTypes(): string[] {
  return [...new Set(SEARCH_REGISTRY.map((entry) => entry.resourceType))];
}

function callbackUri(requestUrl: string): string {
  return new URL(EPIC_CALLBACK_PATH, requestUrl).href;
}

function adapterOf(healthSystem: HealthSystemRow, fetchImpl: typeof fetch): EhrAdapter {
  return adapterFor(healthSystem.vendor, {
    fetchImpl,
    logger: makeLogger({ src: "oauth.epic" }),
    now: Date.now,
  });
}

/**
 * The 500 page for an unset client id.
 *
 * A 500 rather than a 400: there is nothing the owner can do in the UI about an
 * unset Worker secret, and a 400 would suggest there was.
 */
function clientIdMissingPage(c: Context<AppHonoEnv>, healthSystem: HealthSystemRow): Response {
  return oauthPage({
    nonce: c.get("nonce"),
    heading: "Client id not configured",
    detail: `This deployment has no client id for that connection. Set ${clientIdSecretFor(healthSystem)} as a Worker secret and try again.`,
    code: "client_id_not_configured",
    status: 500,
  });
}

/**
 * `GET /oauth/epic/start?healthSystem=<id>`
 *
 * Ends in a 302 to the organisation's authorize endpoint. Everything before that
 * redirect is preparation that must be durable, because the browser leaves: the
 * state row is written before the redirect is issued, never after.
 */
epicRouter.get("/epic/start", async (c) => {
  const nonce = c.get("nonce");
  const healthSystemId = c.req.query("healthSystem") ?? c.req.query("provider") ?? "";
  const repos = reposFor(c.env.DB, c.env, { log: makeLogger({ src: "oauth.epic" }) });

  const healthSystem = healthSystemId === "" ? null : await repos.healthSystems.get(healthSystemId);
  if (!isLiveHealthSystem(healthSystem)) {
    return oauthPage({
      nonce,
      heading: "No such connection",
      detail:
        "That connection does not exist, or it has been removed. Add it again from the dashboard.",
      code: "health_system_not_found",
      status: 404,
    });
  }

  let clientId: string;
  try {
    clientId = clientIdFor(c.env, healthSystem);
  } catch {
    return clientIdMissingPage(c, healthSystem);
  }

  const ports = getPorts();
  const config = await discoverCached(healthSystem.vendor, healthSystem.fhir_base_url, {
    fetchImpl: ports.fetch,
  });
  const pkce = await createPkce();
  const state = await repos.oauthStates.put({
    kind: "epic",
    healthSystemId: healthSystem.id,
    codeVerifier: pkce.verifier,
    ttlMs: STATE_TTL_MS,
  });

  const adapter = adapterOf(healthSystem, ports.fetch);
  const authorizeUrl = adapter.buildAuthorizeUrl({
    authorizeUrl: config.authorizeUrl,
    clientId,
    redirectUri: callbackUri(c.req.url),
    scopes: adapter.scopesFor(allResourceTypes()),
    state,
    codeChallenge: pkce.challenge,
    // Exactly as stored. See the module comment.
    aud: healthSystem.fhir_base_url,
  });
  return c.redirect(authorizeUrl, 302);
});

/**
 * `GET /oauth/callback` -- the vendor's redirect back.
 *
 * The order of the failure checks is the order of increasing trust: an `error`
 * parameter is handled before the state is consumed, so a health system that refused the
 * request does not burn the owner's state row for a flow they may retry.
 */
epicRouter.get("/callback", async (c) => {
  const nonce = c.get("nonce");
  const error = c.req.query("error");
  const healthSystemHint = c.req.query("healthSystem") ?? c.req.query("provider") ?? "";
  if (error !== undefined && error !== "") {
    // The code only. `error_description` is third-party text landing in a document.
    return authorizationRefusedPage(
      nonce,
      error,
      healthSystemHint === ""
        ? "/"
        : `/oauth/epic/start?healthSystem=${encodeURIComponent(healthSystemHint)}`,
    );
  }

  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  if (code === "" || state === "") return invalidStatePage(nonce);

  const log = makeLogger({ src: "oauth.epic" });
  const repos = reposFor(c.env.DB, c.env, { log });
  const consumed = await repos.oauthStates.consume(state);
  // `kind` is checked as well as existence: a Google state must not be redeemable
  // at this callback, even though only this app ever mints either. `epic` is the
  // kind for every health system launch, whatever its vendor: see the module comment.
  if (consumed?.kind !== "epic" || consumed.healthSystemId === null) {
    return invalidStatePage(nonce);
  }

  const healthSystem = await repos.healthSystems.get(consumed.healthSystemId);
  if (!isLiveHealthSystem(healthSystem)) {
    return oauthPage({
      nonce,
      heading: "No such connection",
      detail: "That connection was removed while the sign-in was in progress.",
      code: "health_system_not_found",
      status: 404,
    });
  }

  let clientId: string;
  try {
    clientId = clientIdFor(c.env, healthSystem);
  } catch {
    return clientIdMissingPage(c, healthSystem);
  }

  const clientSecret = await repos.healthSystems.getClientSecret(healthSystem.id);
  if (clientSecret === null) {
    return oauthPage({
      nonce,
      heading: "This connection has no client secret yet",
      detail:
        "This connection's client secret has not been added. Paste it into the connection's settings, then start the connection again.",
      code: "client_secret_missing",
      status: 409,
      retryPath: "/",
    });
  }

  const ports = getPorts();
  const config = await discoverCached(healthSystem.vendor, healthSystem.fhir_base_url, {
    fetchImpl: ports.fetch,
  });
  const tokens = await adapterOf(healthSystem, ports.fetch).exchangeCode({
    tokenUrl: config.tokenUrl,
    clientId,
    clientSecret,
    code,
    // Identical to the authorize request's, or the exchange is refused.
    redirectUri: callbackUri(c.req.url),
    codeVerifier: consumed.codeVerifier,
    tokenAuthMethods: config.tokenAuthMethods,
  });

  const connection = await repos.connections.upsertTokens(healthSystem.id, {
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
    await ports.sync.resolveReconnectAlert(repos.ctx, { healthSystemId: healthSystem.id });
  } catch {
    log.warn("oauth.epic.alert_not_resolved", { healthSystemId: healthSystem.id });
  }

  // A calendar sync with nowhere to write is not a failed sync -- it is not a sync
  // at all. Without this, connecting a health system before Google (the normal order on
  // first setup) kicked off a run that could only ever fail with
  // `sync.google_unavailable`, so the first thing the owner saw after a successful
  // connect was a red run. Mirrors the backoff skip in calendar-sync.ts: no run
  // row for work that could not start, just a note that it was skipped.
  const google = await repos.google.get();
  if (google.status === "disconnected") {
    log.info("oauth.epic.sync_skipped_google_disconnected", { healthSystemId: healthSystem.id });
  } else {
    afterResponse(c, "oauth.epic.sync", () =>
      ports.sync.runCalendarSync(repos.ctx, {
        healthSystemIds: [healthSystem.id],
        trigger: "manual",
      }),
    );
  }

  return c.redirect(`/?connected=${encodeURIComponent(healthSystem.id)}`, 302);
});
