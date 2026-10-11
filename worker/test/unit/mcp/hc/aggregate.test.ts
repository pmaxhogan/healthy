// `aggregate()` and the reader under it (`parts.ts`): calendar buckets filled
// from the coarsest level of the store that is exact.
//
// The fake store logs every reader call, so these tests pin two things at
// once: the numbers, and what was opened to get them. "A year by day reads
// day rollups and no raw chunk" is half of what this code is for.
//
// Synthetic throughout; zones are test parameters.

import { describe, expect, it } from "vitest";

import { dayBoundsMs } from "../../../../src/hc/rollup/day.ts";
import { recordStartMs } from "../../../../src/hc/wire.ts";
import { aggregate, defaultMetrics, parseOriginMode } from "../../../../src/mcp/hc/aggregate.ts";
import { zoneClock } from "../../../../src/mcp/hc/time.ts";
import {
  HOUR_MS,
  MINUTE_MS,
  PHONE,
  PLATFORM,
  WEARABLE,
  addDevice,
  device,
  emptyHc,
  fakeHcReads,
  instant,
  interval,
  platformHour,
} from "../hc-fake.ts";

import type { CalendarBucket } from "../../../../src/hc/rollup/day.ts";
import type { HcRecord } from "../../../../src/hc/wire.ts";
import type { AggregateRequest, AggregateResult } from "../../../../src/mcp/hc/aggregate.ts";
import type { FakeHc } from "../hc-fake.ts";

const FIXED_WEST = "Etc/GMT+5";
const HALF_HOUR = "Asia/Kolkata";
const DST = "Pacific/Auckland";
const UTC = "UTC";

const DEVICE = "dev_1";
const DAY_MS = 24 * HOUR_MS;
/** 2026-03-10T00:00Z: an arbitrary Tuesday. */
const D0 = Date.UTC(2026, 2, 10);

const steps = (id: string, startMs: number, count: number, origin = WEARABLE): HcRecord =>
  interval(id, "Steps", startMs, startMs + MINUTE_MS, { count }, { origin });

function store(records: readonly HcRecord[], timezone = UTC): FakeHc {
  const hc = emptyHc();
  hc.timezone = timezone;
  addDevice(hc, device(DEVICE, "Test phone", 1), records);
  return hc;
}

function request(
  hc: FakeHc,
  overrides: Partial<AggregateRequest> & { tz?: string },
): AggregateRequest {
  const timeZone = overrides.tz ?? hc.timezone;
  return {
    deviceId: DEVICE,
    type: "Steps",
    range: { startMs: D0, endMs: D0 + DAY_MS },
    bucket: "day",
    mode: { kind: "hc_priority" },
    metrics: ["sum"],
    fill: "zero",
    excludeFuture: true,
    nowMs: D0 + 30 * DAY_MS,
    clock: zoneClock(timeZone),
    dayRollupsUsable: timeZone === hc.timezone,
    bmrKcalPerDay: null,
    ...overrides,
  };
}

const readers = (hc: FakeHc): string[] => [...new Set(hc.calls.map((call) => call.reader))];
const sums = (rows: { values: Record<string, { sum?: number | null }> }[], field = "count") =>
  rows.map((row) => row.values[field]?.sum ?? null);

describe("which level of the store answers", () => {
  const records = [
    steps("a", D0 + 1 * HOUR_MS, 100),
    steps("b", D0 + 9 * HOUR_MS + 20 * MINUTE_MS, 200),
    steps("c", D0 + DAY_MS + 3 * HOUR_MS, 400),
    steps("d", D0 + 2 * DAY_MS + 23 * HOUR_MS, 800),
  ];
  const threeDays = { startMs: D0, endMs: D0 + 3 * DAY_MS };

  it("answers whole days in the configured zone from day rollups alone", async () => {
    const hc = store(records);

    const result = await aggregate(fakeHcReads(hc), request(hc, { range: threeDays }));

    expect(sums(result.rows)).toStrictEqual([300, 400, 800]);
    expect(result.sources).toStrictEqual(["day_rollup"]);
    expect(readers(hc)).toStrictEqual(["dayRollups"]);
  });

  it("composes days from hour rollups when the answer is in another zone", async () => {
    const hc = store(records);
    // Local days in a zone five hours west begin at 05:00Z.
    const range = { startMs: D0 + 5 * HOUR_MS, endMs: D0 + 5 * HOUR_MS + 2 * DAY_MS };

    const result = await aggregate(fakeHcReads(hc), request(hc, { range, tz: FIXED_WEST }));

    expect(result.rows.map((row) => row.bucket)).toStrictEqual(["2026-03-10", "2026-03-11"]);
    expect(sums(result.rows)).toStrictEqual([600, 0]);
    expect(result.sources).toStrictEqual(["hour_rollup"]);
    expect(readers(hc)).toStrictEqual(["hourRollups"]);
  });

  it("does not use day rollups while any are waiting to be rebuilt", async () => {
    const hc = store(records);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { range: threeDays, dayRollupsUsable: false }),
    );

    expect(sums(result.rows)).toStrictEqual([300, 400, 800]);
    expect(readers(hc)).toStrictEqual(["hourRollups"]);
  });

  it("opens raw records only for the hours a boundary cuts, in a half-hour zone", async () => {
    const hc = store(records);
    // Two local days in a zone on +05:30: they begin at 18:30Z.
    const startMs = D0 + 18.5 * HOUR_MS;
    const range = { startMs, endMs: startMs + 2 * DAY_MS };

    const result = await aggregate(fakeHcReads(hc), request(hc, { range, tz: HALF_HOUR }));

    expect(result.rows.map((row) => row.bucket)).toStrictEqual(["2026-03-11", "2026-03-12"]);
    expect(sums(result.rows)).toStrictEqual([400, 0]);
    // Three boundaries, each inside one UTC hour: three one-hour raw reads, no more.
    const raw = hc.calls.filter((call) => call.reader === "records");
    expect(raw.map((call) => (call.endMs ?? 0) - (call.startMs ?? 0))).toStrictEqual([
      HOUR_MS / 2,
      HOUR_MS,
      HOUR_MS / 2,
    ]);
  });

  it("answers hour buckets from hour rollups and sub-hour buckets from that range's records", async () => {
    const hc = store(records);
    const morning = { startMs: D0 + 9 * HOUR_MS, endMs: D0 + 10 * HOUR_MS };

    const hourly = await aggregate(
      fakeHcReads(hc),
      request(hc, { range: { startMs: D0, endMs: D0 + DAY_MS }, bucket: "hour" }),
    );
    const afterHourly = readers(hc);
    hc.calls.length = 0;
    const quarters = await aggregate(
      fakeHcReads(hc),
      request(hc, { range: morning, bucket: "15min" }),
    );

    expect(hourly.rows).toHaveLength(24);
    expect(sums(hourly.rows)[1]).toBe(100);
    expect(sums(hourly.rows)[9]).toBe(200);
    expect(afterHourly).toStrictEqual(["hourRollups"]);
    expect(sums(quarters.rows)).toStrictEqual([0, 200, 0, 0]);
    expect(quarters.rows[1]?.bucket).toBe("2026-03-10T09:15:00+00:00");
    expect(hc.calls).toStrictEqual([
      { reader: "records", type: "Steps", startMs: morning.startMs, endMs: morning.endMs },
    ]);
  });

  it("reads the ragged edges of a range raw and the whole days between from rollups", async () => {
    const hc = store(records);
    const range = { startMs: D0 + 30 * MINUTE_MS, endMs: D0 + 3 * DAY_MS };

    const result = await aggregate(fakeHcReads(hc), request(hc, { range }));

    expect(sums(result.rows)).toStrictEqual([300, 400, 800]);
    expect(result.rows[0]?.partial).toBe(true);
    expect(result.rows[1]?.partial).toBeUndefined();
    expect(new Set(result.sources)).toStrictEqual(new Set(["day_rollup", "hour_rollup"]));
  });
});

describe("calendar buckets", () => {
  it("counts a record in the bucket its start falls in, in the answer's zone", async () => {
    // 04:30Z on the 11th is still the 10th five hours west.
    const hc = store([steps("late", D0 + DAY_MS + 4.5 * HOUR_MS, 70)], FIXED_WEST);
    const range = { startMs: D0 + 5 * HOUR_MS, endMs: D0 + 5 * HOUR_MS + 2 * DAY_MS };

    const result = await aggregate(fakeHcReads(hc), request(hc, { range }));

    expect(result.rows.map((row) => [row.bucket, row.values.count?.sum])).toStrictEqual([
      ["2026-03-10", 70],
      ["2026-03-11", 0],
    ]);
  });

  it("makes a day 25 hours long when the clocks go back, and loses none of it", async () => {
    // 2026-04-05 in this zone runs from 11:00Z on the 4th for 25 hours.
    const startMs = Date.UTC(2026, 3, 4, 11);
    const hc = store([steps("first", startMs, 1), steps("last", startMs + 24.5 * HOUR_MS, 2)], DST);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { range: { startMs, endMs: startMs + 25 * HOUR_MS } }),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      bucket: "2026-04-05",
      start: "2026-04-05T00:00:00+13:00",
      end: "2026-04-06T00:00:00+12:00",
    });
    expect(sums(result.rows)).toStrictEqual([3]);
  });

  it("starts weeks on Monday and months on the first", async () => {
    const hc = store([steps("a", D0, 5)]);
    const range = { startMs: Date.UTC(2026, 1, 25), endMs: Date.UTC(2026, 2, 12) };

    const weeks = await aggregate(fakeHcReads(hc), request(hc, { range, bucket: "week" }));
    const months = await aggregate(fakeHcReads(hc), request(hc, { range, bucket: "month" }));

    expect(weeks.rows.map((row) => row.bucket)).toStrictEqual([
      "2026-02-23",
      "2026-03-02",
      "2026-03-09",
    ]);
    expect(sums(weeks.rows)).toStrictEqual([0, 0, 5]);
    expect(months.rows.map((row) => [row.bucket, row.partial ?? false])).toStrictEqual([
      ["2026-02", true],
      ["2026-03", true],
    ]);
  });
});

describe("fill and has_data", () => {
  const hc = store([
    steps("a", D0 + HOUR_MS, 100),
    instant("w", "Weight", D0 + HOUR_MS, { weight: 70 }),
  ]);
  const range = { startMs: D0, endMs: D0 + 2 * DAY_MS };

  it("returns an empty bucket, zero-filled and marked", async () => {
    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { range, metrics: ["sum", "n", "mean", "records"] }),
    );

    expect(result.rows[1]).toMatchObject({
      hasData: false,
      origins: [],
      records: 0,
      values: { count: { sum: 0, n: 0, mean: null } },
    });
    expect(result.rows[1]?.method).toBeUndefined();
    expect(result.rows[0]).toMatchObject({ hasData: true, records: 1 });
  });

  it("fills with null when asked, counts included", async () => {
    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { range, fill: "null", metrics: ["sum", "records"] }),
    );

    expect(result.rows[1]).toMatchObject({ hasData: false, records: null });
    expect(result.rows[1]?.values.count?.sum).toBeNull();
  });

  it("never invents a mean, a minimum or a maximum for an empty bucket", async () => {
    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { range, type: "Weight", metrics: defaultMetrics("Weight") }),
    );

    expect(result.rows[0]?.values.weight).toStrictEqual({ mean: 70, min: 70, max: 70, n: 1 });
    expect(result.rows[1]?.values.weight).toStrictEqual({ mean: null, min: null, max: null, n: 0 });
  });
});

describe("exclude_future", () => {
  const hc = store([steps("past", D0 + HOUR_MS, 100), steps("future", D0 + 20 * HOUR_MS, 999)]);
  const range = { startMs: D0, endMs: D0 + 3 * DAY_MS };
  const nowMs = D0 + 12 * HOUR_MS;

  it("stops at now: no future bucket, no future record, and the cut day says partial", async () => {
    const result = await aggregate(fakeHcReads(hc), request(hc, { range, nowMs }));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ partial: true, end: "2026-03-10T12:00:00+00:00" });
    expect(sums(result.rows)).toStrictEqual([100]);
  });

  it("counts everything in the range when told not to", async () => {
    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { range, nowMs, excludeFuture: false }),
    );

    expect(sums(result.rows)).toStrictEqual([1099, 0, 0]);
  });
});

describe("origin modes", () => {
  const twoApps = [
    steps("w1", D0 + 8 * HOUR_MS, 500),
    steps("p1", D0 + 8 * HOUR_MS, 300, PHONE),
    steps("p2", D0 + 9 * HOUR_MS, 40, PHONE),
    // The second day only the phone was carried.
    steps("p3", D0 + DAY_MS + 8 * HOUR_MS, 250, PHONE),
  ];
  const range = { startMs: D0, endMs: D0 + 2 * DAY_MS };

  it("parses the three modes and nothing else", () => {
    expect(parseOriginMode("hc_priority")).toStrictEqual({ kind: "hc_priority" });
    expect(parseOriginMode("all_separately")).toStrictEqual({ kind: "all_separately" });
    expect(parseOriginMode(`origin:${PHONE}`)).toStrictEqual({ kind: "origin", origin: PHONE });
    expect(parseOriginMode("origin:")).toBeNull();
    expect(parseOriginMode("sum_everything")).toBeNull();
  });

  it("falls back to the one app with the most, HOUR by hour, and counts only what it overlapped", async () => {
    const hc = store(twoApps);

    const result = await aggregate(fakeHcReads(hc), request(hc, { range }));

    // 08:00 is the wearable's (500 beats 300); 09:00 only the phone recorded,
    // so its 40 steps are real and are kept -- not lost with the phone's day.
    expect(
      result.rows.map((row) => [row.method, row.origins, row.values.count?.sum]),
    ).toStrictEqual([
      ["max_origin", [PHONE, WEARABLE], 540],
      ["max_origin", [PHONE], 250],
    ]);
    // One record dropped: the phone's copy of the hour the wearable also counted.
    expect(result.rows[0]?.duplicatesDropped).toBe(1);
    expect(result.rows[1]?.duplicatesDropped).toBeUndefined();
    expect(result).toMatchObject({ duplicatesDropped: 1, usedPlatform: false, usedFallback: true });
  });

  it("uses the platform's own aggregate where the phone uploaded one", async () => {
    const hc = store([
      ...twoApps,
      platformHour("Steps", D0 + 8 * HOUR_MS, 520),
      platformHour("Steps", D0 + 9 * HOUR_MS, 40),
    ]);

    const result = await aggregate(fakeHcReads(hc), request(hc, { range }));

    expect(result.rows[0]).toMatchObject({
      method: "platform",
      origins: [PLATFORM],
      values: { count: { sum: 560 } },
    });
    // No platform figure for the second day: that bucket falls back, and says so.
    expect(result.rows[1]).toMatchObject({ method: "max_origin", values: { count: { sum: 250 } } });
    expect(result).toMatchObject({ usedPlatform: true, usedFallback: true, duplicatesDropped: 0 });
  });

  it("does not open hour by hour a day the platform answers whole", async () => {
    // Two apps both counting all day, and the platform's figure for every hour
    // they recorded in: there is no fallback, so there is nothing to choose.
    const records: HcRecord[] = [];
    for (let hour = 6; hour < 22; hour += 1) {
      records.push(
        steps(`w${String(hour)}`, D0 + hour * HOUR_MS, 500),
        steps(`p${String(hour)}`, D0 + hour * HOUR_MS, 300, PHONE),
        platformHour("Steps", D0 + hour * HOUR_MS, 520),
      );
    }
    const hc = store(records);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { range: { startMs: D0, endMs: D0 + DAY_MS } }),
    );

    expect(result.rows[0]).toMatchObject({ method: "platform", values: { count: { sum: 8320 } } });
    expect(result).toMatchObject({ usedFallback: false, duplicatesDropped: 0 });
    // Was every hour of every such day read, to choose an origin nobody asked for.
    expect(readers(hc)).toStrictEqual(["dayRollups"]);
  });

  it("composes a bucket the platform covers only part of, hour by hour", async () => {
    // The platform figure exists for 08:00 only; 09:00 has records and none.
    const hc = store([...twoApps, platformHour("Steps", D0 + 8 * HOUR_MS, 520)]);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { range: { startMs: D0, endMs: D0 + DAY_MS } }),
    );

    expect(result.rows[0]).toMatchObject({
      method: "platform_and_max_origin",
      origins: [PHONE, PLATFORM],
      values: { count: { sum: 560 } },
    });
    expect(result.usedFallback).toBe(true);
  });

  it("does not use the platform's hourly figure for a bucket narrower than its hour", async () => {
    const hc = store([...twoApps, platformHour("Steps", D0 + 8 * HOUR_MS, 520)]);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, {
        range: { startMs: D0 + 8 * HOUR_MS, endMs: D0 + 9 * HOUR_MS },
        bucket: "30min",
      }),
    );

    expect(result.rows.map((row) => row.method)).toStrictEqual(["max_origin", undefined]);
    expect(hc.calls.every((call) => call.type === "Steps")).toBe(true);
  });

  it("takes one app's records alone", async () => {
    const hc = store(twoApps);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { range, mode: { kind: "origin", origin: PHONE } }),
    );

    expect(result.rows.map((row) => [row.method, row.values.count?.sum])).toStrictEqual([
      ["origin", 340],
      ["origin", 250],
    ]);
    expect(result.duplicatesDropped).toBe(0);
  });

  it("returns a row per bucket per app, filled, when asked for them separately", async () => {
    const hc = store(twoApps);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { range, mode: { kind: "all_separately" } }),
    );

    expect(
      result.rows.map((row) => [row.bucket, row.origins[0], row.hasData, row.values.count?.sum]),
    ).toStrictEqual([
      ["2026-03-10", PHONE, true, 340],
      ["2026-03-10", WEARABLE, true, 500],
      ["2026-03-11", PHONE, true, 250],
      ["2026-03-11", WEARABLE, false, 0],
    ]);
  });

  it("merges every app for a measurement: two readings are two readings", async () => {
    const hc = store([
      instant("w1", "Weight", D0 + HOUR_MS, { weight: 70 }),
      instant("w2", "Weight", D0 + 2 * HOUR_MS, { weight: 72 }, { origin: PHONE }),
    ]);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { type: "Weight", metrics: ["mean", "n", "first", "last"] }),
    );

    expect(result.rows[0]).toMatchObject({
      method: "all_origins",
      origins: [PHONE, WEARABLE],
      values: { weight: { mean: 71, n: 2, first: 70, last: 72 } },
    });
    expect(result.duplicatesDropped).toBe(0);
  });
});

describe("bmr_fill", () => {
  const energy = (id: string, startMs: number, hours: number, kcal: number): HcRecord =>
    interval(id, "TotalCaloriesBurned", startMs, startMs + hours * HOUR_MS, { energy: kcal });
  const hc = store([energy("a", D0 + 6 * HOUR_MS, 12, 900)]);
  const base = { type: "TotalCaloriesBurned", range: { startMs: D0, endMs: D0 + 2 * DAY_MS } };

  it("reports what was recorded and nothing else by default", async () => {
    const result = await aggregate(fakeHcReads(hc), request(hc, base));

    expect(sums(result.rows, "energy")).toStrictEqual([900, 0]);
    expect(result.rows.every((row) => row.bmrFillKcal === undefined)).toBe(true);
  });

  it("pads only the time nothing recorded, and shows the padding", async () => {
    const result = await aggregate(fakeHcReads(hc), request(hc, { ...base, bmrKcalPerDay: 1600 }));

    // Half the first day was recorded, so half a day of basal energy is added.
    expect(result.rows[0]).toMatchObject({ bmrFillKcal: 800, values: { energy: { sum: 1700 } } });
    expect(result.rows[1]).toMatchObject({
      hasData: false,
      bmrFillKcal: 1600,
      values: { energy: { sum: 1600 } },
    });
  });

  it("applies to total calories only", async () => {
    const steps1 = store([steps("a", D0, 10)]);

    const result = await aggregate(fakeHcReads(steps1), request(steps1, { bmrKcalPerDay: 1600 }));

    expect(result.rows[0]?.bmrFillKcal).toBeUndefined();
    expect(sums(result.rows)).toStrictEqual([10]);
  });
});

describe("sessions", () => {
  it("aggregates sleep and exercise by how long they ran", async () => {
    const hc = store([
      interval("s1", "SleepSession", D0 + HOUR_MS, D0 + 8 * HOUR_MS, {}),
      interval("s2", "SleepSession", D0 + 14 * HOUR_MS, D0 + 15 * HOUR_MS, {}),
    ]);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { type: "SleepSession", metrics: defaultMetrics("SleepSession") }),
    );

    expect(defaultMetrics("SleepSession")).toStrictEqual(["duration", "records"]);
    expect(result.rows[0]).toMatchObject({ records: 2, durationMs: 8 * HOUR_MS });
  });
});

/** The local days `first`..`last` (YYYY-MM-DD) of a zone, as a range. */
function daysRange(first: string, last: string, timeZone: string) {
  return {
    startMs: dayBoundsMs(first, timeZone).startMs,
    endMs: dayBoundsMs(last, timeZone).endMs,
  };
}

const total = (result: AggregateResult, field = "count"): number =>
  result.rows.reduce((sum, row) => sum + (row.values[field]?.sum ?? 0), 0);

/** A small deterministic generator (a linear congruential one): the same data every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

/** An exercise session of one type by one app. */
function run(id: string, startMs: number, minutes: number, origin: string, type: string): HcRecord {
  const data = { exerciseType: type };
  return interval(id, "ExerciseSession", startMs, startMs + minutes * MINUTE_MS, data, { origin });
}

const allowed = (): boolean => true;

/** A series record at 08:00 with one sample a second. */
function samples(id: string, type: string, key: string, values: number[]): HcRecord {
  const from = D0 + 8 * HOUR_MS;
  return interval(id, type, from, from + 10 * MINUTE_MS, {
    samples: values.map((value, index) => ({ t: from + index * 1000, [key]: value })),
  });
}

describe("the fallback adds up: a month is the sum of its days and of its hours", () => {
  // The reviewer's case. One app recorded the first sixteen days of a month,
  // another the last fourteen: a thousand steps a day, no platform figure.
  const APRIL = Date.UTC(2026, 3, 1);
  /** After the month, so `exclude_future` cuts nothing of it. */
  const nowMs = Date.UTC(2026, 5, 1);
  const handover: HcRecord[] = [];
  for (let day = 0; day < 30; day += 1) {
    handover.push(
      steps(
        `d${String(day)}`,
        APRIL + day * DAY_MS + 12 * HOUR_MS,
        1000,
        day < 16 ? WEARABLE : PHONE,
      ),
    );
  }

  it.each([
    ["from day rollups, in the configured zone", UTC, undefined],
    ["from hour rollups, while day rollups are not usable", UTC, false],
  ] as const)("keeps both halves of a month two apps split, %s", async (_name, zone, usable) => {
    const range = daysRange("2026-04-01", "2026-04-30", zone);
    const by = async (bucket: CalendarBucket): Promise<AggregateResult> => {
      const hc = store(handover, zone);
      return aggregate(
        fakeHcReads(hc),
        request(hc, { range, bucket, nowMs, ...(usable === false && { dayRollupsUsable: false }) }),
      );
    };

    const month = await by("month");
    const weeks = await by("week");
    const days = await by("day");

    // Was 16,000 with fourteen "duplicates": the smaller half of the month erased.
    expect(sums(month.rows)).toStrictEqual([30_000]);
    expect(month.rows[0]).toMatchObject({ method: "max_origin", origins: [PHONE, WEARABLE] });
    expect(month.duplicatesDropped).toBe(0);
    expect(total(weeks)).toBe(30_000);
    expect(total(days)).toBe(30_000);
    expect(weeks.duplicatesDropped + days.duplicatesDropped).toBe(0);
  });

  it("answers the split month from day rollups alone: no day holds a choice", async () => {
    const hc = store(handover);

    await aggregate(
      fakeHcReads(hc),
      request(hc, { range: daysRange("2026-04-01", "2026-04-30", UTC), bucket: "month", nowMs }),
    );

    expect(readers(hc)).toStrictEqual(["dayRollups"]);
  });

  it("opens hour by hour only the days two apps both recorded", async () => {
    // Both apps on the 3rd; the wearable alone on every other day.
    const records = [
      ...handover.map((record) => ({ ...record, origin: WEARABLE })),
      steps("p-3a", APRIL + 2 * DAY_MS + 12 * HOUR_MS, 400, PHONE),
      steps("p-3b", APRIL + 2 * DAY_MS + 15 * HOUR_MS, 70, PHONE),
    ];
    const hc = store(records);

    const month = await aggregate(
      fakeHcReads(hc),
      request(hc, { range: daysRange("2026-04-01", "2026-04-30", UTC), bucket: "month", nowMs }),
    );

    // 12:00 on the 3rd is the wearable's; 15:00 only the phone recorded.
    expect(sums(month.rows)).toStrictEqual([30_070]);
    expect(month.duplicatesDropped).toBe(1);
    expect(hc.calls.filter((call) => call.reader === "hourRollups")).toStrictEqual([
      {
        reader: "hourRollups",
        type: "Steps",
        startMs: APRIL + 2 * DAY_MS,
        endMs: APRIL + 3 * DAY_MS,
      },
    ]);
    expect(readers(hc)).not.toContain("records");
  });

  const ORIGINS = [WEARABLE, PHONE, "com.example.tracker"];

  /** Thirty-odd days of three apps recording, dropping out and overlapping at random. */
  function randomSteps(seed: number, fromMs: number): HcRecord[] {
    const random = seeded(seed);
    const records: HcRecord[] = [];
    for (let hour = 0; hour < 34 * 24; hour += 1) {
      for (const origin of ORIGINS) {
        // Each app is on for some days and off for others, and records most hours it is on.
        const day = Math.floor(hour / 24);
        const on = (day + ORIGINS.indexOf(origin) * 5) % 9 < 5;
        if (!on || random() < 0.35) continue;
        const startMs = fromMs + hour * HOUR_MS + Math.floor(random() * 59) * MINUTE_MS;
        const count = 1 + Math.floor(random() * 900);
        records.push(steps(`${origin}-${String(records.length)}`, startMs, count, origin));
      }
    }
    return records;
  }

  /** What the rule says, worked out the long way: per UTC hour, the origin with the most. */
  function expected(records: readonly HcRecord[], range: { startMs: number; endMs: number }) {
    const hours = new Map<number, Map<string, { sum: number; records: number }>>();
    for (const record of records) {
      const startMs = recordStartMs(record);
      if (startMs < range.startMs || startMs >= range.endMs) continue;
      const hour = Math.floor(startMs / HOUR_MS);
      const origins = hours.get(hour) ?? new Map<string, { sum: number; records: number }>();
      hours.set(hour, origins);
      const own = origins.get(record.origin) ?? { sum: 0, records: 0 };
      origins.set(record.origin, {
        sum: own.sum + Number(record.data.count),
        records: own.records + 1,
      });
    }
    let sum = 0;
    let dropped = 0;
    for (const origins of hours.values()) {
      const ranked = [...origins];
      ranked.sort(
        ([leftName, left], [rightName, right]) =>
          right.sum - left.sum || (leftName < rightName ? -1 : 1),
      );
      sum += ranked[0]?.[1].sum ?? 0;
      for (const [, loser] of ranked.slice(1)) dropped += loser.records;
    }
    return { sum, dropped };
  }

  it.each([
    ["the configured zone, on the hour", UTC, UTC],
    ["another zone, on the hour", UTC, FIXED_WEST],
    ["another zone, on the half hour", UTC, HALF_HOUR],
    ["a configured zone on the half hour", HALF_HOUR, HALF_HOUR],
    ["a configured zone with a clock change in the month", DST, DST],
  ])("for random data from three apps in %s", async (_name, configured, zone) => {
    for (const seed of [1, 2, 3]) {
      const records = randomSteps(seed, Date.UTC(2026, 2, 30));
      const range = daysRange("2026-04-01", "2026-04-30", zone);
      const want = expected(records, range);
      const by = async (bucket: CalendarBucket): Promise<AggregateResult> => {
        const hc = store(records, configured);
        return aggregate(fakeHcReads(hc), request(hc, { range, bucket, tz: zone, nowMs }));
      };

      const answers = await Promise.all(
        (["month", "week", "day", "hour", "30min"] as const).map((bucket) => by(bucket)),
      );

      // Something was dropped and something kept, or the test proves nothing.
      expect(want.dropped).toBeGreaterThan(100);
      for (const answer of answers) {
        expect(total(answer)).toBe(want.sum);
        expect(answer.duplicatesDropped).toBe(want.dropped);
      }
      expect(answers[0]?.rows).toHaveLength(1);
    }
  });
});

describe("types whose records are not one activity counted twice", () => {
  it("keeps two different workouts from two apps on one day: both, and both counted", async () => {
    const hc = store([
      run("a", D0 + 8 * HOUR_MS, 40, WEARABLE, "RUNNING"),
      run("b", D0 + 17 * HOUR_MS, 25, PHONE, "WALKING"),
    ]);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { type: "ExerciseSession", metrics: defaultMetrics("ExerciseSession") }),
    );

    // Was: the shorter one dropped as a "duplicate" of the longer.
    expect(result.rows[0]).toMatchObject({
      method: "merged_sessions",
      origins: [PHONE, WEARABLE],
      records: 2,
      durationMs: 65 * MINUTE_MS,
    });
    expect(result.duplicatesDropped).toBe(0);
  });

  it("counts the same workout written by two apps once", async () => {
    const hc = store([
      run("a", D0 + 8 * HOUR_MS, 40, WEARABLE, "RUNNING"),
      run("a-copy", D0 + 8 * HOUR_MS + 2 * MINUTE_MS, 40, PHONE, "RUNNING"),
    ]);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { type: "ExerciseSession", metrics: defaultMetrics("ExerciseSession") }),
    );

    // One stretch of 42 minutes, not 80.
    expect(result.rows[0]).toMatchObject({ records: 1, durationMs: 42 * MINUTE_MS });
    expect(result.duplicatesDropped).toBe(1);
  });

  it("answers duration from the platform and the count from the store, by default", async () => {
    const hc = store([
      run("a", D0 + 8 * HOUR_MS, 40, WEARABLE, "RUNNING"),
      run("a-copy", D0 + 8 * HOUR_MS, 40, PHONE, "RUNNING"),
      platformHour("ExerciseDuration", D0 + 8 * HOUR_MS, 40 * MINUTE_MS),
    ]);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { type: "ExerciseSession", metrics: defaultMetrics("ExerciseSession") }),
    );

    // The default metrics used to make the platform's figure unreachable.
    expect(defaultMetrics("ExerciseSession")).toStrictEqual(["duration", "records"]);
    expect(result.rows[0]).toMatchObject({
      method: "platform",
      origins: [PLATFORM],
      durationMs: 40 * MINUTE_MS,
      records: 1,
    });
    expect(result).toMatchObject({ usedPlatform: true, usedFallback: false });
  });

  it("does not take the platform's hours for a day they cover only part of", async () => {
    const hc = store([
      run("a", D0 + 8 * HOUR_MS, 40, WEARABLE, "RUNNING"),
      run("b", D0 + 17 * HOUR_MS, 25, WEARABLE, "WALKING"),
      platformHour("ExerciseDuration", D0 + 17 * HOUR_MS, 25 * MINUTE_MS),
    ]);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { type: "ExerciseSession", metrics: ["duration", "records"] }),
    );

    expect(result.rows[0]).toMatchObject({
      method: "merged_sessions",
      durationMs: 65 * MINUTE_MS,
      records: 2,
    });
    expect(result.usedFallback).toBe(true);
  });

  it("adds up what two apps logged to drink: two entries are two drinks", async () => {
    const drink = (id: string, startMs: number, volume: number, origin: string): HcRecord =>
      interval(id, "Hydration", startMs, startMs + MINUTE_MS, { volume }, { origin });
    const hc = store([
      drink("a", D0 + 8 * HOUR_MS, 0.3, WEARABLE),
      drink("b", D0 + 8 * HOUR_MS + 20 * MINUTE_MS, 0.25, PHONE),
      drink("c", D0 + 13 * HOUR_MS, 0.5, PHONE),
    ]);

    const result = await aggregate(fakeHcReads(hc), request(hc, { type: "Hydration" }));

    expect(result.rows[0]).toMatchObject({ method: "all_origins", origins: [PHONE, WEARABLE] });
    expect(result.rows[0]?.values.volume?.sum).toBeCloseTo(1.05, 10);
    expect(result.duplicatesDropped).toBe(0);
  });
});

describe("a night belongs to the day it ended on", () => {
  // 23:00 on the 10th to 07:00 on the 11th, and a nap on the 11th.
  const night = interval("n1", "SleepSession", D0 + 23 * HOUR_MS, D0 + 31 * HOUR_MS, {});
  const nap = interval("n2", "SleepSession", D0 + 38 * HOUR_MS, D0 + 39 * HOUR_MS, {});
  const range = { startMs: D0, endMs: D0 + 2 * DAY_MS };

  it("files it there in every origin mode, and says which rule applied", async () => {
    const hc = store([night, nap]);
    const base = { type: "SleepSession", range, metrics: defaultMetrics("SleepSession") };

    const merged = await aggregate(fakeHcReads(hc), request(hc, base));
    const own = await aggregate(
      fakeHcReads(hc),
      request(hc, { ...base, mode: { kind: "origin", origin: WEARABLE } }),
    );
    const apart = await aggregate(
      fakeHcReads(hc),
      request(hc, { ...base, mode: { kind: "all_separately" } }),
    );

    // The start date would have put eight hours of sleep on the 10th.
    for (const result of [merged, own, apart]) {
      expect(result.bucketing).toBe("end_time");
      expect(result.rows.map((row) => [row.bucket, row.records, row.durationMs])).toStrictEqual([
        ["2026-03-10", 0, 0],
        ["2026-03-11", 2, 9 * HOUR_MS],
      ]);
    }
    expect(merged.sources).toStrictEqual(["session_summary"]);
  });

  it("is not answered from the platform's hours, which would split it at midnight", async () => {
    const hc = store([
      night,
      platformHour("SleepDuration", D0 + 23 * HOUR_MS, HOUR_MS),
      ...[24, 25, 26, 27, 28, 29, 30].map((hour) =>
        platformHour("SleepDuration", D0 + hour * HOUR_MS, HOUR_MS),
      ),
    ]);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { type: "SleepSession", range, metrics: ["duration"] }),
    );

    expect(result.rows.map((row) => row.durationMs)).toStrictEqual([0, 8 * HOUR_MS]);
    expect(result).toMatchObject({ usedPlatform: false, usedFallback: false });
    expect(hc.calls.every((call) => call.reader === "sleepNights")).toBe(true);
  });

  it("files everything else by its start", async () => {
    const hc = store([steps("a", D0 + 23 * HOUR_MS, 10)]);

    const result = await aggregate(fakeHcReads(hc), request(hc, { range }));

    expect(result.bucketing).toBe("start_time");
    expect(sums(result.rows)).toStrictEqual([10, 0]);
  });
});

describe("artefacts are left out of an aggregate, and counted", () => {
  const weights = [
    instant("w1", "Weight", D0 + 7 * HOUR_MS, { weight: 81.4 }, { origin: PHONE }),
    // Typed into a profile screen beside a height: not a weighing.
    instant("w-profile", "Weight", D0 + 12 * HOUR_MS, { weight: 60 }, { origin: PHONE }),
    instant("h1", "Height", D0 + 12 * HOUR_MS, { height: 1.8 }, { origin: PHONE }),
    instant("w2", "Weight", D0 + DAY_MS + 7 * HOUR_MS, { weight: 81.1 }, { origin: PHONE }),
  ];
  const range = { startMs: D0, endMs: D0 + 2 * DAY_MS };
  const weight = { type: "Weight", range, metrics: ["min", "max", "n"] as const };

  it("keeps a profile-setup weight out of the minimum, and says it did", async () => {
    const hc = store(weights);

    const result = await aggregate(fakeHcReads(hc), request(hc, { ...weight, allowed }));

    // Was `min: 60` with nothing to say it is not a measurement.
    expect(result.rows[0]).toMatchObject({
      values: { weight: { min: 81.4, max: 81.4, n: 1 } },
      artefactsExcluded: 1,
    });
    expect(result.rows[1]?.artefactsExcluded).toBeUndefined();
    expect(result).toMatchObject({ artefactsExcluded: 1, rulesNotApplied: [] });
  });

  it("opens only the day a height was written on", async () => {
    const hc = store(weights);

    await aggregate(fakeHcReads(hc), request(hc, { ...weight, allowed }));
    const raw = hc.calls.filter((call) => call.reader === "records");

    expect(raw.map((call) => call.type)).toStrictEqual(["Height", "Weight"]);
    // The hour of the profile entry, and nothing of the second day.
    expect(raw[1]).toMatchObject({ startMs: D0 + 12 * HOUR_MS, endMs: D0 + 13 * HOUR_MS });
  });

  it("keeps every value when asked to", async () => {
    const hc = store(weights);

    const result = await aggregate(
      fakeHcReads(hc),
      request(hc, { ...weight, allowed, excludeArtefacts: false }),
    );

    expect(result.rows[0]).toMatchObject({ values: { weight: { min: 60, n: 2 } } });
    expect(result.rows[0]?.artefactsExcluded).toBeUndefined();
    expect(result.artefactsExcluded).toBe(0);
  });

  it("does not read heights it may not see: the rule is not applied, and the result says so", async () => {
    const hc = store(weights);

    const denied = await aggregate(
      fakeHcReads(hc),
      request(hc, { ...weight, allowed: (type) => type !== "Height" }),
    );
    const unasked = await aggregate(fakeHcReads(hc), request(hc, weight));

    for (const result of [denied, unasked]) {
      expect(result.rows[0]).toMatchObject({ values: { weight: { min: 60, n: 2 } } });
      expect(result.rulesNotApplied).toStrictEqual(["weight_artefact_rule_not_applied"]);
    }
    expect(hc.calls.some((call) => call.type === "Height")).toBe(false);
  });

  it("takes implausible heart-rate and speed samples out of the extremes", async () => {
    const hc = store([
      samples("hr", "HeartRate", "bpm", [61, 232, 63, 0]),
      samples("hr-fine", "HeartRate", "bpm", [70]),
      samples("sp", "Speed", "speed", [2.5, 40, 3]),
    ]);
    const metrics = ["min", "max", "n"] as const;

    const heart = await aggregate(fakeHcReads(hc), request(hc, { type: "HeartRate", metrics }));
    const speed = await aggregate(fakeHcReads(hc), request(hc, { type: "Speed", metrics }));
    const kept = await aggregate(
      fakeHcReads(hc),
      request(hc, { type: "HeartRate", metrics, excludeArtefacts: false }),
    );

    expect(heart.rows[0]).toMatchObject({
      values: { bpm: { min: 61, max: 70, n: 3 } },
      artefactsExcluded: 2,
    });
    expect(speed.rows[0]).toMatchObject({
      values: { speed: { min: 2.5, max: 3, n: 2 } },
      artefactsExcluded: 1,
    });
    expect(kept.rows[0]).toMatchObject({ values: { bpm: { min: 0, max: 232, n: 5 } } });
  });
});
