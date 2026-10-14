// The nightly sleep summary. One hand-built night whose every expected number
// can be worked out by reading the fixture, then the edges. All values invented.

import { describe, expect, it } from "vitest";

import {
  AWAKE_STAGES,
  HR_WAKE_HOLD_FRACTION,
  HR_WAKE_BASELINE_PERCENTILE,
  HR_WAKE_MAX_GAP_MS,
  HR_WAKE_MIN_OVERNIGHT_MINUTES,
  HR_WAKE_MIN_RUN_MINUTES,
  HR_WAKE_RISE_BPM,
  HR_WAKE_SEARCH_AFTER_MS,
  HR_WAKE_SEARCH_BEFORE_MS,
  HR_WAKE_SUSTAIN_MS,
  RESTING_HR_BEFORE_END_TOLERANCE_MS,
  SLEEP_MATCH_TOLERANCE_MS,
  hrWake,
  summariseSleep,
} from "../../../../src/hc/rollup/sleep.ts";

import { HOUR, MIN, PHONE, SECOND, T0, WEARABLE, instant, interval, steady } from "./fixtures.ts";

import type { SleepContext } from "../../../../src/hc/rollup/sleep.ts";
import type { HcRecord } from "../../../../src/hc/wire.ts";

/** Bedtime and getting-up time of the night: eight hours. */
const START = T0 + 22 * HOUR;
const END = START + 8 * HOUR;

/** A stage from minute `from` to minute `to` of the night. */
function stage(from: number, to: number, name: string): Record<string, unknown> {
  return { start: START + from * MIN, end: START + to * MIN, stage: name };
}

function session(data: Record<string, unknown>, overrides: Partial<HcRecord> = {}): HcRecord {
  return interval("SleepSession", START, END, data, overrides);
}

const NOTHING: SleepContext = {
  hr: [],
  hrv: [],
  respiratoryRate: [],
  skinTemperature: [],
  restingHeartRate: [],
  others: [],
};

function context(overrides: Partial<SleepContext>): SleepContext {
  return { ...NOTHING, ...overrides };
}

/**
One reading a minute, thirty seconds into the minute, for minute `from` up
to but not including minute `to` of the night.
*/
function hrMinutes(from: number, to: number, bpm: number): { t: number; bpm: number }[] {
  return steady(START + from * MIN + 30 * SECOND, to - from, bpm);
}

// The night. Minutes in bed: 480.
//
//   0- 20  AWAKE_IN_BED   20
//  20- 80  LIGHT          60
//  80-170  DEEP           90
// 170-200  REM            30
// 200-210  AWAKE          10
// 210-330  LIGHT         120
// 330-390  REM            60
// 390-395  OUT_OF_BED      5
// 395-450  SLEEPING       55
// 450-480  AWAKE          30
//
// Awake: 20 + 10 + 5 + 30 = 65. Asleep: 480 - 65 = 415.
const NIGHT_STAGES = [
  stage(0, 20, "AWAKE_IN_BED"),
  stage(20, 80, "LIGHT"),
  stage(80, 170, "DEEP"),
  stage(170, 200, "REM"),
  stage(200, 210, "AWAKE"),
  stage(210, 330, "LIGHT"),
  stage(330, 390, "REM"),
  stage(390, 395, "OUT_OF_BED"),
  stage(395, 450, "SLEEPING"),
  stage(450, 480, "AWAKE"),
];

// Heart rate, one reading a minute:
//
//   0- 20   70   settling                        20 minutes
//  20-100   50                                    80
// 100-105   60   a stir, under the rise threshold  5
// 105-465   50                                   360
// 465-480   74   up, fifteen minutes before the session ends   15
// 480-510   74   still up after it (outside the session)
//
// In the session: 480 readings. Sum = 20*70 + 440*50 + 5*60 + 15*74 = 24 810.
// Tenth percentile of the 480 minutes: 50. Risen means 62 or more.
const NIGHT_HR = [
  ...hrMinutes(0, 20, 70),
  ...hrMinutes(20, 100, 50),
  ...hrMinutes(100, 105, 60),
  ...hrMinutes(105, 465, 50),
  ...hrMinutes(465, 510, 74),
];

const NIGHT_CONTEXT: SleepContext = {
  hr: NIGHT_HR,
  // Sorted, the in-session readings are 10 20 30 40 50.
  hrv: [
    instant("HeartRateVariabilityRmssd", START + 60 * MIN, { rmssd: 40 }),
    instant("HeartRateVariabilityRmssd", START + 120 * MIN, { rmssd: 20 }),
    instant("HeartRateVariabilityRmssd", START + 180 * MIN, { rmssd: 50 }),
    instant("HeartRateVariabilityRmssd", START + 240 * MIN, { rmssd: 30 }),
    instant("HeartRateVariabilityRmssd", START + 300 * MIN, { rmssd: 10 }),
    instant("HeartRateVariabilityRmssd", END + 20 * MIN, { rmssd: 99 }),
  ],
  respiratoryRate: [
    instant("RespiratoryRate", START + 6 * HOUR, { rate: 18 }),
    instant("RespiratoryRate", END + 5 * MIN, { rate: 15 }),
  ],
  skinTemperature: [
    interval("SkinTemperature", START + MIN, END, {
      baseline: 33,
      deltas: [
        { t: START + HOUR, delta: -1 },
        { t: START + 3 * HOUR, delta: 1 },
        { t: START + 5 * HOUR, delta: 3 },
      ],
    }),
  ],
  restingHeartRate: [instant("RestingHeartRate", END + 10 * MIN, { bpm: 52 })],
  others: [],
};

describe("summariseSleep: a whole night", () => {
  const record = session(
    { stages: NIGHT_STAGES, title: "Night", notes: "window open" },
    { startOffsetMin: -300, endOffsetMin: -240 },
  );
  const night = summariseSleep(record, NIGHT_CONTEXT);

  it("copies the session's own facts", () => {
    expect(night).toMatchObject({
      origin: WEARABLE,
      startMs: START,
      endMs: END,
      startOffsetMin: -300,
      endOffsetMin: -240,
      title: "Night",
      notes: "window open",
    });
  });

  it("works out in-bed, awake and asleep time", () => {
    expect(night.inBedMin).toBe(480);
    expect(night.awakeMin).toBe(65);
    expect(night.asleepMin).toBe(415);
  });

  it("totals each stage", () => {
    expect(night.stageMin).toEqual({
      AWAKE_IN_BED: 20,
      LIGHT: 180,
      DEEP: 90,
      REM: 90,
      AWAKE: 40,
      OUT_OF_BED: 5,
      SLEEPING: 55,
    });
    const total = Object.values(night.stageMin).reduce((sum, minutes) => sum + minutes, 0);
    expect(total).toBe(night.inBedMin);
  });

  it("places onset and the stage wake", () => {
    expect(night.onsetMs).toBe(START + 20 * MIN);
    expect(night.stageWakeMs).toBe(START + 450 * MIN);
  });

  it("places the heart-rate wake at the sustained rise, later than the stage wake", () => {
    expect(night.hrWakeMs).toBe(START + 465 * MIN);
    expect(night.hrWakeMs).toBeGreaterThan(night.stageWakeMs ?? Infinity);
  });

  it("summarises overnight heart rate from the samples inside the session", () => {
    expect(night.hr?.n).toBe(480);
    expect(night.hr?.min).toBe(50);
    expect(night.hr?.max).toBe(74);
    expect(night.hr?.mean).toBeCloseTo(24_810 / 480, 10);
  });

  it("gives the HRV median and quartiles of the in-session readings", () => {
    expect(night.hrv).toEqual({ median: 30, q1: 20, q3: 40, n: 5 });
  });

  it("matches the readings stamped at the session's ends", () => {
    // The one just after the end, not the one two hours before it.
    expect(night.respiratoryRate).toBe(15);
    expect(night.restingHr).toBe(52);
    // Mean of -1, 1 and 3.
    expect(night.skinTempDelta).toBe(1);
  });

  it("returns the stages, in order", () => {
    expect(night.stages).toHaveLength(10);
    expect(night.stages[0]).toEqual({
      start: START,
      end: START + 20 * MIN,
      stage: "AWAKE_IN_BED",
    });
    expect(night.stages.at(-1)?.stage).toBe("AWAKE");
  });
});

describe("summariseSleep: stages", () => {
  it("counts exactly three stages as awake", () => {
    expect([...AWAKE_STAGES].toSorted((left, right) => left.localeCompare(right))).toEqual([
      "AWAKE",
      "AWAKE_IN_BED",
      "OUT_OF_BED",
    ]);
  });

  it("treats a session with no stages as asleep throughout", () => {
    const night = summariseSleep(session({}), NOTHING);
    expect(night).toMatchObject({
      inBedMin: 480,
      asleepMin: 480,
      awakeMin: 0,
      stageMin: {},
      onsetMs: null,
      stageWakeMs: null,
      stages: [],
      title: null,
      notes: null,
      startOffsetMin: null,
      endOffsetMin: null,
    });
  });

  it("reports nothing measured as null, not zero", () => {
    expect(summariseSleep(session({ stages: NIGHT_STAGES }), NOTHING)).toMatchObject({
      hr: null,
      hrv: null,
      hrWakeMs: null,
      respiratoryRate: null,
      skinTempDelta: null,
      restingHr: null,
    });
  });

  it("clips a stage to the session and drops one outside it", () => {
    const night = summariseSleep(
      session({
        stages: [
          stage(-30, 30, "AWAKE"), // half before the session
          stage(30, 470, "LIGHT"),
          stage(470, 500, "DEEP"), // twenty minutes past the end
          stage(500, 520, "REM"), // wholly after
        ],
      }),
      NOTHING,
    );
    expect(night.stageMin).toEqual({ AWAKE: 30, LIGHT: 440, DEEP: 10 });
    expect(night.asleepMin).toBe(450);
    expect(night.stageWakeMs).toBe(END);
    expect(night.stages.map((entry) => [entry.start, entry.end])).toEqual([
      [START, START + 30 * MIN],
      [START + 30 * MIN, START + 470 * MIN],
      [START + 470 * MIN, END],
    ]);
  });

  it("counts UNKNOWN, and a stage name it has never seen, as time not awake", () => {
    const night = summariseSleep(
      session({
        stages: [
          stage(0, 60, "AWAKE"),
          stage(60, 120, "UNKNOWN"),
          stage(120, 180, "SOMETHING_NEWER"),
          stage(180, 480, "DEEP"),
        ],
      }),
      NOTHING,
    );
    expect(night.stageMin).toEqual({ AWAKE: 60, UNKNOWN: 120, DEEP: 300 });
    expect(night.asleepMin).toBe(420);
    expect(night.onsetMs).toBe(START + 60 * MIN);
    expect(night.stages[2]?.stage).toBe("UNKNOWN");
  });

  it("counts time no stage covers as asleep", () => {
    const night = summariseSleep(
      session({ stages: [stage(0, 30, "AWAKE"), stage(100, 200, "DEEP")] }),
      NOTHING,
    );
    expect(night.awakeMin).toBe(30);
    expect(night.asleepMin).toBe(450);
    expect(night.onsetMs).toBe(START + 100 * MIN);
    expect(night.stageWakeMs).toBe(START + 200 * MIN);
  });

  it("has no onset when every stage is an awake one", () => {
    const night = summariseSleep(session({ stages: [stage(0, 480, "AWAKE_IN_BED")] }), NOTHING);
    expect(night).toMatchObject({ asleepMin: 0, awakeMin: 480, onsetMs: null, stageWakeMs: null });
  });

  it("sorts stages and skips entries it cannot read", () => {
    const night = summariseSleep(
      session({
        stages: [
          stage(240, 480, "REM"),
          null,
          { start: START, stage: "DEEP" },
          { start: "soon", end: END, stage: "DEEP" },
          stage(0, 240, "LIGHT"),
          stage(100, 100, "AWAKE"), // empty
        ],
      }),
      NOTHING,
    );
    expect(night.stages.map((entry) => entry.stage)).toEqual(["LIGHT", "REM"]);
    expect(night.awakeMin).toBe(0);
  });

  it("tolerates stages that are not a list", () => {
    expect(summariseSleep(session({ stages: "none" }), NOTHING).stages).toEqual([]);
  });
});

describe("hrWake", () => {
  it("uses the documented constants", () => {
    expect(HR_WAKE_BASELINE_PERCENTILE).toBeCloseTo(0.1, 12);
    expect(HR_WAKE_RISE_BPM).toBe(12);
    expect(HR_WAKE_SUSTAIN_MS).toBe(5 * MIN);
    expect(HR_WAKE_MAX_GAP_MS).toBe(5 * MIN);
    expect(HR_WAKE_SEARCH_BEFORE_MS).toBe(90 * MIN);
    expect(HR_WAKE_SEARCH_AFTER_MS).toBe(60 * MIN);
    expect(HR_WAKE_MIN_OVERNIGHT_MINUTES).toBe(30);
    expect(HR_WAKE_MIN_RUN_MINUTES).toBe(3);
    expect(HR_WAKE_HOLD_FRACTION).toBeCloseTo(0.5, 12);
  });

  it("is null without enough overnight data for a baseline", () => {
    expect(hrWake([], START, END)).toBeNull();
    // Twenty-nine minutes of data, the last ten risen.
    const thin = [...hrMinutes(451, 470, 50), ...hrMinutes(470, 480, 80)];
    expect(thin).toHaveLength(29);
    expect(hrWake(thin, START, END)).toBeNull();
    // One more minute is enough.
    expect(hrWake([...hrMinutes(450, 451, 50), ...thin], START, END)).toBe(START + 470 * MIN);
  });

  it("is null for a flat night", () => {
    expect(hrWake(hrMinutes(0, 540, 55), START, END)).toBeNull();
  });

  it("needs the full rise: one bpm short is not risen", () => {
    const short = [...hrMinutes(0, 460, 50), ...hrMinutes(460, 500, 61)];
    const enough = [...hrMinutes(0, 460, 50), ...hrMinutes(460, 500, 62)];
    expect(hrWake(short, START, END)).toBeNull();
    expect(hrWake(enough, START, END)).toBe(START + 460 * MIN);
  });

  it("ignores a rise that does not last", () => {
    // Four risen minutes near the end, then back down.
    const blip = [...hrMinutes(0, 460, 50), ...hrMinutes(460, 464, 80), ...hrMinutes(464, 520, 50)];
    expect(hrWake(blip, START, END)).toBeNull();
    // Five minutes is sustained, when that is where the data ends ...
    const held = [...hrMinutes(0, 460, 50), ...hrMinutes(460, 465, 80)];
    expect(hrWake(held, START, END)).toBe(START + 460 * MIN);
    // ... but not when the sleeper went back to sleep after them.
    const resettled = [...held, ...hrMinutes(465, 520, 50)];
    expect(hrWake(resettled, START, END)).toBeNull();
  });

  it("takes the last sustained rise, not an earlier one", () => {
    const samples = [
      ...hrMinutes(0, 400, 50),
      ...hrMinutes(400, 410, 80), // up for ten minutes, then asleep again
      ...hrMinutes(410, 455, 50),
      ...hrMinutes(455, 500, 80),
    ];
    expect(hrWake(samples, START, END)).toBe(START + 455 * MIN);
  });

  it("is null when the pulse has been up since long before the end", () => {
    // Up from minute 300: three hours before the end, outside the 90 minutes.
    const samples = [...hrMinutes(0, 300, 50), ...hrMinutes(300, 500, 80)];
    expect(hrWake(samples, START, END)).toBeNull();
    // Up from exactly ninety minutes before the end: inside.
    const edge = [...hrMinutes(0, 390, 50), ...hrMinutes(390, 500, 80)];
    expect(hrWake(edge, START, END)).toBe(START + 390 * MIN);
  });

  it("finds a wake that falls after the session's stated end", () => {
    const samples = [...hrMinutes(0, 490, 50), ...hrMinutes(490, 530, 80)];
    expect(hrWake(samples, START, END)).toBe(START + 490 * MIN);
  });

  it("does not look further than the search window after the end", () => {
    // The rise begins 61 minutes after the end.
    const samples = [...hrMinutes(0, 541, 50), ...hrMinutes(541, 600, 80)];
    expect(hrWake(samples, START, END)).toBeNull();
  });

  it("cannot call a rise sustained from the session's last minutes alone", () => {
    // Risen for the final three minutes and no data after the end.
    const cut = [...hrMinutes(0, 477, 50), ...hrMinutes(477, 480, 80)];
    expect(hrWake(cut, START, END)).toBeNull();
    // The same night with heart rate carried past the end.
    expect(hrWake([...cut, ...hrMinutes(480, 500, 80)], START, END)).toBe(START + 477 * MIN);
  });

  it("follows a rise through sparse sampling, but not across a long hole", () => {
    const fiveMinutely = (from: number, to: number, bpm: number): { t: number; bpm: number }[] =>
      steady(START + from * MIN, (to - from) / 5, bpm, 5 * MIN);
    const sparse = [...fiveMinutely(0, 450, 50), ...fiveMinutely(450, 500, 80)];
    expect(hrWake(sparse, START, END)).toBe(START + 450 * MIN);
    // Readings ten minutes apart are never a run.
    const holed = [...hrMinutes(0, 450, 50), ...steady(START + 450 * MIN, 6, 80, 10 * MIN)];
    expect(hrWake(holed, START, END)).toBeNull();
  });

  it("takes the baseline from the quiet of the night, not its average", () => {
    // A restless night: half at 50, half at 60. The mean is 55, the tenth
    // percentile 50, so 62 is a rise.
    const samples = [
      ...hrMinutes(0, 225, 60),
      ...hrMinutes(225, 450, 50),
      ...hrMinutes(450, 500, 62),
    ];
    expect(hrWake(samples, START, END)).toBe(START + 450 * MIN);
  });
});

const plain = session({});

/** The night's resting heart rate when one reading is stamped `offset` from its end. */
const restingAt = (offset: number): number | null =>
  summariseSleep(
    plain,
    context({ restingHeartRate: [instant("RestingHeartRate", END + offset, { bpm: 55 })] }),
  ).restingHr;

describe("summariseSleep: matching nightly readings", () => {
  it("uses the documented tolerance", () => {
    expect(SLEEP_MATCH_TOLERANCE_MS).toBe(30 * MIN);
    expect(RESTING_HR_BEFORE_END_TOLERANCE_MS).toBe(5 * MIN);
  });

  it("accepts a reading at the edge of the tolerance and refuses one past it", () => {
    expect(restingAt(30 * MIN)).toBe(55);
    expect(restingAt(30 * MIN + 1)).toBeNull();
    // Before the end the allowance is short: a resting heart rate written
    // while the session was still running is not this night's.
    expect(restingAt(-5 * MIN)).toBe(55);
    expect(restingAt(-5 * MIN - 1)).toBeNull();
    expect(restingAt(-30 * MIN)).toBeNull();
  });

  it("takes the nearest reading of several", () => {
    const night = summariseSleep(
      plain,
      context({
        restingHeartRate: [
          instant("RestingHeartRate", END + 20 * MIN, { bpm: 60 }),
          instant("RestingHeartRate", END + 2 * MIN, { bpm: 54 }),
          instant("RestingHeartRate", END - 10 * MIN, { bpm: 58 }),
        ],
      }),
    );
    expect(night.restingHr).toBe(54);
  });

  it("prefers the session's own origin to a nearer reading from another app", () => {
    const night = summariseSleep(
      plain,
      context({
        restingHeartRate: [
          instant("RestingHeartRate", END, { bpm: 70 }, { origin: PHONE }),
          instant("RestingHeartRate", END + 25 * MIN, { bpm: 51 }),
        ],
        respiratoryRate: [
          instant("RespiratoryRate", END, { rate: 20 }, { origin: PHONE }),
          instant("RespiratoryRate", END + 25 * MIN, { rate: 14 }),
        ],
      }),
    );
    expect(night.restingHr).toBe(51);
    expect(night.respiratoryRate).toBe(14);
  });

  it("falls back to another app's reading when the session's origin has none", () => {
    const night = summariseSleep(
      plain,
      context({
        restingHeartRate: [instant("RestingHeartRate", END, { bpm: 70 }, { origin: PHONE })],
      }),
    );
    expect(night.restingHr).toBe(70);
  });

  it("averages in-session respiratory rate when none is stamped at the end", () => {
    const night = summariseSleep(
      plain,
      context({
        respiratoryRate: [
          instant("RespiratoryRate", START + HOUR, { rate: 13 }),
          instant("RespiratoryRate", START + 3 * HOUR, { rate: 15 }),
          instant("RespiratoryRate", START + 5 * HOUR, { rate: 17 }),
          instant("RespiratoryRate", START - HOUR, { rate: 30 }), // before the session
          instant("RespiratoryRate", START + 2 * HOUR, { rate: 40 }, { origin: PHONE }),
        ],
      }),
    );
    expect(night.respiratoryRate).toBe(15);
  });

  it("does not take a mid-session resting heart rate for the night's", () => {
    const night = summariseSleep(
      plain,
      context({ restingHeartRate: [instant("RestingHeartRate", START + 4 * HOUR, { bpm: 50 })] }),
    );
    expect(night.restingHr).toBeNull();
  });

  it("matches skin temperature at the session's start, else inside it", () => {
    const skin = (start: number, deltas: number[]): HcRecord =>
      interval(
        "SkinTemperature",
        start,
        start + HOUR,
        { deltas: deltas.map((delta, index) => ({ t: start + index * MIN, delta })) },
        { origin: WEARABLE },
      );
    const anchored = summariseSleep(
      plain,
      context({ skinTemperature: [skin(START - 5 * MIN, [2, 4]), skin(START + 2 * HOUR, [10])] }),
    );
    expect(anchored.skinTempDelta).toBe(3);

    const inside = summariseSleep(
      plain,
      context({
        skinTemperature: [
          skin(START + 2 * HOUR, [1, 2]),
          skin(START + 4 * HOUR, [3]),
          skin(END + 2 * HOUR, [50]), // after the session
        ],
      }),
    );
    expect(inside.skinTempDelta).toBe(2);

    const empty = summariseSleep(plain, context({ skinTemperature: [skin(START, [])] }));
    expect(empty.skinTempDelta).toBeNull();
  });

  it("leaves HRV readings outside the session out of the quartiles", () => {
    const night = summariseSleep(
      plain,
      context({
        hrv: [
          instant("HeartRateVariabilityRmssd", START - 1, { rmssd: 500 }),
          instant("HeartRateVariabilityRmssd", START, { rmssd: 10 }),
          instant("HeartRateVariabilityRmssd", START + HOUR, { rmssd: 20 }),
          instant("HeartRateVariabilityRmssd", START + 2 * HOUR, { rmssd: 30 }),
          instant("HeartRateVariabilityRmssd", END, { rmssd: 40 }),
          instant("HeartRateVariabilityRmssd", END + 1, { rmssd: 500 }),
          instant("HeartRateVariabilityRmssd", START + 3 * HOUR, { rmssd: "n/a" }),
        ],
      }),
    );
    // 10 20 30 40: the quartiles interpolate to 17.5 and 32.5.
    expect(night.hrv?.n).toBe(4);
    expect(night.hrv?.median).toBe(25);
    expect(night.hrv?.q1).toBeCloseTo(17.5, 10);
    expect(night.hrv?.q3).toBeCloseTo(32.5, 10);
  });
});

// The four cases below share one night: eight hours, 50 bpm asleep (so a rise
// is 62 and "quiet" is under 56), heart rate carried an hour past the end.
const asleep = hrMinutes(0, 480, 50);

/** Awake from the session's end, with `minutes` back at the sleeping level from +20. */
function dipOf(minutes: number): { t: number; bpm: number }[] {
  return [
    ...asleep,
    ...hrMinutes(480, 500, 75),
    ...hrMinutes(500, 500 + minutes, 50),
    ...hrMinutes(500 + minutes, 540, 75),
  ];
}

describe("hrWake: the first rise the pulse does not come back from", () => {
  it("is not moved by one minute under the threshold", () => {
    // 72 from the session's end, with one minute at 60 half an hour on.
    const up = hrMinutes(480, 540, 72).map((sample, index) =>
      index === 30 ? { ...sample, bpm: 60 } : sample,
    );
    expect(hrWake([...asleep, ...up], START, END)).toBe(END);
  });

  it("is not moved by a minute under the threshold every so often", () => {
    // 70 from ten minutes before the end, every ninth minute at 61.
    const up = hrMinutes(470, 540, 70).map((sample, index) =>
      index % 9 === 8 ? { ...sample, bpm: 61 } : sample,
    );
    expect(hrWake([...hrMinutes(0, 470, 50), ...up], START, END)).toBe(END - 10 * MIN);
  });

  it("is not moved by five minutes just under the threshold", () => {
    // 75 from the end, 58 from twenty to twenty-five minutes after it.
    const samples = [
      ...asleep,
      ...hrMinutes(480, 500, 75),
      ...hrMinutes(500, 505, 58),
      ...hrMinutes(505, 540, 75),
    ];
    expect(hrWake(samples, START, END)).toBe(END);
  });

  it("is null for an awakening the sleeper went back to sleep from", () => {
    // Up for ten minutes an hour before the end, then asleep until the data stops.
    const samples = [
      ...hrMinutes(0, 420, 50),
      ...hrMinutes(420, 430, 80),
      ...hrMinutes(430, 480, 50),
    ];
    expect(hrWake(samples, START, END)).toBeNull();
  });

  it("bridges a short dip all the way to the baseline, but not a long one", () => {
    expect(hrWake(dipOf(4), START, END)).toBe(END);
    // Five quiet minutes is settled again: the wake is the rise after them.
    expect(hrWake(dipOf(5), START, END)).toBe(END + 25 * MIN);
  });

  it("takes the earliest such rise, not the latest re-rise", () => {
    // Up at the end, then a wandering waking pulse that keeps crossing 62.
    const wandering = hrMinutes(480, 540, 70).map((sample, index) =>
      index % 3 === 2 ? { ...sample, bpm: 57 } : sample,
    );
    expect(hrWake([...asleep, ...wandering], START, END)).toBe(END);
  });
});

describe("summariseSleep: overlapping and repeated stages", () => {
  it("counts a shared stretch once, for the stage that starts first", () => {
    const night = summariseSleep(
      session({
        stages: [
          stage(0, 100, "LIGHT"),
          stage(60, 160, "DEEP"), // its first forty minutes are already LIGHT
          stage(160, 480, "REM"),
          stage(0, 100, "LIGHT"), // written twice
        ],
      }),
      NOTHING,
    );
    expect(night.stageMin).toEqual({ LIGHT: 100, DEEP: 60, REM: 320 });
    expect(night.stagesOverlap).toBe(true);
    expect(night.stages).toEqual([
      { start: START, end: START + 100 * MIN, stage: "LIGHT" },
      { start: START + 100 * MIN, end: START + 160 * MIN, stage: "DEEP" },
      { start: START + 160 * MIN, end: END, stage: "REM" },
    ]);
  });

  it("never totals more than the time in bed", () => {
    const night = summariseSleep(
      session({
        stages: [stage(0, 480, "AWAKE"), stage(0, 480, "AWAKE"), stage(100, 300, "AWAKE")],
      }),
      NOTHING,
    );
    expect(night).toMatchObject({
      inBedMin: 480,
      awakeMin: 480,
      asleepMin: 0,
      stageMin: { AWAKE: 480 },
      stagesOverlap: true,
    });
  });

  it("drops a stage that lies wholly inside an earlier one", () => {
    const night = summariseSleep(
      session({ stages: [stage(0, 200, "DEEP"), stage(50, 100, "REM"), stage(200, 480, "LIGHT")] }),
      NOTHING,
    );
    expect(night.stageMin).toEqual({ DEEP: 200, LIGHT: 280 });
    expect(night.stagesOverlap).toBe(true);
  });

  it("says so when nothing overlapped", () => {
    expect(summariseSleep(session({ stages: NIGHT_STAGES }), NOTHING).stagesOverlap).toBe(false);
    expect(summariseSleep(session({}), NOTHING).stagesOverlap).toBe(false);
    // Stages that only touch do not overlap.
    const touching = session({ stages: [stage(0, 100, "LIGHT"), stage(100, 480, "DEEP")] });
    expect(summariseSleep(touching, NOTHING).stagesOverlap).toBe(false);
  });
});

describe("summariseSleep: a nap beside the night", () => {
  // A twenty-minute nap ten minutes after the night ends.
  const NAP_START = END + 10 * MIN;
  const NAP_END = END + 30 * MIN;
  const night = session({});
  const nap = interval("SleepSession", NAP_START, NAP_END, {});
  const nightSpan = { startMs: START, endMs: END };
  const napSpan = { startMs: NAP_START, endMs: NAP_END };
  // The night's figures, stamped five minutes after it ended -- which is also
  // within half an hour of the nap's end.
  const readings = {
    respiratoryRate: [instant("RespiratoryRate", END + 5 * MIN, { rate: 15 })],
    restingHeartRate: [
      instant("RestingHeartRate", END + 5 * MIN, { bpm: 52 }),
      instant("RestingHeartRate", NAP_END + 2 * MIN, { bpm: 58 }),
    ],
  };

  it("leaves the night's end-of-night readings to the night", () => {
    const ofNight = summariseSleep(night, context({ ...readings, others: [napSpan] }));
    const ofNap = summariseSleep(nap, context({ ...readings, others: [nightSpan] }));
    expect(ofNight).toMatchObject({ respiratoryRate: 15, restingHr: 52 });
    expect(ofNap).toMatchObject({ respiratoryRate: null, restingHr: 58 });
  });

  it("would have claimed them for the nap without knowing of the night", () => {
    expect(summariseSleep(nap, context(readings)).respiratoryRate).toBe(15);
  });

  it("does the same at the start, for skin temperature", () => {
    // A nap that ends five minutes before the night begins; the night's skin
    // temperature record starts three minutes before the night.
    const evening = { startMs: START - 25 * MIN, endMs: START - 5 * MIN };
    const skin = interval("SkinTemperature", START - 3 * MIN, END, {
      deltas: [{ t: START, delta: 2 }],
    });
    const eveningNap = interval("SleepSession", evening.startMs, evening.endMs, {});
    const withNight = context({ skinTemperature: [skin], others: [nightSpan] });
    expect(summariseSleep(eveningNap, withNight).skinTempDelta).toBeNull();
    expect(
      summariseSleep(night, context({ skinTemperature: [skin], others: [evening] })).skinTempDelta,
    ).toBe(2);
  });

  it("gives a reading midway between two anchors to the earlier session only", () => {
    // Two sessions ending twenty minutes apart, a reading ten from each.
    const early = interval("SleepSession", START, END, {});
    const late = interval("SleepSession", START, END + 20 * MIN, {});
    const midway = { respiratoryRate: [instant("RespiratoryRate", END + 10 * MIN, { rate: 16 })] };
    const ofEarly = summariseSleep(
      early,
      context({ ...midway, others: [{ startMs: START, endMs: END + 20 * MIN }] }),
    );
    const ofLate = summariseSleep(late, context({ ...midway, others: [nightSpan] }));
    expect(ofEarly.respiratoryRate).toBe(16);
    // Not anchored to the later session -- though, falling inside it, it is
    // still what was measured during it.
    expect(ofLate.respiratoryRate).toBe(16);
    expect(summariseSleep(late, context({ ...midway, others: [nightSpan] })).restingHr).toBeNull();
  });
});

describe("summariseSleep: only readings that carry a value are matched", () => {
  it("passes over a nearer record with no value for a farther one with it", () => {
    const night = summariseSleep(
      plain,
      context({
        restingHeartRate: [
          instant("RestingHeartRate", END + MIN, {}),
          instant("RestingHeartRate", END + 2 * MIN, { bpm: "low" }),
          instant("RestingHeartRate", END + 10 * MIN, { bpm: 53 }),
        ],
        respiratoryRate: [
          instant("RespiratoryRate", END, { rate: null }),
          instant("RespiratoryRate", END + 20 * MIN, { rate: 14 }),
        ],
        skinTemperature: [
          interval("SkinTemperature", START, END, { deltas: [] }),
          interval("SkinTemperature", START + 15 * MIN, END, {
            deltas: [{ t: START + HOUR, delta: 4 }],
          }),
        ],
      }),
    );
    expect(night).toMatchObject({ restingHr: 53, respiratoryRate: 14, skinTempDelta: 4 });
  });

  it("does not let a valueless record of its own origin hide another app's reading", () => {
    const night = summariseSleep(
      plain,
      context({
        restingHeartRate: [
          instant("RestingHeartRate", END + MIN, {}),
          instant("RestingHeartRate", END + 3 * MIN, { bpm: 61 }, { origin: PHONE }),
        ],
      }),
    );
    expect(night.restingHr).toBe(61);
  });
});

function rmssd(atHour: number, value: number, origin = WEARABLE): HcRecord {
  return instant("HeartRateVariabilityRmssd", START + atHour * HOUR, { rmssd: value }, { origin });
}

describe("summariseSleep: HRV by origin", () => {
  it("uses the session's own origin's readings when it has any", () => {
    const night = summariseSleep(
      plain,
      context({
        hrv: [rmssd(1, 10), rmssd(2, 20), rmssd(3, 30), rmssd(4, 100, PHONE), rmssd(5, 200, PHONE)],
      }),
    );
    expect(night.hrv).toEqual({ median: 20, q1: 15, q3: 25, n: 3 });
  });

  it("falls back to other apps' readings when it has none", () => {
    const night = summariseSleep(
      plain,
      context({
        hrv: [
          rmssd(4, 100, PHONE),
          rmssd(5, 200, PHONE),
          // The session's own origin wrote a record, but with no value in it.
          instant("HeartRateVariabilityRmssd", START + HOUR, {}),
        ],
      }),
    );
    expect(night.hrv).toEqual({ median: 150, q1: 125, q3: 175, n: 2 });
  });
});
