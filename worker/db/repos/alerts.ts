/**
 * Outbound re-auth alerts, one open row per subject.
 *
 * The dedupe guarantee is what stops the hourly sync opening a new Trello card
 * every hour a connection stays broken. It is enforced by the partial unique
 * index `alerts_open_subject ON alerts (subject) WHERE resolved_at IS NULL`, not
 * by this code -- a plain unique index would not work, because SQLite treats
 * NULLs as distinct and every resolved row has a NULL subject slot free.
 *
 * `openOrGet` is therefore an insert that may lose, followed by a read: whichever
 * caller wins, both end up with the same row and only one card is created.
 */

import { newId } from "../../lib/ids.ts";
import { all, one, run } from "../client.ts";

import type { Ctx } from "../client.ts";
import type { AlertRow } from "../rows.ts";

/** 'provider:<id>' for a health system, 'google' for the calendar account. */
export function providerSubject(providerId: string): string {
  return `provider:${providerId}`;
}

/**
 * 'portal:<id>' for a health system's patient-portal session.
 *
 * A different subject from `providerSubject` for the same provider on purpose:
 * the FHIR grant and the portal password break independently, so sharing a
 * subject would let one alert's resolution close the other's card. See
 * `worker/sync/alerts.ts`.
 */
export function portalSubject(providerId: string): string {
  return `portal:${providerId}`;
}

/** The subject the Google calendar account's alerts use. */
export const GOOGLE_SUBJECT = "google";

export function makeAlertsRepo(ctx: Ctx) {
  const openFor = async (subject: string): Promise<AlertRow | null> =>
    one<AlertRow>(
      ctx.db
        .prepare("SELECT * FROM alerts WHERE subject = ? AND resolved_at IS NULL")
        .bind(subject),
    );

  return {
    /**
     * The open alert for a subject, creating one if there is none.
     *
     * Returns `{ alert, created }` so the caller knows whether it also needs to
     * open a Trello card, which is the expensive half.
     */
    async openOrGet(subject: string): Promise<{ alert: AlertRow; created: boolean }> {
      const existing = await openFor(subject);
      if (existing !== null) return { alert: existing, created: false };

      const { changes } = await run(
        ctx.db
          .prepare(
            `INSERT INTO alerts (id, kind, subject, opened_at) VALUES (?, 'reconnect', ?, ?)
             ON CONFLICT (subject) WHERE resolved_at IS NULL DO NOTHING`,
          )
          .bind(newId(), subject, ctx.now()),
      );
      const alert = await openFor(subject);
      if (alert === null) throw new Error("alert row disappeared after insert");
      if (changes > 0) ctx.log.info("alerts.opened", { subject });
      return { alert, created: changes > 0 };
    },

    /** Remember which Trello card is tracking this alert. */
    async setCard(id: string, trelloCardId: string): Promise<boolean> {
      const { changes } = await run(
        ctx.db.prepare("UPDATE alerts SET trello_card_id = ? WHERE id = ?").bind(trelloCardId, id),
      );
      return changes > 0;
    },

    /**
     * Close the open alert for a subject, returning the row so the caller can
     * complete its Trello card. Null when there was nothing open.
     */
    async resolve(subject: string): Promise<AlertRow | null> {
      const open = await openFor(subject);
      if (open === null) return null;
      await run(
        ctx.db.prepare("UPDATE alerts SET resolved_at = ? WHERE id = ?").bind(ctx.now(), open.id),
      );
      ctx.log.info("alerts.resolved", { subject });
      return { ...open, resolved_at: ctx.now() };
    },

    getOpen: openFor,

    async listOpen(): Promise<AlertRow[]> {
      return all<AlertRow>(
        ctx.db.prepare("SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY opened_at DESC"),
      );
    },

    async listRecent(limit = 50): Promise<AlertRow[]> {
      return all<AlertRow>(
        ctx.db.prepare("SELECT * FROM alerts ORDER BY opened_at DESC LIMIT ?").bind(limit),
      );
    },
  };
}
