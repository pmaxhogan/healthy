// What a deploy that changes what a rollup holds does to the rollups already
// stored: every day rollup is rebuilt, the hour rollups of the running counts
// are written afresh from their chunks on the way, and every sleep night and
// exercise session is summarised again -- with no step run by hand, in
// budgeted slices, and to the same store however the slices fall.
//
// The store "of an earlier making" is made here by taking a store this code
// built and rewriting it as the earlier code would have left it: hour rollups
// without `hours` or `crossing`, day rollups under another digest.
//
// Every record is synthetic: see helpers.ts.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { makeRepos } from "../../../src/db/index.ts";
import { HOUR_MS } from "../../../src/hc/store/keys.ts";
import { readDayRollups, readHourRollups, storeBacklog } from "../../../src/hc/store/read.ts";
import { openJson, payloadAad, sealJson } from "../../../src/hc/store/sealed.ts";
import { recordingLog } from "../db/helpers.ts";

import {
  drain,
  enqueue,
  heartRate,
  interval,
  MINUTE_MS,
  PHONE,
  resetHc,
  seedDevice,
  steps,
  testCtx,
} from "./helpers.ts";

import type { BucketRollup } from "../../../src/hc/rollup/types.ts";
import type { SliceBudget } from "../../../src/hc/store/budget.ts";
import type { HcRecord } from "../../../src/hc/wire.ts";

beforeEach(resetHc);

const log = recordingLog();
const ctx = testCtx({ log: log.log });

/** The lines logged since the list was last emptied, parsed. */
const logged = (): { event: string; statements?: number }[] =>
  log.lines.map((line) => JSON.parse(line) as { event: string; statements?: number });
const repos = makeRepos(ctx);

const TIMEOUT = 60_000;
const DAY_MS = 24 * HOUR_MS;
/** 2026-01-10T00:00Z. With no zone configured, days are UTC days. */
const D0 = Date.UTC(2026, 0, 10);
const DAYS = 12;
const TIGHT: SliceBudget = { maxQueries: 70, maxMs: 20_000 };

/**
 * Twelve days: steps from a wearable every third hour, steps from a phone on
 * some days, heart rate once a day -- and, each day, one record of energy for
 * the whole day, and a walk that runs past midnight.
 */
function history(): HcRecord[] {
  const records: HcRecord[] = [];
  for (let day = 0; day < DAYS; day += 1) {
    const start = D0 + day * DAY_MS;
    for (let hour = 0; hour < 24; hour += 3) {
      records.push(steps(`w-${String(day)}-${String(hour)}`, start + hour * HOUR_MS, 100));
    }
    if (day % 3 === 0) {
      records.push(steps(`p-${String(day)}`, start + 9 * HOUR_MS, 40, { origin: PHONE }));
    }
    records.push(
      heartRate(`hr-${String(day)}`, start + 8 * HOUR_MS, [
        [0, 60],
        [MINUTE_MS, 62],
      ]),
      interval(`kcal-${String(day)}`, "TotalCaloriesBurned", start, start + DAY_MS, {
        energy: 1680,
      }),
      interval(`late-${String(day)}`, "Steps", start + 23.5 * HOUR_MS, start + 24.5 * HOUR_MS, {
        count: 600,
      }),
    );
  }
  // A night with its heart rate, and a workout nobody stopped: the summaries.
  const bedtime = D0 + 22 * HOUR_MS;
  const overnight: [number, number][] = [];
  for (let minute = 0; minute < 8 * 60; minute += 5) overnight.push([minute * MINUTE_MS, 52]);
  records.push(
    interval("night", "SleepSession", bedtime, bedtime + 8 * HOUR_MS, {}),
    heartRate("hr-night", bedtime, overnight),
    interval(
      "forgotten",
      "ExerciseSession",
      D0 + 2 * DAY_MS + 10 * HOUR_MS,
      D0 + 2 * DAY_MS + 14 * HOUR_MS,
      {
        exerciseType: "YOGA",
      },
    ),
  );
  return records;
}

interface SummaryRow {
  record_id_blind: string;
  payload_enc: string;
}

const SUMMARY_TABLES = ["hc_sleep_night", "hc_exercise_session"] as const;

/** Every stored night and session summary, opened, by table and key. */
async function summaries(deviceId: string): Promise<Record<string, Record<string, unknown>>> {
  const out: [string, Record<string, unknown>][] = [];
  for (const table of SUMMARY_TABLES) {
    const { results } = await env.DB.prepare(
      `SELECT record_id_blind, payload_enc FROM ${table} WHERE device_id = ? ORDER BY record_id_blind`,
    )
      .bind(deviceId)
      .all<SummaryRow>();
    for (const row of results) {
      const aad = payloadAad(table, deviceId, row.record_id_blind);
      out.push([
        `${table}|${row.record_id_blind}`,
        (await openJson(ctx, row.payload_enc, aad)) as Record<string, unknown>,
      ]);
    }
  }
  return Object.fromEntries(out);
}

/** Rewrite the summaries as code that knew nothing of the newer fields left them. */
async function downgradeSummaries(deviceId: string): Promise<void> {
  const current = await summaries(deviceId);
  const statements: D1PreparedStatement[] = [];
  const newer = new Set(["hrFirstRiseMs", "leftRunningReason", "energyOrigin"]);
  for (const [key, summary] of Object.entries(current)) {
    const [table = "", blind = ""] = key.split("|", 2);
    const kept = Object.entries(summary).filter(([name]) => !newer.has(name));
    const old = Object.fromEntries(kept);
    const sealed = await sealJson(ctx, old, payloadAad(table, deviceId, blind));
    statements.push(
      env.DB.prepare(
        `UPDATE ${table} SET payload_enc = ? WHERE device_id = ? AND record_id_blind = ?`,
      ).bind(sealed, deviceId, blind),
    );
  }
  await env.DB.batch(statements);
}

interface RollupRow {
  record_type: string;
  origin_hash: string;
  bucket: number | string;
  payload_enc: string;
}

/** Every hour rollup the device holds, opened. */
async function hourRollups(deviceId: string): Promise<{ row: RollupRow; rollup: BucketRollup }[]> {
  const { results } = await env.DB.prepare(
    `SELECT record_type, origin_hash, hour_utc AS bucket, payload_enc FROM hc_rollup_hour
      WHERE device_id = ? ORDER BY record_type, origin_hash, hour_utc`,
  )
    .bind(deviceId)
    .all<RollupRow>();
  return Promise.all(
    results.map(async (row) => ({
      row,
      rollup: (await openJson(
        ctx,
        row.payload_enc,
        payloadAad("hc_rollup_hour", deviceId, row.record_type, row.origin_hash, row.bucket),
      )) as BucketRollup,
    })),
  );
}

/** Every day rollup the device holds, opened, by `type|origin|day`. */
async function dayRollups(deviceId: string): Promise<Record<string, BucketRollup>> {
  const { results } = await env.DB.prepare(
    `SELECT record_type, origin_hash, day AS bucket, payload_enc FROM hc_rollup_day
      WHERE device_id = ? ORDER BY record_type, origin_hash, day`,
  )
    .bind(deviceId)
    .all<RollupRow>();
  const out: [string, BucketRollup][] = [];
  for (const row of results) {
    const aad = payloadAad("hc_rollup_day", deviceId, row.record_type, row.origin_hash, row.bucket);
    out.push([
      `${row.record_type}|${row.origin_hash}|${String(row.bucket)}`,
      (await openJson(ctx, row.payload_enc, aad)) as BucketRollup,
    ]);
  }
  return Object.fromEntries(out);
}

/** Rewrite the device's rollups as the code before this revision left them. */
async function downgrade(deviceId: string): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  const current = await hourRollups(deviceId);
  for (const { row, rollup } of current) {
    const { records, fields, durationMs } = rollup;
    const old = { records, fields, ...(durationMs !== undefined && { durationMs }) };
    const aad = payloadAad(
      "hc_rollup_hour",
      deviceId,
      row.record_type,
      row.origin_hash,
      row.bucket,
    );
    statements.push(
      env.DB.prepare(
        `UPDATE hc_rollup_hour SET payload_enc = ?
          WHERE device_id = ? AND record_type = ? AND origin_hash = ? AND hour_utc = ?`,
      ).bind(await sealJson(ctx, old, aad), deviceId, row.record_type, row.origin_hash, row.bucket),
    );
  }
  statements.push(
    env.DB.prepare("UPDATE hc_rollup_day SET tz_digest = 'earlier' WHERE device_id = ?").bind(
      deviceId,
    ),
  );
  await env.DB.batch(statements);
}

async function build(deviceId: string): Promise<void> {
  await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: history() });
  await drain(ctx, deviceId);
}

const ofType = (
  rows: readonly { row: RollupRow; rollup: BucketRollup }[],
  type: string,
): BucketRollup[] => rows.filter(({ row }) => row.record_type === type).map(({ rollup }) => rollup);

describe("rollups of an earlier making", () => {
  it(
    "are found by the store itself, and say so until they are rebuilt",
    async () => {
      const deviceId = await seedDevice(repos);
      await build(deviceId);
      expect(await storeBacklog(ctx, deviceId)).toMatchObject({ dirty: 0, rezonePending: false });

      await downgrade(deviceId);

      // The earlier rows are not served as current ones.
      expect(await storeBacklog(ctx, deviceId)).toMatchObject({ rezonePending: true });
      expect(
        await readDayRollups(ctx, {
          deviceId,
          type: "Steps",
          startDay: "2026-01-01",
          endDay: "2026-01-31",
        }),
      ).toStrictEqual([]);
    },
    TIMEOUT,
  );

  it(
    "are rebuilt to what this code builds, by a runner that was only woken",
    async () => {
      const deviceId = await seedDevice(repos);
      await build(deviceId);
      const builtHours = await hourRollups(deviceId);
      const builtDays = await dayRollups(deviceId);
      const builtSummaries = await summaries(deviceId);
      await downgrade(deviceId);
      await downgradeSummaries(deviceId);
      expect(await summaries(deviceId)).not.toStrictEqual(builtSummaries);
      log.lines.length = 0;

      // Nothing is queued and nothing is marked: the slice finds the work.
      const { slices } = await drain(ctx, deviceId);

      // The night and the session were summarised again, with the newer fields.
      const rebuilt = await summaries(deviceId);
      expect(rebuilt).toStrictEqual(builtSummaries);
      const night = expect.objectContaining({ hrFirstRiseMs: null }) as unknown;
      const session = expect.objectContaining({
        likelyLeftRunning: true,
        leftRunningReason: "resting_tail",
      }) as unknown;
      expect(Object.values(rebuilt)).toStrictEqual(expect.arrayContaining([night, session]));
      expect(await storeBacklog(ctx, deviceId)).toStrictEqual({
        queuedBatches: 0,
        parkedBatches: 0,
        dirty: 0,
        parkedMarks: 0,
        rezonePending: false,
      });
      expect(await dayRollups(deviceId)).toStrictEqual(builtDays);
      const hours = await hourRollups(deviceId);
      // The running counts' hours were written afresh from their chunks ...
      expect(ofType(hours, "Steps")).toStrictEqual(ofType(builtHours, "Steps"));
      expect(ofType(hours, "TotalCaloriesBurned")).toStrictEqual(
        ofType(builtHours, "TotalCaloriesBurned"),
      );
      expect(ofType(hours, "Steps").every((rollup) => rollup.hours !== undefined)).toBe(true);
      expect(ofType(hours, "Steps").filter((rollup) => rollup.crossing !== undefined)).toHaveLength(
        DAYS,
      );
      // ... and nothing else's: a heart-rate hour needs nothing its row does not say.
      expect(ofType(hours, "HeartRate").every((rollup) => rollup.hours === undefined)).toBe(true);
      expect(slices).toBeGreaterThanOrEqual(1);
      const events = logged().map((entry) => entry.event);
      expect(events).toContain("hc.rezoned");
      expect(events).toContain("hc.rollup_rerolled");
    },
    TIMEOUT,
  );

  it(
    "are rebuilt to the same store in many small slices, each inside its budget",
    async () => {
      const deviceId = await seedDevice(repos);
      await build(deviceId);
      const builtHours = await hourRollups(deviceId);
      const builtDays = await dayRollups(deviceId);
      const builtSummaries = await summaries(deviceId);
      await downgrade(deviceId);
      await downgradeSummaries(deviceId);
      log.lines.length = 0;

      const { slices } = await drain(ctx, deviceId, { budget: TIGHT });
      expect(await summaries(deviceId)).toStrictEqual(builtSummaries);

      expect(slices).toBeGreaterThan(3);
      expect(await dayRollups(deviceId)).toStrictEqual(builtDays);
      const hours = await hourRollups(deviceId);
      expect(ofType(hours, "Steps")).toStrictEqual(ofType(builtHours, "Steps"));
      expect(await storeBacklog(ctx, deviceId)).toMatchObject({ dirty: 0 });
      // A slice may run over by the unit it was in, and by no more than one
      // day's worth of hour rollups.
      const spent = logged()
        .filter((entry) => entry.event === "hc.slice")
        .map((entry) => entry.statements ?? 0);
      expect(Math.max(...spent)).toBeLessThan(TIGHT.maxQueries + 160);
    },
    TIMEOUT,
  );

  it(
    "keep what a day needs of a record that runs past it, and what a long one is",
    async () => {
      const deviceId = await seedDevice(repos);
      await build(deviceId);
      await downgrade(deviceId);
      await drain(ctx, deviceId);

      const stepDays = await readDayRollups(ctx, {
        deviceId,
        type: "Steps",
        startDay: "2026-01-10",
        endDay: "2026-01-10",
        origins: ["com.example.wearable"],
      });
      const energyDays = await readDayRollups(ctx, {
        deviceId,
        type: "TotalCaloriesBurned",
        startDay: "2026-01-10",
        endDay: "2026-01-10",
      });
      const stepHours = await readHourRollups(ctx, {
        deviceId,
        type: "Steps",
        startMs: D0,
        endMs: D0 + DAY_MS,
      });

      // The walk past midnight, whole, on the day it starts -- and listed.
      expect(stepDays[0]?.rollup).toMatchObject({
        records: 9,
        crossing: [{ s: D0 + 23.5 * HOUR_MS, e: D0 + 24.5 * HOUR_MS, v: { count: 600 } }],
      });
      expect(stepDays[0]?.rollup.hours).toStrictEqual(
        [0, 3, 6, 9, 12, 15, 18, 21, 23].map((hour) => D0 / HOUR_MS + hour),
      );
      // The day-long record does not run past its day, but it is long.
      expect(energyDays[0]?.rollup.crossing).toStrictEqual([
        { s: D0, e: D0 + DAY_MS, v: { energy: 1680 } },
      ]);
      expect(stepHours.at(-1)?.rollup.crossing).toHaveLength(1);
    },
    TIMEOUT,
  );
});
