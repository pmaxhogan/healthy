/**
The hour rollup: summary statistics of one (record type, origin, bucket).

`rollupBucket` is given the records of one chunk and says, per numeric field
that means something for the type, how many values there were and their sum,
extremes, mean, first and last. `mergeRollups` folds several such summaries
into one, which is how a local day is built from its UTC hours without the
raw chunks being opened again.

Which fields are summarised is the table below, and nothing else decides it.
The Worker keeps no allowlist of record types, so a type that is not in the
table is still counted (`records`, and `durationMs` when its records are
intervals) -- it just has no `fields`. Never an error: a newer Health Connect
SDK's type must roll up to something.

A record is counted whole in the rollup of the hour it STARTS in. For the
running counts (`isSpreadType`) a record that runs past the end of that hour
is also listed (`crossing`), so an answer can divide it among the buckets it
spans; and every rollup says which UTC hours its records start in (`hours`).

Tolerant by design. `data` arrives as the phone serialised it; a field that
is missing, not a number, or not finite is skipped and not counted in `n`. A
field no record carried is left out of `fields` rather than written as NaN.

Pure: no D1, no `Env`. See `./types.ts` for the shapes.
*/

import { recordEndMs, recordStartMs } from "../wire.ts";

import type { HcRecord } from "../wire.ts";
import type { BucketRollup, CrossingRecord, FieldStats, SpreadShare } from "./types.ts";

const HOUR_MS = 3_600_000;

/**
One summarised field.

- `scalar`: `data[path]`, one value per record, timed at the record's start.
- `series`: `path` is `<list>[].<key>`; one value per element of the nested
  list, timed at the element's own `t`. `n` then counts samples, not records.
*/
export interface RollupFieldSpec {
  /** The key the statistics are filed under in `BucketRollup.fields`. */
  name: string;
  path: string;
  kind: "scalar" | "series";
}

export interface RollupTypeSpec {
  /** Record class simple name without its `Record` suffix. */
  type: string;
  fields: readonly RollupFieldSpec[];
}

function scalar(...names: string[]): RollupFieldSpec[] {
  return names.map((name) => ({ name, path: name, kind: "scalar" }));
}

function series(list: string, key: string): RollupFieldSpec {
  return { name: key, path: `${list}[].${key}`, kind: "series" };
}

/** The key a nested sample carries its epoch-ms time under. */
const SERIES_TIME_KEY = "t";

/**
Every field NutritionRecord carries as a Mass or an Energy, lowerCamel with
the unit dropped. Units are whatever the Android mapper fixes per field; that
table is the authority, and its test should assert against this list.
*/
const NUTRITION_FIELDS = [
  "energy",
  "energyFromFat",
  "protein",
  "totalCarbohydrate",
  "totalFat",
  "dietaryFiber",
  "sugar",
  "saturatedFat",
  "unsaturatedFat",
  "monounsaturatedFat",
  "polyunsaturatedFat",
  "transFat",
  "cholesterol",
  "sodium",
  "potassium",
  "calcium",
  "iron",
  "magnesium",
  "phosphorus",
  "zinc",
  "copper",
  "manganese",
  "selenium",
  "chromium",
  "molybdenum",
  "iodine",
  "chloride",
  "caffeine",
  "biotin",
  "folate",
  "folicAcid",
  "niacin",
  "pantothenicAcid",
  "riboflavin",
  "thiamin",
  "vitaminA",
  "vitaminB12",
  "vitaminB6",
  "vitaminC",
  "vitaminD",
  "vitaminE",
  "vitaminK",
];

/**
The per-type field table. Plain data, exported so the Android mapper's test
and the query tools can assert against the same list.

Field names follow the wire convention: the SDK property in lowerCamel with
its unit dropped. Units are fixed per field (see the design notes) and are
not repeated here.

SleepSession and ExerciseSession are listed with no fields on purpose: what
an hour or a day wants from them is how many there were and how long they
ran, which `records` and `durationMs` already say. Their own summaries
(`./sleep.ts`, `./exercise.ts`) carry the rest.
*/
export const ROLLUP_FIELD_TABLE: readonly RollupTypeSpec[] = [
  { type: "Steps", fields: scalar("count") },
  { type: "Distance", fields: scalar("distance") },
  { type: "ActiveCaloriesBurned", fields: scalar("energy") },
  { type: "TotalCaloriesBurned", fields: scalar("energy") },
  { type: "FloorsClimbed", fields: scalar("floors") },
  { type: "ElevationGained", fields: scalar("elevation") },
  { type: "WheelchairPushes", fields: scalar("count") },
  { type: "HeartRate", fields: [series("samples", "bpm")] },
  { type: "RestingHeartRate", fields: scalar("bpm") },
  { type: "HeartRateVariabilityRmssd", fields: scalar("rmssd") },
  { type: "RespiratoryRate", fields: scalar("rate") },
  { type: "OxygenSaturation", fields: scalar("percentage") },
  { type: "BloodPressure", fields: scalar("systolic", "diastolic") },
  { type: "BloodGlucose", fields: scalar("level") },
  { type: "BodyTemperature", fields: scalar("temperature") },
  { type: "BasalBodyTemperature", fields: scalar("temperature") },
  { type: "SkinTemperature", fields: [series("deltas", "delta"), ...scalar("baseline")] },
  { type: "Weight", fields: scalar("weight") },
  { type: "Height", fields: scalar("height") },
  { type: "BodyFat", fields: scalar("percentage") },
  { type: "LeanBodyMass", fields: scalar("mass") },
  { type: "BoneMass", fields: scalar("mass") },
  { type: "BodyWaterMass", fields: scalar("mass") },
  { type: "BasalMetabolicRate", fields: scalar("bmr") },
  { type: "Vo2Max", fields: scalar("vo2") },
  { type: "Speed", fields: [series("samples", "speed")] },
  { type: "Power", fields: [series("samples", "power")] },
  { type: "StepsCadence", fields: [series("samples", "rate")] },
  { type: "CyclingPedalingCadence", fields: [series("samples", "rate")] },
  { type: "Hydration", fields: scalar("volume") },
  { type: "Nutrition", fields: scalar(...NUTRITION_FIELDS) },
  { type: "SleepSession", fields: [] },
  { type: "ExerciseSession", fields: [] },
];

/**
The running counts: types whose interval records say "this much between
these two instants", so that a record spanning several buckets belongs to
each in proportion to the time it spends there -- which is how Health
Connect's own aggregation divides one. A logged entry (a drink, a meal) is
not one of them: it is an event with a length, not a rate.
*/
const SPREAD_TYPES: ReadonlySet<string> = new Set([
  "Steps",
  "Distance",
  "ActiveCaloriesBurned",
  "TotalCaloriesBurned",
  "FloorsClimbed",
  "ElevationGained",
  "WheelchairPushes",
]);

/** True for a type whose interval records are divided among the buckets they span. */
export function isSpreadType(type: string): boolean {
  return SPREAD_TYPES.has(type);
}

/**
The longest record that is divided. One that claims to run for longer says
nothing usable about when its count happened, and looking for it from every
bucket it might reach would mean reading back without limit: it is counted
whole where it starts, as a long record. Two days, the bound the session
summaries use for the same reason.
*/
export const SPREAD_MAX_MS = 48 * HOUR_MS;

/**
Above this a record is "long": a total someone wrote for a stretch, not a
count of what happened in any one hour of it.
*/
export const LONG_RECORD_MS = HOUR_MS;

/** The synthetic platform-aggregate family: `Agg.<Metric>`, one record per UTC hour. */
const AGG_TYPE_PREFIX = "Agg.";

/** What every `Agg.<Metric>` type summarises: its one `data.value`. */
export const AGG_ROLLUP_FIELDS: readonly RollupFieldSpec[] = scalar("value");

const FIELDS_BY_TYPE: ReadonlyMap<string, readonly RollupFieldSpec[]> = new Map(
  ROLLUP_FIELD_TABLE.map((spec) => [spec.type, spec.fields]),
);

const NO_FIELDS: readonly RollupFieldSpec[] = [];

/** The fields summarised for `type`: empty for a type the table does not know. */
export function rollupFieldsFor(type: string): readonly RollupFieldSpec[] {
  return type.startsWith(AGG_TYPE_PREFIX)
    ? AGG_ROLLUP_FIELDS
    : (FIELDS_BY_TYPE.get(type) ?? NO_FIELDS);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
Fold statistics into a field's running total. The one place the arithmetic
lives: `rollupBucket` folds each value in as statistics of that one value,
and `mergeRollups` folds whole parts in, so the two cannot drift apart.

Ties on the instant go to encounter order: `first` keeps what was met first
and `last` takes what was met last. That is why merging rollups in order
gives exactly what rolling the concatenated records up would have.
*/
function absorb(stats: Map<string, FieldStats>, name: string, incoming: FieldStats): void {
  const current = stats.get(name);
  if (current === undefined) {
    stats.set(name, { ...incoming });
    return;
  }
  const earliest = incoming.firstMs < current.firstMs ? incoming : current;
  const latest = incoming.lastMs >= current.lastMs ? incoming : current;
  stats.set(name, {
    n: current.n + incoming.n,
    sum: current.sum + incoming.sum,
    min: Math.min(current.min, incoming.min),
    max: Math.max(current.max, incoming.max),
    // Recomputed from sum and n by `finish`, once every part is in.
    mean: current.mean,
    first: earliest.first,
    firstMs: earliest.firstMs,
    last: latest.last,
    lastMs: latest.lastMs,
  });
}

function fold(stats: Map<string, FieldStats>, name: string, value: number, ms: number): void {
  absorb(stats, name, {
    n: 1,
    sum: value,
    min: value,
    max: value,
    mean: value,
    first: value,
    firstMs: ms,
    last: value,
    lastMs: ms,
  });
}

function foldField(
  stats: Map<string, FieldStats>,
  spec: RollupFieldSpec,
  record: HcRecord,
  recordMs: number,
): void {
  if (spec.kind === "scalar") {
    const value = finite(record.data[spec.path]);
    if (value !== null) fold(stats, spec.name, value, recordMs);
    return;
  }
  const [list, key] = spec.path.split("[].", 2);
  if (list === undefined || key === undefined) return;
  const samples = record.data[list];
  if (!Array.isArray(samples)) return;
  for (const sample of samples as unknown[]) {
    if (!isObject(sample)) continue;
    const value = finite(sample[key]);
    if (value === null) continue;
    // A sample with no time of its own is filed at its record's start.
    fold(stats, spec.name, value, finite(sample[SERIES_TIME_KEY]) ?? recordMs);
  }
}

function finish(stats: Map<string, FieldStats>): Record<string, FieldStats> {
  for (const field of stats.values()) {
    // Clamped, because a floating-point sum of equal values need not divide
    // back to that value: three readings of 0.1 sum to 0.30000000000000004,
    // and a mean a hair above the maximum would be a visible lie.
    field.mean = Math.min(field.max, Math.max(field.min, field.sum / field.n));
  }
  return Object.fromEntries(stats);
}

/**
Summarise the records of one bucket. Every record passed is counted, whole:
the caller decides which records belong (those that START in the bucket).

`durationMs` is present when at least one record is an interval, and is the
total of the interval records' lengths.
*/
export function rollupBucket(type: string, records: readonly HcRecord[]): BucketRollup {
  const specs = rollupFieldsFor(type);
  const spread = isSpreadType(type);
  const stats = new Map<string, FieldStats>();
  const hours = new Set<number>();
  const crossing: CrossingRecord[] = [];
  let durationMs: number | undefined;
  for (const record of records) {
    const startMs = recordStartMs(record);
    hours.add(Math.floor(startMs / HOUR_MS));
    if (record.start !== undefined) {
      durationMs = (durationMs ?? 0) + Math.max(0, recordEndMs(record) - startMs);
      const listed = spread ? crossingOf(specs, record, startMs) : null;
      if (listed !== null) crossing.push(listed);
    }
    for (const spec of specs) foldField(stats, spec, record, startMs);
  }
  return {
    records: records.length,
    fields: finish(stats),
    ...(durationMs !== undefined && { durationMs }),
    hours: ascending(hours),
    ...(crossing.length > 0 && { crossing }),
  };
}

function ascending(values: Iterable<number>): number[] {
  const out = [...values];
  out.sort((left, right) => left - right);
  return out;
}

/** `record` as a crossing record, or null when it ends within the hour it starts in. */
function crossingOf(
  specs: readonly RollupFieldSpec[],
  record: HcRecord,
  startMs: number,
): CrossingRecord | null {
  const endMs = recordEndMs(record);
  if (endMs <= (Math.floor(startMs / HOUR_MS) + 1) * HOUR_MS) return null;
  const values: [string, number][] = [];
  for (const spec of specs) {
    const value = spec.kind === "scalar" ? finite(record.data[spec.path]) : null;
    if (value !== null) values.push([spec.name, value]);
  }
  return values.length === 0 ? null : { s: startMs, e: endMs, v: Object.fromEntries(values) };
}

/** Two sets of per-field amounts, added. */
function addAmounts(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): Record<string, number> {
  const out = new Map(Object.entries(left));
  for (const [name, value] of Object.entries(right)) out.set(name, (out.get(name) ?? 0) + value);
  return Object.fromEntries(out);
}

/** Two spread shares, added. */
export function addShares(left: SpreadShare | undefined, right: SpreadShare): SpreadShare {
  if (left === undefined) return { sum: { ...right.sum }, ms: right.ms, long: { ...right.long } };
  return {
    sum: addAmounts(left.sum, right.sum),
    ms: left.ms + right.ms,
    long: addAmounts(left.long, right.long),
  };
}

/**
Fold several rollups of the same (type, origin) into one: hours into a day.

Exact for `records`, `durationMs`, and each field's `n`, `sum`, `min`, `max`,
`first` and `last`; `mean` is recomputed from the merged `sum` and `n`, never
averaged from the parts' means. (`sum` is exact up to floating-point
addition order, as any sum of non-integers is.)

Parts need not be in time order -- `first` and `last` go by `firstMs` and
`lastMs` -- but when two parts tie on the instant, the earlier part in the
array keeps `first` and the later takes `last`, the rule `rollupBucket` uses.
A field only some parts carry is merged over the parts that carry it. No
parts at all is an empty rollup.

`hours` is the union of the parts' -- and absent as soon as one part that
holds records does not say, since the union would then claim to be complete
when it is not. `crossing` lists and `spread` shares are added together.
*/
export function mergeRollups(parts: readonly BucketRollup[]): BucketRollup {
  const stats = new Map<string, FieldStats>();
  let records = 0;
  let durationMs: number | undefined;
  const crossing: CrossingRecord[] = [];
  let spread: SpreadShare | undefined;
  for (const part of parts) {
    records += part.records;
    if (part.durationMs !== undefined) durationMs = (durationMs ?? 0) + part.durationMs;
    for (const [name, field] of Object.entries(part.fields)) {
      if (field.n > 0) absorb(stats, name, field);
    }
    crossing.push(...(part.crossing ?? []));
    if (part.spread !== undefined) spread = addShares(spread, part.spread);
  }
  const hours = hoursOf(parts);
  return {
    records,
    fields: finish(stats),
    ...(durationMs !== undefined && { durationMs }),
    ...(hours !== null && { hours }),
    ...(crossing.length > 0 && { crossing }),
    ...(spread !== undefined && { spread }),
  };
}

/** The union of the parts' `hours`, or null when a part that holds records does not say. */
function hoursOf(parts: readonly BucketRollup[]): number[] | null {
  const hours = new Set<number>();
  for (const part of parts) {
    if (part.hours === undefined) {
      if (part.records > 0) return null;
      continue;
    }
    for (const hour of part.hours) hours.add(hour);
  }
  return ascending(hours);
}
