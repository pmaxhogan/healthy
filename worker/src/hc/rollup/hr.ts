/**
 * Heart-rate helpers shared by the rollups and the query tools: flattening
 * HeartRate records into samples, the per-minute series, resampling to a
 * requested resolution, and finding events (sustained rises) in a minute
 * series.
 *
 * Pure: no D1, no `Env`. Times are epoch milliseconds throughout.
 */

import { AppError } from "../../lib/errors.ts";

import { lowerBound, quantileOfSorted, sortedBy } from "./stats.ts";

import type { HcRecord } from "../wire.ts";
import type { HrHour } from "./types.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** One heart-rate reading. */
export interface HrSample {
  t: number;
  bpm: number;
}

/** One minute of heart rate on the absolute timeline. */
export interface HrMinutePoint {
  /** Start of the minute, epoch ms. */
  t: number;
  /** Samples in the minute. */
  n: number;
  min: number;
  max: number;
  /** Plain mean of the minute's samples. */
  mean: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function byTime(left: { t: number }, right: { t: number }): number {
  return left.t - right.t;
}

/**
 * Every sample of the given HeartRate records, in time order.
 *
 * Tolerant: a record with no `samples` list, and a sample without a finite
 * `t` and `bpm`, are skipped. Nothing else is filtered here -- an implausible
 * reading is the artefact rules' business (`../rules.ts`), at query time.
 */
export function heartRateSamples(records: readonly HcRecord[]): HrSample[] {
  const samples: HrSample[] = [];
  for (const record of records) {
    const list = record.data.samples;
    if (!Array.isArray(list)) continue;
    for (const sample of list as unknown[]) {
      if (!isObject(sample)) continue;
      const { t, bpm } = sample;
      if (typeof t !== "number" || typeof bpm !== "number") continue;
      if (Number.isFinite(t) && Number.isFinite(bpm)) samples.push({ t, bpm });
    }
  }
  return sortedBy(samples, byTime);
}

/**
 * Samples grouped by the UTC minute they fall in, in time order. Minutes with
 * no sample are absent. The input need not be sorted.
 */
export function minuteSeries(samples: readonly HrSample[]): HrMinutePoint[] {
  const minutes = new Map<number, { n: number; sum: number; min: number; max: number }>();
  for (const { t, bpm } of samples) {
    const minute = Math.floor(t / MINUTE_MS) * MINUTE_MS;
    const current = minutes.get(minute);
    if (current === undefined) minutes.set(minute, { n: 1, sum: bpm, min: bpm, max: bpm });
    else {
      current.n += 1;
      current.sum += bpm;
      if (bpm < current.min) current.min = bpm;
      if (bpm > current.max) current.max = bpm;
    }
  }
  return sortedBy(
    [...minutes].map(([t, { n, sum, min, max }]) => ({ t, n, min, max, mean: sum / n })),
    byTime,
  );
}

/** One stored `hc_hr_minute` row put back on the absolute timeline. */
export function hrHourToPoints(hourUtc: number, hour: HrHour): HrMinutePoint[] {
  return sortedBy(
    hour.minutes.map(({ m, n, min, max, mean }) => ({
      t: hourUtc * HOUR_MS + m * MINUTE_MS,
      n,
      min,
      max,
      mean,
    })),
    byTime,
  );
}

/**
 * Summary of the samples in `[startMs, endMs]`, or null when there are none.
 *
 * `min`, `max` and `n` are over the samples. `mean` is the mean of the
 * per-minute means, not of the samples: a wearable samples every second or so
 * while it thinks its wearer is active and far less often otherwise, so a plain
 * mean of samples would weight the busy minutes many times over.
 */
export function summariseHeartRate(
  samples: readonly HrSample[],
  startMs: number,
  endMs: number,
): { min: number; mean: number; max: number; n: number } | null {
  const inside = samples.filter((sample) => sample.t >= startMs && sample.t <= endMs);
  const minutes = minuteSeries(inside);
  if (minutes.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const minute of minutes) {
    if (minute.min < min) min = minute.min;
    if (minute.max > max) max = minute.max;
    sum += minute.mean;
  }
  return { min, mean: sum / minutes.length, max, n: inside.length };
}

/** The resolutions a heart-rate series can be asked for. */
export type HrResolution = "raw" | "5s" | "1min" | "5min" | "1h";

/** Bucket width per resolution, ms. `raw` has none. */
export const HR_RESOLUTION_MS: Readonly<Record<Exclude<HrResolution, "raw">, number>> = {
  "5s": 5000,
  "1min": MINUTE_MS,
  "5min": 5 * MINUTE_MS,
  "1h": HOUR_MS,
};

/**
 * How long one sample is taken to stand for when no other follows it. Ten
 * minutes: a wearable's slowest background rate is a reading every several
 * minutes, so anything longer than this is a gap (the watch was off the
 * wrist), not a steady heart rate, and must not be credited to the last
 * reading before it.
 */
export const HR_SAMPLE_HOLD_MAX_MS = 10 * MINUTE_MS;

export interface HrPoint {
  /** Start of the bucket (for `raw`, the sample's own time), epoch ms. */
  t: number;
  /** Time-weighted mean of the bucket; for `raw`, the reading itself. */
  bpm: number;
  /** Samples behind the point. */
  n: number;
  min: number;
  max: number;
}

export interface HrResampled {
  /** The resolution asked for. */
  resolution: HrResolution;
  /**
   * The bucket width actually used, ms: the resolution's own, times
   * `decimation`. Null for `raw`, whose points are not on a grid.
   */
  bucketMs: number | null;
  points: HrPoint[];
  /** True when `maxPoints` forced a coarser result than the resolution asked for. */
  decimated: boolean;
  /**
   * 1 when not decimated. Otherwise the factor: each point covers this many
   * buckets of the requested resolution (for `raw`, this many consecutive
   * samples).
   */
  decimation: number;
  /** Points there would have been without `maxPoints`. */
  totalPoints: number;
  /** Samples read. */
  samples: number;
}

/** Weighted points on a fixed grid. `sorted` must be in time order. */
function bucketed(sorted: readonly HrSample[], width: number): HrPoint[] {
  interface Running {
    n: number;
    weighted: number;
    weight: number;
    min: number;
    max: number;
  }
  // Filled in time order, and a Map keeps insertion order, so no sort is needed.
  const buckets = new Map<number, Running>();
  let tiedUntil = 0;
  let held = 0;
  for (const [index, sample] of sorted.entries()) {
    const start = Math.floor(sample.t / width) * width;
    if (index >= tiedUntil) {
      // Readings at one instant share the stretch that instant stands for.
      tiedUntil = index + 1;
      while (sorted[tiedUntil]?.t === sample.t) tiedUntil += 1;
      // A reading stands until the next one, the end of its bucket, or the
      // hold limit, whichever comes first. The next reading counts even when
      // it belongs to the following bucket. Always more than zero.
      const next = sorted[tiedUntil]?.t ?? Infinity;
      const stood = Math.min(next, start + width, sample.t + HR_SAMPLE_HOLD_MAX_MS) - sample.t;
      held = stood / (tiedUntil - index);
    }
    let bucket = buckets.get(start);
    if (bucket === undefined) {
      bucket = { n: 0, weighted: 0, weight: 0, min: Infinity, max: -Infinity };
      buckets.set(start, bucket);
    }
    bucket.n += 1;
    bucket.weighted += sample.bpm * held;
    bucket.weight += held;
    bucket.min = Math.min(bucket.min, sample.bpm);
    bucket.max = Math.max(bucket.max, sample.bpm);
  }
  return [...buckets].map(([t, { n, weighted, weight, min, max }]) => ({
    t,
    bpm: weighted / weight,
    n,
    min,
    max,
  }));
}

/** Every `factor` consecutive raw samples as one point: plain mean, true extremes. */
function grouped(sorted: readonly HrSample[], factor: number): HrPoint[] {
  const points: HrPoint[] = [];
  for (let from = 0; from < sorted.length; from += factor) {
    const group = sorted.slice(from, from + factor);
    const first = group[0];
    if (first === undefined) break;
    let sum = 0;
    let min = first.bpm;
    let max = first.bpm;
    for (const { bpm } of group) {
      sum += bpm;
      if (bpm < min) min = bpm;
      if (bpm > max) max = bpm;
    }
    points.push({ t: first.t, bpm: sum / group.length, n: group.length, min, max });
  }
  return points;
}

/** How much wider the grid is made on each pass that still does not fit `maxPoints`. */
const RESAMPLE_GROWTH = 1.25;

/**
 * Heart-rate samples at a requested resolution.
 *
 * `raw` returns the samples as they are, in time order. Every other resolution
 * puts them on a fixed grid aligned to the epoch and gives each non-empty
 * bucket a TIME-WEIGHTED mean: each reading counts for as long as it stood
 * (see {@link HR_SAMPLE_HOLD_MAX_MS}), so ten minutes sampled every second and
 * fifty sampled every five minutes contribute to an hour in proportion to
 * their length, not to their sample counts. `min`, `max` and `n` are over the
 * bucket's samples. Empty buckets are absent, not interpolated.
 *
 * `maxPoints` is the caller's ceiling, never applied unless passed. When the
 * result would exceed it, the series is made coarser rather than cut short:
 * the grid is widened by a whole factor that fits (and recomputed from the
 * samples, so the means stay time-weighted and no reading is dropped); for
 * `raw`, consecutive samples are grouped. The result says so in `decimated`,
 * `decimation`, `bucketMs` and `totalPoints`.
 *
 * The factor is found from the series' span, not by counting up, so it is a
 * good fit rather than provably the smallest. One case cannot be met at all:
 * the grid is aligned to the epoch, so readings either side of a line every
 * width shares stay in two buckets however wide the buckets grow. The search
 * stops once a bucket is wider than the whole timeline to that point and
 * returns what it has -- check `points.length`, not only `maxPoints`.
 */
export function resampleHeartRate(
  samples: readonly HrSample[],
  resolution: HrResolution,
  options: { maxPoints?: number } = {},
): HrResampled {
  const { maxPoints } = options;
  if (maxPoints !== undefined && (!Number.isSafeInteger(maxPoints) || maxPoints < 1)) {
    throw new AppError("bad_request", "maxPoints is a positive integer");
  }
  const sorted = sortedBy(samples, byTime);

  if (resolution === "raw") {
    const total = sorted.length;
    const factor = maxPoints === undefined || total <= maxPoints ? 1 : Math.ceil(total / maxPoints);
    return {
      resolution,
      bucketMs: null,
      points: grouped(sorted, factor),
      decimated: factor > 1,
      decimation: factor,
      totalPoints: total,
      samples: total,
    };
  }

  const width = HR_RESOLUTION_MS[resolution];
  let points = bucketed(sorted, width);
  const totalPoints = points.length;
  let factor = 1;
  if (maxPoints !== undefined && totalPoints > maxPoints) {
    const first = sorted[0]?.t ?? 0;
    const last = sorted.at(-1)?.t ?? 0;
    // Two lower bounds: enough to merge the points there are, and wide enough
    // that the span itself fits. Starting from the larger skips straight past
    // the factors that could never work (a sparse series at a fine resolution
    // needs thousands), and growing by a quarter each time gets to one that
    // does in a handful of passes.
    factor = Math.max(
      Math.ceil(totalPoints / maxPoints),
      Math.ceil((last - first) / (width * maxPoints)),
    );
    points = bucketed(sorted, width * factor);
    const reach = Math.max(Math.abs(first), Math.abs(last));
    while (points.length > maxPoints && width * factor <= reach) {
      factor = Math.max(factor + 1, Math.ceil(factor * RESAMPLE_GROWTH));
      points = bucketed(sorted, width * factor);
    }
  }
  return {
    resolution,
    bucketMs: width * factor,
    points,
    decimated: factor > 1,
    decimation: factor,
    totalPoints,
    samples: sorted.length,
  };
}

export interface HrEventOptions {
  /** How far above its baseline the heart rate must rise to open an event, bpm. */
  minDeltaBpm: number;
  /** Length of the look-back window the baseline is taken from, seconds. */
  windowS: number;
  /** How long the rise must last to count, seconds. */
  sustainS: number;
}

export interface HrEvent {
  /** Start of the first minute at or above the rise threshold. */
  startMs: number;
  /** End of the last minute still elevated. */
  endMs: number;
  /** Start of the minute with the highest mean. */
  peakMs: number;
  /** The baseline the event rose from: see {@link HR_EVENT_BASELINE_QUANTILE}. */
  baselineBpm: number;
  /** The highest minute mean of the event. */
  peakBpm: number;
  /** `peakBpm` minus `baselineBpm`. */
  deltaBpm: number;
  /** From the start of the event to the start of its peak minute, seconds. */
  timeToPeakS: number;
  durationS: number;
}

/**
 * The baseline is this quantile of the quiet minutes in the look-back window.
 * Low, not the median: on the way up a slow climb half the window is already
 * elevated, and a median would follow the climb and never see it as a rise.
 * The tenth percentile is the level the heart rate was resting at without
 * being the single lowest minute.
 */
export const HR_EVENT_BASELINE_QUANTILE = 0.1;

/**
 * A baseline needs this many quiet minutes in its window. Fewer, and one odd
 * minute would set it.
 */
export const HR_EVENT_MIN_BASELINE_MINUTES = 3;

/**
 * Once open, an event lasts while the heart rate stays above this fraction of
 * `minDeltaBpm` over the baseline. Half: a rise that dips for a minute on its
 * way up or down is one event, not two, but one that falls most of the way
 * back is over.
 */
export const HR_EVENT_HOLD_FRACTION = 0.5;

/**
 * A hole in the minute series longer than this ends an event. Two minutes
 * allows one missing minute; beyond that nothing says the rise continued.
 */
export const HR_EVENT_MAX_GAP_MS = 2 * MINUTE_MS;

interface MinuteMean {
  t: number;
  mean: number;
}

/**
 * The event that opens at `points[from]`: how far it runs while each minute
 * stays at or above `floor` with no gap too long, its peak, and the index
 * scanning resumes at.
 */
function elevatedRun(
  points: readonly MinuteMean[],
  from: number,
  floor: number,
): { peak: MinuteMean; last: MinuteMean; next: number } {
  let peak = points[from] ?? { t: 0, mean: 0 };
  let last = peak;
  let next = from + 1;
  for (; next < points.length; next += 1) {
    const point = points[next];
    if (point === undefined || point.t - last.t > HR_EVENT_MAX_GAP_MS || point.mean < floor) break;
    if (point.mean > peak.mean) peak = point;
    last = point;
  }
  return { peak, last, next };
}

/**
 * The quiet minutes of the last `windowMs`, kept in value order as the scan
 * moves on, so the baseline costs a lookup rather than a sort of the window at
 * every minute.
 */
class BaselineWindow {
  private readonly windowMs: number;
  private readonly admitted: MinuteMean[] = [];
  private head = 0;
  private readonly values: number[] = [];

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /** Add a minute that was not part of an event. Minutes arrive in time order. */
  admit(point: MinuteMean): void {
    this.admitted.push(point);
    this.values.splice(lowerBound(this.values, point.mean), 0, point.mean);
  }

  /** The baseline for a minute at `t`, or null with too few quiet minutes before it. */
  baselineAt(t: number): number | null {
    for (;;) {
      const oldest = this.admitted[this.head];
      if (oldest === undefined || oldest.t >= t - this.windowMs) break;
      this.values.splice(lowerBound(this.values, oldest.mean), 1);
      this.head += 1;
    }
    return this.values.length >= HR_EVENT_MIN_BASELINE_MINUTES
      ? quantileOfSorted(this.values, HR_EVENT_BASELINE_QUANTILE)
      : null;
  }
}

/**
 * Sustained rises in a per-minute heart-rate series.
 *
 * For each minute in turn, the baseline is the
 * {@link HR_EVENT_BASELINE_QUANTILE} quantile of the QUIET minute means in the
 * `windowS` seconds before it -- quiet meaning not part of an event already
 * opened, whether that event was reported or dropped as too short. (Were the
 * event's own minutes allowed in, the window after a rise would be full of it,
 * and a second rise minutes later would have nothing to rise from.) There
 * must be at least {@link HR_EVENT_MIN_BASELINE_MINUTES} of them, else that
 * minute cannot open an event.
 *
 * A minute whose mean is `minDeltaBpm` or more above its baseline opens an
 * event; the baseline is then frozen, and the event runs on through every
 * following minute that stays above baseline plus
 * {@link HR_EVENT_HOLD_FRACTION} of `minDeltaBpm`, until one does not or the
 * series has a gap longer than {@link HR_EVENT_MAX_GAP_MS}. It is reported
 * when it lasted `sustainS` or longer; a shorter one is dropped, and scanning
 * resumes after it either way.
 *
 * A climb is seen when it gains `minDeltaBpm` within about `windowS`; one
 * slower than that is, by this definition, a drift and not an event.
 *
 * The series is `minuteSeries()` output or stored minute rows through
 * `hrHourToPoints()`; it need not be sorted.
 */
export function detectHrEvents(
  series: readonly { t: number; mean: number }[],
  options: HrEventOptions,
): HrEvent[] {
  const { minDeltaBpm, windowS, sustainS } = options;
  // Written as "is a usable number", so NaN is refused along with the rest.
  const usable = minDeltaBpm > 0 && windowS > 0 && sustainS >= 0;
  if (!usable) {
    throw new AppError(
      "bad_request",
      "minDeltaBpm and windowS are positive, sustainS is not negative",
    );
  }
  const points = sortedBy(series, byTime);
  const quiet = new BaselineWindow(windowS * 1000);
  const events: HrEvent[] = [];
  let index = 0;
  while (index < points.length) {
    const opener = points[index];
    if (opener === undefined) break;
    const baseline = quiet.baselineAt(opener.t);
    if (baseline === null || opener.mean - baseline < minDeltaBpm) {
      quiet.admit(opener);
      index += 1;
      continue;
    }
    const run = elevatedRun(points, index, baseline + minDeltaBpm * HR_EVENT_HOLD_FRACTION);
    const endMs = run.last.t + MINUTE_MS;
    if (endMs - opener.t >= sustainS * 1000) {
      events.push({
        startMs: opener.t,
        endMs,
        peakMs: run.peak.t,
        baselineBpm: baseline,
        peakBpm: run.peak.mean,
        deltaBpm: run.peak.mean - baseline,
        timeToPeakS: (run.peak.t - opener.t) / 1000,
        durationS: (endMs - opener.t) / 1000,
      });
    }
    // The event's minutes are never admitted to the baseline window.
    index = run.next;
  }
  return events;
}
