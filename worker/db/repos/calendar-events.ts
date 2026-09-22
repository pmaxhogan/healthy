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
  /**
   * True when this write is a ghost coming back to life.
   *
   * Only a restore may move a row out of `ghost`. Without the flag, writing a
   * ghost's own fingerprint back -- which is exactly what ghosting does, since the
   * calendar entry has just been patched to the ghost variant -- would clear
   * `ghosted_at`, and the next run would stamp a new one, re-render the "as of"
   * line, get a different fingerprint and patch the same event again, for ever.
   */
  restore?: boolean;
}

const SELECT = "SELECT * FROM calendar_events";

export function makeCalendarEventsRepo(ctx: Ctx) {
  const byKey = async (eventKey: string): Promise<CalendarEventRow | null> =>
    one<CalendarEventRow>(ctx.db.prepare(`${SELECT} WHERE event_key = ?`).bind(eventKey));

  return {
    /**
     * Record an event the sync just inserted or patched.
     *
     * A new row is always active. An upsert over an existing one moves the
     * fingerprint and the ids but leaves `state` and `ghosted_at` exactly as they
     * are, unless `restore` says the appointment has reappeared upstream -- which
     * is the one signal that legitimately un-ghosts a row. The two columns move
     * together because the migration's CHECK ties them: `state = 'ghost'` exactly
     * when `ghosted_at` is set.
     */
    async upsert(input: UpsertEvent): Promise<CalendarEventRow> {
      const at = ctx.now();
      const restoring = input.restore === true ? 1 : 0;
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
               state = CASE WHEN ? THEN 'active' ELSE calendar_events.state END,
               start_at = excluded.start_at,
               last_seen_at = excluded.last_seen_at,
               ghosted_at = CASE WHEN ? THEN NULL ELSE calendar_events.ghosted_at END,
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
            restoring,
            restoring,
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
     * Mark an event as vanished upstream, in one statement.
     *
     * Both halves of ghosting have to land together: the state moves to `ghost`
     * *and* the fingerprint becomes the ghost variant's, or the next run sees a
     * stale fingerprint, patches the calendar entry again, and every hourly sync
     * re-writes every ghost for ever. Doing it as `upsert` then a state-only
     * `markGhost` cannot work -- that is what the `restore` flag on `upsert` is
     * about -- so the fingerprint comes through here.
     *
     * `COALESCE(ghosted_at, ?)` is what keeps the original disappearance time: the
     * timestamp records when it *first* vanished and the calendar description
     * quotes it, so a moving one would change the ghost's own fingerprint every
     * run. `COALESCE(?, fingerprint)` lets a row-only ghost -- one where no Google
     * write happened -- keep the fingerprint that still describes the calendar.
     *
     * Idempotent: a row that is already a ghost is only touched when the caller
     * brought a fingerprint, so `true` always means something moved.
     */
    async markGhost(
      eventKey: string,
      options: { fingerprint?: string | null; ghostedAt?: number } = {},
    ): Promise<boolean> {
      const at = ctx.now();
      const fingerprint = options.fingerprint ?? null;
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE calendar_events
                SET state = 'ghost',
                    ghosted_at = COALESCE(ghosted_at, ?),
                    fingerprint = COALESCE(?, fingerprint),
                    last_seen_at = ?,
                    updated_at = ?
              WHERE event_key = ? AND (state <> 'ghost' OR ? IS NOT NULL)`,
          )
          .bind(options.ghostedAt ?? at, fingerprint, at, at, eventKey, fingerprint),
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
