// What a session's summary says about its heart rate and its ending:
//
//  - `hr.min` / `hr.max` are the lowest and highest SAMPLE, also when the
//    summary is built -- as the store builds it -- from one point a minute;
//  - a night has two heart-rate wakes: the final get-up (`hrWakeMs`) and the
//    first sustained rise at or after its end (`hrFirstRiseMs`);
//  - a workout's left-running flag is stored with the rule that raised it,
//    and its energy with the app it came from.
//
// Every value below is invented.

import { describe, expect, it } from "vitest";

import { summariseExercise } from "../../../../src/hc/rollup/exercise.ts";
import { minuteSeries, summariseHeartRate } from "../../../../src/hc/rollup/hr.ts";
import { hrFirstRise, hrWake, summariseSleep } from "../../../../src/hc/rollup/sleep.ts";

import type { HrSample } from "../../../../src/hc/rollup/hr.ts";
import type { HcRecord } from "../../../../src/hc/wire.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_790_000_000_000 - (1_790_000_000_000 % HOUR);
/** A night from 22:00 to 06:00 on an invented clock. */
const START = T0;
const END = START + 8 * HOUR;

/** One point a minute at `bpm`, for the minutes `[from, to)` after the night's start. */
const minutes = (from: number, to: number, bpm: number): HrSample[] =>
  Array.from({ length: to - from }, (_unused, index) => ({ t: START + (from + index) * MIN, bpm }));

function record(
  id: string,
  type: string,
  startMs: number,
  endMs: number,
  data: Record<string, unknown>,
  origin = "com.example.wearable",
): HcRecord {
  return { id, type, origin, lastModified: 1, start: startMs, end: endMs, data };
}

describe("a session's heart rate", () => {
  it("has the samples' extremes and count when it is given samples", () => {
    const samples = [
      { t: START, bpm: 50 },
      { t: START + 10_000, bpm: 70 },
      { t: START + MIN, bpm: 58 },
    ];

    expect(summariseHeartRate(samples, START, END)).toStrictEqual({
      min: 50,
      // The mean of the two minutes' means: 60 and 58.
      mean: 59,
      max: 70,
      n: 3,
    });
  });

  it("has them too when it is given one point a minute that carries its minute's", () => {
    // What the store hands a summary: the minute's mean, with its extremes.
    const points: HrSample[] = [
      { t: START, bpm: 60, min: 50, max: 70, n: 2 },
      { t: START + MIN, bpm: 58, min: 58, max: 58, n: 1 },
    ];

    // Was min 58, max 60, n 2: the lowest and highest minute MEAN.
    expect(summariseHeartRate(points, START, END)).toStrictEqual({
      min: 50,
      mean: 59,
      max: 70,
      n: 3,
    });
  });

  it("weighs two points of one minute by the samples each stands for", () => {
    const [minute] = minuteSeries([
      { t: START, bpm: 60, min: 55, max: 65, n: 3 },
      { t: START + 30_000, bpm: 80, min: 80, max: 80, n: 1 },
    ]);

    expect(minute).toStrictEqual({ t: START, n: 4, min: 55, max: 80, mean: 65 });
  });
});

describe("hrFirstRise", () => {
  const night = minutes(0, 480, 50);

  it("is the first rise after the end, where hrWake is the last", () => {
    // Up for twenty minutes from 06:10, settled again for half an hour, up
    // again from 07:00.
    const hr = [
      ...night,
      ...minutes(480, 490, 50),
      ...minutes(490, 510, 80),
      ...minutes(510, 540, 52),
      ...minutes(540, 541, 80),
    ];
    const wholeHour = [...hr, ...minutes(541, 560, 80)];

    expect(hrFirstRise(wholeHour, START, END)).toBe(START + 490 * MIN);
    // The search for the wake stops an hour after the end, where the second
    // rise has only just begun and cannot be seen to last.
    expect(hrWake(hr, START, END)).toBeNull();
    expect(hrFirstRise(hr, START, END)).toBe(START + 490 * MIN);
  });

  it("agrees with hrWake when there is one rise and it comes after the end", () => {
    const hr = [...night, ...minutes(480, 495, 51), ...minutes(495, 530, 78)];

    expect(hrWake(hr, START, END)).toBe(START + 495 * MIN);
    expect(hrFirstRise(hr, START, END)).toBe(START + 495 * MIN);
  });

  it("is the end itself when the pulse was already up as the session closed", () => {
    const hr = [...minutes(0, 450, 50), ...minutes(450, 520, 76)];

    expect(hrWake(hr, START, END)).toBe(START + 450 * MIN);
    expect(hrFirstRise(hr, START, END)).toBe(END);
  });

  it("passes over a blip that does not last, and a rise before the end that settled", () => {
    const hr = [
      // An awakening in the night, gone back to sleep from.
      ...minutes(0, 300, 50),
      ...minutes(300, 320, 80),
      ...minutes(320, 480, 50),
      // Two minutes up, then settled: not a rise.
      ...minutes(480, 482, 80),
      ...minutes(482, 500, 50),
      ...minutes(500, 520, 74),
    ];

    expect(hrFirstRise(hr, START, END)).toBe(START + 500 * MIN);
  });

  it("is null when nothing rises in the hour after the end, or there is no baseline", () => {
    expect(hrFirstRise([...night, ...minutes(480, 540, 51)], START, END)).toBeNull();
    expect(hrFirstRise(minutes(470, 540, 80), START, END)).toBeNull();
    expect(hrFirstRise([], START, END)).toBeNull();
  });

  it("is on the night's summary beside the final wake", () => {
    const session = record("night", "SleepSession", START, END, {});
    const hr = [...night, ...minutes(480, 495, 51), ...minutes(495, 530, 78)];

    const summary = summariseSleep(session, {
      hr,
      hrv: [],
      respiratoryRate: [],
      skinTemperature: [],
      restingHeartRate: [],
    });

    expect(summary).toMatchObject({
      hrWakeMs: START + 495 * MIN,
      hrFirstRiseMs: START + 495 * MIN,
    });
  });
});

describe("an exercise summary", () => {
  const span = { startMs: START, endMs: START + 4 * HOUR };
  const session = record("s", "ExerciseSession", span.startMs, span.endMs, {
    exerciseType: "WALKING",
  });
  /** One Steps record a minute, `perMinute(minute)` steps in each. */
  const walking = (perMinute: (minute: number) => number): HcRecord[] =>
    Array.from({ length: 240 }, (_unused, minute) =>
      record(`st-${String(minute)}`, "Steps", START + minute * MIN, START + (minute + 1) * MIN, {
        count: perMinute(minute),
      }),
    );
  const pulse = (bpm: (minute: number) => number): HrSample[] =>
    Array.from({ length: 240 }, (_unused, minute) => ({
      t: START + minute * MIN,
      bpm: bpm(minute),
    }));
  const none = { steps: [], distance: [], activeCalories: [], others: [] };

  it("says which rule found a session left running", () => {
    const resting = summariseExercise(session, {
      ...none,
      hr: pulse((minute) => (minute < 150 ? 130 : 70)),
      steps: walking((minute) => (minute < 150 ? 100 : 0)),
    });
    // Up and about for the last hour and a half: not at rest, nothing like the workout.
    const ranOn = summariseExercise(session, {
      ...none,
      hr: pulse((minute) => (minute < 150 ? 140 : 112)),
      steps: walking((minute) => (minute < 150 ? 100 : 10)),
    });
    const hike = summariseExercise(session, {
      ...none,
      hr: pulse((minute) => (minute < 150 ? 140 : 125)),
      steps: walking(() => 90),
    });

    expect(resting).toMatchObject({ likelyLeftRunning: true, leftRunningReason: "resting_tail" });
    expect(ranOn).toMatchObject({
      likelyLeftRunning: true,
      leftRunningReason: "tail_below_active_phase",
    });
    expect(hike).toMatchObject({ likelyLeftRunning: false, leftRunningReason: null });
  });

  it("names the app its energy came from, and nobody when there is none", () => {
    const burned = record(
      "kcal",
      "ActiveCaloriesBurned",
      START + HOUR,
      START + 2 * HOUR,
      { energy: 300 },
      "com.example.phone",
    );

    const withEnergy = summariseExercise(session, { ...none, hr: [], activeCalories: [burned] });
    const without = summariseExercise(session, { ...none, hr: [] });

    expect(withEnergy).toMatchObject({ energy: 300, energyOrigin: "com.example.phone" });
    expect(without).toMatchObject({ energy: null, energyOrigin: null });
  });
});
