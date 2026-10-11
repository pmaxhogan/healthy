// A running count's record that runs past its bucket is divided among the
// buckets it spans, and a record longer than an hour does not beat an app that
// measured the hour.
//
// The failure these pin: one app writes a day's energy as ONE record from
// midnight to midnight (an estimate of basal energy), another writes what it
// measured every hour, basal included. The day-long record was counted whole
// in the hour it starts in, was the largest thing in that hour, and so won it
// -- and the day gained a second copy of a day's basal energy.
//
// Synthetic throughout; zones are test parameters.

import { describe, expect, it } from "vitest";

import { dayBoundsMs } from "../../../../src/hc/rollup/day.ts";
import { aggregate } from "../../../../src/mcp/hc/aggregate.ts";
import { zoneClock } from "../../../../src/mcp/hc/time.ts";
import {
  HOUR_MS,
  MINUTE_MS,
  PHONE,
  WEARABLE,
  addDevice,
  device,
  emptyHc,
  fakeHcReads,
  interval,
} from "../hc-fake.ts";

import type { CalendarBucket } from "../../../../src/hc/rollup/day.ts";
import type { HcRecord } from "../../../../src/hc/wire.ts";
import type { AggregateRequest, AggregateResult } from "../../../../src/mcp/hc/aggregate.ts";
import type { FakeHc } from "../hc-fake.ts";

const UTC = "UTC";
const FIXED_WEST = "Etc/GMT+5";
const HALF_HOUR = "Asia/Kolkata";
const DEVICE = "dev_1";
const DAY_MS = 24 * HOUR_MS;
/** 2026-03-10T00:00Z: an arbitrary Tuesday. */
const D0 = Date.UTC(2026, 2, 10);
const NOW = D0 + 60 * DAY_MS;

const TOTAL = "TotalCaloriesBurned";

const energy = (id: string, startMs: number, endMs: number, kcal: number, origin: string) =>
  interval(id, TOTAL, startMs, endMs, { energy: kcal }, { origin });
const steps = (id: string, startMs: number, endMs: number, count: number, origin = WEARABLE) =>
  interval(id, "Steps", startMs, endMs, { count }, { origin });

function store(records: readonly HcRecord[], timezone = UTC): FakeHc {
  const hc = emptyHc();
  hc.timezone = timezone;
  addDevice(hc, device(DEVICE, "Test phone", 1), records);
  return hc;
}

function ask(
  hc: FakeHc,
  bucket: CalendarBucket,
  overrides: Partial<AggregateRequest> & { tz?: string } = {},
): Promise<AggregateResult> {
  const timeZone = overrides.tz ?? hc.timezone;
  return aggregate(fakeHcReads(hc), {
    deviceId: DEVICE,
    type: TOTAL,
    range: { startMs: D0, endMs: D0 + DAY_MS },
    bucket,
    mode: { kind: "hc_priority" },
    metrics: ["sum"],
    fill: "zero",
    excludeFuture: true,
    nowMs: NOW,
    clock: zoneClock(timeZone),
    dayRollupsUsable: timeZone === hc.timezone,
    bmrKcalPerDay: null,
    ...overrides,
  });
}

const sums = (result: AggregateResult, field = "energy"): number[] =>
  result.rows.map((row) => row.values[field]?.sum ?? 0);
const total = (result: AggregateResult, field = "energy"): number =>
  sums(result, field).reduce((sum, value) => sum + value, 0);

/** The wearable's hours: 100 kcal each, basal included, for the hours given. */
const measured = (hours: readonly number[], day = D0): HcRecord[] =>
  hours.map((hour) =>
    energy(
      `w-${String(day)}-${String(hour)}`,
      day + hour * HOUR_MS,
      day + (hour + 1) * HOUR_MS,
      100,
      WEARABLE,
    ),
  );
const everyHour = Array.from({ length: 24 }, (_, hour) => hour);
/** The phone's estimate for a whole day, as one record: 70 kcal an hour. */
const dayLong = (day = D0): HcRecord =>
  energy(`p-${String(day)}`, day, day + DAY_MS, 24 * 70, PHONE);

describe("a day's total written as one record, beside an app that measured every hour", () => {
  const records = [...measured(everyHour), dayLong()];

  it("does not win the hour it starts in: the day is what was measured", async () => {
    const hc = store(records);

    const day = await ask(hc, "day");
    const hours = await ask(hc, "hour");

    // Was 2,400 + 1,680 - 100: the whole day-long record in the midnight hour.
    expect(sums(day)).toStrictEqual([2400]);
    expect(sums(hours)).toStrictEqual(everyHour.map(() => 100));
    expect(day.rows[0]).toMatchObject({ method: "max_origin", origins: [WEARABLE] });
    expect(day.rows[0]?.longRecordSum).toBeUndefined();
    expect(day.longRecordRows).toBe(0);
    // The day-long record is one record left out, in the hour it starts in.
    expect(day.duplicatesDropped).toBe(1);
  });

  it("is a twenty-fourth in each hour when it is asked for by itself", async () => {
    const hc = store(records);
    const mode = { kind: "origin", origin: PHONE } as const;

    const hours = await ask(hc, "hour", { mode, metrics: ["sum", "records", "n", "duration"] });
    const day = await ask(hc, "day", { mode });

    for (const share of sums(hours)) expect(share).toBeCloseTo(70, 9);
    expect(total(hours)).toBeCloseTo(1680, 6);
    expect(sums(day)).toStrictEqual([1680]);
    // The record itself is counted once, where it starts.
    expect(hours.rows.map((row) => row.records)).toStrictEqual([
      1,
      ...everyHour.slice(1).map(() => 0),
    ]);
    expect(hours.rows.map((row) => row.values.energy?.n)).toStrictEqual([
      1,
      ...everyHour.slice(1).map(() => 0),
    ]);
    expect(hours.rows.map((row) => row.durationMs)).toStrictEqual(everyHour.map(() => HOUR_MS));
    expect(hours.rows.every((row) => row.hasData)).toBe(true);
    // And every hour says its figure comes from a record longer than an hour.
    expect(hours.rows[5]?.longRecordSum).toBeCloseTo(70, 9);
    expect(day.rows[0]?.longRecordSum).toBeCloseTo(1680, 6);
  });

  it("fills only the hours nobody measured, and the row says how much that is", async () => {
    // The wearable was off from 03:00 to 06:00.
    const worn = everyHour.filter((hour) => hour < 3 || hour >= 6);
    const hc = store([...measured(worn), dayLong()]);

    const day = await ask(hc, "day");
    const hours = await ask(hc, "hour");

    expect(total(day)).toBeCloseTo(21 * 100 + 3 * 70, 6);
    expect(total(hours)).toBeCloseTo(total(day), 6);
    expect(sums(hours)[4]).toBeCloseTo(70, 9);
    expect(hours.rows[4]).toMatchObject({ method: "max_origin", origins: [PHONE] });
    expect(day.rows[0]).toMatchObject({ origins: [PHONE, WEARABLE] });
    expect(day.rows[0]?.longRecordSum).toBeCloseTo(210, 6);
    expect(day.longRecordRows).toBe(1);
  });

  it("still loses to a smaller figure that was measured in the hour", async () => {
    // 40 kcal measured in an hour beats the 70 that is a day's total spread out.
    const hc = store([energy("w", D0 + 2 * HOUR_MS, D0 + 3 * HOUR_MS, 40, WEARABLE), dayLong()]);

    const hours = await ask(hc, "hour");

    expect(sums(hours)[2]).toBe(40);
    expect(hours.rows[2]).toMatchObject({ origins: [WEARABLE] });
    expect(sums(hours)[3]).toBeCloseTo(70, 9);
  });

  it("gives one row per app, each divided the same way, under all_separately", async () => {
    const hc = store(records);

    const hours = await ask(hc, "hour", { mode: { kind: "all_separately" } });
    const phone = hours.rows.filter((row) => row.origins[0] === PHONE);

    expect(phone).toHaveLength(24);
    for (const row of phone) expect(row.values.energy?.sum).toBeCloseTo(70, 9);
  });
});

describe("a month of that, answered at every level", () => {
  const days = Array.from({ length: 9 }, (_, index) => D0 + index * DAY_MS);
  // The wearable is worn on every day but the fourth, where it is off all
  // day, and is off for six hours of the seventh.
  const wornOn = new Map<number, number[]>([
    [3, []],
    [6, everyHour.filter((hour) => hour >= 6)],
  ]);
  const records = days.flatMap((day, index) => [
    ...measured(wornOn.get(index) ?? everyHour, day),
    dayLong(day),
  ]);
  const range = { startMs: D0, endMs: D0 + 9 * DAY_MS };
  const expected = 7 * 2400 + 1680 + (18 * 100 + 6 * 70);

  it.each([true, false])(
    "is the same from day rollups (%s) as from hours, and by day as by hour",
    async (dayRollupsUsable) => {
      const hc = store(records);

      const whole = await ask(hc, "month", { range, dayRollupsUsable });
      const byDay = await ask(hc, "day", { range, dayRollupsUsable });
      const byHour = await ask(hc, "hour", { range });

      expect(total(whole)).toBeCloseTo(expected, 4);
      expect(total(byDay)).toBeCloseTo(expected, 4);
      expect(total(byHour)).toBeCloseTo(expected, 4);
      expect(sums(byDay)[3]).toBeCloseTo(1680, 6);
      expect(sums(byDay)[6]).toBeCloseTo(18 * 100 + 6 * 70, 6);
      expect(byDay.rows[0]?.longRecordSum).toBeUndefined();
      expect(byDay.rows[3]?.longRecordSum).toBeCloseTo(1680, 6);
      expect(byDay.rows[6]?.longRecordSum).toBeCloseTo(420, 6);
    },
  );

  it("is the same in a zone whose days begin on another hour", async () => {
    const hc = store(records);
    // Local days five hours west begin at 05:00Z, so each day-long record is
    // split between two of them.
    const local = {
      startMs: dayBoundsMs("2026-03-10", FIXED_WEST).startMs,
      endMs: dayBoundsMs("2026-03-17", FIXED_WEST).endMs,
    };

    const byDay = await ask(hc, "day", { range: local, tz: FIXED_WEST });
    const byHour = await ask(hc, "hour", { range: local, tz: FIXED_WEST });

    expect(total(byDay)).toBeCloseTo(total(byHour), 4);
    // 2026-03-13 local is the last nineteen hours of the day the wearable was
    // off (the phone's share) and five measured hours of the next.
    expect(sums(byDay)[3]).toBeCloseTo(19 * 70 + 5 * 100, 6);
  });
});

describe("a record that runs across a boundary", () => {
  it("is divided between two days by the time it spends in each", async () => {
    // Half an hour either side of midnight; and one wholly inside the first day.
    const records = [
      steps("late", D0 + 23.5 * HOUR_MS, D0 + 24.5 * HOUR_MS, 600),
      steps("noon", D0 + 12 * HOUR_MS, D0 + 12 * HOUR_MS + MINUTE_MS, 50),
    ];
    const range = { startMs: D0, endMs: D0 + 2 * DAY_MS };
    const request = { type: "Steps", range, metrics: ["sum", "records"] as const };

    for (const dayRollupsUsable of [true, false]) {
      const hc = store(records);
      const days = await ask(hc, "day", { ...request, dayRollupsUsable });

      expect(sums(days, "count")).toStrictEqual([350, 300]);
      // The record is one record, on the day it starts.
      expect(days.rows.map((row) => row.records)).toStrictEqual([2, 0]);
      expect(days.rows[1]).toMatchObject({ hasData: true, origins: [WEARABLE] });
    }
  });

  it("brings into a range the share of a record that started before it", async () => {
    const records = [steps("late", D0 - HOUR_MS, D0 + 2 * HOUR_MS, 900)];

    for (const dayRollupsUsable of [true, false]) {
      const hc = store(records);
      const day = await ask(hc, "day", { type: "Steps", dayRollupsUsable });
      const hours = await ask(hc, "hour", { type: "Steps" });

      expect(sums(day, "count")).toStrictEqual([600]);
      expect(sums(hours, "count").slice(0, 3)).toStrictEqual([300, 300, 0]);
    }
  });

  it("leaves out the share that falls after the range", async () => {
    const hc = store([steps("late", D0 + 23 * HOUR_MS, D0 + 25 * HOUR_MS, 400)]);

    const day = await ask(hc, "day", { type: "Steps" });

    expect(sums(day, "count")).toStrictEqual([200]);
  });

  it("is divided between buckets narrower than an hour", async () => {
    // Ten minutes in the first half hour, twenty in the second.
    const hc = store([
      steps("walk", D0 + 10 * HOUR_MS + 20 * MINUTE_MS, D0 + 10 * HOUR_MS + 50 * MINUTE_MS, 300),
    ]);
    const range = { startMs: D0 + 10 * HOUR_MS, endMs: D0 + 11 * HOUR_MS };

    const halves = await ask(hc, "30min", { type: "Steps", range });

    expect(sums(halves, "count")[0]).toBeCloseTo(100, 9);
    expect(sums(halves, "count")[1]).toBeCloseTo(200, 9);
  });

  it("is divided at the edges of days that do not begin on a UTC hour", async () => {
    // Local days on +05:30 begin at 18:30Z. An hour's record across that edge.
    const edge = D0 + 18.5 * HOUR_MS;
    const hc = store([steps("walk", edge - 15 * MINUTE_MS, edge + 45 * MINUTE_MS, 400)], HALF_HOUR);
    const range = { startMs: edge - DAY_MS, endMs: edge + DAY_MS };

    const days = await ask(hc, "day", { type: "Steps", range });

    expect(sums(days, "count")[0]).toBeCloseTo(100, 9);
    expect(sums(days, "count")[1]).toBeCloseTo(300, 9);
  });

  it("is not divided at all when it claims to run for more than two days", async () => {
    const hc = store([steps("week", D0 + HOUR_MS, D0 + 7 * DAY_MS, 7000)]);
    const range = { startMs: D0, endMs: D0 + 3 * DAY_MS };

    const days = await ask(hc, "day", { type: "Steps", range });

    expect(sums(days, "count")).toStrictEqual([7000, 0, 0]);
    expect(days.rows[0]?.longRecordSum).toBe(7000);
  });

  it("leaves a record that ends within its hour exactly as it was", async () => {
    const hc = store([steps("a", D0 + 9 * HOUR_MS, D0 + 9 * HOUR_MS + 5 * MINUTE_MS, 123)]);

    const hours = await ask(hc, "hour", { type: "Steps", metrics: ["sum", "n", "mean", "max"] });

    expect(hours.rows[9]?.values.count).toStrictEqual({ sum: 123, n: 1, mean: 123, max: 123 });
    expect(hours.rows[9]?.longRecordSum).toBeUndefined();
  });

  it("is never applied to a logged entry: a drink is where it was logged", async () => {
    const hc = store([
      interval("d", "Hydration", D0 + 23.5 * HOUR_MS, D0 + 24.5 * HOUR_MS, { volume: 0.5 }),
    ]);
    const range = { startMs: D0, endMs: D0 + 2 * DAY_MS };

    const days = await ask(hc, "day", { type: "Hydration", range });

    expect(sums(days, "volume")).toStrictEqual([0.5, 0]);
  });
});

describe("the basal fill, beside a record that covers the day", () => {
  it("pads nothing where the day-long record already accounts for the time", async () => {
    const hc = store([dayLong()]);

    const hours = await ask(hc, "hour", { bmrKcalPerDay: 1200 });

    // Was 1,680 in the first hour and fifty of padding in each of the others.
    expect(hours.rows.every((row) => row.bmrFillKcal === undefined)).toBe(true);
    expect(total(hours)).toBeCloseTo(1680, 6);
  });
});
