// The Hono app: every non-MCP request lands here.
//
// Wave 0 shape. Only /health is real; everything else answers 404 JSON so that
// no route is accidentally open before its gate exists. In particular the SPA
// assets are NOT served yet -- wiring env.ASSETS in before the Access and
// password middleware would publish the admin UI to the internet.

import { Hono } from "hono";

import type { Env } from "./env.ts";
import type { ApiError, HealthResponse } from "@shared/types.ts";

export const app = new Hono<{ Bindings: Env }>();

/**
 * Liveness probe. Public by design (it bypasses Cloudflare Access), so it must
 * never grow a body that says anything about configuration or state.
 */
app.get("/health", (c) => c.json<HealthResponse>({ ok: true }));

// TODO(wave1): public pages -- GET /about, /privacy, /terms (Access bypass).
// TODO(wave1): gates -- Access JWT (jose) -> password session -> CSRF, in that
//   order, as middleware mounted before everything below.
// TODO(wave1): POST /auth/login, POST /auth/logout.
// TODO(wave1): GET /oauth/epic/start, GET /oauth/callback,
//   GET /oauth/google/start, GET /oauth/google/callback,
//   GET /reconnect/:connectionId.
// TODO(wave2): /api/* admin JSON routes.
// TODO(wave2): GET/POST /authorize -- the MCP consent page.
// TODO(wave2): final fallback -> env.ASSETS with SPA fallback, mounted only
//   AFTER the gate middleware is in place.

app.notFound((c) => c.json<ApiError>({ error: "not_found" }, 404));

app.onError((error, c) => {
  // Deliberately opaque: the message may quote an upstream response, and
  // upstream responses can carry patient detail. The structured logger added
  // in wave 1 is the only thing that gets to see the cause.
  console.error("unhandled", { message: error.message });
  return c.json<ApiError>({ error: "internal_error" }, 500);
});
