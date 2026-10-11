/**
 * Heart rate for the tools, from the per-minute rows wherever a minute is
 * fine enough.
 *
 * The store keeps one sealed row of minute statistics per origin per UTC hour,
 * so a day at one-minute resolution is twenty-four rows and no raw chunk. Two
 * things send a question to the raw records instead, and only for the hours
 * concerned:
 *
 *  - a resolution finer than a minute (`raw`, `5s`);
 *  - a minute whose highest reading is above the artefact rule's upper limit
 *    or whose lowest is below its lower one (`HR_MAX_PLAUSIBLE_BPM` and
 *    `HR_MIN_PLAUSIBLE_BPM` in `worker/src/hc/rules.ts`). The minute row
 *    cannot say which of its samples were implausible, so that hour's records
 *    are read, put through `flagHeartRateArtefacts`, and the minute rebuilt
 *    from what the rule kept.
 *
 * Origins are never blended: two devices worn at once are two series. Unless
 * the caller names origins, a phone's series is the one origin with the most
 * samples in the range.
 */

import { heartRateSamples, minuteSeries, resampleHeartRate } from "../../hc/rollup/hr.ts";
import {
  HR_MAX_PLAUSIBLE_BPM,
  HR_MIN_PLAUSIBLE_BPM,
  flagHeartRateArtefacts,
} from "../../hc/rules.ts";

import { HOUR_MS, MINUTE_MS } from "./time.ts";
import { fileUnder, sortedBy, sortedText } from "./util.ts";

import type { HcReads } from "./reads.ts";
import type { Range } from "./time.ts";
import type { HrMinutePoint, HrPoint, HrResolution, HrSample } from "../../hc/rollup/hr.ts";
import type { HcRecord } from "../../hc/wire.ts";

export const TYPE_HEART_RATE = "HeartRate";

interface OriginSeries<Point> {
  origin: string;
  points: Point[];
}

export interface MinuteRead {
  /** One series per origin read, each in time order. */
  series: OriginSeries<HrMinutePoint>[];
  /** Samples the artefact rule removed. */
  artefactsDropped: number;
  /** Origins that have heart rate in the range but were not asked for or chosen. */
  otherOrigins: number;
}

/** Runs of consecutive hours, as `[fromMs, toMs)` windows. */
function hourRuns(hours: ReadonlySet<number>): Range[] {
  const runs: Range[] = [];
  const ordered = sortedBy(hours, (left, right) => left - right);
  for (const hour of ordered) {
    const last = runs.at(-1);
    if (last?.endMs === hour * HOUR_MS) last.endMs += HOUR_MS;
    else runs.push({ startMs: hour * HOUR_MS, endMs: (hour + 1) * HOUR_MS });
  }
  return runs;
}

const minuteOf = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/**
 * The suspect minutes of one origin, rebuilt from the raw records with the
 * artefact rule applied, and how many samples the rule took out of them.
 */
async function rebuildMinutes(
  reads: HcReads,
  deviceId: string,
  origin: string,
  suspect: ReadonlySet<number>,
): Promise<{ rebuilt: Map<number, HrMinutePoint>; dropped: number }> {
  const hours = new Set<number>();
  for (const minute of suspect) hours.add(Math.floor(minute / HOUR_MS));
  const rebuilt = new Map<number, HrMinutePoint>();
  let dropped = 0;
  for (const run of hourRuns(hours)) {
    const records = await reads.records({
      deviceId,
      type: TYPE_HEART_RATE,
      startMs: run.startMs,
      endMs: run.endMs,
      origins: [origin],
    });
    const { kept, flags } = flagHeartRateArtefacts(records);
    dropped += flags.filter((flag) => suspect.has(minuteOf(flag.t))).length;
    const minutes = minuteSeries(heartRateSamples(kept));
    for (const minute of minutes) {
      if (suspect.has(minute.t)) rebuilt.set(minute.t, minute);
    }
  }
  return { rebuilt, dropped };
}

/**
 * One origin's minute series with every minute that holds an implausible
 * reading replaced by what the artefact rule leaves of it.
 */
async function cleanSuspectMinutes(
  reads: HcReads,
  deviceId: string,
  origin: string,
  points: HrMinutePoint[],
): Promise<{ points: HrMinutePoint[]; dropped: number }> {
  const suspect = new Set<number>();
  for (const point of points) {
    if (point.max > HR_MAX_PLAUSIBLE_BPM || point.min < HR_MIN_PLAUSIBLE_BPM) suspect.add(point.t);
  }
  if (suspect.size === 0) return { points, dropped: 0 };
  const { rebuilt, dropped } = await rebuildMinutes(reads, deviceId, origin, suspect);
  const cleaned: HrMinutePoint[] = [];
  for (const point of points) {
    // A minute that was nothing but artefacts is gone, not zero.
    const minute = suspect.has(point.t) ? rebuilt.get(point.t) : point;
    if (minute !== undefined) cleaned.push(minute);
  }
  return { points: cleaned, dropped };
}

/**
 * The origins to answer with: those asked for, else the one whose series
 * weighs most (ties by name).
 */
function chooseOrigins<Point>(
  byOrigin: ReadonlyMap<string, Point[]>,
  asked: readonly string[] | undefined,
  weigh: (points: readonly Point[]) => number,
): string[] {
  const names = sortedText(byOrigin.keys());
  if (asked !== undefined || names.length < 2) return names;
  let best = names[0] ?? "";
  for (const name of names) {
    if (weigh(byOrigin.get(name) ?? []) > weigh(byOrigin.get(best) ?? [])) best = name;
  }
  return [best];
}

/**
 * Per-minute heart rate of one phone in a range, artefacts removed.
 * `origins` omitted: the one origin with the most samples.
 */
export async function readMinutes(
  reads: HcReads,
  deviceId: string,
  range: Range,
  origins: readonly string[] | undefined,
): Promise<MinuteRead> {
  const rows = await reads.hrMinutes({
    deviceId,
    startMs: range.startMs,
    endMs: range.endMs,
    origins,
  });
  // The minute the range starts in is part of it.
  const fromMs = minuteOf(range.startMs);
  const byOrigin = new Map<string, HrMinutePoint[]>();
  for (const row of rows) {
    for (const { m, n, min, max, mean } of row.minutes) {
      const t = row.hourUtc * HOUR_MS + m * MINUTE_MS;
      if (t >= fromMs && t < range.endMs) fileUnder(byOrigin, row.origin, { t, n, min, max, mean });
    }
  }
  const chosen = chooseOrigins(byOrigin, origins, (points) =>
    points.reduce((sum, point) => sum + point.n, 0),
  );
  const series: OriginSeries<HrMinutePoint>[] = [];
  let artefactsDropped = 0;
  for (const origin of chosen) {
    const points = sortedBy(byOrigin.get(origin) ?? [], (left, right) => left.t - right.t);
    const cleaned = await cleanSuspectMinutes(reads, deviceId, origin, points);
    artefactsDropped += cleaned.dropped;
    series.push({ origin, points: cleaned.points });
  }
  return { series, artefactsDropped, otherOrigins: byOrigin.size - chosen.length };
}

export interface Resampled {
  points: HrPoint[];
  /** Null for `raw`. */
  bucketMs: number | null;
  decimated: boolean;
  decimation: number;
  totalPoints: number;
}

/** Minute points on a grid `widthMs` wide: the mean of the minute means, extremes, sample count. */
function regroup(points: readonly HrMinutePoint[], widthMs: number): HrPoint[] {
  const out: HrPoint[] = [];
  let sum = 0;
  let minutes = 0;
  for (const point of points) {
    const t = Math.floor(point.t / widthMs) * widthMs;
    const last = out.at(-1);
    if (last?.t === t) {
      sum += point.mean;
      minutes += 1;
      last.bpm = sum / minutes;
      last.n += point.n;
      last.min = Math.min(last.min, point.min);
      last.max = Math.max(last.max, point.max);
    } else {
      sum = point.mean;
      minutes = 1;
      out.push({ t, bpm: point.mean, n: point.n, min: point.min, max: point.max });
    }
  }
  return out;
}

/**
 * The bucket widths a decimated series is put on, ms: the widths a person
 * would choose for a chart axis. A series that does not fit `maxPoints` is
 * moved to the first of these that does, so a week of minutes becomes
 * five-minute or fifteen-minute points and never a 5.8-day bucket.
 */
const GRID_LADDER_MS: readonly number[] = [
  ...[1, 2, 5, 10, 15, 30].map((minutes) => minutes * MINUTE_MS),
  ...[1, 2, 3, 6, 12].map((hours) => hours * HOUR_MS),
  ...[1, 2, 7, 14, 28].map((days) => days * 24 * HOUR_MS),
];

/** Past the ladder a width is doubled until the series fits. */
const GRID_GROWTH = 2;

/**
 * The widths to try for a series that does not fit, coarsest last: every rung
 * that is a whole multiple of the resolution asked for and at least `fromMs`
 * wide, then doublings of the last rung without end.
 */
function* widthsFrom(widthMs: number, fromMs: number): Generator<number> {
  let last = widthMs;
  for (const rung of GRID_LADDER_MS) {
    if (rung <= widthMs || rung % widthMs !== 0) continue;
    last = rung;
    if (rung >= fromMs) yield rung;
  }
  for (;;) {
    last *= GRID_GROWTH;
    if (last >= fromMs) yield last;
  }
}

/**
 * A minute series at `widthMs` (a whole number of minutes), made coarser when
 * it does not fit `maxPoints` -- never cut short.
 *
 * The coarser width is the first rung of {@link GRID_LADDER_MS} that fits, a
 * whole multiple of the width asked for. Where to start looking is worked out
 * from the series, not counted up to: no width narrower than the span divided
 * by `maxPoints` can fit, and none that merges fewer points than needed. So a
 * sparse series over years reaches its width in a pass or two instead of
 * trying every factor on the way (each pass reads every point).
 */
export function resampleMinutes(
  points: readonly HrMinutePoint[],
  widthMs: number,
  maxPoints: number,
): Resampled {
  let resampled = regroup(points, widthMs);
  const totalPoints = resampled.length;
  let width = widthMs;
  if (totalPoints > maxPoints) {
    const spanMs = (points.at(-1)?.t ?? 0) - (points[0]?.t ?? 0);
    const least = Math.max(widthMs * Math.ceil(totalPoints / maxPoints), spanMs / maxPoints);
    for (const candidate of widthsFrom(widthMs, least)) {
      width = candidate;
      resampled = regroup(points, width);
      // A grid aligned to the epoch puts everything in one bucket once a
      // bucket is wider than the timeline itself, so this always ends.
      if (resampled.length <= maxPoints) break;
    }
  }
  return {
    points: resampled,
    bucketMs: width,
    decimated: width > widthMs,
    decimation: width / widthMs,
    totalPoints,
  };
}

export interface SampleRead {
  series: OriginSeries<HrSample>[];
  artefactsDropped: number;
  otherOrigins: number;
}

/**
 * Every heart-rate sample of one phone in a range, artefacts removed, from the
 * raw records. `origins` omitted: the one origin with the most samples.
 */
export async function readSamples(
  reads: HcReads,
  deviceId: string,
  range: Range,
  origins: readonly string[] | undefined,
): Promise<SampleRead> {
  const records = await reads.records({
    deviceId,
    type: TYPE_HEART_RATE,
    startMs: range.startMs,
    endMs: range.endMs,
    origins,
  });
  const { kept, flags } = flagHeartRateArtefacts(records);
  const inRange = (t: number): boolean => t >= range.startMs && t < range.endMs;
  const recordsByOrigin = new Map<string, HcRecord[]>();
  for (const record of kept) fileUnder(recordsByOrigin, record.origin, record);
  const byOrigin = new Map<string, HrSample[]>();
  for (const [origin, own] of recordsByOrigin) {
    const samples = heartRateSamples(own).filter((sample) => inRange(sample.t));
    if (samples.length > 0) byOrigin.set(origin, samples);
  }
  const chosen = chooseOrigins(byOrigin, origins, (points) => points.length);
  const shown = new Set(chosen);
  return {
    series: chosen.map((origin) => ({ origin, points: byOrigin.get(origin) ?? [] })),
    artefactsDropped: flags.filter((flag) => shown.has(flag.origin) && inRange(flag.t)).length,
    otherOrigins: byOrigin.size - chosen.length,
  };
}

/** Samples at `raw` or a sub-minute resolution, decimated to `maxPoints` by the rollup module. */
export function resampleSamples(
  samples: readonly HrSample[],
  resolution: HrResolution,
  maxPoints: number,
): Resampled {
  const result = resampleHeartRate(samples, resolution, { maxPoints });
  return {
    points: result.points,
    bucketMs: result.bucketMs,
    decimated: result.decimated,
    decimation: result.decimation,
    totalPoints: result.totalPoints,
  };
}
