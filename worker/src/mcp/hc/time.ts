/**
 * Times in and out of the Health Connect tools.
 *
 * In: `start` and `end` are either a calendar date (`2026-01-31`), meaning
 * that whole local day in the zone the call runs in, or an instant that says
 * its own offset (`2026-01-31T09:00:00-05:00`, `...Z`). A date-time with no
 * offset is refused: it could only be guessed at, and a guess that is an hour
 * out moves a night's sleep into the wrong day. Every range is half-open,
 * `[start, end)`; an `end` given as a date runs to the end of that local day.
 *
 * Out: every instant is ISO-8601 carrying the zone's offset at that instant
 * (`2026-01-31T09:00:00-05:00`), so a string compares correctly within one
 * answer and reads as a wall-clock time.
 *
 * The zone is the owner's sealed `timezone` setting unless the caller passes
 * `tz`. No zone is named anywhere in this module.
 */

import { dayBoundsMs, localDay } from "../../hc/rollup/day.ts";
import { toIsoInZone } from "../../lib/time.ts";

export const SECOND_MS = 1000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
/** Seconds and a fraction are optional; the offset is not. */
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** True for a `YYYY-MM-DD` the calendar has. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** True for a calendar date, or an instant that carries its offset. */
export function isDateOrOffsetInstant(value: string): boolean {
  return isCalendarDate(value) || (INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value)));
}

/** True when the runtime knows `timeZone` as an IANA zone. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export interface RangeInput {
  start: string;
  /** Omitted: now. */
  end?: string | undefined;
  timeZone: string;
  /** Epoch ms. */
  nowMs: number;
}

/** `[startMs, endMs)`, epoch ms. Empty (`endMs <= startMs`) when the arguments say so. */
export interface Range {
  startMs: number;
  endMs: number;
}

/** The half-open range two `start` / `end` arguments name. */
export function parseRange(input: RangeInput): Range {
  const { start, end, timeZone } = input;
  const startMs = isCalendarDate(start) ? dayBoundsMs(start, timeZone).startMs : Date.parse(start);
  if (end === undefined) return { startMs, endMs: input.nowMs };
  const endMs = isCalendarDate(end) ? dayBoundsMs(end, timeZone).endMs : Date.parse(end);
  return { startMs, endMs };
}

/**
 * How long one zone-offset lookup is reused for. Every zone's offset is a
 * whole number of quarter hours and changes on a quarter-hour boundary, so
 * inside one quarter hour the offset is constant.
 */
const OFFSET_SLOT_MS = 15 * MINUTE_MS;

const OFFSET_PATTERN = /([+-])(\d{2}):(\d{2})$/u;

/**
 * Instants written in one zone.
 *
 * `Intl` is asked for an offset once per quarter hour and the rest is
 * arithmetic: a raw heart-rate answer formats tens of thousands of instants,
 * and one formatter call each would dominate the request.
 */
export interface ZoneClock {
  readonly timeZone: string;
  /** ISO-8601 with the zone's offset; milliseconds only when there are any. */
  iso(ms: number): string;
  /** `iso`, or null for null. */
  isoOrNull(ms: number | null | undefined): string | null;
  /** The local calendar date, `YYYY-MM-DD`. */
  day(ms: number): string;
}

export function zoneClock(timeZone: string): ZoneClock {
  const offsets = new Map<number, { ms: number; text: string }>();
  const offsetAt = (ms: number): { ms: number; text: string } => {
    const slot = Math.floor(ms / OFFSET_SLOT_MS);
    const cached = offsets.get(slot);
    if (cached !== undefined) return cached;
    const text = toIsoInZone((slot * OFFSET_SLOT_MS) / SECOND_MS, timeZone);
    const match = OFFSET_PATTERN.exec(text);
    const minutes = match === null ? 0 : Number(match[2]) * 60 + Number(match[3]);
    const offset = {
      ms: (match?.[1] === "-" ? -minutes : minutes) * MINUTE_MS,
      text: match?.[0] ?? "+00:00",
    };
    offsets.set(slot, offset);
    return offset;
  };
  const iso = (ms: number): string => {
    const offset = offsetAt(ms);
    // The wall clock, read off a UTC rendering of the shifted instant.
    const wall = new Date(ms + offset.ms).toISOString();
    const body = ms % SECOND_MS === 0 ? wall.slice(0, 19) : wall.slice(0, 23);
    return `${body}${offset.text}`;
  };
  return {
    timeZone,
    iso,
    isoOrNull: (ms) => (ms === null || ms === undefined ? null : iso(ms)),
    day: (ms) => localDay(ms, timeZone),
  };
}
