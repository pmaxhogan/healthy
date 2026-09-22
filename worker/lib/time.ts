/**
 * Time helpers.
 *
 * Two representations, and only two, so nothing has to guess:
 *   - a **unix second** integer, which is what every D1 timestamp column holds
 *   - an **ISO-8601 instant string** in UTC (`...Z`), which is what FHIR, the
 *     Google Calendar API and the JSON logs speak
 *
 * Milliseconds appear only inside this module and in `ttlMs` arguments.
 *
 * The display timezone is a `settings` row, never a constant here: a default
 * baked into source would leak where the owner lives. Every function that
 * formats for a human therefore takes the zone as an argument.
 */

import { AppError } from "./errors.ts";

/** Seconds in a day. Exported because window arithmetic reads better with it. */
export const DAY_SECONDS = 86_400;

/** Current time as an integer unix second. */
export function nowSeconds(clock: () => number = Date.now): number {
  return Math.floor(clock() / 1000);
}

/** A unix second as an ISO-8601 UTC instant. */
export function toIso(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) {
    throw new AppError("bad_request", "not a finite unix timestamp");
  }
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * An ISO-8601 instant as an integer unix second, truncated towards the past.
 *
 * Throws rather than returning NaN: an unparseable upstream date must fail the
 * resource it came from, not silently become 1970.
 */
export function fromIso(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new AppError("bad_request", "unparseable ISO-8601 instant");
  return Math.floor(ms / 1000);
}

/** True if `iso` parses. Cheap guard for optional FHIR date fields. */
export function isIso(iso: string): boolean {
  return !Number.isNaN(Date.parse(iso));
}

/** `iso` shifted by `minutes` (negative shifts earlier), as an ISO instant. */
export function addMinutes(iso: string, minutes: number): string {
  return toIso(fromIso(iso) + Math.round(minutes * 60));
}

/** `iso` shifted by whole `days`, as an ISO instant. */
export function addDays(iso: string, days: number): string {
  return toIso(fromIso(iso) + days * DAY_SECONDS);
}

const PART_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { ...PART_FORMAT, timeZone }).formatToParts(
      new Date(ms),
    );
  } catch (error) {
    throw new AppError("bad_request", "unknown IANA time zone", undefined, { cause: error });
  }
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  // Some ICU builds render midnight as hour 24 under hour12:false.
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

/** The zone's offset from UTC in ms at the given instant (east of UTC positive). */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Both sides are whole seconds; the millisecond part never moves with a zone.
  return asIfUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The instant at which the local calendar day containing `iso` began in
 * `timeZone`, as an ISO-8601 UTC instant.
 *
 * Two passes: the first converts the local midnight using the offset in force
 * at `iso`, the second re-reads the offset at that candidate. That is what makes
 * the answer right on a day whose offset changed after midnight (a DST
 * transition), where a single-pass conversion is an hour out.
 */
export function startOfDayInZone(iso: string, timeZone: string): string {
  const ms = fromIso(iso) * 1000;
  const local = zonedParts(ms, timeZone);
  const midnightAsIfUtc = Date.UTC(local.year, local.month - 1, local.day);
  const candidate = midnightAsIfUtc - zoneOffsetMs(ms, timeZone);
  const refined = midnightAsIfUtc - zoneOffsetMs(candidate, timeZone);
  return toIso(Math.floor(refined / 1000));
}

/**
 * The local calendar date of `iso` in `timeZone` as `YYYY-MM-DD`.
 *
 * This is the form FHIR search date parameters take (`date=ge2026-01-01`), and
 * it has to be computed in the owner's zone or the window is a day out for
 * anyone east or west of UTC.
 */
export function dateInZone(iso: string, timeZone: string): string {
  const p = zonedParts(fromIso(iso) * 1000, timeZone);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(p.year).padStart(4, "0")}-${pad(p.month)}-${pad(p.day)}`;
}

const DEFAULT_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };

/**
 * Format an instant for a human, in an explicit zone.
 *
 * Defaults to a short date-and-time, which is what the calendar description
 * footer and the admin UI both want. The locale is fixed to en-US so the output
 * does not change with whatever locale the Worker isolate happens to report.
 */
export function formatInZone(
  iso: string,
  timeZone: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const ms = fromIso(iso) * 1000;
  const format = options ?? DEFAULT_FORMAT;
  try {
    return new Intl.DateTimeFormat("en-US", { ...format, timeZone }).format(new Date(ms));
  } catch (error) {
    throw new AppError("bad_request", "unknown IANA time zone", undefined, { cause: error });
  }
}
