/**
 * The rebuild phase: what the ingest runner does once a device's queue is
 * empty. It drains `hc_dirty` (worker/src/hc/store/dirty.ts), turning each
 * mark into the row it asks for:
 *
 *   hr        the per-minute heart-rate row of an hour a series spilled into
 *   day       one type's day rollups for a UTC day, from its hour rollups
 *   sleep     one night's summary, from the session and what was measured
 *   exercise  one session's summary, likewise
 *
 * Each row is written, and its mark deleted, in one `db.batch`. A slice that
 * is cut off leaves the mark, and the row is built again: every build reads
 * the store as it is, so building twice is harmless.
 *
 * `day` marks are settled a run at a time -- up to `DAY_RUN` consecutive UTC
 * days of one type, their hour rollups read once, every local day they fall on
 * written and all their marks cleared in the one transaction. A UTC day falls
 * on two local days in any zone off UTC and its neighbour shares one of them,
 * so a run builds each local day once where single marks would build it twice.
 *
 * ### Days and the configured zone
 *
 * A day rollup is a calendar day in the zone the owner configured (the sealed
 * `timezone` setting; there is no zone in source). Its hours are whole UTC
 * hours wherever the day's edges fall on one, and are read from the hour
 * rollups without opening a chunk. Where an edge falls inside a UTC hour (a
 * zone a half or three quarters of an hour off UTC) that one hour's chunk is
 * opened and only the records that start on the right side of the edge are
 * counted, so a day is exact in every zone.
 *
 * Each row carries `tz_digest`, a keyed digest of the zone it was built for.
 * When the setting changes, rows of the old zone are found by that digest:
 * every day the type has data on is marked for the new zone and the old rows
 * are deleted, one record type at a time so the work is resumable. Readers
 * only return rows of the current zone in the meantime.
 */

import { blindHcRecordId, blinderFor } from "../../db/blind.ts";
import { all, batch, one } from "../../db/client.ts";
import { getTimezone } from "../../db/settings.ts";
import { dayBoundsMs, daysTouched } from "../rollup/day.ts";
import { summariseExercise } from "../rollup/exercise.ts";
import { mergeRollups, rollupBucket } from "../rollup/hour.ts";
import {
  HR_WAKE_SEARCH_AFTER_MS,
  SLEEP_MATCH_TOLERANCE_MS,
  summariseSleep,
} from "../rollup/sleep.ts";
import { recordEndMs, recordStartMs } from "../wire.ts";

import {
  hourRollupStatement,
  hrMinuteAad,
  hrMinuteStatement,
  hrSpillIn,
  readChunks,
  readChunksInHours,
} from "./chunks.ts";
import {
  MAX_SESSION_SPAN_MS,
  clearKeysStatement,
  clearStatement,
  nextDirty,
  parkMarkStatements,
} from "./dirty.ts";
import {
  DAY_HOURS,
  DAY_MARK_KEY_SQL,
  HOUR_MS,
  TYPE_EXERCISE_SESSION,
  TYPE_HEART_RATE,
  TYPE_SLEEP_SESSION,
  compareText,
  dayMarkKey,
  dayRuns,
  hourOf,
  hrMarkKey,
  keyId,
  listOf,
  parseHrMarkKey,
  sortedBy,
} from "./keys.ts";
import { readHrPoints, readRecords, tzDigest } from "./read.ts";
import { lookupIndex } from "./record-index.ts";
import { openJson, payloadAad, permanentStoreCode, sealJson } from "./sealed.ts";

import type { Meter } from "./budget.ts";
import type { StoredChunk } from "./chunks.ts";
import type { DirtyRow } from "./dirty.ts";
import type { ChunkKey, DayRun } from "./keys.ts";
import type { Ctx } from "../../db/client.ts";
import type { BucketRollup } from "../rollup/types.ts";
import type { HcRecord } from "../wire.ts";

/**
 * How far either side of a sleep session its context is read, and so how far
 * from a changed record a stored night is marked for rebuilding: the wider of
 * the two margins the summary itself uses (worker/src/hc/rollup/sleep.ts).
 */
export const SLEEP_CONTEXT_MARGIN_MS = Math.max(SLEEP_MATCH_TOLERANCE_MS, HR_WAKE_SEARCH_AFTER_MS);

const TYPE_HRV = "HeartRateVariabilityRmssd";
const TYPE_RESPIRATORY_RATE = "RespiratoryRate";
const TYPE_SKIN_TEMPERATURE = "SkinTemperature";
const TYPE_RESTING_HEART_RATE = "RestingHeartRate";
const TYPE_STEPS = "Steps";
const TYPE_DISTANCE = "Distance";
const TYPE_ACTIVE_CALORIES = "ActiveCaloriesBurned";

/**
 * The types a sleep night's summary reads. A change to one re-marks the night.
 * Another sleep session is among them: a reading stamped between two sessions
 * is given to one only, so each night depends on its neighbours.
 */
export const SLEEP_CONTEXT_TYPES: ReadonlySet<string> = new Set([
  TYPE_SLEEP_SESSION,
  TYPE_HEART_RATE,
  TYPE_HRV,
  TYPE_RESPIRATORY_RATE,
  TYPE_SKIN_TEMPERATURE,
  TYPE_RESTING_HEART_RATE,
]);

/** The same for an exercise session; another session can change its overlaps. */
export const EXERCISE_CONTEXT_TYPES: ReadonlySet<string> = new Set([
  TYPE_HEART_RATE,
  TYPE_STEPS,
  TYPE_DISTANCE,
  TYPE_ACTIVE_CALORIES,
  TYPE_EXERCISE_SESSION,
]);

/** Marks fetched per query. */
const DIRTY_PAGE = 100;
/**
 * Statements one mark may cost, as an upper estimate: a session's summary is
 * the dearest, at two reads per context type plus the write.
 */
const MARK_COST = 16;

const DAY_MS = DAY_HOURS * HOUR_MS;
/**
 * UTC days of one type settled as one unit. A week: its eight or nine local
 * days are one read of hour rollups (a few hundred small rows) and one
 * transaction of a few dozen statements, and only the two days at its ends can
 * be built again by a neighbouring run.
 */
const DAY_RUN = 7;
/**
 * Statements one run may cost, as an estimate: the read and the statement that
 * clears the marks, then for each local day -- one more than the run has UTC
 * days, in any zone off UTC -- a row per origin (taken as two) and the delete
 * of the origins that left.
 */
const runCost = (run: DayRun): number => 2 + (run.days + 1) * 3;

interface Rebuild {
  ctx: Ctx;
  deviceId: string;
  zone: string;
  digest: string;
  meter: Meter;
}

async function commit(job: Rebuild, statements: D1PreparedStatement[]): Promise<void> {
  job.meter.spend(statements.length);
  await batch(job.ctx.db, statements);
}

// ---------------------------------------------------------------------------
// The zone.
// ---------------------------------------------------------------------------

/**
 * Re-mark every day of every type that still has rows built for another zone.
 * True when none are left.
 */
async function rezone(job: Rebuild): Promise<boolean> {
  const { ctx, deviceId, digest, meter } = job;
  for (;;) {
    meter.spend();
    const stale = await one<{ record_type: string }>(
      ctx.db
        .prepare(
          "SELECT record_type FROM hc_rollup_day WHERE device_id = ? AND tz_digest != ? LIMIT 1",
        )
        .bind(deviceId, digest),
    );
    if (stale === null) return true;
    if (!meter.mayStart(MARK_COST)) return false;

    // Every UTC day the type has data in is marked; which local days those are
    // is settled when each mark is rebuilt. In one transaction with the delete,
    // so the old rows only go once their replacements are asked for.
    const statements = [
      ctx.db
        .prepare(
          `INSERT INTO hc_dirty (device_id, kind, key, marked_at)
           SELECT device_id, 'day', ${DAY_MARK_KEY_SQL}, ?
             FROM hc_rollup_hour WHERE device_id = ? AND record_type = ?
            GROUP BY hour_utc / ${String(DAY_HOURS)}
           ON CONFLICT (device_id, kind, key) DO UPDATE SET marked_at = excluded.marked_at`,
        )
        .bind(ctx.now(), deviceId, stale.record_type),
      ctx.db
        .prepare(
          "DELETE FROM hc_rollup_day WHERE device_id = ? AND record_type = ? AND tz_digest != ?",
        )
        .bind(deviceId, stale.record_type, digest),
    ];
    await commit(job, statements);
    meter.done();
    ctx.log.info("hc.rezoned", { deviceId });
  }
}

// ---------------------------------------------------------------------------
// One mark of each kind. Each returns the statements that write the row; the
// caller adds the one that clears the mark.
// ---------------------------------------------------------------------------

async function rebuildHr(job: Rebuild, key: string): Promise<D1PreparedStatement[]> {
  const parsed = parseHrMarkKey(key);
  if (parsed === null) return [];
  const { ctx, deviceId, meter } = job;
  const own: ChunkKey = { type: TYPE_HEART_RATE, ...parsed };
  const chunks = await readChunks(ctx, deviceId, [own], meter);
  const chunk = chunks.get(keyId(own));
  const spill = await hrSpillIn(ctx, deviceId, parsed.originHash, parsed.hourUtc, meter);
  return [
    await hrMinuteStatement(ctx, deviceId, parsed.originHash, parsed.hourUtc, [
      ...spill,
      ...(chunk?.records ?? []),
    ]),
  ];
}

interface HourRow {
  origin_hash: string;
  hour_utc: number;
  payload_enc: string;
}

/** One origin's share of a day: the rollups of its hours, to be merged. */
type DayParts = Map<string, BucketRollup[]>;

function addPart(parts: DayParts, originHash: string, part: BucketRollup): void {
  parts.set(originHash, [...(parts.get(originHash) ?? []), part]);
}

/** The part of a chunk that counts towards a day: the records that start in it. */
function addChunk(parts: DayParts, chunk: StoredChunk, startMs: number, endMs: number): void {
  const inDay = chunk.records.filter((record) => {
    const at = recordStartMs(record);
    return at >= startMs && at < endMs;
  });
  if (inDay.length > 0) addPart(parts, chunk.key.originHash, rollupBucket(chunk.key.type, inDay));
}

/** One type's hour rollups for the UTC hours that `[startMs, endMs)` touches, every origin. */
async function hourRollups(
  job: Rebuild,
  type: string,
  startMs: number,
  endMs: number,
): Promise<HourRow[]> {
  const { ctx, deviceId, meter } = job;
  meter.spend();
  return all<HourRow>(
    ctx.db
      .prepare(
        `SELECT origin_hash, hour_utc, payload_enc FROM hc_rollup_hour
          WHERE device_id = ? AND record_type = ? AND hour_utc >= ? AND hour_utc < ?
          ORDER BY origin_hash, hour_utc`,
      )
      .bind(deviceId, type, hourOf(startMs), Math.ceil(endMs / HOUR_MS)),
  );
}

/**
 * A day's parts the cheap way: hours wholly inside the day from their rollup,
 * and an hour the day's edge cuts through recounted from its chunk (see the
 * module comment). `rows` are the type's hour rollups, already read, for a span
 * that covers the day; the ones outside it are passed over.
 */
async function dayFromRollups(
  job: Rebuild,
  type: string,
  startMs: number,
  endMs: number,
  rows: readonly HourRow[],
): Promise<DayParts> {
  const { ctx, deviceId, meter } = job;
  const parts: DayParts = new Map();
  const cut: ChunkKey[] = [];
  for (const row of rows) {
    const hourStart = row.hour_utc * HOUR_MS;
    if (hourStart + HOUR_MS <= startMs || hourStart >= endMs) continue;
    if (hourStart >= startMs && hourStart + HOUR_MS <= endMs) {
      const aad = payloadAad("hc_rollup_hour", deviceId, type, row.origin_hash, row.hour_utc);
      addPart(parts, row.origin_hash, (await openJson(ctx, row.payload_enc, aad)) as BucketRollup);
    } else {
      cut.push({ type, originHash: row.origin_hash, hourUtc: row.hour_utc });
    }
  }
  const cutChunks = await readChunks(ctx, deviceId, cut, meter);
  for (const chunk of cutChunks.values()) addChunk(parts, chunk, startMs, endMs);
  return parts;
}

/**
 * A day's parts the long way: every chunk of the day opened and counted. What
 * is done when an hour rollup will not open. A rollup is derived, so it is not
 * a loss: `repairs` are the statements that write each hour's rollup afresh.
 */
async function dayFromChunks(
  job: Rebuild,
  type: string,
  startMs: number,
  endMs: number,
): Promise<{ parts: DayParts; repairs: D1PreparedStatement[] }> {
  const { ctx, deviceId, meter } = job;
  const chunks = await readChunksInHours(
    ctx,
    deviceId,
    type,
    hourOf(startMs),
    Math.ceil(endMs / HOUR_MS),
    meter,
  );
  const parts: DayParts = new Map();
  const repairs: D1PreparedStatement[] = [];
  for (const chunk of chunks) {
    repairs.push(await hourRollupStatement(ctx, deviceId, chunk.key, chunk.records));
    addChunk(parts, chunk, startMs, endMs);
  }
  return { parts, repairs };
}

/**
 * The statement that removes a day's rows for the origins that no longer have
 * anything on it. Bound: device, type, day, and the origins that do, as a JSON
 * array.
 *
 * `INDEXED BY`: the day is not next in the primary key (the origin is), so left
 * to itself the planner walks every day the type has ever had and tests each.
 * Once per day rebuilt, that is every stored day read again for each of them.
 * The range index goes straight to the one day.
 */
export const PRUNE_DAY_SQL = `DELETE FROM hc_rollup_day INDEXED BY hc_rollup_day_range
  WHERE device_id = ? AND record_type = ? AND day = ?
    AND origin_hash NOT IN (SELECT value FROM json_each(?))`;

/**
 * The statements that make one type's rows for one local day agree with the
 * store. `rows`: see `dayFromRollups`.
 */
async function dayStatements(
  job: Rebuild,
  type: string,
  day: string,
  rows: readonly HourRow[],
): Promise<D1PreparedStatement[]> {
  const { ctx, deviceId } = job;
  const { startMs, endMs } = dayBoundsMs(day, job.zone);
  let parts: DayParts;
  const statements: D1PreparedStatement[] = [];
  try {
    parts = await dayFromRollups(job, type, startMs, endMs, rows);
  } catch (error) {
    const errorCode = permanentStoreCode(error);
    if (errorCode === null) throw error;
    ctx.log.warn("hc.rollup_repaired", { deviceId, errorCode });
    const rebuilt = await dayFromChunks(job, type, startMs, endMs);
    ({ parts } = rebuilt);
    statements.push(...rebuilt.repairs);
  }

  const at = ctx.now();
  for (const [originHash, originParts] of parts) {
    const aad = payloadAad("hc_rollup_day", deviceId, type, originHash, day);
    const sealed = await sealJson(ctx, mergeRollups(originParts), aad);
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO hc_rollup_day
             (device_id, record_type, origin_hash, day, tz_digest, payload_enc, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (device_id, record_type, origin_hash, day) DO UPDATE SET
             tz_digest = excluded.tz_digest,
             payload_enc = excluded.payload_enc,
             updated_at = excluded.updated_at`,
        )
        .bind(deviceId, type, originHash, day, job.digest, sealed, at),
    );
  }
  // An origin with nothing left on the day loses its row.
  const kept = JSON.stringify(listOf(parts.keys()));
  statements.push(ctx.db.prepare(PRUNE_DAY_SQL).bind(deviceId, type, day, kept));
  return statements;
}

/**
 * The statements that settle a run of `day` marks: every local day the run's
 * UTC days fall on -- in the zone configured now -- rebuilt for the type, and
 * the mark of each of those UTC days cleared. Each hour of the run lies inside
 * one of the days rebuilt, so the marks are answered whole; a neighbouring run
 * that shares the local day at either end will build that one day again, which
 * is only work.
 */
async function rebuildDayRun(job: Rebuild, run: DayRun): Promise<D1PreparedStatement[]> {
  const { type } = run;
  const startMs = run.firstDay * DAY_MS;
  const days = daysTouched(startMs, startMs + run.days * DAY_MS, job.zone);
  const bounds = days.map((day) => dayBoundsMs(day, job.zone));
  const rows = await hourRollups(
    job,
    type,
    Math.min(...bounds.map((bound) => bound.startMs)),
    Math.max(...bounds.map((bound) => bound.endMs)),
  );
  const statements: D1PreparedStatement[] = [];
  for (const day of days) statements.push(...(await dayStatements(job, type, day, rows)));
  const answered: string[] = [];
  for (let day = run.firstDay; day < run.firstDay + run.days; day += 1) {
    answered.push(dayMarkKey(type, day * DAY_HOURS));
  }
  statements.push(clearKeysStatement(job.ctx, job.deviceId, "day", answered));
  return statements;
}

/**
 * The transactions that settle a run: one that rebuilds it, or -- when a chunk
 * one of its days has to be built from will not open -- one per UTC day, with
 * the day that cannot be built parked (see `settleMark`) and the others built.
 */
async function settleDayRun(job: Rebuild, run: DayRun): Promise<D1PreparedStatement[][]> {
  const { ctx, deviceId } = job;
  try {
    return [await rebuildDayRun(job, run)];
  } catch (error) {
    const errorCode = permanentStoreCode(error);
    if (errorCode === null) throw error;
    if (run.days === 1) {
      ctx.log.error("hc.mark_parked", { deviceId, kind: "day", errorCode });
      const mark = { kind: "day", key: dayMarkKey(run.type, run.firstDay * DAY_HOURS) };
      return [parkMarkStatements(ctx, deviceId, mark)];
    }
    const batches: D1PreparedStatement[][] = [];
    for (let day = run.firstDay + run.days - 1; day >= run.firstDay; day -= 1) {
      batches.push(...(await settleDayRun(job, { type: run.type, firstDay: day, days: 1 })));
    }
    return batches;
  }
}

/** Settle a page of `day` marks, a run at a time. False when the budget ran out. */
async function settleDays(job: Rebuild, marks: readonly DirtyRow[]): Promise<boolean> {
  const { runs, unreadable } = dayRuns(
    marks.map((mark) => mark.key),
    DAY_RUN,
  );
  if (unreadable.length > 0) {
    // Keys no version of this code writes. Cleared, not guessed at.
    await commit(job, [clearKeysStatement(job.ctx, job.deviceId, "day", unreadable)]);
    job.meter.done();
  }
  for (const run of runs) {
    if (!job.meter.mayStart(runCost(run))) return false;
    const batches = await settleDayRun(job, run);
    for (const statements of batches) await commit(job, statements);
    job.meter.done();
  }
  return true;
}

/**
 * The stretch of a session its context is read for. A session that claims to
 * run for longer than any real one is summarised from its first
 * `MAX_SESSION_SPAN_MS` only -- reading months of heart rate for one record
 * would be a way to stall the rebuild -- and the summary says so.
 */
function contextSpan(session: HcRecord): { startMs: number; endMs: number; clamped: boolean } {
  const startMs = recordStartMs(session);
  const endMs = recordEndMs(session);
  const clamped = endMs - startMs > MAX_SESSION_SPAN_MS;
  return { startMs, endMs: clamped ? startMs + MAX_SESSION_SPAN_MS : endMs, clamped };
}

interface HrMinuteRow {
  origin_hash: string;
  hour_utc: number;
  payload_enc: string;
}

/**
 * Rewrite, from the chunks, every per-minute heart-rate row of the window that
 * will not open. The rows are derived; one that is corrupt is rebuilt.
 */
async function repairHrMinutes(job: Rebuild, startMs: number, endMs: number): Promise<void> {
  const { ctx, deviceId, meter } = job;
  meter.spend();
  const rows = await all<HrMinuteRow>(
    ctx.db
      .prepare(
        `SELECT origin_hash, hour_utc, payload_enc FROM hc_hr_minute
          WHERE device_id = ? AND hour_utc >= ? AND hour_utc < ?`,
      )
      .bind(deviceId, hourOf(startMs), hourOf(endMs) + 1),
  );
  for (const row of rows) {
    try {
      await openJson(ctx, row.payload_enc, hrMinuteAad(deviceId, row.origin_hash, row.hour_utc));
    } catch (error) {
      const errorCode = permanentStoreCode(error);
      if (errorCode === null) throw error;
      ctx.log.warn("hc.hr_minute_repaired", { deviceId, errorCode });
      await commit(job, await rebuildHr(job, hrMarkKey(row.origin_hash, row.hour_utc)));
    }
  }
}

/** `readHrPoints`, repairing the minute rows once if one of them will not open. */
async function hrPoints(
  job: Rebuild,
  startMs: number,
  endMs: number,
  originHash: string,
): Promise<{ t: number; bpm: number }[]> {
  job.meter.spend();
  try {
    return await readHrPoints(job.ctx, job.deviceId, startMs, endMs, originHash);
  } catch (error) {
    if (permanentStoreCode(error) === null) throw error;
    await repairHrMinutes(job, startMs, endMs);
    job.meter.spend();
    return readHrPoints(job.ctx, job.deviceId, startMs, endMs, originHash);
  }
}

/** The stored session a `sleep` or `exercise` mark names, or null when it is gone. */
async function findSession(
  job: Rebuild,
  type: string,
  idBlind: string,
): Promise<{ session: HcRecord; originHash: string } | null> {
  const { ctx, deviceId, meter } = job;
  const index = await lookupIndex(ctx, deviceId, [idBlind], meter);
  const entry = index.get(idBlind);
  if (entry === undefined || entry.deleted || entry.key.type !== type) return null;
  const chunks = await readChunks(ctx, deviceId, [entry.key], meter);
  const chunk = chunks.get(keyId(entry.key));
  const blinder = blinderFor(ctx.env);
  const held = chunk?.records ?? [];
  for (const record of held) {
    if ((await blindHcRecordId(blinder, deviceId, record.id)) === idBlind) {
      return { session: record, originHash: entry.key.originHash };
    }
  }
  return null;
}

async function rebuildSleep(job: Rebuild, idBlind: string): Promise<D1PreparedStatement[]> {
  const { ctx, deviceId, meter } = job;
  const found = await findSession(job, TYPE_SLEEP_SESSION, idBlind);
  if (found === null) {
    return [
      ctx.db
        .prepare("DELETE FROM hc_sleep_night WHERE device_id = ? AND record_id_blind = ?")
        .bind(deviceId, idBlind),
    ];
  }
  const { session } = found;
  const span = contextSpan(session);
  const startMs = span.startMs - SLEEP_CONTEXT_MARGIN_MS;
  const endMs = span.endMs + SLEEP_CONTEXT_MARGIN_MS;
  const around = (type: string): Promise<HcRecord[]> => {
    meter.spend(2);
    return readRecords(ctx, { deviceId, type, startMs, endMs: endMs + 1 });
  };
  // The other sessions near this one (a nap after the night), read from the raw
  // records as the exercise rebuild does: a reading stamped between two
  // sessions is given to one of them only, and each has to know of the other.
  const blinder = blinderFor(ctx.env);
  const others: { startMs: number; endMs: number }[] = [];
  const sleepSessions = await around(TYPE_SLEEP_SESSION);
  for (const other of sleepSessions) {
    if ((await blindHcRecordId(blinder, deviceId, other.id)) !== idBlind) {
      others.push({ startMs: recordStartMs(other), endMs: recordEndMs(other) });
    }
  }
  const night = summariseSleep(session, {
    hr: await hrPoints(job, startMs, endMs, found.originHash),
    hrv: await around(TYPE_HRV),
    respiratoryRate: await around(TYPE_RESPIRATORY_RATE),
    skinTemperature: await around(TYPE_SKIN_TEMPERATURE),
    restingHeartRate: await around(TYPE_RESTING_HEART_RATE),
    others,
  });
  return [
    ctx.db
      .prepare(
        `INSERT INTO hc_sleep_night (device_id, record_id_blind, start_ms, end_ms, payload_enc, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id, record_id_blind) DO UPDATE SET
           start_ms = excluded.start_ms,
           end_ms = excluded.end_ms,
           payload_enc = excluded.payload_enc,
           updated_at = excluded.updated_at`,
      )
      .bind(
        deviceId,
        idBlind,
        night.startMs,
        night.endMs,
        await sealJson(
          ctx,
          span.clamped ? { ...night, contextClamped: true } : night,
          payloadAad("hc_sleep_night", deviceId, idBlind),
        ),
        ctx.now(),
      ),
  ];
}

/**
 * One origin's records, for a quantity that is summed: the session's own app's
 * when it wrote any in the window, otherwise those of the app that wrote the
 * most. Two apps counting the same steps must not be added together.
 */
function oneOrigin(records: readonly HcRecord[], ownOrigin: string): HcRecord[] {
  const byOrigin = new Map<string, HcRecord[]>();
  for (const record of records) {
    byOrigin.set(record.origin, [...(byOrigin.get(record.origin) ?? []), record]);
  }
  const own = byOrigin.get(ownOrigin);
  if (own !== undefined) return own;
  // Most records first; the package name breaks a tie, so the choice is stable.
  const ranked = sortedBy(
    byOrigin,
    ([leftName, left], [rightName, right]) =>
      right.length - left.length || compareText(leftName, rightName),
  );
  return ranked[0]?.[1] ?? [];
}

async function rebuildExercise(job: Rebuild, idBlind: string): Promise<D1PreparedStatement[]> {
  const { ctx, deviceId, meter } = job;
  const found = await findSession(job, TYPE_EXERCISE_SESSION, idBlind);
  if (found === null) {
    return [
      ctx.db
        .prepare("DELETE FROM hc_exercise_session WHERE device_id = ? AND record_id_blind = ?")
        .bind(deviceId, idBlind),
    ];
  }
  const { session } = found;
  const span = contextSpan(session);
  const { startMs, endMs } = span;
  const during = (type: string): Promise<HcRecord[]> => {
    meter.spend(2);
    return readRecords(ctx, { deviceId, type, startMs, endMs: endMs + 1 });
  };
  const blinder = blinderFor(ctx.env);
  // The other sessions come from the raw records, not from the summaries: a
  // summary that has not been built yet would otherwise be an overlap missed.
  const others: { idBlind: string; startMs: number; endMs: number }[] = [];
  const sessions = await during(TYPE_EXERCISE_SESSION);
  for (const other of sessions) {
    const otherBlind = await blindHcRecordId(blinder, deviceId, other.id);
    if (otherBlind !== idBlind) {
      others.push({
        idBlind: otherBlind,
        startMs: recordStartMs(other),
        endMs: recordEndMs(other),
      });
    }
  }
  const summary = summariseExercise(session, {
    hr: await hrPoints(job, startMs, endMs, found.originHash),
    steps: oneOrigin(await during(TYPE_STEPS), session.origin),
    distance: oneOrigin(await during(TYPE_DISTANCE), session.origin),
    activeCalories: oneOrigin(await during(TYPE_ACTIVE_CALORIES), session.origin),
    others,
  });
  return [
    ctx.db
      .prepare(
        `INSERT INTO hc_exercise_session (device_id, record_id_blind, start_ms, end_ms, payload_enc, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id, record_id_blind) DO UPDATE SET
           start_ms = excluded.start_ms,
           end_ms = excluded.end_ms,
           payload_enc = excluded.payload_enc,
           updated_at = excluded.updated_at`,
      )
      .bind(
        deviceId,
        idBlind,
        summary.startMs,
        summary.endMs,
        await sealJson(
          ctx,
          span.clamped ? { ...summary, contextClamped: true } : summary,
          payloadAad("hc_exercise_session", deviceId, idBlind),
        ),
        ctx.now(),
      ),
  ];
}

async function rebuildMark(job: Rebuild, mark: DirtyRow): Promise<D1PreparedStatement[]> {
  switch (mark.kind) {
    case "hr": {
      return rebuildHr(job, mark.key);
    }
    case "sleep": {
      return rebuildSleep(job, mark.key);
    }
    case "exercise": {
      return rebuildExercise(job, mark.key);
    }
    default: {
      // A kind no version of this code writes. Cleared, not guessed at.
      job.ctx.log.warn("hc.dirty_unknown_kind", { deviceId: job.deviceId });
      return [];
    }
  }
}

/**
 * The statements that settle one mark: its row written and the mark cleared --
 * or, when what the row has to be built from will not open, the mark parked.
 *
 * A derived row that is corrupt has been repaired by the time an error gets
 * here (`dayStatements`, `hrPoints`); what is left is a source chunk that
 * cannot be read. Retrying that would hold this mark at the head of the list
 * for ever with every other mark behind it, so it is set aside, loudly, and
 * the rebuild goes on. Anything that might pass is thrown, as everywhere else.
 */
async function settleMark(job: Rebuild, mark: DirtyRow): Promise<D1PreparedStatement[]> {
  const { ctx, deviceId } = job;
  try {
    return [...(await rebuildMark(job, mark)), clearStatement(ctx, deviceId, mark)];
  } catch (error) {
    const errorCode = permanentStoreCode(error);
    if (errorCode === null) throw error;
    ctx.log.error("hc.mark_parked", { deviceId, kind: mark.kind, errorCode });
    return parkMarkStatements(ctx, deviceId, mark);
  }
}

/**
 * Park the mark the rebuild would take next. For the caller that counts
 * attempts (worker/src/hc/apply.ts): when slices keep dying with nothing
 * queued, the mark at the head of the list is what they die on. False when
 * there is no mark to park.
 */
export async function parkFirstMark(
  ctx: Ctx,
  deviceId: string,
  errorCode: string,
): Promise<boolean> {
  const [page] = await nextDirty(ctx, deviceId, 1);
  const mark = page?.[0];
  if (mark === undefined) return false;
  await batch(ctx.db, parkMarkStatements(ctx, deviceId, mark));
  ctx.log.error("hc.mark_parked", { deviceId, kind: mark.kind, errorCode });
  return true;
}

/**
 * Settle the marks of one page, in order. False when the budget ran out.
 *
 * A page is all of one kind (`nextDirty`), and a page of `day` marks is
 * settled in runs rather than mark by mark.
 */
async function settlePage(job: Rebuild, marks: readonly DirtyRow[]): Promise<boolean> {
  if (marks[0]?.kind === "day") return settleDays(job, marks);
  for (const mark of marks) {
    if (!job.meter.mayStart(MARK_COST)) return false;
    await commit(job, await settleMark(job, mark));
    job.meter.done();
  }
  return true;
}

export interface RebuildResult {
  /** The zone digest every day rollup is now known to carry, or null: see `HcRunnerState`. */
  tzDigest: string | null;
  more: boolean;
}

/**
 * What one slice of the runner has already read and need not read again. A
 * slice runs the rebuild after every batch it applies, and the configured zone
 * is the same each time: it is the owner's setting, and a slice is seconds.
 *
 * It lives no longer than the slice. The zone can be changed at any time, and
 * the next slice -- the next alarm -- reads it afresh.
 */
export interface SliceMemo {
  zone?: string;
}

/** The configured zone: read once for a slice that carries a memo, every time otherwise. */
async function zoneFor(ctx: Ctx, meter: Meter, memo: SliceMemo | undefined): Promise<string> {
  if (memo?.zone !== undefined) return memo.zone;
  meter.spend();
  const zone = await getTimezone(ctx);
  if (memo !== undefined) memo.zone = zone;
  return zone;
}

/**
 * One budgeted pass over a device's rebuild work. `knownDigest` is what the
 * caller remembers from the last pass; when it is the current zone's digest
 * the check for rows of another zone is skipped.
 */
export async function rebuildSlice(
  ctx: Ctx,
  deviceId: string,
  knownDigest: string | null,
  meter: Meter,
  memo?: SliceMemo,
): Promise<RebuildResult> {
  const zone = await zoneFor(ctx, meter, memo);
  const job: Rebuild = { ctx, deviceId, zone, digest: await tzDigest(ctx, zone), meter };

  if (knownDigest !== job.digest && !(await rezone(job))) return { tzDigest: null, more: true };

  for (;;) {
    const pages = await nextDirty(ctx, deviceId, DIRTY_PAGE, meter);
    const left = await settlePages(job, pages);
    if (left !== "unknown") return { tzDigest: job.digest, more: left === "some" };
  }
}

/**
 * Settle the pages `nextDirty` returned, in order. Says what is left of the
 * list afterwards: `"some"` when the budget ran out, `"none"` when the list is
 * known to be empty, and `"unknown"` when it has to be read again.
 */
async function settlePages(
  job: Rebuild,
  pages: readonly DirtyRow[][],
): Promise<"some" | "none" | "unknown"> {
  for (const marks of pages) {
    if (!(await settlePage(job, marks))) return "some";
    // A full page: this kind may have more, and they come before any mark of
    // the kinds after it. Ask again rather than go on to those.
    if (marks.length >= DIRTY_PAGE) return "unknown";
  }
  // Every page was the whole of its kind, and settling a mark writes no mark:
  // the list is empty, and there is no need to ask D1 to say so.
  return "none";
}
