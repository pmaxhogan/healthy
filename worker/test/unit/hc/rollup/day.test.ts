// Local-day arithmetic. Every expected instant is written out as UTC plus an
// explicit offset, never obtained from the functions under test. The zones are
// chosen for their rules (fixed, half-hour, southern-hemisphere DST, a
// half-hour DST shift, DST at midnight, a skipped day), not for any place.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEEK_START,
  calendarBuckets,
  dayBoundsMs,
  daysTouched,
  localDay,
} from "../../../../src/hc/rollup/day.ts";

const HOUR = 3_600_000;
const MIN = 60_000;

/** UTC-5 all year. (POSIX sign: "GMT+5" is five hours WEST.) */
const FIXED_WEST = "Etc/GMT+5";
/** UTC+5:30 all year. */
const HALF_HOUR = "Asia/Kolkata";
/** UTC+5:45 all year. */
const QUARTER_HOUR = "Asia/Kathmandu";
/** UTC+12, UTC+13 in summer. Back at 03:00 on 2026-04-05, forward at 02:00 on 2026-09-27. */
const DST = "Pacific/Auckland";
/** UTC+10:30, UTC+11 in summer: a half-hour shift. Back at 02:00 on 2026-04-05. */
const HALF_HOUR_DST = "Australia/Lord_Howe";
/** UTC-5, UTC-4 in summer, changing AT midnight: forward 2026-03-08, back 2026-11-01. */
const MIDNIGHT_DST = "America/Havana";
/** Jumped the date line: 2011-12-30 did not happen there. */
const SKIPPED_DAY = "Pacific/Apia";
/** UTC, UTC+1 in summer. Forward at 01:00 UTC on 2026-03-29. */
const NORTHERN_DST = "Europe/London";

/**
Zones whose clocks once went back ACROSS midnight, so the date on the wall
clock ran backwards: a change at 00:01 back to 23:01 of the day before, or
(the last) three hours back from 02:00. Each with the instant it happened.
*/
const BACKWARD_DATES: readonly (readonly [string, number])[] = [
  ["America/Goose_Bay", Date.UTC(2010, 10, 7, 3, 1)],
  ["America/St_Johns", Date.UTC(2010, 10, 7, 2, 31)],
  ["America/Moncton", Date.UTC(2006, 9, 29, 3, 1)],
  ["Antarctica/Casey", Date.UTC(2010, 2, 4, 15, 0)],
];

/** Instants every seven minutes for thirty hours either side of `at`. */
function around(at: number): number[] {
  const instants: number[] = [];
  for (let t = at - 30 * HOUR; t <= at + 30 * HOUR; t += 7 * MIN) instants.push(t);
  return instants;
}

describe("localDay", () => {
  it("reads the date in the zone, not in UTC", () => {
    const ms = Date.UTC(2026, 0, 15, 3, 0); // 22:00 the evening before, five hours west
    expect(localDay(ms, FIXED_WEST)).toBe("2026-01-14");
    expect(localDay(ms, "UTC")).toBe("2026-01-15");
    expect(localDay(Date.UTC(2026, 0, 15, 18, 29), HALF_HOUR)).toBe("2026-01-15");
    expect(localDay(Date.UTC(2026, 0, 15, 18, 30), HALF_HOUR)).toBe("2026-01-16");
  });

  it("turns over at the zone's own midnight to the millisecond", () => {
    const midnight = Date.UTC(2026, 5, 10, 5, 0); // 00:00 five hours west
    expect(localDay(midnight - 1, FIXED_WEST)).toBe("2026-06-09");
    expect(localDay(midnight, FIXED_WEST)).toBe("2026-06-10");
  });

  it("refuses an unknown zone and a non-finite instant", () => {
    expect(() => localDay(0, "Not/AZone")).toThrow(/time zone/u);
    expect(() => localDay(NaN, "UTC")).toThrow(/finite/u);
  });
});

describe("dayBoundsMs", () => {
  it("is 24 hours in a fixed zone", () => {
    expect(dayBoundsMs("2026-06-10", FIXED_WEST)).toEqual({
      startMs: Date.UTC(2026, 5, 10, 5, 0),
      endMs: Date.UTC(2026, 5, 11, 5, 0),
    });
  });

  it("handles half-hour and quarter-hour offsets", () => {
    expect(dayBoundsMs("2026-06-10", HALF_HOUR)).toEqual({
      startMs: Date.UTC(2026, 5, 10) - 5.5 * HOUR,
      endMs: Date.UTC(2026, 5, 11) - 5.5 * HOUR,
    });
    expect(dayBoundsMs("2026-06-10", QUARTER_HOUR).startMs).toBe(
      Date.UTC(2026, 5, 10) - (5 * HOUR + 45 * MIN),
    );
  });

  it("gives a 23-hour day when the clocks go forward", () => {
    const bounds = dayBoundsMs("2026-09-27", DST);
    expect(bounds.startMs).toBe(Date.UTC(2026, 8, 27) - 12 * HOUR);
    expect(bounds.endMs).toBe(Date.UTC(2026, 8, 28) - 13 * HOUR);
    expect(bounds.endMs - bounds.startMs).toBe(23 * HOUR);
  });

  it("gives a 25-hour day when the clocks go back", () => {
    const bounds = dayBoundsMs("2026-04-05", DST);
    expect(bounds.startMs).toBe(Date.UTC(2026, 3, 5) - 13 * HOUR);
    expect(bounds.endMs).toBe(Date.UTC(2026, 3, 6) - 12 * HOUR);
    expect(bounds.endMs - bounds.startMs).toBe(25 * HOUR);
  });

  it("gives a 24.5-hour day when a half-hour shift goes back", () => {
    const bounds = dayBoundsMs("2026-04-05", HALF_HOUR_DST);
    expect(bounds.startMs).toBe(Date.UTC(2026, 3, 5) - 11 * HOUR);
    expect(bounds.endMs - bounds.startMs).toBe(24.5 * HOUR);
  });

  it("starts the day at the transition when midnight itself is skipped", () => {
    // 00:00 never happens: the clocks read 01:00 at 05:00 UTC.
    const bounds = dayBoundsMs("2026-03-08", MIDNIGHT_DST);
    expect(bounds.startMs).toBe(Date.UTC(2026, 2, 8, 5, 0));
    expect(bounds.endMs).toBe(Date.UTC(2026, 2, 9, 4, 0));
    expect(localDay(bounds.startMs - 1, MIDNIGHT_DST)).toBe("2026-03-07");
  });

  it("starts the day at the first midnight when midnight happens twice", () => {
    // 00:00 at 04:00 UTC (summer time), then again at 05:00 UTC.
    const bounds = dayBoundsMs("2026-11-01", MIDNIGHT_DST);
    expect(bounds.startMs).toBe(Date.UTC(2026, 10, 1, 4, 0));
    expect(bounds.endMs).toBe(Date.UTC(2026, 10, 2, 5, 0));
    expect(bounds.endMs - bounds.startMs).toBe(25 * HOUR);
  });

  it("gives an empty day when the zone skipped the date", () => {
    const jump = Date.UTC(2011, 11, 30, 10, 0);
    expect(dayBoundsMs("2011-12-30", SKIPPED_DAY)).toEqual({ startMs: jump, endMs: jump });
    expect(dayBoundsMs("2011-12-29", SKIPPED_DAY).endMs).toBe(jump);
    expect(dayBoundsMs("2011-12-31", SKIPPED_DAY).startMs).toBe(jump);
  });

  it("knows the leap day", () => {
    expect(dayBoundsMs("2028-02-29", FIXED_WEST)).toEqual({
      startMs: Date.UTC(2028, 1, 29, 5, 0),
      endMs: Date.UTC(2028, 2, 1, 5, 0),
    });
  });

  it("refuses a date the calendar does not have", () => {
    for (const bad of ["2027-02-29", "2026-13-01", "2026-6-1", "20260601", ""]) {
      expect(() => dayBoundsMs(bad, "UTC")).toThrow(/calendar date/u);
    }
  });

  it("agrees with localDay at both edges of every day of a DST year", () => {
    for (const zone of [DST, HALF_HOUR_DST, MIDNIGHT_DST, NORTHERN_DST, HALF_HOUR]) {
      let previousEnd: number | null = null;
      for (let civil = Date.UTC(2026, 0, 1); civil < Date.UTC(2027, 0, 1); civil += 24 * HOUR) {
        const day = new Date(civil).toISOString().slice(0, 10);
        const { startMs, endMs } = dayBoundsMs(day, zone);
        expect(localDay(startMs, zone)).toBe(day);
        expect(localDay(endMs - 1, zone)).toBe(day);
        expect(localDay(startMs - 1, zone)).not.toBe(day);
        // Days tile the year: each starts where the one before ended.
        expect(startMs).toBe(previousEnd ?? startMs);
        previousEnd = endMs;
      }
    }
  });
});

describe("daysTouched", () => {
  const midnight = Date.UTC(2026, 5, 10, 5, 0); // 2026-06-10 00:00, five hours west

  it("lists one day for an instant", () => {
    expect(daysTouched(midnight, midnight, FIXED_WEST)).toEqual(["2026-06-10"]);
    expect(daysTouched(midnight - 1, midnight - 1, FIXED_WEST)).toEqual(["2026-06-09"]);
  });

  it("treats the end as exclusive", () => {
    expect(daysTouched(midnight - HOUR, midnight, FIXED_WEST)).toEqual(["2026-06-09"]);
    expect(daysTouched(midnight - HOUR, midnight + 1, FIXED_WEST)).toEqual([
      "2026-06-09",
      "2026-06-10",
    ]);
  });

  it("lists every day of a longer range, across a month end and a leap day", () => {
    expect(
      daysTouched(Date.UTC(2028, 1, 27, 12, 0), Date.UTC(2028, 2, 1, 12, 0), FIXED_WEST),
    ).toEqual(["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01"]);
  });

  it("falls back to the start's day for a range given backwards", () => {
    expect(daysTouched(midnight, midnight - 48 * HOUR, FIXED_WEST)).toEqual(["2026-06-10"]);
  });

  it("uses the zone: a night that is one UTC day is two local ones", () => {
    const start = Date.UTC(2026, 5, 10, 16, 0); // 21:30 on the 10th at +5:30
    const end = Date.UTC(2026, 5, 10, 23, 0); // 04:30 on the 11th
    expect(daysTouched(start, end, "UTC")).toEqual(["2026-06-10"]);
    expect(daysTouched(start, end, HALF_HOUR)).toEqual(["2026-06-10", "2026-06-11"]);
  });
});

describe("calendarBuckets", () => {
  it("returns nothing for an empty range", () => {
    expect(calendarBuckets(5, 5, "day", "UTC")).toEqual([]);
    expect(calendarBuckets(6, 5, "hour", "UTC")).toEqual([]);
  });

  it("refuses a width it does not know, even for an empty range", () => {
    for (const bad of ["fortnight", "0min", "1.5min", "min", "-5min"]) {
      expect(() => calendarBuckets(0, 0, bad as "day", "UTC")).toThrow(/bucket width/u);
    }
    expect(() => calendarBuckets(0, 1, "week", "UTC", 7 as 0)).toThrow(/weekStart/u);
  });

  it("returns whole local days, unclipped, for a range inside them", () => {
    const start = Date.UTC(2026, 5, 10, 12, 0);
    const end = Date.UTC(2026, 5, 11, 12, 0);
    expect(calendarBuckets(start, end, "day", FIXED_WEST)).toEqual([
      {
        startMs: Date.UTC(2026, 5, 10, 5, 0),
        endMs: Date.UTC(2026, 5, 11, 5, 0),
        label: "2026-06-10",
      },
      {
        startMs: Date.UTC(2026, 5, 11, 5, 0),
        endMs: Date.UTC(2026, 5, 12, 5, 0),
        label: "2026-06-11",
      },
    ]);
  });

  it("treats the range end as exclusive", () => {
    const midnight = Date.UTC(2026, 5, 11, 5, 0);
    expect(calendarBuckets(midnight - HOUR, midnight, "day", FIXED_WEST)).toHaveLength(1);
    expect(calendarBuckets(midnight - HOUR, midnight + 1, "day", FIXED_WEST)).toHaveLength(2);
  });

  it("makes day buckets of 23, 24 and 25 hours around the clock changes", () => {
    const spring = calendarBuckets(
      Date.UTC(2026, 8, 26, 0, 0),
      Date.UTC(2026, 8, 28, 0, 0),
      "day",
      DST,
    );
    expect(spring.map((b) => [b.label, (b.endMs - b.startMs) / HOUR])).toEqual([
      ["2026-09-26", 24],
      ["2026-09-27", 23],
      ["2026-09-28", 24],
    ]);
    const autumn = calendarBuckets(
      Date.UTC(2026, 3, 4, 0, 0),
      Date.UTC(2026, 3, 5, 0, 0),
      "day",
      DST,
    );
    expect(autumn.map((b) => [b.label, (b.endMs - b.startMs) / HOUR])).toEqual([
      ["2026-04-04", 24],
      ["2026-04-05", 25],
    ]);
  });

  it("leaves a day the zone skipped out of the list", () => {
    const buckets = calendarBuckets(
      Date.UTC(2011, 11, 29, 12, 0),
      Date.UTC(2011, 11, 31, 12, 0),
      "day",
      SKIPPED_DAY,
    );
    expect(buckets.map((b) => b.label)).toEqual(["2011-12-29", "2011-12-31", "2012-01-01"]);
    expect(buckets[1]?.startMs).toBe(buckets[0]?.endMs);
  });

  it("starts weeks on Monday by default", () => {
    expect(DEFAULT_WEEK_START).toBe(1);
    // 2026-06-10 is a Wednesday.
    const at = Date.UTC(2026, 5, 10, 12, 0);
    expect(calendarBuckets(at, at + 1, "week", FIXED_WEST)).toEqual([
      {
        startMs: Date.UTC(2026, 5, 8, 5, 0),
        endMs: Date.UTC(2026, 5, 15, 5, 0),
        label: "2026-06-08",
      },
    ]);
  });

  it("starts weeks on the day asked for", () => {
    const at = Date.UTC(2026, 5, 10, 12, 0); // a Wednesday
    const labelFor = (weekStart: 0 | 3 | 4 | 6): string | undefined =>
      calendarBuckets(at, at + 1, "week", FIXED_WEST, weekStart)[0]?.label;
    expect(labelFor(0)).toBe("2026-06-07"); // Sunday
    expect(labelFor(6)).toBe("2026-06-06"); // Saturday
    expect(labelFor(3)).toBe("2026-06-10"); // Wednesday itself
    expect(labelFor(4)).toBe("2026-06-04"); // the Thursday before
  });

  it("makes a week holding a clock change one hour short or long", () => {
    const [week] = calendarBuckets(
      Date.UTC(2026, 8, 24, 0, 0),
      Date.UTC(2026, 8, 24, 0, 1),
      "week",
      DST,
    );
    // Monday 2026-09-21 to Monday 2026-09-28, with the 23-hour Sunday inside.
    expect(week?.label).toBe("2026-09-21");
    expect(week === undefined ? 0 : week.endMs - week.startMs).toBe((7 * 24 - 1) * HOUR);
  });

  it("makes month buckets on local month boundaries, with February's leap day", () => {
    const months = calendarBuckets(
      Date.UTC(2028, 0, 31, 12, 0),
      Date.UTC(2028, 2, 1, 12, 0),
      "month",
      HALF_HOUR,
    );
    expect(months).toEqual([
      {
        startMs: Date.UTC(2028, 0, 1) - 5.5 * HOUR,
        endMs: Date.UTC(2028, 1, 1) - 5.5 * HOUR,
        label: "2028-01",
      },
      {
        startMs: Date.UTC(2028, 1, 1) - 5.5 * HOUR,
        endMs: Date.UTC(2028, 2, 1) - 5.5 * HOUR,
        label: "2028-02",
      },
      {
        startMs: Date.UTC(2028, 2, 1) - 5.5 * HOUR,
        endMs: Date.UTC(2028, 3, 1) - 5.5 * HOUR,
        label: "2028-03",
      },
    ]);
    expect(((months[1]?.endMs ?? 0) - (months[1]?.startMs ?? 0)) / (24 * HOUR)).toBe(29);
  });

  it("makes year buckets, 365 and 366 days long", () => {
    const years = calendarBuckets(Date.UTC(2027, 5, 1), Date.UTC(2029, 5, 1), "year", FIXED_WEST);
    expect(years.map((b) => [b.label, (b.endMs - b.startMs) / (24 * HOUR)])).toEqual([
      ["2027", 365],
      ["2028", 366],
      ["2029", 365],
    ]);
    expect(years[0]?.startMs).toBe(Date.UTC(2027, 0, 1, 5, 0));
  });

  it("puts a month's start on the right side of a clock change", () => {
    // April 2026 opens in summer time (UTC+13) and closes in standard (UTC+12).
    const [april] = calendarBuckets(Date.UTC(2026, 3, 15), Date.UTC(2026, 3, 15) + 1, "month", DST);
    expect(april).toEqual({
      startMs: Date.UTC(2026, 3, 1) - 13 * HOUR,
      endMs: Date.UTC(2026, 4, 1) - 12 * HOUR,
      label: "2026-04",
    });
  });

  it("cuts hours from local midnight and labels them with the offset", () => {
    const dayStart = Date.UTC(2026, 5, 10) - 5.5 * HOUR;
    const hours = calendarBuckets(dayStart + 90 * MIN, dayStart + 150 * MIN, "hour", HALF_HOUR);
    expect(hours).toEqual([
      {
        startMs: dayStart + HOUR,
        endMs: dayStart + 2 * HOUR,
        label: "2026-06-10T01:00:00+05:30",
      },
      {
        startMs: dayStart + 2 * HOUR,
        endMs: dayStart + 3 * HOUR,
        label: "2026-06-10T02:00:00+05:30",
      },
    ]);
    // Not UTC hours: a caller answering from UTC hour rollups can tell.
    expect((hours[0]?.startMs ?? 0) % HOUR).toBe(30 * MIN);
  });

  it("gives 23 hour buckets on a spring-forward day and never a 02:00", () => {
    const { startMs, endMs } = {
      startMs: Date.UTC(2026, 8, 27) - 12 * HOUR,
      endMs: Date.UTC(2026, 8, 28) - 13 * HOUR,
    };
    const hours = calendarBuckets(startMs, endMs, "hour", DST);
    expect(hours).toHaveLength(23);
    expect(hours.slice(0, 4).map((b) => b.label)).toEqual([
      "2026-09-27T00:00:00+12:00",
      "2026-09-27T01:00:00+12:00",
      "2026-09-27T03:00:00+13:00",
      "2026-09-27T04:00:00+13:00",
    ]);
    expect(hours.at(-1)?.endMs).toBe(endMs);
  });

  it("gives 25 hour buckets on a fall-back day and tells the repeated hour apart", () => {
    const startMs = Date.UTC(2026, 3, 5) - 13 * HOUR;
    const endMs = Date.UTC(2026, 3, 6) - 12 * HOUR;
    const hours = calendarBuckets(startMs, endMs, "hour", DST);
    expect(hours).toHaveLength(25);
    expect(hours.slice(2, 4).map((b) => b.label)).toEqual([
      "2026-04-05T02:00:00+13:00",
      "2026-04-05T02:00:00+12:00",
    ]);
    expect(new Set(hours.map((b) => b.label)).size).toBe(25);
  });

  it("ends a day with a short bucket when the width does not divide it", () => {
    // A 24.5-hour day cut into hours: 24 whole ones and a half.
    const startMs = Date.UTC(2026, 3, 5) - 11 * HOUR;
    const hours = calendarBuckets(startMs, startMs + 24.5 * HOUR, "hour", HALF_HOUR_DST);
    expect(hours).toHaveLength(25);
    const last = hours.at(-1);
    expect(last === undefined ? 0 : last.endMs - last.startMs).toBe(30 * MIN);
    // The next day's first bucket starts at its own midnight.
    const [next] = calendarBuckets(
      startMs + 24.5 * HOUR,
      startMs + 24.5 * HOUR + 1,
      "hour",
      HALF_HOUR_DST,
    );
    expect(next?.label).toBe("2026-04-06T00:00:00+10:30");
  });

  it("makes N-minute buckets aligned to local midnight", () => {
    const dayStart = Date.UTC(2026, 5, 10) - (5 * HOUR + 45 * MIN);
    const buckets = calendarBuckets(dayStart + 7 * MIN, dayStart + 31 * MIN, "15min", QUARTER_HOUR);
    expect(buckets.map((b) => [(b.startMs - dayStart) / MIN, (b.endMs - dayStart) / MIN])).toEqual([
      [0, 15],
      [15, 30],
      [30, 45],
    ]);
    expect(buckets[1]?.label).toBe("2026-06-10T00:15:00+05:45");
  });

  it("carries N-minute buckets across midnight without a gap or an overlap", () => {
    const midnight = Date.UTC(2026, 5, 11, 5, 0);
    const buckets = calendarBuckets(midnight - 10 * MIN, midnight + 10 * MIN, "5min", FIXED_WEST);
    expect(buckets).toHaveLength(4);
    for (const [index, bucket] of buckets.entries()) {
      expect(bucket.startMs).toBe(midnight - 10 * MIN + index * 5 * MIN);
      expect(bucket.endMs - bucket.startMs).toBe(5 * MIN);
    }
    expect(buckets[2]?.label).toBe("2026-06-11T00:00:00-05:00");
  });

  it("does not cap how many buckets it returns", () => {
    const start = Date.UTC(2026, 0, 1, 5, 0);
    expect(calendarBuckets(start, start + 30 * 24 * HOUR, "1min", FIXED_WEST)).toHaveLength(
      30 * 24 * 60,
    );
  });
});

describe("a zone whose wall-clock date ran backwards", () => {
  const [zone, changed] = ["America/Goose_Bay", Date.UTC(2010, 10, 7, 3, 1)] as const;

  it("starts the day at the first midnight and gives it the repeated hour", () => {
    // 00:00 on the 7th came at 03:00 UTC; at 03:01 the clocks went back to
    // 23:01 on the 6th, and 00:00 came round again at 04:00 UTC.
    expect(dayBoundsMs("2010-11-07", zone)).toEqual({
      startMs: Date.UTC(2010, 10, 7, 3, 0),
      endMs: Date.UTC(2010, 10, 8, 4, 0),
    });
    expect(dayBoundsMs("2010-11-06", zone)).toEqual({
      startMs: Date.UTC(2010, 10, 6, 3, 0),
      endMs: Date.UTC(2010, 10, 7, 3, 0),
    });
  });

  it("keeps the repeated stretch in the day that had already begun", () => {
    expect(localDay(changed - MIN - 1, zone)).toBe("2010-11-06");
    expect(localDay(changed - MIN, zone)).toBe("2010-11-07");
    // The wall clock reads 23:30 on the 6th here, for the second time.
    expect(localDay(changed + 29 * MIN, zone)).toBe("2010-11-07");
    expect(localDay(changed + 2 * HOUR, zone)).toBe("2010-11-07");
  });

  it("gives the long day when three hours repeat", () => {
    const bounds = dayBoundsMs("2010-03-05", "Antarctica/Casey");
    expect(bounds.startMs).toBe(Date.UTC(2010, 2, 5) - 11 * HOUR);
    expect(bounds.endMs).toBe(Date.UTC(2010, 2, 6) - 8 * HOUR);
    expect(bounds.endMs - bounds.startMs).toBe(27 * HOUR);
  });

  it.each(BACKWARD_DATES)("is self-consistent at every instant around %s", (name, at) => {
    const outside: number[] = [];
    const untouched: number[] = [];
    const unbucketed: number[] = [];
    for (const t of around(at)) {
      const day = localDay(t, name);
      const bounds = dayBoundsMs(day, name);
      if (t < bounds.startMs || t >= bounds.endMs) outside.push(t);
      if (daysTouched(t, t + 1, name).join(",") !== day) untouched.push(t);
      const buckets = [
        ...calendarBuckets(t, t + 1, "day", name),
        ...calendarBuckets(t, t + 1, "hour", name),
        ...calendarBuckets(t, t + 1, "month", name),
      ];
      const holds = buckets.length === 3 && buckets.every((b) => b.startMs <= t && t < b.endMs);
      if (!holds) unbucketed.push(t);
    }
    // The day localDay names always contains the instant ...
    expect(outside).toEqual([]);
    // ... a one-millisecond range touches exactly that day, never none ...
    expect(untouched).toEqual([]);
    // ... and every bucket width returns the one bucket that holds it.
    expect(unbucketed).toEqual([]);
  });

  it.each(BACKWARD_DATES)("tiles the days around %s with no gap or overlap", (name, at) => {
    const days = daysTouched(at - 3 * 24 * HOUR, at + 3 * 24 * HOUR, name);
    const bounds = days.map((day) => dayBoundsMs(day, name));
    expect(days.length).toBeGreaterThanOrEqual(6);
    expect(bounds.slice(1).map((b) => b.startMs)).toEqual(bounds.slice(0, -1).map((b) => b.endMs));
    expect(bounds.every((b) => b.endMs > b.startMs)).toBe(true);
  });
});

describe("a date the zone skipped", () => {
  it("is not among the days a range touches", () => {
    expect(
      daysTouched(Date.UTC(2011, 11, 29, 12, 0), Date.UTC(2011, 11, 31, 12, 0), SKIPPED_DAY),
    ).toEqual(["2011-12-29", "2011-12-31", "2012-01-01"]);
  });

  it("is never what localDay answers", () => {
    const jump = Date.UTC(2011, 11, 30, 10, 0);
    expect(localDay(jump - 1, SKIPPED_DAY)).toBe("2011-12-29");
    expect(localDay(jump, SKIPPED_DAY)).toBe("2011-12-31");
  });
});

describe("no range is left without a day or a bucket", () => {
  it.each([FIXED_WEST, HALF_HOUR, DST, HALF_HOUR_DST, MIDNIGHT_DST, SKIPPED_DAY])(
    "in %s",
    (name) => {
      const empty: number[] = [];
      // Every 37 minutes across two years that hold each zone's oddities.
      for (const year of [2011, 2026]) {
        for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 37 * 60 * MIN) {
          const none =
            daysTouched(t, t + 1, name).length !== 1 ||
            calendarBuckets(t, t + 1, "day", name).length !== 1;
          if (none) empty.push(t);
        }
      }
      expect(empty).toEqual([]);
    },
  );
});
