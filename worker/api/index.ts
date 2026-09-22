// The admin JSON API, mounted at /api by app.ts.
//
// Everything registered here is already: behind Cloudflare Access, behind the
// password session, and behind the CSRF guard for POST/PUT/PATCH/DELETE. The
// route handlers therefore do not repeat any of that. Do not add another
// `app.route(...)` in app.ts -- the middleware order there is the security
// boundary, and /api must stay a single mount inside it.
//
// Order matters twice over:
//
//   1. Hono matches in registration order, so the catch-all 404 is LAST. A route
//      added below it is dead code that answers `{"error":"not_found"}`.
//   2. `/sync` is mounted before nothing in particular, but `/providers` must be
//      mounted before the catch-all for its nested `/:id/...` actions to resolve.
//
// The error handler is registered on this sub-app rather than left to app.ts, so
// that a 4xx can name the field that was wrong. It never does that for a 5xx --
// see worker/api/http.ts for why that line is drawn where it is.

import { Hono } from "hono";

import { NO_STORE, apiErrorHandler } from "./http.ts";
import { alertsRouter } from "./routes/alerts.ts";
import { brandsRouter } from "./routes/brands.ts";
import { googleRouter } from "./routes/google.ts";
import { mailRouter } from "./routes/mail.ts";
import { mcpRouter } from "./routes/mcp.ts";
import { overviewRouter } from "./routes/overview.ts";
import { providersRouter, syncRouter } from "./routes/providers.ts";
import { runsRouter } from "./routes/runs.ts";
import { settingsRouter } from "./routes/settings.ts";

import type { AppHonoEnv } from "../auth/gate.ts";
import type { ApiError } from "@shared/types.ts";

export const apiRouter = new Hono<AppHonoEnv>();

apiRouter.onError(apiErrorHandler);

/**
 * The SPA's "is my session still good?" probe, and the smoke test for the whole
 * gate chain.
 *
 * It answers `{ ok: true }` and nothing else -- no identity, no email, no
 * configuration. A caller that reaches this route has already proved it is the
 * owner, so there is nothing to tell it that it does not know.
 */
apiRouter.get("/whoami", (c) => c.json({ ok: true }, 200, NO_STORE));

apiRouter.route("/overview", overviewRouter);
apiRouter.route("/providers", providersRouter);
apiRouter.route("/sync", syncRouter);
apiRouter.route("/google", googleRouter);
apiRouter.route("/settings", settingsRouter);
apiRouter.route("/mcp", mcpRouter);
apiRouter.route("/alerts", alertsRouter);
apiRouter.route("/runs", runsRouter);
apiRouter.route("/brands", brandsRouter);
apiRouter.route("/mail", mailRouter);

/**
 * An unknown /api path must be a JSON 404, never the SPA's index.html: the SPA
 * fallback would answer a mistyped fetch with an HTML document and turn a clear
 * 404 into a parse error at the other end.
 */
apiRouter.all("*", (c) => c.json<ApiError>({ error: "not_found" }, 404, NO_STORE));
