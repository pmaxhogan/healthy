/**
 * Matching a caller's filter against Epic-flavoured FHIR.
 *
 * Every function here checks the raw resource FIRST and the normalized item
 * second, because normalization is lossy in exactly the direction that matters:
 * `codeText` prefers `text`, then `coding[].display`, and only then
 * `coding[].code`. So an organisation that labels its lab panel "Vital Signs"
 * leaves the machine-readable `vital-signs` nowhere but the resource -- and a
 * caller asking for vitals by category would get nothing back from the item
 * alone.
 *
 * Comparison is on a slug (lower-cased, non-alphanumerics dropped) so
 * `vital-signs`, `Vital Signs` and `vitalsigns` are one value. That is deliberate
 * over-matching: the alternative is a filter that silently returns an empty list
 * at one organisation and the full one at another.
 */

import type * as fhir4 from "fhir/r4";

/** Lower-case, alphanumerics only. `Vital Signs` and `vital-signs` agree. */
export function slug(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function codingSlugs(concepts: readonly fhir4.CodeableConcept[] | undefined): Set<string> {
  const out = new Set<string>();
  const present = concepts ?? [];
  for (const concept of present) {
    if (concept.text) out.add(slug(concept.text));
    const codings = concept.coding ?? [];
    for (const coding of codings) {
      if (coding.code) out.add(slug(coding.code));
      if (coding.display) out.add(slug(coding.display));
    }
  }
  return out;
}

/** `resource.category`, when the resource has one. */
function categoriesOf(resource: fhir4.FhirResource): fhir4.CodeableConcept[] | undefined {
  const { category } = resource as { category?: unknown };
  return Array.isArray(category) ? (category as fhir4.CodeableConcept[]) : undefined;
}

/**
 * True when a resource belongs to any of `wanted`.
 *
 * `wanted` is a list of acceptable spellings for one category -- the FHIR code and
 * the display strings organisations use for it.
 */
export function hasCategory(
  resource: fhir4.FhirResource,
  normalizedCategories: readonly string[],
  wanted: readonly string[],
): boolean {
  const needles = wanted.map((value) => slug(value));
  const found = codingSlugs(categoriesOf(resource));
  for (const value of normalizedCategories) found.add(slug(value));
  return needles.some((needle) => found.has(needle));
}

/** Accepted spellings of the Observation categories the tools expose. */
export const LABORATORY = ["laboratory", "lab"] as const;
export const VITAL_SIGNS = ["vital-signs", "vitals"] as const;
export const SOCIAL_HISTORY = ["social-history"] as const;

/** True when `resource.code` carries `code` as a code or a display string. */
export function hasCode(resource: fhir4.FhirResource, code: string): boolean {
  const { code: concept } = resource as { code?: unknown };
  const concepts = concept === undefined ? [] : [concept as fhir4.CodeableConcept];
  return codingSlugs(concepts).has(slug(code));
}

/** True when any of `haystacks` contains `needle`, case-insensitively. */
export function textMatches(needle: string, haystacks: readonly (string | undefined)[]): boolean {
  const wanted = needle.trim().toLowerCase();
  // An empty needle matches everything: a blank `text` argument is not a filter.
  return (
    wanted.length === 0 || haystacks.some((value) => value?.toLowerCase().includes(wanted) === true)
  );
}
