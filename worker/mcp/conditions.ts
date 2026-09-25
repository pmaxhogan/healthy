/**
 * Making a Condition list readable without removing anything from it.
 *
 * An Epic record re-mints the same diagnosis as a new Condition at every visit
 * it is coded at ("encounter diagnosis"), next to the handful of entries on the
 * problem list. Read raw, the list is mostly the same few conditions again and
 * again. This module is what `get_conditions` (and the summary's conditions
 * section) use to make the useful view easy while every row stays reachable:
 *
 *  - {@link canonicalCategory}: the category vocabulary, with the display
 *    strings and Epic's own `visit-diagnosis` mapped onto the three FHIR codes.
 *  - {@link filterStatus}: the `status` filter, honest about the rows that have
 *    no clinical status at all.
 *  - {@link collapseConditions}: one item per condition identity, with how often
 *    and when it was seen and every visit it was coded at.
 *
 * Everything here runs on NORMALIZED items that the exposure policy has already
 * filtered (`respond()`'s `reshape` hook): a hidden field is not there to be
 * grouped by, dated by or counted, so a group can never carry more than the
 * rows it was made from.
 */

import { z } from "zod";

import { slug } from "./match.ts";

import type { ReshapeRow, Reshaped } from "./respond.ts";
import type { RawEntry } from "../policy/filter.ts";

/** The FHIR condition-category codes a caller can filter on. */
type ConditionCategory = "problem-list-item" | "encounter-diagnosis" | "health-concern";

/**
 * Every accepted spelling of each category, by its code. Compared as slugs, so
 * case, spaces and hyphens do not matter. `visit-diagnosis` is Epic's own
 * category, which it sends next to `encounter-diagnosis` on the same row.
 */
export const CATEGORY_SPELLINGS: ReadonlyMap<ConditionCategory, readonly string[]> = new Map<
  ConditionCategory,
  readonly string[]
>([
  ["problem-list-item", ["problem-list-item", "Problem List Item", "problem-list"]],
  ["encounter-diagnosis", ["encounter-diagnosis", "Encounter Diagnosis", "Visit Diagnosis"]],
  ["health-concern", ["health-concern", "Health Concern"]],
]);

const BY_SLUG: ReadonlyMap<string, ConditionCategory> = new Map(
  [...CATEGORY_SPELLINGS].flatMap(([code, spellings]) =>
    spellings.map((spelling): [string, ConditionCategory] => [slug(spelling), code]),
  ),
);

/** The category code a spelling means, or undefined when it is not one of the three. */
export function canonicalCategory(value: string): ConditionCategory | undefined {
  return BY_SLUG.get(slug(value));
}

/** The `category` argument: a non-empty list, every entry a spelling of one of the three. */
export const CATEGORY_ARG = z
  .array(
    z
      .string()
      .min(1)
      .refine((value) => canonicalCategory(value) !== undefined, {
        message:
          "must be problem-list-item, encounter-diagnosis or health-concern " +
          '(or "Problem List Item", "Encounter Diagnosis", "Visit Diagnosis", "Health Concern")',
      }),
  )
  .min(1);

/** A normalized item, as a plain record. */
type Item = Record<string, unknown>;

function stringOf(item: Item, key: string): string | undefined {
  const value = Object.hasOwn(item, key) ? Reflect.get(item, key) : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function recordOf(item: Item, key: string): Item | undefined {
  const value = Object.hasOwn(item, key) ? Reflect.get(item, key) : undefined;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Item)
    : undefined;
}

function stringsOf(item: Item, key: string): string[] {
  const value = Object.hasOwn(item, key) ? Reflect.get(item, key) : undefined;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * An item's categories as codes: each of the three by its code, anything else
 * as it was sent. Deduplicated, so Epic's "Encounter Diagnosis" + "Visit
 * Diagnosis" pair is one `encounter-diagnosis`.
 */
function categoriesOf(item: Item): string[] {
  const out = new Set<string>();
  for (const value of stringsOf(item, "category")) out.add(canonicalCategory(value) ?? value);
  return [...out];
}

/** The value `status: "unknown"` matches: a row with no clinical status. */
const UNKNOWN_STATUS = "unknown";

/** The warning a status filter adds when it excluded rows with no status. */
const STATUS_EXCLUDED_UNKNOWN = "status_filter_excluded_unknown";

interface StatusFiltered<T> {
  kept: T[];
  /** Rows with no clinical status the filter dropped. Zero for `unknown` itself. */
  excludedUnknown: number;
}

/**
 * The rows a `status` filter keeps.
 *
 * `unknown` keeps exactly the rows with no `clinicalStatus`. Any other value
 * keeps the rows whose status matches it as a slug, and counts the no-status
 * rows it therefore dropped -- they are not known NOT to match, so dropping
 * them silently would misreport the record.
 */
function filterStatus<T extends { item: unknown }>(
  rows: readonly T[],
  status: string,
): StatusFiltered<T> {
  const wanted = slug(status);
  const unknownWanted = wanted === UNKNOWN_STATUS;
  const kept: T[] = [];
  let excludedUnknown = 0;
  for (const row of rows) {
    const current = isItem(row.item) ? stringOf(row.item, "clinicalStatus") : undefined;
    if (current === undefined) {
      if (unknownWanted) kept.push(row);
      else excludedUnknown += 1;
    } else if (!unknownWanted && slug(current) === wanted) {
      kept.push(row);
    }
  }
  return { kept, excludedUnknown };
}

function isItem(value: unknown): value is Item {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ICD-10 (or ICD-10-CM), by URL or by its OID. */
function isIcd10(system: string): boolean {
  return (
    /icd-?10/iu.test(system) ||
    system.endsWith("2.16.840.1.113883.6.90") ||
    system.endsWith("2.16.840.1.113883.6.3")
  );
}

/** SNOMED CT, by URL or by its OID. */
function isSnomed(system: string): boolean {
  return /snomed/iu.test(system) || system.endsWith("2.16.840.1.113883.6.96");
}

/** The first coding (in the order sent) whose system matches, as `code`. */
function firstCode(
  codings: readonly Item[],
  matches: (system: string) => boolean,
): string | undefined {
  for (const coding of codings) {
    const codingSystem = stringOf(coding, "system");
    const code = stringOf(coding, "code");
    if (codingSystem !== undefined && code !== undefined && matches(codingSystem)) return code;
  }
  return undefined;
}

/**
 * What makes two rows the same condition: the health system, plus the first
 * ICD-10 code the row carries, else its first SNOMED code, else its text
 * (lower-cased, whitespace collapsed). A row with none of those is its own
 * group -- there is nothing to say it is the same as anything else.
 *
 * ICD-10 first because it is the code a problem-list entry and every visit's
 * copy of it reliably share; which coding a health system sends FIRST differs
 * between the two, so `code.code` (the first coding) cannot be the key.
 */
function conditionIdentity(item: Item, index: number): string {
  const healthSystem = stringOf(item, "healthSystemId") ?? "";
  const code = recordOf(item, "code");
  const codingsValue = code === undefined ? undefined : Reflect.get(code, "codings");
  const codings = Array.isArray(codingsValue) ? codingsValue.filter((entry) => isItem(entry)) : [];
  const icd10 = firstCode(codings, isIcd10);
  if (icd10 !== undefined) return JSON.stringify([healthSystem, "icd10", icd10]);
  const snomed = firstCode(codings, isSnomed);
  if (snomed !== undefined) return JSON.stringify([healthSystem, "snomed", snomed]);
  const text = code === undefined ? undefined : stringOf(code, "text");
  const normalizedText = text?.trim().toLowerCase().replaceAll(/\s+/gu, " ");
  return normalizedText !== undefined && normalizedText !== ""
    ? JSON.stringify([healthSystem, "text", normalizedText])
    : JSON.stringify([healthSystem, "row", index]);
}

/** A date as ms, or undefined when it is missing or unparseable. */
function ms(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The dates one row was seen on: its onset and its recorded date. */
function datesOf(item: Item): { value: string; at: number }[] {
  const out: { value: string; at: number }[] = [];
  for (const key of ["onset", "recorded"]) {
    const value = stringOf(item, key);
    const at = ms(value);
    if (value !== undefined && at !== undefined) out.push({ value, at });
  }
  return out;
}

/** One row going into a group: the policy-filtered item and, with `raw: true`, its resource. */
export interface ConditionRow {
  item: unknown;
  raw: RawEntry | undefined;
}

/** One group coming out: the item, and every member's raw resource in member order. */
export interface ConditionGroup {
  item: Item;
  raw: RawEntry[];
}

interface Building {
  rows: { item: Item; raw: RawEntry | undefined }[];
}

/**
 * One item per condition identity (see {@link conditionIdentity}).
 *
 * `rows` must be newest first (the order `collect` produces), so "the latest
 * row" is the first one. Each group carries:
 *
 *  - the representative row's `code`, `clinicalStatus`, `verificationStatus`
 *    and `abatement` -- the problem-list row when there is one, since the
 *    problem list is where a status is kept current; otherwise the latest row
 *    with a status (or the latest row, when none has one);
 *  - `categories` (the union, as codes) and `onProblemList`;
 *  - `firstSeen` / `lastSeen`: the earliest and latest onset or recorded date
 *    across the rows;
 *  - `occurrences` (how many rows), `ids` (their Condition ids) and
 *    `encounterIds` (each visit they name, once, newest first).
 *
 * Groups are ordered by `lastSeen`, newest first; undated groups last.
 */
export function collapseConditions(rows: readonly ConditionRow[]): ConditionGroup[] {
  const groups = new Map<string, Building>();
  for (const [index, row] of rows.entries()) {
    const item = isItem(row.item) ? row.item : {};
    const key = conditionIdentity(item, index);
    const group = groups.get(key) ?? { rows: [] };
    group.rows.push({ item, raw: row.raw });
    groups.set(key, group);
  }
  const built: ConditionGroup[] = Array.from(groups.values(), (group) => buildGroup(group));
  const order = (group: ConditionGroup): number =>
    ms(stringOf(group.item, "lastSeen")) ?? -Infinity;
  // `built` is a fresh array, so sorting it in place mutates
  // nothing shared (`toSorted` is ES2023; the Worker compiles against ES2022).
  // A stable sort: groups seen equally recently keep their first row's order.
  built.sort((a, b) => order(b) - order(a));
  return built;
}

/** Each distinct string, in first-seen order. */
function distinct(values: Iterable<string>): string[] {
  const out: string[] = [...new Set(values)];
  return out;
}

interface Dated {
  value: string;
  at: number;
}

/** The earliest and latest onset or recorded date across the rows. */
function seenRange(items: readonly Item[]): { earliest?: Dated; latest?: Dated } {
  let earliest: Dated | undefined;
  let latest: Dated | undefined;
  const dates = items.flatMap((item) => datesOf(item));
  for (const date of dates) {
    if (earliest === undefined || date.at < earliest.at) earliest = date;
    if (latest === undefined || date.at > latest.at) latest = date;
  }
  return { ...(earliest && { earliest }), ...(latest && { latest }) };
}

/** Every value of one string field across the rows, in row order. */
function valuesOf(items: readonly Item[], key: string): string[] {
  return items.flatMap((item) => {
    const value = stringOf(item, key);
    return value === undefined ? [] : [value];
  });
}

function buildGroup(group: Building): ConditionGroup {
  const items = group.rows.map((row) => row.item);
  const first = items[0] ?? {};
  const onList = (item: Item): boolean =>
    categoriesOf(item).includes("problem-list-item" satisfies ConditionCategory);
  const onProblemList = items.some((item) => onList(item));
  const representative =
    items.find((item) => onList(item)) ??
    items.find((item) => stringOf(item, "clinicalStatus") !== undefined) ??
    first;
  const categories = distinct(items.flatMap((item) => categoriesOf(item)));
  categories.sort((a, b) => a.localeCompare(b));
  const { earliest, latest } = seenRange(items);

  const code = recordOf(representative, "code");
  const clinicalStatus = stringOf(representative, "clinicalStatus");
  const verificationStatus = stringOf(representative, "verificationStatus");
  const abatement = stringOf(representative, "abatement");
  const healthSystem = stringOf(first, "healthSystem");
  const healthSystemId = stringOf(first, "healthSystemId");
  const item: Item = {
    resourceType: "Condition",
    kind: "condition_group",
    ...(healthSystem !== undefined && { healthSystem }),
    ...(healthSystemId !== undefined && { healthSystemId }),
    ...(code !== undefined && { code }),
    categories,
    onProblemList,
    ...(clinicalStatus !== undefined && { clinicalStatus }),
    ...(verificationStatus !== undefined && { verificationStatus }),
    ...(abatement !== undefined && { abatement }),
    ...(earliest !== undefined && { firstSeen: earliest.value }),
    ...(latest !== undefined && { lastSeen: latest.value }),
    occurrences: items.length,
    ids: valuesOf(items, "id"),
    encounterIds: distinct(valuesOf(items, "encounterId")),
  };
  const raw = group.rows.flatMap((row) => (row.raw === undefined ? [] : [row.raw]));
  return { item, raw };
}

export interface ConditionsView {
  /** A clinical status, or `unknown` for rows with none. */
  status?: string | undefined;
  /** Group rows by condition identity. */
  collapse?: boolean | undefined;
}

/**
 * `get_conditions`' reshape: the status filter, then the collapse. Undefined
 * when neither was asked for, so a call without them is exactly the plain list.
 *
 * `total` is the rows the status filter kept -- before any collapse -- and a
 * collapse adds `groups`, the number of items `jq` and `limit` then see.
 */
export function conditionsReshape(
  view: ConditionsView,
): ((rows: readonly ReshapeRow[]) => Reshaped) | undefined {
  const { status, collapse } = view;
  if (status === undefined && collapse !== true) return undefined;
  return (rows) => {
    const warnings: string[] = [];
    let kept: readonly ReshapeRow[] = rows;
    if (status !== undefined) {
      const filtered = filterStatus(rows, status);
      kept = filtered.kept;
      if (filtered.excludedUnknown > 0) {
        warnings.push(`${STATUS_EXCLUDED_UNKNOWN}:${String(filtered.excludedUnknown)}`);
      }
    }
    if (collapse !== true) {
      return {
        items: kept.map((row) => row.item),
        raw: kept.map((row) => row.raw),
        total: kept.length,
        warnings,
      };
    }
    const groups = collapseConditions(kept);
    return {
      items: groups.map((group) => group.item),
      raw: groups.map((group) => group.raw),
      total: kept.length,
      warnings,
      envelope: { groups: groups.length },
    };
  };
}
