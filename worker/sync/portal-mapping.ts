/**
 * One upcoming portal visit -> the shape the calendar mapping already takes.
 *
 * Pure, and free of D1, `fetch` and `Env` for the same reason `mapping.ts` is:
 * these are the rules a unit test in plain Node has to be able to pin.
 *
 * ### Why a conversion rather than a second mapper
 *
 * The portal and the FHIR pass describe the same appointment, and the owner's
 * calendar must not be able to tell which one wrote an event: the same title
 * template, the same arrive-early arithmetic, the same "Video visit" location,
 * the same description and fingerprint. So a `PortalVisit` is converted into the
 * `NormalizedAppointmentView` that `buildCalendarModel` consumes, and there is
 * exactly one mapping layer in this codebase. A second one would drift, and the
 * way it would show is the owner's calendar re-writing every event the hour a
 * visit changed hands from one source to the other.
 *
 * ### The two things this file decides on its own
 *
 * **The event key.** A portal visit has no Encounter id, so the key's second
 * half is `csn:<csn>` -- the portal's contact-serial number, prefixed so that it
 * can never collide with an Epic resource id and so that `source = 'portal'` is
 * visible in the key itself. The full key is `<providerId>:csn:<csn>`.
 *
 * **What "off the schedule" means here.** `mapping.ts` knows the FHIR Encounter
 * statuses (`cancelled`, `entered-in-error`); the portal has its own vocabulary,
 * derived in `worker/providers/mychart/wire.ts` from a set of contradictory
 * booleans. `canceled` and `no_show` are the two that mean the appointment is not
 * going to happen, so they are what ghosts an event.
 *
 * Nothing here logs: every string it handles (visit type, practitioner, address)
 * is the owner's own data, bound for their calendar and nowhere else.
 */

import type { NormalizedAppointmentView, NormalizedLocationRef } from "../fhir/normalize/types.ts";
import type { PortalVisit, PortalVisitStatus } from "../providers/mychart/index.ts";

/**
 * The infix that marks the portal half of an event key.
 *
 * `<providerId>:csn:<csn>`. Epic resource ids do not contain a colon, so a key
 * carrying this one is unambiguously a portal row even without reading `source`.
 */
const CSN_PREFIX = "csn:";

/** Portal statuses that mean the visit will not happen, so its event is ghosted. */
const PORTAL_OFF_SCHEDULE: ReadonlySet<PortalVisitStatus> = new Set(["canceled", "no_show"]);

/**
 * How far apart two sightings of one appointment may be and still be one visit.
 *
 * Five minutes, and it is the tolerance both directions of the dedupe use. The
 * portal reports the time the clinic shows the patient; the FHIR Encounter
 * reports `period.start`, and the two have been seen to disagree by a minute or
 * two for the same appointment. Wider than this and two genuinely different
 * back-to-back appointments would start collapsing into one.
 */
export const DEDUPE_WINDOW_SECONDS = 300;

/** The `encounterId` half of a portal visit's event key. */
export function portalEncounterId(csn: string): string {
  return `${CSN_PREFIX}${csn}`;
}

/**
 * What every one of a provider's portal event keys starts with.
 *
 * The one place the marker is spelled out for a *caller*: both passes of the sync
 * filter on it -- the portal pass to take its own rows and events, the FHIR pass to
 * leave them alone -- and a second copy of the string in either file is a way for
 * the two filters to stop being exact complements of each other.
 */
export function portalKeyPrefix(providerId: string): string {
  return `${providerId}:${CSN_PREFIX}`;
}

/** The CSN a portal event key carries, or null when the key is not a portal one. */
export function csnOfEncounterId(encounterId: string): string | null {
  return encounterId.startsWith(CSN_PREFIX) ? encounterId.slice(CSN_PREFIX.length) : null;
}

/** True when the visit's status means its calendar event should be a ghost. */
export function isOffSchedule(status: PortalVisitStatus): boolean {
  return PORTAL_OFF_SCHEDULE.has(status);
}

/**
 * `{ key: value }` when the value is present, `{}` when it is not.
 *
 * The same shape `visits.ts` uses, and for the same reason: with
 * `exactOptionalPropertyTypes` an explicit `undefined` is not the same as an
 * absent field, and every one of these fields is genuinely absent when the
 * payload did not carry it.
 */
function pick(key: string, value: string | undefined): Record<string, string> {
  return value === undefined || value === "" ? {} : { [key]: value };
}

/**
 * The location, as much of one as the portal gives.
 *
 * The address arrives as a single rendered line rather than as parts, so it goes
 * in `lines` -- which is what `mapping.ts`'s `addressText` joins back together,
 * producing the same string. Nothing is parsed out of it: guessing at which
 * comma was the city would put a wrong address on the owner's calendar.
 */
function locationOf(visit: PortalVisit): NormalizedLocationRef | undefined {
  const name = visit.locationName ?? visit.department;
  const address = visit.address === undefined || visit.address === "" ? undefined : visit.address;
  if (name === undefined && address === undefined && visit.phone === undefined) return undefined;
  return {
    ...pick("name", name),
    ...(address !== undefined && { address: { lines: [address] } }),
    ...pick("phone", visit.phone),
  };
}

/**
 * Convert one upcoming visit into the calendar mapping's input.
 *
 * `status` carries the portal's own word (`scheduled`, `confirmed`, `canceled`),
 * which is what the description shows the owner. It is deliberately not
 * translated into FHIR's vocabulary: the owner is reading what their clinic
 * said, and a translation would both lose `no_show` and invent a precision the
 * portal's contradictory status booleans do not have.
 */
export function portalVisitView(providerId: string, visit: PortalVisit): NormalizedAppointmentView {
  const location = locationOf(visit);
  return {
    provider: providerId,
    encounterId: portalEncounterId(visit.csn),
    status: visit.status,
    start: visit.start,
    ...pick("end", visit.end),
    ...pick("visitType", visit.visitType),
    ...pick("practitioner", visit.practitioner),
    ...pick("department", visit.department),
    ...(location !== undefined && { location }),
    telehealth: visit.isVideo,
    csn: visit.csn,
  };
}
