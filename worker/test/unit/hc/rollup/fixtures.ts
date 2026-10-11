// Builders for synthetic Health Connect records, shared by the rollup and
// rules tests. Every value a test passes through these is invented; the
// origins are the placeholder package names the project uses everywhere.

import type { HcRecord } from "../../../../src/hc/wire.ts";

export const SECOND = 1000;
export const MIN = 60_000;
export const HOUR = 3_600_000;

/** A UTC midnight, so it is aligned to every bucket width the tests use. */
export const T0 = Date.UTC(2026, 5, 10);

export const WEARABLE = "com.example.wearable";
export const PHONE = "com.example.phone";
export const CUFF = "com.example.cuff";

// Ids only have to be distinct.
const ids = { next: 0 };

function nextId(): string {
  ids.next += 1;
  return `rec-${String(ids.next)}`;
}

/** An instantaneous record. `lastModified` defaults to its time. */
export function instant(
  type: string,
  time: number,
  data: Record<string, unknown>,
  overrides: Partial<HcRecord> = {},
): HcRecord {
  return { id: nextId(), type, origin: WEARABLE, lastModified: time, time, data, ...overrides };
}

/** An interval record. `lastModified` defaults to its end. */
export function interval(
  type: string,
  start: number,
  end: number,
  data: Record<string, unknown>,
  overrides: Partial<HcRecord> = {},
): HcRecord {
  return {
    id: nextId(),
    type,
    origin: WEARABLE,
    lastModified: end,
    start,
    end,
    data,
    ...overrides,
  };
}

/** A HeartRate record whose samples are `[offsetMs from start, bpm]` pairs. */
export function heartRate(
  start: number,
  samples: readonly (readonly [number, number])[],
): HcRecord {
  const last = samples.at(-1)?.[0] ?? 0;
  return interval("HeartRate", start, start + last, {
    samples: samples.map(([offset, bpm]) => ({ t: start + offset, bpm })),
  });
}

/**
 * One heart-rate sample per step from `fromMs`, `count` of them. `bpm` is a
 * constant or a function of the sample's index.
 */
export function steady(
  fromMs: number,
  count: number,
  bpm: number | ((index: number) => number),
  stepMs: number = MIN,
): { t: number; bpm: number }[] {
  return Array.from({ length: count }, (_, index) => ({
    t: fromMs + index * stepMs,
    bpm: typeof bpm === "number" ? bpm : bpm(index),
  }));
}
