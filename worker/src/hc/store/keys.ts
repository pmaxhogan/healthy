/**
The pure half of the Health Connect store: how records are keyed, grouped,
ordered and merged. No D1 and no `Env`, so all of it is unit-tested in plain
Node; the modules beside this one do the reading, sealing and writing.

A record lives in exactly one chunk: (record type, origin app, the UTC hour
its START falls in). Everything here follows from that one rule.
*/

import { recordEndMs, recordStartMs } from "../wire.ts";

import type { HcRecord } from "../wire.ts";

export const HOUR_MS = 3_600_000;

/** Record types the store treats specially. Every other type is just stored. */
export const TYPE_HEART_RATE = "HeartRate";
export const TYPE_SLEEP_SESSION = "SleepSession";
export const TYPE_EXERCISE_SESSION = "ExerciseSession";

/** Where one chunk sits. `originHash` is the blinded package name. */
export interface ChunkKey {
  type: string;
  originHash: string;
  hourUtc: number;
}

/** Hours since the epoch: `hc_chunks.hour_utc`. */
export function hourOf(ms: number): number {
  return Math.floor(ms / HOUR_MS);
}

/**
One string per chunk key, for maps and for AADs. `:` cannot be the separator
a caller splits on (a record type may contain one), so nothing ever parses
this back: it is only compared.
*/
export function keyId(key: ChunkKey): string {
  return `${key.type}:${key.originHash}:${String(key.hourUtc)}`;
}

export function sameKey(left: ChunkKey, right: ChunkKey): boolean {
  return (
    left.type === right.type &&
    left.originHash === right.originHash &&
    left.hourUtc === right.hourUtc
  );
}

/** Code-unit order, not the runtime's locale: the order has to be the same everywhere. */
export function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
An iterable as an array. `Iterator#toArray()` would say the same, but it is
ES2025 and the Worker compiles against the ES2022 lib.
*/
export function listOf<T>(items: Iterable<T>): T[] {
  return [...items];
}

/** A sorted copy; the input is left as it was. */
export function sortedBy<T>(items: Iterable<T>, compare: (left: T, right: T) => number): T[] {
  // eslint-disable-next-line unicorn/no-array-sort -- Array#toSorted is ES2023 and the Worker compiles against the ES2022 lib; this sorts a fresh copy.
  return listOf(items).sort(compare);
}

/**
A chunk's records in their stored order: by start, then by id.

The order is part of the payload, and the payload's digest is how an
unchanged chunk is recognised, so it must not depend on arrival order.
*/
export function sortRecords(records: Iterable<HcRecord>): HcRecord[] {
  return sortedBy(
    records,
    (left, right) => recordStartMs(left) - recordStartMs(right) || compareText(left.id, right.id),
  );
}

/**
One copy per id: the one with the greater `lastModified`, and on a tie the
one that came later in the batch.
*/
export function dedupeUpserts(records: readonly HcRecord[]): HcRecord[] {
  const byId = new Map<string, HcRecord>();
  for (const record of records) {
    const seen = byId.get(record.id);
    if (seen === undefined || record.lastModified >= seen.lastModified) {
      byId.set(record.id, record);
    }
  }
  return listOf(byId.values());
}

/** The upserts of a batch bound for one chunk. `origin` is the package name. */
export interface UpsertGroup {
  type: string;
  origin: string;
  hourUtc: number;
  records: HcRecord[];
}

/**
A batch's upserts by destination chunk, in a fixed order (type, origin,
hour). The order is what makes a position in this list mean the same thing
on every slice that re-reads the batch: the apply cursor is an index into it.
*/
export function groupUpserts(records: readonly HcRecord[]): UpsertGroup[] {
  const groups = new Map<string, UpsertGroup>();
  for (const record of dedupeUpserts(records)) {
    const hourUtc = hourOf(recordStartMs(record));
    // NUL cannot occur in a type, and a JSON string's NUL would only make two
    // origins share a map slot if they were equal anyway.
    const id = `${record.type}\u{0}${record.origin}\u{0}${String(hourUtc)}`;
    const group = groups.get(id);
    if (group === undefined) {
      groups.set(id, { type: record.type, origin: record.origin, hourUtc, records: [record] });
    } else {
      group.records.push(record);
    }
  }
  return sortedBy(
    groups.values(),
    (left, right) =>
      compareText(left.type, right.type) ||
      compareText(left.origin, right.origin) ||
      left.hourUtc - right.hourUtc,
  );
}

/** What merging incoming records into a chunk's stored ones came to. */
export interface MergeResult {
  /** The chunk's records afterwards, in stored order. */
  records: HcRecord[];
  /** Incoming records that are now the stored copy (new, replaced or identical). */
  accepted: HcRecord[];
  /** The accepted ones that are new or differ from what was stored. */
  changed: HcRecord[];
  /** Stored copies an accepted record replaced with different content. */
  replaced: HcRecord[];
}

/**
Merge incoming records into a chunk.

On an id collision the copy with the greater `lastModified` is kept; on a
tie the incoming one is, which makes a replayed batch a no-op rather than a
rejection. An incoming record that loses is simply not in `accepted`.
*/
export function mergeIntoChunk(
  stored: readonly HcRecord[],
  incoming: readonly HcRecord[],
): MergeResult {
  const byId = new Map<string, HcRecord>();
  for (const record of stored) byId.set(record.id, record);
  const accepted: HcRecord[] = [];
  const changed: HcRecord[] = [];
  const replaced: HcRecord[] = [];
  for (const record of incoming) {
    const current = byId.get(record.id);
    if (current !== undefined && current.lastModified > record.lastModified) continue;
    accepted.push(record);
    if (current === undefined) {
      changed.push(record);
    } else if (JSON.stringify(current) !== JSON.stringify(record)) {
      changed.push(record);
      replaced.push(current);
    }
    byId.set(record.id, record);
  }
  return { records: sortRecords(byId.values()), accepted, changed, replaced };
}

/** A chunk's records without the given ids, and the ones that were taken out. */
export function removeFromChunk(
  stored: readonly HcRecord[],
  ids: ReadonlySet<string>,
): { records: HcRecord[]; removed: HcRecord[] } {
  const records: HcRecord[] = [];
  const removed: HcRecord[] = [];
  for (const record of stored) (ids.has(record.id) ? removed : records).push(record);
  return { records, removed };
}

/** The clear time columns of a chunk row. Only meaningful for a non-empty chunk. */
export function chunkExtent(records: readonly HcRecord[]): {
  minStartMs: number;
  maxEndMs: number;
} {
  let minStartMs = Infinity;
  let maxEndMs = -Infinity;
  for (const record of records) {
    minStartMs = Math.min(minStartMs, recordStartMs(record));
    maxEndMs = Math.max(maxEndMs, recordEndMs(record));
  }
  return { minStartMs, maxEndMs };
}

/**
True when a record has anything in the half-open window `[startMs, endMs)`.
An instantaneous record (or a zero-length interval) is in the window its one
instant is in.
*/
export function overlapsWindow(record: HcRecord, startMs: number, endMs: number): boolean {
  const start = recordStartMs(record);
  return start < endMs && Math.max(recordEndMs(record), start + 1) > startMs;
}

/**
Series records with only the samples timed inside their own interval, and
how many samples fell outside it.

Nothing checks a sample's `t` against its record on the way in, and the
store keeps every sample as it arrived. But a per-minute row is filed by the
sample's own time, so a sample claiming an instant its record does not cover
would write a row for an hour the record has nothing to do with. The derived
rows therefore read through this; the raw chunk is never touched.
*/
export function samplesInInterval(records: readonly HcRecord[]): {
  records: HcRecord[];
  outOfInterval: number;
} {
  let outOfInterval = 0;
  const clipped = records.map((record) => {
    const { samples } = record.data;
    if (!Array.isArray(samples)) return record;
    const from = recordStartMs(record);
    const to = recordEndMs(record);
    const inside = (samples as unknown[]).filter((sample) => {
      const t =
        typeof sample === "object" && sample !== null ? (sample as { t?: unknown }).t : null;
      // A sample with no usable time is not this function's to judge.
      return typeof t !== "number" || (t >= from && t <= to);
    });
    if (inside.length === samples.length) return record;
    outOfInterval += samples.length - inside.length;
    return { ...record, data: { ...record.data, samples: inside } };
  });
  return { records: clipped, outOfInterval };
}

// ---------------------------------------------------------------------------
// `hc_dirty` keys. `|` is in neither a record type, a blind nor a date, so a
// key splits back unambiguously.
// ---------------------------------------------------------------------------

const KEY_SEPARATOR = "|";

/** Hours in a UTC day: what one `day` mark covers. */
export const DAY_HOURS = 24;

/** What a `day` mark's key starts with, and the digits its UTC day number is padded to (2,700 years' worth). */
const DAY_KEY_PREFIX = "d";
const DAY_KEY_DIGITS = 6;
/** The part of a `day` mark's key before the separator. It agrees with the two constants above. */
const DAY_KEY_PATTERN = /^d\d{6}$/u;

/** The UTC day (days since the epoch) an hour falls in. */
export function utcDayOf(hourUtc: number): number {
  return Math.floor(hourUtc / DAY_HOURS);
}

/**
A `day` mark: one record type in one UTC day, named by any hour of it. Which
local days that is -- two, in any zone off UTC -- is worked out when the mark
is rebuilt, in the zone configured then.

A UTC day and not an hour: a backfill writes every hour of every day, and a
mark per hour would be two dozen rows for a day that is rebuilt once. The
list a long backfill leaves behind is one row per type and day.

The day comes first and is zero-padded, so the primary key's own order is
time order: the rebuild takes the newest marks first by reading the key
backwards, with no sort.
*/
export function dayMarkKey(type: string, hourUtc: number): string {
  const day = String(utcDayOf(hourUtc)).padStart(DAY_KEY_DIGITS, "0");
  return `${DAY_KEY_PREFIX}${day}${KEY_SEPARATOR}${type}`;
}

/** SQL for `dayMarkKey(record_type, hour_utc)`, for marking straight from a table. */
export const DAY_MARK_KEY_SQL = `'${DAY_KEY_PREFIX}' || printf('%0${String(DAY_KEY_DIGITS)}d', hour_utc / ${String(DAY_HOURS)}) || '${KEY_SEPARATOR}' || record_type`;

/** The type and UTC day a `day` mark names, or null for a key that is not one. */
export function parseDayMarkKey(key: string): { type: string; utcDay: number } | null {
  const parts = key.split(KEY_SEPARATOR);
  const [when, type] = parts;
  if (type === undefined || type === "" || parts.length !== 2) return null;
  return when !== undefined && DAY_KEY_PATTERN.test(when)
    ? { type, utcDay: Number(when.slice(DAY_KEY_PREFIX.length)) }
    : null;
}

/** Consecutive UTC days of one type whose marks are settled together. */
export interface DayRun {
  type: string;
  /** The earliest UTC day of the run. */
  firstDay: number;
  /** How many days it runs for: at least one. */
  days: number;
}

/**
A page of `day` mark keys as the runs to rebuild: per type, consecutive UTC
days together, `maxDays` at most to a run, the newest run first.
`unreadable` are the keys that are not `day` marks at all.

Runs, because neighbouring UTC days share a local day: rebuilt one mark at a
time, every local day of a backfill would be built twice.
*/
export function dayRuns(
  keys: readonly string[],
  maxDays: number,
): { runs: DayRun[]; unreadable: string[] } {
  const byType = new Map<string, Set<number>>();
  const unreadable: string[] = [];
  for (const key of keys) {
    const parsed = parseDayMarkKey(key);
    if (parsed === null) {
      unreadable.push(key);
    } else {
      const days = byType.get(parsed.type) ?? new Set<number>();
      days.add(parsed.utcDay);
      byType.set(parsed.type, days);
    }
  }
  const runs: DayRun[] = [];
  for (const [type, days] of byType) {
    let run: DayRun | null = null;
    const newestFirst = sortedBy(days, (left, right) => right - left);
    for (const day of newestFirst) {
      if (run !== null && day === run.firstDay - 1 && run.days < maxDays) {
        run.firstDay = day;
        run.days += 1;
      } else {
        run = { type, firstDay: day, days: 1 };
        runs.push(run);
      }
    }
  }
  const byEnd = sortedBy(
    runs,
    (left, right) =>
      right.firstDay + right.days - (left.firstDay + left.days) ||
      compareText(left.type, right.type),
  );
  return { runs: byEnd, unreadable };
}

/** An `hr` mark: the per-minute heart-rate row of one origin and UTC hour. */
export function hrMarkKey(originHash: string, hourUtc: number): string {
  return `${originHash}${KEY_SEPARATOR}${String(hourUtc)}`;
}

export function parseHrMarkKey(key: string): { originHash: string; hourUtc: number } | null {
  const parts = key.split(KEY_SEPARATOR);
  const [originHash, hour] = parts;
  if (originHash === undefined || hour === undefined || originHash === "" || hour === "") {
    return null;
  }
  const hourUtc = Number(hour);
  return parts.length === 2 && Number.isSafeInteger(hourUtc) ? { originHash, hourUtc } : null;
}
