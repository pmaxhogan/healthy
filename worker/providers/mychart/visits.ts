/**
 * Turn the portal's upcoming-visits JSON into something the calendar sync can map.
 *
 * Three things here are worth knowing before changing anything.
 *
 * **Field names are read from a candidate list, not assumed.** The research this
 * was built from documents what the payload *contains*, not what the keys are
 * called, so `wire.ts` lists the plausible names per field and the first one
 * present wins. A name that is missing degrades to an absent optional field.
 *
 * **Status comes from a priority order, not from a single flag.** The payload
 * sets several status booleans at once and they contradict each other; one of
 * them (`IsPastVisit`) is documented as simply always wrong. So the status is
 * the highest-priority flag that is true and nothing else, and `scheduled` is
 * the floor. `wire.ts` holds the order, which is the documented part.
 *
 * **A payload with rows but no parseable visit is a failure, not an empty day.**
 * If the candidate key lists ever stop matching -- a release renames things --
 * the honest answer is `portal_parse_failed`, not "you have no appointments",
 * because the second one silently ghosts every event on the owner's calendar.
 *
 * **Place is nested, and video is not a boolean.** A live capture corrected both
 * guesses: the department name, its address and its phone number are fields of a
 * `PrimaryDepartment` object rather than flat keys, the address inside it is
 * itself structured, and no `IsVideoVisit`-shaped flag exists at all -- a video
 * visit is one whose `Telemedicine` object is present or whose `TelehealthMode`
 * is above zero. The flat readers are kept as fallbacks for a deployment that
 * still answers the old way.
 */

import { AppError } from "../../lib/errors.ts";
import { toIsoInZone } from "../../lib/time.ts";

import { isExternalVisit } from "./external.ts";
import {
  ADDRESS_KEYS,
  DEPARTMENT_KEYS,
  DEPARTMENT_OBJECT_KEYS,
  PAST_BUCKET,
  STATUS_PRIORITY,
  TELEHEALTH_MODE_KEYS,
  TELEMEDICINE_OBJECT_KEYS,
  VIDEO_KEYS,
  VISIT_BUCKETS,
  VISIT_KEYS,
} from "./wire.ts";

import type { PortalVisitStatus } from "./wire.ts";

/** One upcoming visit, in the shape the calendar mapping wants. */
export interface PortalVisit {
  /** The portal's contact-serial number: stable per visit, and the dedupe key. */
  csn: string;
  /** ISO-8601 carrying the clinic's own UTC offset, e.g. `2026-09-29T14:30:00-05:00`. */
  start: string;
  /** Same form as `start`. Absent when the payload does not say how long it is. */
  end?: string;
  /** IANA zone the visit is scheduled in, which is the clinic's, not the owner's. */
  timeZone: string;
  visitType: string;
  practitioner?: string;
  department?: string;
  locationName?: string;
  address?: string;
  phone?: string;
  isVideo: boolean;
  status: PortalVisitStatus;
  /**
   * Set (to true) only when the payload says the visit belongs to another
   * organisation than the portal listing it -- a shared-record copy. Absent means
   * first-party, or unknown. See `external.ts`.
   */
  external?: true;
}

export interface ParsedUpcoming {
  visits: PortalVisit[];
  /** Rows that carried no usable identifier or instant. Logged as a count. */
  unparsed: number;
}

/**
 * `/Date(1758000000000)/` or `/Date(1758000000000-0500)/` as a unix second.
 *
 * The number is always UTC milliseconds; the trailing offset is presentational
 * and is deliberately ignored, because the zone the visit should be *displayed*
 * in comes from the payload's own `TimeZone` field instead.
 */
const WCF_DATE = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/u;

export function parseWcfDate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value / 1000);
  if (typeof value !== "string") return null;
  const match = WCF_DATE.exec(value.trim());
  if (match?.[1] === undefined) return null;
  const ms = Number(match[1]);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * A record's fields as a Map.
 *
 * A Map rather than indexing the object: every lookup here is by a name from a
 * candidate list, and `record[name]` on untrusted JSON is both a prototype-
 * pollution read and a lint failure. `Object.entries` only ever yields own
 * enumerable keys, so the Map cannot contain anything inherited.
 */
function fieldsOf(record: object): Map<string, unknown> {
  return new Map(Object.entries(record));
}

/** The first candidate key with a usable value, as a trimmed string. */
function text(fields: ReadonlyMap<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = fields.get(key);
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** The first candidate key holding a positive number. */
function count(fields: ReadonlyMap<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = fields.get(key);
    const numeric = typeof value === "string" ? Number(value) : value;
    if (typeof numeric === "number" && Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return undefined;
}

/**
 * True when any candidate key is set.
 *
 * `1` and `"true"` count as true alongside `true`: the payload is generated from
 * a .NET model and a boolean has been seen serialised all three ways. An absent
 * key is false -- never a parse failure, because a status flag this client has
 * not heard of must not stop a visit being calendared.
 */
const TRUTHY: ReadonlySet<unknown> = new Set([true, 1, "true", "True"]);

function flag(fields: ReadonlyMap<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => TRUTHY.has(fields.get(key)));
}

/** The visit's status: the highest-priority true flag, or `scheduled`. */
export function statusOf(fields: ReadonlyMap<string, unknown>): PortalVisitStatus {
  for (const { status, keys } of STATUS_PRIORITY) {
    if (flag(fields, keys)) return status;
  }
  return "scheduled";
}

/** The first candidate key whose value is a plain object. */
function nested(
  fields: ReadonlyMap<string, unknown>,
  keys: readonly string[],
): Map<string, unknown> | null {
  for (const key of keys) {
    const value = fields.get(key);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return fieldsOf(value);
    }
  }
  return null;
}

/** Non-empty trimmed strings out of a value that may be one, or a list of them. */
function lines(value: unknown): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" ? lines(entry) : []))
    : [];
}

/**
 * A structured address as one line, tolerantly.
 *
 * Accepts the three shapes the payload has been seen to use -- a plain string, an
 * array of lines, or an object of parts -- and assembles whichever parts are
 * present. Nothing is required: an object with only a city yields the city, and
 * an object with none of the candidate keys yields nothing rather than throwing.
 * The result is only ever written to a calendar event's location.
 */
export function formatAddress(value: unknown): string | undefined {
  const direct = lines(value);
  if (direct.length > 0) return direct.join(", ");
  if (typeof value !== "object" || value === null) return undefined;
  const fields = fieldsOf(value);
  // A nested `DiscreteAddress` wins over the flat parts beside it: it is the
  // structured copy, and the flat one next to it is the display copy.
  const discrete = nested(fields, ADDRESS_KEYS.discrete);
  const parts = discrete ?? fields;
  const street = ADDRESS_KEYS.lines.flatMap((key) => lines(parts.get(key)));
  const city = text(parts, ADDRESS_KEYS.city);
  const state = text(parts, ADDRESS_KEYS.state);
  const postalCode = text(parts, ADDRESS_KEYS.postalCode);
  const locality = [city, [state, postalCode].filter(Boolean).join(" ")].filter(
    (part) => part !== undefined && part !== "",
  );
  const all = [...street, ...locality];
  return all.length === 0 ? undefined : all.join(", ");
}

/** The department object's name, address and phone, when the payload nests them. */
function departmentOf(fields: ReadonlyMap<string, unknown>): {
  department?: string;
  address?: string;
  phone?: string;
} {
  const department = nested(fields, DEPARTMENT_OBJECT_KEYS);
  if (department === null) return {};
  return {
    ...pick("department", text(department, DEPARTMENT_KEYS.name)),
    ...pick("address", formatAddress(firstPresent(department, DEPARTMENT_KEYS.address))),
    ...pick("phone", text(department, DEPARTMENT_KEYS.phone)),
  };
}

/** The first candidate key that is set at all, whatever its type. */
function firstPresent(fields: ReadonlyMap<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = fields.get(key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * True when this visit is a video visit.
 *
 * Three signals, any of which is enough: a legacy boolean flag, a present (not
 * null) telemedicine object, or a non-zero telehealth mode. The second and third
 * are what a real payload carries; the first is the earlier guess, kept for a
 * deployment that renders it.
 */
export function isVideoVisit(fields: ReadonlyMap<string, unknown>): boolean {
  if (flag(fields, VIDEO_KEYS) || nested(fields, TELEMEDICINE_OBJECT_KEYS) !== null) return true;
  return TELEHEALTH_MODE_KEYS.some((key) => {
    const value = fields.get(key);
    const mode = typeof value === "string" ? Number(value) : value;
    return typeof mode === "number" && Number.isFinite(mode) && mode > 0;
  });
}

/** The practitioner, whether the payload names one or lists several. */
function practitionerOf(fields: ReadonlyMap<string, unknown>): string | undefined {
  const single = text(fields, VISIT_KEYS.practitioner);
  if (single !== undefined) return single;
  for (const key of VISIT_KEYS.practitioners) {
    const value = fields.get(key);
    if (!Array.isArray(value)) continue;
    const names = value
      .map((entry) =>
        typeof entry === "string"
          ? entry.trim()
          : (text(fieldsOf(entry as object), VISIT_KEYS.practitioner) ?? ""),
      )
      .filter((name) => name !== "");
    if (names.length > 0) return names.join(", ");
  }
  return undefined;
}

function toVisit(record: object, fallbackTimeZone: string): PortalVisit | null {
  const fields = fieldsOf(record);
  const csn = text(fields, VISIT_KEYS.csn);
  const startSeconds = firstInstant(fields);
  // No identifier means nothing can be deduped or updated later, and no instant
  // means nothing can be calendared. Either one makes the row unusable.
  if (csn === undefined || startSeconds === null) return null;

  const visitType = text(fields, VISIT_KEYS.visitType);
  const timeZone = text(fields, VISIT_KEYS.timeZone) ?? fallbackTimeZone;
  const minutes = count(fields, VISIT_KEYS.durationMinutes);
  const place = departmentOf(fields);
  const optional = {
    ...(minutes !== undefined && {
      end: isoIn(startSeconds + Math.round(minutes * 60), timeZone, fallbackTimeZone),
    }),
    ...pick("practitioner", practitionerOf(fields)),
    // The flat readers first, then the nested object on top: the nested copy is
    // the one a live payload actually carries, so where both exist it wins.
    ...pick("department", text(fields, VISIT_KEYS.department)),
    ...pick("locationName", text(fields, VISIT_KEYS.locationName)),
    ...pick("address", text(fields, VISIT_KEYS.address)),
    ...pick("phone", text(fields, VISIT_KEYS.phone)),
    ...place,
    // A nested department is also the best name for the location when the payload
    // has no flat one, which is the common case.
    ...pick("locationName", text(fields, VISIT_KEYS.locationName) ?? place.department),
  };

  return {
    csn,
    start: isoIn(startSeconds, timeZone, fallbackTimeZone),
    timeZone,
    visitType: visitType ?? "Appointment",
    isVideo: isVideoVisit(fields),
    ...(isExternalVisit(fields) && { external: true as const }),
    status: statusOf(fields),
    ...optional,
  };
}

/** `{ key: value }` when the value is present, `{}` when it is not. */
function pick(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

/** The instant, from whichever key carries it. */
function firstInstant(fields: ReadonlyMap<string, unknown>): number | null {
  for (const key of VISIT_KEYS.instant) {
    const parsed = parseWcfDate(fields.get(key));
    if (parsed !== null) return parsed;
  }
  // The clinic-local display date is the last resort, and only when it is itself
  // a `/Date(...)/`: parsing a human-formatted local date would guess a zone.
  for (const key of VISIT_KEYS.primaryDate) {
    const parsed = parseWcfDate(fields.get(key));
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * The instant in the clinic's zone, falling back to the requested one.
 *
 * A zone name the payload made up (or a typo) would otherwise throw and lose the
 * whole batch; the requested zone is always a real one, because the caller got
 * it from the settings row.
 */
function isoIn(seconds: number, timeZone: string, fallbackTimeZone: string): string {
  try {
    return toIsoInZone(seconds, timeZone);
  } catch {
    return toIsoInZone(seconds, fallbackTimeZone);
  }
}

/**
 * Parse a `LoadUpcoming` body.
 *
 * `fallbackTimeZone` is the zone that was asked for, used for any row that does
 * not name its own. Throws `portal_parse_failed` when the body is not an object
 * with at least one of the documented buckets, or when it had rows and none of
 * them parsed -- see the module comment for why that is not an empty result.
 */
export function parseUpcoming(payload: unknown, fallbackTimeZone: string): ParsedUpcoming {
  const buckets = objectBody(payload, "upcoming-visits");
  const present = VISIT_BUCKETS.filter((name) => Array.isArray(buckets.get(name)));
  if (present.length === 0) {
    throw new AppError("portal_parse_failed", "the upcoming-visits body had none of the buckets");
  }
  const rows = present.flatMap((name) => buckets.get(name) as unknown[]);
  return collect(rows, fallbackTimeZone, "upcoming-visits");
}

/**
 * Parse a `LoadPast` body.
 *
 * Same rows, one level deeper: `LoadPast` groups by an opaque organisation token
 * because a chart account can be linked to several organisations, so the arrays
 * live at `List.<token>.List`. The tokens themselves are never named here -- they
 * identify organisations -- and are simply whatever own keys the object has.
 *
 * Throws `portal_parse_failed` on the same two conditions `parseUpcoming` does:
 * a body that is not the documented shape, and a body with rows where none of
 * them parsed.
 */
export function parsePast(payload: unknown, fallbackTimeZone: string): ParsedUpcoming {
  const body = objectBody(payload, "past-visits");
  const outer = body.get(PAST_BUCKET.outer);
  if (typeof outer !== "object" || outer === null || Array.isArray(outer)) {
    throw new AppError("portal_parse_failed", "the past-visits body had no organisation buckets");
  }
  const rows: unknown[] = [];
  let buckets = 0;
  for (const [, bucket] of fieldsOf(outer)) {
    if (typeof bucket !== "object" || bucket === null) continue;
    const inner: unknown = fieldsOf(bucket).get(PAST_BUCKET.inner);
    if (!Array.isArray(inner)) continue;
    buckets++;
    rows.push(...(inner as unknown[]));
  }
  if (buckets === 0) {
    throw new AppError("portal_parse_failed", "no organisation bucket carried a visit list");
  }
  return collect(rows, fallbackTimeZone, "past-visits");
}

/** The body as a field map, or `portal_parse_failed`. */
function objectBody(payload: unknown, label: string): Map<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AppError("portal_parse_failed", `the ${label} body was not an object`);
  }
  return fieldsOf(payload);
}

/** Rows to visits, with the "rows but nothing parsed" rule from the module comment. */
function collect(
  rows: readonly unknown[],
  fallbackTimeZone: string,
  label: string,
): ParsedUpcoming {
  const visits: PortalVisit[] = [];
  let seen = 0;
  for (const record of rows) {
    if (typeof record !== "object" || record === null) continue;
    seen++;
    const visit = toVisit(record, fallbackTimeZone);
    if (visit !== null) visits.push(visit);
  }
  if (seen > 0 && visits.length === 0) {
    throw new AppError("portal_parse_failed", `no row in the ${label} body could be read`, {
      rows: seen,
    });
  }
  return { visits, unparsed: seen - visits.length };
}
