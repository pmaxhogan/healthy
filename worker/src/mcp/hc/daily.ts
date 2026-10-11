/**
 * `daily_summary`: one row per local day, joining what the other Health
 * Connect tools answer one type at a time.
 *
 * Every number comes from the same code the single-type tools use, so a day
 * here can never disagree with `hc_aggregate` or `blood_pressure` about the
 * same day:
 *
 *  - steps, distance, active and total energy: `aggregate()` by day under
 *    `hc_priority`. Total energy is what was recorded -- never padded with
 *    basal metabolic rate.
 *  - HRV and respiratory rate: the day's mean, every origin.
 *  - sleep: the night that ENDED on the day -- the day you woke up, which is
 *    also where `hc_aggregate` files a night (the longest, when there are
 *    several; the others are counted as `naps`).
 *  - blood pressure: the day's readings after the duplicate rule.
 *  - weight: the day's last weighing after the profile-setup rule. Every
 *    weighing is still listed (`weighings`), each with the flag it earned.
 *  - resting heart rate: RestingHeartRate records, but not a cuff's. A
 *    blood-pressure app that also writes its pulse as a "resting heart rate"
 *    is not measuring one, so a RestingHeartRate record from an origin that
 *    wrote a BloodPressure reading within {@link CUFF_PULSE_WINDOW_MS} of the
 *    same instant is left out and counted.
 *
 * A section whose record type the exposure policy denies is not read and is
 * absent from the row, not null: the caller is told by a warning, and the row
 * does not say the type exists. The caller passes every row through
 * `stripJoined` (`./policy.ts`) as well, which is what removes a field that
 * sits inside another type's section (`sleep.skinTempDelta`). A rule that
 * needs a second type for context -- the cuff rule needs the readings, the
 * profile rule a height -- only gets it when that type is itself allowed, and
 * a flag is only raised from types the call may see. A denied type is never
 * read to apply a rule: the rule is then NOT applied, the figure is what was
 * recorded, and the answer says so with a stable warning
 * (`resting_hr_cuff_rule_not_applied`, `weight_artefact_rule_not_applied`),
 * which names the rule and nothing about the type that was withheld.
 */

import { dayBoundsMs, daysTouched } from "../../hc/rollup/day.ts";
import { dedupeBloodPressure, flagWeightArtefacts, isOverThreeHours } from "../../hc/rules.ts";
import { recordStartMs } from "../../hc/wire.ts";

import { aggregate } from "./aggregate.ts";
import { groupSessions } from "./sessions.ts";
import { MINUTE_MS } from "./time.ts";
import { fileUnder, finite, meanOf, numbersOf } from "./util.ts";

import type { AggregateRow, Metric } from "./aggregate.ts";
import type { HcReads } from "./reads.ts";
import type { Group } from "./sessions.ts";
import type { Range, ZoneClock } from "./time.ts";
import type { ExerciseSummary, SleepNight } from "../../hc/rollup/types.ts";
import type { HcRecord } from "../../hc/wire.ts";

/**
 * How close a RestingHeartRate record must be to a BloodPressure reading from
 * the same app to be taken for the cuff's pulse, ms. One minute: a cuff
 * writes both from one measurement, seconds apart at most, while a wearable's
 * daily resting figure is stamped on its own schedule.
 */
const CUFF_PULSE_WINDOW_MS = MINUTE_MS;

/** The record types `daily_summary` reads, by the section each fills. */
export const DAILY_TYPES = {
  steps: "Steps",
  distance: "Distance",
  activeKcal: "ActiveCaloriesBurned",
  totalKcal: "TotalCaloriesBurned",
  sleep: "SleepSession",
  restingHr: "RestingHeartRate",
  hrv: "HeartRateVariabilityRmssd",
  respiratoryRate: "RespiratoryRate",
  bloodPressure: "BloodPressure",
  weight: "Weight",
  exercises: "ExerciseSession",
} as const;

export type DailySection = keyof typeof DAILY_TYPES;

export interface DailyRequest {
  deviceId: string;
  /** Local days, `YYYY-MM-DD`, ascending and consecutive. */
  days: readonly string[];
  clock: ZoneClock;
  nowMs: number;
  /** Whether one type's day rollups can answer the range: see `dayRollupsUsable` in `./sources.ts`. */
  dayRollupsUsable: (type: string, range: Range) => Promise<boolean>;
  /** The sections the exposure policy lets this call fill. */
  sections: ReadonlySet<DailySection>;
  /**
   * Whether the policy lets this call read a record type at all. The rules
   * that need a second type for context (a cuff's readings, a profile's
   * height) only get it when that type is itself allowed.
   */
  allowed: (type: string) => boolean;
}

export interface DailyResult {
  rows: Record<string, unknown>[];
  /** RestingHeartRate records left out as a cuff's pulse. */
  cuffPulsesExcluded: number;
  /** Blood-pressure copies the duplicate rule dropped. */
  bpDuplicatesDropped: number;
  /** Records of other apps left out of the day totals. */
  duplicatesDropped: number;
  /**
   * Stable codes of the rules that could not be applied because the type they
   * need for context is withheld: the figures they guard are as recorded.
   */
  rulesNotApplied: string[];
}

/** The cuff rule could not run: `restingHr` may include a cuff's pulse. */
const CUFF_RULE_NOT_APPLIED = "resting_hr_cuff_rule_not_applied";
/** The profile-setup rule could not run: `weight` may be a typed-in profile entry. */
const WEIGHT_RULE_NOT_APPLIED = "weight_artefact_rule_not_applied";

/** `records` filed under each one's local day. */
function byDay(records: readonly HcRecord[], clock: ZoneClock): Map<string, HcRecord[]> {
  const out = new Map<string, HcRecord[]>();
  for (const record of records) fileUnder(out, clock.day(recordStartMs(record)), record);
  return out;
}

/**
 * RestingHeartRate records that are not a cuff's pulse: see the module
 * comment. `readings` are the BloodPressure records around the same time.
 */
function excludeCuffPulses(
  resting: readonly HcRecord[],
  readings: readonly HcRecord[],
): { kept: HcRecord[]; excluded: HcRecord[] } {
  const times = new Map<string, number[]>();
  for (const reading of readings) fileUnder(times, reading.origin, recordStartMs(reading));
  const kept: HcRecord[] = [];
  const excluded: HcRecord[] = [];
  for (const record of resting) {
    const at = recordStartMs(record);
    const cuff = (times.get(record.origin) ?? []).some(
      (time) => Math.abs(time - at) <= CUFF_PULSE_WINDOW_MS,
    );
    (cuff ? excluded : kept).push(record);
  }
  return { kept, excluded };
}

/** Everything read for the range, filed by local day. */
interface DailyData {
  totals: Record<"steps" | "distance" | "activeKcal" | "totalKcal", Map<string, AggregateRow>>;
  hrv: Map<string, AggregateRow>;
  respiratoryRate: Map<string, AggregateRow>;
  pressure: Map<string, HcRecord[]>;
  pressureDropped: Map<string, HcRecord[]>;
  resting: Map<string, HcRecord[]>;
  cuffPulses: Map<string, HcRecord[]>;
  /** Weighings the profile-setup rule kept: what the day's `weight` is read from. */
  weights: Map<string, HcRecord[]>;
  /** Every weighing, and the reason each flagged one was flagged, by record id. */
  weighings: Map<string, HcRecord[]>;
  weightFlags: Map<string, string>;
  weightFlagDays: Set<string>;
  nights: Group<SleepNight>[];
  workouts: Group<ExerciseSummary>[];
}

/** Reads one type's records that START within `marginMs` of the range. */
function rawReader(reads: HcReads, deviceId: string, range: Range) {
  return async (type: string, marginMs = 0): Promise<HcRecord[]> => {
    const startMs = range.startMs - marginMs;
    const endMs = range.endMs + marginMs;
    const records = await reads.records({ deviceId, type, startMs, endMs });
    return records.filter((record) => {
      const at = recordStartMs(record);
      return at >= startMs && at < endMs;
    });
  };
}

/** The left-running flag is read off heart rate and steps, so it follows them. */
function mayJudgeTail(request: DailyRequest): boolean {
  return request.allowed("HeartRate") && request.allowed("Steps");
}

async function loadSessions(
  reads: HcReads,
  request: DailyRequest,
  range: Range,
): Promise<Pick<DailyData, "nights" | "workouts">> {
  const { deviceId, sections } = request;
  const nights = sections.has("sleep") ? await reads.sleepNights({ deviceId, ...range }) : [];
  const workouts = sections.has("exercises")
    ? await reads.exerciseSessions({ deviceId, ...range })
    : [];
  return {
    nights: groupSessions(
      DAILY_TYPES.sleep,
      nights.map(({ id, night }) => ({ id, summary: night })),
    ),
    workouts: groupSessions(
      DAILY_TYPES.exercises,
      workouts.map(({ id, session }) => ({ id, summary: session })),
      mayJudgeTail(request),
    ),
  };
}

/** The measurements read record by record: blood pressure, resting heart rate, weight. */
async function loadReadings(
  reads: HcReads,
  request: DailyRequest,
  range: Range,
  result: DailyResult,
): Promise<
  Pick<
    DailyData,
    | "pressure"
    | "pressureDropped"
    | "resting"
    | "cuffPulses"
    | "weights"
    | "weighings"
    | "weightFlags"
    | "weightFlagDays"
  >
> {
  const { clock, sections } = request;
  const raw = rawReader(reads, request.deviceId, range);
  const wants = (section: DailySection, type: string): boolean =>
    sections.has(section) && request.allowed(type);

  // The cuff rule needs the readings too, but only a call that may see blood
  // pressure reads them: with the type denied, "a pulse was excluded" would
  // say a reading exists. Resting heart rate is then reported as recorded,
  // and the answer says the rule did not run.
  const readings = sections.has("bloodPressure")
    ? await raw(DAILY_TYPES.bloodPressure, CUFF_PULSE_WINDOW_MS)
    : [];
  const pressure = dedupeBloodPressure(
    readings.filter((record) => {
      const at = recordStartMs(record);
      return at >= range.startMs && at < range.endMs;
    }),
  );
  result.bpDuplicatesDropped = pressure.duplicates.length;

  const restingRecords = sections.has("restingHr") ? await raw(DAILY_TYPES.restingHr) : [];
  const resting = excludeCuffPulses(restingRecords, readings);
  result.cuffPulsesExcluded = resting.excluded.length;
  if (restingRecords.length > 0 && !sections.has("bloodPressure")) {
    result.rulesNotApplied.push(CUFF_RULE_NOT_APPLIED);
  }

  const weightRecords = sections.has("weight") ? await raw(DAILY_TYPES.weight) : [];
  const weights = flagWeightArtefacts(weightRecords, {
    height: wants("weight", "Height") ? await raw("Height", MINUTE_MS) : [],
  });
  if (weightRecords.length > 0 && !request.allowed("Height")) {
    result.rulesNotApplied.push(WEIGHT_RULE_NOT_APPLIED);
  }
  const weightFlags = new Map(weights.flags.map((flag) => [flag.recordId, flag.reason]));

  return {
    pressure: byDay(pressure.kept, clock),
    pressureDropped: byDay(
      pressure.duplicates.map((drop) => drop.record),
      clock,
    ),
    resting: byDay(resting.kept, clock),
    cuffPulses: byDay(resting.excluded, clock),
    weights: byDay(weights.kept, clock),
    // Every weighing, flagged ones included: a flag takes a record out of the
    // day's figure, never out of the list.
    weighings: byDay(weights.records, clock),
    weightFlags,
    weightFlagDays: new Set(weights.flags.map((flag) => clock.day(flag.t))),
  };
}

async function loadDaily(
  reads: HcReads,
  request: DailyRequest,
  range: Range,
  result: DailyResult,
): Promise<DailyData> {
  const { deviceId, clock, sections } = request;
  const perDay = async (
    section: DailySection,
    metrics: readonly Metric[],
  ): Promise<Map<string, AggregateRow>> => {
    if (!sections.has(section)) return new Map();
    const answer = await aggregate(reads, {
      deviceId,
      type: DAILY_TYPES[section],
      range,
      bucket: "day",
      mode: { kind: "hc_priority" },
      metrics,
      fill: "null",
      excludeFuture: true,
      nowMs: request.nowMs,
      clock,
      dayRollupsUsable: await request.dayRollupsUsable(DAILY_TYPES[section], range),
      bmrKcalPerDay: null,
      allowed: request.allowed,
    });
    result.duplicatesDropped += answer.duplicatesDropped;
    return new Map(answer.rows.map((row) => [row.bucket, row]));
  };
  return {
    totals: {
      steps: await perDay("steps", ["sum"]),
      distance: await perDay("distance", ["sum"]),
      activeKcal: await perDay("activeKcal", ["sum"]),
      totalKcal: await perDay("totalKcal", ["sum"]),
    },
    hrv: await perDay("hrv", ["mean", "n"]),
    respiratoryRate: await perDay("respiratoryRate", ["mean", "n"]),
    ...(await loadReadings(reads, request, range, result)),
    ...(await loadSessions(reads, request, range)),
  };
}

function sumOf(row: AggregateRow | undefined, field: string): number | null {
  return row?.values[field]?.sum ?? null;
}

function meanField(row: AggregateRow | undefined, field: string): number | null {
  return row?.values[field]?.mean ?? null;
}

/** The night with the most sleep: a nap beside it is not "the night". */
function mainNight(nights: readonly Group<SleepNight>[]): Group<SleepNight> | undefined {
  let main = nights[0];
  for (const group of nights) {
    if (main === undefined || group.primary.summary.asleepMin > main.primary.summary.asleepMin) {
      main = group;
    }
  }
  return main;
}

/** What to read one day with care for. Only ever raised from types the call may see. */
function dayFlags(
  day: string,
  data: DailyData,
  request: DailyRequest,
  sessions: { nights: readonly Group<SleepNight>[]; workouts: readonly Group<ExerciseSummary>[] },
): string[] {
  const totals = Object.values(data.totals).map((rows) => rows.get(day));
  const { endMs } = dayBoundsMs(day, request.clock.timeZone);
  const checks: [boolean, string][] = [
    [endMs > request.nowMs || totals.some((row) => row?.partial === true), "partial_day"],
    [totals.some((row) => (row?.duplicatesDropped ?? 0) > 0), "other_origins_dropped"],
    [sessions.nights.some((group) => group.members.length > 1), "sleep_sessions_merged"],
    [
      sessions.nights.some((group) => group.primary.summary.stagesOverlap === true),
      "sleep_stages_overlap",
    ],
    [
      sessions.nights.some((group) => group.primary.summary.contextClamped === true) ||
        sessions.workouts.some((group) => group.primary.summary.contextClamped === true),
      "session_context_clamped",
    ],
    [
      sessions.workouts.some((group) => isOverThreeHours(group.primary.summary)),
      "exercise_over_three_hours",
    ],
    [
      mayJudgeTail(request) &&
        sessions.workouts.some((group) => group.primary.summary.likelyLeftRunning),
      "exercise_likely_left_running",
    ],
    [sessions.workouts.some((group) => group.members.length > 1), "exercise_sessions_merged"],
    [data.pressureDropped.has(day), "bp_duplicates_dropped"],
    [data.cuffPulses.has(day), "resting_hr_cuff_pulse_excluded"],
    [data.weightFlagDays.has(day), "weight_profile_artefact_excluded"],
  ];
  return checks.flatMap(([raised, flag]) => (raised ? [flag] : []));
}

function sleepSection(
  nights: readonly Group<SleepNight>[],
  clock: ZoneClock,
): Record<string, unknown> | null {
  const night = mainNight(nights)?.primary.summary;
  if (night === undefined) return null;
  return {
    start: clock.iso(night.startMs),
    end: clock.iso(night.endMs),
    inBedMin: night.inBedMin,
    asleepMin: night.asleepMin,
    awakeMin: night.awakeMin,
    wearableWake: clock.isoOrNull(night.stageWakeMs),
    skinTempDelta: night.skinTempDelta,
    origin: night.origin,
    naps: nights.length - 1,
  };
}

function pressureSection(readings: readonly HcRecord[]): Record<string, unknown> | null {
  if (readings.length === 0) return null;
  return {
    systolic: meanOf(numbersOf(readings, "systolic")),
    diastolic: meanOf(numbersOf(readings, "diastolic")),
    readings: readings.length,
  };
}

function dayRow(day: string, data: DailyData, request: DailyRequest): Record<string, unknown> {
  const { clock, sections } = request;
  const nights = data.nights.filter((group) => clock.day(group.merged.endMs) === day);
  // A workout is filed on the day it started, by its own times: the figures
  // of a merged row are all its longest session's.
  const workouts = data.workouts.filter(
    (group) => clock.day(group.primary.summary.startMs) === day,
  );
  const has = (section: DailySection): boolean => sections.has(section);
  return {
    date: day,
    ...(has("steps") && { steps: sumOf(data.totals.steps.get(day), "count") }),
    ...(has("distance") && { distance: sumOf(data.totals.distance.get(day), "distance") }),
    ...(has("activeKcal") && { activeKcal: sumOf(data.totals.activeKcal.get(day), "energy") }),
    ...(has("totalKcal") && { totalKcal: sumOf(data.totals.totalKcal.get(day), "energy") }),
    ...(has("sleep") && { sleep: sleepSection(nights, clock) }),
    ...(has("restingHr") && { restingHr: meanOf(numbersOf(data.resting.get(day) ?? [], "bpm")) }),
    ...(has("hrv") && { hrvRmssd: meanField(data.hrv.get(day), "rmssd") }),
    ...(has("respiratoryRate") && {
      respiratoryRate: meanField(data.respiratoryRate.get(day), "rate"),
    }),
    ...(has("bloodPressure") && { bloodPressure: pressureSection(data.pressure.get(day) ?? []) }),
    ...(has("weight") && {
      weight: numbersOf(data.weights.get(day) ?? [], "weight").at(-1) ?? null,
      weighings: (data.weighings.get(day) ?? []).map((record) => ({
        time: clock.iso(recordStartMs(record)),
        weight: finite(record.data.weight),
        origin: record.origin,
        flag: data.weightFlags.get(record.id) ?? null,
      })),
    }),
    ...(has("exercises") && {
      exercises: workouts.map((group) => ({
        title: group.primary.summary.title,
        exerciseType: group.primary.summary.exerciseType,
        start: clock.iso(group.primary.summary.startMs),
        durationMin: (group.primary.summary.endMs - group.primary.summary.startMs) / MINUTE_MS,
        overThreeHours: isOverThreeHours(group.primary.summary),
        likelyLeftRunning: group.primary.summary.likelyLeftRunning,
      })),
    }),
    flags: dayFlags(day, data, request, { nights, workouts }),
  };
}

/** Summarise the days of one phone. Days that have not begun are left out. */
export async function dailySummary(reads: HcReads, request: DailyRequest): Promise<DailyResult> {
  const { days, clock } = request;
  const first = days[0];
  const last = days.at(-1);
  const result: DailyResult = {
    rows: [],
    cuffPulsesExcluded: 0,
    bpDuplicatesDropped: 0,
    duplicatesDropped: 0,
    rulesNotApplied: [],
  };
  if (first === undefined || last === undefined) return result;
  const zone = clock.timeZone;
  const range: Range = {
    startMs: dayBoundsMs(first, zone).startMs,
    endMs: dayBoundsMs(last, zone).endMs,
  };
  const data = await loadDaily(reads, request, range, result);
  for (const day of days) {
    if (dayBoundsMs(day, zone).startMs > request.nowMs) continue;
    result.rows.push(dayRow(day, data, request));
  }
  return result;
}

/** The local days a `daily_summary` call is about. */
export function summaryDays(range: Range, timeZone: string): string[] {
  return daysTouched(range.startMs, range.endMs, timeZone);
}
