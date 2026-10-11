/**
 * `hc_aggregate`'s arithmetic: calendar buckets in a named zone, filled from
 * the store's rollups, with the question of "whose numbers" answered out loud.
 *
 * Several apps write the same thing to one Health Connect store -- a phone and
 * a watch both count steps -- so adding every record up counts a walk twice.
 * `origin_mode` says what to do about it:
 *
 *  - `hc_priority` (the default). For the types Health Connect itself
 *    aggregates, the phone uploads the platform's own priority-merged hourly
 *    figure as `Agg.<Metric>` records, and a bucket that has them is answered
 *    with them (row `method: "platform"`): the platform's number, not an
 *    imitation of its merge. Where there is none the answer falls back, and
 *    says so. How depends on what the type is:
 *
 *      - a COUNTER (steps, distance, energy, floors: a sensor's running count)
 *        is decided HOUR BY HOUR: in each UTC hour the one origin with the
 *        largest total is taken and the others' records of that hour are
 *        counted as duplicates dropped (`"max_origin"`). The hour is the unit
 *        whatever the bucket size, and the hours are then summed upward, so a
 *        month is the sum of its days and of its hours, and an app that
 *        recorded the first half of a month does not erase the app that
 *        recorded the second. Only records in an hour the chosen origin also
 *        recorded in are ever "dropped";
 *      - a session (sleep, exercise) is answered from the stored session
 *        summaries, grouped by the session rules (`"merged_sessions"`): two
 *        apps writing the same workout are one, two different workouts are
 *        two;
 *      - anything else -- a measurement (heart rate, a weight), or an entry a
 *        person logs (a drink, a meal) -- is every origin merged
 *        (`"all_origins"`), since two readings are two readings.
 *  - `origin:<package>`: that app's records alone (`"origin"`).
 *  - `all_separately`: one row per bucket per origin, nothing merged.
 *
 * A record counts in the bucket its START falls in, whole. Sleep is the one
 * exception: a night counts in the bucket it ENDED in -- the day you woke up
 * -- which is the date `sleep_sessions` and `daily_summary` give it
 * (`bucketing` on the result says which rule applied). For that reason sleep
 * is never answered from the platform's hourly figure, which would split a
 * night at midnight.
 *
 * Artefact rules (`worker/src/hc/rules.ts`) are applied to the types that have
 * one -- implausible heart-rate and speed samples, a weight typed into a
 * profile screen -- unless `excludeArtefacts` is false, and every row says how
 * many values that removed (`artefactsExcluded`). The weight rule needs the
 * Height records beside the weights; when the caller may not read those, the
 * rule is not applied and the result says so (`rulesNotApplied`).
 *
 * Total calories are never gap-filled unless `bmr_fill` asks: the platform
 * pads the hours nothing recorded with basal metabolic rate, which turns "no
 * data" into a plausible number. With `bmr_fill` the padding is done here,
 * visibly, as `bmrFillKcal` on each row.
 *
 * Pure but for the reads it is handed.
 */

import { calendarBuckets } from "../../hc/rollup/day.ts";
import { mergeRollups, rollupFieldsFor } from "../../hc/rollup/hour.ts";
import {
  HR_MAX_PLAUSIBLE_BPM,
  HR_MIN_PLAUSIBLE_BPM,
  PROFILE_ARTEFACT_WINDOW_MS,
  SPEED_MAX_PLAUSIBLE_MPS,
  flagHeartRateArtefacts,
  flagSpeedArtefacts,
  flagWeightArtefacts,
} from "../../hc/rules.ts";
import { recordStartMs } from "../../hc/wire.ts";

import { readParts } from "./parts.ts";
import { PLATFORM_AGGREGATED_TYPES, platformAggregateType } from "./policy.ts";
import { groupSessions } from "./sessions.ts";
import { DAY_MS, HOUR_MS } from "./time.ts";
import { compareText, fileUnder, listOf, mapUnder, sortedBy, sortedText } from "./util.ts";

import type { ExcludedValues, PartCleaner, PartSource, StatsPart } from "./parts.ts";
import type { HcReads } from "./reads.ts";
import type { Spanned, Stored } from "./sessions.ts";
import type { Range, ZoneClock } from "./time.ts";
import type { CalendarBucket, CalendarBucketSpan } from "../../hc/rollup/day.ts";
import type { BucketRollup, FieldStats } from "../../hc/rollup/types.ts";

const TYPE_SLEEP = "SleepSession";
const TYPE_EXERCISE = "ExerciseSession";
const TYPE_HEIGHT = "Height";

/** Types whose natural figure is how long they ran, not a field. */
const DURATION_TYPES: ReadonlySet<string> = new Set([TYPE_EXERCISE, TYPE_SLEEP]);

/**
 * Types a person logs entry by entry. Their values add up, but two apps'
 * entries are two entries: a drink logged in one app and a coffee in another
 * are not one drink counted twice.
 */
const ENTRY_TYPES: ReadonlySet<string> = new Set(["Hydration", "Nutrition"]);

/**
 * Types whose values add up over time. Everything else is a measurement.
 */
const CUMULATIVE_TYPES: ReadonlySet<string> = new Set([
  ...PLATFORM_AGGREGATED_TYPES,
  "TotalCaloriesBurned",
  "Nutrition",
]);

export const TYPE_TOTAL_CALORIES = "TotalCaloriesBurned";
export const TYPE_BMR = "BasalMetabolicRate";

/** The stable codes of the rules an answer could not apply. */
const WEIGHT_RULE_NOT_APPLIED = "weight_artefact_rule_not_applied";

function isCumulative(type: string): boolean {
  return CUMULATIVE_TYPES.has(type);
}

/**
 * True for a sensor's running count: the cumulative types where two origins
 * recording the same hour is the same activity counted twice.
 */
export function isCounter(type: string): boolean {
  return CUMULATIVE_TYPES.has(type) && !DURATION_TYPES.has(type) && !ENTRY_TYPES.has(type);
}

const FIELD_METRICS = ["sum", "mean", "min", "max", "n", "first", "last"] as const;
const ROW_METRICS = ["records", "duration"] as const;
export const METRICS = [...FIELD_METRICS, ...ROW_METRICS] as const;
type FieldMetric = (typeof FIELD_METRICS)[number];
export type Metric = (typeof METRICS)[number];

const FIELD_METRIC_SET: ReadonlySet<string> = new Set(FIELD_METRICS);

/** What a type is aggregated by when the caller names no metric. */
export function defaultMetrics(type: string): Metric[] {
  if (DURATION_TYPES.has(type)) return ["duration", "records"];
  return isCumulative(type) ? ["sum"] : ["mean", "min", "max", "n"];
}

export type OriginMode =
  { kind: "hc_priority" } | { kind: "origin"; origin: string } | { kind: "all_separately" };

const ORIGIN_PREFIX = "origin:";

/** `hc_priority`, `all_separately` or `origin:<package>`; null for anything else. */
export function parseOriginMode(text: string): OriginMode | null {
  if (text === "hc_priority" || text === "all_separately") return { kind: text };
  const origin = text.startsWith(ORIGIN_PREFIX) ? text.slice(ORIGIN_PREFIX.length) : "";
  return origin === "" ? null : { kind: "origin", origin };
}

/** How one row's numbers were arrived at. See the module comment. */
type RowMethod =
  | "platform"
  | "platform_and_max_origin"
  | "platform_and_all_origins"
  | "max_origin"
  | "all_origins"
  | "merged_sessions"
  | "origin";

/** Which level of the store answered: a rollup, raw records, or the session summaries. */
type AnswerSource = PartSource | "session_summary";

export interface AggregateRow {
  /** The bucket's label: a date, a month, a year, or a local ISO instant. */
  bucket: string;
  start: string;
  end: string;
  /** False for a bucket nothing was recorded in: its numbers are the fill. */
  hasData: boolean;
  /** Present and true when the requested range (or `exclude_future`) cut the bucket short. */
  partial?: true;
  /** Absent on an empty bucket. */
  method?: RowMethod;
  /** The apps whose records the numbers are. */
  origins: string[];
  records?: number | null;
  durationMs?: number | null;
  /** Per field of the type, the metrics asked for. */
  values: Record<string, Partial<Record<FieldMetric, number | null>>>;
  /**
   * Records left out of this bucket as another origin's copy: a counter's
   * records in an hour a larger origin also recorded, or a session that
   * overlaps one already counted.
   */
  duplicatesDropped?: number;
  /** Values an artefact rule took out of this bucket's numbers. Absent when none. */
  artefactsExcluded?: number;
  /** kcal added by `bmr_fill` for the part of the bucket nothing recorded. */
  bmrFillKcal?: number;
}

export interface AggregateRequest {
  deviceId: string;
  type: string;
  range: Range;
  bucket: CalendarBucket;
  mode: OriginMode;
  metrics: readonly Metric[];
  fill: "zero" | "null";
  /** True drops everything after `nowMs`: no future bucket, no future record. */
  excludeFuture: boolean;
  nowMs: number;
  clock: ZoneClock;
  /** The answer's zone is the configured one and nothing is waiting to be rebuilt. */
  dayRollupsUsable: boolean;
  /** kcal/day to pad unrecorded time with, `TotalCaloriesBurned` only; null for no fill. */
  bmrKcalPerDay: number | null;
  /**
   * False keeps every value, artefacts included. Omitted or true applies the
   * artefact rule of a type that has one, and counts what it removed.
   */
  excludeArtefacts?: boolean | undefined;
  /**
   * Whether the exposure policy lets this call read a record type. Asked
   * before another type is read as context for a rule (Height for the weight
   * rule) or a flag derived from one is used (left-running, off heart rate
   * and steps). Omitted: no context type is readable, so no such rule is
   * applied -- the safe answer for a caller that has not asked the policy.
   */
  allowed?: ((type: string) => boolean) | undefined;
}

export interface AggregateResult {
  rows: AggregateRow[];
  /** Which levels of the store answered. */
  sources: AnswerSource[];
  duplicatesDropped: number;
  /** Values the type's artefact rule took out, over every row. */
  artefactsExcluded: number;
  /** Stable codes of artefact rules that could not be applied (context type not readable). */
  rulesNotApplied: string[];
  /** Which instant of a record decides its bucket: its end for sleep, else its start. */
  bucketing: "start_time" | "end_time";
  /** True when at least one bucket was answered with the platform's own aggregate. */
  usedPlatform: boolean;
  /** True when at least one bucket fell back from the platform aggregate. */
  usedFallback: boolean;
}

const CALENDAR_UNITS: ReadonlySet<string> = new Set(["day", "week", "month", "year"]);

/** The buckets of a range, each clipped to it. */
interface ClippedSpan extends CalendarBucketSpan {
  /** The part of the bucket inside the range. */
  fromMs: number;
  toMs: number;
}

function clippedSpans(range: Range, bucket: CalendarBucket, timeZone: string): ClippedSpan[] {
  return calendarBuckets(range.startMs, range.endMs, bucket, timeZone).map((span) => ({
    ...span,
    fromMs: Math.max(span.startMs, range.startMs),
    toMs: Math.min(span.endMs, range.endMs),
  }));
}

/** Index of the span holding `ms`, or -1. Spans are in order and do not overlap. */
function spanIndex(spans: readonly ClippedSpan[], ms: number): number {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const span = spans[middle];
    if (span === undefined) return -1;
    if (ms < span.fromMs) high = middle - 1;
    else if (ms >= span.toMs) low = middle + 1;
    else return middle;
  }
  return -1;
}

type Grouped = Map<number, Map<string, BucketRollup>>;

/** Parts in a fixed order, so that merging them is the same whatever order they were read in. */
function inOrder(parts: readonly StatsPart[]): StatsPart[] {
  return sortedBy(
    parts,
    (left, right) => left.startMs - right.startMs || compareText(left.origin, right.origin),
  );
}

/** Parts grouped by bucket, then by origin, each group merged to one rollup. */
function byBucketAndOrigin(spans: readonly ClippedSpan[], parts: readonly StatsPart[]): Grouped {
  const grouped = new Map<number, Map<string, BucketRollup[]>>();
  for (const part of inOrder(parts)) {
    const index = spanIndex(spans, part.startMs);
    if (index === -1) continue;
    fileUnder(mapUnder(grouped, index), part.origin, part.rollup);
  }
  const merged: Grouped = new Map();
  for (const [index, origins] of grouped) {
    const out = new Map<string, BucketRollup>();
    for (const [origin, rollups] of origins) {
      const rollup = mergeRollups(rollups);
      // A rollup row can outlive its last record for a moment; it is not data.
      if (rollup.records > 0) out.set(origin, rollup);
    }
    if (out.size > 0) merged.set(index, out);
  }
  return merged;
}

/**
 * What an origin's hour weighs when choosing between origins: the sum of the
 * type's primary field (steps counted, metres, kcal), or its record count for
 * a type without one.
 */
function weight(type: string, rollup: BucketRollup): number {
  const primary = rollupFieldsFor(type)[0]?.name;
  const stats = primary === undefined ? undefined : rollup.fields[primary];
  return stats?.sum ?? rollup.records;
}

function fieldValues(
  type: string,
  rollup: BucketRollup | null,
  metrics: readonly Metric[],
  fill: "zero" | "null",
): AggregateRow["values"] {
  const wanted = metrics.filter((metric): metric is FieldMetric => FIELD_METRIC_SET.has(metric));
  const names = new Set([
    ...rollupFieldsFor(type).map((field) => field.name),
    ...Object.keys(rollup?.fields ?? {}),
  ]);
  const out: [string, Partial<Record<FieldMetric, number | null>>][] = [];
  for (const name of names) {
    const stats: FieldStats | undefined = rollup?.fields[name];
    out.push([
      name,
      Object.fromEntries(
        wanted.map((metric) => [
          metric,
          stats === undefined ? emptyMetric(metric, fill) : stats[metric],
        ]),
      ),
    ]);
  }
  return Object.fromEntries(out);
}

/**
 * What a metric is in a bucket nothing was recorded in. A zero is only honest
 * for the metrics that count: an empty bucket has no mean, and no lowest or
 * highest value.
 */
function emptyMetric(metric: FieldMetric, fill: "zero" | "null"): number | null {
  return fill === "zero" && (metric === "sum" || metric === "n") ? 0 : null;
}

interface RowInput {
  span: ClippedSpan;
  rollup: BucketRollup | null;
  origins: string[];
  method?: RowMethod;
  duplicatesDropped?: number;
  /**
   * The origins whose excluded artefacts this row answers for. Omitted: every
   * origin's in the bucket.
   */
  excludedFor?: readonly string[];
}

/** One `aggregate()` call's working state, shared by every path through it. */
interface Run {
  reads: HcReads;
  request: AggregateRequest;
  range: Range;
  spans: ClippedSpan[];
  sources: Set<AnswerSource>;
  rows: AggregateRow[];
  /** Index-aligned with `rows`: the time each row's interval records cover. */
  recordedMs: number[];
  duplicatesDropped: number;
  artefactsExcluded: number;
  rulesNotApplied: Set<string>;
  usedPlatform: boolean;
  usedFallback: boolean;
  /** What the artefact rule took out, by record: read twice, counted once. */
  excluded: Map<string, ExcludedValues>;
  /**
   * One type's parts. With `window` they are read hour by hour inside it (no
   * day rollup), so each can be told apart by its UTC hour.
   */
  parts: (
    type: string,
    options?: { origins?: readonly string[]; window?: Range },
  ) => Promise<StatsPart[]>;
  push: (input: RowInput) => AggregateRow;
}

function buildRow(run: Run, input: RowInput): AggregateRow {
  const { span, rollup } = input;
  const { type, metrics, fill, clock } = run.request;
  const partial = span.fromMs > span.startMs || span.toMs < span.endMs;
  const emptyCount = fill === "zero" ? 0 : null;
  let excluded = 0;
  for (const entry of run.excluded.values()) {
    if (entry.startMs < span.fromMs || entry.startMs >= span.toMs) continue;
    if (input.excludedFor === undefined || input.excludedFor.includes(entry.origin)) {
      excluded += entry.count;
    }
  }
  const dropped = input.duplicatesDropped ?? 0;
  return {
    bucket: span.label,
    start: clock.iso(span.fromMs),
    end: clock.iso(span.toMs),
    hasData: rollup !== null,
    ...(partial && { partial: true as const }),
    ...(input.method !== undefined && { method: input.method }),
    origins: input.origins,
    ...(metrics.includes("records") && { records: rollup?.records ?? emptyCount }),
    ...(metrics.includes("duration") && {
      durationMs: rollup === null ? emptyCount : (rollup.durationMs ?? 0),
    }),
    values: fieldValues(type, rollup, metrics, fill),
    ...(dropped > 0 && { duplicatesDropped: dropped }),
    ...(excluded > 0 && { artefactsExcluded: excluded }),
  };
}

/** The artefact rule of a type with dense samples, by the rollup field that gives it away. */
function seriesCleaner(type: string): PartCleaner | undefined {
  if (type === "HeartRate") {
    return {
      suspect: ({ rollup }) => {
        const stats = rollup.fields.bpm;
        return (
          stats !== undefined &&
          (stats.max > HR_MAX_PLAUSIBLE_BPM || stats.min < HR_MIN_PLAUSIBLE_BPM)
        );
      },
      apply: flagHeartRateArtefacts,
    };
  }
  if (type === "Speed") {
    return {
      suspect: ({ rollup }) => (rollup.fields.speed?.max ?? 0) > SPEED_MAX_PLAUSIBLE_MPS,
      apply: flagSpeedArtefacts,
    };
  }
  return undefined;
}

/**
 * The artefact rule this call applies to its type, if any. The weight rule
 * needs the Height records around the range, and is only built when the call
 * may read them; when it may not, the rule is recorded as not applied.
 */
async function cleanerFor(
  reads: HcReads,
  request: AggregateRequest,
  range: Range,
  notApplied: Set<string>,
): Promise<PartCleaner | undefined> {
  const { type, deviceId } = request;
  if (request.excludeArtefacts === false) return undefined;
  if (type !== "Weight") return seriesCleaner(type);
  if (request.allowed?.(TYPE_HEIGHT) !== true) {
    notApplied.add(WEIGHT_RULE_NOT_APPLIED);
    return undefined;
  }
  const height = await reads.records({
    deviceId,
    type: TYPE_HEIGHT,
    startMs: range.startMs - PROFILE_ARTEFACT_WINDOW_MS,
    endMs: range.endMs + PROFILE_ARTEFACT_WINDOW_MS,
  });
  // No height anywhere near: nothing can be flagged, and nothing need be opened.
  if (height.length === 0) return undefined;
  const times = height.map((record) => ({ origin: record.origin, t: recordStartMs(record) }));
  return {
    suspect: (part) =>
      times.some(
        ({ origin, t }) =>
          origin === part.origin &&
          t >= part.startMs - PROFILE_ARTEFACT_WINDOW_MS &&
          t <= part.endMs + PROFILE_ARTEFACT_WINDOW_MS,
      ),
    apply: (records) => flagWeightArtefacts(records, { height }),
  };
}

async function startRun(reads: HcReads, request: AggregateRequest): Promise<Run> {
  const { clock } = request;
  const range: Range = request.excludeFuture
    ? { startMs: request.range.startMs, endMs: Math.min(request.range.endMs, request.nowMs) }
    : request.range;
  const spans = clippedSpans(range, request.bucket, clock.timeZone);
  const boundaries: number[] = Array.from(spans, (span) => span.fromMs);
  const lastSpan = spans.at(-1);
  if (lastSpan !== undefined) boundaries.push(lastSpan.toMs);
  const dayRollupZone =
    request.dayRollupsUsable && CALENDAR_UNITS.has(request.bucket) ? clock.timeZone : null;
  const rulesNotApplied = new Set<string>();
  const cleaner = DURATION_TYPES.has(request.type)
    ? undefined
    : await cleanerFor(reads, request, range, rulesNotApplied);
  const run: Run = {
    reads,
    request,
    range,
    spans,
    sources: new Set(),
    rows: [],
    recordedMs: [],
    duplicatesDropped: 0,
    artefactsExcluded: 0,
    rulesNotApplied,
    usedPlatform: false,
    usedFallback: false,
    excluded: new Map(),
    parts: async (type, options = {}) => {
      const result = await readParts(reads, {
        deviceId: request.deviceId,
        type,
        range: options.window ?? range,
        boundaries,
        dayRollupZone: options.window === undefined ? dayRollupZone : null,
        origins: options.origins,
        cleaner: type === request.type ? cleaner : undefined,
      });
      for (const source of result.sources) run.sources.add(source);
      for (const entry of result.excluded) {
        run.excluded.set(`${entry.origin}|${String(entry.startMs)}`, entry);
      }
      // A rollup row can outlive its last record for a moment; it is not data.
      return result.parts.filter((part) => part.rollup.records > 0);
    },
    push: (input) => {
      const row = buildRow(run, input);
      run.rows.push(row);
      run.recordedMs.push(input.rollup?.durationMs ?? 0);
      run.duplicatesDropped += row.duplicatesDropped ?? 0;
      run.artefactsExcluded += row.artefactsExcluded ?? 0;
      return row;
    },
  };
  return run;
}

async function aggregateOneOrigin(run: Run, origin: string): Promise<void> {
  const own = byBucketAndOrigin(
    run.spans,
    await run.parts(run.request.type, { origins: [origin] }),
  );
  for (const [index, span] of run.spans.entries()) {
    const rollup = own.get(index)?.get(origin) ?? null;
    run.push({
      span,
      rollup,
      origins: rollup === null ? [] : [origin],
      excludedFor: [origin],
      ...(rollup !== null && { method: "origin" as const }),
    });
  }
}

/** One row per bucket per origin from per-bucket, per-origin rollups. */
function pushSeparately(run: Run, all: Grouped): void {
  const names = new Set<string>();
  for (const origins of all.values()) for (const origin of origins.keys()) names.add(origin);
  const ordered = sortedText(names);
  for (const [index, span] of run.spans.entries()) {
    if (ordered.length === 0) run.push({ span, rollup: null, origins: [] });
    for (const origin of ordered) {
      const rollup = all.get(index)?.get(origin) ?? null;
      run.push({
        span,
        rollup,
        origins: [origin],
        excludedFor: [origin],
        ...(rollup !== null && { method: "origin" as const }),
      });
    }
  }
}

async function aggregateSeparately(run: Run): Promise<void> {
  pushSeparately(run, byBucketAndOrigin(run.spans, await run.parts(run.request.type)));
}

const hourOf = (ms: number): number => Math.floor(ms / HOUR_MS);

/**
 * A counter's parts with one origin chosen per UTC hour: `kept` is the chosen
 * origin's parts, `dropped` everyone else's in an hour that origin recorded
 * in. Ties go to the lower origin name, so the choice is the same everywhere.
 *
 * Every part must lie inside one UTC hour (an hour rollup, or a raw record).
 */
function chooseByHour(
  type: string,
  parts: readonly StatsPart[],
): { kept: StatsPart[]; dropped: StatsPart[] } {
  const hours = new Map<number, Map<string, StatsPart[]>>();
  for (const part of inOrder(parts))
    fileUnder(mapUnder(hours, hourOf(part.startMs)), part.origin, part);
  const kept: StatsPart[] = [];
  const dropped: StatsPart[] = [];
  for (const origins of hours.values()) {
    let best: { origin: string; weight: number } | null = null;
    const names = sortedText(origins.keys());
    for (const origin of names) {
      const own = origins.get(origin) ?? [];
      let total = 0;
      for (const part of own) total += weight(type, part.rollup);
      if (best === null || total > best.weight) best = { origin, weight: total };
    }
    for (const [origin, own] of origins) (origin === best?.origin ? kept : dropped).push(...own);
  }
  return { kept, dropped };
}

/** Runs of adjacent stretches, merged. */
function mergedRanges(ranges: readonly Range[]): Range[] {
  const out: Range[] = [];
  const ordered = sortedBy(ranges, (left, right) => left.startMs - right.startMs);
  for (const range of ordered) {
    const last = out.at(-1);
    if (last !== undefined && last.endMs >= range.startMs) {
      last.endMs = Math.max(last.endMs, range.endMs);
    } else {
      out.push({ ...range });
    }
  }
  return out;
}

/**
 * The days of a coarse read that have to be opened hour by hour before an
 * origin can be chosen per hour.
 *
 * A day only one origin recorded in holds no choice, and its day rollup is
 * final -- which is what keeps a multi-year answer on day rollups. A day two
 * origins recorded in is opened. In a zone whose days do not begin on a UTC
 * hour, a UTC hour can straddle two days, so one day cannot be judged alone:
 * there, every day is opened as soon as the range holds two origins at all.
 */
function daysToOpen(parts: readonly StatsPart[]): Range[] {
  const days = new Map<number, { endMs: number; origins: Set<string> }>();
  const everyOrigin = new Set<string>();
  let aligned = true;
  for (const part of parts) {
    everyOrigin.add(part.origin);
    if (part.source !== "day_rollup") continue;
    aligned &&= part.startMs % HOUR_MS === 0 && part.endMs % HOUR_MS === 0;
    const day = days.get(part.startMs);
    if (day === undefined)
      days.set(part.startMs, { endMs: part.endMs, origins: new Set([part.origin]) });
    else day.origins.add(part.origin);
  }
  const open: Range[] = [];
  for (const [startMs, day] of days) {
    if ((aligned ? day.origins.size : everyOrigin.size) > 1)
      open.push({ startMs, endMs: day.endMs });
  }
  return mergedRanges(open);
}

interface BucketChoice {
  parts: StatsPart[];
  dropped: number;
}

/**
 * A counter under `hc_priority` without the platform's figure, for the whole
 * range: one origin per UTC hour, summed into buckets. See the module comment.
 */
async function hourlyFallback(
  run: Run,
  coarse: readonly StatsPart[],
): Promise<Map<number, BucketChoice>> {
  const { type } = run.request;
  const open = daysToOpen(coarse);
  const opened = (part: StatsPart): boolean =>
    part.source === "day_rollup" &&
    open.some((range) => part.startMs >= range.startMs && part.startMs < range.endMs);
  const settled: StatsPart[] = [];
  const hourly: StatsPart[] = [];
  for (const part of coarse) {
    if (opened(part)) continue;
    (part.source === "day_rollup" ? settled : hourly).push(part);
  }
  for (const window of open) hourly.push(...(await run.parts(type, { window })));

  const { kept, dropped } = chooseByHour(type, hourly);
  const out = new Map<number, BucketChoice>();
  const choice = (ms: number): BucketChoice | null => {
    const index = spanIndex(run.spans, ms);
    if (index === -1) return null;
    let entry = out.get(index);
    if (entry === undefined) {
      entry = { parts: [], dropped: 0 };
      out.set(index, entry);
    }
    return entry;
  };
  for (const part of [...settled, ...kept]) choice(part.startMs)?.parts.push(part);
  for (const part of dropped) {
    const entry = choice(part.startMs);
    if (entry !== null) entry.dropped += part.rollup.records;
  }
  return out;
}

/** A bucket from the parts chosen for it. */
function chosenInput(span: ClippedSpan, choice: BucketChoice | undefined): RowInput {
  if (choice === undefined || choice.parts.length === 0) {
    return { span, rollup: null, origins: [], duplicatesDropped: choice?.dropped ?? 0 };
  }
  const parts = inOrder(choice.parts);
  return {
    span,
    rollup: mergeRollups(parts.map((part) => part.rollup)),
    origins: sortedText(new Set(parts.map((part) => part.origin))),
    method: "max_origin",
    duplicatesDropped: choice.dropped,
  };
}

/** A bucket as every origin merged: a measurement, or a logged entry. */
function allOriginsInput(
  span: ClippedSpan,
  origins: Map<string, BucketRollup> | undefined,
): RowInput {
  if (origins === undefined) return { span, rollup: null, origins: [] };
  const entries = sortedBy(origins, ([left], [right]) => compareText(left, right));
  return {
    span,
    rollup: mergeRollups(entries.map(([, rollup]) => rollup)),
    origins: entries.map(([origin]) => origin),
    method: "all_origins",
  };
}

/**
 * The platform's hourly aggregate as a rollup of the type it stands for: its
 * one `value` is the type's primary field's sum, or a session type's duration.
 */
function fromPlatform(type: string, hours: readonly BucketRollup[]): BucketRollup {
  const merged = mergeRollups(hours);
  const value = merged.fields.value;
  if (DURATION_TYPES.has(type)) {
    return { records: merged.records, fields: {}, durationMs: value?.sum ?? 0 };
  }
  const primary = rollupFieldsFor(type)[0]?.name ?? "value";
  return { records: merged.records, fields: value === undefined ? {} : { [primary]: value } };
}

/** The metrics the platform's hourly figure can answer for a field type. */
function platformCanAnswer(metrics: readonly Metric[]): boolean {
  return metrics.every((metric) => metric === "sum");
}

/**
 * True when every hour of the range falls wholly inside one bucket, so an
 * hourly platform figure is never split between two.
 */
function hourAligned(range: Range, spans: readonly ClippedSpan[]): boolean {
  return range.startMs % HOUR_MS === 0 && spans.every((span) => span.fromMs % HOUR_MS === 0);
}

/**
 * True when the platform's hours in a bucket span every record of the type
 * there, so the platform's total is the bucket's total.
 *
 * It is not when the phone has uploaded the platform's figure for only part of
 * the bucket -- the day it was paired, or a day still being backfilled -- and
 * taking the platform's number alone would then report a short day. Judged by
 * the first and last instants each side holds, which a rollup carries.
 */
function platformCovers(
  platform: ReadonlyMap<string, BucketRollup>,
  own: ReadonlyMap<string, BucketRollup> | undefined,
): boolean {
  if (own === undefined) return true;
  const hours = mergeRollups(listOf(platform.values())).fields.value;
  if (hours === undefined) return false;
  for (const rollup of own.values()) {
    for (const stats of Object.values(rollup.fields)) {
      if (stats.firstMs < hours.firstMs || stats.lastMs >= hours.lastMs + HOUR_MS) return false;
    }
  }
  return own.size > 0;
}

/** One bucket the platform covers only partly: hour by hour, the platform's figure or the fallback. */
async function mixedInput(run: Run, platformType: string, span: ClippedSpan): Promise<RowInput> {
  const { type } = run.request;
  const window: Range = { startMs: span.fromMs, endMs: span.toMs };
  const platform = new Map<number, StatsPart[]>();
  const platformHours = await run.parts(platformType, { window });
  for (const part of platformHours) fileUnder(platform, hourOf(part.startMs), part);
  const counter = isCounter(type);
  const own = await run.parts(type, { window });
  const choice = counter ? chooseByHour(type, own) : { kept: own, dropped: [] };
  const elsewhere = (part: StatsPart): boolean => !platform.has(hourOf(part.startMs));

  const fallback = inOrder(choice.kept.filter((part) => elsewhere(part)));
  const pieces: BucketRollup[] = [];
  const origins = new Set<string>();
  for (const hour of platform.values()) {
    pieces.push(
      fromPlatform(
        type,
        hour.map((part) => part.rollup),
      ),
    );
    for (const part of hour) origins.add(part.origin);
  }
  for (const part of fallback) {
    pieces.push(part.rollup);
    origins.add(part.origin);
  }
  let dropped = 0;
  for (const part of choice.dropped) if (elsewhere(part)) dropped += part.rollup.records;
  const mixed = counter ? "platform_and_max_origin" : "platform_and_all_origins";
  return {
    span,
    rollup: mergeRollups(pieces),
    origins: sortedText(origins),
    method: fallback.length > 0 ? mixed : "platform",
    duplicatesDropped: dropped,
  };
}

async function aggregateByPriority(run: Run): Promise<void> {
  const { type, metrics } = run.request;
  const platformType = platformAggregateType(type);
  const usePlatform =
    platformType !== null && platformCanAnswer(metrics) && hourAligned(run.range, run.spans);
  const platform: Grouped = usePlatform
    ? byBucketAndOrigin(run.spans, await run.parts(platformType))
    : new Map<number, Map<string, BucketRollup>>();
  const coarse = await run.parts(type);
  const own = byBucketAndOrigin(run.spans, coarse);
  // Only the buckets the platform says nothing about fall back, so only their
  // parts are opened hour by hour: three years of a watch and a phone both
  // counting steps, with the platform's figure throughout, stays on day
  // rollups. (The platform is only used when every bucket begins on a UTC
  // hour, so no hour is shared between a bucket that falls back and one that
  // does not.)
  const unanswered = coarse.filter((part) => !platform.has(spanIndex(run.spans, part.startMs)));
  const chosen = isCounter(type) ? await hourlyFallback(run, unanswered) : null;
  const fallback = (index: number, span: ClippedSpan): RowInput =>
    chosen === null ? allOriginsInput(span, own.get(index)) : chosenInput(span, chosen.get(index));
  for (const [index, span] of run.spans.entries()) {
    const fromHc = platform.get(index);
    if (platformType === null || fromHc === undefined) {
      const row = run.push(fallback(index, span));
      run.usedFallback ||= platformType !== null && row.hasData;
      continue;
    }
    run.usedPlatform = true;
    const input = platformCovers(fromHc, own.get(index))
      ? platformInput(type, span, fromHc)
      : await mixedInput(run, platformType, span);
    run.usedFallback ||= run.push(input).method !== "platform";
  }
}

/** A bucket answered wholly with the platform's own figure. */
function platformInput(
  type: string,
  span: ClippedSpan,
  platform: ReadonlyMap<string, BucketRollup>,
): RowInput {
  const hours = listOf(platform.values());
  return {
    span,
    rollup: fromPlatform(type, hours),
    origins: sortedText(platform.keys()),
    method: "platform",
  };
}

/** One stored session, as far as an aggregate reads it. */
type Session = Stored<Spanned>;

/** The stored summaries of the run's session type with anything in the range. */
async function readSessions(run: Run): Promise<Session[]> {
  const { deviceId, type } = run.request;
  const window = { deviceId, startMs: run.range.startMs, endMs: run.range.endMs };
  if (window.endMs <= window.startMs) return [];
  let sessions: Session[];
  if (type === TYPE_SLEEP) {
    const nights = await run.reads.sleepNights(window);
    sessions = nights.map(({ id, night }) => ({
      id,
      summary: { origin: night.origin, startMs: night.startMs, endMs: night.endMs },
    }));
  } else {
    const stored = await run.reads.exerciseSessions(window);
    sessions = stored.map(({ id, session }) => ({
      id,
      summary: {
        origin: session.origin,
        startMs: session.startMs,
        endMs: session.endMs,
        exerciseType: session.exerciseType,
        likelyLeftRunning: session.likelyLeftRunning,
      },
    }));
  }
  if (sessions.length > 0) run.sources.add("session_summary");
  return sessions;
}

/** The instant that files a session in a bucket: a night's end, a workout's start. */
function sessionAnchor(type: string, session: Spanned): number {
  return type === TYPE_SLEEP ? session.endMs : session.startMs;
}

/** Sessions as per-bucket, per-origin rollups: how many, and how long they ran. */
function sessionsByOrigin(run: Run, sessions: readonly Session[]): Grouped {
  const { type } = run.request;
  const out: Grouped = new Map();
  for (const { summary } of sessions) {
    const index = spanIndex(run.spans, sessionAnchor(type, summary));
    if (index === -1) continue;
    const origins = mapUnder(out, index);
    const current = origins.get(summary.origin) ?? { records: 0, fields: {}, durationMs: 0 };
    origins.set(summary.origin, {
      records: current.records + 1,
      fields: {},
      durationMs: (current.durationMs ?? 0) + (summary.endMs - summary.startMs),
    });
  }
  return out;
}

/** What the session rules make of one bucket: stretches, their length, and who wrote them. */
interface SessionBucket {
  groups: number;
  durationMs: number;
  dropped: number;
  origins: Set<string>;
  /** The earliest start and latest end of the bucket's stretches. */
  firstMs: number;
  lastMs: number;
}

/** Sessions grouped by the session rules, each group filed where its longest session is. */
function sessionsMerged(run: Run, sessions: readonly Session[]): Map<number, SessionBucket> {
  const { type, allowed } = run.request;
  // The left-running flag is read off heart rate and steps: it only shapes the
  // grouping for a call that may see both.
  const flagReadable = allowed?.("HeartRate") === true && allowed("Steps");
  const out = new Map<number, SessionBucket>();
  for (const group of groupSessions(type, sessions, flagReadable)) {
    const index = spanIndex(run.spans, sessionAnchor(type, group.primary.summary));
    if (index === -1) continue;
    let bucket = out.get(index);
    if (bucket === undefined) {
      bucket = {
        groups: 0,
        durationMs: 0,
        dropped: 0,
        origins: new Set(),
        firstMs: Infinity,
        lastMs: -Infinity,
      };
      out.set(index, bucket);
    }
    bucket.groups += 1;
    bucket.durationMs += group.merged.endMs - group.merged.startMs;
    bucket.dropped += group.members.length - 1;
    bucket.firstMs = Math.min(bucket.firstMs, group.merged.startMs);
    bucket.lastMs = Math.max(bucket.lastMs, group.merged.endMs);
    for (const member of group.members) bucket.origins.add(member.summary.origin);
  }
  return out;
}

/**
 * Exercise time per bucket from the platform's hourly figure, where the phone
 * uploaded one. Sleep is never asked for: see the module comment.
 */
async function platformDurations(run: Run): Promise<Grouped> {
  const { type, metrics } = run.request;
  const platformType = type === TYPE_EXERCISE ? platformAggregateType(type) : null;
  return platformType === null ||
    !metrics.includes("duration") ||
    !hourAligned(run.range, run.spans)
    ? new Map()
    : byBucketAndOrigin(run.spans, await run.parts(platformType));
}

/**
 * A session type under `hc_priority`: how many stretches from the stored
 * summaries, and how long from the platform's figure where its hours span
 * every stretch of the bucket, else from the stretches themselves.
 */
async function aggregateSessionsByPriority(run: Run, sessions: readonly Session[]): Promise<void> {
  const { type } = run.request;
  const merged = sessionsMerged(run, sessions);
  const platform = await platformDurations(run);
  for (const [index, span] of run.spans.entries()) {
    const stored = merged.get(index);
    const fromHc = platform.get(index);
    const hours = fromHc === undefined ? undefined : mergeRollups(listOf(fromHc.values()));
    const value = hours?.fields.value;
    const covers =
      value !== undefined &&
      (stored === undefined ||
        (stored.firstMs >= value.firstMs && stored.lastMs <= value.lastMs + HOUR_MS));
    if (fromHc !== undefined && hours !== undefined && covers) {
      run.usedPlatform = true;
      run.push({
        span,
        rollup: { ...fromPlatform(type, [hours]), records: stored?.groups ?? 0 },
        origins: sortedText(fromHc.keys()),
        method: "platform",
        duplicatesDropped: stored?.dropped ?? 0,
      });
      continue;
    }
    if (stored === undefined) {
      run.push({ span, rollup: null, origins: [] });
      continue;
    }
    // Only exercise has a platform figure to fall back from.
    if (type === TYPE_EXERCISE) run.usedFallback = true;
    run.push({
      span,
      rollup: { records: stored.groups, fields: {}, durationMs: stored.durationMs },
      origins: sortedText(stored.origins),
      method: "merged_sessions",
      duplicatesDropped: stored.dropped,
    });
  }
}

async function aggregateSessions(run: Run): Promise<void> {
  const { mode } = run.request;
  const sessions = await readSessions(run);
  if (mode.kind === "hc_priority") {
    await aggregateSessionsByPriority(run, sessions);
    return;
  }
  if (mode.kind === "all_separately") {
    pushSeparately(run, sessionsByOrigin(run, sessions));
    return;
  }
  const own = sessionsByOrigin(
    run,
    sessions.filter(({ summary }) => summary.origin === mode.origin),
  );
  for (const [index, span] of run.spans.entries()) {
    const rollup = own.get(index)?.get(mode.origin) ?? null;
    run.push({
      span,
      rollup,
      origins: rollup === null ? [] : [mode.origin],
      ...(rollup !== null && { method: "origin" as const }),
    });
  }
}

/** Aggregate one type on one phone. */
export async function aggregate(
  reads: HcReads,
  request: AggregateRequest,
): Promise<AggregateResult> {
  const { mode, type } = request;
  const run = await startRun(reads, request);
  if (DURATION_TYPES.has(type)) await aggregateSessions(run);
  else if (mode.kind === "origin") await aggregateOneOrigin(run, mode.origin);
  else if (mode.kind === "all_separately") await aggregateSeparately(run);
  else await aggregateByPriority(run);

  if (type === TYPE_TOTAL_CALORIES && request.bmrKcalPerDay !== null) {
    applyBmrFill(run.rows, run.recordedMs, request.bmrKcalPerDay, mode.kind === "all_separately");
  }
  return {
    rows: run.rows,
    sources: listOf(run.sources),
    duplicatesDropped: run.duplicatesDropped,
    artefactsExcluded: run.artefactsExcluded,
    rulesNotApplied: listOf(run.rulesNotApplied),
    bucketing: type === TYPE_SLEEP ? "end_time" : "start_time",
    usedPlatform: run.usedPlatform,
    usedFallback: run.usedFallback,
  };
}

/**
 * Pad each bucket's unrecorded time with basal metabolic rate. The recorded
 * time is the total length of the bucket's interval records, so a bucket a
 * tracker covered completely gains nothing.
 */
function applyBmrFill(
  rows: AggregateRow[],
  recordedMs: readonly number[],
  bmrKcalPerDay: number,
  separately: boolean,
): void {
  // One row per bucket except under `all_separately`, where padding each
  // origin's row would add the same basal energy once per app.
  if (separately) return;
  for (const [index, row] of rows.entries()) {
    const lengthMs = Date.parse(row.end) - Date.parse(row.start);
    const fill = (bmrKcalPerDay * (lengthMs - Math.min(recordedMs[index] ?? 0, lengthMs))) / DAY_MS;
    if (fill <= 0) continue;
    row.bmrFillKcal = fill;
    const energy = row.values.energy;
    if (energy !== undefined && "sum" in energy) energy.sum = (energy.sum ?? 0) + fill;
  }
}
