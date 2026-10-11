/**
 * `data_quality`: what in a range should be read with care.
 *
 * Every duplicate and artefact rule is the one in `worker/src/hc/rules.ts` --
 * this module only decides where to point them. To stay cheap over a long
 * range it looks at rollups first and opens raw records only where a rollup
 * says a rule could fire:
 *
 *  - heart rate outside the plausible limits, speed above its limit, an
 *    implausible floor count: found from the hour rollup's `max` (or `min`),
 *    then counted exactly from that hour's records;
 *  - weights written by a profile screen, duplicated blood-pressure readings,
 *    precision changes: types with a handful of records a day, read whole;
 *  - overlapping, duplicated, zero-length and left-running sessions: from the
 *    stored session summaries;
 *  - several apps recording the same cumulative type on one day, days with
 *    nothing between days with something, and the app that supplies a type
 *    changing: from one per-day, per-origin count of each type;
 *  - a date with overnight vitals and no sleep session to account for them:
 *    from the vitals' hour rollups and the stored nights.
 *
 * The last two groups and the precision check are observations, not rules
 * about any one record, so their thresholds live here.
 *
 * `request.types` says which types to REPORT findings for: what the caller
 * asked about, of what the phone holds and the exposure policy allows. It does
 * not decide what a rule may read for context. A profile-setup weight is told
 * by the height beside it and a left-running session by heart rate and steps;
 * asking about `Weight` alone must still find the profile weight. Context is
 * gated by the exposure policy only (`request.allowed`): a denied type is
 * never read, as a finding or as context.
 *
 * ### Long ranges
 *
 * Everything above is read per WINDOW of the range, never for the range at
 * once. One read of a whole history is every sealed day and hour rollup of
 * every type, opened and held together, and that is more than one request can
 * carry: it is what a full-history call died of. Two ways in:
 *
 *  - {@link dataQualityPage} walks the range in windows of
 *    {@link QUALITY_WINDOW_DAYS} local days from wherever its caller's cursor
 *    left off, and stops -- at a window's end, never inside one -- once it has
 *    `maxBytes` of findings or has read {@link QUALITY_MAX_WINDOWS_PER_CALL}
 *    windows. It says where it stopped (`untilMs`, and `done`), which is what
 *    a tool turns into `truncated: true` and a cursor (`HcAnswer.scan` in
 *    `./sources.ts`). Nothing is dropped and no range is refused: a longer
 *    range is more pages.
 *  - {@link dataQuality} is every page in one call. It holds one window of
 *    the store at a time, so it no longer has the whole history in memory,
 *    but it does all the reading at once: it bounds memory, not work.
 *
 * A range no longer than a window is one window either way, and reads as it
 * always has.
 *
 * A window is assessed with what came before it in view, so cutting the range
 * loses nothing at a cut:
 *
 *  - the day-level rules (a gap, a change of source) read
 *    {@link QUALITY_LOOKBACK_DAYS} days before the window as well and report
 *    what falls inside it. A silence longer than that is still found: when a
 *    regularly recorded type has nothing in the lookback, the days before it
 *    are read for that one type to learn when it stopped;
 *  - a precision change is judged against the same app's previous value up to
 *    the lookback before the window;
 *  - a session belongs to the window it ENDS in (the last window also takes
 *    one that runs past the range), and sessions are read
 *    {@link SESSION_MARGIN_MS} either side so an overlapping pair that
 *    straddles a cut is still seen as a pair.
 *
 * Two things do depend on the span looked at, and so can differ between one
 * window over a long range and several: whether a type counts as "recorded
 * most days" is judged over the window and its lookback, not the whole range
 * (a type worn daily this year and never before is regular this year); and a
 * source switch after a silence longer than the lookback is reported only for
 * the types the gap rule covers.
 */

import { dayBoundsMs } from "../../hc/rollup/day.ts";
import { SLEEP_MATCH_TOLERANCE_MS } from "../../hc/rollup/sleep.ts";
import {
  FLOORS_MAX_PER_MINUTE,
  HR_MAX_PLAUSIBLE_BPM,
  HR_MIN_PLAUSIBLE_BPM,
  LEFT_RUNNING_ACTIVE_DROP_BPM,
  LEFT_RUNNING_ACTIVE_MIN_CADENCE,
  LEFT_RUNNING_MIN_DURATION_MS,
  LEFT_RUNNING_TAIL_MAX_CADENCE,
  LEFT_RUNNING_TAIL_MS,
  PROFILE_ARTEFACT_WINDOW_MS,
  SPEED_MAX_PLAUSIBLE_MPS,
  dedupeBloodPressure,
  flagFloors,
  flagHeartRateArtefacts,
  flagSpeedArtefacts,
  flagWeightArtefacts,
  isOverThreeHours,
} from "../../hc/rules.ts";
import { recordStartMs } from "../../hc/wire.ts";

import { aggregate, isCounter } from "./aggregate.ts";
import { groupSessions, leftRunningReasons } from "./sessions.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./time.ts";
import { distinctText, fileUnder, finite, listOf, mapUnder, sortedBy } from "./util.ts";

import type { AggregateRow } from "./aggregate.ts";
import type { HcReads } from "./reads.ts";
import type { Group, LeftRunningReason, Spanned } from "./sessions.ts";
import type { Range, ZoneClock } from "./time.ts";
import type { ArtefactFlag, ArtefactResult } from "../../hc/rules.ts";
import type { HcRecord } from "../../hc/wire.ts";

/**
 * A type is "recorded daily" -- so that a day without it is a gap worth
 * reporting -- when it has records on at least this share of the days between
 * its first and last day in the span looked at. Half: a watch worn most days
 * qualifies, a scale stepped on now and then does not.
 */
const GAP_MIN_DAY_COVERAGE = 0.5;

/** And it needs at least this many days with records before a gap means anything. */
const GAP_MIN_DAYS_WITH_DATA = 3;

/**
 * The types a gap is reported for: those a device records by itself, day in
 * day out, so that a day with none means the device was off or its data did
 * not arrive. The sensor counters (`isCounter`: steps, distance, energy,
 * floors ...), the vitals a wearable samples unasked, and sleep -- a night is
 * expected every night.
 *
 * Everything else is EVENT data, written when a person does something: a
 * workout, a blood-pressure reading, a weighing, a meal, a meditation. Nobody
 * exercises on a schedule a tool can know, so a week without a workout is a
 * week without a workout and not a hole in the data; reporting it as one is
 * noise. Event types still get every other rule.
 */
const PASSIVE_VITALS: ReadonlySet<string> = new Set([
  "HeartRate",
  "RestingHeartRate",
  "HeartRateVariabilityRmssd",
  "RespiratoryRate",
  "OxygenSaturation",
  "SkinTemperature",
  "SleepSession",
]);

/** True for a type the gap rule applies to. See {@link PASSIVE_VITALS}. */
export function isGapType(type: string): boolean {
  return isCounter(type) || PASSIVE_VITALS.has(type);
}

/**
 * The app supplying a type has "switched" only when the app that supplied it
 * before is absent, or nearly: at most this share of the day's total on the
 * day another app takes over. A tenth: two apps recording side by side trade
 * the lead from day to day without either going away, and that is not a
 * change of source; a watch left in a drawer contributes nothing at all.
 */
const SOURCE_SWITCH_MAX_PREVIOUS_SHARE = 0.1;

/**
 * A value printed with this many decimals or fewer is "rounded": what a
 * person types or a display shows.
 */
const PRECISION_ROUNDED_MAX_DECIMALS = 2;

/**
 * A value printed with this many decimals or more is "unrounded": what a unit
 * conversion leaves behind (a weight entered in pounds, stored in kilograms).
 * A value between the two says nothing either way -- a rounded value that
 * happens to end in a zero prints shorter, and must not read as a change.
 */
const PRECISION_UNROUNDED_MIN_DECIMALS = 4;

/**
 * What a wearable writes for a night. A date with readings of at least
 * {@link SESSION_MISSING_MIN_VITALS} of these that no stored sleep session
 * accounts for is a night the wearable measured whose session did not arrive.
 */
const OVERNIGHT_VITALS: readonly string[] = [
  "HeartRateVariabilityRmssd",
  "RespiratoryRate",
  "RestingHeartRate",
  "SkinTemperature",
];

/**
 * Two, not one: a resting heart rate alone is a daily figure some apps write
 * whether or not the wearer slept in the device, and a single HRV reading can
 * be a daytime spot check. Two different overnight types on one date are a
 * night.
 */
const SESSION_MISSING_MIN_VITALS = 2;

const TYPE_SLEEP = "SleepSession";
const TYPE_EXERCISE = "ExerciseSession";

/** How many local days {@link dataQualityPage} assesses at a time. Half a year. */
export const QUALITY_WINDOW_DAYS = 183;

/** How many days before a window its day-level and precision rules also see. */
export const QUALITY_LOOKBACK_DAYS = 183;

/**
 * How many windows one call of {@link dataQualityPage} reads before it stops
 * and hands back a cursor, however little it has found. Two: a year of the
 * store a call, which is a few hundred reads -- a request has a ceiling on
 * how many it may make, and a quiet history must not be a way to reach it.
 */
export const QUALITY_MAX_WINDOWS_PER_CALL = 2;

/**
 * How far either side of a window sessions are read, so that both of an
 * overlapping pair are seen when a cut falls between their ends. Two days:
 * longer than the longest session that is ever merged with another.
 */
const SESSION_MARGIN_MS = 2 * DAY_MS;

/** Types with few records a day whose values are read whole, and the field checked. */
const SPARSE_SCALARS: ReadonlyMap<string, string> = new Map([
  ["Weight", "weight"],
  ["Height", "height"],
  ["BodyFat", "percentage"],
  ["BodyTemperature", "temperature"],
  ["BasalBodyTemperature", "temperature"],
  ["BloodGlucose", "level"],
  ["Vo2Max", "vo2"],
  ["LeanBodyMass", "mass"],
  ["BoneMass", "mass"],
  ["BodyWaterMass", "mass"],
  ["BasalMetabolicRate", "bmr"],
]);

/** The thresholds behind the findings, for the answer's envelope. */
export const QUALITY_RULES = {
  heartRateMaxBpm: HR_MAX_PLAUSIBLE_BPM,
  heartRateMinBpm: HR_MIN_PLAUSIBLE_BPM,
  speedMaxMps: SPEED_MAX_PLAUSIBLE_MPS,
  floorsMaxPerMinute: FLOORS_MAX_PER_MINUTE,
  weightProfileWindowMs: PROFILE_ARTEFACT_WINDOW_MS,
  leftRunningMinDurationMs: LEFT_RUNNING_MIN_DURATION_MS,
  leftRunningTailMs: LEFT_RUNNING_TAIL_MS,
  leftRunningActiveDropBpm: LEFT_RUNNING_ACTIVE_DROP_BPM,
  leftRunningTailMaxStepsPerMin: LEFT_RUNNING_TAIL_MAX_CADENCE,
  leftRunningActiveMinStepsPerMin: LEFT_RUNNING_ACTIVE_MIN_CADENCE,
  gapMinDayCoverage: GAP_MIN_DAY_COVERAGE,
  gapMinDaysWithData: GAP_MIN_DAYS_WITH_DATA,
  sessionMissingMinVitalTypes: SESSION_MISSING_MIN_VITALS,
  sourceSwitchMaxPreviousShare: SOURCE_SWITCH_MAX_PREVIOUS_SHARE,
  precisionRoundedMaxDecimals: PRECISION_ROUNDED_MAX_DECIMALS,
  precisionUnroundedMinDecimals: PRECISION_UNROUNDED_MIN_DECIMALS,
  windowDays: QUALITY_WINDOW_DAYS,
  lookbackDays: QUALITY_LOOKBACK_DAYS,
} as const;

/** One thing found. `type` is the record type it is about; the rest describes it. */
export interface Finding {
  type: string;
  kind: string;
  detail: Record<string, unknown>;
}

export interface QualityRequest {
  deviceId: string;
  range: Range;
  clock: ZoneClock;
  nowMs: number;
  /** Whether one type's day rollups can answer the range: see `dayRollupsUsable` in `./sources.ts`. */
  dayRollupsUsable: (type: string, range: Range) => Promise<boolean>;
  /**
   * The record types to report findings for: what was asked about, of what
   * the phone holds and the policy lets this call read.
   */
  types: readonly string[];
  /**
   * Whether the exposure policy lets this call read a record type. What gates
   * a rule's context, whatever `types` narrows the report to.
   */
  allowed: (type: string) => boolean;
}

/** One window's reads: the request, the stretch being assessed, and what surrounds it. */
interface Scan {
  reads: HcReads;
  request: QualityRequest;
  types: ReadonlySet<string>;
  /** The stretch findings are reported for. */
  window: Range;
  /** Where the lookback before the window begins: the window's own start when there is none. */
  spanStartMs: number;
  /** True for the window that ends the range: it takes a session that runs past it. */
  last: boolean;
  /** One type's records that start in `[fromMs - marginMs, window end + marginMs)`. */
  raw: (type: string, options?: { fromMs?: number; marginMs?: number }) => Promise<HcRecord[]>;
  /** Per-day, per-origin shares of one type over a stretch, read once per window. */
  days: (type: string, range: Range) => Promise<Map<string, Map<string, DayShare>>>;
}

/** What one origin recorded of a type on one day. */
interface DayShare {
  records: number;
  /** What the origin's day weighs against another's: see {@link shareWeight}. */
  weight: number;
}

/**
 * What a day's row weighs when origins are compared: the sum of the type's
 * primary field (steps, metres, kcal), a session type's duration, or -- for a
 * type with neither -- its record count. Never the record count when there is
 * a sum: one app writing a record a minute and another a record an hour would
 * otherwise be compared by how chatty they are.
 */
function shareWeight(row: AggregateRow): number {
  const primary = Object.values(row.values)[0]?.sum;
  if (primary !== null && primary !== undefined) return primary;
  const duration = row.durationMs ?? 0;
  return duration > 0 ? duration : (row.records ?? 0);
}

/** Per day: which origins recorded the type, and how much each. */
function dayOrigins(rows: readonly AggregateRow[]): Map<string, Map<string, DayShare>> {
  const out = new Map<string, Map<string, DayShare>>();
  for (const row of rows) {
    const day = mapUnder(out, row.bucket);
    const origin = row.origins[0];
    if (origin !== undefined && row.hasData) {
      day.set(origin, { records: row.records ?? 0, weight: shareWeight(row) });
    }
  }
  return out;
}

function startScan(
  reads: HcReads,
  request: QualityRequest,
  window: Range,
  spanStartMs: number,
): Scan {
  const { deviceId } = request;
  const dayCache = new Map<string, Promise<Map<string, Map<string, DayShare>>>>();
  const loadDays = async (
    type: string,
    range: Range,
  ): Promise<Map<string, Map<string, DayShare>>> => {
    if (range.endMs <= range.startMs) return new Map();
    const answer = await aggregate(reads, {
      deviceId,
      type,
      range,
      bucket: "day",
      mode: { kind: "all_separately" },
      metrics: ["sum", "records", "duration"],
      fill: "zero",
      excludeFuture: true,
      nowMs: request.nowMs,
      clock: request.clock,
      dayRollupsUsable: await request.dayRollupsUsable(type, range),
      bmrKcalPerDay: null,
      // Every record is counted here: an artefact is still a record an app wrote.
      excludeArtefacts: false,
      allowed: request.allowed,
    });
    return dayOrigins(answer.rows);
  };
  return {
    reads,
    request,
    types: new Set(request.types),
    window,
    spanStartMs,
    last: window.endMs >= request.range.endMs,
    raw: async (type, options = {}) => {
      const marginMs = options.marginMs ?? 0;
      const startMs = (options.fromMs ?? window.startMs) - marginMs;
      const endMs = window.endMs + marginMs;
      const records = await reads.records({ deviceId, type, startMs, endMs });
      return records.filter((record) => {
        const at = recordStartMs(record);
        return at >= startMs && at < endMs;
      });
    },
    days: (type, range) => {
      const key = `${type}|${String(range.startMs)}|${String(range.endMs)}`;
      let pending = dayCache.get(key);
      if (pending === undefined) {
        pending = loadDays(type, range);
        dayCache.set(key, pending);
      }
      return pending;
    },
  };
}

/** True for an instant inside the window being assessed. */
function inWindow(scan: Scan, ms: number): boolean {
  return ms >= scan.window.startMs && ms < scan.window.endMs;
}

/**
 * True for a session (or a group of them) that belongs to this window: it
 * ends inside it. The last window also takes one that runs past the end of
 * the range, so a session still open when the range ends is not lost.
 */
function endsHere(scan: Scan, span: { startMs: number; endMs: number }): boolean {
  const touches = span.endMs >= scan.window.startMs && span.startMs < scan.window.endMs;
  return touches && (span.endMs < scan.window.endMs || scan.last);
}

/** Digits after the decimal point, as the number prints. */
function decimals(value: number): number {
  const text = String(value);
  if (text.includes("e")) return 0;
  const point = text.indexOf(".");
  return point === -1 ? 0 : text.length - point - 1;
}

type Precision = "rounded" | "unrounded";

function precisionOf(value: number): Precision | null {
  const digits = decimals(value);
  if (digits <= PRECISION_ROUNDED_MAX_DECIMALS) return "rounded";
  return digits >= PRECISION_UNROUNDED_MIN_DECIMALS ? "unrounded" : null;
}

interface DenseRule {
  type: string;
  /** The rollup field whose extremes say the rule could fire. */
  field: string;
  suspect: (stats: { min: number; max: number }) => boolean;
  rule: (records: readonly HcRecord[]) => ArtefactResult;
}

const DENSE_RULES: readonly DenseRule[] = [
  {
    type: "HeartRate",
    field: "bpm",
    suspect: (stats) => stats.max > HR_MAX_PLAUSIBLE_BPM || stats.min < HR_MIN_PLAUSIBLE_BPM,
    rule: flagHeartRateArtefacts,
  },
  {
    type: "Speed",
    field: "speed",
    suspect: (stats) => stats.max > SPEED_MAX_PLAUSIBLE_MPS,
    rule: flagSpeedArtefacts,
  },
  {
    type: "FloorsClimbed",
    field: "floors",
    // A record can only break the per-minute limit if it holds more than the limit.
    suspect: (stats) => stats.max > FLOORS_MAX_PER_MINUTE || stats.min < 0,
    rule: flagFloors,
  },
];

/**
 * Artefacts of a dense type: hours whose rollup says the rule could fire are
 * read raw and put through it.
 */
async function denseArtefacts(scan: Scan, dense: DenseRule): Promise<ArtefactFlag[]> {
  const { deviceId } = scan.request;
  const range = scan.window;
  const rollups = await scan.reads.hourRollups({
    deviceId,
    type: dense.type,
    // From the hour the window starts in: its flags are filtered to the window below.
    startMs: Math.floor(range.startMs / HOUR_MS) * HOUR_MS,
    endMs: range.endMs,
  });
  const hours = new Set<number>();
  for (const row of rollups) {
    const stats = row.rollup.fields[dense.field];
    if (stats !== undefined && dense.suspect(stats)) hours.add(row.hourUtc);
  }
  const flags: ArtefactFlag[] = [];
  // One read per run of adjacent suspect hours, not one per hour.
  const runs: Range[] = [];
  const ordered = sortedBy(hours, (left, right) => left - right);
  for (const hour of ordered) {
    const last = runs.at(-1);
    if (last?.endMs === hour * HOUR_MS) last.endMs += HOUR_MS;
    else runs.push({ startMs: hour * HOUR_MS, endMs: (hour + 1) * HOUR_MS });
  }
  for (const run of runs) {
    const records = await scan.reads.records({ deviceId, type: dense.type, ...run });
    // A record is examined with the hour it starts in, so none is counted twice.
    const own = records.filter((record) => hours.has(Math.floor(recordStartMs(record) / HOUR_MS)));
    for (const flag of dense.rule(own).flags) {
      if (flag.t >= range.startMs && flag.t < range.endMs) flags.push(flag);
    }
  }
  return flags;
}

/** Artefact flags as one finding per origin per hour: a bad minute can hold dozens of samples. */
function flagsByHour(type: string, flags: readonly ArtefactFlag[], clock: ZoneClock): Finding[] {
  const groups = new Map<string, ArtefactFlag[]>();
  for (const flag of flags) {
    fileUnder(groups, `${flag.origin}|${String(Math.floor(flag.t / HOUR_MS))}`, flag);
  }
  const findings: Finding[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const values = group.flatMap((flag) => (flag.value === null ? [] : [flag.value]));
    findings.push({
      type,
      kind: "artefact",
      detail: {
        reason: first.reason,
        origin: first.origin,
        hour: clock.iso(Math.floor(first.t / HOUR_MS) * HOUR_MS),
        count: group.length,
        maxValue: values.length === 0 ? null : Math.max(...values),
        minValue: values.length === 0 ? null : Math.min(...values),
      },
    });
  }
  return findings;
}

function flagFindings(type: string, flags: readonly ArtefactFlag[], clock: ZoneClock): Finding[] {
  return flags.map((flag) => ({
    type,
    kind: "artefact",
    detail: { reason: flag.reason, origin: flag.origin, at: clock.iso(flag.t), value: flag.value },
  }));
}

async function denseFindings(scan: Scan): Promise<Finding[]> {
  const { clock } = scan.request;
  const findings: Finding[] = [];
  for (const dense of DENSE_RULES) {
    if (!scan.types.has(dense.type)) continue;
    const flags = await denseArtefacts(scan, dense);
    if (dense.type !== "FloorsClimbed") {
      findings.push(...flagsByHour(dense.type, flags, clock));
      continue;
    }
    findings.push(...flagFindings(dense.type, flags, clock));
  }
  return findings;
}

/**
 * The one finding that is about a type and not about any stretch of time:
 * floors are an estimate wherever they come from. Said once per answer, with
 * the first window -- not once per window.
 */
function standingFindings(scan: Scan): Finding[] {
  const first = scan.window.startMs <= scan.request.range.startMs;
  if (!first || !scan.types.has("FloorsClimbed")) return [];
  return [
    {
      type: "FloorsClimbed",
      kind: "noisy_series",
      detail: {
        reason: "floors_are_barometric_estimates",
        note: "Floors come from a pressure sensor and read weather, lifts and hills as climbing.",
      },
    },
  ];
}

/**
 * Where one origin's values of a sparse type go from rounded to unrounded, or
 * back. `records` may begin before the window (the lookback): a change is
 * reported when the value that changed is inside it.
 */
function precisionChanges(
  scan: Scan,
  type: string,
  field: string,
  records: readonly HcRecord[],
): Finding[] {
  const { clock } = scan.request;
  const last = new Map<string, Precision>();
  const out: Finding[] = [];
  for (const record of records) {
    const value = finite(record.data[field]);
    const now = value === null ? null : precisionOf(value);
    if (value === null || now === null) continue;
    const before = last.get(record.origin);
    if (before !== undefined && before !== now && inWindow(scan, recordStartMs(record))) {
      out.push({
        type,
        kind: "precision_change",
        detail: {
          field,
          origin: record.origin,
          at: clock.iso(recordStartMs(record)),
          from: before,
          to: now,
          decimals: decimals(value),
        },
      });
    }
    last.set(record.origin, now);
  }
  return out;
}

async function sparseFindings(scan: Scan): Promise<Finding[]> {
  const { clock } = scan.request;
  const findings: Finding[] = [];
  // Context follows the policy, not the `types` the report was narrowed to.
  const context = async (type: string): Promise<HcRecord[]> =>
    scan.request.allowed(type) ? scan.raw(type, { marginMs: PROFILE_ARTEFACT_WINDOW_MS }) : [];
  for (const [type, field] of SPARSE_SCALARS) {
    if (!scan.types.has(type)) continue;
    // From the lookback on, so the first value of a window has one before it.
    const records = await scan.raw(type, { fromMs: scan.spanStartMs });
    if (type === "Weight") {
      const own = records.filter((record) => inWindow(scan, recordStartMs(record)));
      const { flags } = flagWeightArtefacts(own, { height: await context("Height") });
      findings.push(...flagFindings(type, flags, clock));
    }
    findings.push(...precisionChanges(scan, type, field, records));
  }
  return findings;
}

async function pressureFindings(scan: Scan): Promise<Finding[]> {
  if (!scan.types.has("BloodPressure")) return [];
  const { duplicates } = dedupeBloodPressure(await scan.raw("BloodPressure"));
  return duplicates.map((drop) => ({
    type: "BloodPressure",
    kind: "duplicate",
    detail: {
      reason: drop.reason,
      at: scan.request.clock.iso(recordStartMs(drop.record)),
      origin: drop.record.origin,
      duplicateOf: drop.duplicateOf,
    },
  }));
}

function overlapFinding(type: string, group: Group<Spanned>, clock: ZoneClock): Finding {
  return {
    type,
    kind: "overlapping_sessions",
    detail: {
      start: clock.iso(group.merged.startMs),
      end: clock.iso(group.merged.endMs),
      sessions: group.members.length,
      exactDuplicates: group.merged.exactDuplicates,
      origins: distinctText(group.members.map((member) => member.summary.origin)),
    },
  };
}

/** The window widened by the session margin: what the session rules read. */
function sessionWindow(scan: Scan): { deviceId: string; startMs: number; endMs: number } {
  return {
    deviceId: scan.request.deviceId,
    startMs: scan.window.startMs - SESSION_MARGIN_MS,
    endMs: scan.window.endMs + SESSION_MARGIN_MS,
  };
}

async function sleepFindings(scan: Scan): Promise<Finding[]> {
  if (!scan.types.has(TYPE_SLEEP)) return [];
  const { clock } = scan.request;
  const nights = await scan.reads.sleepNights(sessionWindow(scan));
  const groups = groupSessions(
    TYPE_SLEEP,
    nights.map(({ id, night }) => ({ id, summary: night })),
  );
  const findings = groups
    .filter((group) => group.members.length > 1 && endsHere(scan, group.merged))
    .map((group) => overlapFinding(TYPE_SLEEP, group, clock));
  // A night whose own stages overlapped: its stage minutes were cut to fit.
  for (const { night } of nights) {
    if (night.stagesOverlap !== true || !endsHere(scan, night)) continue;
    findings.push({
      type: TYPE_SLEEP,
      kind: "overlapping_stages",
      detail: {
        origin: night.origin,
        start: clock.iso(night.startMs),
        end: clock.iso(night.endMs),
      },
    });
  }
  return findings;
}

async function exerciseFindings(scan: Scan): Promise<Finding[]> {
  const type = TYPE_EXERCISE;
  if (!scan.types.has(type)) return [];
  const { clock } = scan.request;
  const sessions = await scan.reads.exerciseSessions(sessionWindow(scan));
  // The left-running flag was read off heart rate and steps, so it is only
  // reported by a call the policy lets see both -- whatever `types` asked for.
  const { allowed } = scan.request;
  const mayJudgeTail = allowed("HeartRate") && allowed("Steps");
  const stored = sessions.map(({ id, session }) => ({ id, summary: session }));
  // Only the sessions of this window are judged: the margin's are here as
  // possible partners of an overlap, and are judged with their own window.
  const own = stored.filter((entry) => endsHere(scan, entry.summary));
  const reasons = mayJudgeTail ? leftRunningReasons(own) : new Map<string, LeftRunningReason>();
  const findings: Finding[] = [];
  const groups = groupSessions(type, stored, mayJudgeTail);
  for (const group of groups) {
    if (group.members.length > 1 && endsHere(scan, group.merged)) {
      findings.push(overlapFinding(type, group, clock));
    }
    for (const { id, summary } of group.members) {
      if (!endsHere(scan, summary)) continue;
      // No reason unless the call may see the flag: nothing was judged for it.
      findings.push(...sessionFlags(summary, reasons.get(id), clock));
    }
  }
  return findings;
}

/** What one exercise session's own length and ending earn it. */
function sessionFlags(
  summary: Spanned & { zeroLength: boolean },
  reason: LeftRunningReason | undefined,
  clock: ZoneClock,
): Finding[] {
  const type = TYPE_EXERCISE;
  const detail = {
    origin: summary.origin,
    start: clock.iso(summary.startMs),
    end: clock.iso(summary.endMs),
    durationMin: (summary.endMs - summary.startMs) / MINUTE_MS,
  };
  return [
    // Longer than three hours by the clock alone; the stricter flag after it
    // also needs an ending that is nothing like the session.
    ...(isOverThreeHours(summary) ? [{ type, kind: "long_session", detail }] : []),
    ...(reason === undefined
      ? []
      : [{ type, kind: "likely_left_running", detail: { ...detail, reason } }]),
    ...(summary.zeroLength ? [{ type, kind: "zero_length_session", detail }] : []),
  ];
}

/** The origin that recorded the most; ties by name. */
function dominant(origins: ReadonlyMap<string, DayShare>): string | null {
  let best: [string, DayShare] | null = null;
  for (const entry of origins) {
    if (
      best === null ||
      entry[1].weight > best[1].weight ||
      (entry[1].weight === best[1].weight && entry[0] < best[0])
    ) {
      best = entry;
    }
  }
  return best === null ? null : best[0];
}

/** The share of a day's total that one origin recorded; 0 when it recorded nothing. */
function shareOf(origins: ReadonlyMap<string, DayShare>, origin: string): number {
  let total = 0;
  for (const share of origins.values()) total += share.weight;
  const own = origins.get(origin)?.weight ?? 0;
  return total > 0 ? own / total : 0;
}

/** Days on which two or more apps recorded a counter: a plain sum would count it twice. */
function overlappingOrigins(
  type: string,
  days: ReadonlyMap<string, Map<string, DayShare>>,
): Finding[] {
  // Counters only: two workouts, or two drinks, by two apps on one day are two.
  if (!isCounter(type)) return [];
  const out: Finding[] = [];
  for (const [date, origins] of days) {
    if (origins.size < 2) continue;
    const counts = [...origins].map(([origin, share]) => [origin, share.records] as const);
    out.push({
      type,
      kind: "overlapping_origins",
      detail: { date, origins: Object.fromEntries(counts) },
    });
  }
  return out;
}

/**
 * What came before the days being walked, when the type was silent for all of
 * them up to its first record there: the silence began earlier than the
 * lookback reaches.
 */
interface Lead {
  /** The first day of the silence, `YYYY-MM-DD`. */
  from: string;
  /** Days of it before the first of the days being walked. */
  days: number;
  /** The app that supplied the type on the last day before it. */
  previous: string | null;
}

/**
 * Gaps and source switches of one type, walking its days from first record to
 * last.
 *
 * A gap is reported only for a type a device records unasked
 * ({@link isGapType}) and that is recorded most days.
 *
 * A switch is the app that supplied a type going away and another taking
 * over: reported on the first day a different app recorded the most AND the
 * app that supplied it before recorded at most
 * {@link SOURCE_SWITCH_MAX_PREVIOUS_SHARE} of that day's total. Two apps
 * recording side by side trade the lead without either leaving, and that is
 * not reported -- the "previous" supplier stays the one last established,
 * so when it does stop the switch is still found.
 *
 * `lead` continues a silence that began before the first of `days`.
 */
function gapsAndSwitches(
  type: string,
  days: ReadonlyMap<string, Map<string, DayShare>>,
  lead: Lead | null = null,
): Finding[] {
  const labels = listOf(days.keys());
  const withData = labels.filter((label) => (days.get(label)?.size ?? 0) > 0);
  const first = withData[0];
  const last = withData.at(-1);
  if (first === undefined || last === undefined) return [];
  const span = labels.slice(labels.indexOf(first), labels.indexOf(last) + 1);
  const regular =
    isGapType(type) &&
    withData.length >= GAP_MIN_DAYS_WITH_DATA &&
    withData.length / span.length >= GAP_MIN_DAY_COVERAGE;

  const out: Finding[] = [];
  // The run of empty days being walked through: where it began and how long it is.
  const gap: { from: string | null; days: number } =
    lead === null
      ? { from: null, days: 0 }
      : { from: lead.from, days: lead.days + labels.indexOf(first) };
  let previous: string | null = lead?.previous ?? null;
  for (const label of span) {
    const origins = days.get(label) ?? new Map<string, DayShare>();
    const source = dominant(origins);
    if (source === null) {
      gap.from ??= label;
      gap.days += 1;
      continue;
    }
    if (regular && gap.from !== null) {
      out.push({ type, kind: "gap", detail: { from: gap.from, days: gap.days, resumed: label } });
    }
    gap.from = null;
    gap.days = 0;
    if (previous === null) {
      previous = source;
      continue;
    }
    if (source === previous) continue;
    const previousShare = shareOf(origins, previous);
    if (previousShare > SOURCE_SWITCH_MAX_PREVIOUS_SHARE) continue;
    out.push({
      type,
      kind: "source_switch",
      detail: { date: label, from: previous, to: source, previousShare },
    });
    previous = source;
  }
  return out;
}

/** `days` after `day` (`YYYY-MM-DD`); negative for before. Calendar arithmetic, no zone. */
function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The silence a type came out of, when it has no record in the lookback and
 * recorded something before it: read from the days between the start of the
 * range and the lookback, for this one type. Null when there is nothing
 * earlier to continue -- the type simply begins in this window.
 */
async function leadInto(
  scan: Scan,
  type: string,
  days: ReadonlyMap<string, Map<string, DayShare>>,
): Promise<Lead | null> {
  const { request } = scan;
  // Only where the lookback was cut by its length, not by the start of the range.
  if (!isGapType(type) || scan.spanStartMs <= request.range.startMs) return null;
  const startDay = request.clock.day(scan.window.startMs);
  let firstData: string | undefined;
  for (const [label, origins] of days) {
    if (origins.size > 0) {
      firstData = label;
      break;
    }
  }
  // Silent in this window too, or recorded during the lookback: nothing to continue.
  if (firstData === undefined || firstData < startDay) return null;
  const rows = await scan.reads.syncRows(request.deviceId);
  const firstMs = rows.find((row) => row.recordType === type)?.firstMs ?? null;
  if (firstMs === null || firstMs >= scan.spanStartMs) return null;
  const earlier = await scan.days(type, {
    startMs: request.range.startMs,
    endMs: scan.spanStartMs,
  });
  let lastLabel: string | null = null;
  let lastOrigins: ReadonlyMap<string, DayShare> | null = null;
  let after = 0;
  for (const [label, origins] of earlier) {
    if (origins.size > 0) {
      lastLabel = label;
      lastOrigins = origins;
      after = 0;
    } else {
      after += 1;
    }
  }
  return lastLabel === null || lastOrigins === null
    ? null
    : { from: addDays(lastLabel, 1), days: after, previous: dominant(lastOrigins) };
}

/** True for a day-level finding dated inside the window. */
function datedHere(finding: Finding, startDay: string): boolean {
  const { detail } = finding;
  const date = finding.kind === "gap" ? detail.resumed : detail.date;
  return typeof date === "string" && date >= startDay;
}

async function dayFindings(scan: Scan): Promise<Finding[]> {
  const { request } = scan;
  const startDay = request.clock.day(scan.window.startMs);
  const range = { startMs: scan.spanStartMs, endMs: scan.window.endMs };
  const findings: Finding[] = [];
  for (const type of request.types) {
    const days = await scan.days(type, range);
    const found = [
      ...overlappingOrigins(type, days),
      ...gapsAndSwitches(type, days, await leadInto(scan, type, days)),
    ];
    findings.push(...found.filter((finding) => datedHere(finding, startDay)));
  }
  return findings;
}

/**
 * When one overnight type was measured in the window, to the hour rollup's
 * resolution: the first and the last reading of every hour that has any. No
 * record is opened -- a wearable that logs a figure all night makes a handful
 * of rows a night, and one that stamps it once makes one.
 */
async function vitalInstants(scan: Scan, type: string): Promise<number[]> {
  const { window } = scan;
  const rollups = await scan.reads.hourRollups({
    deviceId: scan.request.deviceId,
    type,
    startMs: Math.floor(window.startMs / HOUR_MS) * HOUR_MS,
    endMs: window.endMs,
  });
  const instants: number[] = [];
  for (const row of rollups) {
    for (const stats of Object.values(row.rollup.fields)) {
      instants.push(stats.firstMs, stats.lastMs);
    }
  }
  return instants.filter((instant) => inWindow(scan, instant));
}

/**
 * Dates on which the wearable wrote its overnight figures and no sleep session
 * accounts for them: the night was measured, and its session is not in the
 * store.
 *
 * A reading is accounted for when it is timed inside a stored sleep session or
 * within {@link SLEEP_MATCH_TOLERANCE_MS} of either end -- the reach the night
 * summaries themselves use to give a reading to a session. What is left is
 * filed under its local date, and a date with unaccounted readings of at least
 * {@link SESSION_MISSING_MIN_VITALS} DIFFERENT overnight types is a finding.
 * Judged by time and not by date, so the evening half of a night that is
 * there is never mistaken for a night that is not.
 *
 * A finding about `SleepSession`, so it is reported when sleep is asked
 * about; the vitals are context, read wherever the policy allows them and
 * never when it does not.
 */
async function missingSessionFindings(scan: Scan): Promise<Finding[]> {
  if (!scan.types.has(TYPE_SLEEP)) return [];
  const { request } = scan;
  const { clock } = request;
  const measured: [string, number[]][] = [];
  for (const type of OVERNIGHT_VITALS) {
    if (!request.allowed(type)) continue;
    const instants = await vitalInstants(scan, type);
    if (instants.length > 0) measured.push([type, instants]);
  }
  if (measured.length < SESSION_MISSING_MIN_VITALS) return [];
  const stored = await scan.reads.sleepNights(sessionWindow(scan));
  const nights = stored.map(({ night }) => ({
    fromMs: night.startMs - SLEEP_MATCH_TOLERANCE_MS,
    toMs: night.endMs + SLEEP_MATCH_TOLERANCE_MS,
  }));
  const unaccounted = (instant: number): boolean =>
    nights.every((night) => instant < night.fromMs || instant > night.toMs);
  const vitalsByDate = new Map<string, string[]>();
  for (const [type, instants] of measured) {
    const loose = instants.filter((instant) => unaccounted(instant));
    const dates = new Set(loose.map((instant) => clock.day(instant)));
    for (const date of dates) fileUnder(vitalsByDate, date, type);
  }
  const findings: Finding[] = [];
  const dates = sortedBy(vitalsByDate.keys(), (left, right) => (left < right ? -1 : 1));
  for (const date of dates) {
    const vitals = distinctText(vitalsByDate.get(date) ?? []);
    if (vitals.length < SESSION_MISSING_MIN_VITALS) continue;
    findings.push({ type: TYPE_SLEEP, kind: "session_missing", detail: { date, vitals } });
  }
  return findings;
}

/** Everything worth knowing about one window of a phone's data. */
async function assess(
  reads: HcReads,
  request: QualityRequest,
  window: Range,
  spanStartMs: number,
): Promise<Finding[]> {
  const scan = startScan(reads, request, window, spanStartMs);
  return [
    ...(await pressureFindings(scan)),
    ...(await denseFindings(scan)),
    ...standingFindings(scan),
    ...(await sparseFindings(scan)),
    ...(await sleepFindings(scan)),
    ...(await missingSessionFindings(scan)),
    ...(await exerciseFindings(scan)),
    ...(await dayFindings(scan)),
  ];
}

/**
 * A range assessed as ONE window: every read spans all of it. What the
 * windowed forms are held against in the tests, and right for nothing longer
 * than a window -- over years it is the read that a request cannot carry.
 */
export async function dataQualityInOneRead(
  reads: HcReads,
  request: QualityRequest,
): Promise<Finding[]> {
  return assess(reads, request, request.range, request.range.startMs);
}

/** Where one page of a windowed assessment starts and how much it may carry. */
interface QualityPageOptions {
  /**
   * Where this page starts: the `nextMs` of the page before it. Omitted (or
   * outside the range): the start of the range.
   */
  fromMs?: number | null | undefined;
  /**
   * Where this page must stop, for a page that is being read AGAIN: a cursor
   * that cut inside a page's rows resumes by offset, so the rows have to be
   * the same rows. Omitted: the page stops by its budget.
   */
  untilMs?: number | null | undefined;
  /** Bytes of findings after which no further window is read. Soft: a window is never cut. */
  maxBytes: number;
}

interface QualityPage {
  findings: Finding[];
  /** Where this page started and stopped, epoch ms. */
  fromMs: number;
  untilMs: number;
  /** True when it reached the end of the range: there is no next page. */
  done: boolean;
}

/** The end of the window that starts at `startMs`: a local midnight, or the end of the range. */
function windowEndMs(request: QualityRequest, startMs: number): number {
  const { clock, range } = request;
  const endDay = addDays(clock.day(startMs), QUALITY_WINDOW_DAYS);
  return Math.min(range.endMs, dayBoundsMs(endDay, clock.timeZone).startMs);
}

/** Where the lookback before a window that starts at `startMs` begins. */
function lookbackStartMs(request: QualityRequest, startMs: number): number {
  const { clock, range } = request;
  if (startMs <= range.startMs) return range.startMs;
  const day = addDays(clock.day(startMs), -QUALITY_LOOKBACK_DAYS);
  return Math.max(range.startMs, dayBoundsMs(day, clock.timeZone).startMs);
}

const encoder = new TextEncoder();

/** Roughly what the findings weigh as rows: enough to decide when a page is full. */
function bytesOf(findings: readonly Finding[]): number {
  let total = 0;
  for (const finding of findings) total += encoder.encode(JSON.stringify(finding)).length + 1;
  return total;
}

/**
 * One page of a range's assessment: whole windows from `fromMs`, until the
 * page holds `maxBytes` of findings, {@link QUALITY_MAX_WINDOWS_PER_CALL}
 * windows have been read, or the range ends. See "Long ranges" above.
 *
 * What the store has memoised of each window is released before the next
 * (`HcReads.releaseReads`), so a page holds one window's rows at a time.
 */
export async function dataQualityPage(
  reads: HcReads,
  request: QualityRequest,
  options: QualityPageOptions,
): Promise<QualityPage> {
  const { range } = request;
  const asked = options.fromMs ?? range.startMs;
  const fromMs = asked > range.startMs && asked < range.endMs ? asked : range.startMs;
  const fixedEnd = options.untilMs ?? null;
  const findings: Finding[] = [];
  let startMs = fromMs;
  let windows = 0;
  while (startMs < range.endMs) {
    const endMs = windowEndMs(request, startMs);
    const window = { startMs, endMs };
    findings.push(...(await assess(reads, request, window, lookbackStartMs(request, startMs))));
    reads.releaseReads?.();
    startMs = endMs;
    windows += 1;
    const full =
      fixedEnd === null
        ? windows >= QUALITY_MAX_WINDOWS_PER_CALL || bytesOf(findings) >= options.maxBytes
        : startMs >= fixedEnd;
    if (full) break;
  }
  const untilMs = Math.max(startMs, fromMs);
  return { findings, fromMs, untilMs, done: untilMs >= range.endMs };
}

/**
 * Everything worth knowing about one phone's data in a range: every page of
 * {@link dataQualityPage}, one after another, as one list.
 *
 * It walks the range in the same windows and lets go of each before the
 * next, so however long the range is it never holds more than a window of
 * the store -- which is what a single read of a whole history could not do.
 * It still does all the work in one call: a caller that can hand back a
 * cursor should page with `dataQualityPage` instead and do a bounded part.
 */
export async function dataQuality(reads: HcReads, request: QualityRequest): Promise<Finding[]> {
  const findings: Finding[] = [];
  let fromMs: number | null = null;
  for (;;) {
    const page = await dataQualityPage(reads, request, {
      fromMs,
      maxBytes: Infinity,
    });
    findings.push(...page.findings);
    if (page.done) return findings;
    fromMs = page.untilMs;
  }
}
