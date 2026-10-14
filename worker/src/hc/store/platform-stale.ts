/**
 * `hc_platform_stale`: hours whose stored platform total (`Agg.<Metric>`) is
 * out of date, for the phone to work out again. See worker/src/hc/platform-totals.ts
 * for what a platform total is and why the phone cannot find these hours
 * itself.
 *
 * ### Marking, and clearing
 *
 * Applying a batch marks an hour when a record of a totalled type is taken out
 * of it: deleted, or rewritten with other times (or another origin) so that it
 * leaves the hours its old copy covered. Every hour the OLD copy covered is
 * marked -- start to end, not only the hour it starts in. Not the new copy's:
 * an upsert carries its times, and the phone works out the totals of the hours
 * it touches in the same upload. Not an hour the marking batch itself carries
 * the total of, which Health Connect worked out after the change. And never
 * for the `Agg.*` records themselves.
 *
 * The mark is written in the same `db.batch` as the chunk write that causes it
 * (worker/src/hc/apply.ts), so a slice that dies leaves both or neither, and a
 * replay writes it again to the same row.
 *
 * It is cleared by a total for that hour -- upserted, or deleted because the
 * hour has none any more -- from a batch that arrived AFTER the one that
 * marked it: a higher queue sequence number, the order tombstones go by
 * (worker/src/hc/store/record-index.ts). A total from an earlier batch, applied
 * late because it was set aside and queued again, was worked out before the
 * deletion and leaves the mark. A mark the one-off scan below wrote has no
 * batch behind it, and is cleared by a total from a batch that arrived in a
 * later second than it was written.
 *
 * Both statements write what the row is to be, so applying them twice leaves
 * what applying them once does.
 *
 * ### Telling the phone
 *
 * The ingest route's answer carries the device's marks (`staleHoursFor`):
 * the only way anything reaches the phone. A mark stays until a total clears
 * it, however many answers it has been in.
 *
 * ### The scan
 *
 * Totals that went stale before marks were kept were never marked. So the
 * runner walks every stored `Agg.<Metric>` hour once, a bounded pass at a time
 * when it has nothing else to do, and marks the hours whose total has a figure
 * where the type has no record at all (`scanPlatformTotals`; `staleTotals` in
 * worker/src/hc/platform-totals.ts says why it cannot also judge the apps a
 * total names). Revision 1 did judge them, and marked hours whose total was
 * fresh: those cost the phone one request each and were cleared by it, so
 * the revision is not raised for the change. `SCAN_REVISION`
 * says which making of the scan a device has been through: raising it walks
 * every device again after the next deploy, with nothing to run by hand.
 */

import { blindHcOrigin, blinderFor } from "../../db/blind.ts";
import { all, batch } from "../../db/client.ts";
import {
  PLATFORM_SOURCE_TYPES,
  addPresence,
  aggTypeOf,
  staleTotals,
  totalOrigins,
} from "../platform-totals.ts";
import { recordStartMs } from "../wire.ts";

import { readChunksInHours } from "./chunks.ts";
import { HOUR_MS } from "./keys.ts";

import type { Meter } from "./budget.ts";
import type { BatchArrival } from "./record-index.ts";
import type { Ctx } from "../../db/client.ts";
import type { Presence, StoredTotal } from "../platform-totals.ts";

/** Hours written per statement: one bound string of some tens of kilobytes at most. */
const MARK_PAGE = 5000;

/** The part of a batch's arrival a mark is stamped with, and a clear compared against. */
type Stamp = Pick<BatchArrival, "seq" | "receivedAt">;

/**
 * Mark `hours` of `sourceType` stale, stamped with the batch `by`. A row that
 * is already there keeps the later of the two stamps: a delete applied late
 * does not move a mark back, and neither does a replay.
 */
export function markStaleStatements(
  ctx: Ctx,
  deviceId: string,
  sourceType: string,
  hours: readonly number[],
  by: Stamp,
): D1PreparedStatement[] {
  const sql = `INSERT INTO hc_platform_stale (device_id, record_type, hour_utc, marked_seq, marked_at)
     SELECT ?1, ?2, value, ?3, ?4 FROM json_each(?5) WHERE true
     ON CONFLICT (device_id, record_type, hour_utc) DO UPDATE SET
       marked_seq = max(coalesce(marked_seq, excluded.marked_seq), excluded.marked_seq),
       marked_at = max(marked_at, excluded.marked_at)`;
  return pagesOf(hours).map((page) =>
    ctx.db.prepare(sql).bind(deviceId, sourceType, by.seq, by.receivedAt, page),
  );
}

/** `hours` as JSON arrays of at most `MARK_PAGE`: one bound string a statement. */
function pagesOf(hours: readonly number[]): string[] {
  const pages: string[] = [];
  for (let from = 0; from < hours.length; from += MARK_PAGE) {
    pages.push(JSON.stringify(hours.slice(from, from + MARK_PAGE)));
  }
  return pages;
}

/**
 * Clear the marks of `hours` of `sourceType` that the batch `by` arrived
 * after: the total it carries for them is newer than what made them stale.
 */
export function clearStaleStatements(
  ctx: Ctx,
  deviceId: string,
  sourceType: string,
  hours: readonly number[],
  by: Stamp,
): D1PreparedStatement[] {
  const sql = `DELETE FROM hc_platform_stale
      WHERE device_id = ?1 AND record_type = ?2
        AND hour_utc IN (SELECT value FROM json_each(?3))
        AND CASE WHEN marked_seq IS NULL THEN marked_at < ?5 ELSE marked_seq < ?4 END`;
  return pagesOf(hours).map((page) =>
    ctx.db.prepare(sql).bind(deviceId, sourceType, page, by.seq, by.receivedAt),
  );
}

// ---------------------------------------------------------------------------
// The ingest route's answer.
// ---------------------------------------------------------------------------

/**
 * Stale hours of one record type one answer carries, at most: the earliest
 * ones. Delivery pacing, not a cap: the phone works out a few hundred hours a
 * sync, politely, and a mark stays until a total clears it, so whatever is not
 * in this answer is in a later one. Nothing is dropped. Per type, so that one
 * type with months of stale hours does not keep another's out of the answer;
 * twenty days of hours, so a month of one type's history deleted at once is
 * answered over a few syncs.
 */
export const STALE_HOURS_PER_ANSWER = 500;

/**
 * The device's stale hours for the answer to the upload of `batchId`, by
 * record type, as epoch milliseconds of each hour's start; or null when this
 * answer cannot say.
 *
 * It cannot while another batch of the device is still waiting to be applied.
 * That batch may carry the very totals that clear a mark -- the phone's last
 * repair, waiting behind a backfill -- and an answer that listed the hour all
 * the same would have the phone work it out once more for nothing, every sync
 * until the queue drained. So the list is given only when nothing but this
 * batch is queued: every mark is then as the batches before it left it. (A
 * batch that was set aside does not count: it is applied only once it is
 * queued again, and the phone working an hour out again meanwhile is harmless.)
 *
 * The hours this very batch carries totals for are left out, for the same
 * reason: it is the repair of them, and has only not been applied yet. What
 * this batch's own deletes make stale is not marked yet either; the answer
 * after it says so.
 *
 * One `db.batch`, so one round trip: whether anything else is queued, and the
 * first `STALE_HOURS_PER_ANSWER` marks of each type.
 */
export async function staleHoursFor(
  ctx: Ctx,
  deviceId: string,
  batchId: string,
  carried: ReadonlySet<string>,
): Promise<Record<string, number[]> | null> {
  const [queued, rows] = await batch<{ waiting?: number; record_type?: string; hour_utc?: number }>(
    ctx.db,
    [
      ctx.db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM hc_ingest_queue
                           WHERE device_id = ? AND parked_at IS NULL AND batch_id != ?) AS waiting`,
        )
        .bind(deviceId, batchId),
      ctx.db
        .prepare(
          `SELECT record_type, hour_utc FROM (
             SELECT record_type, hour_utc,
                    row_number() OVER (PARTITION BY record_type ORDER BY hour_utc) AS n
               FROM hc_platform_stale WHERE device_id = ?)
            WHERE n <= ? ORDER BY record_type, hour_utc`,
        )
        .bind(deviceId, STALE_HOURS_PER_ANSWER),
    ],
  );
  if ((queued?.[0]?.waiting ?? 0) !== 0) return null;
  const byType = new Map<string, number[]>();
  const listed = rows ?? [];
  for (const row of listed) {
    const type = row.record_type;
    const hour = row.hour_utc;
    if (type === undefined || hour === undefined || carried.has(`${type}|${String(hour)}`))
      continue;
    const hours = byType.get(type) ?? [];
    hours.push(hour * HOUR_MS);
    byType.set(type, hours);
  }
  return Object.fromEntries(byType);
}

// ---------------------------------------------------------------------------
// The one-off scan.
// ---------------------------------------------------------------------------

/**
 * Which making of the scan a device has been through. Raise it when the rule
 * that decides a stale total changes, and every device is walked again, a
 * pass at a time, after the next deploy.
 */
export const SCAN_REVISION = 1;

/** Stored hours of one `Agg.<Metric>` type one pass reads: a week of a type worn all day. */
const SCAN_HOURS = 168;

/**
 * How far before an hour the store looks for a record still running into it.
 * A record lives in the chunk of the hour it starts in; one that started up to
 * this long before and runs on is found by its chunk's `max_end_ms`. A record
 * that started longer ago than this (a total written for days at a stretch)
 * is not seen, and an hour it is the only record of is marked: that costs the
 * phone one call that works the same total out again, after which the mark is
 * cleared. Two days, the bound the rollups divide records over.
 */
const LOOKBACK_HOURS = 48;

/** Statements one pass issues: the hours, the totals, the extents, the commit. */
const PASS_COST = 6;

interface ScanRow {
  revision: number;
  record_type: string;
  next_hour: number;
  done: number;
}

/** The `Agg.<Metric>` types, in the order they are walked. */
const AGG_TYPES: readonly string[] = PLATFORM_SOURCE_TYPES.map((type) => aggTypeOf(type) ?? type);

/** Where the walk stands: the type being walked and the first hour of it not yet looked at. */
interface ScanAt {
  aggType: string;
  nextHour: number;
}

/** What a scan works through: the types with stored totals, in walking order. */
interface Scan {
  ctx: Ctx;
  deviceId: string;
  meter: Meter;
  types: readonly string[];
}

/** The first type of `scan.types` at or after `aggType` in the walk, from `nextHour`; null at the end. */
function positionFrom(scan: Scan, aggType: string, nextHour: number): ScanAt | null {
  const at = AGG_TYPES.indexOf(aggType);
  for (const type of scan.types) {
    const index = AGG_TYPES.indexOf(type);
    if (index === at) return { aggType: type, nextHour };
    if (index > at) return { aggType: type, nextHour: 0 };
  }
  return null;
}

/**
 * Where the scan of a device stands, and which totalled types it has any
 * stored total of: one round trip. Null when there is nothing left to do --
 * the scan of this revision is done, or the device has no stored total at all
 * (then nothing is written: a device that starts uploading totals later
 * uploads them beside their records, and the marks apply keeps cover those).
 */
async function startScan(
  ctx: Ctx,
  deviceId: string,
  meter: Meter,
): Promise<{ scan: Scan; at: ScanAt | null } | null> {
  meter.spend(2);
  const [positions, present] = await batch<ScanRow & { record_type: string }>(ctx.db, [
    ctx.db
      .prepare(
        "SELECT revision, record_type, next_hour, done FROM hc_platform_scan WHERE device_id = ?",
      )
      .bind(deviceId),
    // `hc_sync_state` counts every stored type, the totals included: which of
    // them have anything is one primary-key read, where asking `hc_chunks`
    // would be a read per type.
    ctx.db
      .prepare(
        `SELECT record_type FROM hc_sync_state
          WHERE device_id = ? AND record_count > 0
            AND record_type IN (SELECT value FROM json_each(?))`,
      )
      .bind(deviceId, JSON.stringify(AGG_TYPES)),
  ]);
  const row = positions?.[0];
  if (row?.revision === SCAN_REVISION && row.done === 1) return null;
  const stored = new Set((present ?? []).map((entry) => entry.record_type));
  const scan: Scan = { ctx, deviceId, meter, types: AGG_TYPES.filter((type) => stored.has(type)) };
  if (scan.types.length === 0) return null;
  const current = row?.revision === SCAN_REVISION ? row : null;
  const at = positionFrom(
    scan,
    current?.record_type ?? AGG_TYPES[0] ?? "",
    current?.next_hour ?? 0,
  );
  return { scan, at };
}

/** The statement that records where the scan has got to: null is done. */
function positionStatement(ctx: Ctx, deviceId: string, at: ScanAt | null): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO hc_platform_scan (device_id, revision, record_type, next_hour, done)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET revision = excluded.revision,
         record_type = excluded.record_type, next_hour = excluded.next_hour, done = excluded.done`,
    )
    .bind(deviceId, SCAN_REVISION, at?.aggType ?? "", at?.nextHour ?? 0, at === null ? 1 : 0);
}

/** One pass: up to `SCAN_HOURS` stored hours of one type, from `at.nextHour`. */
async function scanPass(scan: Scan, at: ScanAt): Promise<ScanAt | null> {
  const { ctx, deviceId, meter } = scan;
  const { aggType, nextHour } = at;
  const sourceType = PLATFORM_SOURCE_TYPES[AGG_TYPES.indexOf(aggType)];
  meter.spend();
  const hours =
    sourceType === undefined
      ? []
      : await all<{ hour_utc: number }>(
          ctx.db
            .prepare(
              `SELECT hour_utc FROM hc_chunks
                WHERE device_id = ? AND record_type = ? AND hour_utc >= ? AND part = 0
                ORDER BY hour_utc LIMIT ?`,
            )
            .bind(deviceId, aggType, nextHour, SCAN_HOURS),
        );
  const first = hours[0]?.hour_utc;
  const last = hours.at(-1)?.hour_utc;
  if (sourceType === undefined || first === undefined || last === undefined) {
    // Nothing (more) of this type: on to the next, or done.
    const nextType = scan.types[scan.types.indexOf(aggType) + 1];
    const following = nextType === undefined ? null : { aggType: nextType, nextHour: 0 };
    meter.spend();
    await batch(ctx.db, [positionStatement(ctx, deviceId, following)]);
    return following;
  }

  meter.spend();
  const chunks = await readChunksInHours(ctx, deviceId, aggType, first, last + 1);
  meter.spend();
  const extents = await all<{ origin_hash: string; min_start_ms: number; max_end_ms: number }>(
    ctx.db
      .prepare(
        `SELECT origin_hash, min_start_ms, max_end_ms FROM hc_chunks
          WHERE device_id = ? AND record_type = ? AND hour_utc >= ? AND hour_utc < ? AND part = 0`,
      )
      .bind(deviceId, sourceType, first - LOOKBACK_HOURS, last + 1),
  );
  const window = { fromHour: first, toHour: last + 1 };
  const presence: Presence = new Map();
  for (const extent of extents) {
    addPresence(
      presence,
      extent.origin_hash,
      { startMs: extent.min_start_ms, endMs: extent.max_end_ms },
      window,
    );
  }
  // The origins a total names are package names, inside its sealed record;
  // the chunks carry their origin blinded. Blinded here, so the two compare.
  const blinder = blinderFor(ctx.env);
  const blinds = new Map<string, string>();
  const blindOf = async (origin: string): Promise<string> => {
    let blind = blinds.get(origin);
    if (blind === undefined) {
      blind = await blindHcOrigin(blinder, deviceId, origin);
      blinds.set(origin, blind);
    }
    return blind;
  };
  const totals: StoredTotal[] = [];
  for (const chunk of chunks) {
    for (const record of chunk.records) {
      const origins = await Promise.all(
        totalOrigins(record).map(async (origin) => blindOf(origin)),
      );
      totals.push({ hourUtc: Math.floor(recordStartMs(record) / HOUR_MS), origins });
    }
  }
  const stale = staleTotals(totals, presence).map((found) => found.hourUtc);
  const after = { aggType, nextHour: last + 1 };
  const statements = [
    ...(stale.length === 0
      ? []
      : [
          ctx.db
            .prepare(
              // A mark a batch already wrote is left as it is: it says more.
              `INSERT INTO hc_platform_stale (device_id, record_type, hour_utc, marked_seq, marked_at)
               SELECT ?, ?, value, NULL, ? FROM json_each(?) WHERE true
               ON CONFLICT (device_id, record_type, hour_utc) DO NOTHING`,
            )
            .bind(deviceId, sourceType, ctx.now(), JSON.stringify(stale)),
        ]),
    positionStatement(ctx, deviceId, after),
  ];
  meter.spend(statements.length);
  await batch(ctx.db, statements);
  if (stale.length > 0) {
    ctx.log.info("hc.platform_scan", {
      deviceId,
      aggType,
      hours: hours.length,
      stale: stale.length,
    });
  }
  return after;
}

/**
 * Walk the stored platform totals of a device for stale hours, a pass at a
 * time, while the budget lasts. True when there is more to walk. What the
 * runner does when it has nothing else to do; each pass writes its marks and
 * where it got to in one transaction, so a slice that dies repeats one pass.
 */
export async function scanPlatformTotals(
  ctx: Ctx,
  deviceId: string,
  meter: Meter,
): Promise<boolean> {
  const started = await startScan(ctx, deviceId, meter);
  if (started === null) return false;
  const { scan } = started;
  let { at } = started;
  if (at === null) {
    // Past the last type with totals: the walk is over.
    meter.spend();
    await batch(ctx.db, [positionStatement(ctx, deviceId, null)]);
    return false;
  }
  while (at !== null) {
    if (!meter.mayStart(PASS_COST)) return true;
    at = await scanPass(scan, at);
    meter.done();
  }
  return false;
}
