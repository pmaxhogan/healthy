// The day that is still going on, and the promise `hc_aggregate` makes about
// it: a day is the sum of its hours as answered at the same instant, every
// bucket from the start of the range up to now is there, and a bucket is only
// called the platform's when the platform has a figure for every hour in which
// something was recorded.
//
// The failure these pin: the platform's hourly totals for today had holes in
// the middle (an hour the phone had once reported as empty), a day was judged
// "covered" by the first and last hour the platform had, and so it was summed
// from the platform's hours alone -- far below the sum of the very hours the
// same tool answered one by one.
//
// Synthetic throughout; zones are test parameters.

import { describe, expect, it } from "vitest";

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
  platformHour,
} from "../hc-fake.ts";

import type { CalendarBucket } from "../../../../src/hc/rollup/day.ts";
import type { HcRecord } from "../../../../src/hc/wire.ts";
import type { AggregateRequest, AggregateResult } from "../../../../src/mcp/hc/aggregate.ts";
import type { FakeHc } from "../hc-fake.ts";

const FIXED_WEST = "Etc/GMT+5";
const DEVICE = "dev_1";
const DAY_MS = 24 * HOUR_MS;
/** An arbitrary local midnight in a zone five hours west of UTC. */
const D0 = Date.UTC(2026, 2, 10, 5);
/** Now: half past four in the afternoon of that day, give or take. */
const NOW = D0 + 16 * HOUR_MS + 31 * MINUTE_MS;

const at = (hour: number, minute = 0): number => D0 + hour * HOUR_MS + minute * MINUTE_MS;

const steps = (id: string, startMs: number, count: number, origin = WEARABLE): HcRecord =>
  interval(id, "Steps", startMs, startMs + MINUTE_MS, { count }, { origin });

/** A wearable and a phone both counting, every hour from midnight to the hour now is in. */
function walked(): HcRecord[] {
  const records: HcRecord[] = [];
  for (let hour = 0; hour <= 16; hour += 1) {
    records.push(
      steps(`w-${String(hour)}`, at(hour, 5), 700),
      steps(`p-${String(hour)}`, at(hour, 10), 400, PHONE),
    );
  }
  return records;
}

function store(records: readonly HcRecord[]): FakeHc {
  const hc = emptyHc();
  hc.timezone = FIXED_WEST;
  addDevice(hc, device(DEVICE, "Test phone", 1), records);
  return hc;
}

function ask(
  hc: FakeHc,
  bucket: CalendarBucket,
  overrides: Partial<AggregateRequest> = {},
): Promise<AggregateResult> {
  return aggregate(fakeHcReads(hc), {
    deviceId: DEVICE,
    type: "Steps",
    range: { startMs: D0, endMs: D0 + DAY_MS },
    bucket,
    mode: { kind: "hc_priority" },
    metrics: ["sum"],
    fill: "zero",
    excludeFuture: true,
    nowMs: NOW,
    clock: zoneClock(FIXED_WEST),
    dayRollupsUsable: true,
    bmrKcalPerDay: null,
    ...overrides,
  });
}

const total = (result: AggregateResult): number =>
  result.rows.reduce((sum, row) => sum + (row.values.count?.sum ?? 0), 0);

describe("today, with the platform's totals missing for hours in the middle", () => {
  // The platform has a figure for the small hours and for the hour now is in,
  // and none for 04:00 to 15:00, where both apps recorded all the same.
  const holed = [
    ...walked(),
    ...[0, 1, 2, 3, 16].map((hour) => platformHour("Steps", at(hour), 750)),
  ];

  it("answers a day that is the sum of its hours", async () => {
    const hc = store(holed);

    const day = await ask(hc, "day");
    const hours = await ask(hc, "hour");
    const halves = await ask(hc, "30min");

    // Five hours from the platform, twelve from the app that counted most.
    expect(total(hours)).toBe(5 * 750 + 12 * 700);
    expect(total(day)).toBe(total(hours));
    // Thirty-minute buckets are narrower than the platform's hour, so they are
    // the larger app's own count throughout.
    expect(total(halves)).toBe(17 * 700);
  });

  it("does not call that day the platform's", async () => {
    const hc = store(holed);

    const day = await ask(hc, "day");

    expect(day.rows).toHaveLength(1);
    expect(day.rows[0]).toMatchObject({
      partial: true,
      hasData: true,
      method: "platform_and_max_origin",
    });
    expect(day.usedFallback).toBe(true);
  });

  it("returns every hour from the start of the day to now, the last one cut short", async () => {
    const hc = store(holed);

    const hours = await ask(hc, "hour");

    expect(hours.rows).toHaveLength(17);
    expect(hours.rows.map((row) => row.hasData)).toStrictEqual(
      Array.from({ length: 17 }, () => true),
    );
    expect(hours.rows.map((row) => row.method)).toStrictEqual([
      ...Array.from({ length: 4 }, () => "platform"),
      ...Array.from({ length: 12 }, () => "max_origin"),
      "platform",
    ]);
    expect(hours.rows.at(-1)).toMatchObject({ partial: true });
    expect(hours.rows.slice(0, -1).some((row) => row.partial === true)).toBe(false);
  });

  it("returns the hours nothing was recorded in too, as empty rows", async () => {
    // Nothing after 09:00 at all: the hours up to now are still listed.
    const hc = store(walked().filter((record) => (record.start ?? 0) < at(9)));

    const hours = await ask(hc, "hour");

    expect(hours.rows).toHaveLength(17);
    expect(hours.rows.slice(9).every((row) => !row.hasData && row.values.count?.sum === 0)).toBe(
      true,
    );
  });

  it("is the platform's when the platform has every hour something was recorded in", async () => {
    const hc = store([
      ...walked(),
      ...Array.from({ length: 17 }, (_, hour) => platformHour("Steps", at(hour), 750)),
    ]);

    const day = await ask(hc, "day");
    const hours = await ask(hc, "hour");

    expect(day.rows[0]).toMatchObject({ partial: true, method: "platform" });
    expect(total(day)).toBe(17 * 750);
    expect(total(hours)).toBe(17 * 750);
    expect(day.usedFallback).toBe(false);
  });
});

describe("a whole day answered from day rollups, with a hole in the platform's hours", () => {
  // Yesterday, complete: the platform has 08:00 and 18:00, and nothing for the
  // hours between, where the wearable recorded.
  const yesterday = D0 - DAY_MS;
  const records = [
    ...[8, 12, 18].map((hour) => steps(`w-${String(hour)}`, yesterday + hour * HOUR_MS, 600)),
    platformHour("Steps", yesterday + 8 * HOUR_MS, 640),
    platformHour("Steps", yesterday + 18 * HOUR_MS, 610),
  ];
  const range = { startMs: yesterday, endMs: D0 };

  it("is the sum of its hours all the same", async () => {
    const hc = store(records);

    const day = await ask(hc, "day", { range });
    const hours = await ask(hc, "hour", { range });

    expect(total(hours)).toBe(640 + 600 + 610);
    expect(total(day)).toBe(total(hours));
    expect(day.rows[0]).toMatchObject({ method: "platform_and_max_origin" });
    expect(day.rows[0]?.partial).toBeUndefined();
  });

  it("stays on day rollups when the platform has every hour", async () => {
    const hc = store([...records, platformHour("Steps", yesterday + 12 * HOUR_MS, 600)]);

    const day = await ask(hc, "day", { range });

    expect(day.rows[0]).toMatchObject({ method: "platform", values: { count: { sum: 1850 } } });
    // Nothing of the day itself is read hour by hour: the only hour rollups
    // read are those of the two days before it, where a record that runs into
    // the day would be listed.
    const hourly = hc.calls.filter((call) => call.reader === "hourRollups");
    expect(hourly.map((call) => call.endMs)).toStrictEqual([yesterday]);
    expect(hc.calls.some((call) => call.reader === "records")).toBe(false);
  });
});
