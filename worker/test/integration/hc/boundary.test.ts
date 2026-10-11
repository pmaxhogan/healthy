// The hour boundary: which earlier chunks reach into an hour, and which only
// touch it.
//
// The rule, in one place:
//
//   - A record is the half-open interval [start, end), and so is a window. A
//     record that ends exactly where an hour (or a window) starts has nothing
//     in it. One that ends a millisecond later does.
//   - A heart-rate SAMPLE is an instant. One stamped exactly on the hour
//     belongs to that hour's per-minute row, even though its record started in
//     the hour before and ends on the boundary.
//
// The partial index `hc_chunks_spill` holds only the chunks that run PAST the
// end of their own hour, so the boundary sample is not found through it: the
// previous hour's chunk is read by primary key. Each case below pins one side
// of that line, and what the index holds while it does.
//
// Every record is synthetic: see helpers.ts.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { makeRepos } from "../../../src/db/index.ts";
import { readHrMinutes, readRecords } from "../../../src/hc/store/read.ts";

import {
  drain,
  enqueue,
  H0,
  heartRate,
  interval,
  MINUTE_MS,
  PHONE,
  resetHc,
  seedDevice,
  T,
  testCtx,
  WEARABLE,
} from "./helpers.ts";

import type { HcRecord } from "../../../src/hc/wire.ts";

beforeEach(resetHc);

const ctx = testCtx();
const repos = makeRepos(ctx);

const HOUR = 3_600_000;
/** The first instant of the hour after the test's own. */
const NEXT = T + HOUR;

/** How many chunk rows of a device the spill index holds. */
async function indexed(deviceId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS n FROM hc_chunks INDEXED BY hc_chunks_spill
      WHERE device_id = ? AND max_end_ms > (hour_utc + 1) * 3600000`,
  )
    .bind(deviceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** `origin -> hour -> minutes with a sample`, for the two hours either side of the boundary. */
async function minutes(deviceId: string): Promise<Record<string, Record<number, number[]>>> {
  const rows = await readHrMinutes(ctx, { deviceId, startMs: T, endMs: T + 2 * HOUR });
  const byOrigin: Record<string, Record<number, number[]>> = {};
  for (const row of rows) {
    const hours = byOrigin[row.origin] ?? {};
    hours[row.hourUtc] = row.minutes.map((minute) => minute.m);
    byOrigin[row.origin] = hours;
  }
  return byOrigin;
}

/** The ids of the Steps records with anything in `[startMs, endMs)`. */
async function stepsIn(deviceId: string, startMs: number, endMs: number): Promise<string[]> {
  const records = await readRecords(ctx, { deviceId, type: "Steps", startMs, endMs });
  return records.map((record) => record.id);
}

/**
 * A heart-rate series that starts at :59 and ends `pastMs` after the hour,
 * with a sample at :59 and one at its very end.
 */
function endingAt(id: string, pastMs: number, extra: Partial<HcRecord> = {}): HcRecord {
  const start = T + 59 * MINUTE_MS;
  return heartRate(
    id,
    start,
    [
      [0, 60],
      [MINUTE_MS + pastMs, 61],
    ],
    { end: NEXT + pastMs, ...extra },
  );
}

/** Minutes 0 to 59. */
const EVERY_MINUTE = Array.from({ length: 60 }, (_, index) => index);

/** Text that will not compress: forty kilobytes of it. */
function noise(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(30_000));
  return btoa(String.fromCodePoint(...bytes));
}

describe("a record that ends exactly on the hour", () => {
  it("is not in the next hour, is not in the spill index, and is in its own", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [interval("on", "Steps", T + 30 * MINUTE_MS, NEXT, { count: 1 })],
    });
    await drain(ctx, deviceId);

    expect(await indexed(deviceId)).toBe(0);
    expect(await stepsIn(deviceId, NEXT, NEXT + HOUR)).toStrictEqual([]);
    expect(await stepsIn(deviceId, NEXT, NEXT + 1)).toStrictEqual([]);
    // Its last millisecond is the one before the boundary.
    expect(await stepsIn(deviceId, NEXT - 1, NEXT)).toStrictEqual(["on"]);
    expect(await stepsIn(deviceId, NEXT - 1, NEXT + HOUR)).toStrictEqual(["on"]);
  });

  it("puts nothing in the next hour's heart-rate row when no sample is on the boundary", async () => {
    const deviceId = await seedDevice(repos);
    // Ends on the hour; its samples are at :59:00 and :59:30.
    const series = heartRate(
      "hr-on",
      T + 59 * MINUTE_MS,
      [
        [0, 60],
        [30_000, 61],
      ],
      { end: NEXT },
    );
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [series] });
    await drain(ctx, deviceId);
    expect(await minutes(deviceId)).toStrictEqual({ [WEARABLE]: { [H0]: [59] } });

    // The next hour gets a record of its own: its row is that record's alone.
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [heartRate("hr-own", NEXT + 10 * MINUTE_MS, [[0, 70]])],
    });
    await drain(ctx, deviceId);

    expect(await indexed(deviceId)).toBe(0);
    expect(await minutes(deviceId)).toStrictEqual({ [WEARABLE]: { [H0]: [59], [H0 + 1]: [10] } });
  });
});

describe("a record that ends one millisecond past the hour", () => {
  it("is in the next hour, and its chunk is in the spill index", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        interval("past", "Steps", T + 30 * MINUTE_MS, NEXT + 1, { count: 1 }),
        // Hours later, and ending inside its own hour: in the way of nothing.
        interval("later", "Steps", T + 5 * HOUR, T + 5 * HOUR + MINUTE_MS, { count: 1 }),
      ],
    });
    await drain(ctx, deviceId);

    expect(await indexed(deviceId)).toBe(1);
    expect(await stepsIn(deviceId, NEXT, NEXT + 1)).toStrictEqual(["past"]);
    expect(await stepsIn(deviceId, NEXT, NEXT + HOUR)).toStrictEqual(["past"]);
    // And no further: it has nothing at the instant it ends on.
    expect(await stepsIn(deviceId, NEXT + 1, NEXT + HOUR)).toStrictEqual([]);
  });

  it("puts its sample in the next hour's heart-rate row", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [endingAt("hr-past", 1)] });
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [heartRate("hr-own", NEXT + 10 * MINUTE_MS, [[0, 70]])],
    });
    await drain(ctx, deviceId);

    expect(await indexed(deviceId)).toBe(1);
    expect(await minutes(deviceId)).toStrictEqual({
      [WEARABLE]: { [H0]: [59], [H0 + 1]: [0, 10] },
    });
  });
});

describe("a heart-rate sample stamped exactly on the hour", () => {
  it("belongs to that hour, though its record started in the one before and ends there", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [endingAt("hr-edge", 0)] });
    await drain(ctx, deviceId);

    // The record ends on the boundary, so its chunk is not in the index...
    expect(await indexed(deviceId)).toBe(0);
    // ...and its last sample is in the next hour's row all the same.
    expect(await minutes(deviceId)).toStrictEqual({ [WEARABLE]: { [H0]: [59], [H0 + 1]: [0] } });
  });

  it("is kept when the hour's own chunk is written afterwards", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [endingAt("hr-edge", 0)] });
    await drain(ctx, deviceId);
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [heartRate("hr-own", NEXT + 10 * MINUTE_MS, [[0, 70]])],
    });
    await drain(ctx, deviceId);

    expect(await indexed(deviceId)).toBe(0);
    expect(await minutes(deviceId)).toStrictEqual({
      [WEARABLE]: { [H0]: [59], [H0 + 1]: [0, 10] },
    });
  });

  it("is added when it arrives after the hour's own chunk, and leaves with its record", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [heartRate("hr-own", NEXT + 10 * MINUTE_MS, [[0, 70]])],
    });
    await drain(ctx, deviceId);
    await enqueue(repos, deviceId, { batchId: "batch-0002", upserts: [endingAt("hr-edge", 0)] });
    await drain(ctx, deviceId);

    expect(await minutes(deviceId)).toStrictEqual({
      [WEARABLE]: { [H0]: [59], [H0 + 1]: [0, 10] },
    });

    await enqueue(repos, deviceId, { batchId: "batch-0003", deletes: ["hr-edge"] });
    await drain(ctx, deviceId);

    expect(await minutes(deviceId)).toStrictEqual({ [WEARABLE]: { [H0 + 1]: [10] } });
  });
});

/** Sixty heart-rate records in one hour that will not fit one row; the last ends `pastMs` past it. */
const heavy = (pastMs: number): HcRecord[] => [
  ...Array.from({ length: 59 }, (_, index) =>
    heartRate(`heavy-${String(index).padStart(2, "0")}`, T + index * MINUTE_MS, [[0, 60]], {
      end: T + (index + 1) * MINUTE_MS,
      data: { samples: [{ t: T + index * MINUTE_MS, bpm: 60 }], notes: noise() },
    }),
  ),
  endingAt("heavy-59", pastMs),
];

/** Rows the chunk of the test's own hour occupies. */
async function partsOf(deviceId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM hc_chunks WHERE device_id = ? AND hour_utc = ?",
  )
    .bind(deviceId, H0)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("a chunk of several rows at the boundary", () => {
  it("is read whole by primary key when it ends on the hour", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: heavy(0) });
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [heartRate("hr-own", NEXT + 10 * MINUTE_MS, [[0, 70]])],
    });
    await drain(ctx, deviceId);

    expect(await partsOf(deviceId)).toBeGreaterThan(1);
    expect(await indexed(deviceId)).toBe(0);
    expect(await minutes(deviceId)).toStrictEqual({
      [WEARABLE]: { [H0]: EVERY_MINUTE, [H0 + 1]: [0, 10] },
    });
  });

  it("is read whole through the index when it runs past the hour, every row of it once", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: heavy(1) });
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [heartRate("hr-own", NEXT + 10 * MINUTE_MS, [[0, 70]])],
    });
    await drain(ctx, deviceId);

    const parts = await partsOf(deviceId);
    expect(parts).toBeGreaterThan(1);
    // Every row of the chunk carries the chunk's own end, so each is indexed.
    expect(await indexed(deviceId)).toBe(parts);
    expect(await minutes(deviceId)).toStrictEqual({
      [WEARABLE]: { [H0]: EVERY_MINUTE, [H0 + 1]: [0, 10] },
    });
    // A window in the next hour gets the one record that reaches it, once.
    const reaching = await readRecords(ctx, {
      deviceId,
      type: "HeartRate",
      startMs: NEXT,
      endMs: NEXT + MINUTE_MS,
    });
    expect(reaching.map((record) => record.id)).toStrictEqual(["heavy-59"]);
  });
});

describe("two origins at the boundary", () => {
  it("keep their heart-rate rows apart: one app's boundary sample is not the other's", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        // The watch: a series ending on the hour with a sample on it.
        endingAt("watch-edge", 0),
        // The phone: one that runs a millisecond past, and its own next hour.
        endingAt("phone-past", 1, { origin: PHONE }),
        heartRate("phone-own", NEXT + 20 * MINUTE_MS, [[0, 80]], { origin: PHONE }),
      ],
    });
    await drain(ctx, deviceId);

    // Only the phone's chunk overruns its hour.
    expect(await indexed(deviceId)).toBe(1);
    expect(await minutes(deviceId)).toStrictEqual({
      [WEARABLE]: { [H0]: [59], [H0 + 1]: [0] },
      [PHONE]: { [H0]: [59], [H0 + 1]: [0, 20] },
    });
  });

  it("are both read by a window that names no origin, and one by a window that does", async () => {
    const deviceId = await seedDevice(repos);
    const from = T + 30 * MINUTE_MS;
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        interval("watch-past", "Steps", from, NEXT + 1, { count: 1 }),
        interval("phone-past", "Steps", from, NEXT + 2, { count: 1 }, { origin: PHONE }),
        interval("phone-on", "Steps", from + 1, NEXT, { count: 1 }, { origin: PHONE }),
      ],
    });
    await drain(ctx, deviceId);
    const window = { deviceId, type: "Steps", startMs: NEXT, endMs: NEXT + HOUR };

    const both = await readRecords(ctx, window);
    const phone = await readRecords(ctx, { ...window, origins: [PHONE] });

    expect(both).toHaveLength(2);
    expect(new Set(both.map((record) => record.id))).toStrictEqual(
      new Set(["phone-past", "watch-past"]),
    );
    expect(phone.map((record) => record.id)).toStrictEqual(["phone-past"]);
    // The second millisecond of the hour is the phone's alone.
    expect(await stepsIn(deviceId, NEXT + 1, NEXT + 2)).toStrictEqual(["phone-past"]);
  });
});
