/**
 * One visit seen by more than one health system: which sightings are the same
 * appointment, and which one speaks for it.
 *
 * A chart account linked to several organisations lets each portal list visits
 * booked at the others. Without this, a visit at organisation A that B's portal
 * also lists would be calendared twice and answered twice by the MCP. Filtering
 * other organisations' visits out instead would lose them whenever A itself is
 * not connected, or its session is failing -- the shared copy may be the only
 * one there is. So every sighting is kept until a better one is known, and only
 * then collapsed.
 *
 * Pure, like `portal-mapping.ts`: the calendar sync and the MCP both call it, and
 * a second copy of these rules would let the two disagree about what "one visit"
 * means.
 *
 * ### Same visit, across health systems
 *
 * A CSN is numbered per Epic instance, so two organisations' numbers can collide
 * and one organisation's copy of another's visit may carry either number. It is
 * therefore never enough on its own across health systems. Two sightings are the same
 * visit when their starts are within `DEDUPE_WINDOW_SECONDS` (the tolerance the
 * same-health system rule already uses -- two views of one appointment have been seen
 * a minute or two apart) AND at least one of:
 *
 *  - the same CSN;
 *  - the same practitioner, after normalisation;
 *  - the same department or location, after normalisation, with no disagreement
 *    about the practitioner (two appointments at one clinic at one time, with two
 *    different clinicians, are two appointments).
 *
 * Anything less is not merged. A duplicate on the calendar is an eyesore; a real
 * visit merged out of existence is a missed appointment.
 *
 * ### Which sighting wins
 *
 * By {@link SightingRank}: a FHIR Encounter (the organisation's own record), then
 * a portal copy that does not say it is someone else's, then one that does, then
 * a portal copy that has not been refreshed for {@link STALE_SECONDS} (its portal
 * is failing, so a fresher copy elsewhere is the better guide). Ties go to the
 * lower health system id, which only has to be stable, so every caller picks the same
 * winner.
 */

import { DEDUPE_WINDOW_SECONDS } from "./portal-mapping.ts";

/** A portal copy older than this loses to any fresher one. Two days. */
export const STALE_SECONDS = 2 * 24 * 3600;

/** Lower wins. See the module comment. */
export type SightingRank = 0 | 1 | 2 | 3;

export const RANK_FHIR: SightingRank = 0;
const RANK_PORTAL: SightingRank = 1;
const RANK_EXTERNAL: SightingRank = 2;
const RANK_STALE: SightingRank = 3;

/** What the matcher needs to know about one sighting of a visit. */
export interface Sighting {
  healthSystemId: string;
  /** Unix seconds. */
  start: number;
  csn?: string | undefined;
  practitioner?: string | undefined;
  department?: string | undefined;
  location?: string | undefined;
  rank: SightingRank;
}

/**
 * The rank of one portal copy.
 *
 * `fetchedAt` is when the portal pass last saw it; `now` is the caller's clock.
 */
export function portalRank(external: boolean, fetchedAt: number, now: number): SightingRank {
  if (now - fetchedAt > STALE_SECONDS) return RANK_STALE;
  return external ? RANK_EXTERNAL : RANK_PORTAL;
}

/** Credentials and titles that one view prints and another does not. */
const TITLE_TOKENS: ReadonlySet<string> = new Set([
  "md",
  "do",
  "np",
  "pa",
  "pac",
  "rn",
  "aprn",
  "fnp",
  "dnp",
  "phd",
  "dr",
  "mbbs",
  "dpm",
  "od",
  "dds",
]);

/**
 * A label reduced to what two views of it can agree on: lowercase alphanumeric
 * words, credentials dropped, in sorted order -- so "Rivers, Ada MD" and "Dr Ada
 * Rivers" are the same practitioner. Empty when nothing is left.
 */
export function normalizeLabel(value: string | undefined): string {
  if (value === undefined) return "";
  const words = value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== "" && !TITLE_TOKENS.has(word));
  words.sort((left, right) => left.localeCompare(right));
  return words.join(" ");
}

/** "Same" when both sides have a value and it normalises equal; null when either lacks one. */
function agree(a: string | undefined, b: string | undefined): boolean | null {
  const left = normalizeLabel(a);
  const right = normalizeLabel(b);
  return left === "" || right === "" ? null : left === right;
}

/**
 * How two sightings from different health systems match, if they do.
 *
 *  - `identity`: the same CSN, or the same practitioner. Strong enough to act on
 *    destructively -- the calendar sync deletes an event it had already written
 *    for the weaker copy.
 *  - `place`: only a shared department or location, with neither side naming a
 *    practitioner the other contradicts. Two same-time visits at two
 *    organisations that share a generic label ("Laboratory", "Imaging") look like
 *    this, so it is only ever enough to *not insert* a second copy, never to
 *    delete one that is already on the calendar (security review L3).
 *  - `none`: two appointments.
 */
export type VisitMatch = "identity" | "place" | "none";

export function matchAcrossHealthSystems(a: Sighting, b: Sighting): VisitMatch {
  if (
    a.healthSystemId === b.healthSystemId ||
    !Number.isFinite(a.start) ||
    !Number.isFinite(b.start) ||
    Math.abs(a.start - b.start) > DEDUPE_WINDOW_SECONDS
  )
    return "none";
  if (a.csn !== undefined && a.csn !== "" && a.csn === b.csn) return "identity";
  // A practitioner both sides name decides it; otherwise a shared place does.
  const practitioner = agree(a.practitioner, b.practitioner);
  if (practitioner !== null) return practitioner ? "identity" : "none";
  return agree(a.department, b.department) === true || agree(a.location, b.location) === true
    ? "place"
    : "none";
}

/** What {@link sameVisitWithinHealthSystem} compares. */
export interface VisitIdentity {
  /** Unix seconds. */
  start: number;
  csn?: string | undefined;
  practitioner?: string | undefined;
}

/**
 * True when two sightings from the SAME health system -- a FHIR Encounter and a
 * portal visit -- are one appointment. The calendar's adoption of a portal row
 * and the MCP's merge of a portal item both ask this.
 *
 * The identity half of {@link matchAcrossHealthSystems}, and nothing weaker:
 *
 *  - When both carry a CSN, the CSN decides, whatever the clock says. Within one
 *    Epic instance it is the visit's own number.
 *  - Otherwise the starts must be within `DEDUPE_WINDOW_SECONDS` AND both sides
 *    must name the same practitioner, after normalisation.
 *
 * A shared start time alone is never enough, and neither is a shared place. A
 * cancelled Encounter at the same time as a different, live portal visit is two
 * appointments; treating it as one handed the live visit's calendar entry to the
 * cancelled Encounter, which then greyed it out.
 */
export function sameVisitWithinHealthSystem(a: VisitIdentity, b: VisitIdentity): boolean {
  const aCsn = a.csn ?? "";
  const bCsn = b.csn ?? "";
  if (aCsn !== "" && bCsn !== "") return aCsn === bCsn;
  const together =
    Number.isFinite(a.start) &&
    Number.isFinite(b.start) &&
    Math.abs(a.start - b.start) <= DEDUPE_WINDOW_SECONDS;
  return together && agree(a.practitioner, b.practitioner) === true;
}

/** True when two sightings from different health systems are one appointment. */
export function sameVisitAcrossHealthSystems(a: Sighting, b: Sighting): boolean {
  return matchAcrossHealthSystems(a, b) !== "none";
}

/** True when `a` speaks for the visit over `b`. */
export function outranks(a: Sighting, b: Sighting): boolean {
  return a.rank === b.rank ? a.healthSystemId < b.healthSystemId : a.rank < b.rank;
}
