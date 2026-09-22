/**
 * `/api/alerts` -- the reconnect alerts, and the "does Trello still work?" button.
 *
 * ### Why the test card is not auto-archived
 *
 * The obvious design is "create the card, then archive it in ten minutes". There is
 * no way to do that honestly in a Worker: `waitUntil` is bounded by the
 * invocation's lifetime, a `setTimeout` inside it is not a durable timer, and a
 * ten-minute sleep would burn the request's wall clock for nothing. An alarm on the
 * MCP Durable Object would work, but making the alert test depend on the MCP
 * session object is a strange coupling to introduce for a diagnostic.
 *
 * So the card id is returned instead, and `DELETE /api/alerts/test/:cardId`
 * archives it on demand -- which is also the honest UX: the owner presses "send
 * test card", goes and looks at Trello, comes back and presses "archive it".
 */

import { Hono } from "hono";

import { toAlertDto } from "../dto.ts";
import { NO_STORE, apiContext, limitQuerySchema, readQuery } from "../http.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";

/** Alerts per page when the caller does not say. */
const DEFAULT_ALERT_LIMIT = 50;

export const alertsRouter = new Hono<AppHonoEnv>();

/**
 * Recent alerts, open ones first.
 *
 * The whole history rather than just the open ones: "this connection has broken
 * four times this month" is the useful signal, and it is invisible if resolved rows
 * are hidden.
 */
alertsRouter.get("/", async (c) => {
  const api = apiContext(c);
  const { limit } = readQuery(c, limitQuerySchema);
  const rows = await api.repos.alerts.listRecent(limit ?? DEFAULT_ALERT_LIMIT);
  return c.json(
    rows.map((row) => toAlertDto(row)),
    200,
    NO_STORE,
  );
});

/**
 * Create a disposable Trello card, to prove the credentials and list ids work.
 *
 * No `alerts` row is written: this is not an alert, and inserting one would make
 * the open-alert count on the dashboard lie.
 */
alertsRouter.post("/test", async (c) => {
  const api = apiContext(c);
  const trello = api.ports.trello(c.env, api.ports.fetch);
  // The link on the card is the app's own root -- the card body's job is to prove
  // the integration works, and a link to a reconnect flow that is not broken would
  // be actively confusing.
  const cardId = await trello.createTestCard(new URL("/", c.req.url).href);
  return c.json({ cardId }, 201, NO_STORE);
});

/** Archive a card this endpoint created. See the module comment. */
alertsRouter.delete("/test/:cardId", async (c) => {
  const api = apiContext(c);
  const trello = api.ports.trello(c.env, api.ports.fetch);
  await trello.archiveCard(c.req.param("cardId"));
  return c.json({ ok: true }, 200, NO_STORE);
});
