/**
A `field` rule's vocabularies, for a paired phone's Health Connect data.

`./aliases.ts` translates a FHIR rule between two shapes of one resource.
Phone data has the same problem in a different form: ONE measurement is
spelled several ways, by several tools, on rows of several types. A systolic
pressure is `systolic` on a sitting, `readings[].systolic` inside it,
`data.systolic` in `hc_records`, `values.systolic.mean` in `hc_aggregate`
and `bloodPressure.systolic` on a `daily_summary` row -- whose `resourceType`
is not even `hc:BloodPressure`. A rule that removed only the spelling it was
written in would be a rule the owner believes in and a model reads around.

So a rule naming a field of a record type -- in ANY of its spellings -- is
expanded into every place that field ends up, on every tool:

 - on rows of that type: `<f>`, `data.<f>` (and `data.<list>[].<f>` for a
   sampled series), `values.<f>`, `readings[].<f>`, the type's own other
   names for it ({@link OWN_PLACES}), a quality finding's `value`;
 - on rows of another type: the joined fields `JOINED_FIELDS` says carry
   that type's data (`./hc-fields.ts`), narrowed by {@link DERIVED_PLACES}
   where a type has several fields and each lands somewhere different.

A rule may also name a joined field directly under its SOURCE type
(`hc:HeartRate` / `hr`): that reaches the rows that carry it, whatever their
own type.

It only ever adds paths, and every path it adds names the same measurement,
so it strips more and never less. `./filter.ts` applies the result;
`./validate.ts` uses it to refuse a rule that could reach nothing.

Pure: tables and string work.
*/

import { ARRAY_SEGMENT } from "@shared/policy-path.ts";

import { recordFieldsOf } from "../hc/record-types.ts";
import { rollupFieldsFor } from "../hc/rollup/hour.ts";

import { JOINED_FIELDS, JOINED_SOURCE_TYPES, PLATFORM_PAIRS, joinedFieldsOf } from "./hc-fields.ts";

import type { FieldRule } from "./rules.ts";

/** What `resourceType` puts before a Health Connect record type. */
export const HC_TYPE_PREFIX = "hc:";

/** True for the `resourceType` of a phone's row, or a rule scoped to one. */
export function isHcResourceType(resourceType: string | null): resourceType is string {
  return resourceType?.startsWith(HC_TYPE_PREFIX) === true;
}

/** `hc:HeartRate` -> `HeartRate`. */
export function hcTypeOf(resourceType: string): string {
  return resourceType.slice(HC_TYPE_PREFIX.length);
}

/** The prefixes a field can be written under: the containers the tools put it in. */
const CONTAINERS: ReadonlySet<string> = new Set(["data", "values", "readings", "weighings"]);

/**
A type's other names for one of its fields, on rows of its OWN type. Heart
rate is `bpm` in a record and a minute's `mean`/`min`/`max` in `hr_series`,
and an event's three figures in `hr_events`.
*/
const OWN_PLACES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  HeartRate: { bpm: ["mean", "min", "max", "baselineBpm", "peakBpm", "deltaBpm"] },
};

/** Where `data_quality` puts the value a rule flagged, on a finding about any type. */
const FINDING_VALUE_PATHS: readonly string[] = ["value", "maxValue", "minValue"];

/**
Where one field of a type lands on rows of ANOTHER type, per tool, when
that is narrower than "every joined field of the type" -- or, for a tool
`JOINED_FIELDS` does not cover, where it lands at all.
*/
const DERIVED_PLACES: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>>
> = {
  BloodPressure: {
    systolic: { daily_summary: ["bloodPressure.systolic"] },
    diastolic: { daily_summary: ["bloodPressure.diastolic"] },
  },
  Weight: { weight: { daily_summary: ["weight", "weighings.weight"] } },
  SkinTemperature: {
    // The night's figure is the mean of the deltas; the baseline is not in it.
    baseline: { sleep_sessions: [], daily_summary: [] },
  },
  // The basal-metabolic padding `hc_aggregate` can add to a calorie total.
  BasalMetabolicRate: { bmr: { hc_aggregate: ["bmrFillKcal"] } },
};

const PLATFORM_TYPES: ReadonlySet<string> = new Set(PLATFORM_PAIRS.map(([type]) => type));

/** The numeric fields of a type: what a total, a mean or a joined figure is computed from. */
function numericFields(type: string): readonly string[] {
  return rollupFieldsFor(type).map((spec) => spec.name);
}

/** `samples[].bpm` -> the list a sampled field sits in (`samples`), or null for a scalar. */
function seriesListOf(type: string, field: string): string | null {
  const spec = rollupFieldsFor(type).find((entry) => entry.name === field);
  return spec?.kind === "series" ? (spec.path.split("[].", 1)[0] ?? null) : null;
}

/** True when `field` is something a record of `type` carries, by either table. */
function isFieldOf(type: string, field: string): boolean {
  return numericFields(type).includes(field) || recordFieldsOf(type)?.includes(field) === true;
}

/** A dotted path as segments, an array step written wherever a `[]` could follow. */
function segmentsOf(dotted: string): string[] {
  return dotted.split(".");
}

interface NamedField {
  /** The field of the record type the path names. */
  field: string;
  /** Whatever the path goes on to say below it. */
  tail: readonly string[];
}

/** Every place {@link DERIVED_PLACES} and {@link OWN_PLACES} put one field of a type, dotted. */
function otherNamesOf(type: string, field: string): string[] {
  const derived = Object.values(DERIVED_PLACES[type]?.[field] ?? {}).flat();
  return [...derived, ...(OWN_PLACES[type]?.[field] ?? [])];
}

/**
The type's field a path names by one of its OTHER names: where the field
lands on another row (`bloodPressure.systolic`, `weighings[].weight`), the
type's own alternative name for it (`mean` of a heart-rate point), or a
joined field that carries nothing but this type's one number (`hr`,
`restingHr`, `steps`). A joined field read off two types (a workout's
left-running flag) names neither's field: hiding the flag is not hiding
every heart rate.
*/
function fieldByOtherName(type: string, dotted: string): string | null {
  const numeric = numericFields(type);
  const fields = new Set([...numeric, ...(recordFieldsOf(type) ?? [])]);
  for (const field of fields) {
    if (otherNamesOf(type, field).includes(dotted)) return field;
  }
  const [only, ...more] = numeric;
  if (only === undefined || more.length > 0) return null;
  const tables: Record<string, readonly string[]>[] = Object.values(JOINED_FIELDS);
  for (const table of tables) {
    const sources = Object.hasOwn(table, dotted) ? table[dotted] : undefined;
    if (sources?.length === 1 && sources[0] === type) return only;
  }
  return null;
}

/**
The field a path names, whichever way it was written: `systolic`,
`data.systolic`, `values.systolic.mean`, `readings[].systolic`,
`data.samples[].bpm` (the sampled field, not its list) and
`bloodPressure.systolic` all name one.
*/
function namedField(type: string, path: readonly string[]): NamedField | null {
  const plain = path.filter((segment) => segment !== ARRAY_SEGMENT);
  const byOtherName = fieldByOtherName(type, plain.join("."));
  if (byOtherName !== null) return { field: byOtherName, tail: [] };
  const container = CONTAINERS.has(plain[0] ?? "") ? plain[0] : undefined;
  const rest = container === undefined ? plain : plain.slice(1);
  const [head, ...tail] = rest;
  if (head === undefined) return null;
  // `samples.bpm`: the list is how the field is stored, the key is the field.
  const sampled = tail[0];
  if (sampled !== undefined && seriesListOf(type, sampled) === head) {
    return { field: sampled, tail: tail.slice(1) };
  }
  // Below `values.<f>` is a metric of the field, not a part of it.
  return { field: head, tail: container === "values" ? [] : tail };
}

/** Every spelling of one field on rows of its own type. */
function ownSpellings(tool: string, type: string, named: NamedField): string[][] {
  const { field, tail } = named;
  const out: string[][] = [
    [field, ...tail],
    ["data", field, ...tail],
    // Any metric below `values.<f>` is that field's number.
    ["values", field],
    ["readings", field, ...tail],
  ];
  const list = seriesListOf(type, field);
  if (list !== null) out.push(["data", list, field]);
  const ownPlaces = OWN_PLACES[type]?.[field] ?? [];
  for (const place of ownPlaces) out.push(segmentsOf(place));
  if (!numericFields(type).includes(field)) return out;
  if (tool === "data_quality") for (const place of FINDING_VALUE_PATHS) out.push([place]);
  // The platform's hourly total of the type, stored as `Agg.<Metric>` and tagged as the type.
  if (PLATFORM_TYPES.has(type) && numericFields(type)[0] === field) out.push(["data", "value"]);
  return out;
}

/** Where one field of `type` lands on rows of another type, in one tool. */
function derivedPlaces(tool: string, type: string, field: string): string[][] {
  const narrowed = DERIVED_PLACES[type]?.[field]?.[tool];
  if (narrowed !== undefined) return narrowed.map((place) => segmentsOf(place));
  // Joined figures are computed from a type's numbers, not from its labels.
  return numericFields(type).includes(field)
    ? joinedFieldsOf(tool, type).map((joined) => segmentsOf(joined))
    : [];
}

/**
The joined fields of `tool` carrying `type`'s data that `path` names: the
one it spells (or sits below), and any other of the same name one level
down -- a sitting's `pulse` and each of its readings' `pulse` are one thing.
*/
function namedJoinedFields(tool: string, type: string, path: readonly string[]): string[][] {
  const plain = path.filter((segment) => segment !== ARRAY_SEGMENT);
  const dotted = plain.join(".");
  const joined = joinedFieldsOf(tool, type);
  const exact = joined.some((field) => dotted === field || dotted.startsWith(`${field}.`));
  if (!exact) return [];
  const leaf = plain.at(-1) ?? "";
  const sameName = joined.filter((field) => segmentsOf(field).at(-1) === leaf);
  return [[...path], ...sameName.map((field) => segmentsOf(field))];
}

export interface HcCandidateInput {
  tool: string;
  /** The row's own `resourceType`, `hc:<Type>`. */
  rowType: string;
  /** The rule's `resourceType`, or null for a rule on every type. */
  ruleType: string | null;
  path: readonly string[];
}

const candidateCache = new Map<string, readonly (readonly string[])[]>();

function candidatesFor(
  tool: string,
  rowType: string,
  type: string,
  path: readonly string[],
): string[][] {
  const named = namedField(type, path);
  if (named === null) return [];
  if (rowType === type) return ownSpellings(tool, type, named);
  const out = namedJoinedFields(tool, type, path);
  return isFieldOf(type, named.field) ? [...out, ...derivedPlaces(tool, type, named.field)] : out;
}

/**
Every path worth pruning from one row for one rule path. Always includes
the path as written when the rule is on the row's own type (or on every
type); nothing at all when the rule's type has no data on this row.
*/
export function hcCandidates(input: HcCandidateInput): readonly (readonly string[])[] {
  const { tool, path } = input;
  const key = [tool, input.rowType, input.ruleType ?? "*", ...path].join("\u{0}");
  const cached = candidateCache.get(key);
  if (cached !== undefined) return cached;

  const rowType = hcTypeOf(input.rowType);
  const out = new Map<string, readonly string[]>();
  const add = (candidates: readonly (readonly string[])[]): void => {
    for (const candidate of candidates) out.set(candidate.join("\u{0}"), candidate);
  };
  if (input.ruleType === null) {
    // A rule on every type: the path as written, the row's own spellings of
    // it, and the places any type that has such a field puts it on this row.
    add([path]);
    add(candidatesFor(tool, rowType, rowType, path));
    for (const type of typesWithJoins(tool)) {
      if (type !== rowType) add(candidatesFor(tool, rowType, type, path));
    }
  } else {
    const type = hcTypeOf(input.ruleType);
    if (type === rowType) add([path]);
    add(candidatesFor(tool, rowType, type, path));
  }
  const candidates = [...out].map(([, candidate]) => candidate);
  candidateCache.set(key, candidates);
  return candidates;
}

/** The record types whose data one tool puts on rows of another type. */
function typesWithJoins(tool: string): string[] {
  const types = new Set<string>();
  for (const type of JOINED_SOURCE_TYPES) {
    if (joinedFieldsOf(tool, type).length > 0) types.add(type);
  }
  for (const [type, fields] of Object.entries(DERIVED_PLACES)) {
    if (Object.values(fields).some((places) => Object.hasOwn(places, tool))) types.add(type);
  }
  return [...types];
}

/**
True when rows tagged `rowType` in `tool` can carry anything a rule on
`ruleType` could name: they are that type's own rows, or the tool joins
that type's data onto them.
*/
export function hcRuleCanReach(tool: string, rowType: string, ruleType: string): boolean {
  if (rowType === ruleType) return true;
  const type = hcTypeOf(ruleType);
  return (
    joinedFieldsOf(tool, type).length > 0 ||
    Object.values(DERIVED_PLACES[type] ?? {}).some((places) => Object.hasOwn(places, tool))
  );
}

/**
True when a `field` rule names `field` of record type `type`, in any
spelling: it is scoped to that type (or to every type) and one of its
paths resolves to the field.
*/
export function hcFieldRuleNames(rule: FieldRule, type: string, field: string): boolean {
  const scoped = rule.resourceType === null || rule.resourceType === `${HC_TYPE_PREFIX}${type}`;
  return scoped && namedField(type, rule.path)?.field === field;
}
