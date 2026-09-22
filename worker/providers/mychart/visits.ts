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
 */

import { AppError } from "../../lib/errors.ts";
import { toIsoInZone } from "../../lib/time.ts";

import { STATUS_PRIORITY, VIDEO_KEYS, VISIT_BUCKETS, VISIT_KEYS } from "./wire.ts";

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
  const optional = {
    ...(minutes !== undefined && {
      end: isoIn(startSeconds + Math.round(minutes * 60), timeZone, fallbackTimeZone),
    }),
    ...pick("practitioner", practitionerOf(fields)),
    ...pick("department", text(fields, VISIT_KEYS.department)),
    ...pick("locationName", text(fields, VISIT_KEYS.locationName)),
    ...pick("address", text(fields, VISIT_KEYS.address)),
    ...pick("phone", text(fields, VISIT_KEYS.phone)),
  };

  return {
    csn,
    start: isoIn(startSeconds, timeZone, fallbackTimeZone),
    timeZone,
    visitType: visitType ?? "Appointment",
    isVideo: flag(fields, VIDEO_KEYS),
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
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AppError("portal_parse_failed", "the upcoming-visits body was not an object");
  }
  const buckets = fieldsOf(payload);
  const present = VISIT_BUCKETS.filter((name) => Array.isArray(buckets.get(name)));
  if (present.length === 0) {
    throw new AppError("portal_parse_failed", "the upcoming-visits body had none of the buckets");
  }

  const visits: PortalVisit[] = [];
  let rows = 0;
  for (const name of present) {
    for (const record of buckets.get(name) as unknown[]) {
      if (typeof record !== "object" || record === null) continue;
      rows++;
      const visit = toVisit(record, fallbackTimeZone);
      if (visit !== null) visits.push(visit);
    }
  }

  if (rows > 0 && visits.length === 0) {
    throw new AppError("portal_parse_failed", "no row in the upcoming-visits body could be read", {
      rows,
    });
  }
  return { visits, unparsed: rows - visits.length };
}
