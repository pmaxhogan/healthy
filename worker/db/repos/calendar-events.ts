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
 *
 * `source` and `portal_csn` (0002_portal.sql) exist because the same visit can be
 * seen twice: the patient portal knows about it as soon as it is booked, and the
 * FHIR Encounter for it may not appear until afterwards. `rekey` is what happens
 * when the second sighting arrives -- the portal row becomes the FHIR row, in
 * place, keeping the Google event it already created rather than ghosting one
 * appointment and inserting another.
 */

import { all, one, run, sha256Hex } from "../client.ts";

import type { Ctx } from "../client.ts";
import type { CalendarEventRow, CalendarEventSource, CalendarEventState } from "../rows.ts";

/** Hex characters of `eventKey`'s digest kept in a log line. Short on purpose:
 * long enough to correlate two lines about the same row, short enough that it
 * never brushes the redactor's 32-character opaque-string threshold. */
const LOG_HASH_CHARS = 12;

/**
 * `providerId` plus a short digest of the full key, for the two log lines below.
 *
 * `eventKey` is `<providerId>:<encounterId>` -- the encounter half is Epic's own
 * resource id. `worker/lib/log.ts`'s redactor cannot catch it there: the `:`
 * ends an opaque run, so neither half reaches the 32-character threshold, and
 * the key name matches neither `SENSITIVE_KEY` nor `IDENTIFIER_KEY`. Logging
 * `providerId` (our own row id) plus a digest of the whole key keeps these
 * lines correlatable without ever putting the upstream id in Workers Logs. See
 * SECURITY.md, "No PHI in logs".
 */
async function logSafeKey(eventKey: string): Promise<{ providerId: string; eventKeyHash: string }> {
  const separator = eventKey.indexOf(":");
  const providerId = separator > 0 ? eventKey.slice(0, separator) : eventKey;
  const digest = await sha256Hex(eventKey);
  return { providerId, eventKeyHash: digest.slice(0, LOG_HASH_CHARS) };
}

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
  /** Which pass wrote this row. Defaults to 'fhir', which is what every row was. */
  source?: CalendarEventSource;
  /** The portal's contact-serial number. Only ever set on a 'portal' row. */
  portalCsn?: string | null;
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
                state, start_at, first_seen_at, last_seen_at, ghosted_at, updated_at,
                source, portal_csn)
             VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?, ?)
             ON CONFLICT (event_key) DO UPDATE SET
               calendar_id = excluded.calendar_id,
               google_event_id = excluded.google_event_id,
               fingerprint = excluded.fingerprint,
               state = CASE WHEN ? THEN 'active' ELSE calendar_events.state END,
               start_at = excluded.start_at,
               last_seen_at = excluded.last_seen_at,
               ghosted_at = CASE WHEN ? THEN NULL ELSE calendar_events.ghosted_at END,
               updated_at = excluded.updated_at,
               -- Provenance moves with the write: a row the adoption in
               -- portal-sync.ts handed to the FHIR pass is written again as
               -- 'fhir' and must not still read 'portal' afterwards.
               source = excluded.source,
               portal_csn = excluded.portal_csn`,
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
            input.source ?? "fhir",
            input.portalCsn ?? null,
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
        source?: CalendarEventSource;
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
      if (options.source !== undefined) {
        clauses.push("source = ?");
        values.push(options.source);
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
      // No `LIMIT` clause at all unless a caller actually wants one: the owner's
      // whole calendar-events table is what "list" means when nothing narrows it.
      const limitClause = options.limit === undefined ? "" : " LIMIT ?";
      const bound = options.limit === undefined ? values : [...values, options.limit];
      return all<CalendarEventRow>(
        ctx.db
          .prepare(`${SELECT}${where} ORDER BY start_at IS NULL, start_at, event_key${limitClause}`)
          .bind(...bound),
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
      if (changes > 0) ctx.log.info("calendar_events.ghosted", await logSafeKey(eventKey));
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
      if (changes > 0) ctx.log.info("calendar_events.restored", await logSafeKey(eventKey));
      return changes > 0;
    },

    /**
     * Hand one row to a different event key, keeping its Google event.
     *
     * The one caller is the FHIR pass meeting an appointment the portal has
     * already calendared: one visit under two ids (`<providerId>:csn:<csn>` and
     * `<providerId>:<encounterId>`). Ghosting the portal row and inserting a FHIR
     * one would leave the owner looking at a grey "Cancelled:" event beside a live
     * duplicate of the same appointment, so the row is renamed in place and the
     * patch that follows rewrites the event's own key marker.
     *
     * The fingerprint is cleared on purpose: what is on the calendar was rendered
     * from the portal's fields, so the FHIR fingerprint cannot describe it and the
     * diff has to see a change.
     *
     * False when the target key already exists -- both sightings have been written
     * already and there is nothing to move.
     */
    async rekey(
      fromKey: string,
      toKey: string,
      input: { encounterId: string; source: CalendarEventSource },
    ): Promise<boolean> {
      const existing = await byKey(toKey);
      if (existing !== null) return false;
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE calendar_events
                SET event_key = ?, encounter_id = ?, source = ?, portal_csn = NULL,
                    fingerprint = '', last_seen_at = ?, updated_at = ?
              WHERE event_key = ?`,
          )
          .bind(toKey, input.encounterId, input.source, ctx.now(), ctx.now(), fromKey),
      );
      if (changes > 0) ctx.log.info("calendar_events.rekeyed", await logSafeKey(toKey));
      return changes > 0;
    },

    /**
     * Forget one row entirely.
     *
     * The one caller is the portal pass removing a calendared duplicate -- a copy
     * of a visit another, higher-precedence copy already speaks for -- after it
     * has deleted the Google event. That is not a ghost: the visit is not
     * cancelled, it is simply shown once, by the other copy. Dropping the row is
     * what stops the duplicate being recreated, since a duplicate with no row is
     * never inserted (see `worker/sync/portal-sync.ts`). True when a row went.
     */
    async remove(eventKey: string): Promise<boolean> {
      const { changes } = await run(
        ctx.db.prepare("DELETE FROM calendar_events WHERE event_key = ?").bind(eventKey),
      );
      if (changes > 0) ctx.log.info("calendar_events.removed", await logSafeKey(eventKey));
      return changes > 0;
    },

    /** How many of one provider's rows came from one pass and are in one state. */
    async countBySource(
      providerId: string,
      source: CalendarEventSource,
      state: CalendarEventState,
    ): Promise<number> {
      const row = await one<{ n: number }>(
        ctx.db
          .prepare(
            `SELECT COUNT(*) AS n FROM calendar_events
              WHERE provider_id = ? AND source = ? AND state = ?`,
          )
          .bind(providerId, source, state),
      );
      return row?.n ?? 0;
    },

    /**
     * The owner changed the sync target and the row's event has followed it
     * there. Only the tracked calendar moves -- the fingerprint, state and
     * timestamps describe the appointment, not where it lives, and the caller
     * has already made the Google-side move before calling this.
     */
    async moveCalendar(eventKey: string, calendarId: string): Promise<void> {
      await run(
        ctx.db
          .prepare(`UPDATE calendar_events SET calendar_id = ?, updated_at = ? WHERE event_key = ?`)
          .bind(calendarId, ctx.now(), eventKey),
      );
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
