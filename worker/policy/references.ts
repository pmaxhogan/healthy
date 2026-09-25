/**
 * References: the one place a resource names another one in passing.
 *
 * A FHIR `Reference` carries a `display` -- the referenced resource's name,
 * copied in by the health system -- wherever it appears: `subject`,
 * `performer[]`, `resultsInterpreter[]`, `participant[].individual`, inside an
 * extension, inside a contained resource. A `field` rule names paths, and no
 * owner can be expected to list every path a Practitioner's name could sit
 * under in every resource type. So the choke point treats the display as what
 * it is -- a copy of the referenced resource -- and judges it by the policy
 * that resource's type is under:
 *
 *  (a) a type a `resource` rule denies: its displays go everywhere;
 *  (b) Patient / RelatedPerson, when a hide rule reaches the patient's `name`
 *      or the `sensitive` default withholds it;
 *  (c) Practitioner / PractitionerRole / Person, when that type is denied, a
 *      hide rule reaches its `name`, or a hide rule reaches one of the fields a
 *      clinician's name is rendered into (an Encounter's `practitioners`, a
 *      request's `requester`, ...).
 *
 * A reference whose target type cannot be read -- a `urn:uuid:`, a `#id` with
 * no matching contained resource, a bare `{ display }` -- is removed whenever
 * any person type is restricted: failing closed is the only safe reading of
 * "we do not know whose name this is".
 *
 * The normalized items carry the same names, rendered to strings by
 * `refs.display` (`worker/fhir/normalize/refs.ts`). {@link REFERENCE_FIELDS}
 * lists every normalized field that is a reference rendered to text, with the
 * raw element it came from and the types FHIR R4 allows that element to point
 * at; the normalized field goes when the reference it was read from would.
 */

import { ARRAY_SEGMENT } from "@shared/policy-path.ts";

import { isSensitiveAllowed, ruleReaches, type ItemScope, type PolicyRules } from "./rules.ts";
import { SENSITIVE_FIELDS } from "./tree.ts";

/** The patient and the people speaking for them. */
const PATIENT_TYPES: readonly string[] = ["Patient", "RelatedPerson"];

/** Clinicians. */
const PRACTITIONER_TYPES: readonly string[] = ["Practitioner", "PractitionerRole", "Person"];

const PERSON_TYPES: ReadonlySet<string> = new Set([...PATIENT_TYPES, ...PRACTITIONER_TYPES]);

/** What reference targets the policy withholds in one scope. */
export interface Restriction {
  /** Target resource types whose displays are removed. */
  types: ReadonlySet<string>;
  /** True when any person type is restricted: an untyped reference is then removed too. */
  person: boolean;
}

/** One normalized field read through a Reference: its display, or the resource it points at. */
interface ReferenceField {
  /** The normalized path the rendered value sits at. */
  normalized: readonly string[];
  /** The raw Reference element (not its `display`) it was read from. */
  raw: readonly string[];
  /** Every type FHIR R4 lets that element point at: the fallback when the raw is not in hand. */
  targets: readonly string[];
  /**
   * True when the field is the referenced party's name. A hide rule on one of
   * those restricts clinicians' names everywhere; a rule on the others (a
   * specialty, an address) is only itself.
   */
  name?: true;
}

const ACTOR_TARGETS = [
  "Practitioner",
  "PractitionerRole",
  "Organization",
  "Patient",
  "RelatedPerson",
  "Device",
] as const;

const PARTICIPANT_TARGETS = ["Practitioner", "PractitionerRole", "RelatedPerson"] as const;

/**
 * Every normalized field rendered from a Reference, by resource type. A test
 * pins it against the normalizers, so a new `refs.display` call without an
 * entry here fails rather than leaking.
 */
export const REFERENCE_FIELDS: ReadonlyMap<string, readonly ReferenceField[]> = new Map<
  string,
  readonly ReferenceField[]
>([
  [
    "Encounter",
    [
      {
        normalized: ["practitioners", ARRAY_SEGMENT, "name"],
        raw: ["participant", ARRAY_SEGMENT, "individual"],
        targets: PARTICIPANT_TARGETS,
        name: true,
      },
      // Read from the referenced Practitioner resource itself.
      {
        normalized: ["practitioners", ARRAY_SEGMENT, "specialty"],
        raw: ["participant", ARRAY_SEGMENT, "individual"],
        targets: PARTICIPANT_TARGETS,
      },
      // The appointment view (`get_appointments`, the summary) under the same type.
      {
        normalized: ["practitioner"],
        raw: ["participant", ARRAY_SEGMENT, "individual"],
        targets: PARTICIPANT_TARGETS,
        name: true,
      },
      {
        normalized: ["specialty"],
        raw: ["participant", ARRAY_SEGMENT, "individual"],
        targets: PARTICIPANT_TARGETS,
      },
      // A Location's name, address and phone, and the department's name.
      {
        normalized: ["location"],
        raw: ["location", ARRAY_SEGMENT, "location"],
        targets: ["Location"],
      },
      {
        normalized: ["department"],
        raw: ["location", ARRAY_SEGMENT, "location"],
        targets: ["Location"],
      },
      { normalized: ["organization"], raw: ["serviceProvider"], targets: ["Organization"] },
      { normalized: ["org"], raw: ["serviceProvider"], targets: ["Organization"] },
    ],
  ],
  [
    "MedicationRequest",
    [
      { normalized: ["requester"], raw: ["requester"], targets: ACTOR_TARGETS, name: true },
      { normalized: ["medication"], raw: ["medicationReference"], targets: ["Medication"] },
    ],
  ],
  [
    "MedicationDispense",
    [{ normalized: ["medication"], raw: ["medicationReference"], targets: ["Medication"] }],
  ],
  [
    "ServiceRequest",
    [{ normalized: ["requester"], raw: ["requester"], targets: ACTOR_TARGETS, name: true }],
  ],
  [
    "Procedure",
    [
      {
        normalized: ["performers", ARRAY_SEGMENT, "name"],
        raw: ["performer", ARRAY_SEGMENT, "actor"],
        targets: ACTOR_TARGETS,
        name: true,
      },
    ],
  ],
  [
    "DocumentReference",
    [
      {
        normalized: ["author"],
        raw: ["author"],
        targets: ACTOR_TARGETS,
        name: true,
      },
    ],
  ],
  [
    "CareTeam",
    [
      {
        normalized: ["participants", ARRAY_SEGMENT, "name"],
        raw: ["participant", ARRAY_SEGMENT, "member"],
        targets: [...ACTOR_TARGETS, "CareTeam"],
        name: true,
      },
    ],
  ],
  [
    "Coverage",
    [
      {
        normalized: ["payor"],
        raw: ["payor"],
        targets: ["Organization", "Patient", "RelatedPerson"],
      },
    ],
  ],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

function named(path: readonly string[]): string[] {
  return path.filter((segment) => segment !== ARRAY_SEGMENT);
}

/** True when one path is a prefix of the other, array markers ignored: either one takes the other with it. */
function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const left = named(a);
  const right = named(b);
  const length = Math.min(left.length, right.length);
  return length > 0 && left.slice(0, length).every((segment, index) => segment === right.at(index));
}

/**
 * True when a hide rule reaching `resourceType` in this scope touches `path`.
 *
 * `anyTool` drops the rule's tool scope from the test. It is how a rule on a
 * person resource's OWN `name` is read: a `Patient.name` rule scoped to
 * `get_patient_profile` (the only tool a Patient item appears in) is the
 * owner saying the name is not to be shown, and it must reach the copy of it
 * in every other tool's resources, or the scope would be a way around it. A
 * rule on a field a name is rendered into (`participants[].name` in one tool)
 * is about that tool's answer, and keeps its tool scope.
 */
function hidesIn(
  rules: PolicyRules,
  scope: ItemScope,
  target: { resourceType: string; path: readonly string[]; anyTool: boolean },
): boolean {
  return rules.fields.some(
    (rule) =>
      ruleReaches(rule, {
        ...scope,
        tool: target.anyTool ? (rule.tool ?? scope.tool) : scope.tool,
        resourceType: target.resourceType,
      }) && overlaps(rule.path, target.path),
  );
}

/** A person resource's own `name`, under any tool scope. */
const ownName = (resourceType: string) => ({ resourceType, path: ["name"], anyTool: true });

function patientNameHidden(rules: PolicyRules, scope: ItemScope): boolean {
  const hidden = PATIENT_TYPES.some(
    (type) => rules.resources.has(type) || hidesIn(rules, scope, ownName(type)),
  );
  if (hidden) return true;
  const sensitive = SENSITIVE_FIELDS.get("Patient") ?? [];
  return (
    sensitive.includes("name") &&
    !isSensitiveAllowed(rules, { ...scope, resourceType: "Patient" }, "name")
  );
}

function practitionerNameHidden(rules: PolicyRules, scope: ItemScope): boolean {
  const hidden = PRACTITIONER_TYPES.some(
    (type) => rules.resources.has(type) || hidesIn(rules, scope, ownName(type)),
  );
  if (hidden) return true;
  // A rule on a field a clinician's name is rendered into -- normalized or raw
  // spelling -- is a rule against clinicians' names.
  for (const [resourceType, fields] of REFERENCE_FIELDS) {
    for (const field of fields) {
      if (field.name !== true || !field.targets.includes("Practitioner")) continue;
      if (
        hidesIn(rules, scope, { resourceType, path: field.normalized, anyTool: false }) ||
        hidesIn(rules, scope, { resourceType, path: [...field.raw, "display"], anyTool: false })
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The reference targets withheld in one scope: the item's tool and health
 * system. The item's own resource type is not part of it -- a name is a name
 * wherever it is referenced from -- and a rule on a person's own `name`
 * reaches every tool (see `hidesIn`).
 */
export function restrictionFor(rules: PolicyRules, scope: ItemScope): Restriction {
  const types = new Set<string>(rules.resources);
  if (patientNameHidden(rules, scope)) for (const type of PATIENT_TYPES) types.add(type);
  if (practitionerNameHidden(rules, scope)) for (const type of PRACTITIONER_TYPES) types.add(type);
  let person = false;
  for (const type of types) if (PERSON_TYPES.has(type)) person = true;
  return { types, person };
}

/** True when nothing is restricted: the walk can be skipped. */
export function isUnrestricted(restriction: Restriction): boolean {
  return restriction.types.size === 0;
}

// --- reading a reference's target type ---------------------------------------

const RESOURCE_TYPE = /^[A-Z][A-Za-z]{1,63}$/u;

/** The type a literal `reference` points at, or null when it cannot be read. */
function typeFromReference(
  reference: string,
  contained: ReadonlyMap<string, string>,
): string | null {
  if (reference.startsWith("#")) return contained.get(reference.slice(1)) ?? null;
  const bare = reference.split(/[?#]/u, 1)[0] ?? "";
  const withoutHistory = bare.split("/_history/", 1)[0] ?? bare;
  const segments = withoutHistory.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const type = segments.at(-2) ?? "";
  return RESOURCE_TYPE.test(type) ? type : null;
}

/** The type a `Reference.type` URI names (`Practitioner`, or a StructureDefinition URL). */
function typeFromTypeUri(uri: string): string | null {
  const last = uri.split("/").at(-1) ?? "";
  return RESOURCE_TYPE.test(last) ? last : null;
}

/** Every type one reference names, from `reference` and `type`; empty when it names none. */
function targetTypes(
  ref: Record<string, unknown>,
  contained: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  const reference = own(ref, "reference");
  if (typeof reference === "string") {
    const type = typeFromReference(reference, contained);
    if (type !== null) out.push(type);
  }
  const typeUri = own(ref, "type");
  if (typeof typeUri === "string") {
    const type = typeFromTypeUri(typeUri);
    if (type !== null) out.push(type);
  }
  return out;
}

/**
 * The type to name in the warning when a reference with these targets is
 * withheld, or null when it is not withheld.
 */
function withheldAs(targets: readonly string[], restriction: Restriction): string | null {
  if (targets.length === 0) return restriction.person ? "unknown" : null;
  return targets.find((type) => restriction.types.has(type)) ?? null;
}

// --- the raw walk -----------------------------------------------------------

/** Keys only a Coding has: a `display` beside one of them is a code's text, not a name. */
const CODING_KEYS: readonly string[] = ["system", "code", "version", "userSelected"];

/**
 * True for an object that is (or has to be treated as) a FHIR Reference:
 * a literal `reference`, a typed logical reference, or a `display` that is not
 * a Coding's. A bare `{ display }` counts -- Epic sends performers that way.
 */
function isReference(value: Record<string, unknown>): boolean {
  if (typeof own(value, "resourceType") === "string") return false;
  if (typeof own(value, "reference") === "string") return true;
  const typedLogical = typeof own(value, "type") === "string" && isRecord(own(value, "identifier"));
  const namedOnly =
    typeof own(value, "display") === "string" &&
    CODING_KEYS.every((key) => !Object.hasOwn(value, key));
  return typedLogical || namedOnly;
}

/** One walk's context: what is withheld, and what `#id` points at. */
export interface WalkContext {
  restriction: Restriction;
  /** Contained resource ids to their resource types, for `#id` references. */
  contained: ReadonlyMap<string, string>;
  warnings: Set<string>;
}

interface Walked {
  changed: boolean;
  value: unknown;
}

/** The keys a withheld reference loses: the name, and the identifier (an NPI, an MRN) beside it. */
const WITHHELD_KEYS: ReadonlySet<string> = new Set(["display", "identifier"]);

function withoutKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key)));
}

/** Judge one record that may be a Reference; returns it with the withheld keys gone. */
function judgeReference(value: Record<string, unknown>, context: WalkContext): Walked {
  if (!isReference(value)) return { changed: false, value };
  const as = withheldAs(targetTypes(value, context.contained), context.restriction);
  if (as === null || [...WITHHELD_KEYS].every((key) => !Object.hasOwn(value, key))) {
    return { changed: false, value };
  }
  context.warnings.add(`policy_reference_display_removed:${as}`);
  return { changed: true, value: withoutKeys(value, WITHHELD_KEYS) };
}

/**
 * An Annotation's `authorString` is a person's name with no reference to type
 * it by: removed whenever any person type is restricted.
 */
function judgeAnnotation(value: Record<string, unknown>, context: WalkContext): Walked {
  if (!context.restriction.person || typeof own(value, "authorString") !== "string") {
    return { changed: false, value };
  }
  context.warnings.add("policy_reference_display_removed:unknown");
  return { changed: true, value: withoutKeys(value, new Set(["authorString"])) };
}

/**
 * Rebuild `value` with every withheld reference's `display` (and `identifier`)
 * gone, at any depth. `skip` names keys of the top-level record not to walk
 * (a resource's `contained`, which is filtered as resources of their own).
 * Nothing under a `coding` key is ever a reference.
 */
export function walkReferences(
  value: unknown,
  context: WalkContext,
  skip: ReadonlySet<string> = EMPTY_KEYS,
): Walked {
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const element of value as unknown[]) {
      const next = walkReferences(element, context);
      if (next.changed) changed = true;
      out.push(next.value);
    }
    return changed ? { changed, value: out } : { changed: false, value };
  }
  if (!isRecord(value)) return { changed: false, value };

  const asReference = judgeReference(value, context);
  const asAnnotation = judgeAnnotation(asReference.value as Record<string, unknown>, context);
  let changed = asReference.changed || asAnnotation.changed;
  const entries: [string, unknown][] = [];
  for (const [key, child] of Object.entries(asAnnotation.value as Record<string, unknown>)) {
    if (key === "coding" || skip.has(key)) {
      entries.push([key, child]);
      continue;
    }
    const next = walkReferences(child, context);
    if (next.changed) changed = true;
    entries.push([key, next.value]);
  }
  return changed ? { changed, value: Object.fromEntries(entries) } : { changed: false, value };
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

// --- the normalized side ----------------------------------------------------

/** Every Reference record at `path` below `value`, stepping into arrays wherever they are met. */
function referencesAt(value: unknown, path: readonly string[]): Record<string, unknown>[] {
  let level: unknown[] = [value];
  for (const segment of path) {
    const next: unknown[] = [];
    for (const node of level.flat()) {
      if (!isRecord(node)) continue;
      next.push(segment === ARRAY_SEGMENT ? node : own(node, segment));
    }
    level = next;
  }
  return level.flat().filter((node) => isRecord(node));
}

/**
 * The type a normalized reference field is withheld as, or null when it is
 * not. With the raw resource it was read from in hand, the references
 * actually there decide; without it (or when none is there -- the value came
 * from somewhere else, like a patient portal), every type the element may
 * point at does, which fails closed.
 */
function fieldWithheldAs(
  field: ReferenceField,
  source: unknown,
  restriction: Restriction,
  contained: ReadonlyMap<string, string>,
): string | null {
  const found = source === undefined ? [] : referencesAt(source, field.raw);
  if (found.length === 0) {
    return field.targets.find((type) => restriction.types.has(type)) ?? null;
  }
  for (const reference of found) {
    const as = withheldAs(targetTypes(reference, contained), restriction);
    if (as !== null) return as;
  }
  return null;
}

/** Contained resource ids to their types, for resolving `#id` references. */
export function containedTypes(resource: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!isRecord(resource)) return out;
  const contained = own(resource, "contained");
  if (!Array.isArray(contained)) return out;
  for (const entry of contained as unknown[]) {
    if (!isRecord(entry)) continue;
    const id = own(entry, "id");
    const type = own(entry, "resourceType");
    if (typeof id === "string" && typeof type === "string") out.set(id, type);
  }
  return out;
}

/**
 * The normalized paths to remove from one item of `resourceType`, each with
 * the type it is withheld as. `source` is the raw resource the item was
 * normalized from, when the caller has it.
 */
export function withheldNormalizedPaths(
  resourceType: string,
  source: unknown,
  restriction: Restriction,
): { path: readonly string[]; as: string }[] {
  if (isUnrestricted(restriction)) return [];
  const contained = containedTypes(source);
  const out: { path: readonly string[]; as: string }[] = [];
  const fields = REFERENCE_FIELDS.get(resourceType) ?? [];
  for (const field of fields) {
    const as = fieldWithheldAs(field, source, restriction, contained);
    if (as !== null) out.push({ path: field.normalized, as });
  }
  return out;
}
