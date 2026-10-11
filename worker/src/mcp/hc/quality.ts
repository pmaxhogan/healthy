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
 *    changing: from one per-day, per-origin count of each type.
 *
 * The last group and the precision check are observations, not rules about
 * any one record, so their thresholds live here.
 *
 * `request.types` says which types to REPORT findings for: what the caller
 * asked about, of what the phone holds and the exposure policy allows. It does
 * not decide what a rule may read for context. A profile-setup weight is told
 * by the height beside it and a left-running session by heart rate and steps;
 * asking about `Weight` alone must still find the profile weight. Context is
 * gated by the exposure policy only (`request.allowed`): a denied type is
 * never read, as a finding or as context.
 */

import {
  FLOORS_MAX_PER_MINUTE,
  HR_MAX_PLAUSIBLE_BPM,
  HR_MIN_PLAUSIBLE_BPM,
  LEFT_RUNNING_MIN_DURATION_MS,
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
import { groupSessions } from "./sessions.ts";
import { HOUR_MS, MINUTE_MS } from "./time.ts";
import { distinctText, fileUnder, finite, listOf, mapUnder, sortedBy } from "./util.ts";

import type { AggregateRow } from "./aggregate.ts";
import type { HcReads } from "./reads.ts";
import type { Group, Spanned } from "./sessions.ts";
import type { Range, ZoneClock } from "./time.ts";
import type { ArtefactFlag, ArtefactResult } from "../../hc/rules.ts";
import type { HcRecord } from "../../hc/wire.ts";

/**
 * A type is "recorded daily" -- so that a day without it is a gap worth
 * reporting -- when it has records on at least this share of the days between
 * its first and last day in the range. Half: a watch worn most days qualifies,
 * a scale stepped on now and then does not.
 */
const GAP_MIN_DAY_COVERAGE = 0.5;

/** And it needs at least this many days with records before a gap means anything. */
const GAP_MIN_DAYS_WITH_DATA = 3;

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
  gapMinDayCoverage: GAP_MIN_DAY_COVERAGE,
  gapMinDaysWithData: GAP_MIN_DAYS_WITH_DATA,
  sourceSwitchMaxPreviousShare: SOURCE_SWITCH_MAX_PREVIOUS_SHARE,
  precisionRoundedMaxDecimals: PRECISION_ROUNDED_MAX_DECIMALS,
  precisionUnroundedMinDecimals: PRECISION_UNROUNDED_MIN_DECIMALS,
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

/** One call's reads: the request, and the two ways it gets records. */
interface Scan {
  reads: HcReads;
  request: QualityRequest;
  types: ReadonlySet<string>;
  /** One type's records that start within `marginMs` of the range. */
  raw: (type: string, marginMs?: number) => Promise<HcRecord[]>;
}

function startScan(reads: HcReads, request: QualityRequest): Scan {
  const { deviceId, range } = request;
  return {
    reads,
    request,
    types: new Set(request.types),
    raw: async (type, marginMs = 0) => {
      const startMs = range.startMs - marginMs;
      const endMs = range.endMs + marginMs;
      const records = await reads.records({ deviceId, type, startMs, endMs });
      return records.filter((record) => {
        const at = recordStartMs(record);
        return at >= startMs && at < endMs;
      });
    },
  };
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
  const { deviceId, range } = scan.request;
  const rollups = await scan.reads.hourRollups({
    deviceId,
    type: dense.type,
    // From the hour the range starts in: its flags are filtered to the range below.
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
    findings.push(...flagFindings(dense.type, flags, clock), {
      type: dense.type,
      kind: "noisy_series",
      detail: {
        reason: "floors_are_barometric_estimates",
        note: "Floors come from a pressure sensor and read weather, lifts and hills as climbing.",
      },
    });
  }
  return findings;
}

/** Where one origin's values of a sparse type go from rounded to unrounded, or back. */
function precisionChanges(
  type: string,
  field: string,
  records: readonly HcRecord[],
  clock: ZoneClock,
): Finding[] {
  const last = new Map<string, Precision>();
  const out: Finding[] = [];
  for (const record of records) {
    const value = finite(record.data[field]);
    const now = value === null ? null : precisionOf(value);
    if (value === null || now === null) continue;
    const before = last.get(record.origin);
    if (before !== undefined && before !== now) {
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
    scan.request.allowed(type) ? scan.raw(type, PROFILE_ARTEFACT_WINDOW_MS) : [];
  for (const [type, field] of SPARSE_SCALARS) {
    if (!scan.types.has(type)) continue;
    const records = await scan.raw(type);
    if (type === "Weight") {
      const { flags } = flagWeightArtefacts(records, { height: await context("Height") });
      findings.push(...flagFindings(type, flags, clock));
    }
    findings.push(...precisionChanges(type, field, records, clock));
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

async function sleepFindings(scan: Scan): Promise<Finding[]> {
  if (!scan.types.has("SleepSession")) return [];
  const { deviceId, range, clock } = scan.request;
  const nights = await scan.reads.sleepNights({ deviceId, ...range });
  const groups = groupSessions(
    "SleepSession",
    nights.map(({ id, night }) => ({ id, summary: night })),
  );
  const findings = groups
    .filter((group) => group.members.length > 1)
    .map((group) => overlapFinding("SleepSession", group, clock));
  // A night whose own stages overlapped: its stage minutes were cut to fit.
  for (const { night } of nights) {
    if (night.stagesOverlap !== true) continue;
    findings.push({
      type: "SleepSession",
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
  const type = "ExerciseSession";
  if (!scan.types.has(type)) return [];
  const { deviceId, range, clock } = scan.request;
  const sessions = await scan.reads.exerciseSessions({ deviceId, ...range });
  // The left-running flag was read off heart rate and steps, so it is only
  // reported by a call the policy lets see both -- whatever `types` asked for.
  const { allowed } = scan.request;
  const mayJudgeTail = allowed("HeartRate") && allowed("Steps");
  const findings: Finding[] = [];
  const groups = groupSessions(
    type,
    sessions.map(({ id, session }) => ({ id, summary: session })),
    mayJudgeTail,
  );
  for (const group of groups) {
    if (group.members.length > 1) findings.push(overlapFinding(type, group, clock));
    for (const { summary } of group.members) {
      const detail = {
        origin: summary.origin,
        start: clock.iso(summary.startMs),
        end: clock.iso(summary.endMs),
        durationMin: (summary.endMs - summary.startMs) / MINUTE_MS,
      };
      const checks: [boolean, string][] = [
        // Longer than three hours by the clock alone; the stricter flag after
        // it also needs a quiet ending.
        [isOverThreeHours(summary), "long_session"],
        [mayJudgeTail && summary.likelyLeftRunning, "likely_left_running"],
        [summary.zeroLength, "zero_length_session"],
      ];
      for (const [found, kind] of checks) if (found) findings.push({ type, kind, detail });
    }
  }
  return findings;
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
 * Gaps and source switches of one type, walking its days from first record to
 * last.
 *
 * A switch is the app that supplied a type going away and another taking
 * over: reported on the first day a different app recorded the most AND the
 * app that supplied it before recorded at most
 * {@link SOURCE_SWITCH_MAX_PREVIOUS_SHARE} of that day's total. Two apps
 * recording side by side trade the lead without either leaving, and that is
 * not reported -- the "previous" supplier stays the one last established,
 * so when it does stop the switch is still found.
 */
function gapsAndSwitches(
  type: string,
  days: ReadonlyMap<string, Map<string, DayShare>>,
): Finding[] {
  const labels = listOf(days.keys());
  const withData = labels.filter((label) => (days.get(label)?.size ?? 0) > 0);
  const first = withData[0];
  const last = withData.at(-1);
  if (first === undefined || last === undefined) return [];
  const span = labels.slice(labels.indexOf(first), labels.indexOf(last) + 1);
  const regular =
    withData.length >= GAP_MIN_DAYS_WITH_DATA &&
    withData.length / span.length >= GAP_MIN_DAY_COVERAGE;

  const out: Finding[] = [];
  // The run of empty days being walked through: where it began and how long it is.
  const gap: { from: string | null; days: number } = { from: null, days: 0 };
  let previous: string | null = null;
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

async function dayFindings(scan: Scan): Promise<Finding[]> {
  const { request } = scan;
  const findings: Finding[] = [];
  for (const type of request.types) {
    const answer = await aggregate(scan.reads, {
      deviceId: request.deviceId,
      type,
      range: request.range,
      bucket: "day",
      mode: { kind: "all_separately" },
      metrics: ["sum", "records", "duration"],
      fill: "zero",
      excludeFuture: true,
      nowMs: request.nowMs,
      clock: request.clock,
      dayRollupsUsable: await request.dayRollupsUsable(type, request.range),
      bmrKcalPerDay: null,
      // Every record is counted here: an artefact is still a record an app wrote.
      excludeArtefacts: false,
      allowed: request.allowed,
    });
    const days = dayOrigins(answer.rows);
    findings.push(...overlappingOrigins(type, days), ...gapsAndSwitches(type, days));
  }
  return findings;
}

/** Everything worth knowing about one phone's data in a range. */
export async function dataQuality(reads: HcReads, request: QualityRequest): Promise<Finding[]> {
  const scan = startScan(reads, request);
  return [
    ...(await pressureFindings(scan)),
    ...(await denseFindings(scan)),
    ...(await sparseFindings(scan)),
    ...(await sleepFindings(scan)),
    ...(await exerciseFindings(scan)),
    ...(await dayFindings(scan)),
  ];
}
