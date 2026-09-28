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
 * and practitioners are counted by the portal's own ids (`departmentId`,
 * `practitionerId`, deterministic tokens like the visit's own), falling back to
 * the normalised name when a visit has no id.
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

/** The paragraphs of a directions text: split on blank lines, empty ones dropped. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

/** What two copies of one paragraph agree on. */
function paragraphKey(paragraph: string): string {
  return paragraph.replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

function departmentKey(visit: PortalVisit): string {
  return visit.departmentId ?? `name:${normalizeLabel(visit.department ?? visit.locationName)}`;
}

function practitionerKey(visit: PortalVisit): string {
  return visit.practitionerId ?? `name:${normalizeLabel(visit.practitioner)}`;
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
  return kept.length === 0 ? undefined : kept.join("\n\n");
}
