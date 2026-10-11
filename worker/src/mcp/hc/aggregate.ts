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
 *    figure as `Agg.<Metric>` records, and a bucket is answered with them (row
 *    `method: "platform"`) when the platform has a figure for EVERY hour of
 *    the bucket in which something was recorded: the platform's number, not an
 *    imitation of its merge. A bucket it has only some of those hours for is
 *    composed hour by hour, the platform's figure where there is one and the
 *    fallback elsewhere (`"platform_and_max_origin"`,
 *    `"platform_and_all_origins"`), which is what makes a day the sum of its
 *    hours whatever the platform is missing. Where there is none the answer
 *    falls back, and says so. How depends on what the type is:
 *
 *      - a COUNTER (steps, distance, energy, floors: a sensor's running count)
 *        is decided HOUR BY HOUR: in each UTC hour one origin is taken and the
 *        others' records of that hour are counted as duplicates dropped
 *        (`"max_origin"`). An origin that recorded something in or around the
 *        hour itself is preferred to one that only has a share of a record
 *        longer than an hour there (a day's total written as one record);
 *        among those preferred the largest total wins. The hour is the unit
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
 * ### Which bucket a record counts in
 *
 * A record counts in the bucket its START falls in. Two exceptions:
 *
 *  - A running count's interval record (`isSpreadType`: steps, distance,
 *    energy, floors, elevation, wheelchair pushes) that runs past the end of
 *    its bucket is DIVIDED: each bucket gets the share of its value that the
 *    time it spends there is of its length, which is how Health Connect's own
 *    aggregation divides one. So a day's total written as one record is a
 *    twenty-fourth in each hour, not all of it at midnight. Only `sum` and
 *    `duration` are divided; `records`, `n`, `mean`, `min`, `max`, `first` and
 *    `last` stay with the bucket the record starts in. What a bucket's total
 *    owes to records longer than an hour is said on the row (`longRecordSum`).
 *    A record longer than two days is not divided at all.
 *  - A night of sleep counts in the bucket it ENDED in -- the day you woke up
 *    -- which is the date `sleep_sessions` and `daily_summary` give it
 *    (`bucketing` on the result says which rule applied). For that reason
 *    sleep is never answered from the platform's hourly figure, which would
 *    split a night at midnight.
 *
 * The stored rollups hold every record whole, where it starts, and list the
 * ones that run past their hour (`BucketRollup.crossing`); the dividing is
 * done here, from those lists, so no chunk is opened for it.
 *
 * Sleep has two lengths: `duration` is time ASLEEP (what Health Connect calls
 * a night's duration) and `in_bed` is the session from start to end.
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
import {
  LONG_RECORD_MS,
  SPREAD_MAX_MS,
  addShares,
  isSpreadType,
  mergeRollups,
  rollupFieldsFor,
} from "../../hc/rollup/hour.ts";
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
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./time.ts";
import { compareText, fileUnder, listOf, mapUnder, sortedBy, sortedText } from "./util.ts";

import type { ExcludedValues, PartCleaner, PartSource, StatsPart } from "./parts.ts";
import type { HcReads } from "./reads.ts";
import type { Spanned, Stored } from "./sessions.ts";
import type { Range, ZoneClock } from "./time.ts";
import type { CalendarBucket, CalendarBucketSpan } from "../../hc/rollup/day.ts";
import type {
  BucketRollup,
  CrossingRecord,
  FieldStats,
  SpreadShare,
} from "../../hc/rollup/types.ts";

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
const ROW_METRICS = ["records", "duration", "in_bed"] as const;
export const METRICS = [...FIELD_METRICS, ...ROW_METRICS] as const;
type FieldMetric = (typeof FIELD_METRICS)[number];
export type Metric = (typeof METRICS)[number];

const FIELD_METRIC_SET: ReadonlySet<string> = new Set(FIELD_METRICS);

/** What a type is aggregated by when the caller names no metric. */
export function defaultMetrics(type: string): Metric[] {
  if (type === TYPE_SLEEP) return ["duration", "in_bed", "records"];
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
  /**
   * How long the bucket's records ran. For sleep, time ASLEEP; the session
   * from start to end is `inBedMs`.
   */
  durationMs?: number | null;
  /** Sleep only, with the `in_bed` metric: the nights' length from start to end. */
  inBedMs?: number | null;
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
  /**
   * Of the bucket's total (the `sum` of the type's first field), what comes
   * from records longer than an hour, divided evenly over their length: a
   * figure written for a long stretch -- a day's total as one record, often
   * an estimate of basal energy -- and not something measured in the bucket.
   * Absent when there is none.
   */
  longRecordSum?: number;
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
  /** Rows whose total includes a share of a record longer than an hour: `longRecordSum`. */
  longRecordRows: number;
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

const hourOf = (ms: number): number => Math.floor(ms / HOUR_MS);

// ---------------------------------------------------------------------------
// Pieces: the store's parts as an answer uses them, a record that runs past
// its bucket divided among the buckets it spans.
// ---------------------------------------------------------------------------

/**
 * One part of an answer. A part read from the store (`share: false`), or the
 * share of a record that falls in one stretch between two boundaries (`share:
 * true`: no record of its own, only `rollup.spread`).
 */
interface Piece extends StatsPart {
  /**
   * False for what a record longer than an hour contributes -- its share of an
   * hour, or a part that holds nothing but such records: see `chooseByHour`.
   */
  fine: boolean;
  share: boolean;
  /**
   * The UTC hours the piece has data in. Null for a day rollup written before
   * rollups said: it has to be read hour by hour to find out.
   */
  hours: readonly number[] | null;
}

/** The UTC hours a part read from the store has records in. */
function hoursOfPart(part: StatsPart): readonly number[] | null {
  // An hour rollup and a raw record are one hour whatever they say.
  return part.source === "day_rollup" ? (part.rollup.hours ?? null) : [hourOf(part.startMs)];
}

/** A part taken as it is: nothing in it runs past its bucket, or its type is not divided. */
function wholePiece(part: StatsPart): Piece {
  return { ...part, fine: part.rollup.records > 0, share: false, hours: hoursOfPart(part) };
}

/** The first bucket boundary or UTC hour boundary after `at`. */
function nextCut(boundaries: readonly number[], at: number): number {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((boundaries[middle] ?? Infinity) <= at) low = middle + 1;
    else high = middle;
  }
  return Math.min(boundaries[low] ?? Infinity, (hourOf(at) + 1) * HOUR_MS);
}

function scaled(values: Readonly<Record<string, number>>, by: number): Record<string, number> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value * by]));
}

/** The records of a part read inside the range that an answer divides. */
function crossersOf(boundaries: readonly number[], part: StatsPart): readonly CrossingRecord[] {
  if (part.source !== "raw") return part.rollup.crossing ?? [];
  // A raw part is one record, and what it ran for is its rollup's duration.
  // It is divided when it runs past the next boundary after its start.
  const length = part.rollup.durationMs ?? 0;
  return length <= 0 || part.startMs + length <= nextCut(boundaries, part.startMs)
    ? []
    : [wholeRecord(part, length)];
}

/** The one record of a raw part, as a crossing record. */
function wholeRecord(part: StatsPart, length: number): CrossingRecord {
  const values = Object.entries(part.rollup.fields).map(([name, stats]): [string, number] => [
    name,
    stats.sum,
  ]);
  return { s: part.startMs, e: part.startMs + length, v: Object.fromEntries(values) };
}

/**
 * The shares of one record inside `window`: one piece per stretch between two
 * boundaries (bucket edges and UTC hours), each holding the part of the
 * record's value that the stretch is of its length.
 */
function sharesOf(
  boundaries: readonly number[],
  record: CrossingRecord,
  window: Range,
  from: Pick<StatsPart, "origin" | "source">,
): Piece[] {
  const length = record.e - record.s;
  const long = length > LONG_RECORD_MS;
  const endMs = Math.min(record.e, window.endMs);
  const shares: Piece[] = [];
  let at = Math.max(record.s, window.startMs);
  while (at < endMs) {
    const next = Math.min(nextCut(boundaries, at), endMs);
    const sum = scaled(record.v, (next - at) / length);
    shares.push({
      startMs: at,
      endMs: next,
      origin: from.origin,
      source: from.source,
      rollup: { records: 0, fields: {}, spread: { sum, ms: next - at, long: long ? sum : {} } },
      fine: !long,
      share: true,
      hours: [hourOf(at)],
    });
    at = next;
  }
  return shares;
}

/**
 * One part of a running count as pieces: itself, less the records that run
 * past their bucket, and those records' shares inside `window`.
 */
function dividePart(
  boundaries: readonly number[],
  part: StatsPart,
  window: Range,
  out: Piece[],
): void {
  const crossers = crossersOf(boundaries, part);
  if (crossers.length === 0) {
    out.push(wholePiece(part));
    return;
  }
  let taken: SpreadShare = { sum: {}, ms: 0, long: {} };
  let longRecords = 0;
  for (const record of crossers) {
    const length = record.e - record.s;
    if (length > LONG_RECORD_MS) longRecords += 1;
    if (length > SPREAD_MAX_MS) {
      // Too long to divide: it stays whole where it starts, and is called long.
      taken = addShares(taken, { sum: {}, ms: 0, long: record.v });
      continue;
    }
    taken = addShares(taken, { sum: scaled(record.v, -1), ms: -length, long: {} });
    out.push(...sharesOf(boundaries, record, window, part));
  }
  const { records, fields, durationMs } = part.rollup;
  out.push({
    ...part,
    rollup: { records, fields, ...(durationMs !== undefined && { durationMs }), spread: taken },
    fine: records > longRecords,
    share: false,
    hours: hoursOfPart(part),
  });
}

/** True when a rollup has anything in it: a record, or a share of one that started elsewhere. */
function holdsData(rollup: BucketRollup): boolean {
  if (rollup.records > 0) return true;
  const shares = Object.values(rollup.spread?.sum ?? {});
  return shares.some((sum) => sum !== 0);
}

/**
 * A figure that was put together from shares, without the last digits a
 * floating-point sum of thirds leaves behind: twelve significant digits.
 */
function tidy(value: number): number {
  return Number(value.toPrecision(12));
}

type Grouped = Map<number, Map<string, BucketRollup>>;

/** Parts in a fixed order, so that merging them is the same whatever order they were read in. */
function inOrder<Part extends StatsPart>(parts: readonly Part[]): Part[] {
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
      if (holdsData(rollup)) out.set(origin, rollup);
    }
    if (out.size > 0) merged.set(index, out);
  }
  return merged;
}

/** The name of the field a type is weighed and flagged by: its first. */
function primaryField(type: string): string | undefined {
  return rollupFieldsFor(type)[0]?.name;
}

/**
 * What an origin's hour weighs when choosing between origins: the sum of the
 * type's primary field (steps counted, metres, kcal) with the shares of
 * divided records in it, or its record count for a type without one.
 */
function weight(type: string, rollup: BucketRollup): number {
  const primary = primaryField(type);
  if (primary === undefined) return rollup.records;
  const stats = rollup.fields[primary];
  const share = rollup.spread?.sum[primary];
  return stats === undefined && share === undefined
    ? rollup.records
    : (stats?.sum ?? 0) + (share ?? 0);
}

function fieldValues(
  type: string,
  rollup: BucketRollup | null,
  metrics: readonly Metric[],
  fill: "zero" | "null",
): AggregateRow["values"] {
  const wanted = metrics.filter((metric): metric is FieldMetric => FIELD_METRIC_SET.has(metric));
  const shares = rollup?.spread?.sum ?? {};
  const names = new Set([
    ...rollupFieldsFor(type).map((field) => field.name),
    ...Object.keys(rollup?.fields ?? {}),
    ...Object.keys(shares),
  ]);
  const out: [string, Partial<Record<FieldMetric, number | null>>][] = [];
  for (const name of names) {
    const stats: FieldStats | undefined = rollup?.fields[name];
    const share = shares[name];
    const valueOf = (metric: FieldMetric): number | null => {
      // The one metric a divided record changes: its shares are in, and the
      // parts of the bucket's own records that fall elsewhere are out.
      if (metric === "sum" && share !== undefined) return tidy((stats?.sum ?? 0) + share);
      return stats === undefined ? emptyMetric(metric, fill) : stats[metric];
    };
    out.push([name, Object.fromEntries(wanted.map((metric) => [metric, valueOf(metric)]))]);
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
  /** Sleep only: the nights' length from start to end. */
  inBedMs?: number;
  /**
   * The origins whose excluded artefacts this row answers for. Omitted: every
   * origin's in the bucket.
   */
  excludedFor?: readonly string[];
}

/** What narrows one read of a type's parts. */
interface PartOptions {
  origins?: readonly string[];
  /**
   * Read hour by hour inside this window (no day rollup), so that each part
   * can be told apart by its UTC hour.
   */
  window?: Range;
}

/** One `aggregate()` call's working state, shared by every path through it. */
interface Run {
  reads: HcReads;
  request: AggregateRequest;
  range: Range;
  spans: ClippedSpan[];
  /** Every bucket edge inside the range, ascending, and the range's end. */
  boundaries: number[];
  /** The zone whose day rollups may answer, or null: see `PartsQuery.dayRollupZone`. */
  dayRollupZone: string | null;
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
  /** One type's parts, as the store holds them: every record whole, where it starts. */
  parts: (type: string, options?: PartOptions) => Promise<StatsPart[]>;
  push: (input: RowInput) => AggregateRow;
}

/** How long a rollup's interval records ran in its bucket, with what dividing them changed. */
function recordedIn(rollup: BucketRollup | null): number {
  if (rollup === null) return 0;
  const ms = (rollup.durationMs ?? 0) + (rollup.spread?.ms ?? 0);
  return Math.max(0, ms);
}

/** Values the artefact rule took out of one row's bucket, for the origins the row answers for. */
function excludedIn(run: Run, input: RowInput): number {
  const { span, excludedFor } = input;
  let excluded = 0;
  for (const entry of run.excluded.values()) {
    if (entry.startMs < span.fromMs || entry.startMs >= span.toMs) continue;
    if (excludedFor === undefined || excludedFor.includes(entry.origin)) excluded += entry.count;
  }
  return excluded;
}

/** What a rollup's total owes to records longer than an hour: `AggregateRow.longRecordSum`. */
function longShare(type: string, rollup: BucketRollup | null): number {
  const primary = primaryField(type);
  return primary === undefined ? 0 : (rollup?.spread?.long[primary] ?? 0);
}

function buildRow(run: Run, input: RowInput): AggregateRow {
  const { span, rollup } = input;
  const { type, metrics, fill, clock } = run.request;
  const partial = span.fromMs > span.startMs || span.toMs < span.endMs;
  const emptyCount = fill === "zero" ? 0 : null;
  const excluded = excludedIn(run, input);
  const dropped = input.duplicatesDropped ?? 0;
  const long = longShare(type, rollup);
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
      durationMs: rollup === null ? emptyCount : recordedIn(rollup),
    }),
    ...(type === TYPE_SLEEP &&
      metrics.includes("in_bed") && {
        inBedMs: rollup === null ? emptyCount : (input.inBedMs ?? 0),
      }),
    values: fieldValues(type, rollup, metrics, fill),
    ...(dropped > 0 && { duplicatesDropped: dropped }),
    ...(excluded > 0 && { artefactsExcluded: excluded }),
    ...(long > 0 && { longRecordSum: tidy(long) }),
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
    boundaries,
    dayRollupZone,
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
      run.recordedMs.push(recordedIn(input.rollup));
      run.duplicatesDropped += row.duplicatesDropped ?? 0;
      run.artefactsExcluded += row.artefactsExcluded ?? 0;
      return row;
    },
  };
  return run;
}

/**
 * The shares, inside `window`, of the records that started BEFORE it and run
 * into it. They are found in the hour rollups of the two days before the
 * window: no record older than that is divided (`SPREAD_MAX_MS`). Hour
 * rollups and never day rollups, whatever the range is answered from: whether
 * a day rollup is current was asked about the range, not about the days
 * before it, and an hour rollup always is.
 */
async function sharesFromBefore(
  run: Run,
  type: string,
  window: Range,
  options: PartOptions,
): Promise<Piece[]> {
  // From an hour's start, so that only the window's own edge can cut an hour.
  const before: Range = {
    startMs: hourOf(window.startMs - SPREAD_MAX_MS) * HOUR_MS,
    endMs: window.startMs,
  };
  const read = await readParts(run.reads, {
    deviceId: run.request.deviceId,
    type,
    range: before,
    boundaries: [before.startMs, before.endMs],
    dayRollupZone: null,
    origins: options.origins,
  });
  const shares: Piece[] = [];
  for (const part of read.parts) {
    const length = part.rollup.durationMs ?? 0;
    const records =
      part.source === "raw" ? [wholeRecord(part, length)] : (part.rollup.crossing ?? []);
    for (const record of records) {
      if (record.e <= window.startMs || record.e - record.s > SPREAD_MAX_MS) continue;
      const own = sharesOf(run.boundaries, record, window, part);
      if (own.length > 0) run.sources.add(part.source);
      shares.push(...own);
    }
  }
  return shares;
}

/**
 * One type's parts as pieces. For a running count, the records that run past
 * their bucket are divided among the buckets they span, the ones that started
 * before the range included: see the module comment.
 */
async function readPieces(run: Run, type: string, options: PartOptions = {}): Promise<Piece[]> {
  const parts = await run.parts(type, options);
  if (!isSpreadType(type)) return parts.map((part) => wholePiece(part));
  const window = options.window ?? run.range;
  const pieces: Piece[] = [];
  for (const part of parts) dividePart(run.boundaries, part, window, pieces);
  if (window.endMs > window.startMs) {
    pieces.push(...(await sharesFromBefore(run, type, window, options)));
  }
  return pieces;
}

async function aggregateOneOrigin(run: Run, origin: string): Promise<void> {
  const own = byBucketAndOrigin(
    run.spans,
    await readPieces(run, run.request.type, { origins: [origin] }),
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
function pushSeparately(run: Run, all: Grouped, inBed?: Map<number, Map<string, number>>): void {
  const names = new Set<string>();
  for (const origins of all.values()) for (const origin of origins.keys()) names.add(origin);
  const ordered = sortedText(names);
  for (const [index, span] of run.spans.entries()) {
    if (ordered.length === 0) run.push({ span, rollup: null, origins: [] });
    for (const origin of ordered) {
      const rollup = all.get(index)?.get(origin) ?? null;
      const length = inBed?.get(index)?.get(origin);
      run.push({
        span,
        rollup,
        origins: [origin],
        excludedFor: [origin],
        ...(length !== undefined && { inBedMs: length }),
        ...(rollup !== null && { method: "origin" as const }),
      });
    }
  }
}

async function aggregateSeparately(run: Run): Promise<void> {
  pushSeparately(run, byBucketAndOrigin(run.spans, await readPieces(run, run.request.type)));
}

/**
 * A counter's pieces with one origin chosen per UTC hour: `kept` is the chosen
 * origin's pieces, `dropped` everyone else's in an hour that origin has
 * anything in.
 *
 * An origin with something of its own in the hour -- a record no longer than
 * an hour, or a share of one -- is preferred to an origin that has only the
 * share of a longer record there. A day's total written as one record says
 * nothing about any one hour, and letting its share stand beside (or instead
 * of) a tracker that measured the hour would count the same energy twice, or
 * swap a measurement for an average. It is still what the hour gets when
 * nobody measured it. Among the origins preferred, the largest total wins;
 * ties go to the lower origin name, so the choice is the same everywhere.
 *
 * Every piece must lie inside one UTC hour (an hour rollup, a raw record, or
 * a share).
 */
function chooseByHour(type: string, pieces: readonly Piece[]): { kept: Piece[]; dropped: Piece[] } {
  const hours = new Map<number, Map<string, Piece[]>>();
  for (const piece of inOrder(pieces)) {
    fileUnder(mapUnder(hours, hourOf(piece.startMs)), piece.origin, piece);
  }
  const kept: Piece[] = [];
  const dropped: Piece[] = [];
  for (const origins of hours.values()) {
    const chosen = originOfHour(type, origins);
    for (const [origin, own] of origins) (origin === chosen ? kept : dropped).push(...own);
  }
  return { kept, dropped };
}

/** The origin taken for one UTC hour, from every origin's pieces in it: see `chooseByHour`. */
function originOfHour(type: string, origins: ReadonlyMap<string, Piece[]>): string | null {
  const names = sortedText(origins.keys());
  const measured = names.filter((origin) =>
    (origins.get(origin) ?? []).some((piece) => piece.fine),
  );
  let best: { origin: string; weight: number } | null = null;
  const candidates = measured.length > 0 ? measured : names;
  for (const origin of candidates) {
    let total = 0;
    const own = origins.get(origin) ?? [];
    for (const piece of own) total += weight(type, piece.rollup);
    if (best === null || total > best.weight) best = { origin, weight: total };
  }
  return best?.origin ?? null;
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

/** True for a day rollup as the store holds it: a whole local day of one origin. */
function isDayPiece(piece: Piece): boolean {
  return piece.source === "day_rollup" && !piece.share;
}

/** True when `ms` falls in one of `ranges`, which are in order and do not overlap. */
function within(ranges: readonly Range[], ms: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (range === undefined) return false;
    if (ms < range.startMs) high = middle - 1;
    else if (ms >= range.endMs) low = middle + 1;
    else return true;
  }
  return false;
}

/**
 * The days of a coarse read that have to be opened hour by hour before an
 * origin can be chosen per hour.
 *
 * A day only one origin has anything in holds no choice, and its day rollup
 * is final -- which is what keeps a multi-year answer on day rollups. A day
 * two origins have something in is opened; a share of a record that started
 * on another day counts as its origin being there. In a zone whose days do
 * not begin on a UTC hour, a UTC hour can straddle two days, so one day cannot
 * be judged alone: there, every day is opened as soon as the range holds two
 * origins at all.
 */
function daysToOpen(pieces: readonly Piece[]): Range[] {
  const days = new Map<number, { endMs: number; origins: Set<string> }>();
  const everyOrigin = new Set<string>();
  let aligned = true;
  for (const piece of pieces) {
    everyOrigin.add(piece.origin);
    if (!isDayPiece(piece)) continue;
    aligned &&= piece.startMs % HOUR_MS === 0 && piece.endMs % HOUR_MS === 0;
    const day = days.get(piece.startMs);
    if (day === undefined) {
      days.set(piece.startMs, { endMs: piece.endMs, origins: new Set([piece.origin]) });
    } else day.origins.add(piece.origin);
  }
  const starts = sortedBy(days.keys(), (left, right) => left - right);
  // The day a piece that is not a day rollup lands in, if it lands in one.
  const dayHolding = (ms: number): { endMs: number; origins: Set<string> } | undefined => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((starts[middle] ?? Infinity) <= ms) low = middle + 1;
      else high = middle;
    }
    const day = days.get(starts[low - 1] ?? NaN);
    return day !== undefined && ms < day.endMs ? day : undefined;
  };
  for (const piece of pieces) {
    if (!isDayPiece(piece)) dayHolding(piece.startMs)?.origins.add(piece.origin);
  }
  const open: Range[] = [];
  for (const [startMs, day] of days) {
    if ((aligned ? day.origins.size : everyOrigin.size) > 1) {
      open.push({ startMs, endMs: day.endMs });
    }
  }
  return mergedRanges(open);
}

interface BucketChoice {
  parts: Piece[];
  dropped: number;
}

/**
 * A counter under `hc_priority` without the platform's figure, for the whole
 * range: one origin per UTC hour, summed into buckets. See the module comment.
 */
async function hourlyFallback(
  run: Run,
  coarse: readonly Piece[],
): Promise<Map<number, BucketChoice>> {
  const { type } = run.request;
  const open = daysToOpen(coarse);
  const settled: Piece[] = [];
  const hourly: Piece[] = [];
  for (const piece of coarse) {
    // Everything in an opened day is read again below, hour by hour: its day
    // rollup, and whatever share of another day's record landed in it.
    if (within(open, piece.startMs)) continue;
    (isDayPiece(piece) ? settled : hourly).push(piece);
  }
  for (const window of open) hourly.push(...(await readPieces(run, type, { window })));

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
  for (const piece of [...settled, ...kept]) choice(piece.startMs)?.parts.push(piece);
  for (const piece of dropped) {
    const entry = choice(piece.startMs);
    if (entry !== null) entry.dropped += piece.rollup.records;
  }
  return out;
}

/** A bucket from the parts chosen for it. */
function chosenInput(span: ClippedSpan, choice: BucketChoice | undefined): RowInput {
  const rollup =
    choice === undefined ? null : mergeRollups(inOrder(choice.parts).map((part) => part.rollup));
  if (choice === undefined || rollup === null || !holdsData(rollup)) {
    return { span, rollup: null, origins: [], duplicatesDropped: choice?.dropped ?? 0 };
  }
  return {
    span,
    rollup,
    origins: sortedText(new Set(choice.parts.map((part) => part.origin))),
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
 * The hourly figures are added as they were uploaded, unrounded.
 */
function fromPlatform(type: string, hours: readonly BucketRollup[]): BucketRollup {
  const merged = mergeRollups(hours);
  const value = merged.fields.value;
  if (DURATION_TYPES.has(type)) {
    return { records: merged.records, fields: {}, durationMs: value?.sum ?? 0 };
  }
  const primary = primaryField(type) ?? "value";
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
 * The buckets the platform has a figure in but does not cover: some hour in
 * which the type itself has data -- a record, or a share of one -- has no
 * hourly figure from the platform.
 *
 * Judged hour by hour, never by the first and last hour the platform has. Its
 * hours can have holes anywhere: the day a phone was paired, a day still being
 * backfilled, an hour whose total was lost. Taking the platform's number alone
 * for such a bucket reports a short day and calls it the platform's.
 *
 * It costs nothing to ask: a rollup says which hours its records start in
 * (`BucketRollup.hours`), a day rollup included. One written before rollups
 * said is taken as not covered, and so is read hour by hour.
 */
function partlyCovered(
  run: Run,
  platform: readonly StatsPart[],
  own: readonly Piece[],
): Set<number> {
  const covered = new Set<number>();
  for (const part of platform) {
    const hours = hoursOfPart(part);
    if (hours !== null) for (const hour of hours) covered.add(hour);
  }
  const partly = new Set<number>();
  for (const piece of own) {
    const index = spanIndex(run.spans, piece.startMs);
    if (index === -1 || partly.has(index)) continue;
    if (piece.hours === null || piece.hours.some((hour) => !covered.has(hour))) partly.add(index);
  }
  return partly;
}

/**
 * The buckets the platform covers only partly, each composed hour by hour: the
 * platform's figure in the hours it has one, the fallback in the others. Read
 * a run of adjacent buckets at a time, so a long stretch of them is two reads
 * and not two per bucket.
 */
async function composeMixed(
  run: Run,
  platformType: string,
  buckets: ReadonlySet<number>,
): Promise<Map<number, RowInput>> {
  const { type } = run.request;
  const counter = isCounter(type);
  const windows = mergedRanges(
    listOf(buckets).flatMap((index) => {
      const span = run.spans[index];
      return span === undefined ? [] : [{ startMs: span.fromMs, endMs: span.toMs }];
    }),
  );
  const platform = new Map<number, Map<number, StatsPart[]>>();
  const own = new Map<number, Piece[]>();
  for (const window of windows) {
    const hours = await run.parts(platformType, { window });
    for (const part of hours) {
      const index = spanIndex(run.spans, part.startMs);
      fileUnder(mapUnder(platform, index), hourOf(part.startMs), part);
    }
    const pieces = await readPieces(run, type, { window });
    for (const piece of pieces) fileUnder(own, spanIndex(run.spans, piece.startMs), piece);
  }

  const out = new Map<number, RowInput>();
  for (const index of buckets) {
    const span = run.spans[index];
    if (span === undefined) continue;
    const hours = platform.get(index) ?? new Map<number, StatsPart[]>();
    const pieces = own.get(index) ?? [];
    const choice = counter ? chooseByHour(type, pieces) : { kept: pieces, dropped: [] };
    out.set(index, mixedInput(type, span, hours, choice));
  }
  return out;
}

/**
 * One bucket the platform covers only partly: its figure for the hours it has
 * one in, and for the others what the fallback chose.
 */
function mixedInput(
  type: string,
  span: ClippedSpan,
  hours: ReadonlyMap<number, StatsPart[]>,
  choice: { kept: readonly Piece[]; dropped: readonly Piece[] },
): RowInput {
  const elsewhere = (piece: Piece): boolean => !hours.has(hourOf(piece.startMs));
  const fallback = inOrder(choice.kept.filter((piece) => elsewhere(piece)));
  const rollups: BucketRollup[] = [];
  const origins = new Set<string>();
  for (const hour of hours.values()) {
    rollups.push(
      fromPlatform(
        type,
        hour.map((part) => part.rollup),
      ),
    );
    for (const part of hour) origins.add(part.origin);
  }
  for (const piece of fallback) {
    rollups.push(piece.rollup);
    origins.add(piece.origin);
  }
  let dropped = 0;
  for (const piece of choice.dropped) if (elsewhere(piece)) dropped += piece.rollup.records;
  const used = fallback.some((piece) => holdsData(piece.rollup));
  const mixed = isCounter(type) ? "platform_and_max_origin" : "platform_and_all_origins";
  return {
    span,
    rollup: mergeRollups(rollups),
    origins: sortedText(origins),
    method: used ? mixed : "platform",
    duplicatesDropped: dropped,
  };
}

async function aggregateByPriority(run: Run): Promise<void> {
  const { type, metrics } = run.request;
  const platformType = platformAggregateType(type);
  const usePlatform =
    platformType !== null && platformCanAnswer(metrics) && hourAligned(run.range, run.spans);
  const platformParts = usePlatform ? await run.parts(platformType) : [];
  const platform = byBucketAndOrigin(run.spans, platformParts);
  const coarse = await readPieces(run, type);
  const own = byBucketAndOrigin(run.spans, coarse);
  // Only the buckets the platform says nothing about fall back, so only their
  // parts are opened hour by hour: three years of a watch and a phone both
  // counting steps, with the platform's figure throughout, stays on day
  // rollups. (The platform is only used when every bucket begins on a UTC
  // hour, so no hour is shared between a bucket that falls back and one that
  // does not.)
  const unanswered = coarse.filter((piece) => !platform.has(spanIndex(run.spans, piece.startMs)));
  const chosen = isCounter(type) ? await hourlyFallback(run, unanswered) : null;
  const fallback = (index: number, span: ClippedSpan): RowInput =>
    chosen === null ? allOriginsInput(span, own.get(index)) : chosenInput(span, chosen.get(index));
  const partly = new Set(
    listOf(partlyCovered(run, platformParts, coarse)).filter((index) => platform.has(index)),
  );
  const mixed =
    platformType === null || partly.size === 0
      ? new Map<number, RowInput>()
      : await composeMixed(run, platformType, partly);
  // Every bucket gets its row, whatever became of the one before it.
  for (const [index, span] of run.spans.entries()) {
    const fromHc = platform.get(index);
    if (platformType === null || fromHc === undefined) {
      const row = run.push(fallback(index, span));
      if (platformType !== null && row.hasData) run.usedFallback = true;
      continue;
    }
    run.usedPlatform = true;
    const row = run.push(mixed.get(index) ?? platformInput(type, span, fromHc));
    if (row.method !== "platform") run.usedFallback = true;
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

/** What an aggregate reads of one stored session. */
interface SessionSpan extends Spanned {
  /** Sleep only: the night's time asleep. */
  asleepMs?: number;
}

/** One stored session, as far as an aggregate reads it. */
type Session = Stored<SessionSpan>;

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
      summary: {
        origin: night.origin,
        startMs: night.startMs,
        endMs: night.endMs,
        asleepMs: night.asleepMin * MINUTE_MS,
      },
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

/**
 * What a session counts for as `duration`: a night's time asleep, a workout's
 * length. `spanMs` is the session from start to end.
 */
function sessionDuration(type: string, session: SessionSpan, spanMs: number): number {
  return type === TYPE_SLEEP ? (session.asleepMs ?? spanMs) : spanMs;
}

/** Sessions as per-bucket, per-origin rollups: how many, and how long they ran. */
function sessionsByOrigin(
  run: Run,
  sessions: readonly Session[],
): { rollups: Grouped; inBed: Map<number, Map<string, number>> } {
  const { type } = run.request;
  const rollups: Grouped = new Map();
  const inBed = new Map<number, Map<string, number>>();
  for (const { summary } of sessions) {
    const index = spanIndex(run.spans, sessionAnchor(type, summary));
    if (index === -1) continue;
    const spanMs = summary.endMs - summary.startMs;
    const origins = mapUnder(rollups, index);
    const current = origins.get(summary.origin) ?? { records: 0, fields: {}, durationMs: 0 };
    origins.set(summary.origin, {
      records: current.records + 1,
      fields: {},
      durationMs: (current.durationMs ?? 0) + sessionDuration(type, summary, spanMs),
    });
    const lengths = mapUnder(inBed, index);
    lengths.set(summary.origin, (lengths.get(summary.origin) ?? 0) + spanMs);
  }
  return { rollups, inBed };
}

/** What the session rules make of one bucket: stretches, their length, and who wrote them. */
interface SessionBucket {
  groups: number;
  /** What the stretches count for as `duration`: see `sessionDuration`. */
  durationMs: number;
  /** The stretches from start to end, added up. */
  spanMs: number;
  dropped: number;
  origins: Set<string>;
  /** The earliest start and latest end of the bucket's stretches. */
  firstMs: number;
  lastMs: number;
  /** The UTC hours the bucket's stretches have time in. */
  hours: Set<number>;
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
        spanMs: 0,
        dropped: 0,
        origins: new Set(),
        firstMs: Infinity,
        lastMs: -Infinity,
        hours: new Set(),
      };
      out.set(index, bucket);
    }
    const spanMs = group.merged.endMs - group.merged.startMs;
    bucket.groups += 1;
    // A group of copies of one night is that night once: the figures of its
    // longest member, as `sleep_sessions` gives them.
    bucket.durationMs += sessionDuration(type, group.primary.summary, spanMs);
    bucket.spanMs += spanMs;
    bucket.dropped += group.members.length - 1;
    bucket.firstMs = Math.min(bucket.firstMs, group.merged.startMs);
    bucket.lastMs = Math.max(bucket.lastMs, group.merged.endMs);
    for (let hour = hourOf(group.merged.startMs); hour * HOUR_MS < group.merged.endMs; hour += 1) {
      bucket.hours.add(hour);
    }
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
 * True when the platform's hours in a bucket span every stretch filed there:
 * it has a figure for each hour a stretch has time in. Where its rollup does
 * not say which hours it has (one written before rollups did), by the first
 * and last instants each side holds.
 */
function platformSpans(platform: BucketRollup, stored: SessionBucket): boolean {
  if (platform.hours !== undefined) {
    const have = new Set(platform.hours);
    return listOf(stored.hours).every((hour) => have.has(hour));
  }
  const value = platform.fields.value;
  return (
    value !== undefined &&
    stored.firstMs >= value.firstMs &&
    stored.lastMs <= value.lastMs + HOUR_MS
  );
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
    const covers =
      hours?.fields.value !== undefined && (stored === undefined || platformSpans(hours, stored));
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
      inBedMs: stored.spanMs,
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
    const all = sessionsByOrigin(run, sessions);
    pushSeparately(run, all.rollups, all.inBed);
    return;
  }
  const own = sessionsByOrigin(
    run,
    sessions.filter(({ summary }) => summary.origin === mode.origin),
  );
  for (const [index, span] of run.spans.entries()) {
    const rollup = own.rollups.get(index)?.get(mode.origin) ?? null;
    const length = own.inBed.get(index)?.get(mode.origin);
    run.push({
      span,
      rollup,
      origins: rollup === null ? [] : [mode.origin],
      ...(length !== undefined && { inBedMs: length }),
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
    longRecordRows: run.rows.filter((row) => row.longRecordSum !== undefined).length,
  };
}

/**
 * Pad each bucket's unrecorded time with basal metabolic rate. The recorded
 * time is the total length of the bucket's interval records -- of a record
 * that runs past the bucket, the part inside it -- so a bucket a tracker
 * covered completely gains nothing.
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
