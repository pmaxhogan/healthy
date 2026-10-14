/**
Reading one record type's statistics for a range with as little decryption
as the question allows.

The store keeps three levels of the same numbers: a day rollup per local
day (in the configured zone), an hour rollup per UTC hour, and the raw
records. A bucketed question is answered from the coarsest level whose rows
fall wholly inside one bucket:

 - whole local days, when the answer is in the configured zone, the buckets
   are calendar units and nothing is waiting to be rebuilt: day rollups;
 - every remaining UTC hour that lies inside the range and has no bucket
   boundary strictly inside it: hour rollups;
 - what is left -- the ragged edges of the range, an hour a boundary cuts
   (a zone on a half-hour offset, an `<N>min` bucket): the raw records of
   just those hours, each summarised on its own.

So a year by day is a few hundred rows, a day by hour is twenty-four, and
only a sub-hour question opens chunks -- and then only the range's own.

Everything comes back as "parts": one summary, one origin, one instant that
decides its bucket. A record counts in the bucket its START falls in, whole
(`bucketing: "start_time"`), which is the rule the rollups were built by and
what makes the three levels add up to the same totals.

A query may carry an artefact rule (`cleaner`). A rollup cannot say which of
its values a rule would flag, only -- by its extremes -- that one could be
inside it. So a summary the rule calls suspect is opened one level down, a
day into its hours and an hour into its records, the records are put
through the rule, and the part is rebuilt from what the rule kept. What it
took out is counted in `excluded`, never dropped silently. Only the suspect
hours are opened: a year of heart rate with one bad minute reads one chunk.
*/

import { dayBoundsMs, daysTouched } from "../../hc/rollup/day.ts";
import { rollupBucket } from "../../hc/rollup/hour.ts";
import { recordStartMs } from "../../hc/wire.ts";

import { HOUR_MS } from "./time.ts";
import { listOf } from "./util.ts";

import type { HcReads } from "./reads.ts";
import type { Range } from "./time.ts";
import type { BucketRollup } from "../../hc/rollup/types.ts";
import type { ArtefactFlag } from "../../hc/rules.ts";
import type { HcRecord } from "../../hc/wire.ts";

/** Which level of the store a part was read from. */
export type PartSource = "day_rollup" | "hour_rollup" | "raw";

export interface StatsPart {
  /** The instant that decides the part's bucket: its day's, hour's or record's start. */
  startMs: number;
  /** Where the stretch the part summarises ends; `startMs` for a single record. */
  endMs: number;
  /** The origin app's package name. */
  origin: string;
  rollup: BucketRollup;
  /** The level it was read from. */
  source: PartSource;
}

/** An artefact rule, in the two forms a level-by-level read needs it. */
export interface PartCleaner {
  /** True when a rollup's summary says the rule could fire on something inside it. */
  suspect: (part: StatsPart) => boolean;
  /** The rule itself: the records without what it flags, and the flags. */
  apply: (records: readonly HcRecord[]) => { kept: HcRecord[]; flags: ArtefactFlag[] };
}

/** Values an artefact rule took out, filed where their record is. */
export interface ExcludedValues {
  /** The start of the record the values were in: what decides its bucket. */
  startMs: number;
  origin: string;
  /** Flagged values: samples of a series record, or the record itself. */
  count: number;
}

export interface PartsQuery {
  deviceId: string;
  type: string;
  range: Range;
  /**
  Every bucket boundary, ascending. A part is only read whole from a rollup
  when no boundary falls strictly inside it.
  */
  boundaries: readonly number[];
  /**
  The zone whose local days the day rollups hold, when they may be used:
  the answer is in the configured zone, every boundary is a local midnight,
  and the store has nothing left to rebuild. Null otherwise.
  */
  dayRollupZone: string | null;
  /** Package names. Omitted: every origin. */
  origins?: readonly string[] | undefined;
  /** An artefact rule to apply to the type. Omitted: none. */
  cleaner?: PartCleaner | undefined;
}

export interface PartsResult {
  parts: StatsPart[];
  sources: Set<PartSource>;
  /** What `cleaner` took out. Empty without one. */
  excluded: ExcludedValues[];
}

/** True when some boundary lies strictly between `fromMs` and `toMs`. */
function cutInside(boundaries: readonly number[], fromMs: number, toMs: number): boolean {
  // Binary search for the first boundary after `fromMs`.
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((boundaries[middle] ?? Infinity) <= fromMs) low = middle + 1;
    else high = middle;
  }
  return (boundaries[low] ?? Infinity) < toMs;
}

/** What the query's artefact rule took out of `records`, one entry per record. */
function excludedFrom(
  records: readonly HcRecord[],
  flags: readonly ArtefactFlag[],
): ExcludedValues[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const counts = new Map<string, ExcludedValues>();
  for (const flag of flags) {
    const record = byId.get(flag.recordId);
    if (record === undefined) continue;
    const entry = counts.get(record.id);
    if (entry === undefined) {
      counts.set(record.id, { startMs: recordStartMs(record), origin: record.origin, count: 1 });
    } else {
      entry.count += 1;
    }
  }
  return listOf(counts.values());
}

/**
The raw records that START in `window`, each as its own part, the query's
artefact rule applied. `only` narrows them to the records it accepts.
*/
async function rawParts(
  reads: HcReads,
  query: PartsQuery,
  window: Range,
  result: PartsResult,
  only: (record: HcRecord) => boolean = () => true,
): Promise<void> {
  const read = await reads.records({
    deviceId: query.deviceId,
    type: query.type,
    startMs: window.startMs,
    endMs: window.endMs,
    origins: query.origins,
  });
  // The reader returns everything that overlaps; only what starts here counts here.
  const own = read.filter((record) => {
    const startMs = recordStartMs(record);
    return startMs >= window.startMs && startMs < window.endMs && only(record);
  });
  const cleaned = query.cleaner?.apply(own);
  if (cleaned !== undefined) result.excluded.push(...excludedFrom(own, cleaned.flags));
  const kept = cleaned === undefined ? own : cleaned.kept;
  for (const record of kept) {
    const startMs = recordStartMs(record);
    result.sources.add("raw");
    result.parts.push({
      startMs,
      endMs: startMs,
      origin: record.origin,
      rollup: rollupBucket(query.type, [record]),
      source: "raw",
    });
  }
}

/** `[fromMs, toMs)` from hour rollups where an hour is whole, and raw records elsewhere. */
async function hourParts(
  reads: HcReads,
  query: PartsQuery,
  fromMs: number,
  toMs: number,
  result: PartsResult,
): Promise<void> {
  if (toMs <= fromMs) return;
  const firstHour = Math.ceil(fromMs / HOUR_MS);
  const endHour = Math.floor(toMs / HOUR_MS);
  const whole = new Set<number>();
  for (let hour = firstHour; hour < endHour; hour += 1) {
    if (!cutInside(query.boundaries, hour * HOUR_MS, (hour + 1) * HOUR_MS)) whole.add(hour);
  }

  if (whole.size > 0) {
    const rows = await reads.hourRollups({
      deviceId: query.deviceId,
      type: query.type,
      startMs: firstHour * HOUR_MS,
      endMs: endHour * HOUR_MS,
      origins: query.origins,
    });
    for (const row of rows) {
      if (!whole.has(row.hourUtc)) continue;
      result.sources.add("hour_rollup");
      result.parts.push({
        startMs: row.hourUtc * HOUR_MS,
        endMs: (row.hourUtc + 1) * HOUR_MS,
        origin: row.origin,
        rollup: row.rollup,
        source: "hour_rollup",
      });
    }
  }

  // Everything that is not a whole hour, as runs of adjacent stretches.
  let runStart: number | null = null;
  const flush = async (runEnd: number): Promise<void> => {
    if (runStart === null || runEnd <= runStart) return;
    await rawParts(reads, query, { startMs: runStart, endMs: runEnd }, result);
    runStart = null;
  };
  for (let at = fromMs; at < toMs;) {
    const hour = Math.floor(at / HOUR_MS);
    const next = Math.min((hour + 1) * HOUR_MS, toMs);
    if (whole.has(hour)) await flush(at);
    else runStart ??= at;
    at = next;
  }
  await flush(toMs);
}

/** The first and last local day lying wholly inside the range, or null when none does. */
function wholeDays(
  range: Range,
  timeZone: string,
): { startDay: string; endDay: string; startMs: number; endMs: number } | null {
  const days = daysTouched(range.startMs, range.endMs, timeZone);
  const whole = (
    day: string | undefined,
  ): { day: string; startMs: number; endMs: number } | null => {
    if (day === undefined) return null;
    const bounds = dayBoundsMs(day, timeZone);
    return bounds.startMs >= range.startMs && bounds.endMs <= range.endMs
      ? { day, ...bounds }
      : null;
  };
  // Only the range's first and last day can be cut short by it.
  const first = whole(days[0]) ?? whole(days[1]);
  const last = whole(days.at(-1)) ?? whole(days.at(-2));
  return first === null || last === null || last.endMs <= first.startMs
    ? null
    : { startDay: first.day, endDay: last.day, startMs: first.startMs, endMs: last.endMs };
}

/** The parts `suspect` picks at one level, taken out of the result. */
function takeSuspects(
  result: PartsResult,
  source: PartSource,
  suspect: (part: StatsPart) => boolean,
): StatsPart[] {
  const taken: StatsPart[] = [];
  const left: StatsPart[] = [];
  for (const part of result.parts) {
    (part.source === source && suspect(part) ? taken : left).push(part);
  }
  result.parts = left;
  return taken;
}

/** Runs of adjacent hours, from the hours' starts. */
function hourRuns(starts: readonly number[]): Range[] {
  const ordered = [...new Set(starts)];
  ordered.sort((left, right) => left - right);
  const runs: Range[] = [];
  for (const startMs of ordered) {
    const last = runs.at(-1);
    if (last?.endMs === startMs) last.endMs = startMs + HOUR_MS;
    else runs.push({ startMs, endMs: startMs + HOUR_MS });
  }
  return runs;
}

/**
Open every rollup part the query's artefact rule calls suspect one level
down, until what is left is either beyond suspicion or rebuilt from records
the rule has been through. See the module comment.
*/
async function cleanSuspects(
  reads: HcReads,
  query: PartsQuery,
  result: PartsResult,
): Promise<void> {
  const { cleaner } = query;
  if (cleaner === undefined) return;
  // A suspect day, as that origin's hours: most of them will not be suspect.
  for (const day of takeSuspects(result, "day_rollup", cleaner.suspect)) {
    await hourParts(reads, { ...query, origins: [day.origin] }, day.startMs, day.endMs, result);
  }
  // Suspect hours, as records: one read per run of adjacent hours.
  const hours = takeSuspects(result, "hour_rollup", cleaner.suspect);
  const wanted = new Set(hours.map((part) => `${part.origin}|${String(part.startMs)}`));
  const origins = [...new Set(hours.map((part) => part.origin))];
  const runs = hourRuns(hours.map((part) => part.startMs));
  for (const run of runs) {
    await rawParts(reads, { ...query, origins }, run, result, (record) => {
      const hourMs = Math.floor(recordStartMs(record) / HOUR_MS) * HOUR_MS;
      return wanted.has(`${record.origin}|${String(hourMs)}`);
    });
  }
}

async function readLevels(reads: HcReads, query: PartsQuery, result: PartsResult): Promise<void> {
  const { range } = query;
  if (range.endMs <= range.startMs) return;

  const days = query.dayRollupZone === null ? null : wholeDays(range, query.dayRollupZone);
  if (days === null || query.dayRollupZone === null) {
    await hourParts(reads, query, range.startMs, range.endMs, result);
    return;
  }

  await hourParts(reads, query, range.startMs, days.startMs, result);
  const zone = query.dayRollupZone;
  const rows = await reads.dayRollups({
    deviceId: query.deviceId,
    type: query.type,
    startDay: days.startDay,
    endDay: days.endDay,
    origins: query.origins,
  });
  const bounds = new Map<string, Range>();
  for (const row of rows) {
    let day = bounds.get(row.day);
    if (day === undefined) {
      day = dayBoundsMs(row.day, zone);
      bounds.set(row.day, day);
    }
    result.sources.add("day_rollup");
    result.parts.push({
      startMs: day.startMs,
      endMs: day.endMs,
      origin: row.origin,
      rollup: row.rollup,
      source: "day_rollup",
    });
  }
  await hourParts(reads, query, days.endMs, range.endMs, result);
}

/** Every part of one type in the range, from the coarsest level that is exact. */
export async function readParts(reads: HcReads, query: PartsQuery): Promise<PartsResult> {
  const result: PartsResult = { parts: [], sources: new Set(), excluded: [] };
  await readLevels(reads, query, result);
  await cleanSuspects(reads, query, result);
  return result;
}
