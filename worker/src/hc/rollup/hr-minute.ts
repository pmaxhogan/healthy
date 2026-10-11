/**
 * The per-minute heart-rate row of one (origin, UTC hour): `hc_hr_minute`.
 *
 * ### Which samples a row covers, and the spill rule
 *
 * A row covers exactly the samples whose own time `t` falls in its UTC hour --
 * each sample is filed under its own minute, never under its record's start.
 *
 * That differs from how raw records are stored. A HeartRate record is a series
 * with a start and an end, and it lives in the chunk of its START hour however
 * long it runs, so a record that starts at 10:58 can hold samples timed 11:03.
 * Those samples belong to the 11:00 row, not the 10:00 one.
 *
 * `hrMinutesOfHour` therefore reads samples out of whatever records it is
 * given and keeps only those in the hour asked for. Nothing is lost provided
 * the caller follows two rules:
 *
 *  1. To build the row of hour H, pass every HeartRate record that could hold
 *     a sample in H: the records of chunk H, plus those of any earlier chunk
 *     whose `max_end_ms` reaches into H (the chunk store keeps `max_end_ms`
 *     for exactly this kind of range read).
 *  2. After a chunk changes, rebuild the row of every hour in
 *     `hrHoursTouched(recordsBefore ∪ recordsAfter)`, not only the chunk's own
 *     hour -- that list is where the spill went.
 *
 * A caller that passes only chunk H's records still gets a correct row for
 * every sample it was shown; it just leaves hour H+1's row without the spilled
 * samples until rule 1 is applied there. The raw chunks are never affected.
 *
 * Pure: no D1, no `Env`.
 */

import { heartRateSamples, minuteSeries } from "./hr.ts";
import { sortedBy } from "./stats.ts";

import type { HcRecord } from "../wire.ts";
import type { HrHour } from "./types.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Per-minute n / min / max / mean of the samples that fall in UTC hour
 * `hourUtc` (hours since the epoch, as `hc_chunks.hour_utc`), from the
 * HeartRate records given. Samples outside the hour are ignored here; see the
 * module comment for how the caller reaches them. Minutes with no sample are
 * absent, and minutes are in order.
 */
export function hrMinutesOfHour(records: readonly HcRecord[], hourUtc: number): HrHour {
  const from = hourUtc * HOUR_MS;
  const to = from + HOUR_MS;
  const inHour = heartRateSamples(records).filter((sample) => sample.t >= from && sample.t < to);
  return {
    minutes: minuteSeries(inHour).map(({ t, n, min, max, mean }) => ({
      m: (t - from) / MINUTE_MS,
      n,
      min,
      max,
      mean,
    })),
  };
}

/**
 * Every UTC hour (hours since the epoch) in which the given HeartRate records
 * hold at least one sample, ascending. The hours whose minute rows a change to
 * these records can alter.
 */
export function hrHoursTouched(records: readonly HcRecord[]): number[] {
  const hours = new Set<number>();
  for (const sample of heartRateSamples(records)) hours.add(Math.floor(sample.t / HOUR_MS));
  return sortedBy([...hours], (left, right) => left - right);
}
