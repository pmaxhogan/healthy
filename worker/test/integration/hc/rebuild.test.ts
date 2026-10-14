// The rebuild phase: day rollups in the configured zone, sleep nights and
// exercise sessions, all drained from `hc_dirty` once the queue is empty.
//
// The zones below are parameters of the tests and nothing else: no zone is
// named anywhere in the Worker's source. They are chosen for their arithmetic
// (a fixed offset, a daylight-saving change, an offset that is not a whole
// number of hours), and none of them is anyone's.
//
// Every record is synthetic: see helpers.ts.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { makeRepos } from "../../../src/db/index.ts";
import { setSetting } from "../../../src/db/settings.ts";
import { rebuildAllowance, rebuildShare, runHcSlice } from "../../../src/hc/apply.ts";
import { dayBoundsMs } from "../../../src/hc/rollup/day.ts";
import { unparkMarks } from "../../../src/hc/store/dirty.ts";
import { HOUR_MS, dayMarkKey } from "../../../src/hc/store/keys.ts";
import {
  readDayRollups,
  readRecords,
  readExerciseSessions,
  readSleepNights,
  storeBacklog,
} from "../../../src/hc/store/read.ts";
import { clock, recordingLog } from "../db/helpers.ts";

import {
  count,
  drain,
  enqueue,
  heartRate,
  instant,
  interval,
  logRow,
  MINUTE_MS,
  PHONE,
  resetHc,
  seedDevice,
  steps,
  T,
  testCtx,
  WEARABLE,
} from "./helpers.ts";

import type { HcRunnerState, HeadCache } from "../../../src/hc/apply.ts";
import type { HcRecord } from "../../../src/hc/wire.ts";

beforeEach(resetHc);

const ctx = testCtx();
const repos = makeRepos(ctx);

const FIXED_WEST = "Etc/GMT+5";
const FIXED_EAST = "Etc/GMT-3";
const WITH_DST = "Pacific/Auckland";
/** Zones whose midnight is not on a UTC hour: 30 and 45 minutes off. */
const FRACTIONAL_ZONES = ["Asia/Kolkata", "Asia/Kathmandu"];

/** One Steps record of 100 at every UTC hour of `[fromMs, toMs)`, `offsetMs` past the hour. */
function hourly(fromMs: number, toMs: number, offsetMs = 0): HcRecord[] {
  const records: HcRecord[] = [];
  for (let at = fromMs; at < toMs; at += HOUR_MS) {
    records.push(
      steps(`${WEARABLE}-${String(at + offsetMs)}`, at + offsetMs, 100, { origin: WEARABLE }),
    );
  }
  return records;
}

/** Every Steps record the device holds. */
function readRecordsOf(deviceId: string): Promise<HcRecord[]> {
  return readRecords(ctx, { deviceId, type: "Steps", startMs: 0, endMs: T + 10_000 * HOUR_MS });
}

/** `day -> records counted`, for one origin, over a span of days. */
async function dayCounts(
  deviceId: string,
  startDay: string,
  endDay: string,
  origin = WEARABLE,
): Promise<Record<string, number>> {
  const rows = await readDayRollups(ctx, {
    deviceId,
    type: "Steps",
    startDay,
    endDay,
    origins: [origin],
  });
  return Object.fromEntries(rows.map((row) => [row.day, row.rollup.records]));
}

/** Every `day` mark of a device, as it is stored. */
async function dayMarks(deviceId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT key FROM hc_dirty WHERE device_id = ? AND kind = 'day' ORDER BY key",
  )
    .bind(deviceId)
    .all<{ key: string }>();
  return results.map((row) => row.key);
}

/** When the one `day` mark of a device was last written. */
async function markedAt(deviceId: string): Promise<number[]> {
  const { results } = await env.DB.prepare(
    "SELECT marked_at FROM hc_dirty WHERE device_id = ? AND kind = 'day'",
  )
    .bind(deviceId)
    .all<{ marked_at: number }>();
  return results.map((row) => row.marked_at);
}

/** Slices of a few chunks each until `chunks` of the head batch are written. */
async function applyUntil(
  slow: ReturnType<typeof testCtx>,
  deviceId: string,
  chunks: number,
  cache: HeadCache | undefined,
  carried?: HcRunnerState,
): Promise<HcRunnerState | undefined> {
  let state = carried;
  for (let slice = 0; slice < 200; slice += 1) {
    const written = await count("hc_chunks", deviceId);
    if (written >= chunks) break;
    ({ state } = await runHcSlice(slow, deviceId, state, { maxQueries: 12, maxMs: 20_000 }, cache));
  }
  return state;
}

describe("day rollups", () => {
  it("are built from the hour rollups once the queue is empty", async () => {
    const deviceId = await seedDevice(repos);
    await setSetting(ctx, "timezone", FIXED_WEST);
    const from = Date.UTC(2026, 0, 10);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: hourly(from, from + 48 * HOUR_MS),
    });

    await drain(ctx, deviceId);

    // Five hours behind UTC: the first five records fall on the day before.
    expect(await dayCounts(deviceId, "2026-01-01", "2026-01-31")).toStrictEqual({
      "2026-01-09": 5,
      "2026-01-10": 24,
      "2026-01-11": 19,
    });
    const rows = await readDayRollups(ctx, {
      deviceId,
      type: "Steps",
      startDay: "2026-01-10",
      endDay: "2026-01-10",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe(WEARABLE);
    expect(rows[0]?.rollup.fields.count).toMatchObject({ n: 24, sum: 2400, min: 100, max: 100 });
    expect(await count("hc_dirty", deviceId)).toBe(0);
  });

  it("give a day the hours the zone gave it across a daylight-saving change", async () => {
    const deviceId = await seedDevice(repos);
    await setSetting(ctx, "timezone", WITH_DST);
    // The clocks of this zone go forward on this date: the day is 23 hours.
    const short = dayBoundsMs("2025-09-28", WITH_DST);
    expect(short.endMs - short.startMs).toBe(23 * HOUR_MS);
    // And back on this one: 25 hours.
    const long = dayBoundsMs("2026-04-05", WITH_DST);
    expect(long.endMs - long.startMs).toBe(25 * HOUR_MS);

    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        ...hourly(short.startMs - 30 * HOUR_MS, short.endMs + 30 * HOUR_MS),
        ...hourly(long.startMs - 30 * HOUR_MS, long.endMs + 30 * HOUR_MS),
      ],
    });
    await drain(ctx, deviceId);

    expect(await dayCounts(deviceId, "2025-09-27", "2025-09-29")).toStrictEqual({
      "2025-09-27": 24,
      "2025-09-28": 23,
      "2025-09-29": 24,
    });
    expect(await dayCounts(deviceId, "2026-04-04", "2026-04-06")).toStrictEqual({
      "2026-04-04": 24,
      "2026-04-05": 25,
      "2026-04-06": 24,
    });
  });

  it.each(FRACTIONAL_ZONES)("split the hour a day's edge falls inside (%s)", async (FRACTIONAL) => {
    const deviceId = await seedDevice(repos);
    await setSetting(ctx, "timezone", FRACTIONAL);
    const day = dayBoundsMs("2026-01-10", FRACTIONAL);
    // The premise: this zone's midnight is not on a UTC hour.
    expect(day.startMs % HOUR_MS).not.toBe(0);
    const from = Math.floor(day.startMs / HOUR_MS) * HOUR_MS - 2 * HOUR_MS;
    // Two records in every UTC hour, five minutes in and five minutes from the end.
    const records = [
      ...hourly(from, from + 30 * HOUR_MS, 5 * MINUTE_MS),
      ...hourly(from, from + 30 * HOUR_MS, 55 * MINUTE_MS),
    ];
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: records });

    await drain(ctx, deviceId);

    const inDay = (bounds: { startMs: number; endMs: number }): number =>
      records.filter(
        (record) => (record.start ?? 0) >= bounds.startMs && (record.start ?? 0) < bounds.endMs,
      ).length;
    const counts = await dayCounts(deviceId, "2026-01-09", "2026-01-11");
    expect(counts["2026-01-10"]).toBe(48);
    expect(counts).toStrictEqual({
      "2026-01-09": inDay(dayBoundsMs("2026-01-09", FRACTIONAL)),
      "2026-01-10": inDay(day),
      "2026-01-11": inDay(dayBoundsMs("2026-01-11", FRACTIONAL)),
    });
    // Every record is on exactly one day.
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(records.length);
  });

  it("follow a record that is deleted, and drop a day left empty", async () => {
    const deviceId = await seedDevice(repos);
    await setSetting(ctx, "timezone", FIXED_WEST);
    const noon = Date.UTC(2026, 0, 10, 17);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        steps("a", noon, 100),
        steps("b", noon + HOUR_MS, 100),
        steps("c", noon + 24 * HOUR_MS, 100),
        steps("p", noon, 100, { origin: PHONE }),
      ],
    });
    await drain(ctx, deviceId);
    expect(await dayCounts(deviceId, "2026-01-10", "2026-01-11")).toStrictEqual({
      "2026-01-10": 2,
      "2026-01-11": 1,
    });

    await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["b", "c"] });
    await drain(ctx, deviceId);

    expect(await dayCounts(deviceId, "2026-01-10", "2026-01-11")).toStrictEqual({
      "2026-01-10": 1,
    });
    expect(await dayCounts(deviceId, "2026-01-10", "2026-01-11", PHONE)).toStrictEqual({
      "2026-01-10": 1,
    });
  });

  it("are rebuilt for the new zone when the timezone setting changes", async () => {
    const deviceId = await seedDevice(repos);
    await setSetting(ctx, "timezone", FIXED_WEST);
    const from = Date.UTC(2026, 0, 10);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: hourly(from, from + 48 * HOUR_MS),
    });
    const built = await drain(ctx, deviceId);
    const digests = async (): Promise<string[]> => {
      const { results } = await env.DB.prepare(
        "SELECT DISTINCT tz_digest FROM hc_rollup_day WHERE device_id = ?",
      )
        .bind(deviceId)
        .all<{ tz_digest: string }>();
      return results.map((row) => row.tz_digest);
    };
    const [west] = await digests();
    // A keyed digest, not the zone's name.
    expect(west).not.toContain("GMT");

    await setSetting(ctx, "timezone", FIXED_EAST);
    // Until the runner has been round, the old zone's days are not served as the new zone's.
    expect(await dayCounts(deviceId, "2026-01-01", "2026-01-31")).toStrictEqual({});
    expect(await storeBacklog(ctx, deviceId)).toMatchObject({ dirty: 0, rezonePending: true });

    // The runner remembers which zone it last built for; that is what it compares.
    await drain(ctx, deviceId, { state: built.state });

    expect(await dayCounts(deviceId, "2026-01-01", "2026-01-31")).toStrictEqual({
      "2026-01-10": 21,
      "2026-01-11": 24,
      "2026-01-12": 3,
    });
    const after = await digests();
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(west);
    expect(await storeBacklog(ctx, deviceId)).toStrictEqual({
      queuedBatches: 0,
      parkedBatches: 0,
      dirty: 0,
      parkedMarks: 0,
      rezonePending: false,
    });
  });

  it("notice a changed zone even when nothing remembers the old one", async () => {
    const deviceId = await seedDevice(repos);
    await setSetting(ctx, "timezone", FIXED_WEST);
    const from = Date.UTC(2026, 0, 10);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: hourly(from, from + 24 * HOUR_MS),
    });
    await drain(ctx, deviceId);

    await setSetting(ctx, "timezone", FIXED_EAST);
    // No carried state, and a small budget, so the rebuild spans slices.
    const rebuilt = await drain(ctx, deviceId, { budget: { maxQueries: 12, maxMs: 20_000 } });

    expect(rebuilt.slices).toBeGreaterThan(1);
    expect(await dayCounts(deviceId, "2026-01-01", "2026-01-31")).toStrictEqual({
      "2026-01-10": 21,
      "2026-01-11": 3,
    });
  });
});

describe("sleep nights", () => {
  const BED = Date.UTC(2026, 0, 10, 22);
  const WAKE = BED + 8 * HOUR_MS;
  const session = interval("night-1", "SleepSession", BED, WAKE, {
    title: "Night",
    stages: [
      { start: BED + 10 * MINUTE_MS, end: BED + 4 * HOUR_MS, stage: "LIGHT" },
      { start: BED + 4 * HOUR_MS, end: BED + 6 * HOUR_MS, stage: "DEEP" },
      { start: BED + 6 * HOUR_MS, end: WAKE - 10 * MINUTE_MS, stage: "REM" },
      { start: WAKE - 10 * MINUTE_MS, end: WAKE, stage: "AWAKE" },
    ],
  });
  /** A sample every five minutes through the night, one record per hour. */
  const overnight = Array.from({ length: 8 }, (_, hour) =>
    heartRate(
      `hr-${String(hour)}`,
      BED + hour * HOUR_MS,
      Array.from(
        { length: 12 },
        (_unused, index) => [index * 5 * MINUTE_MS, 52 + (index % 3)] as const,
      ),
    ),
  );
  const window = { startMs: BED, endMs: WAKE };

  it("summarise a session with the heart rate measured during it", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [session, ...overnight] });

    await drain(ctx, deviceId);

    const nights = await readSleepNights(ctx, { deviceId, ...window });
    expect(nights).toHaveLength(1);
    const night = nights[0]?.night;
    expect(night).toMatchObject({
      origin: WEARABLE,
      startMs: BED,
      endMs: WAKE,
      inBedMin: 480,
      awakeMin: 10,
      asleepMin: 470,
      title: "Night",
      hrv: null,
    });
    expect(night?.stageMin).toMatchObject({ DEEP: 120 });
    expect(night?.hr).toMatchObject({ min: 52, max: 54 });
    // The id is the blinded one: it names nothing.
    expect(nights[0]?.id).not.toContain("night-1");
    // Outside the window: not returned.
    expect(
      await readSleepNights(ctx, { deviceId, startMs: WAKE + 1, endMs: WAKE + HOUR_MS }),
    ).toStrictEqual([]);
  });

  it("are rebuilt when what was measured that night arrives later", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [session] });
    await drain(ctx, deviceId);
    const [before] = await readSleepNights(ctx, { deviceId, ...window });
    expect(before?.night.hr).toBeNull();
    expect(before?.night.hrv).toBeNull();

    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [
        ...overnight,
        instant("hrv-1", "HeartRateVariabilityRmssd", BED + 3 * HOUR_MS, { rmssd: 42 }),
        instant("rhr-1", "RestingHeartRate", WAKE + 5 * MINUTE_MS, { bpm: 51 }),
      ],
    });
    await drain(ctx, deviceId);

    const [after] = await readSleepNights(ctx, { deviceId, ...window });
    expect(after?.night.hr).not.toBeNull();
    expect(after?.night.hrv).toMatchObject({ median: 42, n: 1 });
    expect(after?.night.restingHr).toBe(51);
  });

  it("see heart rate past the session's end, so a late rise counts as the wake", async () => {
    const deviceId = await seedDevice(repos);
    // A sample a minute for the last two hours: resting until two minutes
    // before the end, then up, and staying up for a quarter of an hour after.
    const from = WAKE - 2 * HOUR_MS;
    const rise = WAKE - 2 * MINUTE_MS;
    const minutes = Array.from({ length: 135 }, (_unused, index) => from + index * MINUTE_MS);
    const late = minutes.map((at, index) =>
      heartRate(`late-${String(index)}`, at, [[30_000, at >= rise ? 85 : 50]]),
    );
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [session, ...late] });

    await drain(ctx, deviceId);

    const [night] = await readSleepNights(ctx, { deviceId, ...window });
    // Two minutes of rise inside the session would not be "sustained" alone.
    expect(night?.night.hrWakeMs).toBe(rise);
  });

  it("give a reading stamped between a night and a nap to the nearer one only", async () => {
    const deviceId = await seedDevice(repos);
    // A twenty-minute nap ten minutes after the night, and the night's
    // respiratory rate stamped five minutes after it: within half an hour of
    // the nap's end too.
    const nap = interval("nap-1", "SleepSession", WAKE + 10 * MINUTE_MS, WAKE + 30 * MINUTE_MS, {});
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        session,
        nap,
        instant("rr-1", "RespiratoryRate", WAKE + 5 * MINUTE_MS, { rate: 15 }),
      ],
    });

    await drain(ctx, deviceId);

    const nights = await readSleepNights(ctx, {
      deviceId,
      startMs: BED,
      endMs: WAKE + HOUR_MS,
    });
    const rateOf = (startMs: number): number | null | undefined =>
      nights.find((entry) => entry.night.startMs === startMs)?.night.respiratoryRate;
    expect(nights).toHaveLength(2);
    expect(rateOf(BED)).toBe(15);
    expect(rateOf(WAKE + 10 * MINUTE_MS)).toBeNull();
  });

  it("go when the session is deleted", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [session] });
    await drain(ctx, deviceId);
    expect(await count("hc_sleep_night", deviceId)).toBe(1);

    await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["night-1"] });
    await drain(ctx, deviceId);

    expect(await count("hc_sleep_night", deviceId)).toBe(0);
    expect(await count("hc_dirty", deviceId)).toBe(0);
  });
});

describe("exercise sessions", () => {
  const START = T;
  const run = interval("run-1", "ExerciseSession", START, START + HOUR_MS, {
    exerciseType: "RUNNING",
    title: "Run",
  });
  const walk = interval(
    "walk-1",
    "ExerciseSession",
    START + 30 * MINUTE_MS,
    START + 90 * MINUTE_MS,
    {
      exerciseType: "WALKING",
    },
  );
  const window = { startMs: START, endMs: START + 2 * HOUR_MS };

  it("join what was measured, and name the sessions they overlap", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        run,
        walk,
        steps("st-1", START + 10 * MINUTE_MS, 500),
        steps("st-2", START + 20 * MINUTE_MS, 250),
        heartRate("hr-1", START + 5 * MINUTE_MS, [
          [0, 120],
          [MINUTE_MS, 140],
        ]),
      ],
    });

    await drain(ctx, deviceId);

    const sessions = await readExerciseSessions(ctx, { deviceId, ...window });
    expect(sessions.map((row) => row.session.exerciseType)).toStrictEqual(["RUNNING", "WALKING"]);
    const [first, second] = sessions;
    expect(first?.session).toMatchObject({
      origin: WEARABLE,
      durationMin: 60,
      steps: 750,
      title: "Run",
      overlaps: [second?.id],
    });
    expect(first?.session.hr).toMatchObject({ min: 120, max: 140 });
    // Nothing was measured after the walk began.
    expect(second?.session).toMatchObject({ steps: null, hr: null, overlaps: [first?.id] });
  });

  it("sum one app's steps, never two apps' counts of the same walk", async () => {
    const deviceId = await seedDevice(repos);
    const during = START + 10 * MINUTE_MS;
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        run,
        steps("own-1", during, 500),
        steps("other-1", during, 480, { origin: PHONE }),
        steps("other-2", during + MINUTE_MS, 30, { origin: PHONE }),
        // No record from the session's own app: the app with the most records is used.
        interval(
          "d-1",
          "Distance",
          during,
          during + MINUTE_MS,
          { distance: 100 },
          { origin: PHONE },
        ),
        interval(
          "d-2",
          "Distance",
          during + MINUTE_MS,
          during + 2 * MINUTE_MS,
          { distance: 50 },
          { origin: PHONE },
        ),
        interval(
          "d-3",
          "Distance",
          during,
          during + MINUTE_MS,
          { distance: 999 },
          { origin: "com.example.cuff" },
        ),
      ],
    });

    await drain(ctx, deviceId);

    const [only] = await readExerciseSessions(ctx, { deviceId, ...window });
    expect(only?.session).toMatchObject({
      steps: 500,
      distance: 150,
      overlaps: [],
      exactDuplicate: false,
    });
  });

  it("are rebuilt when a session they overlapped is deleted", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [run, walk] });
    await drain(ctx, deviceId);

    await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["walk-1"] });
    await drain(ctx, deviceId);

    const sessions = await readExerciseSessions(ctx, { deviceId, ...window });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.session.overlaps).toStrictEqual([]);
  });
});

describe("a record that claims to run for weeks", () => {
  it("re-marks the sessions near its start, not every session it spans", async () => {
    const time = clock();
    const moving = testCtx({ now: time.now });
    const deviceId = await seedDevice(repos);
    const near = interval("near", "ExerciseSession", T + HOUR_MS, T + 2 * HOUR_MS, {
      exerciseType: "RUNNING",
    });
    const far = interval("far", "ExerciseSession", T + 240 * HOUR_MS, T + 241 * HOUR_MS, {
      exerciseType: "RUNNING",
    });
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [near, far] });
    await drain(moving, deviceId);
    const builtAt = async (): Promise<Record<number, number>> => {
      const { results } = await env.DB.prepare(
        "SELECT start_ms, updated_at FROM hc_exercise_session WHERE device_id = ?",
      )
        .bind(deviceId)
        .all<{ start_ms: number; updated_at: number }>();
      return Object.fromEntries(results.map((row) => [row.start_ms, row.updated_at]));
    };
    const before = await builtAt();

    time.advance(600);
    // Twenty days long. Stored whole; only its first 48 hours look for dependants.
    const endless = interval("endless", "Steps", T, T + 480 * HOUR_MS, { count: 5 });
    await enqueue(repos, deviceId, { batchId: "batch-0002", upserts: [endless] });
    await drain(moving, deviceId);

    const after = await builtAt();
    expect(after[near.start ?? 0]).toBe((before[near.start ?? 0] ?? 0) + 600);
    expect(after[far.start ?? 0]).toBe(before[far.start ?? 0]);
    const kept = await readRecordsOf(deviceId);
    expect(kept).toStrictEqual([endless]);
  });
});

describe("day marks and the zone", () => {
  it("are resolved to days when rebuilt, in the zone configured then", async () => {
    const deviceId = await seedDevice(repos);
    const from = Date.UTC(2026, 0, 10);
    // Applied with no zone configured, and only partly rebuilt: on a budget
    // this small the rebuild's share of a slice is one thing, and one thing is
    // a week of days at most. Ten days leave marks behind.
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: hourly(from, from + 10 * 24 * HOUR_MS),
    });
    let state;
    for (let slice = 0; slice < 500; slice += 1) {
      ({ state } = await runHcSlice(ctx, deviceId, state, { maxQueries: 30, maxMs: 20_000 }));
      const backlog = await storeBacklog(ctx, deviceId);
      if (backlog.queuedBatches === 0) break;
    }
    // One mark a type and UTC day, and the newest week of them is gone.
    expect(await count("hc_dirty", deviceId)).toBe(3);

    await setSetting(ctx, "timezone", FIXED_WEST);
    await drain(ctx, deviceId);

    // The days of the zone set afterwards, not of the one in force at apply
    // time -- for the days that were built before it was set, too.
    const whole = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`2026-01-${String(10 + index)}`, 24]),
    );
    expect(await dayCounts(deviceId, "2026-01-01", "2026-01-31")).toStrictEqual({
      "2026-01-09": 5,
      ...whole,
      "2026-01-19": 19,
    });
    expect(await count("hc_dirty", deviceId)).toBe(0);
  }, 30_000);

  it("are one a type and UTC day, however many hours of the day were written", async () => {
    const deviceId = await seedDevice(repos);
    const from = Date.UTC(2026, 0, 10);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: hourly(from, from + 3 * 24 * HOUR_MS),
    });
    // Stopped part way through the batch, so nothing has been rebuilt yet: a
    // few chunks a slice, until most of the seventy-two are written.
    let state;
    let chunks = 0;
    for (let slice = 0; slice < 500 && chunks < 60; slice += 1) {
      ({ state } = await runHcSlice(ctx, deviceId, state, { maxQueries: 12, maxMs: 20_000 }));
      chunks = await count("hc_chunks", deviceId);
    }

    expect(chunks).toBeLessThan(72);
    const log = await logRow(deviceId, "batch-0001");
    expect(log?.status).toBe("applying");
    // Sixty-odd chunks written, in hour order: three days, three marks.
    expect(await dayMarks(deviceId)).toStrictEqual([
      dayMarkKey("Steps", from / HOUR_MS),
      dayMarkKey("Steps", from / HOUR_MS + 24),
      dayMarkKey("Steps", from / HOUR_MS + 48),
    ]);
  }, 30_000);

  it("rebuild both local days their UTC day falls on, and nothing else", async () => {
    const deviceId = await seedDevice(repos);
    await setSetting(ctx, "timezone", FIXED_WEST);
    const from = Date.UTC(2026, 0, 10);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: hourly(from, from + 4 * 24 * HOUR_MS),
    });
    await drain(ctx, deviceId);
    const twelfth = dayMarkKey("Steps", Date.UTC(2026, 0, 12) / HOUR_MS);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM hc_rollup_day WHERE device_id = ?").bind(deviceId),
      env.DB.prepare(
        "INSERT INTO hc_dirty (device_id, kind, key, marked_at) VALUES (?, 'day', ?, 0)",
      ).bind(deviceId, twelfth),
    ]);

    await drain(ctx, deviceId);

    // 12 January UTC is the last five hours of the 11th and the first nineteen
    // of the 12th in this zone; each is built whole, from every hour it has.
    expect(await dayCounts(deviceId, "2026-01-01", "2026-01-31")).toStrictEqual({
      "2026-01-11": 24,
      "2026-01-12": 24,
    });
    expect(await count("hc_dirty", deviceId)).toBe(0);
  });

  it("that are not day marks at all are cleared, and the real ones beside them rebuilt", async () => {
    const deviceId = await seedDevice(repos);
    await setSetting(ctx, "timezone", FIXED_WEST);
    const from = Date.UTC(2026, 0, 10);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: hourly(from, from + 24 * HOUR_MS),
    });
    await drain(ctx, deviceId);
    const real = dayMarkKey("Steps", from / HOUR_MS);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM hc_rollup_day WHERE device_id = ?").bind(deviceId),
      env.DB.prepare(
        `INSERT INTO hc_dirty (device_id, kind, key, marked_at)
         VALUES (?1, 'day', ?2, 0), (?1, 'day', '0491736|Steps', 0), (?1, 'day', 'nonsense', 0)`,
      ).bind(deviceId, real),
    ]);

    await drain(ctx, deviceId);

    expect(await count("hc_dirty", deviceId)).toBe(0);
    expect(await dayCounts(deviceId, "2026-01-01", "2026-01-31")).toStrictEqual({
      "2026-01-09": 5,
      "2026-01-10": 19,
    });
  });

  it("are written once by a batch, not once for every chunk of the day", async () => {
    const time = clock();
    const moving = testCtx({ now: time.now });
    const deviceId = await seedDevice(repos);
    const from = Date.UTC(2026, 0, 10);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: hourly(from, from + 24 * HOUR_MS),
    });
    const first = time.now();
    // The parsed batch, and what it has marked, carried from slice to slice as
    // the runner carries it.
    const cache: HeadCache = { head: null };

    const state = await applyUntil(moving, deviceId, 4, cache);
    expect(await markedAt(deviceId)).toStrictEqual([first]);

    // Later slices of the same batch write more chunks of the day, and leave
    // the mark as it is: there, and not written again.
    time.advance(600);
    await applyUntil(moving, deviceId, 16, cache, state);

    expect(await count("hc_chunks", deviceId)).toBeLessThan(24);
    expect(await markedAt(deviceId)).toStrictEqual([first]);
  }, 30_000);

  it("are written again by a slice that does not know what the batch has marked", async () => {
    const time = clock();
    const moving = testCtx({ now: time.now });
    const deviceId = await seedDevice(repos);
    const from = Date.UTC(2026, 0, 10);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: hourly(from, from + 24 * HOUR_MS),
    });
    const first = time.now();

    // No cache: every slice reads the batch afresh, as after an eviction.
    const state = await applyUntil(moving, deviceId, 4, undefined);
    time.advance(600);
    await applyUntil(moving, deviceId, 16, undefined, state);

    expect(await markedAt(deviceId)).toStrictEqual([first + 600]);
  }, 30_000);

  it("are written again by the next batch, after the rebuild has cleared them", async () => {
    const deviceId = await seedDevice(repos);
    await setSetting(ctx, "timezone", FIXED_WEST);
    const from = Date.UTC(2026, 0, 10, 12);
    const cache: HeadCache = { head: null };
    const run = async (): Promise<void> => {
      let state: HcRunnerState | undefined;
      for (let slice = 0; slice < 200; slice += 1) {
        const result = await runHcSlice(ctx, deviceId, state, undefined, cache);
        ({ state } = result);
        if (!result.more) return;
      }
    };
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: hourly(from, from + 2 * HOUR_MS),
    });
    await run();
    expect(await dayCounts(deviceId, "2026-01-10", "2026-01-10")).toStrictEqual({
      "2026-01-10": 2,
    });

    // The same day again, through the same runner: the mark is not remembered
    // from the batch before, and the day follows the new records.
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: hourly(from + 2 * HOUR_MS, from + 5 * HOUR_MS),
    });
    await run();

    expect(await dayCounts(deviceId, "2026-01-10", "2026-01-10")).toStrictEqual({
      "2026-01-10": 5,
    });
    expect(await count("hc_dirty", deviceId)).toBe(0);
  });

  it("take a larger share of a slice the longer the list, and never more than half", () => {
    expect(rebuildShare(0, 1)).toBeCloseTo(0.2);
    expect(rebuildShare(200, 1)).toBeCloseTo(0.35);
    expect(rebuildShare(400, 1)).toBeCloseTo(0.5);
    expect(rebuildShare(1_000_000, 1)).toBeCloseTo(0.5);
  });

  it("take what is above a fifth only out of what the slice has left", () => {
    // A long list, and a slice that has spent all but a third of its budget.
    expect(rebuildShare(1_000_000, 1 / 3)).toBeCloseTo(1 / 3);
    // Nothing left at all: the fifth every applied batch is followed by.
    expect(rebuildShare(1_000_000, 0)).toBeCloseTo(0.2);
    expect(rebuildShare(0, 0)).toBeCloseTo(0.2);
  });

  // The share is of the work, not of a slice: what a batch is followed by is
  // measured against what that batch cost, so five small batches in a slice are
  // not each followed by a fifth of the whole slice.
  it("are allowed a quarter of what the batch cost at a fifth, and as much again at a half", () => {
    const slice = { maxQueries: 650, maxMs: 20_000 };
    const batch = { statements: 200, ms: 2000 };

    expect(rebuildAllowance(0.2, batch, slice)).toStrictEqual({ maxQueries: 50, maxMs: 500 });
    expect(rebuildAllowance(0.5, batch, slice)).toStrictEqual({ maxQueries: 200, maxMs: 2000 });
  });

  it("are never allowed more than that fraction of a slice, nor less than a floor", () => {
    const slice = { maxQueries: 650, maxMs: 20_000 };

    // A batch that filled a slice and more: the old allowance, a fifth of a slice.
    const large = rebuildAllowance(0.2, { statements: 5000, ms: 60_000 }, slice);
    expect(large).toStrictEqual({ maxQueries: 130, maxMs: 4000 });
    // A batch that cost nothing (every record already stored) is still followed
    // by room for a couple of marks.
    const free = rebuildAllowance(0.2, { statements: 0, ms: 0 }, slice);
    expect(free).toStrictEqual({ maxQueries: 32, maxMs: 500 });
    // And in a slice too small for the floor, the slice's own fraction rules.
    const tiny = rebuildAllowance(0.2, { statements: 0, ms: 0 }, { maxQueries: 40, maxMs: 1000 });
    expect(tiny).toStrictEqual({ maxQueries: 8, maxMs: 25 });
  });
});

describe("a derived row that will not open", () => {
  it("is rebuilt from the chunks: an hour rollup", async () => {
    const deviceId = await seedDevice(repos);
    await setSetting(ctx, "timezone", FIXED_WEST);
    const noon = Date.UTC(2026, 0, 10, 17);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [steps("a", noon, 100), steps("b", noon + HOUR_MS, 100)],
    });
    await drain(ctx, deviceId);
    // Not what was sealed there: it will never open.
    await env.DB.prepare(
      "UPDATE hc_rollup_hour SET payload_enc = 'v3:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE device_id = ? AND hour_utc = ?",
    )
      .bind(deviceId, noon / HOUR_MS)
      .run();

    // Another record on the same day marks the day again.
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [steps("c", noon + 2 * HOUR_MS, 100)],
    });
    await drain(ctx, deviceId);

    expect(await dayCounts(deviceId, "2026-01-10", "2026-01-10")).toStrictEqual({
      "2026-01-10": 3,
    });
    expect(await storeBacklog(ctx, deviceId)).toMatchObject({ dirty: 0, parkedMarks: 0 });
    // The rollup itself was written afresh: a second rebuild reads it.
    await enqueue(repos, deviceId, {
      batchId: "batch-0003",
      upserts: [steps("d", noon + 3 * HOUR_MS, 100)],
    });
    await drain(ctx, deviceId);
    expect(await dayCounts(deviceId, "2026-01-10", "2026-01-10")).toStrictEqual({
      "2026-01-10": 4,
    });
  });

  it("is rebuilt from the chunks: a heart-rate minute row a night reads", async () => {
    const deviceId = await seedDevice(repos);
    const bed = Date.UTC(2026, 0, 10, 22);
    const night = interval("night-1", "SleepSession", bed, bed + 2 * HOUR_MS, {});
    const hr = [0, 1].map((hour) =>
      heartRate(`hr-${String(hour)}`, bed + hour * HOUR_MS, [[60_000, 55]]),
    );
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [night, ...hr] });
    await drain(ctx, deviceId);
    await env.DB.prepare(
      "UPDATE hc_hr_minute SET payload_enc = 'v3:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE device_id = ? AND hour_utc = ?",
    )
      .bind(deviceId, bed / HOUR_MS)
      .run();

    // Something else measured that night arrives, and the night is rebuilt.
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [instant("hrv-1", "HeartRateVariabilityRmssd", bed + HOUR_MS, { rmssd: 40 })],
    });
    await drain(ctx, deviceId);

    const [row] = await readSleepNights(ctx, { deviceId, startMs: bed, endMs: bed + HOUR_MS });
    expect(row?.night.hr).toMatchObject({ n: 2 });
    expect(row?.night.hrv).toMatchObject({ n: 1 });
    expect(await storeBacklog(ctx, deviceId)).toMatchObject({ dirty: 0, parkedMarks: 0 });
  });
});

describe("a mark whose source chunk will not open", () => {
  it("is parked, and every other mark is still rebuilt", async () => {
    const deviceId = await seedDevice(repos);
    await setSetting(ctx, "timezone", FIXED_WEST);
    const noon = Date.UTC(2026, 0, 10, 17);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [steps("a", noon, 100), heartRate("hr-1", noon, [[60_000, 60]])],
    });
    await drain(ctx, deviceId);
    const chunk = await env.DB.prepare(
      "SELECT origin_hash, hour_utc FROM hc_chunks WHERE device_id = ? AND record_type = 'HeartRate'",
    )
      .bind(deviceId)
      .first<{ origin_hash: string; hour_utc: number }>();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE hc_chunks SET payload_enc = 'v3:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE device_id = ? AND record_type = 'HeartRate'",
      ).bind(deviceId),
      // The mark that needs that chunk, first in line; and one that does not.
      env.DB.prepare(
        "INSERT INTO hc_dirty (device_id, kind, key, marked_at) VALUES (?, 'hr', ?, 0), (?, 'day', ?, 0)",
      ).bind(
        deviceId,
        `${chunk?.origin_hash ?? ""}|${String(chunk?.hour_utc ?? 0)}`,
        deviceId,
        dayMarkKey("Steps", noon / HOUR_MS),
      ),
      env.DB.prepare("DELETE FROM hc_rollup_day WHERE device_id = ?").bind(deviceId),
    ]);

    // Terminates: the bad mark is not retried for ever at the head of the list.
    await drain(ctx, deviceId);

    expect(await storeBacklog(ctx, deviceId)).toMatchObject({ dirty: 0, parkedMarks: 1 });
    expect(await dayCounts(deviceId, "2026-01-10", "2026-01-10")).toStrictEqual({
      "2026-01-10": 1,
    });
    const { results } = await env.DB.prepare("SELECT kind FROM hc_dirty WHERE device_id = ?")
      .bind(deviceId)
      .all<{ kind: string }>();
    expect(results).toStrictEqual([{ kind: "parked:hr" }]);

    // Kept, and can be put back to be tried again.
    expect(await unparkMarks(ctx, deviceId)).toBe(1);
    expect(await storeBacklog(ctx, deviceId)).toMatchObject({ dirty: 1, parkedMarks: 0 });
  });
});

describe("sleep nights and their neighbours", () => {
  it("are rebuilt when another sleep session arrives beside them", async () => {
    const time = clock();
    const moving = testCtx({ now: time.now });
    const deviceId = await seedDevice(repos);
    const bed = Date.UTC(2026, 0, 10, 22);
    const night = interval("night-1", "SleepSession", bed, bed + 8 * HOUR_MS, {});
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [night] });
    await drain(moving, deviceId);
    const builtAt = async (): Promise<number | undefined> => {
      const row = await env.DB.prepare(
        "SELECT updated_at FROM hc_sleep_night WHERE device_id = ? AND start_ms = ?",
      )
        .bind(deviceId, bed)
        .first<{ updated_at: number }>();
      return row?.updated_at;
    };
    const before = await builtAt();

    time.advance(600);
    const nap = interval(
      "nap-1",
      "SleepSession",
      bed + 8 * HOUR_MS + 20 * MINUTE_MS,
      bed + 9 * HOUR_MS,
      {},
    );
    await enqueue(repos, deviceId, { batchId: "batch-0002", upserts: [nap] });
    await drain(moving, deviceId);

    expect(await builtAt()).toBe((before ?? 0) + 600);
    expect(await count("hc_sleep_night", deviceId)).toBe(2);
  });
});

describe("a session that claims an absurd span", () => {
  it("is summarised from its first two days, and says so", async () => {
    const deviceId = await seedDevice(repos);
    const start = Date.UTC(2026, 0, 10, 8);
    const endless = interval("run-forever", "ExerciseSession", start, start + 400 * 24 * HOUR_MS, {
      exerciseType: "RUNNING",
    });
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        endless,
        steps("early", start + HOUR_MS, 500),
        // A hundred days in: inside the session, outside what is read for it.
        steps("late", start + 100 * 24 * HOUR_MS, 900),
      ],
    });

    await drain(ctx, deviceId);

    const [row] = await readExerciseSessions(ctx, {
      deviceId,
      startMs: start,
      endMs: start + HOUR_MS,
    });
    expect(row?.session).toMatchObject({ steps: 500, contextClamped: true });
    // The record itself is stored whole.
    expect(row?.session.endMs).toBe(start + 400 * 24 * HOUR_MS);
  });
});

describe("while batches are still arriving", () => {
  const DAY = 24 * HOUR_MS;
  /** One day of hourly steps and that night's sleep, `n` days after the first. */
  function dayBatch(n: number): HcRecord[] {
    const from = Date.UTC(2026, 0, 10) + n * DAY;
    return [
      ...hourly(from, from + DAY),
      interval(`night-${String(n)}`, "SleepSession", from + 22 * HOUR_MS, from + 30 * HOUR_MS, {}),
    ];
  }

  it("builds summaries of what is already applied, and the queue still drains", async () => {
    const logged = recordingLog();
    const loud = testCtx({ log: logged.log });
    const deviceId = await seedDevice(repos);
    await setSetting(ctx, "timezone", FIXED_WEST);
    for (const n of [0, 1, 2]) {
      await enqueue(repos, deviceId, { batchId: `batch-000${String(n)}`, upserts: dayBatch(n) });
    }
    // Room for about one batch a slice: the queue is never empty until the end.
    const budget = { maxQueries: 200, maxMs: 20_000 };

    const first = await runHcSlice(loud, deviceId, undefined, budget);

    const afterFirst = await storeBacklog(ctx, deviceId);
    expect(first.more).toBe(true);
    expect(afterFirst.queuedBatches).toBeGreaterThanOrEqual(2);
    // With two batches still queued, the first one's night and some of its
    // days are already there to be read.
    expect(await count("hc_sleep_night", deviceId)).toBe(1);
    expect(await count("hc_rollup_day", deviceId)).toBeGreaterThan(0);
    // And the slice said what it did.
    const line = logged.lines.find((entry) => entry.includes('"hc.slice"'));
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      event: "hc.slice",
      deviceId,
      phase: "apply",
      ended: "statements",
      queuedBatches: afterFirst.queuedBatches,
    });

    // More keeps arriving; the share the rebuild takes never stops the queue.
    await enqueue(repos, deviceId, { batchId: "batch-0003", upserts: dayBatch(3) });
    const rest = await drain(loud, deviceId, { budget, state: first.state });

    expect(rest.slices).toBeLessThan(40);
    expect(await storeBacklog(ctx, deviceId)).toMatchObject({ queuedBatches: 0, dirty: 0 });
    expect(await count("hc_sleep_night", deviceId)).toBe(4);
    expect(await dayCounts(deviceId, "2026-01-10", "2026-01-12")).toStrictEqual({
      "2026-01-10": 24,
      "2026-01-11": 24,
      "2026-01-12": 24,
    });
    const sliceLines = logged.lines.filter((entry) => entry.includes('"hc.slice"'));
    const last = sliceLines.at(-1);
    expect(JSON.parse(last ?? "{}")).toMatchObject({
      phase: "rebuild",
      ended: "done",
      queuedBatches: 0,
    });
  });

  it("takes the newest days first", async () => {
    const deviceId = await seedDevice(repos);
    await setSetting(ctx, "timezone", FIXED_WEST);
    const from = Date.UTC(2026, 0, 10);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: hourly(from, from + 10 * DAY),
    });
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [steps("later", from + 20 * DAY, 1)],
    });

    // Small slices until the first batch is in: the slice that finishes it has
    // only its share to rebuild with, which is one run of days -- a week.
    let state;
    for (let slice = 0; slice < 500; slice += 1) {
      ({ state } = await runHcSlice(ctx, deviceId, state, { maxQueries: 60, maxMs: 20_000 }));
      const applied = await logRow(deviceId, "batch-0001");
      if (applied?.status === "applied") break;
    }

    const { results } = await env.DB.prepare(
      "SELECT min(day) AS oldest, max(day) AS newest FROM hc_rollup_day WHERE device_id = ?",
    )
      .bind(deviceId)
      .all<{ oldest: string | null; newest: string | null }>();
    // The last day of the batch is built; its first is still waiting.
    expect(results[0]?.newest).toBe("2026-01-19");
    expect(results[0]?.oldest).toBe("2026-01-12");
  }, 30_000);
});
