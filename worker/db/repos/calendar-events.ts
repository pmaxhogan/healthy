/**
 * The sync's own record of what it has written to the calendar.
 *
 * Nothing in this table is clinical: a key, the Google event id, and a
 * fingerprint of the mapped fields. That is deliberate -- the calendar itself
 * holds the content, and this table only has to be able to find it again.
 *
 * Ghosting is the reason `state` and `ghosted_at` exist, and the migration's
 * CHECK ties them together: `state = 'ghost'` exactly when `ghosted_at` is set.
 * A ghost is never deleted, so an appointment that vanished upstream stays
 * visible in the owner's history, and `restore` can bring it back if the org
 * un-cancels it.
 */

import { all, one, run } from "../client.ts";

import type { Ctx } from "../client.ts";
import type { CalendarEventRow, CalendarEventState } from "../rows.ts";

interface UpsertEvent {
  /** '<providerId>:<encounterId>', mirrored into extendedProperties.private.key. */
  eventKey: string;
  providerId: string;
  encounterId: string;
  calendarId: string;
  googleEventId: string;
  /** sha256 of the mapped fields; a change is what triggers a patch. */
  fingerprint: string;
  /** Unix second the appointment starts, for window queries. */
  startAt?: number | null;
}

const SELECT = "SELECT * FROM calendar_events";

export function makeCalendarEventsRepo(ctx: Ctx) {
  const byKey = async (eventKey: string): Promise<CalendarEventRow | null> =>
    one<CalendarEventRow>(ctx.db.prepare(`${SELECT} WHERE event_key = ?`).bind(eventKey));

  return {
    /**
     * Record an event the sync just inserted or patched.
     *
     * An upsert of a key that is currently a ghost restores it: the appointment
     * has reappeared upstream, which is precisely the signal to un-ghost.
     */
    async upsert(input: UpsertEvent): Promise<CalendarEventRow> {
      const at = ctx.now();
      await run(
        ctx.db
          .prepare(
            `INSERT INTO calendar_events
               (event_key, provider_id, encounter_id, calendar_id, google_event_id, fingerprint,
                state, start_at, first_seen_at, last_seen_at, ghosted_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?)
             ON CONFLICT (event_key) DO UPDATE SET
               calendar_id = excluded.calendar_id,
               google_event_id = excluded.google_event_id,
               fingerprint = excluded.fingerprint,
               state = 'active',
               start_at = excluded.start_at,
               last_seen_at = excluded.last_seen_at,
               ghosted_at = NULL,
               updated_at = excluded.updated_at`,
          )
          .bind(
            input.eventKey,
            input.providerId,
            input.encounterId,
            input.calendarId,
            input.googleEventId,
            input.fingerprint,
            input.startAt ?? null,
            at,
            at,
            at,
          ),
      );
      const row = await byKey(input.eventKey);
      if (row === null) throw new Error("calendar_events row disappeared after upsert");
      return row;
    },

    getByKey: byKey,

    async list(
      options: {
        providerId?: string;
        state?: CalendarEventState;
        startsAfter?: number;
        limit?: number;
      } = {},
    ): Promise<CalendarEventRow[]> {
      const clauses: string[] = [];
      const values: unknown[] = [];
      if (options.providerId !== undefined) {
        clauses.push("provider_id = ?");
        values.push(options.providerId);
      }
      if (options.state !== undefined) {
        clauses.push("state = ?");
        values.push(options.state);
      }
      if (options.startsAfter !== undefined) {
        clauses.push("start_at >= ?");
        values.push(options.startsAfter);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      return all<CalendarEventRow>(
        ctx.db
          .prepare(`${SELECT}${where} ORDER BY start_at IS NULL, start_at, event_key LIMIT ?`)
          .bind(...values, options.limit ?? 1000),
      );
    },

    /**
     * Mark an event as vanished upstream. Idempotent, and it keeps the original
     * `ghosted_at`: the timestamp records when it first disappeared, and the
     * calendar description quotes it.
     */
    async markGhost(eventKey: string): Promise<boolean> {
      const at = ctx.now();
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE calendar_events
                SET state = 'ghost', ghosted_at = COALESCE(ghosted_at, ?), updated_at = ?
              WHERE event_key = ? AND state <> 'ghost'`,
          )
          .bind(at, at, eventKey),
      );
      if (changes > 0) ctx.log.info("calendar_events.ghosted", { eventKey });
      return changes > 0;
    },

    /** The appointment came back. Clears the ghost and optionally the fingerprint. */
    async restore(eventKey: string, fingerprint?: string): Promise<boolean> {
      const at = ctx.now();
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE calendar_events
                SET state = 'active', ghosted_at = NULL,
                    fingerprint = COALESCE(?, fingerprint),
                    last_seen_at = ?, updated_at = ?
              WHERE event_key = ? AND state = 'ghost'`,
          )
          .bind(fingerprint ?? null, at, at, eventKey),
      );
      if (changes > 0) ctx.log.info("calendar_events.restored", { eventKey });
      return changes > 0;
    },

    /** Stamp `last_seen_at` for every key the current sync saw. */
    async touch(eventKeys: readonly string[]): Promise<number> {
      if (eventKeys.length === 0) return 0;
      const placeholders = eventKeys.map(() => "?").join(", ");
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE calendar_events SET last_seen_at = ?, updated_at = ?
              WHERE event_key IN (${placeholders})`,
          )
          .bind(ctx.now(), ctx.now(), ...eventKeys),
      );
      return changes;
    },
  };
}
