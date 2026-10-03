/**
 * ModMed appointment rows -> the portal visit model the calendar sync already reads.
 *
 * One appointment row, as the upcoming list returns it:
 *
 *   { id, appointmentDate, timeZone, reason,
 *     physician: { id, fullNameComplete, ... },
 *     facility: { id, name, timeZone, address: { street1, city, state, zipcode, ... },
 *                 mainPhone: { formattedPhoneNumber, ... }, ... },
 *     visit?: { id, visitType, ... } }
 *
 * What the fields mean, as confirmed against a signed-in session:
 *
 *  - `appointmentDate` is the true instant, written with a `+0000` offset (no
 *    colon). It is UTC; nothing about the clinic's zone is in it.
 *  - `facility.timeZone` is the zone the portal renders the time in, and the
 *    clinic's own. The row's top-level `timeZone` is the *practice's* zone,
 *    which can differ from the clinic's -- the portal's own page prefers the
 *    facility's, and so does this.
 *  - `id` is the appointment's id: stable, and the dedupe key (`csn` in the
 *    shared model, which predates there being a second vendor).
 *  - There is no status, no duration and no cancellation flag. A row is on the
 *    list because it is booked; a cancelled one drops off, which the sync's
 *    vanished-visit rule already handles. A row that carries a `visit` object
 *    has been checked in.
 *
 * A row without a usable id or instant is skipped and counted, never guessed.
 * Logs carry counts only.
 */

import { toIsoInZone } from "../../lib/time.ts";

import type { Logger } from "../../lib/log.ts";
import type { PortalVisit } from "../mychart/visits.ts";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(record: Json, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function text(record: Json | undefined, key: string): string | undefined {
  if (record === undefined) return undefined;
  const value = field(record, key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.replaceAll(/\s+/gu, " ").trim();
  return trimmed === "" ? undefined : trimmed;
}

function idOf(record: Json | undefined, key = "id"): string | undefined {
  if (record === undefined) return undefined;
  const value = field(record, key);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function child(record: Json, key: string): Json | undefined {
  const value = field(record, key);
  return isRecord(value) ? value : undefined;
}

/**
 * `2026-10-14T15:30:00.000+0000` (or with `+00:00`, or `Z`) -> unix seconds.
 * Null for anything that is not an ISO instant with an explicit offset: a bare
 * local time would be a guess about the zone.
 */
export function parseAppointmentDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const zone = /(?:Z|[+-]\d{2}:?\d{2})$/u.exec(trimmed)?.[0];
  if (zone === undefined) return null;
  const local = trimmed.slice(0, -zone.length);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?$/u.test(local)) return null;
  const offset = zone === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const ms = Date.parse(`${local}${offset}`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * The canonical IANA name for the legacy `US/*` links ModMed reports.
 *
 * `US/Central` and friends are backward-compatibility links in the tz database:
 * every runtime here resolves them, but they are deprecated, and a zone stored
 * on a visit (and served over MCP) should be the name everything else uses.
 * The whole `US/*` family, so nothing about which one a practice uses is
 * special-cased.
 */
const US_LINKS: ReadonlyMap<string, string> = new Map([
  ["US/Alaska", "America/Anchorage"],
  ["US/Aleutian", "America/Adak"],
  ["US/Arizona", "America/Phoenix"],
  ["US/Central", "America/Chicago"],
  ["US/East-Indiana", "America/Indiana/Indianapolis"],
  ["US/Eastern", "America/New_York"],
  ["US/Hawaii", "Pacific/Honolulu"],
  ["US/Indiana-Starke", "America/Indiana/Knox"],
  ["US/Michigan", "America/Detroit"],
  ["US/Mountain", "America/Denver"],
  ["US/Pacific", "America/Los_Angeles"],
  ["US/Samoa", "Pacific/Pago_Pago"],
]);

/** `zone`, with a legacy `US/*` link replaced by its canonical name. */
export function canonicalZone(zone: string | undefined): string | undefined {
  return zone === undefined ? undefined : (US_LINKS.get(zone) ?? zone);
}

/** Whether `zone` is an IANA zone this runtime knows. */
function knownZone(zone: string | undefined): zone is string {
  if (zone === undefined) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** One line: street, city, state and ZIP, whatever of them the row has. */
function addressOf(facility: Json | undefined): string | undefined {
  const address = facility === undefined ? undefined : child(facility, "address");
  if (address === undefined) return undefined;
  const street = [text(address, "street1"), text(address, "street2")].filter(Boolean).join(" ");
  const city = text(address, "city");
  const stateZip = [text(address, "state"), text(address, "zipcode")].filter(Boolean).join(" ");
  const line = [street, city, stateZip].filter((part) => part !== undefined && part !== "");
  return line.length === 0 ? text(address, "fullStreetAddress") : line.join(", ");
}

function phoneOf(facility: Json | undefined): string | undefined {
  if (facility === undefined) return undefined;
  for (const key of ["mainPhone", "workPhoneNumber"]) {
    const phone = child(facility, key);
    const formatted = text(phone, "formattedPhoneNumber") ?? text(phone, "phoneNumber");
    if (formatted !== undefined) return formatted;
  }
  return undefined;
}

/**
 * Whether an appointment's reason says it is a video visit.
 *
 * The only signal there is. The patient API's appointment projection is fixed
 * (`id`, `appointmentDate`, `timeZone`, `reason`, `physician`, `facility`,
 * `visit`); a selector naming any telehealth-ish field is silently ignored, and
 * the app's own video page is a separate screen that lists a meeting only once
 * the practice has opened it (`/ema/ws/v3/meeting/available`), not a property
 * of a booked appointment. So a booking is a video visit when the practice
 * booked it under a reason that says so.
 */
const VIDEO_REASON = /\b(?:video|virtual|tele-?health|tele-?medicine|telemed|e-?visit)\b/iu;

export function isVideoReason(reason: string | undefined): boolean {
  return reason !== undefined && VIDEO_REASON.test(reason);
}

/** One row, or null when it carries no usable id or instant. */
export function parseAppointment(row: unknown, fallbackTimeZone: string): PortalVisit | null {
  if (!isRecord(row)) return null;
  const id = idOf(row);
  const start = parseAppointmentDate(field(row, "appointmentDate"));
  if (id === undefined || start === null) return null;
  const facility = child(row, "facility");
  const physician = child(row, "physician");
  const zoneCandidates = [
    canonicalZone(text(facility, "timeZone")),
    canonicalZone(text(row, "timeZone")),
    fallbackTimeZone,
  ];
  const timeZone = zoneCandidates.find(knownZone) ?? "UTC";
  const visitType = text(row, "reason") ?? "Appointment";
  const practitioner =
    text(physician, "fullNameComplete") ?? text(physician, "fullName") ?? text(physician, "name");
  const facilityName = text(facility, "name");
  const address = addressOf(facility);
  const phone = phoneOf(facility);
  const departmentId = idOf(facility);
  const practitionerId = idOf(physician);
  return {
    csn: id,
    start: toIsoInZone(start, timeZone),
    timeZone,
    visitType,
    ...(practitioner !== undefined && { practitioner }),
    ...(facilityName !== undefined && { department: facilityName, locationName: facilityName }),
    ...(address !== undefined && { address }),
    ...(phone !== undefined && { phone }),
    isVideo: isVideoReason(visitType),
    status: child(row, "visit") === undefined ? "scheduled" : "arrived",
    ...(departmentId !== undefined && { departmentId }),
    ...(practitionerId !== undefined && { practitionerId }),
  };
}

/** Every row, in order, skipping (and counting) the unusable ones. */
export function parseAppointments(
  rows: readonly unknown[],
  fallbackTimeZone: string,
  logger: Logger,
): PortalVisit[] {
  const visits: PortalVisit[] = [];
  let unparsed = 0;
  for (const row of rows) {
    const visit = parseAppointment(row, fallbackTimeZone);
    if (visit === null) unparsed += 1;
    else visits.push(visit);
  }
  if (unparsed > 0) logger.warn("portal.modmed.unparsed_rows", { unparsed, rows: rows.length });
  return visits;
}

/** Marks a past-list id (a visit), so it can never equal an appointment id. */
const PAST_VISIT_PREFIX = "visit:";

/**
 * One row of the *past* list, which is a different record: a visit, not an
 * appointment. `visitId`, `visitDate` (same `+0000` form), `primaryProvider` (a
 * display name) and the same `facility`. It also carries clinical text
 * (`impressions`) and a note link; neither is read.
 */
function parsePastVisit(row: unknown, fallbackTimeZone: string): PortalVisit | null {
  if (!isRecord(row)) return null;
  const visitId = idOf(row, "visitId");
  const start = parseAppointmentDate(field(row, "visitDate"));
  if (visitId === undefined || start === null) return null;
  // A visit id and an appointment id are different number spaces that may well
  // overlap, and both become `csn`: the prefix keeps them from colliding.
  const id = `${PAST_VISIT_PREFIX}${visitId}`;
  const facility = child(row, "facility");
  const zoneCandidates = [canonicalZone(text(facility, "timeZone")), fallbackTimeZone];
  const timeZone = zoneCandidates.find(knownZone) ?? "UTC";
  const practitioner = text(row, "primaryProvider");
  const facilityName = text(facility, "name");
  const address = addressOf(facility);
  const phone = phoneOf(facility);
  const departmentId = idOf(facility);
  const practitionerId = idOf(row, "providerId");
  return {
    csn: id,
    start: toIsoInZone(start, timeZone),
    timeZone,
    visitType: "Visit",
    ...(practitioner !== undefined && { practitioner }),
    ...(facilityName !== undefined && { department: facilityName, locationName: facilityName }),
    ...(address !== undefined && { address }),
    ...(phone !== undefined && { phone }),
    isVideo: false,
    status: "completed",
    ...(departmentId !== undefined && { departmentId }),
    ...(practitionerId !== undefined && { practitionerId }),
  };
}

/** Every past row, skipping (and counting) the unusable ones. */
export function parsePastVisits(
  rows: readonly unknown[],
  fallbackTimeZone: string,
  logger: Logger,
): PortalVisit[] {
  const visits: PortalVisit[] = [];
  let unparsed = 0;
  for (const row of rows) {
    const visit = parsePastVisit(row, fallbackTimeZone);
    if (visit === null) unparsed += 1;
    else visits.push(visit);
  }
  if (unparsed > 0) logger.warn("portal.modmed.unparsed_rows", { unparsed, rows: rows.length });
  return visits;
}
