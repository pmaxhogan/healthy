/**
 * Duplicate and artefact rules for Health Connect data. The ONE place they
 * live.
 *
 * The store keeps everything the phone sends, exactly. Nothing is marked or
 * dropped at ingest. These rules are applied when a question is answered, and
 * the answer reports what they removed or flagged -- so a rule that turns out
 * to be wrong costs a code change, not lost data, and two tools can never
 * disagree about what counts as a duplicate.
 *
 * Every function is pure and takes records as the store returns them. None
 * modifies its input; where a record has to change (an implausible sample
 * removed from a series) a copy is returned in its place. Every threshold is a
 * named constant with the reason for its value.
 *
 * Why these rules exist at all: several apps write to one Health Connect
 * store. A cuff's reading can arrive once from its own app and again relayed
 * by another; a wearable's optical sensor now and then locks onto footfalls
 * instead of the pulse; a profile set-up screen writes the weight typed into
 * it as though it were a weighing; and a workout is sometimes left running.
 */

import { minuteSeries } from "./rollup/hr.ts";
import { mean, sortedBy } from "./rollup/stats.ts";
import { recordEndMs, recordStartMs } from "./wire.ts";

import type { HrSample } from "./rollup/hr.ts";
import type { HcRecord } from "./wire.ts";

const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compareText(left: string, right: string): number {
  // Code-unit order, not a locale's: the tie-break only has to be the same
  // everywhere it runs.
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Earliest-written first; ties by origin name, then by id, so the order is total. */
function byWriteOrder(left: HcRecord, right: HcRecord): number {
  return (
    left.lastModified - right.lastModified ||
    compareText(left.origin, right.origin) ||
    compareText(left.id, right.id)
  );
}

/** One thing a rule noticed about a record, or about one sample inside it. */
export interface ArtefactFlag {
  recordId: string;
  origin: string;
  reason: ArtefactReason;
  /** When the flagged value was measured, epoch ms. */
  t: number;
  /** The flagged value, in the field's fixed unit; null when the record carries none. */
  value: number | null;
}

export type ArtefactReason =
  "heart_rate_implausible" | "speed_implausible" | "weight_profile_setup" | "floors_implausible";

/**
 * What an artefact rule returns. A flag never drops data: `records` is always
 * everything the rule was given.
 */
export interface ArtefactResult {
  /** Every record passed in, untouched and in input order, flagged or not. */
  records: HcRecord[];
  /**
   * The same records WITHOUT the flagged values, in input order -- what a
   * minimum, a maximum or a trend should be worked out from. A record flagged
   * as a whole is absent; a series record that lost some samples appears as a
   * copy without them, and one that lost all of them is absent.
   */
  kept: HcRecord[];
  flags: ArtefactFlag[];
}

/**
 * The records no flag names: "the values excluding flagged", for a caller that
 * holds the full list and the flags and wants its extremes from the rest. For
 * a rule that flags whole records this is the rule's own `kept`.
 */
export function excludingFlagged(
  records: readonly HcRecord[],
  flags: readonly ArtefactFlag[],
): HcRecord[] {
  const flagged = new Set(flags.map((flag) => flag.recordId));
  return records.filter((record) => !flagged.has(record.id));
}

// --------------------------------------------------------------------------
// Blood pressure
// --------------------------------------------------------------------------

export interface DuplicateDrop {
  /** The copy that was dropped. */
  record: HcRecord;
  /** The id of the copy kept in its place. */
  duplicateOf: string;
  reason: "same_second_same_reading";
}

/**
 * Blood-pressure readings that are one measurement seen twice.
 *
 * Two readings are the same measurement when their times agree to the NEAREST
 * second and their systolic and diastolic values agree to 0.1 mmHg. Rounded,
 * not truncated, on both counts: a relay that drops or rounds the milliseconds
 * can land either side of a truncation boundary, and one that passes the
 * pressure through a float can hand back 119.99999 for 120. No coarser than a
 * second, because two genuine readings in one sitting are a minute or so apart
 * and often identical.
 *
 * Of the copies, the one with the earliest `lastModified` is kept -- the app
 * that wrote first is the one that measured, and its metadata (device, body
 * position) is the original. A tie goes to the lower origin name, then the
 * lower id, only so that every caller keeps the same copy.
 *
 * A record without both numbers cannot be matched and is always kept. `kept`
 * is in input order.
 */
export function dedupeBloodPressure(records: readonly HcRecord[]): {
  kept: HcRecord[];
  duplicates: DuplicateDrop[];
} {
  const winners = new Map<string, HcRecord>();
  const keyOf = (record: HcRecord): string | null => {
    const systolic = finite(record.data.systolic);
    const diastolic = finite(record.data.diastolic);
    if (systolic === null || diastolic === null) return null;
    const second = Math.round(recordStartMs(record) / SECOND_MS);
    const tenths = (value: number): string => String(Math.round(value * BP_VALUE_STEPS_PER_MMHG));
    return `${String(second)}|${tenths(systolic)}|${tenths(diastolic)}`;
  };
  for (const record of records) {
    const key = keyOf(record);
    if (key === null) continue;
    const current = winners.get(key);
    if (current === undefined || byWriteOrder(record, current) < 0) winners.set(key, record);
  }
  const kept: HcRecord[] = [];
  const duplicates: DuplicateDrop[] = [];
  for (const record of records) {
    const key = keyOf(record);
    const winner = key === null ? undefined : winners.get(key);
    if (winner === undefined || winner === record) kept.push(record);
    else duplicates.push({ record, duplicateOf: winner.id, reason: "same_second_same_reading" });
  }
  return { kept, duplicates };
}

/**
 * Blood-pressure values are compared in steps of a tenth of a mmHg: finer than
 * any cuff reports, coarse enough to absorb a float round trip.
 */
const BP_VALUE_STEPS_PER_MMHG = 10;

/**
 * The default gap that still joins two readings into one sitting, minutes.
 * Home-measurement guidance is two or three readings a minute or two apart;
 * ten minutes allows for a re-fitted cuff and a rest between them, and is far
 * shorter than the gap between a morning and an evening sitting.
 */
export const BP_SESSION_WINDOW_MIN = 10;

export interface BloodPressureSession {
  /** Time of the first and of the last reading, epoch ms. */
  startMs: number;
  endMs: number;
  /** The sitting's readings, in time order. */
  readings: HcRecord[];
  /** Mean of the readings that carry the value; null when none does. */
  systolic: number | null;
  diastolic: number | null;
}

/**
 * Readings grouped into sittings: a reading joins the sitting before it when
 * it was taken within `windowMin` minutes of that sitting's LAST reading, so a
 * run of readings each a few minutes after the one before is one sitting
 * however long it grows. Sittings and their readings are in time order.
 *
 * Deduplicate first (`dedupeBloodPressure`): a relayed copy would otherwise
 * count twice in the means.
 */
export function groupBloodPressureSessions(
  records: readonly HcRecord[],
  windowMin: number = BP_SESSION_WINDOW_MIN,
): BloodPressureSession[] {
  const ordered = sortedBy(
    records,
    (left, right) => recordStartMs(left) - recordStartMs(right) || byWriteOrder(left, right),
  );
  const groups: { startMs: number; endMs: number; readings: HcRecord[] }[] = [];
  for (const record of ordered) {
    const at = recordStartMs(record);
    const current = groups.at(-1);
    if (current !== undefined && at - current.endMs <= windowMin * MINUTE_MS) {
      current.readings.push(record);
      current.endMs = at;
    } else {
      groups.push({ startMs: at, endMs: at, readings: [record] });
    }
  }
  const meanOf = (readings: readonly HcRecord[], field: string): number | null => {
    const values: number[] = [];
    for (const record of readings) {
      const value = finite(record.data[field]);
      if (value !== null) values.push(value);
    }
    return mean(values);
  };
  return groups.map((group) => ({
    ...group,
    systolic: meanOf(group.readings, "systolic"),
    diastolic: meanOf(group.readings, "diastolic"),
  }));
}

// --------------------------------------------------------------------------
// Series artefacts: heart rate and speed
// --------------------------------------------------------------------------

/**
 * A heart-rate sample above this is flagged, bpm. 200 is at or beyond the
 * maximum of nearly every adult (the usual estimate, 220 minus age, reaches it
 * only at twenty), while a wrist sensor that has locked onto arm swing or
 * footfalls reads cadence-like values up here.
 */
export const HR_MAX_PLAUSIBLE_BPM = 200;

/**
 * A heart-rate sample below this is flagged, bpm. Twenty is under any pulse a
 * conscious person has (profound bradycardia is in the thirties), so a reading
 * down here -- and zero or a negative number above all -- is a sensor that
 * lost the skin, not a heart.
 */
export const HR_MIN_PLAUSIBLE_BPM = 20;

/**
 * A speed sample above this is flagged, m/s. 15 m/s is 54 km/h: beyond any
 * running pace (a world-class sprint peaks near 12) and above sustained
 * cycling on the flat, so in a walk or run it is a position jump. A fast road
 * descent can truly exceed it, which is one reason this is a flag raised when
 * a question is answered and not a deletion.
 */
export const SPEED_MAX_PLAUSIBLE_MPS = 15;

interface PlausibleRange {
  /** Values below this are flagged; -Infinity for no lower bound. */
  low: number;
  /** Values above this are flagged. */
  high: number;
}

/** The sample's value and time when `sample[key]` is a number outside `range`; else null. */
function outOfRange(
  sample: unknown,
  key: string,
  range: PlausibleRange,
): { value: number; t: number | null } | null {
  if (!isObject(sample)) return null;
  const value = finite(sample[key]);
  const plausible = value === null || (value >= range.low && value <= range.high);
  return plausible ? null : { value, t: finite(sample.t) };
}

function flagSeries(
  records: readonly HcRecord[],
  key: string,
  range: PlausibleRange,
  reason: ArtefactReason,
): ArtefactResult {
  const kept: HcRecord[] = [];
  const flags: ArtefactFlag[] = [];
  for (const record of records) {
    const { samples } = record.data;
    if (!Array.isArray(samples)) {
      kept.push(record);
      continue;
    }
    const good: unknown[] = [];
    for (const sample of samples as unknown[]) {
      const out = outOfRange(sample, key, range);
      if (out === null) good.push(sample);
      else {
        flags.push({
          recordId: record.id,
          origin: record.origin,
          reason,
          t: out.t ?? recordStartMs(record),
          value: out.value,
        });
      }
    }
    // A copy, never the stored record with samples removed: inputs are not modified.
    if (good.length === samples.length) kept.push(record);
    else if (good.length > 0) kept.push({ ...record, data: { ...record.data, samples: good } });
  }
  return { records: [...records], kept, flags };
}

/**
 * HeartRate records with every sample above {@link HR_MAX_PLAUSIBLE_BPM} or
 * below {@link HR_MIN_PLAUSIBLE_BPM} (zero and negative readings included)
 * flagged, one flag per sample. `kept` holds copies without those samples;
 * `records` is the input as it was.
 */
export function flagHeartRateArtefacts(records: readonly HcRecord[]): ArtefactResult {
  return flagSeries(
    records,
    "bpm",
    { low: HR_MIN_PLAUSIBLE_BPM, high: HR_MAX_PLAUSIBLE_BPM },
    "heart_rate_implausible",
  );
}

/**
 * Speed records with every sample above {@link SPEED_MAX_PLAUSIBLE_MPS}
 * flagged, one flag per sample. `kept` holds copies without those samples.
 */
export function flagSpeedArtefacts(records: readonly HcRecord[]): ArtefactResult {
  return flagSeries(
    records,
    "speed",
    { low: -Infinity, high: SPEED_MAX_PLAUSIBLE_MPS },
    "speed_implausible",
  );
}

// --------------------------------------------------------------------------
// Weight written by a profile set-up screen
// --------------------------------------------------------------------------

/**
 * How close in time a Weight record must be to a Height record from the same
 * origin to be taken for a profile entry, ms. One minute: a set-up screen
 * saves its fields together, seconds apart at most, whereas a scale does not
 * write a height at all.
 *
 * Measured between the records' own times, not their `lastModified`: editing
 * a record moves `lastModified` and says nothing about when it was first
 * written.
 */
export const PROFILE_ARTEFACT_WINDOW_MS = MINUTE_MS;

/**
 * Weight records that look typed into a profile rather than weighed: timed
 * within {@link PROFILE_ARTEFACT_WINDOW_MS} of a HEIGHT record by the same
 * origin. Every weight inside that cluster is flagged, not only the nearest.
 *
 * Height is the only tell. A BasalMetabolicRate beside a weight is NOT one:
 * some apps work a BMR out and write it with every genuine weigh-in, so it
 * accompanies real measurements as readily as typed ones.
 *
 * Nothing is dropped: `records` is every weight given, `flags` says which look
 * typed, and `kept` is the weights without them, for a minimum, maximum or
 * trend.
 *
 * `context.height` holds the Height records around the weights' time range (at
 * least the window either side of it). `context.basalMetabolicRate` is
 * accepted for callers that pass it and is not read.
 */
export function flagWeightArtefacts(
  weights: readonly HcRecord[],
  context: { height: readonly HcRecord[]; basalMetabolicRate?: readonly HcRecord[] },
): ArtefactResult {
  const heightTimes = new Map<string, number[]>();
  for (const record of context.height) {
    const times = heightTimes.get(record.origin);
    if (times === undefined) heightTimes.set(record.origin, [recordStartMs(record)]);
    else times.push(recordStartMs(record));
  }
  const kept: HcRecord[] = [];
  const flags: ArtefactFlag[] = [];
  for (const record of weights) {
    const at = recordStartMs(record);
    const near = (heightTimes.get(record.origin) ?? []).some(
      (time) => Math.abs(time - at) <= PROFILE_ARTEFACT_WINDOW_MS,
    );
    if (!near) {
      kept.push(record);
      continue;
    }
    flags.push({
      recordId: record.id,
      origin: record.origin,
      reason: "weight_profile_setup",
      t: at,
      value: finite(record.data.weight),
    });
  }
  return { records: [...weights], kept, flags };
}

// --------------------------------------------------------------------------
// Sessions: overlap, exact duplicates, zero length, left running
// --------------------------------------------------------------------------

/** What the session rules need to know about a session. */
export interface SessionSpan {
  startMs: number;
  endMs: number;
}

/**
 * A session shorter than this is "zero length", ms. One second: session times
 * are compared to the second everywhere else here, and a start and stop inside
 * the same second is a mis-tap, not a workout.
 */
export const ZERO_LENGTH_SESSION_MAX_MS = SECOND_MS;

export function isZeroLengthSession(session: SessionSpan): boolean {
  return session.endMs - session.startMs < ZERO_LENGTH_SESSION_MAX_MS;
}

/**
 * True when two sessions share any stretch of time. Strict: one that ends at
 * the instant the other starts does not overlap it.
 */
export function sessionsOverlap(a: SessionSpan, b: SessionSpan): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/**
 * True when two sessions have the same start and the same end, each to the
 * second -- the same session written twice, typically once by the app that
 * recorded it and once by one that synced it.
 */
export function isExactDuplicateSession(a: SessionSpan, b: SessionSpan): boolean {
  return (
    Math.floor(a.startMs / SECOND_MS) === Math.floor(b.startMs / SECOND_MS) &&
    Math.floor(a.endMs / SECOND_MS) === Math.floor(b.endMs / SECOND_MS)
  );
}

/**
 * Only a session longer than this can be "left running", ms. Three hours:
 * most real workouts are shorter, so below it a quiet ending is far more
 * likely to be a cool-down than a forgotten stop button.
 */
export const LEFT_RUNNING_MIN_DURATION_MS = 3 * HOUR_MS;

/**
 * The stretch at the end of a long session that is examined, ms. Thirty
 * minutes: longer than a cool-down or a pause at a junction, short enough that
 * a session forgotten for an hour is caught.
 */
export const LEFT_RUNNING_TAIL_MS = 30 * MINUTE_MS;

/**
 * The tail's mean heart rate must be at or below this to count as "low", bpm.
 * 100 is the conventional upper bound of a resting heart rate; sustained
 * exercise sits above it, and the slow activities that do not (a stroll) are
 * told apart by their steps instead.
 */
export const LEFT_RUNNING_TAIL_MAX_BPM = 100;

/**
 * The tail may hold at most this many steps and still count as "no steps".
 * Thirty in thirty minutes -- one a minute -- is what a wrist counts from
 * someone moving about a room; any walk is hundreds.
 */
export const LEFT_RUNNING_TAIL_MAX_STEPS = 30;

/**
 * How much of a summed quantity (`data[field]` of interval records: steps,
 * distance, energy) falls in `[fromMs, toMs]`.
 *
 * A record that only partly overlaps the window counts in proportion to the
 * overlap, on the assumption that it accrued evenly -- a ten-minute record of
 * 600 steps that straddles the window's start by half contributes 300. An
 * instantaneous record counts whole when it falls inside. Null when no record
 * carrying the value has any share in the window, which is not the same as a
 * measured zero.
 *
 * The one helper for this: the exercise summary and the left-running rule
 * both use it, so they cannot disagree about a straddling record. The records
 * must be ONE origin's -- two apps counting the same steps would be added.
 */
export function quantityWithin(
  records: readonly HcRecord[],
  field: string,
  fromMs: number,
  toMs: number,
): number | null {
  let total: number | null = null;
  for (const record of records) {
    const value = finite(record.data[field]);
    if (value === null) continue;
    const start = recordStartMs(record);
    const end = recordEndMs(record);
    if (end === start) {
      if (start >= fromMs && start <= toMs) total = (total ?? 0) + value;
      continue;
    }
    const overlap = Math.min(end, toMs) - Math.max(start, fromMs);
    if (overlap > 0) total = (total ?? 0) + (value * overlap) / (end - start);
  }
  return total;
}

/**
 * True for an exercise session that looks forgotten rather than long: over
 * {@link LEFT_RUNNING_MIN_DURATION_MS}, AND a quiet last
 * {@link LEFT_RUNNING_TAIL_MS}.
 *
 * "Quiet" is judged on whichever of the two signals the session has:
 *
 *  - heart rate, when there is any sample inside the session: the tail's mean
 *    (of per-minute means) is at or below {@link LEFT_RUNNING_TAIL_MAX_BPM}.
 *    A tail with NO samples, in a session that has them earlier, is quiet too:
 *    the wearable came off while the session ran on.
 *  - steps, when any Steps record overlaps the session: the tail holds at most
 *    {@link LEFT_RUNNING_TAIL_MAX_STEPS}. A Steps record that only partly
 *    overlaps the tail counts in proportion to the overlap.
 *
 * Both must be quiet when both exist. When the session has neither signal at
 * all there is nothing to check the tail with, and the answer falls back to
 * duration alone: over three hours is flagged. That is deliberately the
 * noisier choice -- the flag is a hint shown beside the session, never a
 * reason to hide it.
 *
 * `hr` and `steps` may hold data from outside the session; only what falls
 * inside it is used.
 */
export function isLikelyLeftRunning(
  session: SessionSpan,
  hr: readonly HrSample[],
  steps: readonly HcRecord[],
): boolean {
  const { startMs, endMs } = session;
  if (endMs - startMs <= LEFT_RUNNING_MIN_DURATION_MS) return false;
  const tailStart = endMs - LEFT_RUNNING_TAIL_MS;

  const sessionHr = hr.filter((sample) => sample.t >= startMs && sample.t <= endMs);
  const sessionSteps = steps.filter(
    (record) => recordStartMs(record) < endMs && recordEndMs(record) > startMs,
  );
  // No heart rate and no steps: duration alone decides. See the comment above.
  if (sessionHr.length === 0 && sessionSteps.length === 0) return true;

  if (sessionHr.length > 0) {
    const tail = minuteSeries(sessionHr.filter((sample) => sample.t >= tailStart));
    const tailMean = mean(tail.map((minute) => minute.mean));
    if (tailMean !== null && tailMean > LEFT_RUNNING_TAIL_MAX_BPM) return false;
  }
  return (
    sessionSteps.length === 0 ||
    (quantityWithin(sessionSteps, "count", tailStart, endMs) ?? 0) <= LEFT_RUNNING_TAIL_MAX_STEPS
  );
}

export interface MergedSession {
  /** Earliest start and latest end of the group, epoch ms. */
  startMs: number;
  endMs: number;
  /** Every session of the group, by start time. One for a session that overlaps nothing. */
  sessions: HcRecord[];
  /**
   * The session that speaks for the group: the longest; among equals the one
   * written first, then the lower origin name, then the lower id.
   */
  primary: HcRecord;
  /** How many of the group's sessions repeat another's start and end to the second. */
  exactDuplicates: number;
}

function secondsKey(record: HcRecord): string {
  return `${String(Math.floor(recordStartMs(record) / SECOND_MS))}|${String(
    Math.floor(recordEndMs(record) / SECOND_MS),
  )}`;
}

/** Disjoint sets over indices 0..size-1: which sessions have been linked. */
function linker(size: number): {
  find: (index: number) => number;
  link: (a: number, b: number) => void;
} {
  const parent = Array.from({ length: size }, (_unused, index) => index);
  const find = (index: number): number => {
    let root = index;
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
    parent[index] = root;
    return root;
  };
  return {
    find,
    link: (a, b) => {
      // The lower index becomes the root, so a group is named by its earliest session.
      const [rootA, rootB] = [find(a), find(b)];
      parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
    },
  };
}

/**
 * A session longer than three hours, whatever its tail looks like. The plain
 * companion of {@link isLikelyLeftRunning}: that one needs a quiet ending and
 * the heart rate and steps to judge it by, this one only the clock, so it can
 * be counted without either.
 */
export function isOverThreeHours(session: SessionSpan): boolean {
  return session.endMs - session.startMs > LEFT_RUNNING_MIN_DURATION_MS;
}

/**
 * An exercise session longer than this is never merged with one it overlaps,
 * ms. Twelve hours: longer than any single workout that two apps would both
 * record (an ultra-distance day is the edge), and far shorter than a session
 * somebody forgot to stop, which would otherwise swallow every real workout
 * that happened while it ran.
 */
export const EXERCISE_MERGE_MAX_MS = 12 * HOUR_MS;

/**
 * The same bound for sleep, ms. Eighteen hours: longer than any night in bed,
 * a long lie-in included, so a sleep session past it is one that was never
 * closed and must not absorb the next night or a nap.
 */
export const SLEEP_MERGE_MAX_MS = 18 * HOUR_MS;

// --------------------------------------------------------------------------
// Left running, judged against the session's own active phase
// --------------------------------------------------------------------------

/**
 * {@link isLikelyLeftRunning} asks whether a long session ENDS AT REST: a tail
 * at or below a resting heart rate with next to no steps. That misses the
 * commonest way a session is forgotten -- the workout ends, the person stays
 * on their feet, and the tracker runs on through an evening of being up and
 * about. The pulse is then above resting and there are a few steps, so the
 * tail is not "at rest"; it is simply nothing like the workout.
 *
 * The rule here compares the tail with the session ITSELF instead of with a
 * fixed resting level. For a session over three hours (and no longer than the
 * twelve past which a session stands alone anyway):
 *
 *  1. The TAIL is its last {@link LEFT_RUNNING_TAIL_MS}, the stretch the
 *     resting rule examines too.
 *  2. The ACTIVE PHASE is the half hour before the tail with the highest mean
 *     heart rate (of per-minute means): the workout at its busiest.
 *  3. The session is flagged when ALL of these hold:
 *      - the tail's mean heart rate is at least
 *        {@link LEFT_RUNNING_ACTIVE_DROP_BPM} below the active phase's;
 *      - the tail's cadence is at most {@link LEFT_RUNNING_TAIL_MAX_CADENCE}
 *        steps a minute;
 *      - the active phase's cadence was at least
 *        {@link LEFT_RUNNING_ACTIVE_MIN_CADENCE} steps a minute.
 *
 * The last condition is what keeps it conservative. A ride, a swim or a
 * session on a machine makes no steps at any point, so "no steps at the end"
 * says nothing about it and the rule does not fire: only an activity that
 * was making steps and stopped making them is judged. A steady hike keeps
 * both its pulse and its cadence to the end and is never flagged; neither is
 * a session missing either signal, or with fewer than
 * {@link LEFT_RUNNING_MIN_MINUTES} minutes of heart rate in the tail or in
 * every half hour before it.
 *
 * It is a flag beside the session and never changes a stored value: the
 * session keeps its times, its duration and every figure. Both rules are
 * applied when the session's summary is built ({@link leftRunningReason}), so
 * the flag and the rule that raised it are stored with the summary and every
 * tool reads the same ones.
 */

/** The tail's mean heart rate must be this far below the active phase's, bpm. */
export const LEFT_RUNNING_ACTIVE_DROP_BPM = 20;

/**
 * The tail may hold at most this many steps a minute. Twenty is pottering
 * about a house; any walk, however slow, is several times that.
 */
export const LEFT_RUNNING_TAIL_MAX_CADENCE = 20;

/**
 * The active phase must have held at least this many steps a minute for the
 * tail's lack of them to mean anything: twice the tail's limit, so the fall
 * is a real one and an activity that never made steps is left alone.
 */
export const LEFT_RUNNING_ACTIVE_MIN_CADENCE = 40;

/** Minutes of heart rate a half hour needs before its mean is used. */
const LEFT_RUNNING_MIN_MINUTES = 10;

/** Why a session is flagged as left running. */
export type LeftRunningReason = "resting_tail" | "tail_below_active_phase";

interface MinuteMean {
  /** Start of the minute, epoch ms. */
  t: number;
  mean: number;
}

/** The mean of the minute means in `[fromMs, toMs)`, or null with too few minutes to say. */
function windowMean(minutes: readonly MinuteMean[], fromMs: number, toMs: number): number | null {
  const inside = minutes.filter((minute) => minute.t >= fromMs && minute.t < toMs);
  return inside.length < LEFT_RUNNING_MIN_MINUTES
    ? null
    : mean(inside.map((minute) => minute.mean));
}

/** Steps a minute over `[fromMs, toMs]`, from one origin's Steps records. */
function cadence(steps: readonly HcRecord[], fromMs: number, toMs: number): number {
  return (quantityWithin(steps, "count", fromMs, toMs) ?? 0) / ((toMs - fromMs) / MINUTE_MS);
}

/**
 * True when a long session's tail is far below its own active phase in both
 * heart rate and cadence. See the comment above for the rule.
 *
 * `minutes` are per-minute heart-rate means and `steps` ONE origin's Steps
 * records; both may run wider than the session, and only what falls inside it
 * is used.
 */
export function tailBelowActivePhase(
  session: SessionSpan,
  minutes: readonly MinuteMean[],
  steps: readonly HcRecord[],
): boolean {
  const { startMs, endMs } = session;
  if (!isOverThreeHours(session) || endMs - startMs > EXERCISE_MERGE_MAX_MS) return false;
  const tailStart = endMs - LEFT_RUNNING_TAIL_MS;
  const tailBpm = windowMean(minutes, tailStart, endMs + 1);
  if (tailBpm === null) return false;

  // The busiest half hour before the tail, by heart rate.
  let active: { fromMs: number; bpm: number } | null = null;
  for (const minute of minutes) {
    const fromMs = minute.t;
    if (fromMs < startMs || fromMs + LEFT_RUNNING_TAIL_MS > tailStart) continue;
    const bpm = windowMean(minutes, fromMs, fromMs + LEFT_RUNNING_TAIL_MS);
    if (bpm !== null && (active === null || bpm > active.bpm)) active = { fromMs, bpm };
  }
  if (active === null || tailBpm > active.bpm - LEFT_RUNNING_ACTIVE_DROP_BPM) return false;

  const inSession = steps.filter(
    (record) => recordStartMs(record) < endMs && recordEndMs(record) > startMs,
  );
  if (inSession.length === 0) return false;
  const activeCadence = cadence(inSession, active.fromMs, active.fromMs + LEFT_RUNNING_TAIL_MS);
  return (
    activeCadence >= LEFT_RUNNING_ACTIVE_MIN_CADENCE &&
    cadence(inSession, tailStart, endMs) <= LEFT_RUNNING_TAIL_MAX_CADENCE
  );
}

/**
 * Which rule, if either, says an exercise session was left running: the
 * resting tail first ({@link isLikelyLeftRunning}), then the tail far below
 * the session's own active phase ({@link tailBelowActivePhase}). Null when
 * neither does.
 *
 * `hr` is heart rate around the session -- samples, or one point a minute --
 * and `steps` ONE origin's Steps records.
 */
export function leftRunningReason(
  session: SessionSpan,
  hr: readonly HrSample[],
  steps: readonly HcRecord[],
): LeftRunningReason | null {
  if (isLikelyLeftRunning(session, hr, steps)) return "resting_tail";
  // The minute the session ends in is part of it.
  const inside = hr.filter((sample) => sample.t >= session.startMs && sample.t <= session.endMs);
  return tailBelowActivePhase(session, minuteSeries(inside), steps)
    ? "tail_below_active_phase"
    : null;
}

/** What decides which overlapping sessions may be merged. All optional. */
export interface SessionMergeOptions {
  /**
   * The kind of a session (an exercise type). Two overlapping sessions of
   * different kinds are two activities and are not merged. Omitted: every
   * session is of one kind.
   */
  kindOf?: (record: HcRecord) => string;
  /**
   * True for a session that must not be merged through an overlap, whatever
   * its length: one flagged as left running.
   */
  standsAlone?: (record: HcRecord) => boolean;
  /** A session longer than this stands alone too, ms. Omitted: no bound. */
  maxMs?: number;
}

/**
 * Sessions (sleep or exercise records of one type) grouped so that each group
 * is one stretch of activity: two sessions are in the same group when they
 * overlap, when they are exact duplicates, or when a chain of such pairs links
 * them. Nothing is dropped -- every input session is in exactly one group --
 * and groups are in time order.
 *
 * An overlap only merges two sessions that could be the same activity
 * ({@link SessionMergeOptions}): of the same kind, neither left running, and
 * neither longer than the bound. Without that, one session nobody stopped
 * overlaps every real workout of the following day and they all come back as
 * one row described by the forgotten one. A session that stands alone is its
 * own group, and what it overlaps is left to be grouped without it.
 *
 * Exact duplicates are linked wherever they sit and whatever they are, not
 * only when adjacent: the same start and end to the second is the same
 * session written twice, however long it is. Two zero-length copies overlap
 * nothing, and a third session that starts between them must not keep them
 * apart.
 *
 * The span of a group is the union of its sessions, so summing group lengths
 * of one kind never counts an hour twice the way summing the raw sessions
 * would. (A session that stands alone can share hours with another group:
 * that is the point of keeping it apart, and its row says it is suspect.)
 */
export function mergeOverlappingSessions(
  sessions: readonly HcRecord[],
  options: SessionMergeOptions = {},
): MergedSession[] {
  const ordered = sortedBy(
    sessions,
    (left, right) =>
      recordStartMs(left) - recordStartMs(right) ||
      recordEndMs(left) - recordEndMs(right) ||
      byWriteOrder(left, right),
  );
  const sets = linker(ordered.length);
  const maxMs = options.maxMs ?? Infinity;

  // Overlaps: sorted by start, so overlapping the running union is overlapping
  // one of its members. One running union per kind.
  const runs = new Map<string, { first: number; startMs: number; endMs: number }>();
  const firstWithKey = new Map<string, number>();
  const overlap = (kind: string, index: number, span: SessionSpan): void => {
    const run = runs.get(kind);
    if (run !== undefined && sessionsOverlap(run, span)) {
      sets.link(run.first, index);
      run.endMs = Math.max(run.endMs, span.endMs);
    } else {
      runs.set(kind, { first: index, ...span });
    }
  };
  for (const [index, record] of ordered.entries()) {
    const span = { startMs: recordStartMs(record), endMs: recordEndMs(record) };
    const alone = span.endMs - span.startMs > maxMs || options.standsAlone?.(record) === true;
    if (!alone) overlap(options.kindOf?.(record) ?? "", index, span);
    // Exact duplicates, however far apart in the order.
    const key = secondsKey(record);
    const twin = firstWithKey.get(key);
    if (twin === undefined) firstWithKey.set(key, index);
    else sets.link(twin, index);
  }

  // Roots are earliest members and the Map is filled in start order, so the
  // groups come out in time order with their members in time order.
  const byRoot = new Map<number, HcRecord[]>();
  for (const [index, record] of ordered.entries()) {
    const root = sets.find(index);
    const members = byRoot.get(root);
    if (members === undefined) byRoot.set(root, [record]);
    else members.push(record);
  }
  const groups: MergedSession[] = [];
  for (const members of byRoot.values()) {
    const [head] = members;
    if (head !== undefined) groups.push(summariseGroup(head, members));
  }
  return groups;
}

function summariseGroup(head: HcRecord, members: HcRecord[]): MergedSession {
  const length = (record: HcRecord): number => recordEndMs(record) - recordStartMs(record);
  let startMs = Infinity;
  let endMs = -Infinity;
  let primary = head;
  const seen = new Set<string>();
  let exactDuplicates = 0;
  for (const record of members) {
    startMs = Math.min(startMs, recordStartMs(record));
    endMs = Math.max(endMs, recordEndMs(record));
    // The longest speaks for the group; among equals, the one written first.
    if ((length(primary) - length(record) || byWriteOrder(record, primary)) < 0) primary = record;
    const key = secondsKey(record);
    if (seen.has(key)) exactDuplicates += 1;
    else seen.add(key);
  }
  return { startMs, endMs, sessions: members, primary, exactDuplicates };
}

// --------------------------------------------------------------------------
// Floors
// --------------------------------------------------------------------------

/**
 * Floors-climbed counts are noisy as a class, whatever the individual value:
 * they come from a barometric altimeter, which reads a weather front, a lift,
 * a car on a hill or a closing door as climbing. Every answer built on them
 * carries this, so the number is read as an estimate.
 */
export const FLOORS_ARE_NOISY = true;

/**
 * A record claiming more floors per minute than this is flagged on its own
 * account. Ten a minute is a floor every six seconds, held for the whole
 * record: quicker than a fit person takes stairs, so it is pressure, not legs.
 */
export const FLOORS_MAX_PER_MINUTE = 10;

/**
 * FloorsClimbed records, with those that are individually implausible flagged
 * (and left out of `kept`, though never out of `records`): a negative count, or a rate above
 * {@link FLOORS_MAX_PER_MINUTE} (a record shorter than a minute is rated as a
 * minute, so a brief burst of a few floors is not flagged).
 *
 * `noisy` is always {@link FLOORS_ARE_NOISY}: the records that are kept are
 * still estimates, and the caller should say so.
 */
export function flagFloors(records: readonly HcRecord[]): ArtefactResult & { noisy: boolean } {
  const kept: HcRecord[] = [];
  const flags: ArtefactFlag[] = [];
  for (const record of records) {
    const floors = finite(record.data.floors);
    const minutes = Math.max(1, (recordEndMs(record) - recordStartMs(record)) / MINUTE_MS);
    if (floors === null || (floors >= 0 && floors / minutes <= FLOORS_MAX_PER_MINUTE)) {
      kept.push(record);
      continue;
    }
    flags.push({
      recordId: record.id,
      origin: record.origin,
      reason: "floors_implausible",
      t: recordStartMs(record),
      value: floors,
    });
  }
  return { records: [...records], kept, flags, noisy: FLOORS_ARE_NOISY };
}
