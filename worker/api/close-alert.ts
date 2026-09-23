/**
 * Close an open reconnect alert from the API, card and all.
 *
 * Distinct from the sync engine's `resolveReconnectAlert`, which is the path a
 * successful reconnection takes. This is the administrative one: the owner deleted
 * the health system or disconnected Google, so the alert is moot rather than resolved.
 *
 * Trello is best effort on purpose. The database row is the source of truth for
 * "is there an open alert"; a card that could not be moved is a stale card, which
 * is a great deal better than a failed DELETE that leaves the health system half
 * removed.
 */

import { AppError, isAppError } from "../lib/errors.ts";
import { logLine } from "../lib/log.ts";

import type { ApiContext } from "./http.ts";
import type { Env } from "../env.ts";

export async function closeAlert(api: ApiContext, env: Env, subject: string): Promise<void> {
  const alert = await api.repos.alerts.resolve(subject);
  const cardId = alert?.trello_card_id ?? null;
  if (cardId === null) return;
  try {
    await api.ports.trello(env, api.ports.fetch).completeCard(cardId);
  } catch (error) {
    // Includes the "Trello is not configured" case, which is a legitimate state.
    logLine("warn", "api_alert_card_not_closed", {
      errorCode: isAppError(error) ? error.code : "unknown",
    });
  }
}

/** `alerts.subject` for a health system. Mirrors `db/repos/alerts.ts`. */
export function healthSystemSubject(healthSystemId: string): string {
  if (healthSystemId === "") throw new AppError("bad_request", "a health system id is required");
  return `health_system:${healthSystemId}`;
}

/** `alerts.subject` for a health system's portal session. Mirrors `db/repos/alerts.ts`. */
export function portalSubject(healthSystemId: string): string {
  if (healthSystemId === "") throw new AppError("bad_request", "a health system id is required");
  return `portal:${healthSystemId}`;
}
