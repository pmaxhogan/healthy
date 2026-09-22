// The OAuth surface, mounted at /oauth by app.ts.
//
//   GET /oauth/epic/start?provider=   -- begin a provider authorisation
//   GET /oauth/callback               -- Epic's redirect back (locked URI)
//   GET /oauth/google/start           -- begin calendar authorisation
//   GET /oauth/google/callback        -- Google's redirect back
//   GET /oauth/reconnect/:id          -- the link inside a Trello card
//
// Two notes for anyone changing this file.
//
// The MCP client-facing endpoints (`POST /oauth/token`, `POST /oauth/register`
// and `/.well-known/*`) do NOT belong here. They are served by
// @cloudflare/workers-oauth-provider, which wraps this whole Hono app in
// worker/index.ts, and they must bypass the owner gate -- an MCP client has no
// Access identity and no password session.
//
// Every route that DOES live here is gated, and is reached by a top-level browser
// navigation redirected from a third party. The session cookie is `SameSite=Lax`
// precisely so that navigation carries it (owner decision, 2026-09-22; `Strict`
// bounced every callback through the password page). If the session has lapsed
// the gate answers with the login page carrying `?next=` set to the full callback
// URL including its query, and signing in resumes the flow. The callback is a
// GET that mutates nothing until the single-use `state` row is consumed, which
// is what protects it.
//
// Responses are HTML or a 302, never JSON, because every one of them is rendered
// in the address bar. The exception is the catch-all below: an unknown /oauth path
// was not reached by a redirect from anywhere, so it is answered like any other
// unknown path.

import { Hono } from "hono";

import { isLiveProvider } from "../api/routes/providers.ts";
import { reposFor } from "../db/index.ts";
import { isAppError } from "../lib/errors.ts";
import { logLine, makeLogger } from "../lib/log.ts";

import { epicRouter } from "./epic.ts";
import { googleOAuthRouter, unknownConnectionPage } from "./google.ts";
import { oauthPage } from "./pages.ts";

import type { AppHonoEnv } from "../auth/gate.ts";
import type { ApiError } from "@shared/types.ts";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const oauthRouter = new Hono<AppHonoEnv>();

/**
 * A thrown failure anywhere in a flow becomes a page, not JSON.
 *
 * Only the stable code travels. An `AppError`'s message here can quote an
 * organisation's own error response, which is exactly the kind of text that must
 * not be rendered into a document or written to a log.
 */
oauthRouter.onError((error, c) => {
  const code = isAppError(error) ? error.code : "internal";
  const status = (isAppError(error) ? error.status : 500) as ContentfulStatusCode;
  logLine("warn", "oauth_failed", { code, path: c.req.path });
  return oauthPage({
    nonce: c.get("nonce"),
    heading: "That did not work",
    detail:
      "Healthy could not finish setting up this connection. Nothing has been changed, so it is safe to try again from the dashboard.",
    code,
    status,
  });
});

oauthRouter.route("/", epicRouter);
oauthRouter.route("/", googleOAuthRouter);

/**
 * `GET /oauth/reconnect/:connectionId` -- the link in a Trello card.
 *
 * It is a redirect rather than a page so the card's link does the whole job: the
 * owner taps it on a phone, clears Access and the password, and lands on the
 * portal's sign-in. One hop, no decisions.
 *
 * `:connectionId` accepts three things, because three different things hold a
 * reference to a connection and making the caller normalise them is how a card ends
 * up with a dead link:
 *
 *   - the literal `google` (which is what `alerts.subject` holds for the calendar
 *     account -- it has no connection row at all)
 *   - a `connections.id`, which is what the admin UI has
 *   - a `providers.id`, which is what a reconnect alert's subject encodes
 */
oauthRouter.get("/reconnect/:connectionId", async (c) => {
  const id = c.req.param("connectionId");
  if (id === "google") return c.redirect("/oauth/google/start", 302);

  const repos = reposFor(c.env.DB, c.env, { log: makeLogger({ src: "oauth.reconnect" }) });
  const connection = await repos.connections.get(id);
  const providerId = connection?.provider_id ?? id;
  const provider = await repos.providers.get(providerId);
  return isLiveProvider(provider)
    ? c.redirect(`/oauth/epic/start?provider=${encodeURIComponent(provider.id)}`, 302)
    : unknownConnectionPage(c.get("nonce"));
});

/** An unknown /oauth path. See the note above about why this one is JSON. */
oauthRouter.all("*", (c) =>
  c.json<ApiError>({ error: "not_found" }, 404, { "cache-control": "no-store" }),
);
