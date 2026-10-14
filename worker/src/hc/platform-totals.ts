/**
The platform's own hourly totals (`Agg.<Metric>`), and how to tell one that
no longer agrees with the records it is a total of. Pure: no D1, no `Env`,
so the store (worker/src/hc/store/platform-stale.ts) and the `data_quality`
tool (worker/src/mcp/hc/quality.ts) share one rule.

The phone uploads, beside the records of a type, Health Connect's own
priority-merged total of every UTC hour of it, as one synthetic record a
hour: type `Agg.<Metric>`, id `agg:<Metric>:<hour start, epoch ms>`, and in
`data` the value and the `origins` -- the package names of the apps whose
records went into it. It works a total out again for every hour it knows
changed. An upsert carries its record's times, so those hours are known; a
deletion does not (Health Connect's change feed gives a deleted record's id
and nothing else), so for one the phone can only guess, and an old hour
whose records were deleted keeps a total that still counts them.

Which record type a metric is the total of comes from `PLATFORM_PAIRS`
(worker/src/policy/hc-fields.ts), the one list the policy reads too, and
which must agree with the companion app's `AggMetric`.
*/

import { PLATFORM_PAIRS } from "../policy/hc-fields.ts";

import { recordEndMs, recordStartMs } from "./wire.ts";

import type { HcRecord } from "./wire.ts";

const HOUR_MS = 3_600_000;

/** What every platform-total type name starts with. */
const AGG_TYPE_PREFIX = "Agg.";

/** What every platform-total record id starts with, and what separates its parts. */
const AGG_ID_PREFIX = "agg:";
const AGG_ID_SEPARATOR = ":";

const SOURCE_OF_METRIC: ReadonlyMap<string, string> = new Map(
  PLATFORM_PAIRS.map(([type, metric]) => [metric, type]),
);
const METRIC_OF_SOURCE: ReadonlyMap<string, string> = new Map(PLATFORM_PAIRS);

/** Every record type the platform totals: `Steps`, `Distance`, ... */
export const PLATFORM_SOURCE_TYPES: readonly string[] = PLATFORM_PAIRS.map(([type]) => type);

/** True for a record type the platform keeps an hourly total of. */
export function isPlatformSourceType(type: string): boolean {
  return METRIC_OF_SOURCE.has(type);
}

/** The `Agg.<Metric>` type that totals `sourceType`, or null when there is none. */
export function aggTypeOf(sourceType: string): string | null {
  const metric = METRIC_OF_SOURCE.get(sourceType);
  return metric === undefined ? null : `${AGG_TYPE_PREFIX}${metric}`;
}

/** The record type an `Agg.<Metric>` type is the total of; null for anything else. */
export function sourceOfAggType(type: string): string | null {
  return type.startsWith(AGG_TYPE_PREFIX)
    ? (SOURCE_OF_METRIC.get(type.slice(AGG_TYPE_PREFIX.length)) ?? null)
    : null;
}

/** One hour of one type's platform total. */
export interface PlatformHour {
  /** The record type the total is of: `Steps`, not `Agg.Steps`. */
  sourceType: string;
  /** Hours since the epoch. */
  hourUtc: number;
}

/** One string per `PlatformHour`, for sets. `|` is in no record type. */
export function platformHourKey(hour: PlatformHour): string {
  return `${hour.sourceType}|${String(hour.hourUtc)}`;
}

/**
The hour a platform-total record id names, or null for an id that is not
one. Deletes are ids alone, and this is how one is recognised as the
deletion of an hour's total: the phone deletes the record of an hour that
has no total any more.
*/
export function parseAggId(id: string): PlatformHour | null {
  if (!id.startsWith(AGG_ID_PREFIX)) return null;
  const parts = id.slice(AGG_ID_PREFIX.length).split(AGG_ID_SEPARATOR);
  const [metric, hourMs] = parts;
  if (metric === undefined || hourMs === undefined || parts.length !== 2) return null;
  const sourceType = SOURCE_OF_METRIC.get(metric);
  if (sourceType === undefined || !/^\d{1,16}$/u.test(hourMs)) return null;
  const ms = Number(hourMs);
  return ms % HOUR_MS === 0 ? { sourceType, hourUtc: ms / HOUR_MS } : null;
}

/** The hour an `Agg.<Metric>` upsert is the total of, or null for any other record. */
export function aggRecordHour(record: HcRecord): PlatformHour | null {
  const sourceType = sourceOfAggType(record.type);
  return sourceType === null
    ? null
    : { sourceType, hourUtc: Math.floor(recordStartMs(record) / HOUR_MS) };
}

/**
Every hour whose platform total a batch carries, upserted or deleted, by
`platformHourKey`. A batch that carries an hour's total has it as Health
Connect worked it out when the phone built the batch -- after it had read
every record change the batch also carries -- so nothing in that batch makes
that hour's total stale.
*/
export function carriedPlatformHours(batch: {
  upserts: readonly HcRecord[];
  deletes: readonly string[];
}): Set<string> {
  const carried = new Set<string>();
  for (const record of batch.upserts) {
    const hour = aggRecordHour(record);
    if (hour !== null) carried.add(platformHourKey(hour));
  }
  for (const id of batch.deletes) {
    const hour = parseAggId(id);
    if (hour !== null) carried.add(platformHourKey(hour));
  }
  return carried;
}

/**
The longest stretch of one record whose hours are marked stale when it goes.
Health Connect divides an interval record among every hour it spans, so a
record's deletion changes the total of each of them -- but a record claiming
to run for years would name tens of thousands of hours, all held in memory
and written in one transaction, for a share of each that rounds to nothing.
A month: longer than any record a device writes (a day's total written as one
record is a day), and the most hours the phone asks Health Connect for in one
call. What lies beyond it of such a record is not marked; the `data_quality`
finding below still names any such hour left with no record at all.
*/
export const MAX_MARKED_SPAN_MS = 31 * 24 * HOUR_MS;

/**
The UTC hours a record overlaps, `[start, end)`: the hours whose platform
total it is part of. An instant, or a record whose end is not after its
start, is in the hour it starts in. Bounded by `MAX_MARKED_SPAN_MS`.
*/
export function hoursOfRecord(record: HcRecord): number[] {
  const startMs = recordStartMs(record);
  const endMs = Math.min(recordEndMs(record), startMs + MAX_MARKED_SPAN_MS);
  const first = Math.floor(startMs / HOUR_MS);
  const last = endMs > startMs ? Math.floor((endMs - 1) / HOUR_MS) : first;
  const hours: number[] = [];
  for (let hour = first; hour <= last; hour += 1) hours.push(hour);
  return hours;
}

// ---------------------------------------------------------------------------
// Telling a stale total from the records.
// ---------------------------------------------------------------------------

/**
Which apps have records of a type in which hours: by hour, the set of their
keys. A key is whatever both sides of the comparison agree on -- a package
name for the `data_quality` tool, which reads opened rows, and the blinded
`origin_hash` for the store's scan, which reads clear columns only.
*/
export type Presence = Map<number, Set<string>>;

/** Note that `origin` has a record over `[startMs, endMs)`, clipped to `[fromHour, toHour)`. */
export function addPresence(
  presence: Presence,
  origin: string,
  span: { startMs: number; endMs: number },
  window: { fromHour: number; toHour: number },
): void {
  const first = Math.max(window.fromHour, Math.floor(span.startMs / HOUR_MS));
  const end =
    span.endMs > span.startMs
      ? Math.floor((span.endMs - 1) / HOUR_MS)
      : Math.floor(span.startMs / HOUR_MS);
  const last = Math.min(window.toHour - 1, end);
  for (let hour = first; hour <= last; hour += 1) {
    let origins = presence.get(hour);
    if (origins === undefined) {
      origins = new Set();
      presence.set(hour, origins);
    }
    origins.add(origin);
  }
}

/** One stored hour of a platform total, as the rule reads it. */
export interface StoredTotal {
  hourUtc: number;
  /** The apps the platform says it counted, as keys of the same kind as the presence. */
  origins: readonly string[];
}

/** Why an hour's total no longer agrees with the records. Stable strings: they are emitted. */
type StaleReason = "no_records";

/** An hour whose stored total counts something the store does not hold. */
export interface StaleTotal {
  hourUtc: number;
  reason: StaleReason;
  /** The origins the total names: none of them has a record of the type in the hour. */
  missing: string[];
}

/**
The stored totals that have a figure in an hour where the type has no
record at all.

That is what a total looks like once every record it counted was deleted:
the store took the deletion, and the total from before it is still there.
It can also be a total over records that never arrived (refused by the
server, say); either way the hour's total and its records disagree, and
working the total out again is what settles it.

Only that, and not "the total names an app with no record in the hour",
although a total does carry the apps it counted (`data.origins`). Health
Connect's list is not the hour's: a total it has just worked out, for an
hour with records of one app only, names every app with records anywhere in
the span the phone asked about (seen on the owner's phone, 2026-10-14, for
hours re-fetched minutes before). Held to the hour, the list made a fresh
total look stale, and the phone would have been sent to fetch it again
every time the scan ran. So a total that still counts a deleted app in an
hour another app also recorded in cannot be told from the stored rows; the
marks the apply writes as it takes the deletion are what find those
(worker/src/hc/store/platform-stale.ts).
*/
export function staleTotals(totals: readonly StoredTotal[], presence: Presence): StaleTotal[] {
  const stale: StaleTotal[] = [];
  for (const total of totals) {
    const present = presence.get(total.hourUtc);
    if (present === undefined || present.size === 0) {
      stale.push({ hourUtc: total.hourUtc, reason: "no_records", missing: [...total.origins] });
    }
  }
  return stale;
}

/** The origins a stored `Agg.<Metric>` record says its total counted: `data.origins`. */
export function totalOrigins(record: HcRecord): string[] {
  const { origins } = record.data;
  return Array.isArray(origins)
    ? origins.filter((origin): origin is string => typeof origin === "string")
    : [];
}
