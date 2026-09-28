/**
 * Directions without the health system's boilerplate.
 *
 * A visit's details page shows its department's directions, and a health system
 * injects its own paragraphs into every department's -- "check in online ahead
 * of your visit", "payment is due at the time of service". Those are noise on a
 * calendar, and the repository is public, so no health system's wording can be
 * hard-coded. The rule is statistical instead, per health system, over every
 * portal visit it has stored (past and upcoming):
 *
 *   - **Only with enough evidence.** Nothing is stripped unless the health system
 *     has at least {@link MIN_VISITS} visits with directions, across at least
 *     {@link MIN_DISTINCT} distinct practitioners and {@link MIN_DISTINCT}
 *     distinct departments. With one practitioner at one office, every paragraph
 *     repeats -- including the real "take the second elevator" -- and nothing
 *     distinguishes the boilerplate.
 *   - **A paragraph is boilerplate when two different departments both carry
 *     it.** Real directions describe one place; the same sentence under two
 *     places is the health system talking, not the department. (Not "appears in
 *     every visit": a live capture showed the check-in paragraph missing from a
 *     visit that offers no online check-in, so that rule would have left it on
 *     most visits.)
 *
 * Paragraphs are compared after whitespace and case normalisation. Departments
 * and practitioners are counted by their normalised names first, and by the
 * portal's own ids (`departmentId`, `practitionerId`) only when a visit has no
 * name. Names on purpose, although ids are the better identity in principle:
 * the stored visits span many sessions, and the ids' stability across sessions
 * has not been observed (the visit's own token's has). An id that changed per
 * session would count one department twice and strip its real directions -- the
 * one failure here that loses what the owner asked for -- while two departments
 * sharing a name only strips less.
 *
 * Visit instructions are not filtered: they are written per visit type, and no
 * capture has shown shared noise in them.
 *
 * Pure: the calendar sync and the MCP both call it, so they cannot disagree.
 */

import { normalizeLabel } from "./portal-dedupe.ts";

import type { PortalVisit } from "../ehr/mychart/visits.ts";

/** Fewer visits with directions than this, and nothing is stripped. */
const MIN_VISITS = 3;
/** Fewer distinct practitioners, or departments, than this, and nothing is stripped. */
const MIN_DISTINCT = 2;

/** Normalised paragraphs the health system repeats across departments. */
export type Boilerplate = ReadonlySet<string>;

/**
 * The paragraphs of a directions text: every line on its own, empty ones dropped.
 *
 * Lines rather than blank-line blocks, because the portal separates its
 * boilerplate from the department's text with a single break as often as with a
 * blank line, and a block that held both could never match another visit's.
 */
function paragraphs(text: string): string[] {
  return text
    .split("\n")
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

/** What two copies of one paragraph agree on. */
function paragraphKey(paragraph: string): string {
  return paragraph.replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

/** A name's normalised form, or the id with a prefix no name can produce. */
function identity(name: string | undefined, id: string | undefined): string {
  const label = normalizeLabel(name);
  return label === "" ? `id:${id ?? ""}` : label;
}

function departmentKey(visit: PortalVisit): string {
  return identity(visit.department ?? visit.locationName, visit.departmentId);
}

function practitionerKey(visit: PortalVisit): string {
  return identity(visit.practitioner, visit.practitionerId);
}

/** The boilerplate of one health system, from every visit it has stored. */
export function boilerplateOf(visits: readonly PortalVisit[]): Boilerplate {
  const described = visits.filter(
    (visit) => visit.directions !== undefined && visit.directions.trim() !== "",
  );
  const departments = new Set(described.map((visit) => departmentKey(visit)));
  const practitioners = new Set(described.map((visit) => practitionerKey(visit)));
  if (
    described.length < MIN_VISITS ||
    departments.size < MIN_DISTINCT ||
    practitioners.size < MIN_DISTINCT
  ) {
    return new Set();
  }
  const seenAt = new Map<string, Set<string>>();
  for (const visit of described) {
    const department = departmentKey(visit);
    const texts = paragraphs(visit.directions ?? "");
    for (const paragraph of texts) {
      const key = paragraphKey(paragraph);
      const places = seenAt.get(key) ?? new Set<string>();
      places.add(department);
      seenAt.set(key, places);
    }
  }
  const out = new Set<string>();
  for (const [key, places] of seenAt) if (places.size >= MIN_DISTINCT) out.add(key);
  return out;
}

/** A visit's directions with the boilerplate paragraphs removed; undefined when none are left. */
export function cleanDirections(
  text: string | undefined,
  boilerplate: Boilerplate,
): string | undefined {
  if (text === undefined) return undefined;
  const kept = paragraphs(text).filter((paragraph) => !boilerplate.has(paragraphKey(paragraph)));
  return kept.length === 0 ? undefined : kept.join("\n");
}
