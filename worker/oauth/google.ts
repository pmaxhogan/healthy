/**
 * Google Calendar authorisation: `/oauth/google/start` and `/oauth/google/callback`.
 *
 * Simpler than the Epic flow in two ways and subtler in one.
 *
 * Simpler: there is one Google account and one client, so there is no health system to
 * look up and no per-organisation secret; and Google's client does not use PKCE
 * here, so the `oauth_states` row carries a throwaway verifier purely to satisfy
 * the NOT NULL column. (The row's real job is the `state` nonce, which is checked
 * exactly as Epic's is: ten minutes, single use, `kind` must match.)
 *
 * Subtler: **the account label.** This app never asks for `openid email`, because
 * it has no business holding the owner's address for its own sake. But the UI does
 * need to show which Google account is connected, or a re-consent into the wrong
 * account is invisible. So the primary calendar's id is read from the calendar
 * scopes the grant already includes, sealed into `google_account.email_enc`, and
 * masked (`p…n@gmail.com`) on the way to the UI. It is never logged.
 */

import { Hono } from "hono";

import { getPorts } from "../api/ports.ts";
import { reposFor } from "../db/index.ts";
import { newToken } from "../lib/ids.ts";
import { makeLogger } from "../lib/log.ts";

import { STATE_TTL_MS } from "./epic.ts";
import { googleOAuthFor } from "./google-client.ts";
import { invalidStatePage, oauthPage, providerRefusedPage } from "./pages.ts";

import type { AppHonoEnv } from "../auth/gate.ts";

export const googleOAuthRouter = new Hono<AppHonoEnv>();

/** `alerts.subject` for the calendar account. Mirrors `db/repos/alerts.ts`. */
const GOOGLE_SUBJECT = "google";

googleOAuthRouter.get("/google/start", async (c) => {
  const repos = reposFor(c.env.DB, c.env, { log: makeLogger({ src: "oauth.google" }) });
  const ports = getPorts();
  const { client } = googleOAuthFor(c.env, c.req.url, ports.fetch);

  const state = await repos.oauthStates.put({
    kind: "google",
    // No health system: a `google` state must have a NULL health_system_id (the table has a
    // CHECK that says so).
    codeVerifier: newToken(),
    ttlMs: STATE_TTL_MS,
  });
  return c.redirect(client.buildAuthUrl({ state }), 302);
});

googleOAuthRouter.get("/google/callback", async (c) => {
  const nonce = c.get("nonce");
  const error = c.req.query("error");
  if (error !== undefined && error !== "") {
    return providerRefusedPage(nonce, error, "/oauth/google/start");
  }

  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  if (code === "" || state === "") return invalidStatePage(nonce);

  const log = makeLogger({ src: "oauth.google" });
  const repos = reposFor(c.env.DB, c.env, { log });
  const consumed = await repos.oauthStates.consume(state);
  if (consumed?.kind !== "google") return invalidStatePage(nonce);

  const ports = getPorts();
  const { client } = googleOAuthFor(c.env, c.req.url, ports.fetch);
  const tokens = await client.exchangeCode(code);

  // Display only, and best effort: the client returns null rather than throwing, so
  // a hiccup here leaves the account connected but unlabelled instead of failing a
  // consent the owner just granted.
  const primary = await client.primaryCalendarSummary(tokens.accessToken);

  await repos.google.upsertTokens({
    ...(primary !== null && { email: primary.id }),
    accessToken: tokens.accessToken,
    // GoogleTokens.expiresAt is epoch milliseconds; the column is a unix second.
    accessExpiresAt: Math.floor(tokens.expiresAt / 1000),
    refreshToken: tokens.refreshToken,
    scope: tokens.scope,
    status: "connected",
  });
  await repos.google.markConnected();

  try {
    await ports.sync.resolveReconnectAlert(repos.ctx, GOOGLE_SUBJECT);
  } catch {
    log.warn("oauth.google.alert_not_resolved");
  }

  return c.redirect("/?google=connected", 302);
});

/** A `not_connected` page, for a reconnect link whose subject has gone away. */
export function unknownConnectionPage(nonce: string): Response {
  return oauthPage({
    nonce,
    heading: "No such connection",
    detail:
      "That reconnect link points at a connection this deployment does not have any more. Open the dashboard to see what is connected.",
    code: "connection_not_found",
    status: 404,
  });
}
