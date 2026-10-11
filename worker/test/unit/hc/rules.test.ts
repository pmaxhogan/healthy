// The query-time duplicate and artefact rules. All values invented; the origins
// are the project's placeholder package names.

import { describe, expect, it } from "vitest";

import {
  BP_SESSION_WINDOW_MIN,
  FLOORS_ARE_NOISY,
  FLOORS_MAX_PER_MINUTE,
  HR_MAX_PLAUSIBLE_BPM,
  HR_MIN_PLAUSIBLE_BPM,
  LEFT_RUNNING_MIN_DURATION_MS,
  LEFT_RUNNING_TAIL_MAX_BPM,
  LEFT_RUNNING_TAIL_MAX_STEPS,
  LEFT_RUNNING_TAIL_MS,
  PROFILE_ARTEFACT_WINDOW_MS,
  SPEED_MAX_PLAUSIBLE_MPS,
  ZERO_LENGTH_SESSION_MAX_MS,
  dedupeBloodPressure,
  excludingFlagged,
  flagFloors,
  flagHeartRateArtefacts,
  flagSpeedArtefacts,
  flagWeightArtefacts,
  groupBloodPressureSessions,
  isExactDuplicateSession,
  isLikelyLeftRunning,
  isOverThreeHours,
  isZeroLengthSession,
  mergeOverlappingSessions,
  quantityWithin,
  sessionsOverlap,
} from "../../../src/hc/rules.ts";

import {
  CUFF,
  HOUR,
  MIN,
  PHONE,
  SECOND,
  T0,
  WEARABLE,
  instant,
  interval,
  steady,
} from "./rollup/fixtures.ts";

import type { ArtefactFlag, ArtefactReason } from "../../../src/hc/rules.ts";
import type { HcRecord } from "../../../src/hc/wire.ts";

function bp(
  time: number,
  systolic: number,
  diastolic: number,
  overrides: Partial<HcRecord> = {},
): HcRecord {
  return instant("BloodPressure", time, { systolic, diastolic }, { origin: CUFF, ...overrides });
}

/** An exercise session from minute `from` to minute `to` after T0. */
function workout(from: number, to: number, overrides: Partial<HcRecord> = {}): HcRecord {
  return interval(
    "ExerciseSession",
    T0 + from * MIN,
    T0 + to * MIN,
    { exerciseType: "WALKING" },
    overrides,
  );
}

function series(type: string, key: string, values: readonly number[]): HcRecord {
  return interval(type, T0, T0 + values.length * SECOND, {
    samples: values.map((value, index) => ({ t: T0 + index * SECOND, [key]: value })),
  });
}

function floors(count: unknown, lengthMs: number): HcRecord {
  return interval("FloorsClimbed", T0, T0 + lengthMs, { floors: count });
}

const ids = (records: readonly HcRecord[]): string[] => records.map((record) => record.id);

const byText = (left: string, right: string): number => left.localeCompare(right);

describe("the thresholds", () => {
  it("are the documented values", () => {
    expect(BP_SESSION_WINDOW_MIN).toBe(10);
    expect(HR_MAX_PLAUSIBLE_BPM).toBe(200);
    expect(HR_MIN_PLAUSIBLE_BPM).toBe(20);
    expect(SPEED_MAX_PLAUSIBLE_MPS).toBe(15);
    expect(PROFILE_ARTEFACT_WINDOW_MS).toBe(MIN);
    expect(ZERO_LENGTH_SESSION_MAX_MS).toBe(SECOND);
    expect(LEFT_RUNNING_MIN_DURATION_MS).toBe(3 * HOUR);
    expect(LEFT_RUNNING_TAIL_MS).toBe(30 * MIN);
    expect(LEFT_RUNNING_TAIL_MAX_BPM).toBe(100);
    expect(LEFT_RUNNING_TAIL_MAX_STEPS).toBe(30);
    expect(FLOORS_MAX_PER_MINUTE).toBe(10);
    expect(FLOORS_ARE_NOISY).toBe(true);
  });
});

describe("dedupeBloodPressure", () => {
  it("drops the later-written copy of a reading relayed by a second app", () => {
    const original = bp(T0, 120, 80, { lastModified: T0 + 5 * SECOND });
    // Same second (the relay lost the milliseconds), written a minute later.
    const relayed = bp(T0 + 400, 120, 80, { origin: PHONE, lastModified: T0 + MIN });
    const result = dedupeBloodPressure([original, relayed]);
    expect(result.kept).toEqual([original]);
    expect(result.duplicates).toEqual([
      { record: relayed, duplicateOf: original.id, reason: "same_second_same_reading" },
    ]);
  });

  it("keeps the earliest-written copy wherever it sits in the input", () => {
    const original = bp(T0, 120, 80, { lastModified: T0 + 5 * SECOND });
    const relayed = bp(T0, 120, 80, { origin: PHONE, lastModified: T0 + MIN });
    const result = dedupeBloodPressure([relayed, original]);
    expect(result.kept).toEqual([original]);
    expect(result.duplicates[0]?.record).toBe(relayed);
  });

  it("breaks a tie on lastModified by origin name, then by id", () => {
    const fromPhone = bp(T0, 120, 80, { origin: PHONE, lastModified: T0 });
    const fromCuff = bp(T0, 120, 80, { origin: CUFF, lastModified: T0 });
    // "com.example.cuff" sorts before "com.example.phone".
    expect(dedupeBloodPressure([fromPhone, fromCuff]).kept).toEqual([fromCuff]);

    const b = bp(T0, 120, 80, { id: "b", lastModified: T0 });
    const a = bp(T0, 120, 80, { id: "a", lastModified: T0 });
    expect(dedupeBloodPressure([b, a]).kept).toEqual([a]);
  });

  it("collapses three copies to one", () => {
    const copies = [
      bp(T0 + 300, 118, 76, { lastModified: T0 + 3 }),
      bp(T0, 118, 76, { lastModified: T0 + 1 }),
      bp(T0 - 400, 118, 76, { lastModified: T0 + 2 }),
    ];
    const result = dedupeBloodPressure(copies);
    expect(ids(result.kept)).toEqual([copies[1]?.id]);
    expect(result.duplicates.map((drop) => drop.duplicateOf)).toEqual([
      copies[1]?.id,
      copies[1]?.id,
    ]);
  });

  it("keeps readings that differ in the second or in either number", () => {
    const readings = [
      bp(T0, 120, 80),
      bp(T0 + SECOND, 120, 80), // the next second: a genuine repeat reading
      bp(T0, 121, 80),
      bp(T0, 120, 81),
    ];
    const result = dedupeBloodPressure(readings);
    expect(result.kept).toEqual(readings);
    expect(result.duplicates).toEqual([]);
  });

  it("keeps input order and never matches a record missing a number", () => {
    const partial = instant("BloodPressure", T0, { systolic: 120 }, { origin: CUFF });
    const partialTwin = instant("BloodPressure", T0, { systolic: 120 }, { origin: PHONE });
    const late = bp(T0 + HOUR, 130, 85);
    const early = bp(T0, 120, 80);
    const result = dedupeBloodPressure([late, partial, early, partialTwin]);
    expect(result.kept).toEqual([late, partial, early, partialTwin]);
  });

  it("is empty for nothing", () => {
    expect(dedupeBloodPressure([])).toEqual({ kept: [], duplicates: [] });
  });
});

describe("groupBloodPressureSessions", () => {
  // A morning sitting of three, and an evening one that drifts on.
  const morning = [bp(T0, 124, 82), bp(T0 + 2 * MIN, 120, 80), bp(T0 + 4 * MIN, 116, 78)];
  const evening = [
    bp(T0 + 12 * HOUR, 130, 90),
    bp(T0 + 12 * HOUR + 8 * MIN, 134, 86),
    bp(T0 + 12 * HOUR + 17 * MIN, 132, 88),
  ];

  it("groups readings taken within the window of the one before", () => {
    const sittings = groupBloodPressureSessions([...evening, ...morning]);
    expect(sittings).toEqual([
      { startMs: T0, endMs: T0 + 4 * MIN, readings: morning, systolic: 120, diastolic: 80 },
      {
        startMs: T0 + 12 * HOUR,
        // Each reading is within ten minutes of the last, so the sitting runs seventeen.
        endMs: T0 + 12 * HOUR + 17 * MIN,
        readings: evening,
        systolic: 132,
        diastolic: 88,
      },
    ]);
  });

  it("splits at a gap longer than the window, and joins at exactly the window", () => {
    const readings = [bp(T0, 120, 80), bp(T0 + 10 * MIN, 122, 80), bp(T0 + 20 * MIN + 1, 124, 80)];
    expect(groupBloodPressureSessions(readings).map((sitting) => sitting.readings.length)).toEqual([
      2, 1,
    ]);
  });

  it("takes the window it is given", () => {
    expect(groupBloodPressureSessions(morning, 1)).toHaveLength(3);
    expect(groupBloodPressureSessions([...morning, ...evening], 24 * 60)).toHaveLength(1);
  });

  it("averages only the readings that carry a value", () => {
    const [sitting] = groupBloodPressureSessions([
      bp(T0, 120, 80),
      instant("BloodPressure", T0 + MIN, { systolic: 130 }, { origin: CUFF }),
    ]);
    expect(sitting).toMatchObject({ systolic: 125, diastolic: 80 });
    const [empty] = groupBloodPressureSessions([instant("BloodPressure", T0, {})]);
    expect(empty).toMatchObject({ systolic: null, diastolic: null });
  });

  it("is empty for nothing", () => {
    expect(groupBloodPressureSessions([])).toEqual([]);
  });
});

describe("flagHeartRateArtefacts", () => {
  it("takes implausible samples out and flags each", () => {
    const record = series("HeartRate", "bpm", [80, 201, 90, 230]);
    const { kept, flags } = flagHeartRateArtefacts([record]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.id).toBe(record.id);
    expect(kept[0]?.data.samples).toEqual([
      { t: T0, bpm: 80 },
      { t: T0 + 2 * SECOND, bpm: 90 },
    ]);
    expect(flags).toEqual([
      {
        recordId: record.id,
        origin: WEARABLE,
        reason: "heart_rate_implausible",
        t: T0 + SECOND,
        value: 201,
      },
      {
        recordId: record.id,
        origin: WEARABLE,
        reason: "heart_rate_implausible",
        t: T0 + 3 * SECOND,
        value: 230,
      },
    ]);
    // The stored record is untouched.
    expect(record.data.samples).toHaveLength(4);
  });

  it("keeps a reading at the limit, and returns a clean record as it was", () => {
    const record = series("HeartRate", "bpm", [200, 199, 45]);
    const { kept, flags } = flagHeartRateArtefacts([record]);
    expect(kept[0]).toBe(record);
    expect(flags).toEqual([]);
  });

  it("drops a record left with no samples, and keeps one that never had any", () => {
    const allBad = series("HeartRate", "bpm", [240, 250]);
    const empty = interval("HeartRate", T0, T0 + MIN, { samples: [] });
    const shapeless = interval("HeartRate", T0, T0 + MIN, {});
    const { kept, flags } = flagHeartRateArtefacts([allBad, empty, shapeless]);
    expect(kept).toEqual([empty, shapeless]);
    expect(flags).toHaveLength(2);
  });

  it("leaves samples it cannot read where they are", () => {
    const record = interval("HeartRate", T0, T0 + MIN, {
      samples: [null, { t: T0, bpm: "fast" }, { bpm: 300 }],
    });
    const { kept, flags } = flagHeartRateArtefacts([record]);
    expect(kept[0]?.data.samples).toEqual([null, { t: T0, bpm: "fast" }]);
    // No time of its own: flagged at its record's start.
    expect(flags).toMatchObject([{ t: T0, value: 300 }]);
  });
});

describe("flagSpeedArtefacts", () => {
  it("flags samples over the limit and keeps the rest", () => {
    const record = series("Speed", "speed", [3, 15, 16, 4]);
    const { kept, flags } = flagSpeedArtefacts([record]);
    expect(kept[0]?.data.samples).toEqual([
      { t: T0, speed: 3 },
      { t: T0 + SECOND, speed: 15 },
      { t: T0 + 3 * SECOND, speed: 4 },
    ]);
    expect(flags).toEqual([
      {
        recordId: record.id,
        origin: WEARABLE,
        reason: "speed_implausible",
        t: T0 + 2 * SECOND,
        value: 16,
      },
    ]);
  });

  it("does not read heart rate, nor the heart-rate rule speed", () => {
    const record = series("Speed", "speed", [250]);
    expect(flagHeartRateArtefacts([record]).flags).toEqual([]);
    expect(flagSpeedArtefacts([series("HeartRate", "bpm", [250])]).flags).toEqual([]);
  });
});

const weight = (time: number, origin: string, overrides: Partial<HcRecord> = {}): HcRecord =>
  instant("Weight", time, { weight: 70 }, { origin, ...overrides });
const height = (time: number, origin: string): HcRecord =>
  instant("Height", time, { height: 2 }, { origin });
const bmr = (time: number, origin: string): HcRecord =>
  instant("BasalMetabolicRate", time, { bmr: 1600 }, { origin });
const none = { height: [], basalMetabolicRate: [] };

const flagged = (offset: number): boolean =>
  flagWeightArtefacts([weight(T0, PHONE)], { ...none, height: [height(T0 + offset, PHONE)] }).flags
    .length === 1;

describe("flagWeightArtefacts", () => {
  it("flags a weight written with a height by the same origin", () => {
    const typed = weight(T0, PHONE);
    const weighed = weight(T0 + HOUR, PHONE);
    const result = flagWeightArtefacts([typed, weighed], {
      ...none,
      height: [height(T0 + 30 * SECOND, PHONE)],
    });
    expect(result.kept).toEqual([weighed]);
    const reason: ArtefactReason = "weight_profile_setup";
    const expected: ArtefactFlag[] = [
      { recordId: typed.id, origin: PHONE, reason, t: T0, value: 70 },
    ];
    expect(result.flags).toEqual(expected);
  });

  it("does not flag a weight for a basal metabolic rate beside it", () => {
    // Some apps write a BMR with every genuine weigh-in.
    const weighed = weight(T0, PHONE);
    const result = flagWeightArtefacts([weighed], {
      ...none,
      basalMetabolicRate: [bmr(T0 - 10 * SECOND, PHONE), bmr(T0, PHONE)],
    });
    expect(result).toEqual({ records: [weighed], kept: [weighed], flags: [] });
  });

  it("flags every weight in the cluster around a height, and drops none", () => {
    const first = weight(T0 - 20 * SECOND, PHONE);
    const second = weight(T0 + 5 * SECOND, PHONE);
    const third = weight(T0 + 50 * SECOND, PHONE);
    const weighed = weight(T0 + 10 * MIN, PHONE);
    const all = [first, second, third, weighed];
    const result = flagWeightArtefacts(all, { height: [height(T0, PHONE)] });
    expect(result.flags.map((flag) => flag.recordId)).toEqual([first.id, second.id, third.id]);
    // The full list is still there; the helper and `kept` give the rest.
    expect(result.records).toEqual(all);
    expect(result.kept).toEqual([weighed]);
    expect(excludingFlagged(result.records, result.flags)).toEqual([weighed]);
  });

  it("does not flag across origins", () => {
    const weighed = weight(T0, WEARABLE);
    const result = flagWeightArtefacts([weighed], { ...none, height: [height(T0, PHONE)] });
    expect(result).toEqual({ records: [weighed], kept: [weighed], flags: [] });
  });

  it("draws the line at one minute, either side", () => {
    expect(flagged(MIN)).toBe(true);
    expect(flagged(-MIN)).toBe(true);
    expect(flagged(MIN + 1)).toBe(false);
    expect(flagged(-MIN - 1)).toBe(false);
  });

  it("goes by the records' times, not by when they were last modified", () => {
    // Edited much later, at the same moment as a height record was written.
    const weighed = weight(T0, PHONE, { lastModified: T0 + 5 * HOUR });
    const result = flagWeightArtefacts([weighed], {
      ...none,
      height: [height(T0 + 5 * HOUR, PHONE)],
    });
    expect(result.kept).toEqual([weighed]);
  });

  it("flags nothing with no profile records around", () => {
    const weights = [weight(T0, PHONE), weight(T0 + MIN, CUFF)];
    expect(flagWeightArtefacts(weights, none)).toEqual({
      records: weights,
      kept: weights,
      flags: [],
    });
  });

  it("flags a weight record that carries no value with a null value", () => {
    const blank = instant("Weight", T0, {}, { origin: PHONE });
    const result = flagWeightArtefacts([blank], { ...none, height: [height(T0, PHONE)] });
    expect(result.flags[0]?.value).toBeNull();
  });
});

const span = (from: number, to: number): { startMs: number; endMs: number } => ({
  startMs: T0 + from,
  endMs: T0 + to,
});

describe("session predicates", () => {
  it("calls sessions overlapping only when they share a stretch of time", () => {
    expect(sessionsOverlap(span(0, 10), span(5, 15))).toBe(true);
    expect(sessionsOverlap(span(5, 15), span(0, 10))).toBe(true);
    expect(sessionsOverlap(span(0, 10), span(2, 3))).toBe(true);
    expect(sessionsOverlap(span(0, 10), span(10, 20))).toBe(false);
    expect(sessionsOverlap(span(0, 10), span(11, 20))).toBe(false);
    // A zero-length session shares no stretch, even with itself.
    expect(sessionsOverlap(span(5, 5), span(5, 5))).toBe(false);
    expect(sessionsOverlap(span(0, 10), span(5, 5))).toBe(true);
  });

  it("calls sessions exact duplicates when start and end agree to the second", () => {
    expect(isExactDuplicateSession(span(0, 60_000), span(999, 60_999))).toBe(true);
    expect(isExactDuplicateSession(span(0, 60_000), span(1000, 60_000))).toBe(false);
    expect(isExactDuplicateSession(span(0, 60_000), span(0, 61_000))).toBe(false);
  });

  it("calls a session under a second long zero length", () => {
    expect(isZeroLengthSession(span(0, 0))).toBe(true);
    expect(isZeroLengthSession(span(0, 999))).toBe(true);
    expect(isZeroLengthSession(span(0, 1000))).toBe(false);
  });
});

describe("isLikelyLeftRunning", () => {
  const long = { startMs: T0, endMs: T0 + 4 * HOUR };

  it("needs more than three hours", () => {
    expect(isLikelyLeftRunning({ startMs: T0, endMs: T0 + 3 * HOUR }, [], [])).toBe(false);
    expect(isLikelyLeftRunning({ startMs: T0, endMs: T0 + 3 * HOUR + 1 }, [], [])).toBe(true);
  });

  it("needs both signals quiet when it has both", () => {
    const restingTail = [...steady(T0, 60, 150), ...steady(T0 + HOUR, 180, 60)];
    const activeTail = steady(T0, 240, 150);
    const earlySteps = [interval("Steps", T0, T0 + HOUR, { count: 6000 })];
    const lateSteps = [
      ...earlySteps,
      interval("Steps", T0 + 3 * HOUR + 40 * MIN, T0 + 4 * HOUR, { count: 800 }),
    ];
    expect(isLikelyLeftRunning(long, restingTail, earlySteps)).toBe(true);
    expect(isLikelyLeftRunning(long, restingTail, lateSteps)).toBe(false);
    expect(isLikelyLeftRunning(long, activeTail, earlySteps)).toBe(false);
    expect(isLikelyLeftRunning(long, activeTail, lateSteps)).toBe(false);
  });

  it("counts an instantaneous step record in the tail whole", () => {
    const quiet = steady(T0, 240, 60);
    const burst = (count: number): HcRecord[] => [
      interval("Steps", T0 + 4 * HOUR - MIN, T0 + 4 * HOUR - MIN, { count }),
    ];
    expect(isLikelyLeftRunning(long, quiet, burst(30))).toBe(true);
    expect(isLikelyLeftRunning(long, quiet, burst(31))).toBe(false);
  });
});

describe("mergeOverlappingSessions", () => {
  it("leaves sessions that do not overlap as groups of one, in time order", () => {
    const later = workout(120, 150);
    const earlier = workout(0, 30);
    expect(mergeOverlappingSessions([later, earlier])).toEqual([
      {
        startMs: T0,
        endMs: T0 + 30 * MIN,
        sessions: [earlier],
        primary: earlier,
        exactDuplicates: 0,
      },
      {
        startMs: T0 + 120 * MIN,
        endMs: T0 + 150 * MIN,
        sessions: [later],
        primary: later,
        exactDuplicates: 0,
      },
    ]);
  });

  it("merges overlapping sessions into the union of their time", () => {
    const a = workout(0, 60);
    const b = workout(30, 90, { origin: PHONE });
    const [group, ...rest] = mergeOverlappingSessions([b, a]);
    expect(rest).toEqual([]);
    expect(group).toMatchObject({ startMs: T0, endMs: T0 + 90 * MIN, exactDuplicates: 0 });
    expect(group?.sessions).toEqual([a, b]);
  });

  it("does not merge sessions that only touch", () => {
    expect(mergeOverlappingSessions([workout(0, 60), workout(60, 90)])).toHaveLength(2);
  });

  it("follows a chain of overlaps into one group", () => {
    const sessions = [workout(0, 10), workout(5, 20), workout(15, 30), workout(40, 50)];
    const groups = mergeOverlappingSessions(sessions);
    expect(groups.map((group) => [group.startMs, group.endMs, group.sessions.length])).toEqual([
      [T0, T0 + 30 * MIN, 3],
      [T0 + 40 * MIN, T0 + 50 * MIN, 1],
    ]);
  });

  it("keeps a session wholly inside another in its group without shortening it", () => {
    const outer = workout(0, 120);
    const inner = workout(30, 40);
    const tail = workout(100, 130);
    const [group] = mergeOverlappingSessions([inner, tail, outer]);
    expect(group).toMatchObject({ startMs: T0, endMs: T0 + 130 * MIN, primary: outer });
    expect(group?.sessions).toHaveLength(3);
  });

  it("picks the longest session as primary, then the one written first", () => {
    const short = workout(0, 30, { lastModified: T0 });
    const longLate = workout(10, 70, { lastModified: T0 + 2 * HOUR, origin: PHONE });
    const longEarly = workout(20, 80, { lastModified: T0 + HOUR });
    const [group] = mergeOverlappingSessions([short, longLate, longEarly]);
    expect(group?.primary).toBe(longEarly);
  });

  it("counts exact duplicates within a group", () => {
    const original = workout(0, 60, { lastModified: T0 + HOUR });
    const copy = interval(
      "ExerciseSession",
      T0 + 300,
      T0 + 60 * MIN + 300,
      { exerciseType: "WALKING" },
      { origin: PHONE, lastModified: T0 + 2 * HOUR },
    );
    const third = workout(0, 60, { origin: CUFF, lastModified: T0 + 3 * HOUR });
    const [group, ...rest] = mergeOverlappingSessions([copy, third, original]);
    expect(rest).toEqual([]);
    expect(group).toMatchObject({ exactDuplicates: 2, primary: original });
  });

  it("joins zero-length sessions at one instant, which overlap nothing", () => {
    const a = workout(5, 5);
    const b = workout(5, 5, { origin: PHONE });
    const apart = workout(6, 6);
    const groups = mergeOverlappingSessions([a, b, apart]);
    expect(groups.map((group) => [group.sessions.length, group.exactDuplicates])).toEqual([
      [2, 1],
      [1, 0],
    ]);
  });

  it("loses no session and changes none", () => {
    const sessions = [
      workout(0, 10),
      workout(5, 20),
      workout(50, 60),
      workout(50, 60),
      workout(9, 9),
    ];
    const before = structuredClone(sessions);
    const groups = mergeOverlappingSessions(sessions);
    expect(groups.flatMap((group) => ids(group.sessions)).toSorted(byText)).toEqual(
      ids(sessions).toSorted(byText),
    );
    expect(sessions).toEqual(before);
  });

  it("is empty for nothing", () => {
    expect(mergeOverlappingSessions([])).toEqual([]);
  });
});

describe("flagFloors", () => {
  it("always says floors are noisy", () => {
    expect(flagFloors([]).noisy).toBe(true);
    expect(flagFloors([floors(3, 5 * MIN)]).noisy).toBe(true);
  });

  it("keeps a believable climb", () => {
    const record = floors(3, 5 * MIN);
    expect(flagFloors([record])).toMatchObject({ kept: [record], flags: [] });
  });

  it("flags a rate no one climbs at", () => {
    const steady10 = floors(50, 5 * MIN); // exactly ten a minute
    const tooFast = floors(51, 5 * MIN);
    const result = flagFloors([steady10, tooFast]);
    expect(result.kept).toEqual([steady10]);
    expect(result.flags).toEqual([
      {
        recordId: tooFast.id,
        origin: WEARABLE,
        reason: "floors_implausible",
        t: T0,
        value: 51,
      },
    ]);
  });

  it("rates a record shorter than a minute as a minute", () => {
    const burst = floors(5, 10 * SECOND);
    const absurd = floors(11, 10 * SECOND);
    const result = flagFloors([burst, absurd]);
    expect(result.kept).toEqual([burst]);
    expect(result.flags.map((flag) => flag.value)).toEqual([11]);
  });

  it("flags a negative count and keeps a record with no count", () => {
    const negative = floors(-1, MIN);
    const blank = floors(undefined, MIN);
    const zero = floors(0, MIN);
    const result = flagFloors([negative, blank, zero]);
    expect(result.kept).toEqual([blank, zero]);
    expect(result.flags.map((flag) => flag.recordId)).toEqual([negative.id]);
  });
});

describe("dedupeBloodPressure: a relay's rounding", () => {
  it("matches times to the nearest second, not the truncated one", () => {
    // 10:00:00.900 relayed as 10:00:01.100: a truncation boundary lies between.
    const original = bp(T0 + 900, 120, 80, { lastModified: T0 });
    const relayed = bp(T0 + 1100, 120, 80, { origin: PHONE, lastModified: T0 + MIN });
    const result = dedupeBloodPressure([original, relayed]);
    expect(result.kept).toEqual([original]);
    expect(result.duplicates.map((drop) => drop.record)).toEqual([relayed]);
  });

  it("still keeps readings a whole second apart", () => {
    const readings = [bp(T0 + 400, 120, 80), bp(T0 + 1600, 120, 80)];
    expect(dedupeBloodPressure(readings).kept).toEqual(readings);
  });

  it("matches values to a tenth of a mmHg", () => {
    const original = bp(T0, 120, 80, { lastModified: T0 });
    // What a float round trip hands back.
    const noisy = bp(T0, 119.9999, 80.0001, { origin: PHONE, lastModified: T0 + 1 });
    const different = bp(T0, 120.1, 80, { origin: PHONE, lastModified: T0 + 2 });
    const result = dedupeBloodPressure([original, noisy, different]);
    expect(result.kept).toEqual([original, different]);
    expect(result.duplicates.map((drop) => drop.record)).toEqual([noisy]);
  });
});

describe("flagHeartRateArtefacts: the lower bound", () => {
  it("flags zero, negative and impossibly low readings", () => {
    const record = series("HeartRate", "bpm", [0, -5, 19, 20, 80]);
    const before = structuredClone(record);
    const { records, kept, flags } = flagHeartRateArtefacts([record]);
    expect(flags.map((flag) => flag.value)).toEqual([0, -5, 19]);
    expect(flags.every((flag) => flag.reason === "heart_rate_implausible")).toBe(true);
    expect(kept[0]?.data.samples).toEqual([
      { t: T0 + 3 * SECOND, bpm: 20 },
      { t: T0 + 4 * SECOND, bpm: 80 },
    ]);
    // The input is returned whole and is not modified.
    expect(records).toEqual([record]);
    expect(records[0]).toBe(record);
    expect(record).toEqual(before);
  });

  it("returns the full list beside what it kept, for every artefact rule", () => {
    const hr = series("HeartRate", "bpm", [250]);
    const speed = series("Speed", "speed", [40]);
    const climb = floors(500, MIN);
    expect(flagHeartRateArtefacts([hr])).toMatchObject({ records: [hr], kept: [] });
    expect(flagSpeedArtefacts([speed])).toMatchObject({ records: [speed], kept: [] });
    expect(flagFloors([climb])).toMatchObject({ records: [climb], kept: [] });
  });

  it("puts no lower bound on speed", () => {
    expect(flagSpeedArtefacts([series("Speed", "speed", [0, 0.5])]).flags).toEqual([]);
  });
});

describe("mergeOverlappingSessions: duplicates that are not adjacent", () => {
  it("groups exact duplicates when another session sorts between them", () => {
    // Two zero-length copies in one second, and a real session that starts
    // between them: the copies overlap nothing, so only the duplicate link
    // can bring them together.
    const first = interval("ExerciseSession", T0 + 100, T0 + 100, {});
    const between = interval("ExerciseSession", T0 + 200, T0 + 30 * MIN, {});
    const second = interval("ExerciseSession", T0 + 900, T0 + 900, {}, { origin: PHONE });
    const groups = mergeOverlappingSessions([second, between, first]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      startMs: T0 + 100,
      endMs: T0 + 30 * MIN,
      exactDuplicates: 1,
      primary: between,
    });
    expect(groups[0]?.sessions).toEqual([first, between, second]);
  });
});

/** A Steps record from minute `fromMin` to minute `toMin` after T0. */
function record(fromMin: number, toMin: number, count: unknown): HcRecord {
  return interval("Steps", T0 + fromMin * MIN, T0 + toMin * MIN, { count });
}

describe("quantityWithin", () => {
  it("counts a record inside the window whole and a straddling one in proportion", () => {
    const records = [record(10, 20, 100), record(-2, 3, 500), record(58, 63, 250)];
    // 100 + three fifths of 500 + two fifths of 250.
    expect(quantityWithin(records, "count", T0, T0 + 60 * MIN)).toBe(500);
  });

  it("counts an instantaneous record whole when it is inside, ends included", () => {
    const records = [record(0, 0, 7), record(60, 60, 5), record(61, 61, 100)];
    expect(quantityWithin(records, "count", T0, T0 + 60 * MIN)).toBe(12);
  });

  it("is null with no share in the window, and zero for a measured zero", () => {
    expect(quantityWithin([], "count", T0, T0 + HOUR)).toBeNull();
    expect(
      quantityWithin([record(-10, 0, 50), record(60, 70, 50)], "count", T0, T0 + HOUR),
    ).toBeNull();
    expect(quantityWithin([record(5, 6, "many")], "count", T0, T0 + HOUR)).toBeNull();
    expect(quantityWithin([record(5, 6, 0)], "count", T0, T0 + HOUR)).toBe(0);
  });
});

const kindOf = (record: HcRecord): string => String(record.data.exerciseType);
const memberIds = (groups: { sessions: HcRecord[] }[]): string[][] =>
  groups.map((group) => group.sessions.map((session) => session.id));

describe("mergeOverlappingSessions: what may be merged", () => {
  it("does not let a session past the bound absorb what it overlaps", () => {
    // Thirty hours nobody stopped, and a forty-minute session the next day.
    const forgotten = workout(0, 30 * 60, { id: "forgotten" });
    const real = workout(24 * 60, 24 * 60 + 40, { id: "real", origin: PHONE });

    const unbounded = mergeOverlappingSessions([forgotten, real]);
    const bounded = mergeOverlappingSessions([forgotten, real], { maxMs: 12 * HOUR });

    // Without a bound they are one group, described by the forgotten one.
    expect(memberIds(unbounded)).toStrictEqual([["forgotten", "real"]]);
    expect(memberIds(bounded)).toStrictEqual([["forgotten"], ["real"]]);
    expect(bounded[1]).toMatchObject({ startMs: T0 + 24 * 60 * MIN, primary: real });
  });

  it("still merges what the stand-alone session overlaps with each other", () => {
    const forgotten = workout(0, 30 * 60, { id: "forgotten" });
    const real = workout(600, 640, { id: "real" });
    const copy = workout(605, 645, { id: "copy", origin: PHONE });

    const groups = mergeOverlappingSessions([forgotten, real, copy], { maxMs: 12 * HOUR });

    expect(memberIds(groups)).toStrictEqual([["forgotten"], ["real", "copy"]]);
  });

  it("does not merge into a session the caller says stands alone, whatever its length", () => {
    const flagged = workout(0, 200, { id: "flagged" });
    const inside = workout(60, 90, { id: "inside", origin: PHONE });

    const groups = mergeOverlappingSessions([flagged, inside], {
      standsAlone: (record) => record.id === "flagged",
    });

    expect(memberIds(groups)).toStrictEqual([["flagged"], ["inside"]]);
  });

  it("does not merge two kinds of session that overlap", () => {
    const walk = workout(0, 60, { id: "walk" });
    const yoga = { ...workout(30, 50, { id: "yoga" }), data: { exerciseType: "YOGA" } };
    const walkCopy = workout(10, 70, { id: "walk-copy", origin: PHONE });

    expect(memberIds(mergeOverlappingSessions([walk, yoga, walkCopy], { kindOf }))).toStrictEqual([
      ["walk", "walk-copy"],
      ["yoga"],
    ]);
    // Without a kind they are one stretch, as before.
    expect(memberIds(mergeOverlappingSessions([walk, yoga, walkCopy]))).toStrictEqual([
      ["walk", "walk-copy", "yoga"],
    ]);
  });

  it("links exact duplicates even when the session stands alone", () => {
    const forgotten = workout(0, 30 * 60, { id: "forgotten" });
    const relayed = workout(0, 30 * 60, { id: "relayed", origin: PHONE });

    const [group, ...rest] = mergeOverlappingSessions([forgotten, relayed], { maxMs: 12 * HOUR });

    expect(rest).toStrictEqual([]);
    expect(group).toMatchObject({ exactDuplicates: 1 });
  });

  it("calls a session long by the clock alone", () => {
    expect(isOverThreeHours({ startMs: T0, endMs: T0 + LEFT_RUNNING_MIN_DURATION_MS })).toBe(false);
    expect(isOverThreeHours({ startMs: T0, endMs: T0 + LEFT_RUNNING_MIN_DURATION_MS + 1 })).toBe(
      true,
    );
  });
});
