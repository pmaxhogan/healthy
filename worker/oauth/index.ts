// The OAuth surface, mounted at /oauth by app.ts.
//
// PLACEHOLDER. The real routes are wave 1/2 and are written by a separate change:
//   GET /oauth/epic/start?provider=   -- begin a provider authorisation
//   GET /oauth/callback               -- provider redirect back (code + state)
//   GET /oauth/google/start           -- begin calendar authorisation
//   GET /oauth/google/callback        -- Google redirect back
//
// WAVE 2: register those on `oauthRouter` below, keeping the catch-all last.
//
// Two notes for whoever fills this in.
//
// The MCP client-facing endpoints (`POST /oauth/token`, `POST /oauth/register`
// and `/.well-known/*`) do NOT belong here. They are served by
// @cloudflare/workers-oauth-provider, which wraps this whole Hono app in
// worker/index.ts, and they must bypass the owner gate -- an MCP client has no
// Access identity and no password session.
//
// Every route that DOES live here is gated, and is reached by a top-level browser
// navigation redirected from a third party. That crosses sites, so the
// `SameSite=Strict` session cookie is not sent: the gate will answer the callback
// with the login page, carrying `?next=` set to the full callback URL including
// its query. Signing in resumes the flow. Do not relax the cookie to `Lax` to
// avoid that -- the redirect-back is exactly the request `Strict` is there to
// protect.

import { Hono } from "hono";

import type { AppHonoEnv } from "../auth/gate.ts";
import type { ApiError } from "@shared/types.ts";

export const oauthRouter = new Hono<AppHonoEnv>();

/** Until the real routes land, every /oauth path is a JSON 404. */
oauthRouter.all("*", (c) =>
  c.json<ApiError>({ error: "not_found" }, 404, { "cache-control": "no-store" }),
);
