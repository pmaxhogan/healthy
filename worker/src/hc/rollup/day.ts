/**
 * Local calendar arithmetic for the Health Connect rollups: which local day an
 * instant falls on, where a local day begins and ends, and how a time range
 * divides into calendar buckets.
 *
 * The zone is always an IANA name handed in by the caller (it is the sealed
 * `timezone` setting). There is no default and no zone literal here, for the
 * reason `lib/time.ts` gives: a zone baked into source says where the owner
 * lives.
 *
 * A local day is NOT 24 hours. It is 23 or 25 across a daylight-saving change
 * (23.5 or 24.5 in a zone that shifts by half an hour), so nothing here adds
 * 86 400 000 to a local midnight: the end of a day is the start of the next
 * calendar day, found independently.
 *
 * ### What a local day is
 *
 * Day D runs from the first instant of D to the first instant of D+1, where
 * "the first instant of D" is the earliest instant at which the wall clock
 * shows date D or a later one. Everything here follows from that one
 * definition, so the functions agree with each other by construction:
 * `localDay(t)` is the day whose bounds contain `t`, consecutive days tile the
 * timeline with no gap and no overlap, and a non-empty range always touches at
 * least one day.
 *
 * That is ordinary local midnight almost always. It also settles the cases
 * where midnight is not ordinary:
 *
 *  - the clocks go forward AT midnight, so 00:00 never happens: the day starts
 *    at the transition (01:00 on the wall clock);
 *  - the clocks go back and 00:00 happens twice: the day starts at the first;
 *  - the clocks go back ACROSS midnight, so the wall-clock date itself runs
 *    backwards (a zone that changed at 00:01 shows 23:01 of the day before a
 *    minute into the new day). The repeated stretch belongs to the day that
 *    had already begun: `localDay` there is NOT the date on the wall clock,
 *    and that day is an hour longer;
 *  - a zone skips a whole calendar date (a date-line move): that date starts
 *    and ends at the same instant, holds no time, and is left out of every
 *    list of days and buckets.
 *
 * Pure: `Intl.DateTimeFormat` and arithmetic, no D1, no `Env`.
 */

import { AppError } from "../../lib/errors.ts";

const MINUTE_MS = 60_000;
/** A civil day on the proleptic UTC calendar. Never used as a local day's length. */
const CIVIL_DAY_MS = 86_400_000;

// One formatter per zone: constructing one costs far more than using it, and a
// multi-year range asks for thousands of local dates.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZone,
    });
  } catch (error) {
    throw new AppError("bad_request", "unknown IANA time zone", undefined, { cause: error });
  }
  formatters.set(timeZone, format);
  return format;
}

/**
 * The local wall clock at `ms`, read as if it were a UTC instant: the "civil"
 * reading. Its difference from `ms` is the zone's offset; its date part is the
 * local date.
 */
function civilMs(ms: number, timeZone: string): number {
  if (!Number.isFinite(ms)) throw new AppError("bad_request", "not a finite epoch-ms instant");
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  // `h23` should never render 24; the modulo is for an ICU build that does.
  return Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour") % 24,
    read("minute"),
    read("second"),
  );
}

/** `YYYY-MM-DD` of a civil instant (a UTC midnight standing for a calendar date). */
function dayLabel(civil: number): string {
  return new Date(civil).toISOString().slice(0, 10);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function floorTo(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

/**
 * `ms` as local ISO-8601 with the zone's offset at that moment, to the second:
 * `2026-04-05T02:00:00+13:00`. The same form as `toIsoInZone` in `lib/time.ts`,
 * built on this module's cached formatter because a fine-grained range asks for
 * one label per bucket.
 */
function localIso(ms: number, timeZone: string): string {
  const civil = civilMs(ms, timeZone);
  const offsetMinutes = Math.round((civil - floorTo(ms, 1000)) / MINUTE_MS);
  const absolute = Math.abs(offsetMinutes);
  const offset = `${offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  return `${new Date(civil).toISOString().slice(0, 19)}${offset}`;
}

/** The zone's offset from UTC at `ms`, in ms (east positive). */
function offsetAt(ms: number, timeZone: string): number {
  return civilMs(ms, timeZone) - floorTo(ms, 1000);
}

/** The date the wall clock shows at `ms`. Not always the local day: see `localDay`. */
function wallDay(ms: number, timeZone: string): string {
  return dayLabel(civilMs(ms, timeZone));
}

/**
 * How far back a clock change can still make the wall-clock date differ from
 * the local day, ms. Larger than any change of offset there has been (the
 * date-line moves were a day), plus slack.
 */
const BACKWARD_REACH_MS = 26 * 3_600_000;

/**
 * The local day `ms` falls on in `timeZone`, as `YYYY-MM-DD`: the day whose
 * `dayBoundsMs` contain it.
 *
 * That is the date on the wall clock, except in the stretch a backward clock
 * change repeats across midnight, which stays in the day already begun. See
 * the module comment.
 */
export function localDay(ms: number, timeZone: string): string {
  const wall = wallDay(ms, timeZone);
  // The wall date can only be behind the local day shortly after the clocks
  // went back, so that is the only time the bounds have to be consulted.
  if (offsetAt(ms - BACKWARD_REACH_MS, timeZone) <= offsetAt(ms, timeZone)) return wall;
  let civil = parseDay(wall);
  while (startOfLocalDay(civil + CIVIL_DAY_MS, timeZone) <= ms) civil += CIVIL_DAY_MS;
  return dayLabel(civil);
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** `YYYY-MM-DD` as the UTC midnight standing for that calendar date. */
function parseDay(day: string): number {
  const match = DAY_PATTERN.exec(day);
  const civil = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
  // The round trip refuses a date the calendar does not have (02-30, month 13).
  if (Number.isNaN(civil) || dayLabel(civil) !== day) {
    throw new AppError("bad_request", "not a YYYY-MM-DD calendar date");
  }
  return civil;
}

/**
 * The first instant at which the wall clock in `timeZone` shows the calendar
 * date `civilDay` (a UTC midnight) or a later one. See the module comment.
 */
function startOfLocalDay(civilDay: number, timeZone: string): number {
  const target = dayLabel(civilDay);
  const shows = (ms: number): boolean => wallDay(ms, timeZone) >= target;
  // Two passes, as `lib/time.ts` does: convert with the offset at a first
  // guess, then again with the offset in force at that guess, which is what
  // makes a day that begins just after a transition come out right.
  const rough = civilDay - (civilMs(civilDay, timeZone) - civilDay);
  let start = civilDay - (civilMs(rough, timeZone) - rough);
  if (!shows(start) || shows(start - 1)) {
    // Midnight is not ordinary here: it was skipped, or it happened twice on
    // the same date. Bisect for the first instant on or after the target date;
    // two civil days either side is wider than any offset change there has been.
    let before = start - 2 * CIVIL_DAY_MS;
    let onOrAfter = start + 2 * CIVIL_DAY_MS;
    while (onOrAfter - before > 1) {
      const middle = before + Math.floor((onOrAfter - before) / 2);
      if (shows(middle)) onOrAfter = middle;
      else before = middle;
    }
    start = onOrAfter;
  }
  // The clocks went back shortly before `start`, by `back`. If the date had
  // already turned before they did, the wall clock first showed it `back`
  // earlier, and what was found above is its second showing.
  const back = offsetAt(start - BACKWARD_REACH_MS, timeZone) - offsetAt(start, timeZone);
  const shownEarlier = back > 0 && shows(start - back) && !shows(start - back - 1);
  return shownEarlier ? start - back : start;
}

/**
 * Where the local day `day` (`YYYY-MM-DD`) begins and ends in `timeZone`, as
 * epoch ms. Half-open: `endMs` is the start of the next calendar day, so the
 * span is 23, 24 or 25 hours (or a half-hour off those) as the zone had it.
 */
export function dayBoundsMs(day: string, timeZone: string): { startMs: number; endMs: number } {
  const civil = parseDay(day);
  return {
    startMs: startOfLocalDay(civil, timeZone),
    endMs: startOfLocalDay(civil + CIVIL_DAY_MS, timeZone),
  };
}

/**
 * True when the calendar date `civilDay` holds any time at all in `timeZone`:
 * false only for a date a zone skipped.
 */
function happened(civilDay: number, timeZone: string): boolean {
  // No change of offset anywhere near it: an ordinary day, and the cheap answer.
  const steady =
    offsetAt(civilDay - BACKWARD_REACH_MS, timeZone) ===
    offsetAt(civilDay + CIVIL_DAY_MS + BACKWARD_REACH_MS, timeZone);
  return (
    steady ||
    startOfLocalDay(civilDay, timeZone) < startOfLocalDay(civilDay + CIVIL_DAY_MS, timeZone)
  );
}

/**
 * Every local day the half-open range `[startMs, endMs)` touches, in order.
 * Never empty.
 *
 * A range that ends exactly at the start of a local day does not touch that
 * day. An instant (`endMs === startMs`, an instantaneous record) touches the
 * one day it falls on, and so does a range given backwards. A calendar date
 * the zone skipped holds no time and is not listed.
 */
export function daysTouched(startMs: number, endMs: number, timeZone: string): string[] {
  const lastMs = endMs > startMs ? endMs - 1 : startMs;
  const first = parseDay(localDay(startMs, timeZone));
  const last = parseDay(localDay(lastMs, timeZone));
  const days: string[] = [];
  for (let civil = first; civil <= last; civil += CIVIL_DAY_MS) {
    // The two ends came from real instants; only a date between them can be one that never was.
    if (civil === first || civil === last || happened(civil, timeZone)) days.push(dayLabel(civil));
  }
  return days;
}

/**
 * A bucket width: a calendar unit, or a fixed number of minutes (`"5min"`,
 * `"15min"`, `"90min"`). `"hour"` is `"60min"`.
 */
export type CalendarBucket = "hour" | "day" | "week" | "month" | "year" | `${number}min`;

/** Day of the week a `week` bucket starts on: 0 is Sunday, 1 Monday ... 6 Saturday. */
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Weeks start on Monday (ISO 8601) unless the caller says otherwise. */
export const DEFAULT_WEEK_START: WeekStart = 1;

export interface CalendarBucketSpan {
  /** Half-open `[startMs, endMs)`, epoch ms. */
  startMs: number;
  endMs: number;
  /** See {@link calendarBuckets} for the form per bucket width. */
  label: string;
}

const MINUTES_PATTERN = /^([1-9]\d*)min$/u;

function fixedMinutes(bucket: string): number | null {
  if (bucket === "hour") return 60;
  const match = MINUTES_PATTERN.exec(bucket);
  return match ? Number(match[1]) : null;
}

/** The civil date that opens the calendar bucket holding the civil date `civil`. */
function bucketFloor(civil: number, bucket: string, weekStart: WeekStart): number {
  const date = new Date(civil);
  switch (bucket) {
    case "day": {
      return civil;
    }
    case "week": {
      return civil - ((date.getUTCDay() - weekStart + 7) % 7) * CIVIL_DAY_MS;
    }
    case "month": {
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    }
    case "year": {
      return Date.UTC(date.getUTCFullYear(), 0, 1);
    }
    default: {
      throw new AppError("bad_request", "unknown bucket width");
    }
  }
}

function bucketNext(civil: number, bucket: string): number {
  const date = new Date(civil);
  switch (bucket) {
    case "day": {
      return civil + CIVIL_DAY_MS;
    }
    case "week": {
      return civil + 7 * CIVIL_DAY_MS;
    }
    case "month": {
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
    default: {
      return Date.UTC(date.getUTCFullYear() + 1, 0, 1);
    }
  }
}

function bucketLabel(civil: number, bucket: string): string {
  const day = dayLabel(civil);
  if (bucket === "month") return day.slice(0, 7);
  return bucket === "year" ? day.slice(0, 4) : day;
}

/**
 * The fixed-width pieces of the local day `[opens, closes)` that touch
 * `[startMs, endMs)`, counted from the day's start. The last is cut short at
 * the day's end.
 */
function piecesOfDay(
  opens: number,
  closes: number,
  startMs: number,
  endMs: number,
  width: number,
  timeZone: string,
): CalendarBucketSpan[] {
  const pieces: CalendarBucketSpan[] = [];
  const from = opens + Math.max(0, floorTo(startMs - opens, width));
  for (let at = from; at < closes && at < endMs; at += width) {
    pieces.push({
      startMs: at,
      endMs: Math.min(at + width, closes),
      label: localIso(at, timeZone),
    });
  }
  return pieces;
}

/**
 * The calendar buckets that the half-open range `[startMs, endMs)` touches, in
 * order. Buckets are WHOLE: the first and last are not clipped to the range,
 * so a caller summing records into them should say when its range cuts one
 * short. Empty when the range is.
 *
 * - `day`, `week`, `month`, `year`: local calendar units, each from the start
 *   of its first local day to the start of the next unit's first local day,
 *   so a day is 23 or 25 hours across a clock change and February has its
 *   leap day. `week` starts on `weekStart`. Labels: `YYYY-MM-DD` (for a week,
 *   its first day), `YYYY-MM`, `YYYY`.
 * - `hour`, `<N>min`: fixed-length pieces of each local day, counted from that
 *   day's start, so they line up with the wall clock and a bucket never
 *   straddles local midnight. A day whose length is not a multiple of the
 *   width (a clock change, or a width that does not divide 24 hours) ends
 *   with one shorter piece. Label: the bucket's start as local ISO-8601 with
 *   the zone's offset at that moment (`YYYY-MM-DDTHH:MM:SS+HH:MM`), which is
 *   what tells the two 01:00s of a fall-back night apart.
 *
 * Note for a caller answering `hour` from the UTC hour rollups: these buckets
 * coincide with UTC hours only in a zone whose offset is a whole number of
 * hours. Check `startMs % 3 600 000 === 0` rather than assuming it.
 */
export function calendarBuckets(
  startMs: number,
  endMs: number,
  bucket: CalendarBucket,
  timeZone: string,
  weekStart: WeekStart = DEFAULT_WEEK_START,
): CalendarBucketSpan[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new AppError("bad_request", "not a finite epoch-ms range");
  }
  if (!Number.isSafeInteger(weekStart) || weekStart < 0 || weekStart > 6) {
    throw new AppError("bad_request", "weekStart is a day of the week, 0 (Sunday) to 6");
  }
  const minutes = fixedMinutes(bucket);
  // Validated before the empty-range return, so a bad width is always refused.
  const unit = minutes === null ? bucket : "day";
  bucketFloor(0, unit, weekStart);

  const spans: CalendarBucketSpan[] = [];
  if (endMs <= startMs) return spans;

  let civil = bucketFloor(parseDay(localDay(startMs, timeZone)), unit, weekStart);
  let opens = startOfLocalDay(civil, timeZone);
  while (opens < endMs) {
    const nextCivil = bucketNext(civil, unit);
    const closes = startOfLocalDay(nextCivil, timeZone);
    // `closes === opens` is a calendar day the zone skipped: no bucket.
    if (closes > opens && closes > startMs) {
      if (minutes === null) {
        spans.push({ startMs: opens, endMs: closes, label: bucketLabel(civil, unit) });
      } else {
        spans.push(...piecesOfDay(opens, closes, startMs, endMs, minutes * MINUTE_MS, timeZone));
      }
    }
    civil = nextCivil;
    opens = closes;
  }
  return spans;
}
