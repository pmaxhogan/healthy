// The admin JSON API, mounted at /api by app.ts.
//
// PLACEHOLDER. The real routes (providers, connections, google, settings, mcp,
// alerts, runs, brands -- see the route table in README.md) are wave 2 and are
// written by a separate change. This module exists now so that the gate, the CSRF
// guard and the 401 contract have something real to be tested against, and so the
// mount point is settled before several people add routes to it.
//
// WAVE 2: add route files under worker/api/ and register them on `apiRouter`
// below. Do not add another `app.route(...)` in app.ts -- the middleware order
// there is the security boundary, and /api must stay a single mount inside it.
//
// Everything registered here is already: behind Cloudflare Access, behind the
// password session, and behind the CSRF guard for POST/PUT/PATCH/DELETE. The
// route handlers therefore do not repeat any of that.

import { Hono } from "hono";

import type { AppHonoEnv } from "../auth/gate.ts";
import type { ApiError } from "@shared/types.ts";

export const apiRouter = new Hono<AppHonoEnv>();

/**
 * The SPA's "is my session still good?" probe, and the smoke test for the whole
 * gate chain.
 *
 * It answers `{ ok: true }` and nothing else -- no identity, no email, no
 * configuration. A caller that reaches this route has already proved it is the
 * owner, so there is nothing to tell it that it does not know.
 */
apiRouter.get("/whoami", (c) => c.json({ ok: true }, 200, { "cache-control": "no-store" }));

/**
 * An unknown /api path must be a JSON 404, never the SPA's index.html: the SPA
 * fallback would answer a mistyped fetch with an HTML document and turn a clear
 * 404 into a parse error at the other end.
 */
apiRouter.all("*", (c) =>
  c.json<ApiError>({ error: "not_found" }, 404, { "cache-control": "no-store" }),
);
