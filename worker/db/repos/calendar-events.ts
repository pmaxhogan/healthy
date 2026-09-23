/**
 * The sync's own record of what it has written to the calendar.
 *
 * Nothing in this table is readable without `DATA_KEY`: a blinded key, the Google
 * event id, a keyed fingerprint of the mapped fields, and one sealed column. That
 * is deliberate -- the calendar itself holds the content, and this table only has
 * to be able to find it again.
 *
 * ### What is stored how (0007)
 *
 *   - `event_key` is `blindEventKey(...)`: `<providerId>:<blind>` or
 *     `<providerId>:csn:<blind>`. The same string is the Google event's
 *     `extendedProperties.private.key`, so pairing a row with its event is still
 *     an exact match, and the `<providerId>:` / `:csn:` structure the sync
 *     partitions on is kept. The upstream id it was built from is not in it.
 *   - `encounter_id` is the blinded upstream id -- for a FHIR row the very value
 *     `fhir_cache.resource_id` keys the Encounter by, which is how a vanished
 *     appointment is rebuilt from the cache without the real id being stored
 *     here. `portal_csn` is `blindCsn(...)`.
 *   - `calendar_id` is `blindCalendarId(...)`. The unique index on
 *     `(calendar_id, google_event_id)` works unchanged, and "this row's event is
 *     on a calendar other than the current target" is a comparison of blinds.
 *   - `fingerprint` is a keyed digest (`worker/sync/mapping.ts`).
 *   - `detail_enc` holds what the sync has to *read*: the real calendar id (to
 *     move or delete an event on the calendar it was created on) and the start
 *     (the window filter, the "is it over yet" rule, the start-time dedupe). One
 *     seal per row, opened once per row per `list`; the AAD is bound to
 *     `google_event_id`, which `rekey` leaves alone and every write that changes
 *     it re-seals in the same statement. `start_at` is written NULL.
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

import { AppError } from "../../lib/errors.ts";
import {
  blindCalendarId,
  blindCsn,
  blindResourceId,
  blinderFor,
  isBlindedEventKey,
} from "../blind.ts";
import { all, one, run, sha256Hex } from "../client.ts";
import { aadFor, open, sealShort } from "../crypto.ts";

import type { Blinder } from "../blind.ts";
import type { Ctx } from "../client.ts";
import type {
  CalendarEventDbRow,
  CalendarEventRow,
  CalendarEventSource,
  CalendarEventState,
} from "../rows.ts";

/** Hex characters of `eventKey`'s digest kept in a log line. */
const LOG_HASH_CHARS = 12;

/** The infix of a portal visit's logical encounter id. Mirrors `portal-mapping.ts`. */
const CSN_PREFIX = "csn:";

/**
 * `providerId` plus a short digest of the full key, for the log lines below.
 *
 * The key is blinded, so it no longer carries an upstream id; the digest is kept
 * so that a log line never carries a value that is also a lookup key in D1.
 */
async function logSafeKey(eventKey: string): Promise<{ providerId: string; eventKeyHash: string }> {
  const separator = eventKey.indexOf(":");
  const providerId = separator > 0 ? eventKey.slice(0, separator) : eventKey;
  const digest = await sha256Hex(eventKey);
  return { providerId, eventKeyHash: digest.slice(0, LOG_HASH_CHARS) };
}

/** What `detail_enc` holds. */
interface EventDetail {
  calendarId: string;
  startAt: number | null;
}

export const calendarDetailAad = (googleEventId: string): string =>
  aadFor("calendar_events", "detail_enc", googleEventId);

/**
 * The stored `encounter_id` for a logical upstream id: an Epic Encounter id, or
 * `csn:<csn>` for a portal visit.
 */
export function encounterRef(
  blinder: Blinder,
  providerId: string,
  encounterId: string,
): Promise<string> {
  return encounterId.startsWith(CSN_PREFIX)
    ? blindCsn(blinder, providerId, encounterId.slice(CSN_PREFIX.length))
    : blindResourceId(blinder, providerId, "Encounter", encounterId);
}

/** Refuse a key that still carries an upstream id. */
function requireBlindedKey(eventKey: string): void {
  if (!isBlindedEventKey(eventKey)) {
    throw new AppError("internal", "calendar_events keys must be blinded");
  }
}

interface UpsertEvent {
  /** `blindEventKey(...)`; mirrored into extendedProperties.private.key. */
  eventKey: string;
  providerId: string;
  /** The *logical* upstream id: an Encounter id, or `csn:<csn>`. Blinded here. */
  encounterId: string;
  /** The real target calendar. Blinded into the column, sealed into the detail. */
  calendarId: string;
  googleEventId: string;
  /** Keyed digest of the mapped fields; a change is what triggers a patch. */
  fingerprint: string;
  /** Unix second the appointment starts. Sealed. */
  startAt?: number | null;
  /** Which pass wrote this row. Defaults to 'fhir', which is what every row was. */
  source?: CalendarEventSource;
  /** The portal's real contact-serial number. Blinded here. Only on a 'portal' row. */
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

/** Earliest first, rows with no start last, then by key: the old `ORDER BY`. */
function byStart(a: CalendarEventRow, b: CalendarEventRow): number {
  if (a.start_at === null || b.start_at === null) {
    if (a.start_at !== b.start_at) return a.start_at === null ? 1 : -1;
  } else if (a.start_at !== b.start_at) {
    return a.start_at - b.start_at;
  }
  if (a.event_key === b.event_key) return 0;
  return a.event_key < b.event_key ? -1 : 1;
}

export function makeCalendarEventsRepo(ctx: Ctx) {
  const blinder = blinderFor(ctx.env);

  const sealDetail = (googleEventId: string, detail: EventDetail): Promise<string> =>
    sealShort(ctx.env, JSON.stringify(detail), calendarDetailAad(googleEventId));

  const decode = async (row: CalendarEventDbRow): Promise<CalendarEventRow> => {
    const { detail_enc: detailEnc, ...rest } = row;
    if (detailEnc === null) {
      // Written before 0007 and not yet reached by the backfill: the plaintext
      // columns are still the truth.
      return rest;
    }
    const detail = JSON.parse(
      await open(ctx.env, detailEnc, calendarDetailAad(row.google_event_id)),
    ) as EventDetail;
    return { ...rest, calendar_id: detail.calendarId, start_at: detail.startAt };
  };

  const byKey = async (eventKey: string): Promise<CalendarEventRow | null> => {
    const row = await one<CalendarEventDbRow>(
      ctx.db.prepare(`${SELECT} WHERE event_key = ?`).bind(eventKey),
    );
    return row === null ? null : decode(row);
  };

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
      requireBlindedKey(input.eventKey);
      const at = ctx.now();
      const restoring = input.restore === true ? 1 : 0;
      const detailEnc = await sealDetail(input.googleEventId, {
        calendarId: input.calendarId,
        startAt: input.startAt ?? null,
      });
      const portalCsn =
        input.portalCsn === undefined || input.portalCsn === null
          ? null
          : await blindCsn(blinder, input.providerId, input.portalCsn);
      await run(
        ctx.db
          .prepare(
            `INSERT INTO calendar_events
               (event_key, provider_id, encounter_id, calendar_id, google_event_id, fingerprint,
                state, start_at, first_seen_at, last_seen_at, ghosted_at, updated_at,
                source, portal_csn, detail_enc)
             VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL, ?, ?, ?, ?)
             ON CONFLICT (event_key) DO UPDATE SET
               encounter_id = excluded.encounter_id,
               calendar_id = excluded.calendar_id,
               google_event_id = excluded.google_event_id,
               fingerprint = excluded.fingerprint,
               state = CASE WHEN ? THEN 'active' ELSE calendar_events.state END,
               start_at = NULL,
               last_seen_at = excluded.last_seen_at,
               ghosted_at = CASE WHEN ? THEN NULL ELSE calendar_events.ghosted_at END,
               updated_at = excluded.updated_at,
               -- Provenance moves with the write: a row the adoption in
               -- portal-sync.ts handed to the FHIR pass is written again as
               -- 'fhir' and must not still read 'portal' afterwards.
               source = excluded.source,
               portal_csn = excluded.portal_csn,
               -- Sealed against the google_event_id written beside it, so the two
               -- always move together.
               detail_enc = excluded.detail_enc`,
          )
          .bind(
            input.eventKey,
            input.providerId,
            await encounterRef(blinder, input.providerId, input.encounterId),
            await blindCalendarId(blinder, input.calendarId),
            input.googleEventId,
            input.fingerprint,
            at,
            at,
            at,
            input.source ?? "fhir",
            portalCsn,
            detailEnc,
            restoring,
            restoring,
          ),
      );
      const row = await byKey(input.eventKey);
      if (row === null) throw new Error("calendar_events row disappeared after upsert");
      return row;
    },

    getByKey: byKey,

    /**
     * Rows, earliest first. Every filter that narrows in SQL is on a plaintext
     * column (`provider_id`, `source`, `state`), so it uses the index; the start
     * is sealed, so `startsAfter` and the ordering are applied after the rows are
     * opened. That costs nothing extra: every caller opens every row it reads.
     */
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
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      const rows = await all<CalendarEventDbRow>(
        ctx.db.prepare(`${SELECT}${where}`).bind(...values),
      );
      const decoded = await Promise.all(rows.map((row) => decode(row)));
      const after = options.startsAfter;
      const windowed =
        after === undefined
          ? decoded
          : decoded.filter((row) => row.start_at !== null && row.start_at >= after);
      windowed.sort(byStart);
      // No limit at all unless a caller actually wants one: the owner's whole
      // calendar-events table is what "list" means when nothing narrows it.
      return options.limit === undefined ? windowed : windowed.slice(0, options.limit);
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
     * already calendared: one visit under two keys (the portal's and the
     * Encounter's). Ghosting the portal row and inserting a FHIR one would leave
     * the owner looking at a grey "Cancelled:" event beside a live duplicate of
     * the same appointment, so the row is renamed in place and the patch that
     * follows rewrites the event's own key marker.
     *
     * The fingerprint is cleared on purpose: what is on the calendar was rendered
     * from the portal's fields, so the FHIR fingerprint cannot describe it and the
     * diff has to see a change. `detail_enc` is untouched: it is bound to the
     * Google event id, which does not move.
     *
     * False when the target key already exists -- both sightings have been written
     * already and there is nothing to move.
     */
    async rekey(
      fromKey: string,
      toKey: string,
      input: { encounterId: string; source: CalendarEventSource },
    ): Promise<boolean> {
      requireBlindedKey(toKey);
      const existing = await one<{ event_key: string }>(
        ctx.db.prepare("SELECT event_key FROM calendar_events WHERE event_key = ?").bind(toKey),
      );
      if (existing !== null) return false;
      const separator = toKey.indexOf(":");
      const providerId = toKey.slice(0, separator);
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE calendar_events
                SET event_key = ?, encounter_id = ?, source = ?, portal_csn = NULL,
                    fingerprint = '', last_seen_at = ?, updated_at = ?
              WHERE event_key = ?`,
          )
          .bind(
            toKey,
            await encounterRef(blinder, providerId, input.encounterId),
            input.source,
            ctx.now(),
            ctx.now(),
            fromKey,
          ),
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
     * has already made the Google-side move before calling this. The detail is
     * re-sealed with the new calendar and the start it already had.
     */
    async moveCalendar(eventKey: string, calendarId: string): Promise<void> {
      const row = await byKey(eventKey);
      if (row === null) return;
      await run(
        ctx.db
          .prepare(
            `UPDATE calendar_events SET calendar_id = ?, detail_enc = ?, start_at = NULL,
                    updated_at = ?
              WHERE event_key = ?`,
          )
          .bind(
            await blindCalendarId(blinder, calendarId),
            await sealDetail(row.google_event_id, { calendarId, startAt: row.start_at }),
            ctx.now(),
            eventKey,
          ),
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
