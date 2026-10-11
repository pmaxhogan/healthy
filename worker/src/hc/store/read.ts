/**
 * Reading the Health Connect store back: what the MCP tools and the rebuild
 * phase call. Nothing here writes.
 *
 * Every reader takes a half-open window `[startMs, endMs)` in epoch
 * milliseconds and returns everything in it. There is no limit anywhere: a
 * caller that wants fewer rows asks for a narrower window or a coarser table
 * (hour and day rollups exist so that a year is a few hundred rows). Large
 * raw reads are fetched from D1 a page at a time, but all of it is returned.
 *
 * Origins are package names to a caller and blinds in the database. A reader
 * that takes `origins` blinds them on the way in; one that returns rows of a
 * table without a payload naming the app (the rollups) resolves the blind
 * back through `listOrigins`, which opens one chunk per origin.
 */

import { blindHcOrigin, blinderFor } from "../../db/blind.ts";
import { all, one } from "../../db/client.ts";
import { getTimezone } from "../../db/settings.ts";
import { hrHourToPoints } from "../rollup/hr.ts";
import { recordStartMs } from "../wire.ts";

import { CHUNK_COLUMNS, assembleChunks, hrMinuteAad, readChunks } from "./chunks.ts";
import { PARKED_PREFIX } from "./dirty.ts";
import { HOUR_MS, TYPE_HEART_RATE, compareText, hourOf, overlapsWindow, sortedBy } from "./keys.ts";
import { openJson, payloadAad } from "./sealed.ts";

import type { ChunkRow } from "./chunks.ts";
import type { Ctx } from "../../db/client.ts";
import type { HrMinutePoint } from "../rollup/hr.ts";
import type {
  BucketRollup,
  ExerciseSummary,
  HrHour,
  HrMinute,
  SleepNight,
} from "../rollup/types.ts";
import type { HcRecord } from "../wire.ts";

export interface RecordWindow {
  deviceId: string;
  type: string;
  /** Inclusive, epoch ms. */
  startMs: number;
  /** Exclusive, epoch ms. */
  endMs: number;
  /** Package names. Omitted: every origin. */
  origins?: readonly string[] | undefined;
}

export interface OriginRef {
  /** The origin app's package name. */
  origin: string;
  originHash: string;
}

export interface HourRollupRow {
  hourUtc: number;
  origin: string;
  rollup: BucketRollup;
}

export interface DayRollupRow {
  /** `YYYY-MM-DD` in the configured zone. */
  day: string;
  origin: string;
  rollup: BucketRollup;
}

export interface HrMinuteRow {
  hourUtc: number;
  origin: string;
  minutes: HrMinute[];
}

export interface StoredSleepNight {
  /** The session's blinded record id: stable, and names nothing. */
  id: string;
  night: SleepNight;
}

export interface StoredExerciseSession {
  id: string;
  session: ExerciseSummary;
}

/** Chunk rows fetched per query: each carries a payload. */
const CHUNK_PAGE = 200;

/** The keyed digest of a zone name that `hc_rollup_day.tz_digest` holds. */
export function tzDigest(ctx: Pick<Ctx, "env">, timeZone: string): Promise<string> {
  return blinderFor(ctx.env).digest("hc_rollup_day.tz_digest", timeZone);
}

/** The first hour that does not start before `endMs`. */
const endHourOf = (endMs: number): number => Math.ceil(endMs / HOUR_MS);

async function originHashes(
  ctx: Ctx,
  deviceId: string,
  origins: readonly string[] | undefined,
): Promise<string[] | null> {
  if (origins === undefined) return null;
  const blinder = blinderFor(ctx.env);
  return Promise.all(origins.map((origin) => blindHcOrigin(blinder, deviceId, origin)));
}

/** ` AND origin_hash IN (...)`, or nothing, with its bound value. */
function originClause(hashes: readonly string[] | null): { sql: string; values: string[] } {
  return hashes === null
    ? { sql: "", values: [] }
    : {
        sql: " AND origin_hash IN (SELECT value FROM json_each(?))",
        values: [JSON.stringify(hashes)],
      };
}

/**
 * Every chunk row one of the two scans matches, in key order, a page at a time.
 */
/** The two reads `readRecords` makes: which rows, and through which index. */
export const WINDOW_SCAN = {
  from: "hc_chunks",
  where: " AND hour_utc >= ? AND hour_utc < ?",
} as const;
/**
 * The second comparison repeats what the first implies, on purpose: it is the
 * predicate of the partial index `hc_chunks_spill` ("this chunk runs past its
 * own hour"). `INDEXED BY` makes that small index the plan; left to choose, the
 * planner walks `hc_chunks_range` through every earlier chunk of the type.
 */
export const SPILL_SCAN = {
  from: "hc_chunks INDEXED BY hc_chunks_spill",
  where: ` AND hour_utc < ? AND max_end_ms >= ? AND max_end_ms >= (hour_utc + 1) * ${String(HOUR_MS)}`,
} as const;

/** The statement one page of a chunk scan runs. Exported so its plan can be asserted. */
export function chunkScanSql(scan: { from: string; where: string }, extra = ""): string {
  return `SELECT ${CHUNK_COLUMNS} FROM ${scan.from}
            WHERE device_id = ? AND record_type = ?${scan.where}${extra}
            ORDER BY hour_utc, origin_hash, part LIMIT ?`;
}

async function scanChunks(
  ctx: Ctx,
  deviceId: string,
  type: string,
  scan: { from: string; where: string },
  origin: { sql: string; values: string[] },
  values: readonly (string | number)[],
): Promise<ChunkRow[]> {
  const rows: ChunkRow[] = [];
  let after: { hour: number; origin: string; part: number } | null = null;
  for (;;) {
    const keyset: string = after === null ? "" : " AND (hour_utc, origin_hash, part) > (?, ?, ?)";
    const page: ChunkRow[] = await all<ChunkRow>(
      ctx.db
        .prepare(chunkScanSql(scan, `${origin.sql}${keyset}`))
        .bind(
          deviceId,
          type,
          ...values,
          ...origin.values,
          ...(after === null ? [] : [after.hour, after.origin, after.part]),
          CHUNK_PAGE,
        ),
    );
    rows.push(...page);
    const last = page.at(-1);
    if (last === undefined || page.length < CHUNK_PAGE) return rows;
    after = { hour: last.hour_utc, origin: last.origin_hash, part: last.part };
  }
}

/**
 * Every record of one type with anything in the window, by start time.
 *
 * A record lives in the chunk of its start hour however long it runs, so the
 * window is read in two parts: the chunks whose hour is in it, and the earlier
 * chunks whose `max_end_ms` reaches into it (a night of sleep that began the
 * evening before). Only overlapping chunks are opened.
 */
export async function readRecords(ctx: Ctx, window: RecordWindow): Promise<HcRecord[]> {
  const { deviceId, type, startMs, endMs } = window;
  if (endMs <= startMs) return [];
  const origin = originClause(await originHashes(ctx, deviceId, window.origins));
  const startHour = hourOf(startMs);

  const inWindow = await scanChunks(ctx, deviceId, type, WINDOW_SCAN, origin, [
    startHour,
    endHourOf(endMs),
  ]);
  const spilling = await scanChunks(ctx, deviceId, type, SPILL_SCAN, origin, [startHour, startMs]);

  // Both scans return every row of each chunk they match, so a chunk that
  // outgrew one row is whole here (worker/src/hc/store/chunks.ts).
  const chunks = await assembleChunks(ctx, deviceId, [...spilling, ...inWindow]);
  const records = chunks.flatMap((stored) =>
    stored.records.filter((record) => overlapsWindow(record, startMs, endMs)),
  );
  return sortedBy(records, (left, right) => recordStartMs(left) - recordStartMs(right));
}

/**
 * The origin apps that have written records of one type, with their package
 * names -- which exist only inside sealed payloads, so one chunk per origin is
 * opened to read them.
 */
export async function listOrigins(ctx: Ctx, deviceId: string, type: string): Promise<OriginRef[]> {
  // Part 0 only: a chunk's continuation rows are not more chunks.
  const firsts = await all<{ origin_hash: string; hour_utc: number }>(
    ctx.db
      .prepare(
        `SELECT origin_hash, min(hour_utc) AS hour_utc FROM hc_chunks
          WHERE device_id = ? AND record_type = ? AND part = 0
          GROUP BY origin_hash`,
      )
      .bind(deviceId, type),
  );
  const keys = firsts.map((row) => ({ type, originHash: row.origin_hash, hourUtc: row.hour_utc }));
  const chunks = await readChunks(ctx, deviceId, keys);
  const origins: OriginRef[] = Array.from(chunks.values(), (stored) => ({
    origin: stored.origin,
    originHash: stored.key.originHash,
  }));
  return sortedBy(origins, (left, right) => compareText(left.origin, right.origin));
}

/** Every record type a device has records of. */
export async function listTypes(ctx: Ctx, deviceId: string): Promise<string[]> {
  const rows = await all<{ record_type: string }>(
    ctx.db
      .prepare(
        "SELECT DISTINCT record_type FROM hc_chunks WHERE device_id = ? ORDER BY record_type",
      )
      .bind(deviceId),
  );
  return rows.map((row) => row.record_type);
}

async function originNames(ctx: Ctx, deviceId: string, type: string): Promise<Map<string, string>> {
  const refs = await listOrigins(ctx, deviceId, type);
  return new Map(refs.map((ref) => [ref.originHash, ref.origin]));
}

interface RollupRow {
  origin_hash: string;
  bucket: number | string;
  payload_enc: string;
}

/** The hour rollups of one type whose UTC hour starts in the window. */
export async function readHourRollups(ctx: Ctx, window: RecordWindow): Promise<HourRollupRow[]> {
  const { deviceId, type } = window;
  const origin = originClause(await originHashes(ctx, deviceId, window.origins));
  const rows = await all<RollupRow>(
    ctx.db
      .prepare(
        `SELECT origin_hash, hour_utc AS bucket, payload_enc FROM hc_rollup_hour
          WHERE device_id = ? AND record_type = ? AND hour_utc >= ? AND hour_utc < ?${origin.sql}
          ORDER BY hour_utc, origin_hash`,
      )
      .bind(
        deviceId,
        type,
        Math.ceil(window.startMs / HOUR_MS),
        endHourOf(window.endMs),
        ...origin.values,
      ),
  );
  if (rows.length === 0) return [];
  const names = await originNames(ctx, deviceId, type);
  return Promise.all(
    rows.map(async (row) => ({
      hourUtc: Number(row.bucket),
      origin: names.get(row.origin_hash) ?? "",
      rollup: (await openJson(
        ctx,
        row.payload_enc,
        payloadAad("hc_rollup_hour", deviceId, type, row.origin_hash, row.bucket),
      )) as BucketRollup,
    })),
  );
}

export interface DayWindow {
  deviceId: string;
  type: string;
  /** Inclusive, `YYYY-MM-DD`. */
  startDay: string;
  /** Inclusive, `YYYY-MM-DD`. */
  endDay: string;
  origins?: readonly string[] | undefined;
}

/**
 * The day rollups of one type for the days asked for, in the configured zone.
 *
 * Only rows built for the zone now configured are returned. After the
 * `timezone` setting changes, every day is rebuilt; until the runner has got
 * to a day it is absent here rather than answered for the old zone, and
 * `storeBacklog` says there is still work outstanding.
 */
export async function readDayRollups(ctx: Ctx, window: DayWindow): Promise<DayRollupRow[]> {
  const { deviceId, type } = window;
  const origin = originClause(await originHashes(ctx, deviceId, window.origins));
  const digest = await tzDigest(ctx, await getTimezone(ctx));
  const rows = await all<RollupRow>(
    ctx.db
      .prepare(
        `SELECT origin_hash, day AS bucket, payload_enc FROM hc_rollup_day
          WHERE device_id = ? AND record_type = ? AND day >= ? AND day <= ? AND tz_digest = ?${origin.sql}
          ORDER BY day, origin_hash`,
      )
      .bind(deviceId, type, window.startDay, window.endDay, digest, ...origin.values),
  );
  if (rows.length === 0) return [];
  const names = await originNames(ctx, deviceId, type);
  return Promise.all(
    rows.map(async (row) => ({
      day: String(row.bucket),
      origin: names.get(row.origin_hash) ?? "",
      rollup: (await openJson(
        ctx,
        row.payload_enc,
        payloadAad("hc_rollup_day", deviceId, type, row.origin_hash, row.bucket),
      )) as BucketRollup,
    })),
  );
}

interface HrRow {
  origin_hash: string;
  hour_utc: number;
  payload_enc: string;
}

/** The per-minute heart-rate rows of the hours `[startHour, endHour)`, by blinded origin. */
async function hrHours(
  ctx: Ctx,
  deviceId: string,
  startHour: number,
  endHour: number,
  origin: { sql: string; values: string[] },
): Promise<{ hourUtc: number; originHash: string; hour: HrHour }[]> {
  const rows = await all<HrRow>(
    ctx.db
      .prepare(
        `SELECT origin_hash, hour_utc, payload_enc FROM hc_hr_minute
          WHERE device_id = ? AND hour_utc >= ? AND hour_utc < ?${origin.sql}
          ORDER BY hour_utc, origin_hash`,
      )
      .bind(deviceId, startHour, endHour, ...origin.values),
  );
  return Promise.all(
    rows.map(async (row) => ({
      hourUtc: row.hour_utc,
      originHash: row.origin_hash,
      hour: (await openJson(
        ctx,
        row.payload_enc,
        hrMinuteAad(deviceId, row.origin_hash, row.hour_utc),
      )) as HrHour,
    })),
  );
}

/**
 * Heart rate at one-minute resolution: the rows of every UTC hour the window
 * touches, whole. A caller that wants only the window's own minutes filters
 * on `hourUtc * 3_600_000 + m * 60_000`.
 */
export async function readHrMinutes(
  ctx: Ctx,
  window: Omit<RecordWindow, "type">,
): Promise<HrMinuteRow[]> {
  const { deviceId } = window;
  if (window.endMs <= window.startMs) return [];
  const origin = originClause(await originHashes(ctx, deviceId, window.origins));
  const rows = await hrHours(
    ctx,
    deviceId,
    hourOf(window.startMs),
    endHourOf(window.endMs),
    origin,
  );
  if (rows.length === 0) return [];
  const names = await originNames(ctx, deviceId, TYPE_HEART_RATE);
  return rows.map((row) => ({
    hourUtc: row.hourUtc,
    origin: names.get(row.originHash) ?? "",
    minutes: row.hour.minutes,
  }));
}

/**
 * One heart-rate reading per minute in `[startMs, endMs]`, for joining to a
 * night or a session: the minute means of the session's own origin when it
 * measured heart rate there, and of every origin otherwise. Mixing a watch's
 * minutes with a second device's would count the overlap twice.
 */
export async function readHrPoints(
  ctx: Ctx,
  deviceId: string,
  startMs: number,
  endMs: number,
  preferOriginHash: string,
): Promise<{ t: number; bpm: number }[]> {
  const rows = await hrHours(ctx, deviceId, hourOf(startMs), hourOf(endMs) + 1, {
    sql: "",
    values: [],
  });
  const own = rows.filter((row) => row.originHash === preferOriginHash);
  const points: HrMinutePoint[] = (own.length > 0 ? own : rows).flatMap((row) =>
    hrHourToPoints(row.hourUtc, row.hour),
  );
  const inWindow = points
    .filter((point) => point.t >= startMs && point.t <= endMs)
    .map((point) => ({ t: point.t, bpm: point.mean }));
  return sortedBy(inWindow, (left, right) => left.t - right.t);
}

interface SessionRow {
  record_id_blind: string;
  payload_enc: string;
}

async function sessionRows(
  ctx: Ctx,
  table: "hc_sleep_night" | "hc_exercise_session",
  window: Omit<RecordWindow, "type" | "origins">,
): Promise<{ id: string; payload: unknown }[]> {
  const rows = await all<SessionRow>(
    ctx.db
      .prepare(
        `SELECT record_id_blind, payload_enc FROM ${table}
          WHERE device_id = ? AND start_ms < ? AND end_ms >= ?
          ORDER BY start_ms, record_id_blind`,
      )
      .bind(window.deviceId, window.endMs, window.startMs),
  );
  return Promise.all(
    rows.map(async (row) => ({
      id: row.record_id_blind,
      payload: await openJson(
        ctx,
        row.payload_enc,
        payloadAad(table, window.deviceId, row.record_id_blind),
      ),
    })),
  );
}

/** Every sleep night with anything in the window, by start. */
export async function readSleepNights(
  ctx: Ctx,
  window: Omit<RecordWindow, "type" | "origins">,
): Promise<StoredSleepNight[]> {
  const rows = await sessionRows(ctx, "hc_sleep_night", window);
  return rows.map((row) => ({ id: row.id, night: row.payload as SleepNight }));
}

/** Every exercise session with anything in the window, by start. */
export async function readExerciseSessions(
  ctx: Ctx,
  window: Omit<RecordWindow, "type" | "origins">,
): Promise<StoredExerciseSession[]> {
  const rows = await sessionRows(ctx, "hc_exercise_session", window);
  return rows.map((row) => ({ id: row.id, session: row.payload as ExerciseSummary }));
}

export interface StoreBacklog {
  /** Batches accepted and waiting to be applied. */
  queuedBatches: number;
  /**
   * Batches that could not be applied and are set aside, body kept. Their
   * records are not in the store, so a non-zero count means data is missing
   * until they are queued again.
   */
  parkedBatches: number;
  /** Rollups and summaries marked for rebuilding and not yet rebuilt. */
  dirty: number;
  /**
   * Marks set aside because what they have to be rebuilt from will not open.
   * Their rollup or summary is missing or out of date until that is fixed.
   */
  parkedMarks: number;
  /**
   * True when day rollups built for another zone are still there: the
   * `timezone` setting changed and the runner has not been round yet, so
   * `readDayRollups` is answering with fewer days than there are.
   */
  rezonePending: boolean;
}

/**
 * What a device still has outstanding. Anything non-zero or true means an
 * answer from the rollups or the summaries may not include everything yet.
 */
export async function storeBacklog(ctx: Ctx, deviceId: string): Promise<StoreBacklog> {
  const digest = await tzDigest(ctx, await getTimezone(ctx));
  const row = await one<{
    batches: number;
    parked: number;
    dirty: number;
    parkedMarks: number;
    rezone: number;
  }>(
    ctx.db
      .prepare(
        `SELECT (SELECT count(DISTINCT batch_id) FROM hc_ingest_queue
                  WHERE device_id = ?1 AND parked_at IS NULL) AS batches,
                (SELECT count(DISTINCT batch_id) FROM hc_ingest_queue
                  WHERE device_id = ?1 AND parked_at IS NOT NULL) AS parked,
                (SELECT count(*) FROM hc_dirty
                  WHERE device_id = ?1 AND (kind < ?3 OR kind >= ?4)) AS dirty,
                (SELECT count(*) FROM hc_dirty
                  WHERE device_id = ?1 AND kind >= ?3 AND kind < ?4) AS parkedMarks,
                EXISTS (SELECT 1 FROM hc_rollup_day WHERE device_id = ?1 AND tz_digest != ?2) AS rezone`,
      )
      .bind(deviceId, digest, PARKED_PREFIX, `${PARKED_PREFIX}~`),
  );
  return {
    queuedBatches: row?.batches ?? 0,
    parkedBatches: row?.parked ?? 0,
    dirty: row?.dirty ?? 0,
    parkedMarks: row?.parkedMarks ?? 0,
    rezonePending: row?.rezone === 1,
  };
}
