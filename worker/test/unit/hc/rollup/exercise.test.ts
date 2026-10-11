// The per-session exercise summary. All values invented.

import { describe, expect, it } from "vitest";

import { summariseExercise } from "../../../../src/hc/rollup/exercise.ts";

import { HOUR, MIN, PHONE, SECOND, T0, WEARABLE, interval, steady } from "./fixtures.ts";

import type { ExerciseContext } from "../../../../src/hc/rollup/exercise.ts";
import type { HcRecord } from "../../../../src/hc/wire.ts";

const START = T0 + 7 * HOUR;

const NOTHING: ExerciseContext = {
  hr: [],
  steps: [],
  distance: [],
  activeCalories: [],
  others: [],
};

function context(overrides: Partial<ExerciseContext>): ExerciseContext {
  return { ...NOTHING, ...overrides };
}

/** A session of `minutes` starting at START. */
function session(
  minutes: number,
  data?: Record<string, unknown>,
  overrides: Partial<HcRecord> = {},
): HcRecord {
  const end = START + minutes * MIN;
  return interval("ExerciseSession", START, end, data ?? { exerciseType: "RUNNING" }, overrides);
}

/** A one-minute Steps record starting `atMin` minutes into the session. */
function steps(atMin: number, count: number, lengthMin = 1): HcRecord {
  return interval("Steps", START + atMin * MIN, START + (atMin + lengthMin) * MIN, { count });
}

/** One heart-rate reading a minute from minute `from` up to, not including, minute `to`. */
function hr(from: number, to: number, bpm: number): { t: number; bpm: number }[] {
  return steady(START + from * MIN, to - from, bpm);
}

describe("summariseExercise: an ordinary session", () => {
  const record = session(
    60,
    {
      exerciseType: "RUNNING",
      title: "Morning run",
      notes: "easy",
      segments: [{ start: START, end: START + 10 * MIN, type: "RUNNING" }, {}],
      laps: [{}, {}, {}],
      route: [
        { t: START, lat: 0, lon: 0 },
        { t: START + MIN, lat: 0.001, lon: 0.001 },
      ],
    },
    { startOffsetMin: 60, endOffsetMin: 60 },
  );
  const summary = summariseExercise(
    record,
    context({
      // Thirty minutes at 120, thirty at 160, and readings either side.
      hr: [...hr(-10, 0, 90), ...hr(0, 30, 120), ...hr(30, 60, 160), ...hr(61, 70, 100)],
      steps: [steps(-1, 999), steps(0, 100), steps(30, 200), steps(59, 50), steps(60, 999)],
      distance: [
        interval("Distance", START + MIN, START + 2 * MIN, { distance: 1500 }),
        interval("Distance", START + 40 * MIN, START + 41 * MIN, { distance: 2500 }),
      ],
      activeCalories: [interval("ActiveCaloriesBurned", START, START + 60 * MIN, { energy: 480 })],
    }),
  );

  it("copies the session's own facts", () => {
    expect(summary).toMatchObject({
      origin: WEARABLE,
      startMs: START,
      endMs: START + 60 * MIN,
      startOffsetMin: 60,
      endOffsetMin: 60,
      exerciseType: "RUNNING",
      title: "Morning run",
      notes: "easy",
      durationMin: 60,
      segments: 2,
      laps: 3,
      hasRoute: true,
    });
  });

  it("summarises heart rate inside the session only", () => {
    expect(summary.hr).toEqual({ min: 120, mean: 140, max: 160, n: 60 });
  });

  it("sums steps, distance and energy from records that start inside it", () => {
    // The record starting a minute early and the one starting at the end are out.
    expect(summary.steps).toBe(350);
    expect(summary.distance).toBe(4000);
    expect(summary.energy).toBe(480);
  });

  it("raises no flags", () => {
    expect(summary).toMatchObject({
      overlaps: [],
      exactDuplicate: false,
      likelyLeftRunning: false,
      zeroLength: false,
    });
  });
});

describe("summariseExercise: what was not measured", () => {
  it("is null, not zero, when nothing was recorded during the session", () => {
    const summary = summariseExercise(session(30, {}), NOTHING);
    expect(summary).toMatchObject({
      exerciseType: "OTHER_WORKOUT",
      title: null,
      notes: null,
      startOffsetMin: null,
      endOffsetMin: null,
      hr: null,
      steps: null,
      distance: null,
      energy: null,
      segments: 0,
      laps: 0,
      hasRoute: false,
    });
  });

  it("keeps a measured zero as zero", () => {
    const summary = summariseExercise(session(30), context({ steps: [steps(5, 0)] }));
    expect(summary.steps).toBe(0);
  });

  it("skips a record whose value is not a number", () => {
    const summary = summariseExercise(
      session(30),
      context({ steps: [steps(5, 40), interval("Steps", START, START + MIN, { count: "many" })] }),
    );
    expect(summary.steps).toBe(40);
  });

  it("has no route when the route list is empty or absent", () => {
    expect(summariseExercise(session(30, { route: [] }), NOTHING).hasRoute).toBe(false);
    expect(summariseExercise(session(30, { route: "yes" }), NOTHING).hasRoute).toBe(false);
  });
});

const other = (
  idBlind: string,
  fromMin: number,
  toMin: number,
  shiftMs = 0,
): { idBlind: string; startMs: number; endMs: number } => ({
  idBlind,
  startMs: START + fromMin * MIN + shiftMs,
  endMs: START + toMin * MIN + shiftMs,
});

describe("summariseExercise: overlaps and duplicates", () => {
  it("lists the sessions it shares time with, and not the ones it only touches", () => {
    const summary = summariseExercise(
      session(60),
      context({
        others: [
          other("before", -30, 0), // ends as this one starts
          other("straddles-start", -30, 10),
          other("inside", 20, 30),
          other("straddles-end", 50, 90),
          other("after", 60, 90), // starts as this one ends
          other("far", 600, 660),
        ],
      }),
    );
    expect(summary.overlaps).toEqual(["straddles-start", "inside", "straddles-end"]);
    expect(summary.exactDuplicate).toBe(false);
  });

  it("flags an exact duplicate: same start and end to the second", () => {
    const summary = summariseExercise(
      session(60),
      context({ others: [other("copy", 0, 60, 400)] }),
    );
    expect(summary.exactDuplicate).toBe(true);
    expect(summary.overlaps).toEqual(["copy"]);
  });

  it("does not call a session a second off a duplicate", () => {
    const summary = summariseExercise(
      session(60),
      context({ others: [other("near", 0, 60, SECOND)] }),
    );
    expect(summary.exactDuplicate).toBe(false);
    expect(summary.overlaps).toEqual(["near"]);
  });
});

const lasting = (ms: number): boolean =>
  summariseExercise(interval("ExerciseSession", START, START + ms, {}), NOTHING).zeroLength;

describe("summariseExercise: zero length", () => {
  it("flags a session that starts and ends at one instant", () => {
    const record = interval("ExerciseSession", START, START, { exerciseType: "WALKING" });
    const summary = summariseExercise(
      record,
      context({
        steps: [interval("Steps", START, START, { count: 12 }), steps(0, 99)],
        others: [{ idBlind: "twin", startMs: START, endMs: START }],
      }),
    );
    expect(summary).toMatchObject({
      zeroLength: true,
      durationMin: 0,
      likelyLeftRunning: false,
      // A record stamped at its instant counts; one that merely starts there
      // has no share in a session with no length.
      steps: 12,
      // It shares no stretch of time with anything, but its twin is a duplicate.
      overlaps: [],
      exactDuplicate: true,
    });
  });

  it("draws the line at one second", () => {
    expect(lasting(999)).toBe(true);
    expect(lasting(SECOND)).toBe(false);
  });
});

const FOUR_HOURS = 240;

const tailAt = (bpm: number): boolean =>
  summariseExercise(
    session(FOUR_HOURS),
    // High until the tail begins, so only the tail decides.
    context({ hr: [...hr(0, 210, 150), ...hr(210, 240, bpm)] }),
  ).likelyLeftRunning;

describe("summariseExercise: left running", () => {
  it("flags a long session whose tail is at rest with no steps", () => {
    // An hour of running, then three hours forgotten on the sofa.
    const summary = summariseExercise(
      session(FOUR_HOURS),
      context({
        hr: [...hr(0, 60, 150), ...hr(60, 240, 65)],
        steps: [steps(0, 3000, 30), steps(30, 3000, 30)],
      }),
    );
    expect(summary.likelyLeftRunning).toBe(true);
  });

  it("does not flag a long hike: heart rate up and steps to the end", () => {
    const summary = summariseExercise(
      session(FOUR_HOURS),
      context({
        hr: hr(0, 240, 125),
        steps: Array.from({ length: 24 }, (_, index) => steps(index * 10, 900, 10)),
      }),
    );
    expect(summary.likelyLeftRunning).toBe(false);
  });

  it("does not flag a slow walk: heart rate low, but steps in the tail", () => {
    const summary = summariseExercise(
      session(FOUR_HOURS),
      context({ hr: hr(0, 240, 85), steps: [steps(0, 5000, 200), steps(215, 500, 20)] }),
    );
    expect(summary.likelyLeftRunning).toBe(false);
  });

  it("does not flag a long ride: no steps anywhere, heart rate up in the tail", () => {
    const summary = summariseExercise(session(FOUR_HOURS), context({ hr: hr(0, 240, 140) }));
    expect(summary.likelyLeftRunning).toBe(false);
  });

  it("flags on heart rate alone when the session has no steps at all", () => {
    const summary = summariseExercise(
      session(FOUR_HOURS),
      context({ hr: [...hr(0, 60, 150), ...hr(60, 240, 62)] }),
    );
    expect(summary.likelyLeftRunning).toBe(true);
  });

  it("flags on steps alone when the session has no heart rate at all", () => {
    const early = context({ steps: [steps(0, 4000, 40)] });
    expect(summariseExercise(session(FOUR_HOURS), early).likelyLeftRunning).toBe(true);
    const late = context({ steps: [steps(0, 4000, 40), steps(220, 400, 10)] });
    expect(summariseExercise(session(FOUR_HOURS), late).likelyLeftRunning).toBe(false);
  });

  it("treats a tail with no readings, after earlier ones, as the wearable taken off", () => {
    const summary = summariseExercise(session(FOUR_HOURS), context({ hr: hr(0, 90, 150) }));
    expect(summary.likelyLeftRunning).toBe(true);
  });

  it("falls back to duration alone with no heart rate and no steps", () => {
    expect(summariseExercise(session(FOUR_HOURS), NOTHING).likelyLeftRunning).toBe(true);
    // Data from outside the session is not data about it.
    const outside = context({ hr: hr(-60, 0, 150), steps: [steps(-30, 500, 10)] });
    expect(summariseExercise(session(FOUR_HOURS), outside).likelyLeftRunning).toBe(true);
  });

  it("never flags a session of three hours or less", () => {
    expect(summariseExercise(session(180), NOTHING).likelyLeftRunning).toBe(false);
    expect(summariseExercise(session(179), NOTHING).likelyLeftRunning).toBe(false);
    const quiet = context({ hr: [...hr(0, 30, 150), ...hr(30, 180, 60)] });
    expect(summariseExercise(session(180), quiet).likelyLeftRunning).toBe(false);
    expect(summariseExercise(session(181), quiet).likelyLeftRunning).toBe(true);
  });

  it("draws the heart-rate line at 100 bpm over the last thirty minutes", () => {
    expect(tailAt(100)).toBe(true);
    expect(tailAt(101)).toBe(false);
  });

  it("allows a few stray steps in the tail, and counts a straddling record in proportion", () => {
    const withTail = (...records: HcRecord[]): boolean =>
      summariseExercise(
        session(FOUR_HOURS),
        context({ hr: hr(0, 240, 60), steps: [steps(0, 2000, 30), ...records] }),
      ).likelyLeftRunning;
    expect(withTail(steps(220, 30, 5))).toBe(true);
    expect(withTail(steps(220, 31, 5))).toBe(false);
    // An hour-long record ending with the session: half of it is in the tail.
    expect(withTail(steps(180, 60, 60))).toBe(true);
    expect(withTail(steps(180, 62, 60))).toBe(false);
  });

  it("is told apart from another origin's session only by the caller", () => {
    // The summary judges the session it is given; it does not look at origin.
    const record = session(FOUR_HOURS, { exerciseType: "BIKING" }, { origin: PHONE });
    expect(summariseExercise(record, NOTHING)).toMatchObject({
      origin: PHONE,
      likelyLeftRunning: true,
    });
  });
});

describe("summariseExercise: records that straddle the session's ends", () => {
  it("counts them in proportion to the overlap, not all or nothing", () => {
    const summary = summariseExercise(
      session(60),
      context({
        steps: [
          steps(10, 100, 10), // inside: whole
          steps(-2, 500, 5), // three of its five minutes are inside: 300
          steps(58, 250, 5), // two of its five: 100
        ],
        // An hour-long record centred on the start: half of it.
        distance: [interval("Distance", START - 30 * MIN, START + 30 * MIN, { distance: 6000 })],
        // A two-hour record covering the session: half of it.
        activeCalories: [
          interval("ActiveCaloriesBurned", START, START + 120 * MIN, { energy: 480 }),
        ],
      }),
    );
    expect(summary.steps).toBe(500);
    expect(summary.distance).toBe(3000);
    expect(summary.energy).toBe(240);
  });

  it("is null when the only records lie wholly outside", () => {
    const summary = summariseExercise(
      session(60),
      context({ steps: [steps(-10, 400, 10), steps(60, 400, 10)] }),
    );
    expect(summary.steps).toBeNull();
  });
});
