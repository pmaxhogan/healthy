/**
 * The `field` rule's two vocabularies, and the engine that translates a path
 * written in either one into the other shape.
 *
 * `worker/policy/filter.ts` is the one place a `field` rule is enforced, and it
 * enforces every rule against two different shapes of the same data: the
 * normalized item the tools return by default, and the raw FHIR resource
 * behind it (`raw: true`). Those two shapes rename the same concept in a lot
 * of places -- Observation's `value` is `valueQuantity` (or one of four other
 * `value[x]` siblings) in the raw resource, its `components[]` is `component[]`,
 * an Encounter's `practitioners[].name` is `participant[].individual.display`
 * -- so a rule written in one vocabulary has to be translated before it can be
 * applied against the other, or half the choke point's job silently does not
 * happen. That translation table lives next to the `normalizeX` function that
 * performs each rename (`worker/fhir/normalize/<type>.ts` exports
 * `FIELD_ALIASES`), so a future rename and its alias entry cannot drift apart
 * in separate files; this module only aggregates them and does the resolving.
 * What each vocabulary contains -- the field tree the admin UI draws and
 * validation walks -- is `worker/policy/tree.ts`.
 *
 * Matching is root-anchored and longest-prefix: an alias is tried only
 * against the very start of a rule's path (right after the resource type),
 * never re-scanned inside whatever is left over, and when more than one alias
 * matches the longest one wins. A shorter match would translate a nested
 * rename's leading segment on its own and leave the rest of the path aimed at
 * the wrong shape entirely -- e.g. treating `components[].value.unit` as
 * "components" (a top-level rename) plus a literal `value.unit` tail, instead
 * of the nested `components[].value` rename it actually is.
 */

import { ARRAY_SEGMENT, isChoiceSegment, matchesChoice } from "@shared/policy-path.ts";

import { FIELD_ALIASES as ALLERGY_ALIASES } from "../fhir/normalize/allergy.ts";
import { FIELD_ALIASES as CARE_PLAN_ALIASES } from "../fhir/normalize/care-plan.ts";
import { FIELD_ALIASES as CARE_TEAM_ALIASES } from "../fhir/normalize/care-team.ts";
import { FIELD_ALIASES as CONDITION_ALIASES } from "../fhir/normalize/condition.ts";
import { FIELD_ALIASES as COVERAGE_ALIASES } from "../fhir/normalize/coverage.ts";
import { FIELD_ALIASES as DEVICE_ALIASES } from "../fhir/normalize/device.ts";
import { FIELD_ALIASES as DIAGNOSTIC_REPORT_ALIASES } from "../fhir/normalize/diagnostic-report.ts";
import { FIELD_ALIASES as DOCUMENT_REFERENCE_ALIASES } from "../fhir/normalize/document-reference.ts";
import { FIELD_ALIASES as ENCOUNTER_ALIASES } from "../fhir/normalize/encounter.ts";
import { FIELD_ALIASES as GOAL_ALIASES } from "../fhir/normalize/goal.ts";
import { FIELD_ALIASES as IMMUNIZATION_ALIASES } from "../fhir/normalize/immunization.ts";
import { NORMALIZED_TYPES } from "../fhir/normalize/index.ts";
import { FIELD_ALIASES as LOCATION_ALIASES } from "../fhir/normalize/location.ts";
import { FIELD_ALIASES as MEDICATION_DISPENSE_ALIASES } from "../fhir/normalize/medication-dispense.ts";
import { FIELD_ALIASES as MEDICATION_REQUEST_ALIASES } from "../fhir/normalize/medication-request.ts";
import { FIELD_ALIASES as OBSERVATION_ALIASES } from "../fhir/normalize/observation.ts";
import { FIELD_ALIASES as ORGANIZATION_ALIASES } from "../fhir/normalize/organization.ts";
import { FIELD_ALIASES as PATIENT_ALIASES } from "../fhir/normalize/patient.ts";
import { FIELD_ALIASES as PRACTITIONER_ALIASES } from "../fhir/normalize/practitioner.ts";
import { FIELD_ALIASES as PROCEDURE_ALIASES } from "../fhir/normalize/procedure.ts";
import { FIELD_ALIASES as SERVICE_REQUEST_ALIASES } from "../fhir/normalize/service-request.ts";
import { FIELD_ALIASES as SPECIMEN_ALIASES } from "../fhir/normalize/specimen.ts";

import { sameNameRenderings } from "./tree.ts";

import type { FieldAlias } from "../fhir/normalize/types.ts";

/** Every resource type this codebase normalizes. */
type ResourceTypeName = (typeof NORMALIZED_TYPES)[number];

/** True for a type this module has aliases for. */
function isKnownResourceType(resourceType: string): resourceType is ResourceTypeName {
  return (NORMALIZED_TYPES as readonly string[]).includes(resourceType);
}

// --- renames, aggregated from each normalize module -------------------------

/**
 * Every `NormalizedBase` field is exactly one raw rename: `lastUpdated` comes
 * from `resource.meta?.lastUpdated` in every `normalizeX` function. Declared
 * once here rather than copied into all 21 modules, and applied to every
 * resource type -- known or not, so an unmodeled type's `lastUpdated` is still
 * covered.
 */
const COMMON_ALIASES: readonly FieldAlias[] = [
  { normalized: ["lastUpdated"], raw: [["meta", "lastUpdated"]], rendered: true },
];

const ALIASES_BY_TYPE = {
  Encounter: ENCOUNTER_ALIASES,
  Condition: CONDITION_ALIASES,
  Observation: OBSERVATION_ALIASES,
  MedicationRequest: MEDICATION_REQUEST_ALIASES,
  MedicationDispense: MEDICATION_DISPENSE_ALIASES,
  AllergyIntolerance: ALLERGY_ALIASES,
  Immunization: IMMUNIZATION_ALIASES,
  Procedure: PROCEDURE_ALIASES,
  DiagnosticReport: DIAGNOSTIC_REPORT_ALIASES,
  DocumentReference: DOCUMENT_REFERENCE_ALIASES,
  CarePlan: CARE_PLAN_ALIASES,
  CareTeam: CARE_TEAM_ALIASES,
  Goal: GOAL_ALIASES,
  Device: DEVICE_ALIASES,
  Coverage: COVERAGE_ALIASES,
  ServiceRequest: SERVICE_REQUEST_ALIASES,
  Specimen: SPECIMEN_ALIASES,
  Patient: PATIENT_ALIASES,
  Practitioner: PRACTITIONER_ALIASES,
  Location: LOCATION_ALIASES,
  Organization: ORGANIZATION_ALIASES,
  // `satisfies Record<ResourceTypeName, ...>` below: adding a resource type to
  // `NORMALIZED_TYPES` without adding it here is a compile error, not a silent
  // gap in the vocabulary a `field` rule is translated through.
} satisfies Record<ResourceTypeName, readonly FieldAlias[]>;

/** `ALIASES_BY_TYPE` as a `Map`, so a lookup by a caller-supplied resource type
 * string is never the bracket-access shape `security/detect-object-injection`
 * flags. */
const ALIASES_MAP: ReadonlyMap<ResourceTypeName, readonly FieldAlias[]> = new Map(
  Object.entries(ALIASES_BY_TYPE) as [ResourceTypeName, readonly FieldAlias[]][],
);

const aliasCache = new Map<string, readonly FieldAlias[]>();

/**
 * Every alias for one resource type: the common one, the module's own, and the
 * same-name renderings the field tree implies (`sameNameRenderings`).
 */
function aliasesFor(resourceType: string): readonly FieldAlias[] {
  const cached = aliasCache.get(resourceType);
  if (cached !== undefined) return cached;
  const aliases = isKnownResourceType(resourceType)
    ? [
        ...COMMON_ALIASES,
        ...(ALIASES_MAP.get(resourceType) ?? []),
        ...sameNameRenderings(resourceType),
      ]
    : COMMON_ALIASES;
  aliasCache.set(resourceType, aliases);
  return aliases;
}

// --- the path-alias engine ---------------------------------------------------

/** `toNormalized` translates a path that may be raw-authored into the
 * normalized shape; `toRaw` translates a path that may be normalized-authored
 * into the raw shape. Either direction leaves an already-correctly-shaped path
 * alone, since no rename ever reuses the same spelling on both sides. */
export type AliasDirection = "toNormalized" | "toRaw";

/** True when one path segment matches one alias segment. A `stem[x]` in the
 * path matches any variant the alias spells out (`value[x]` ~ `valueQuantity`). */
function segmentMatches(pathSegment: string, aliasSegment: string): boolean {
  return (
    pathSegment === aliasSegment ||
    (isChoiceSegment(pathSegment) && matchesChoice(pathSegment, aliasSegment))
  );
}

/**
 * How many segments of `path` the alias `prefix` consumes, or -1 when it is
 * not a prefix of `path` at all.
 *
 * Array markers are skipped on both sides: the filter steps into an array
 * whether or not the path says `[]` (see `prune` in `filter.ts`), so
 * `practitioners.name` and `practitioners[].name` are the same rule and must
 * translate the same way. A marker in `path` directly after the matched prefix
 * is left for the remainder -- `components[]` stays "every element" once it is
 * translated to `component[]`.
 */
function prefixLength(
  path: readonly string[],
  prefix: readonly string[],
  ancestorMatches: boolean,
): number {
  let index = 0;
  for (const aliasSegment of prefix) {
    if (aliasSegment === ARRAY_SEGMENT) continue;
    while (path.at(index) === ARRAY_SEGMENT) index += 1;
    const segment = path.at(index);
    // The path ended above the alias: it names an ancestor of the aliased
    // field, which takes the field with it.
    if (segment === undefined) return ancestorMatches && index > 0 ? path.length : -1;
    if (!segmentMatches(segment, aliasSegment)) return -1;
    index += 1;
  }
  return index;
}

/** The alias alternatives to match `path` against (`from`), and to translate a
 * match into (`to`), for one direction -- `toNormalized` matches against the
 * raw alternatives and translates to the one normalized spelling; `toRaw` is
 * the mirror image. */
function alternatives(
  alias: FieldAlias,
  direction: AliasDirection,
): { from: readonly (readonly string[])[]; to: readonly (readonly string[])[] } {
  return direction === "toNormalized"
    ? { from: alias.raw, to: [alias.normalized] }
    : { from: [alias.normalized], to: alias.raw };
}

/**
 * The longest alias prefix that starts `path`, and every alias tied for that
 * length -- ties matter because `toNormalized` tries several raw spellings of
 * one normalized concept (a `value[x]` choice type), and one raw field can
 * have more than one normalized name (the Encounter shape's and the
 * appointment view's).
 */
function longestMatch(
  path: readonly string[],
  aliases: readonly FieldAlias[],
  direction: AliasDirection,
): { length: number; matches: readonly FieldAlias[] } {
  let length = 0;
  let matches: FieldAlias[] = [];
  for (const alias of aliases) {
    // Removing an ancestor of a rendered field's source (`code.coding[]`, or
    // all of `code`) removes what the field was rendered from, so the field
    // goes too. For a plain rename the ancestor is its own, shorter alias.
    const ancestorMatches = direction === "toNormalized" && alias.rendered === true;
    for (const prefix of alternatives(alias, direction).from) {
      const consumed = prefixLength(path, prefix, ancestorMatches);
      if (consumed <= 0) continue;
      if (consumed > length) {
        length = consumed;
        matches = [];
      }
      if (consumed === length && !matches.includes(alias)) matches.push(alias);
    }
  }
  return { length, matches };
}

/** A path array as a `Map` key, so equal paths dedupe regardless of identity. */
function pathKey(path: readonly string[]): string {
  return path.join("\u{0}");
}

/**
 * Every path the choke point should try against one shape for a rule that may
 * have been authored in either vocabulary: the path exactly as written (safe
 * even when no alias applies -- it is how a rule already in this shape's
 * vocabulary, or one naming a field whose spelling never changed, keeps
 * working), plus whatever the longest matching alias translates it to.
 *
 * Only the longest prefix match is used, not every match: a shorter match
 * would translate a nested rename's leading segment on its own and strand the
 * rest of the path in the wrong vocabulary (see the file comment).
 */
export function expandPath(
  resourceType: string,
  path: readonly string[],
  direction: AliasDirection,
): readonly (readonly string[])[] {
  const { length, matches } = longestMatch(path, aliasesFor(resourceType), direction);
  const remainder = path.slice(length);

  const candidates = new Map<string, readonly string[]>([[pathKey(path), path]]);
  for (const alias of matches) {
    // A rendered field has no structure below it to carry the tail into: the
    // whole of it is what the raw path's value was rendered into.
    const tail = direction === "toNormalized" && alias.rendered === true ? [] : remainder;
    for (const prefix of alternatives(alias, direction).to) {
      const candidate = [...prefix, ...tail];
      candidates.set(pathKey(candidate), candidate);
    }
  }
  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Iterator#toArray() needs a lib newer than the ES2022 one this Worker compiles against (see the `Array#toSorted` note in `worker/policy/filter.ts`).
  return [...candidates.values()];
}
