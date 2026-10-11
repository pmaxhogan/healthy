// The per-minute heart-rate row of one UTC hour, and where the samples of a
// record that runs past its hour go. Every value is invented.

import { describe, expect, it } from "vitest";

import { hrHoursTouched, hrMinutesOfHour } from "../../../../src/hc/rollup/hr-minute.ts";

import { HOUR, MIN, SECOND, T0, heartRate, interval } from "./fixtures.ts";

/** `hour_utc` of the hour starting at T0. */
const H = T0 / HOUR;

describe("hrMinutesOfHour", () => {
  it("gives n, min, max and mean per minute", () => {
    const record = heartRate(T0, [
      [0, 60],
      [30 * SECOND, 70],
      [59 * SECOND, 62],
      [5 * MIN, 90],
    ]);
    expect(hrMinutesOfHour([record], H)).toEqual({
      minutes: [
        { m: 0, n: 3, min: 60, max: 70, mean: 64 },
        { m: 5, n: 1, min: 90, max: 90, mean: 90 },
      ],
    });
  });

  it("files a sample under its own minute at both edges of the hour", () => {
    const record = heartRate(T0 - MIN, [
      [MIN - 1, 50], // the last millisecond of the hour before
      [MIN, 61], // the first of this one
      [MIN + HOUR - 1, 79], // the last of this one
      [MIN + HOUR, 88], // the first of the next
    ]);
    expect(hrMinutesOfHour([record], H).minutes).toEqual([
      { m: 0, n: 1, min: 61, max: 61, mean: 61 },
      { m: 59, n: 1, min: 79, max: 79, mean: 79 },
    ]);
    expect(hrMinutesOfHour([record], H - 1).minutes).toEqual([
      { m: 59, n: 1, min: 50, max: 50, mean: 50 },
    ]);
    expect(hrMinutesOfHour([record], H + 1).minutes).toEqual([
      { m: 0, n: 1, min: 88, max: 88, mean: 88 },
    ]);
  });

  it("merges the samples of several records into one minute, in minute order", () => {
    const late = heartRate(T0 + 10 * MIN, [[0, 100]]);
    const early = heartRate(T0 + 2 * MIN, [
      [0, 70],
      [8 * MIN + 20 * SECOND, 110],
    ]);
    expect(hrMinutesOfHour([late, early], H).minutes).toEqual([
      { m: 2, n: 1, min: 70, max: 70, mean: 70 },
      { m: 10, n: 2, min: 100, max: 110, mean: 105 },
    ]);
  });

  it("is empty for no records, no samples, and samples that are not readable", () => {
    expect(hrMinutesOfHour([], H)).toEqual({ minutes: [] });
    const broken = interval("HeartRate", T0, T0 + MIN, {
      samples: [null, "x", { t: T0 }, { bpm: 70 }, { t: "soon", bpm: 70 }, { t: T0, bpm: NaN }],
    });
    const none = interval("HeartRate", T0, T0 + MIN, {});
    expect(hrMinutesOfHour([broken, none], H)).toEqual({ minutes: [] });
  });

  describe("a record that runs past its start hour", () => {
    // Starts at xx:58 and holds samples into the next hour.
    const spilling = heartRate(T0 + 58 * MIN, [
      [0, 70],
      [90 * SECOND, 72],
      [3 * MIN, 80],
      [5 * MIN, 84],
    ]);

    it("gives each hour only its own samples", () => {
      expect(hrMinutesOfHour([spilling], H).minutes).toEqual([
        { m: 58, n: 1, min: 70, max: 70, mean: 70 },
        { m: 59, n: 1, min: 72, max: 72, mean: 72 },
      ]);
      expect(hrMinutesOfHour([spilling], H + 1).minutes).toEqual([
        { m: 1, n: 1, min: 80, max: 80, mean: 80 },
        { m: 3, n: 1, min: 84, max: 84, mean: 84 },
      ]);
    });

    it("names every hour whose row the record feeds, so none is missed", () => {
      const hours = hrHoursTouched([spilling]);
      expect(hours).toEqual([H, H + 1]);
      const filed = hours
        .flatMap((hour) => hrMinutesOfHour([spilling], hour).minutes)
        .reduce((total, minute) => total + minute.n, 0);
      expect(filed).toBe(4);
    });

    it("joins the next hour's own records when both are passed", () => {
      const own = heartRate(T0 + HOUR + MIN, [[10 * SECOND, 90]]);
      expect(hrMinutesOfHour([own, spilling], H + 1).minutes).toEqual([
        { m: 1, n: 2, min: 80, max: 90, mean: 85 },
        { m: 3, n: 1, min: 84, max: 84, mean: 84 },
      ]);
    });
  });
});

describe("hrHoursTouched", () => {
  it("lists each hour once, ascending, and only hours that hold a sample", () => {
    const records = [
      heartRate(T0 + 3 * HOUR, [[0, 60]]),
      heartRate(T0, [
        [0, 60],
        [10 * MIN, 61],
      ]),
      // Spans three hours but has samples only in the first and the last.
      heartRate(T0 + 5 * HOUR + 59 * MIN, [
        [0, 70],
        [61 * MIN, 71],
      ]),
    ];
    expect(hrHoursTouched(records)).toEqual([H, H + 3, H + 5, H + 7]);
  });

  it("is empty for nothing", () => {
    expect(hrHoursTouched([])).toEqual([]);
  });
});
