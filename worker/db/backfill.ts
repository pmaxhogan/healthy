/**
 * The one-shot rewrite of data written before 0007: blind what D1 compares,
 * seal what it only stores, pad what was sealed without padding, and re-key the
 * Google events so each one still pairs with its row.
 *
 * SQL can compute neither an HMAC nor an AES-GCM seal, so this runs in the Worker.
 * It is driven from the head of every calendar sync (`worker/sync/calendar-sync.ts`)
 * and the sync does nothing else until it reports `complete`: a row or an event
 * still carrying a pre-blinding key would not pair with the key the sync now
 * computes, and an unpaired upcoming visit gets inserted again -- a duplicate on
 * the owner's calendar. Holding the sync back is what makes that impossible.
 *
 * ### Idempotent and resumable, per row
 *
 * Every step selects only the rows still in the old shape, and every rewrite is a
 * single statement (or one D1 batch, which is a transaction) that moves a row
 * from the old shape to the new one -- conditional on the old value still being
 * there, so a concurrent write is never overwritten. Killed at any point, the
 * next run picks up exactly the rows that are left; run twice, the second run
 * finds nothing to do. What marks a row as done:
 *
 *   - `settings`, `providers`, `portal_accounts`: the value is a sealed envelope.
 *   - a short sealed column: the envelope is `v2:` (padded), not `v1:`.
 *   - `fhir_cache`, `portal_visits`: `content_hash` is a keyed digest (`~...`),
 *     not a hex sha256. The row is re-inserted under its blinded id and the old
 *     row deleted, in one batch.
 *   - `calendar_events`: `detail_enc` is set.
 *
 * ### The calendar, and why the order is Google first
 *
 * A row's new key is `blindEventKey(oldKey)` -- a pure function of the old key,
 * so it can be computed only while the old key is still stored. For each
 * unmigrated row the Google event is PATCHed first (its `key` marker to the new
 * key, the rest of `extendedProperties.private` sent back unchanged so nothing
 * depends on Google's merge rules), and the row second. Dying between the two
 * leaves an event with the new key and a row with the old one; the next run
 * recomputes the same new key from the row, sees the event already carries it,
 * and finishes the row. The Google event id never changes, so the pairing is
 * never lost and nothing is inserted. Only events carrying `healthy=1` and
 * exactly the row's old key are patched. Events on the current calendar that
 * carry an old key but have no row (a lost row the sync would otherwise adopt)
 * are re-keyed the same way, so adoption still works for them.
 *
 * The rows' fingerprints are left as they were. The next sync computes keyed
 * fingerprints that match none of them and patches every event once, which also
 * rewrites the `fp` marker. That is a one-off pass of PATCHes, never an insert.
 *
 * Counts only in logs and in `data_migrations.progress_json`. Never a value.
 */

import { AppError, isAppError } from "../lib/errors.ts";
import { errorFields } from "../lib/log.ts";

import {
  blindCalendarId,
  blindCsn,
  blindEventKey,
  blindResourceId,
  blinderFor,
  isBlinded,
  isBlindedEventKey,
} from "./blind.ts";
import { BATCH_CHUNK, all, batch, chunk, one, run } from "./client.ts";
import { aadFor, isSealed, isUnpadded, open, seal, sealShort } from "./crypto.ts";
import { calendarDetailAad, encounterRef } from "./repos/calendar-events.ts";
import { fhirCacheAad, fhirCacheDigest } from "./repos/fhir-cache.ts";
import { PORTAL_LOCATION_COLUMNS, portalAccountAad } from "./repos/portal-accounts.ts";
import { EXPIRY_BUCKET_SECONDS, portalVisitAad, portalVisitDigest } from "./repos/portal-visits.ts";
import { PROVIDER_IDENTITY_COLUMNS, providerIdentityAad } from "./repos/providers.ts";
import { SEALED_SETTING_KEYS, getSetting, settingAad } from "./settings.ts";

import type { Blinder } from "./blind.ts";
import type { Ctx } from "./client.ts";
import type { CalendarEventDbRow, FhirCacheRow, PortalVisitRow } from "./rows.ts";
import type { CalendarClient } from "../google/calendar.ts";
import type { EventRecord } from "../google/types.ts";

/** The `data_migrations.name` of this backfill. */
export const BLIND_BACKFILL = "0007_blind_and_seal";

/** Rows of the two big tables opened and re-sealed per round trip. */
const PAGE = 100;

/** How long one run holds the lease. Longer than any run takes; short enough to recover. */
const LEASE_SECONDS = 15 * 60;

/** Where the calendar listing starts: well before any event this app could have written. */
const LISTING_TIME_MIN = "2000-01-01T00:00:00Z";

export interface BackfillCounts {
  settingsSealed: number;
  providerColumnsSealed: number;
  portalColumnsSealed: number;
  shortSealsPadded: number;
  cacheRowsRekeyed: number;
  visitsRekeyed: number;
  calendarRowsRekeyed: number;
  googleEventsRekeyed: number;
  googleOrphansRekeyed: number;
}

export interface BackfillResult {
  complete: boolean;
  /** Why it is not complete. `backfill_busy` when another run holds the lease. */
  errorCode?: string;
  counts: BackfillCounts;
}

export interface BackfillOptions {
  /**
   * The Google client, built only when an unmigrated calendar row or event is
   * found: a fresh install, or a second run, never needs a token.
   */
  calendar: () => Promise<CalendarClient>;
}

function emptyCounts(): BackfillCounts {
  return {
    settingsSealed: 0,
    providerColumnsSealed: 0,
    portalColumnsSealed: 0,
    shortSealsPadded: 0,
    cacheRowsRekeyed: 0,
    visitsRekeyed: 0,
    calendarRowsRekeyed: 0,
    googleEventsRekeyed: 0,
    googleOrphansRekeyed: 0,
  };
}

interface MigrationRow {
  completed_at: number | null;
  lease_until: number | null;
}

/**
 * Run the backfill to completion, or as far as it gets.
 *
 * Cheap once done: one indexed read of `data_migrations`. Never throws; a failure
 * is reported as `complete: false` with a code, and recorded on the row.
 */
export async function runBlindBackfill(
  ctx: Ctx,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const counts = emptyCounts();
  const state = await one<MigrationRow>(
    ctx.db
      .prepare("SELECT completed_at, lease_until FROM data_migrations WHERE name = ?")
      .bind(BLIND_BACKFILL),
  );
  if (state?.completed_at != null) return { complete: true, counts };

  if (!(await takeLease(ctx))) {
    ctx.log.info("backfill.busy", { migration: BLIND_BACKFILL });
    return { complete: false, errorCode: "backfill_busy", counts };
  }

  const blinder = blinderFor(ctx.env);
  try {
    counts.settingsSealed = await sealSettings(ctx);
    counts.providerColumnsSealed = await sealProviderIdentity(ctx);
    counts.portalColumnsSealed = await sealPortalLocations(ctx);
    counts.shortSealsPadded = await padShortSeals(ctx);
    counts.cacheRowsRekeyed = await rekeyFhirCache(ctx, blinder);
    counts.visitsRekeyed = await rekeyPortalVisits(ctx, blinder);
    await rekeyCalendar(ctx, blinder, options, counts);
  } catch (error) {
    const errorCode = isAppError(error) ? error.code : "internal";
    ctx.log.error("backfill.failed", { migration: BLIND_BACKFILL, ...errorFields(error) });
    await release(ctx, counts, { errorCode, completed: false });
    return { complete: false, errorCode, counts };
  }
  await release(ctx, counts, { errorCode: null, completed: true });
  ctx.log.info("backfill.complete", { migration: BLIND_BACKFILL, ...counts });
  return { complete: true, counts };
}

async function takeLease(ctx: Ctx): Promise<boolean> {
  const now = ctx.now();
  await run(
    ctx.db
      .prepare(
        `INSERT INTO data_migrations (name, started_at, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (name) DO NOTHING`,
      )
      .bind(BLIND_BACKFILL, now, now),
  );
  const { changes } = await run(
    ctx.db
      .prepare(
        `UPDATE data_migrations SET lease_until = ?, updated_at = ?
          WHERE name = ? AND completed_at IS NULL
            AND (lease_until IS NULL OR lease_until <= ?)`,
      )
      .bind(now + LEASE_SECONDS, now, BLIND_BACKFILL, now),
  );
  return changes > 0;
}

/**
 * Close this run's lease, adding its counts to every earlier run's: the row says
 * what the backfill did in total, however many runs it took.
 */
async function release(
  ctx: Ctx,
  counts: BackfillCounts,
  outcome: { errorCode: string | null; completed: boolean },
): Promise<void> {
  const now = ctx.now();
  const previous = await one<{ progress_json: string }>(
    ctx.db.prepare("SELECT progress_json FROM data_migrations WHERE name = ?").bind(BLIND_BACKFILL),
  );
  const total = addCounts(parseCounts(previous?.progress_json), counts);
  await run(
    ctx.db
      .prepare(
        `UPDATE data_migrations
            SET lease_until = NULL, last_error = ?, progress_json = ?, updated_at = ?,
                completed_at = CASE WHEN ? THEN ? ELSE completed_at END
          WHERE name = ?`,
      )
      .bind(
        outcome.errorCode,
        JSON.stringify(total),
        now,
        outcome.completed ? 1 : 0,
        now,
        BLIND_BACKFILL,
      ),
  );
}

/** Earlier runs' counts, or zeros for a row that has none (or holds junk). */
function parseCounts(json: string | undefined): BackfillCounts {
  const counts = emptyCounts();
  if (json === undefined) return counts;
  let stored: unknown;
  try {
    stored = JSON.parse(json);
  } catch {
    return counts;
  }
  if (typeof stored !== "object" || stored === null) return counts;
  for (const key of Object.keys(counts) as (keyof BackfillCounts)[]) {
    // eslint-disable-next-line security/detect-object-injection -- `key` is one of this type's own field names.
    const value = (stored as Partial<Record<keyof BackfillCounts, unknown>>)[key];
    // eslint-disable-next-line security/detect-object-injection -- as above.
    if (typeof value === "number") counts[key] = value;
  }
  return counts;
}

function addCounts(a: BackfillCounts, b: BackfillCounts): BackfillCounts {
  const sum = emptyCounts();
  for (const key of Object.keys(sum) as (keyof BackfillCounts)[]) {
    // eslint-disable-next-line security/detect-object-injection -- `key` is one of this type's own field names.
    sum[key] = a[key] + b[key];
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Values sealed in place.
// ---------------------------------------------------------------------------

/** One conditional write; the number of rows it changed. */
async function write(ctx: Ctx, sql: string, values: readonly unknown[]): Promise<number> {
  const { changes } = await run(ctx.db.prepare(sql).bind(...values));
  return changes;
}

async function sealSettings(ctx: Ctx): Promise<number> {
  const keys = [...SEALED_SETTING_KEYS];
  const rows = await all<{ key: string; value_json: string }>(
    ctx.db
      .prepare(
        `SELECT key, value_json FROM settings WHERE key IN (${keys.map(() => "?").join(", ")})`,
      )
      .bind(...keys),
  );
  let sealed = 0;
  for (const row of rows) {
    if (isSealed(row.value_json)) continue;
    const next = await sealShort(ctx.env, row.value_json, settingAad(row.key));
    sealed += await write(
      ctx,
      "UPDATE settings SET value_json = ? WHERE key = ? AND value_json = ?",
      [next, row.key, row.value_json],
    );
  }
  return sealed;
}

async function sealProviderIdentity(ctx: Ctx): Promise<number> {
  type Row = { id: string } & Record<(typeof PROVIDER_IDENTITY_COLUMNS)[number], string | null>;
  const rows = await all<Row>(
    ctx.db.prepare(`SELECT id, ${PROVIDER_IDENTITY_COLUMNS.join(", ")} FROM providers`),
  );
  let sealed = 0;
  for (const row of rows) {
    for (const column of PROVIDER_IDENTITY_COLUMNS) {
      // `column` is one of four literals above, never input.
      // eslint-disable-next-line security/detect-object-injection -- a closed literal set, see above.
      const value = row[column];
      if (value === null || isSealed(value)) continue;
      const next = await sealShort(ctx.env, value, providerIdentityAad(column, row.id));
      sealed += await write(
        ctx,
        `UPDATE providers SET ${column} = ? WHERE id = ? AND ${column} = ?`,
        [next, row.id, value],
      );
    }
  }
  return sealed;
}

async function sealPortalLocations(ctx: Ctx): Promise<number> {
  type Row = { provider_id: string } & Record<
    (typeof PORTAL_LOCATION_COLUMNS)[number],
    string | null
  >;
  const rows = await all<Row>(
    ctx.db.prepare(
      `SELECT provider_id, ${PORTAL_LOCATION_COLUMNS.join(", ")} FROM portal_accounts`,
    ),
  );
  let sealed = 0;
  for (const row of rows) {
    for (const column of PORTAL_LOCATION_COLUMNS) {
      // eslint-disable-next-line security/detect-object-injection -- a closed literal set, see above.
      const value = row[column];
      if (value === null || isSealed(value)) continue;
      const next = await sealShort(ctx.env, value, portalAccountAad(column, row.provider_id));
      sealed += await write(
        ctx,
        `UPDATE portal_accounts SET ${column} = ? WHERE provider_id = ? AND ${column} = ?`,
        [next, row.provider_id, value],
      );
    }
  }
  return sealed;
}

/**
 * Every short, human-chosen sealed column: re-sealed padded. OAuth tokens and
 * the cookie jar are left alone -- they are not human-chosen, their lengths say
 * nothing about the owner, and re-sealing a live credential mid-refresh is a risk
 * with no privacy gain.
 */
const SHORT_SEALED: readonly { table: string; key: string; column: string }[] = [
  { table: "portal_accounts", key: "provider_id", column: "username_enc" },
  { table: "portal_accounts", key: "provider_id", column: "password_enc" },
  { table: "portal_accounts", key: "provider_id", column: "mfa_contact_enc" },
  { table: "portal_accounts", key: "provider_id", column: "otp_sender_enc" },
  { table: "google_account", key: "id", column: "email_enc" },
  { table: "connections", key: "id", column: "patient_fhir_id_enc" },
  { table: "providers", key: "id", column: "client_secret_enc" },
  { table: "mail_inbox", key: "id", column: "from_addr_enc" },
  { table: "mail_inbox", key: "id", column: "subject_enc" },
  { table: "mail_inbox", key: "id", column: "code_enc" },
];

async function padShortSeals(ctx: Ctx): Promise<number> {
  let padded = 0;
  for (const { table, key, column } of SHORT_SEALED) {
    // Every identifier here comes from the constant list above.
    const rows = await all<{ pk: string | number; value: string }>(
      ctx.db.prepare(
        `SELECT ${key} AS pk, ${column} AS value FROM ${table} WHERE ${column} LIKE 'v1:%'`,
      ),
    );
    for (const row of rows) {
      if (!isUnpadded(row.value)) continue;
      const aad = aadFor(table, column, row.pk);
      const plaintext = await open(ctx.env, row.value, aad);
      const next = await sealShort(ctx.env, plaintext, aad);
      padded += await write(
        ctx,
        `UPDATE ${table} SET ${column} = ? WHERE ${key} = ? AND ${column} = ?`,
        [next, row.pk, row.value],
      );
    }
  }
  return padded;
}

// ---------------------------------------------------------------------------
// The two keyed tables: re-inserted under the blinded id, old row deleted.
// ---------------------------------------------------------------------------

async function rekeyFhirCache(ctx: Ctx, blinder: Blinder): Promise<number> {
  let moved = 0;
  for (;;) {
    const rows = await all<FhirCacheRow>(
      ctx.db
        .prepare(`SELECT * FROM fhir_cache WHERE content_hash NOT LIKE '~%' LIMIT ?`)
        .bind(PAGE),
    );
    if (rows.length === 0) return moved;
    const statements: D1PreparedStatement[] = [];
    for (const row of rows) {
      if (isBlinded(row.resource_id)) {
        throw new AppError("internal", "a blinded cache row has an unkeyed digest");
      }
      const plaintext = await open(
        ctx.env,
        row.payload_enc,
        fhirCacheAad(row.provider_id, row.resource_type, row.resource_id),
      );
      const storedId = await blindResourceId(
        blinder,
        row.provider_id,
        row.resource_type,
        row.resource_id,
      );
      const payloadEnc = await seal(
        ctx.env,
        plaintext,
        fhirCacheAad(row.provider_id, row.resource_type, storedId),
      );
      const digest = await fhirCacheDigest(blinder, row.provider_id, plaintext);
      statements.push(
        // DO NOTHING: a sync since the deploy may already have written the
        // blinded row, and that one is fresher than this.
        ctx.db
          .prepare(
            `INSERT INTO fhir_cache
               (provider_id, resource_type, resource_id, payload_enc, content_hash,
                last_updated, fetched_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (provider_id, resource_type, resource_id) DO NOTHING`,
          )
          .bind(
            row.provider_id,
            row.resource_type,
            storedId,
            payloadEnc,
            digest,
            row.last_updated,
            row.fetched_at,
            row.expires_at,
          ),
        ctx.db
          .prepare(
            `DELETE FROM fhir_cache
              WHERE provider_id = ? AND resource_type = ? AND resource_id = ?`,
          )
          .bind(row.provider_id, row.resource_type, row.resource_id),
      );
    }
    // Pairs stay in one batch: an even chunk size never splits an insert from
    // its delete.
    for (const page of chunk(statements, BATCH_CHUNK)) await batch(ctx.db, page);
    moved += rows.length;
  }
}

async function rekeyPortalVisits(ctx: Ctx, blinder: Blinder): Promise<number> {
  let moved = 0;
  for (;;) {
    const rows = await all<PortalVisitRow>(
      ctx.db
        .prepare(`SELECT * FROM portal_visits WHERE content_hash NOT LIKE '~%' LIMIT ?`)
        .bind(PAGE),
    );
    if (rows.length === 0) return moved;
    const statements: D1PreparedStatement[] = [];
    for (const row of rows) {
      const plaintext = await open(
        ctx.env,
        row.payload_enc,
        portalVisitAad(row.provider_id, row.csn),
      );
      const storedCsn = await blindCsn(blinder, row.provider_id, row.csn);
      const payloadEnc = await seal(ctx.env, plaintext, portalVisitAad(row.provider_id, storedCsn));
      const digest = await portalVisitDigest(blinder, row.provider_id, plaintext);
      // The exact expiry was the visit's start plus a year; rounded up, it only
      // says roughly when to purge.
      const expiresAt = Math.ceil(row.expires_at / EXPIRY_BUCKET_SECONDS) * EXPIRY_BUCKET_SECONDS;
      statements.push(
        ctx.db
          .prepare(
            `INSERT INTO portal_visits
               (provider_id, csn, payload_enc, content_hash, start_at, status, state,
                missing_since, fetched_at, expires_at)
             VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
             ON CONFLICT (provider_id, csn) DO NOTHING`,
          )
          .bind(
            row.provider_id,
            storedCsn,
            payloadEnc,
            digest,
            row.status,
            row.state,
            row.missing_since,
            row.fetched_at,
            expiresAt,
          ),
        ctx.db
          .prepare("DELETE FROM portal_visits WHERE provider_id = ? AND csn = ?")
          .bind(row.provider_id, row.csn),
      );
    }
    for (const page of chunk(statements, BATCH_CHUNK)) await batch(ctx.db, page);
    moved += rows.length;
  }
}

// ---------------------------------------------------------------------------
// The calendar: Google first, then the row.
// ---------------------------------------------------------------------------

/** The `key` marker of an event this app owns, or null. Mirrors `plan.ts`. */
function ownKey(event: EventRecord): string | null {
  const properties = event.extendedProperties?.private;
  if (properties?.healthy !== "1") return null;
  const key = properties.key;
  return key === undefined || key === "" ? null : key;
}

async function rekeyEvent(
  calendar: CalendarClient,
  calendarId: string,
  event: EventRecord,
  newKey: string,
): Promise<void> {
  const properties = event.extendedProperties?.private ?? {};
  await calendar.patchEvent(calendarId, event.id, {
    extendedProperties: {
      private: {
        ...properties,
        healthy: "1",
        key: newKey,
        fp: properties.fp ?? "",
        provider: properties.provider ?? newKey.slice(0, newKey.indexOf(":")),
      },
    },
  });
}

async function rekeyCalendar(
  ctx: Ctx,
  blinder: Blinder,
  options: BackfillOptions,
  counts: BackfillCounts,
): Promise<void> {
  const rows = await all<CalendarEventDbRow>(
    ctx.db.prepare("SELECT * FROM calendar_events WHERE detail_enc IS NULL"),
  );
  // Nothing on the calendar can carry an old key unless some row did once; a
  // database with no unmigrated row has nothing here to do, and never needs
  // Google at all.
  if (rows.length === 0) return;

  const calendar = await options.calendar();
  // `getSetting` reads the value sealed or not, so the step order does not matter.
  const target = await getSetting(ctx, "calendar_id");
  const listed = await calendar.listSyncedEvents({ calendarId: target, timeMin: LISTING_TIME_MIN });
  const byId = new Map(listed.map((event) => [event.id, event]));
  const handledKeys = new Set<string>();

  for (const row of rows) {
    if (isBlindedEventKey(row.event_key)) {
      throw new AppError("internal", "an unmigrated calendar row has a blinded key");
    }
    const newKey = await blindEventKey(blinder, row.event_key);
    handledKeys.add(row.event_key);
    const event =
      row.calendar_id === target
        ? (byId.get(row.google_event_id) ?? null)
        : await calendar.getEvent(row.calendar_id, row.google_event_id);
    if (event !== null && ownKey(event) === row.event_key) {
      await rekeyEvent(calendar, row.calendar_id, event, newKey);
      counts.googleEventsRekeyed += 1;
    }
    // An event that already carries `newKey` was patched by a run that died
    // before this row was written; one that is gone or not ours is left alone,
    // exactly as the sync would leave it.

    const detail = JSON.stringify({ calendarId: row.calendar_id, startAt: row.start_at });
    counts.calendarRowsRekeyed += await write(
      ctx,
      `UPDATE calendar_events
          SET event_key = ?, encounter_id = ?, calendar_id = ?, portal_csn = ?,
              start_at = NULL, detail_enc = ?
        WHERE event_key = ? AND detail_enc IS NULL`,
      [
        newKey,
        await encounterRef(blinder, row.provider_id, row.encounter_id),
        await blindCalendarId(blinder, row.calendar_id),
        row.portal_csn === null ? null : await blindCsn(blinder, row.provider_id, row.portal_csn),
        await sealShort(ctx.env, detail, calendarDetailAad(row.google_event_id)),
        row.event_key,
      ],
    );
  }

  // Events on the target calendar that still carry an old key and had no row:
  // re-keyed too, so the sync's adoption of a row-less event keeps working.
  for (const event of listed) {
    const key = ownKey(event);
    if (key === null || key.indexOf(":") <= 0 || isBlindedEventKey(key) || handledKeys.has(key))
      continue;
    await rekeyEvent(calendar, target, event, await blindEventKey(blinder, key));
    counts.googleOrphansRekeyed += 1;
  }
}
