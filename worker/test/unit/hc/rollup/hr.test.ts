// Heart-rate helpers: sample flattening, the minute series, resampling and
// event detection. Every value is invented.

import { describe, expect, it } from "vitest";

import {
  HR_EVENT_BASELINE_QUANTILE,
  HR_EVENT_HOLD_FRACTION,
  HR_EVENT_MAX_GAP_MS,
  HR_EVENT_MIN_BASELINE_MINUTES,
  HR_RESOLUTION_MS,
  HR_SAMPLE_HOLD_MAX_MS,
  detectHrEvents,
  heartRateSamples,
  hrHourToPoints,
  minuteSeries,
  resampleHeartRate,
  summariseHeartRate,
} from "../../../../src/hc/rollup/hr.ts";

import { HOUR, MIN, SECOND, T0, heartRate, interval, steady } from "./fixtures.ts";

import type { HrPoint } from "../../../../src/hc/rollup/hr.ts";

/** A minute series from a list of per-minute means starting at T0. */
function minutes(means: readonly number[], fromMs: number = T0): { t: number; mean: number }[] {
  return means.map((mean, index) => ({ t: fromMs + index * MIN, mean }));
}

function repeat(value: number, times: number): number[] {
  return Array.from({ length: times }, () => value);
}

const EVENT_OPTIONS = { minDeltaBpm: 20, windowS: 600, sustainS: 300 };

describe("heartRateSamples", () => {
  it("flattens records into time order and skips what it cannot read", () => {
    const records = [
      heartRate(T0 + MIN, [
        [0, 70],
        [SECOND, 71],
      ]),
      heartRate(T0, [[500, 60]]),
      interval("HeartRate", T0, T0 + MIN, { samples: [{ t: T0 + 2, bpm: "61" }, 7, null] }),
      interval("HeartRate", T0, T0 + MIN, { samples: "none" }),
    ];
    expect(heartRateSamples(records)).toEqual([
      { t: T0 + 500, bpm: 60 },
      { t: T0 + MIN, bpm: 70 },
      { t: T0 + MIN + SECOND, bpm: 71 },
    ]);
  });
});

describe("minuteSeries", () => {
  it("groups by minute whatever order the samples come in", () => {
    const samples = [
      { t: T0 + 2 * MIN + 5, bpm: 90 },
      { t: T0 + 10, bpm: 60 },
      { t: T0 + 59_999, bpm: 64 },
      { t: T0 + 2 * MIN, bpm: 100 },
    ];
    expect(minuteSeries(samples)).toEqual([
      { t: T0, n: 2, min: 60, max: 64, mean: 62 },
      { t: T0 + 2 * MIN, n: 2, min: 90, max: 100, mean: 95 },
    ]);
  });

  it("is empty for no samples", () => {
    expect(minuteSeries([])).toEqual([]);
  });
});

describe("hrHourToPoints", () => {
  it("puts a stored row back on the absolute timeline", () => {
    const row = {
      minutes: [
        { m: 59, n: 1, min: 70, max: 70, mean: 70 },
        { m: 0, n: 2, min: 60, max: 62, mean: 61 },
      ],
    };
    expect(hrHourToPoints(T0 / HOUR, row)).toEqual([
      { t: T0, n: 2, min: 60, max: 62, mean: 61 },
      { t: T0 + 59 * MIN, n: 1, min: 70, max: 70, mean: 70 },
    ]);
  });
});

describe("summariseHeartRate", () => {
  it("is null with no sample in the range", () => {
    expect(summariseHeartRate([], T0, T0 + HOUR)).toBeNull();
    expect(summariseHeartRate([{ t: T0 - 1, bpm: 60 }], T0, T0 + HOUR)).toBeNull();
  });

  it("includes both ends of the range", () => {
    const samples = [
      { t: T0, bpm: 60 },
      { t: T0 + HOUR, bpm: 80 },
      { t: T0 + HOUR + 1, bpm: 200 },
    ];
    expect(summariseHeartRate(samples, T0, T0 + HOUR)).toEqual({
      min: 60,
      mean: 70,
      max: 80,
      n: 2,
    });
  });

  it("weights each minute once, however densely it was sampled", () => {
    // One busy minute of sixty readings at 150, one quiet minute with one at 60.
    const samples = [...steady(T0, 60, 150, SECOND), { t: T0 + MIN, bpm: 60 }];
    expect(summariseHeartRate(samples, T0, T0 + HOUR)).toEqual({
      min: 60,
      mean: 105,
      max: 150,
      n: 61,
    });
  });
});

describe("resampleHeartRate", () => {
  it("returns raw samples as they are, in time order", () => {
    const samples = [
      { t: T0 + 2, bpm: 62 },
      { t: T0, bpm: 60 },
      { t: T0 + 1, bpm: 61 },
    ];
    expect(resampleHeartRate(samples, "raw")).toEqual({
      resolution: "raw",
      bucketMs: null,
      points: [
        { t: T0, bpm: 60, n: 1, min: 60, max: 60 },
        { t: T0 + 1, bpm: 61, n: 1, min: 61, max: 61 },
        { t: T0 + 2, bpm: 62, n: 1, min: 62, max: 62 },
      ],
      decimated: false,
      decimation: 1,
      totalPoints: 3,
      samples: 3,
    });
  });

  it("is empty for no samples at any resolution", () => {
    for (const resolution of ["raw", "5s", "1min", "5min", "1h"] as const) {
      const result = resampleHeartRate([], resolution, { maxPoints: 10 });
      expect(result.points).toEqual([]);
      expect(result.decimated).toBe(false);
    }
  });

  it("knows the width of each resolution", () => {
    expect(HR_RESOLUTION_MS).toEqual({
      "5s": 5 * SECOND,
      "1min": MIN,
      "5min": 5 * MIN,
      "1h": HOUR,
    });
  });

  it("weights a reading by how long it stood within its bucket", () => {
    // 60 bpm for 45 s, then 100 for the remaining 15 s of the minute.
    const samples = [
      { t: T0, bpm: 60 },
      { t: T0 + 45 * SECOND, bpm: 100 },
    ];
    expect(resampleHeartRate(samples, "1min").points).toEqual([
      { t: T0, bpm: 70, n: 2, min: 60, max: 100 },
    ]);
  });

  it("lets the next bucket's first reading end the stand of this bucket's last", () => {
    // 60 from 0:00, 120 from 0:30, and the next reading only at 1:10.
    const samples = [
      { t: T0, bpm: 60 },
      { t: T0 + 30 * SECOND, bpm: 120 },
      { t: T0 + 70 * SECOND, bpm: 90 },
    ];
    // Minute 0: 60 for 30 s, then 120 for 30 s -- to the bucket's end, not to 1:10.
    expect(resampleHeartRate(samples, "1min").points).toEqual([
      { t: T0, bpm: 90, n: 2, min: 60, max: 120 },
      { t: T0 + MIN, bpm: 90, n: 1, min: 90, max: 90 },
    ]);
    // In 5 s buckets each reading is alone in its bucket.
    expect(
      resampleHeartRate(samples, "5s").points.map((point) => [point.t - T0, point.bpm]),
    ).toEqual([
      [0, 60],
      [30 * SECOND, 120],
      [70 * SECOND, 90],
    ]);
  });

  it("compares a densely sampled stretch and a sparse one by their length", () => {
    // Ten minutes at one reading a second, all 150; then fifty minutes at one
    // reading every ten minutes, all 60. By time that is (10*150 + 50*60) / 60.
    const dense = steady(T0, 600, 150, SECOND);
    const sparse = steady(T0 + 10 * MIN, 5, 60, 10 * MIN);
    const expected: HrPoint = { t: T0, bpm: 75, n: 605, min: 60, max: 150 };
    expect(resampleHeartRate([...dense, ...sparse], "1h").points).toEqual([expected]);
  });

  it("does not credit a gap to the last reading before it", () => {
    expect(HR_SAMPLE_HOLD_MAX_MS).toBe(10 * MIN);
    // 100 at 0:00, then nothing until 50 at 0:40. Each stands ten minutes at
    // most, so the hour is their even mix -- not 40 minutes of 100.
    const samples = [
      { t: T0, bpm: 100 },
      { t: T0 + 40 * MIN, bpm: 50 },
    ];
    expect(resampleHeartRate(samples, "1h").points).toEqual([
      { t: T0, bpm: 75, n: 2, min: 50, max: 100 },
    ]);
  });

  it("gives readings at one instant equal weight", () => {
    const samples = [
      { t: T0, bpm: 60 },
      { t: T0, bpm: 80 },
      { t: T0 + 30 * SECOND, bpm: 100 },
    ];
    // 60 and 80 both stand for the first 30 s (mean 70), 100 for the last 30 s.
    expect(resampleHeartRate(samples, "1min").points).toEqual([
      { t: T0, bpm: 85, n: 3, min: 60, max: 100 },
    ]);
  });

  it("aligns buckets to the epoch and leaves empty ones out", () => {
    const samples = [
      { t: T0 + 4 * MIN + 59 * SECOND, bpm: 60 },
      { t: T0 + 5 * MIN, bpm: 70 },
      { t: T0 + 21 * MIN, bpm: 80 },
    ];
    expect(resampleHeartRate(samples, "5min").points.map((point) => point.t)).toEqual([
      T0,
      T0 + 5 * MIN,
      T0 + 20 * MIN,
    ]);
  });

  it("leaves a series that fits maxPoints alone", () => {
    const result = resampleHeartRate(steady(T0, 10, 60), "1min", { maxPoints: 10 });
    expect(result.points).toHaveLength(10);
    expect(result).toMatchObject({
      decimated: false,
      decimation: 1,
      bucketMs: MIN,
      totalPoints: 10,
    });
  });

  it("widens the grid to fit maxPoints, and says so", () => {
    const result = resampleHeartRate(
      steady(T0, 10, (index) => 60 + index),
      "1min",
      { maxPoints: 4 },
    );
    expect(result).toMatchObject({
      resolution: "1min",
      decimated: true,
      decimation: 3,
      bucketMs: 3 * MIN,
      totalPoints: 10,
      samples: 10,
    });
    expect(result.points).toEqual([
      { t: T0, bpm: 61, n: 3, min: 60, max: 62 },
      { t: T0 + 3 * MIN, bpm: 64, n: 3, min: 63, max: 65 },
      { t: T0 + 6 * MIN, bpm: 67, n: 3, min: 66, max: 68 },
      { t: T0 + 9 * MIN, bpm: 69, n: 1, min: 69, max: 69 },
    ]);
  });

  it("keeps widening when the first factor still does not fit", () => {
    // Readings in minutes 0,1 3,4 6,7: six points. Tripling the width gives
    // three buckets, still over two; quadrupling gives two.
    const samples = [0, 1, 3, 4, 6, 7].map((minute) => ({ t: T0 + minute * MIN, bpm: 60 }));
    const result = resampleHeartRate(samples, "1min", { maxPoints: 2 });
    expect(result).toMatchObject({ decimated: true, decimation: 4, bucketMs: 4 * MIN });
    expect(result.points.map((point) => [point.t, point.n])).toEqual([
      [T0, 3],
      [T0 + 4 * MIN, 3],
    ]);
  });

  it("groups raw samples to fit maxPoints, keeping the extremes", () => {
    const samples = steady(T0, 10, (index) => (index === 4 ? 181 : 60 + index), SECOND);
    const result = resampleHeartRate(samples, "raw", { maxPoints: 4 });
    expect(result).toMatchObject({
      decimated: true,
      decimation: 3,
      bucketMs: null,
      totalPoints: 10,
      samples: 10,
    });
    expect(result.points).toEqual([
      { t: T0, bpm: 61, n: 3, min: 60, max: 62 },
      { t: T0 + 3 * SECOND, bpm: 103, n: 3, min: 63, max: 181 },
      { t: T0 + 6 * SECOND, bpm: 67, n: 3, min: 66, max: 68 },
      { t: T0 + 9 * SECOND, bpm: 69, n: 1, min: 69, max: 69 },
    ]);
  });

  it("drops no reading when it decimates", () => {
    const samples = steady(T0, 1000, (index) => 50 + (index % 90), 7 * SECOND);
    for (const resolution of ["raw", "5s", "1min", "5min"] as const) {
      const result = resampleHeartRate(samples, resolution, { maxPoints: 7 });
      expect(result.points.length).toBeLessThanOrEqual(7);
      expect(result.decimated).toBe(true);
      expect(result.points.reduce((total, point) => total + point.n, 0)).toBe(1000);
      expect(Math.max(...result.points.map((point) => point.max))).toBe(139);
      expect(Math.min(...result.points.map((point) => point.min))).toBe(50);
    }
  });

  it("refuses a maxPoints that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(() => resampleHeartRate([], "1min", { maxPoints: bad })).toThrow(/maxPoints/u);
    }
  });

  it("does not change its input", () => {
    const samples = [
      { t: T0 + 1, bpm: 61 },
      { t: T0, bpm: 60 },
    ];
    resampleHeartRate(samples, "raw");
    expect(samples.map((sample) => sample.bpm)).toEqual([61, 60]);
  });
});

describe("detectHrEvents", () => {
  it("uses the documented constants", () => {
    expect(HR_EVENT_MIN_BASELINE_MINUTES).toBe(3);
    expect(HR_EVENT_BASELINE_QUANTILE).toBeCloseTo(0.1, 12);
    expect(HR_EVENT_HOLD_FRACTION).toBeCloseTo(0.5, 12);
    expect(HR_EVENT_MAX_GAP_MS).toBe(2 * MIN);
  });

  it("needs three minutes of data before a minute to have a baseline for it", () => {
    // Risen from minute 2, but minute 2 has only two minutes before it. The
    // event opens a minute late, at the first minute that has three.
    const early = minutes([60, 60, ...repeat(100, 8)]);
    expect(detectHrEvents(early, EVENT_OPTIONS).map((event) => event.startMs)).toEqual([
      T0 + 3 * MIN,
    ]);
    // With three quiet minutes first it opens at the rise itself.
    const ready = minutes([60, 60, 60, ...repeat(100, 8)]);
    expect(detectHrEvents(ready, EVENT_OPTIONS).map((event) => event.startMs)).toEqual([
      T0 + 3 * MIN,
    ]);
    expect(detectHrEvents(minutes([60, 60, 100]), { ...EVENT_OPTIONS, sustainS: 0 })).toEqual([]);
  });

  it("finds one sustained rise, with its baseline, peak and timing", () => {
    const series = minutes([...repeat(60, 10), ...repeat(100, 6), ...repeat(60, 10)]);
    expect(detectHrEvents(series, EVENT_OPTIONS)).toEqual([
      {
        startMs: T0 + 10 * MIN,
        endMs: T0 + 16 * MIN,
        peakMs: T0 + 10 * MIN,
        baselineBpm: 60,
        peakBpm: 100,
        deltaBpm: 40,
        timeToPeakS: 0,
        durationS: 360,
      },
    ]);
  });

  it("measures the climb to the peak and holds the event through its decline", () => {
    // Baseline 60, so the event opens at 80 and holds down to 70.
    const series = minutes([...repeat(60, 10), 85, 95, 110, 100, 90, 70, 65, ...repeat(60, 5)]);
    expect(detectHrEvents(series, EVENT_OPTIONS)).toEqual([
      {
        startMs: T0 + 10 * MIN,
        endMs: T0 + 16 * MIN,
        peakMs: T0 + 12 * MIN,
        baselineBpm: 60,
        peakBpm: 110,
        deltaBpm: 50,
        timeToPeakS: 120,
        durationS: 360,
      },
    ]);
  });

  it("does not open an event below the threshold", () => {
    const series = minutes([...repeat(60, 10), ...repeat(79, 10), ...repeat(60, 10)]);
    expect(detectHrEvents(series, EVENT_OPTIONS)).toEqual([]);
  });

  it("drops a rise that does not last", () => {
    const series = minutes([...repeat(60, 10), ...repeat(100, 4), ...repeat(60, 10)]);
    expect(detectHrEvents(series, EVENT_OPTIONS)).toEqual([]);
    expect(detectHrEvents(series, { ...EVENT_OPTIONS, sustainS: 240 })).toHaveLength(1);
  });

  it("cannot open an event before it has a baseline", () => {
    // High from the first minute: there is nothing to have risen from.
    const series = minutes([...repeat(100, 10), ...repeat(60, 10)]);
    expect(detectHrEvents(series, EVENT_OPTIONS)).toEqual([]);
  });

  it("finds two separate events and scans on after each", () => {
    const series = minutes([
      ...repeat(60, 10),
      ...repeat(95, 6),
      ...repeat(60, 12),
      ...repeat(130, 8),
      ...repeat(60, 5),
    ]);
    const events = detectHrEvents(series, EVENT_OPTIONS);
    expect(events.map((event) => [event.startMs, event.endMs, event.peakBpm])).toEqual([
      [T0 + 10 * MIN, T0 + 16 * MIN, 95],
      [T0 + 28 * MIN, T0 + 36 * MIN, 130],
    ]);
    expect(events[1]?.baselineBpm).toBe(60);
  });

  it("ends an event at a hole in the series", () => {
    // Elevated in minutes 10 and 11, silent for 12-14, elevated again from 15.
    const series = [
      ...minutes(repeat(60, 10)),
      ...minutes(repeat(100, 2), T0 + 10 * MIN),
      ...minutes(repeat(100, 6), T0 + 15 * MIN),
      ...minutes(repeat(60, 3), T0 + 21 * MIN),
    ];
    // The first part is too short on its own; the second opens afresh.
    expect(
      detectHrEvents(series, EVENT_OPTIONS).map((event) => [event.startMs, event.durationS]),
    ).toEqual([[T0 + 15 * MIN, 360]]);
  });

  it("bridges one missing minute", () => {
    const series = [
      ...minutes(repeat(60, 10)),
      ...minutes(repeat(100, 3), T0 + 10 * MIN),
      ...minutes(repeat(100, 3), T0 + 14 * MIN),
      ...minutes(repeat(60, 3), T0 + 17 * MIN),
    ];
    expect(
      detectHrEvents(series, EVENT_OPTIONS).map((event) => [event.startMs, event.endMs]),
    ).toEqual([[T0 + 10 * MIN, T0 + 17 * MIN]]);
  });

  it("takes the baseline from the window only", () => {
    // Twenty minutes at 100, then ten at 70, then a rise to 95. Against the
    // last ten minutes (70) that is +25; against all thirty it would not be.
    const series = minutes([...repeat(100, 20), ...repeat(70, 10), ...repeat(95, 6), 70]);
    const [event] = detectHrEvents(series, EVENT_OPTIONS);
    expect(event).toMatchObject({ startMs: T0 + 30 * MIN, baselineBpm: 70, deltaBpm: 25 });
  });

  it("sorts its input and leaves it unchanged", () => {
    const series = minutes([...repeat(60, 10), ...repeat(100, 6), ...repeat(60, 4)]);
    const shuffled = series.toReversed();
    expect(detectHrEvents(shuffled, EVENT_OPTIONS)).toEqual(detectHrEvents(series, EVENT_OPTIONS));
    expect(shuffled[0]?.t).toBe(T0 + 19 * MIN);
  });

  it("refuses options that are not usable numbers", () => {
    for (const bad of [
      { ...EVENT_OPTIONS, minDeltaBpm: 0 },
      { ...EVENT_OPTIONS, windowS: -1 },
      { ...EVENT_OPTIONS, sustainS: -1 },
      { ...EVENT_OPTIONS, minDeltaBpm: NaN },
    ]) {
      expect(() => detectHrEvents([], bad)).toThrow(/minDeltaBpm/u);
    }
  });
});

describe("resampleHeartRate: finding the factor", () => {
  it("stops when no width can meet maxPoints", () => {
    // Either side of the epoch: every epoch-aligned grid has a line between them.
    const result = resampleHeartRate(
      [
        { t: -1, bpm: 60 },
        { t: 1, bpm: 70 },
      ],
      "1min",
      { maxPoints: 1 },
    );
    expect(result.points.map((point) => [point.t < 0, point.bpm])).toEqual([
      [true, 60],
      [false, 70],
    ]);
    expect(result.decimated).toBe(true);
  });

  it("fits a sparse year at a fine resolution without counting its way there", () => {
    // One reading every ten minutes for a year, asked for at five seconds:
    // the factor that fits is in the thousands.
    const year = steady(T0, 52_560, (index) => 50 + (index % 40), 10 * MIN);
    const began = performance.now();
    const result = resampleHeartRate(year, "5s", { maxPoints: 1000 });
    const took = performance.now() - began;
    expect(result.points.length).toBeLessThanOrEqual(1000);
    // Coarser, but not thrown away: most of the ceiling is used.
    expect(result.points.length).toBeGreaterThan(500);
    expect(result.points.reduce((total, point) => total + point.n, 0)).toBe(52_560);
    expect(result).toMatchObject({ decimated: true, totalPoints: 52_560 });
    expect(result.bucketMs).toBe(5 * SECOND * result.decimation);
    expect(took).toBeLessThan(1000);
  });
});

describe("detectHrEvents: the baseline after an event", () => {
  it("finds every round of intervals, not only the first", () => {
    // Ten quiet minutes, then six rounds of six minutes hard and two easy.
    const round = [...repeat(150, 6), ...repeat(62, 2)];
    const series = minutes([...repeat(62, 10), ...Array.from({ length: 6 }, () => round).flat()]);
    const events = detectHrEvents(series, EVENT_OPTIONS);
    expect(events.map((event) => (event.startMs - T0) / MIN)).toEqual([10, 18, 26, 34, 42, 50]);
    expect(events.map((event) => [event.baselineBpm, event.peakBpm, event.durationS])).toEqual(
      repeat(0, 6).map(() => [62, 150, 360]),
    );
  });

  it("finds a second rise that follows the first by two minutes", () => {
    const series = minutes([
      ...repeat(60, 10),
      ...repeat(100, 6),
      ...repeat(60, 2),
      ...repeat(100, 22),
      ...repeat(60, 3),
    ]);
    expect(
      detectHrEvents(series, EVENT_OPTIONS).map((event) => [
        (event.startMs - T0) / MIN,
        (event.endMs - T0) / MIN,
        event.baselineBpm,
      ]),
    ).toEqual([
      [10, 16, 60],
      [18, 40, 60],
    ]);
  });

  it("keeps a rise too short to report out of the next baseline too", () => {
    // Three minutes up (dropped), two down, then a rise that lasts.
    const series = minutes([
      ...repeat(60, 10),
      ...repeat(100, 3),
      ...repeat(60, 2),
      ...repeat(100, 8),
      60,
    ]);
    expect(
      detectHrEvents(series, EVENT_OPTIONS).map((event) => [
        (event.startMs - T0) / MIN,
        event.baselineBpm,
      ]),
    ).toEqual([[15, 60]]);
  });

  it("sees a slow climb as one event, from the level it left", () => {
    // Ten minutes at 60, up two bpm a minute to 120, then held for an hour.
    const climb = Array.from({ length: 31 }, (_unused, index) => 60 + 2 * index);
    const series = minutes([...repeat(60, 10), ...climb, ...repeat(120, 60)]);
    const events = detectHrEvents(series, { minDeltaBpm: 15, windowS: 600, sustainS: 300 });
    // It opens at 76, the first minute fifteen above the 60 it climbed from --
    // a median of the window would have climbed with it and never opened.
    expect(events).toEqual([
      {
        startMs: T0 + 18 * MIN,
        endMs: T0 + 101 * MIN,
        peakMs: T0 + 40 * MIN,
        baselineBpm: 60,
        peakBpm: 120,
        deltaBpm: 60,
        timeToPeakS: 22 * 60,
        durationS: 83 * 60,
      },
    ]);
  });

  it("does not slow down with the size of the window", () => {
    // Thirty days of minutes with a day-long window: a rise every three hours.
    const month = Array.from({ length: 43_200 }, (_unused, index) => ({
      t: T0 + index * MIN,
      mean: index % 180 < 10 ? 120 : 60 + (index % 7),
    }));
    const began = performance.now();
    const events = detectHrEvents(month, { minDeltaBpm: 30, windowS: 86_400, sustainS: 300 });
    const took = performance.now() - began;
    // Every rise after the first, which has no baseline before it.
    expect(events).toHaveLength(239);
    expect(took).toBeLessThan(1500);
  });
});
