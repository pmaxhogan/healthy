/**
 * The `field` rule's vocabulary, and the engine that resolves a path written
 * in either one against the other shape.
 *
 * `worker/policy/filter.ts` is the one place a `field` rule is enforced, and it
 * enforces every rule against two different shapes of the same data: the
 * normalized item the tools return by default, and the raw FHIR resource
 * behind it (`raw: true`). Those two shapes rename the same concept in a lot
 * of places -- Observation's `value` is `valueQuantity` (or one of four other
 * `value[x]` siblings) in the raw resource, its `components[]` is `component[]`
 * -- so a rule written in one vocabulary has to be translated before it can be
 * applied against the other, or half the choke point's job silently does not
 * happen. That translation table lives next to the `normalizeX` function that
 * performs each rename (`worker/fhir/normalize/<type>.ts` exports
 * `FIELD_ALIASES`), so a future rename and its alias entry cannot drift apart
 * in separate files; this module only aggregates them and does the resolving.
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

import type {
  FieldAlias,
  NormalizedAllergy,
  NormalizedAppointmentView,
  NormalizedCarePlan,
  NormalizedCareTeam,
  NormalizedCondition,
  NormalizedCoverage,
  NormalizedDevice,
  NormalizedDiagnosticReport,
  NormalizedDocumentReference,
  NormalizedEncounter,
  NormalizedGoal,
  NormalizedImmunization,
  NormalizedLocation,
  NormalizedMedicationDispense,
  NormalizedMedicationRequest,
  NormalizedObservation,
  NormalizedOrganization,
  NormalizedPatient,
  NormalizedPractitioner,
  NormalizedProcedure,
  NormalizedServiceRequest,
  NormalizedSpecimen,
} from "../fhir/normalize/types.ts";
import type * as fhir4 from "fhir/r4";

/** Every resource type this codebase can validate a `field` rule against. */
type ResourceTypeName = (typeof NORMALIZED_TYPES)[number];

/** True for a type this module has a vocabulary for. */
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
  { normalized: ["lastUpdated"], raw: [["meta", "lastUpdated"]] },
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
  // gap in the vocabulary a `field` rule is checked against.
} satisfies Record<ResourceTypeName, readonly FieldAlias[]>;

/** `ALIASES_BY_TYPE` as a `Map`, so a lookup by a caller-supplied resource type
 * string is never the bracket-access shape `security/detect-object-injection`
 * flags. */
const ALIASES_MAP: ReadonlyMap<ResourceTypeName, readonly FieldAlias[]> = new Map(
  Object.entries(ALIASES_BY_TYPE) as [ResourceTypeName, readonly FieldAlias[]][],
);

function aliasesFor(resourceType: string): readonly FieldAlias[] {
  return isKnownResourceType(resourceType)
    ? [...COMMON_ALIASES, ...(ALIASES_MAP.get(resourceType) ?? [])]
    : COMMON_ALIASES;
}

// --- the known vocabulary of each shape, for write-time validation ----------
//
// Each list is `as const satisfies readonly (keyof fhir4.X | keyof NormalizedX)[]`:
// not exhaustive against the full FHIR R4 spec or every optional normalized
// key by itself, but every entry is checked by the compiler against the real
// type this codebase already imports everywhere else, so a typo here is a
// build failure rather than a rule that is wrongly rejected or wrongly let
// through.

const RAW_BASE_FIELDS = [
  "id",
  "meta",
  "implicitRules",
  "language",
  "text",
  "contained",
  "extension",
  "modifierExtension",
] as const satisfies readonly (keyof fhir4.DomainResource)[];

const NORMALIZED_BASE_FIELDS = ["resourceType", "id", "provider", "lastUpdated"] as const;

const ENCOUNTER_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "status",
  "statusHistory",
  "class",
  "classHistory",
  "type",
  "serviceType",
  "priority",
  "subject",
  "episodeOfCare",
  "basedOn",
  "participant",
  "appointment",
  "period",
  "length",
  "reasonCode",
  "reasonReference",
  "diagnosis",
  "account",
  "hospitalization",
  "location",
  "serviceProvider",
  "partOf",
] as const satisfies readonly (keyof fhir4.Encounter)[];

const CONDITION_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "clinicalStatus",
  "verificationStatus",
  "category",
  "severity",
  "code",
  "bodySite",
  "subject",
  "encounter",
  "onsetDateTime",
  "onsetAge",
  "onsetPeriod",
  "onsetRange",
  "onsetString",
  "abatementDateTime",
  "abatementAge",
  "abatementPeriod",
  "abatementRange",
  "abatementString",
  "recordedDate",
  "recorder",
  "asserter",
  "stage",
  "evidence",
  "note",
] as const satisfies readonly (keyof fhir4.Condition)[];

const OBSERVATION_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "basedOn",
  "partOf",
  "status",
  "category",
  "code",
  "subject",
  "focus",
  "encounter",
  "effectiveDateTime",
  "effectivePeriod",
  "effectiveTiming",
  "effectiveInstant",
  "issued",
  "performer",
  "valueQuantity",
  "valueCodeableConcept",
  "valueString",
  "valueBoolean",
  "valueInteger",
  "valueRange",
  "valueRatio",
  "valueSampledData",
  "valueTime",
  "valueDateTime",
  "valuePeriod",
  "dataAbsentReason",
  "interpretation",
  "note",
  "bodySite",
  "method",
  "specimen",
  "device",
  "referenceRange",
  "hasMember",
  "derivedFrom",
  "component",
] as const satisfies readonly (keyof fhir4.Observation)[];

const MEDICATION_REQUEST_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "status",
  "statusReason",
  "intent",
  "category",
  "priority",
  "doNotPerform",
  "reportedBoolean",
  "reportedReference",
  "medicationCodeableConcept",
  "medicationReference",
  "subject",
  "encounter",
  "supportingInformation",
  "authoredOn",
  "requester",
  "performer",
  "performerType",
  "recorder",
  "reasonCode",
  "reasonReference",
  "instantiatesCanonical",
  "instantiatesUri",
  "basedOn",
  "groupIdentifier",
  "courseOfTherapyType",
  "insurance",
  "note",
  "dosageInstruction",
  "dispenseRequest",
  "substitution",
  "priorPrescription",
  "detectedIssue",
  "eventHistory",
] as const satisfies readonly (keyof fhir4.MedicationRequest)[];

const MEDICATION_DISPENSE_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "partOf",
  "status",
  "statusReasonCodeableConcept",
  "statusReasonReference",
  "category",
  "medicationCodeableConcept",
  "medicationReference",
  "subject",
  "context",
  "supportingInformation",
  "performer",
  "location",
  "authorizingPrescription",
  "type",
  "quantity",
  "daysSupply",
  "whenPrepared",
  "whenHandedOver",
  "destination",
  "receiver",
  "note",
  "dosageInstruction",
  "substitution",
  "detectedIssue",
  "eventHistory",
] as const satisfies readonly (keyof fhir4.MedicationDispense)[];

const ALLERGY_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "clinicalStatus",
  "verificationStatus",
  "type",
  "category",
  "criticality",
  "code",
  "patient",
  "encounter",
  "onsetDateTime",
  "onsetAge",
  "onsetPeriod",
  "onsetRange",
  "onsetString",
  "recordedDate",
  "recorder",
  "asserter",
  "lastOccurrence",
  "note",
  "reaction",
] as const satisfies readonly (keyof fhir4.AllergyIntolerance)[];

const IMMUNIZATION_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "status",
  "statusReason",
  "vaccineCode",
  "patient",
  "encounter",
  "occurrenceDateTime",
  "occurrenceString",
  "recorded",
  "primarySource",
  "reportOrigin",
  "location",
  "manufacturer",
  "lotNumber",
  "expirationDate",
  "site",
  "route",
  "doseQuantity",
  "performer",
  "note",
  "reasonCode",
  "reasonReference",
  "isSubpotent",
  "subpotentReason",
  "education",
  "programEligibility",
  "fundingSource",
  "reaction",
  "protocolApplied",
] as const satisfies readonly (keyof fhir4.Immunization)[];

const PROCEDURE_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "instantiatesCanonical",
  "instantiatesUri",
  "basedOn",
  "partOf",
  "status",
  "statusReason",
  "category",
  "code",
  "subject",
  "encounter",
  "performedDateTime",
  "performedPeriod",
  "performedString",
  "performedAge",
  "performedRange",
  "recorder",
  "asserter",
  "performer",
  "location",
  "reasonCode",
  "reasonReference",
  "bodySite",
  "outcome",
  "report",
  "complication",
  "complicationDetail",
  "followUp",
  "note",
  "focalDevice",
  "usedReference",
  "usedCode",
] as const satisfies readonly (keyof fhir4.Procedure)[];

const DIAGNOSTIC_REPORT_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "basedOn",
  "status",
  "category",
  "code",
  "subject",
  "encounter",
  "effectiveDateTime",
  "effectivePeriod",
  "issued",
  "performer",
  "resultsInterpreter",
  "specimen",
  "result",
  "imagingStudy",
  "media",
  "conclusion",
  "conclusionCode",
  "presentedForm",
] as const satisfies readonly (keyof fhir4.DiagnosticReport)[];

const DOCUMENT_REFERENCE_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "masterIdentifier",
  "identifier",
  "status",
  "docStatus",
  "type",
  "category",
  "subject",
  "date",
  "author",
  "authenticator",
  "custodian",
  "relatesTo",
  "description",
  "securityLabel",
  "content",
  "context",
] as const satisfies readonly (keyof fhir4.DocumentReference)[];

const CARE_PLAN_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "instantiatesCanonical",
  "instantiatesUri",
  "basedOn",
  "replaces",
  "partOf",
  "status",
  "intent",
  "category",
  "title",
  "description",
  "subject",
  "encounter",
  "period",
  "created",
  "author",
  "contributor",
  "careTeam",
  "addresses",
  "supportingInfo",
  "goal",
  "activity",
  "note",
] as const satisfies readonly (keyof fhir4.CarePlan)[];

const CARE_TEAM_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "status",
  "category",
  "name",
  "subject",
  "encounter",
  "period",
  "participant",
  "reasonCode",
  "reasonReference",
  "managingOrganization",
  "telecom",
  "note",
] as const satisfies readonly (keyof fhir4.CareTeam)[];

const GOAL_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "lifecycleStatus",
  "achievementStatus",
  "category",
  "priority",
  "description",
  "subject",
  "startDate",
  "startCodeableConcept",
  "target",
  "statusDate",
  "statusReason",
  "expressedBy",
  "addresses",
  "note",
  "outcomeCode",
  "outcomeReference",
] as const satisfies readonly (keyof fhir4.Goal)[];

const DEVICE_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "definition",
  "udiCarrier",
  "status",
  "statusReason",
  "distinctIdentifier",
  "manufacturer",
  "manufactureDate",
  "expirationDate",
  "lotNumber",
  "serialNumber",
  "deviceName",
  "modelNumber",
  "partNumber",
  "type",
  "specialization",
  "version",
  "property",
  "patient",
  "owner",
  "contact",
  "location",
  "url",
  "note",
  "safety",
  "parent",
] as const satisfies readonly (keyof fhir4.Device)[];

const COVERAGE_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "status",
  "type",
  "policyHolder",
  "subscriber",
  "subscriberId",
  "beneficiary",
  "dependent",
  "relationship",
  "period",
  "payor",
  "class",
  "order",
  "network",
  "costToBeneficiary",
  "subrogation",
  "contract",
] as const satisfies readonly (keyof fhir4.Coverage)[];

const SERVICE_REQUEST_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "instantiatesCanonical",
  "instantiatesUri",
  "basedOn",
  "replaces",
  "requisition",
  "status",
  "intent",
  "category",
  "priority",
  "doNotPerform",
  "code",
  "orderDetail",
  "quantityQuantity",
  "quantityRatio",
  "quantityRange",
  "subject",
  "encounter",
  "occurrenceDateTime",
  "occurrencePeriod",
  "occurrenceTiming",
  "asNeededBoolean",
  "asNeededCodeableConcept",
  "authoredOn",
  "requester",
  "performerType",
  "performer",
  "locationCode",
  "locationReference",
  "reasonCode",
  "reasonReference",
  "insurance",
  "supportingInfo",
  "specimen",
  "bodySite",
  "note",
  "patientInstruction",
  "relevantHistory",
] as const satisfies readonly (keyof fhir4.ServiceRequest)[];

const SPECIMEN_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "accessionIdentifier",
  "status",
  "type",
  "subject",
  "receivedTime",
  "parent",
  "request",
  "collection",
  "processing",
  "container",
  "condition",
  "note",
] as const satisfies readonly (keyof fhir4.Specimen)[];

const PATIENT_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "active",
  "name",
  "telecom",
  "gender",
  "birthDate",
  "deceasedBoolean",
  "deceasedDateTime",
  "address",
  "maritalStatus",
  "multipleBirthBoolean",
  "multipleBirthInteger",
  "photo",
  "contact",
  "communication",
  "generalPractitioner",
  "managingOrganization",
  "link",
] as const satisfies readonly (keyof fhir4.Patient)[];

const PRACTITIONER_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "active",
  "name",
  "telecom",
  "address",
  "gender",
  "birthDate",
  "photo",
  "qualification",
  "communication",
] as const satisfies readonly (keyof fhir4.Practitioner)[];

const LOCATION_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "status",
  "operationalStatus",
  "name",
  "alias",
  "description",
  "mode",
  "type",
  "telecom",
  "address",
  "physicalType",
  "position",
  "managingOrganization",
  "partOf",
  "hoursOfOperation",
  "availabilityExceptions",
  "endpoint",
] as const satisfies readonly (keyof fhir4.Location)[];

const ORGANIZATION_RAW_FIELDS = [
  ...RAW_BASE_FIELDS,
  "identifier",
  "active",
  "type",
  "name",
  "alias",
  "telecom",
  "address",
  "partOf",
  "contact",
  "endpoint",
] as const satisfies readonly (keyof fhir4.Organization)[];

const RAW_FIELDS_BY_TYPE = {
  Encounter: ENCOUNTER_RAW_FIELDS,
  Condition: CONDITION_RAW_FIELDS,
  Observation: OBSERVATION_RAW_FIELDS,
  MedicationRequest: MEDICATION_REQUEST_RAW_FIELDS,
  MedicationDispense: MEDICATION_DISPENSE_RAW_FIELDS,
  AllergyIntolerance: ALLERGY_RAW_FIELDS,
  Immunization: IMMUNIZATION_RAW_FIELDS,
  Procedure: PROCEDURE_RAW_FIELDS,
  DiagnosticReport: DIAGNOSTIC_REPORT_RAW_FIELDS,
  DocumentReference: DOCUMENT_REFERENCE_RAW_FIELDS,
  CarePlan: CARE_PLAN_RAW_FIELDS,
  CareTeam: CARE_TEAM_RAW_FIELDS,
  Goal: GOAL_RAW_FIELDS,
  Device: DEVICE_RAW_FIELDS,
  Coverage: COVERAGE_RAW_FIELDS,
  ServiceRequest: SERVICE_REQUEST_RAW_FIELDS,
  Specimen: SPECIMEN_RAW_FIELDS,
  Patient: PATIENT_RAW_FIELDS,
  Practitioner: PRACTITIONER_RAW_FIELDS,
  Location: LOCATION_RAW_FIELDS,
  Organization: ORGANIZATION_RAW_FIELDS,
} satisfies Record<ResourceTypeName, readonly string[]>;

const ENCOUNTER_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "status",
  "class",
  "visitType",
  "start",
  "end",
  "practitioners",
  "location",
  "organization",
  "department",
  "reasons",
  "telehealth",
  "identifiers",
] as const satisfies readonly (keyof NormalizedEncounter)[];

/**
 * The appointment view's own field names.
 *
 * `get_appointments` and `get_health_summary` serve Encounters in the flat
 * calendar-facing shape (`NormalizedAppointmentView`), still tagged
 * `resourceType: "Encounter"` so a `resource` rule reaches them -- and so the
 * `field` rules that reach them are `Encounter.<field>` rules. Without these the
 * write-time check would refuse `Encounter.practitioner` even though that is the
 * key the owner sees in an answer. `source` says whether an item came from FHIR
 * or from the patient portal's upcoming-visits list.
 */
const APPOINTMENT_VIEW_FIELDS = [
  "encounterId",
  "practitioner",
  "specialty",
  "org",
  "csn",
  "source",
] as const satisfies readonly (keyof NormalizedAppointmentView | "source")[];

const CONDITION_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "code",
  "category",
  "clinicalStatus",
  "verificationStatus",
  "onset",
  "recorded",
  "abatement",
] as const satisfies readonly (keyof NormalizedCondition)[];

const OBSERVATION_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "code",
  "category",
  "value",
  "interpretation",
  "referenceRange",
  "effective",
  "issued",
  "status",
  "components",
] as const satisfies readonly (keyof NormalizedObservation)[];

const MEDICATION_REQUEST_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "medication",
  "status",
  "intent",
  "authoredOn",
  "dosageText",
  "requester",
  "reasons",
] as const satisfies readonly (keyof NormalizedMedicationRequest)[];

const MEDICATION_DISPENSE_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "medication",
  "status",
  "quantity",
  "daysSupply",
  "whenHandedOver",
  "dosageText",
] as const satisfies readonly (keyof NormalizedMedicationDispense)[];

const ALLERGY_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "substance",
  "reactions",
  "criticality",
  "clinicalStatus",
  "onset",
] as const satisfies readonly (keyof NormalizedAllergy)[];

const IMMUNIZATION_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "vaccine",
  "occurrence",
  "status",
  "lot",
  "site",
  "route",
  "doseNumber",
] as const satisfies readonly (keyof NormalizedImmunization)[];

const PROCEDURE_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "code",
  "performed",
  "status",
  "performers",
  "reasons",
] as const satisfies readonly (keyof NormalizedProcedure)[];

const DIAGNOSTIC_REPORT_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "code",
  "category",
  "effective",
  "issued",
  "status",
  "conclusion",
  "resultRefs",
  "presentedFormRefs",
] as const satisfies readonly (keyof NormalizedDiagnosticReport)[];

const DOCUMENT_REFERENCE_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "type",
  "category",
  "date",
  "status",
  "description",
  "author",
  "attachments",
] as const satisfies readonly (keyof NormalizedDocumentReference)[];

const CARE_PLAN_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "title",
  "status",
  "intent",
  "category",
  "period",
  "activities",
] as const satisfies readonly (keyof NormalizedCarePlan)[];

const CARE_TEAM_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "name",
  "status",
  "participants",
] as const satisfies readonly (keyof NormalizedCareTeam)[];

const GOAL_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "description",
  "lifecycleStatus",
  "achievementStatus",
  "startDate",
  "targets",
] as const satisfies readonly (keyof NormalizedGoal)[];

const DEVICE_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "type",
  "manufacturer",
  "model",
  "status",
  "udi",
] as const satisfies readonly (keyof NormalizedDevice)[];

const COVERAGE_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "payor",
  "type",
  "subscriberId",
  "status",
  "sensitive",
] as const satisfies readonly (keyof NormalizedCoverage)[];

const SERVICE_REQUEST_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "code",
  "status",
  "intent",
  "occurrence",
  "requester",
  "reasons",
] as const satisfies readonly (keyof NormalizedServiceRequest)[];

const SPECIMEN_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "type",
  "status",
  "collected",
] as const satisfies readonly (keyof NormalizedSpecimen)[];

const PATIENT_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "name",
  "birthDate",
  "gender",
  "address",
  "sensitive",
] as const satisfies readonly (keyof NormalizedPatient)[];

const PRACTITIONER_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "name",
  "gender",
  "qualifications",
] as const satisfies readonly (keyof NormalizedPractitioner)[];

const LOCATION_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "name",
  "address",
  "phone",
  "status",
] as const satisfies readonly (keyof NormalizedLocation)[];

const ORGANIZATION_NORMALIZED_FIELDS = [
  ...NORMALIZED_BASE_FIELDS,
  "name",
  "type",
  "address",
  "phone",
] as const satisfies readonly (keyof NormalizedOrganization)[];

const NORMALIZED_FIELDS_BY_TYPE = {
  Encounter: [...ENCOUNTER_NORMALIZED_FIELDS, ...APPOINTMENT_VIEW_FIELDS],
  Condition: CONDITION_NORMALIZED_FIELDS,
  Observation: OBSERVATION_NORMALIZED_FIELDS,
  MedicationRequest: MEDICATION_REQUEST_NORMALIZED_FIELDS,
  MedicationDispense: MEDICATION_DISPENSE_NORMALIZED_FIELDS,
  AllergyIntolerance: ALLERGY_NORMALIZED_FIELDS,
  Immunization: IMMUNIZATION_NORMALIZED_FIELDS,
  Procedure: PROCEDURE_NORMALIZED_FIELDS,
  DiagnosticReport: DIAGNOSTIC_REPORT_NORMALIZED_FIELDS,
  DocumentReference: DOCUMENT_REFERENCE_NORMALIZED_FIELDS,
  CarePlan: CARE_PLAN_NORMALIZED_FIELDS,
  CareTeam: CARE_TEAM_NORMALIZED_FIELDS,
  Goal: GOAL_NORMALIZED_FIELDS,
  Device: DEVICE_NORMALIZED_FIELDS,
  Coverage: COVERAGE_NORMALIZED_FIELDS,
  ServiceRequest: SERVICE_REQUEST_NORMALIZED_FIELDS,
  Specimen: SPECIMEN_NORMALIZED_FIELDS,
  Patient: PATIENT_NORMALIZED_FIELDS,
  Practitioner: PRACTITIONER_NORMALIZED_FIELDS,
  Location: LOCATION_NORMALIZED_FIELDS,
  Organization: ORGANIZATION_NORMALIZED_FIELDS,
} satisfies Record<ResourceTypeName, readonly string[]>;

function toFieldMap(
  byType: Record<ResourceTypeName, readonly string[]>,
): Map<ResourceTypeName, ReadonlySet<string>> {
  return new Map(
    Object.entries(byType).map(([type, fields]) => [type as ResourceTypeName, new Set(fields)]),
  );
}

const RAW_FIELDS_MAP = toFieldMap(RAW_FIELDS_BY_TYPE);
const NORMALIZED_FIELDS_MAP = toFieldMap(NORMALIZED_FIELDS_BY_TYPE);

function rawFieldsFor(resourceType: ResourceTypeName): ReadonlySet<string> {
  return RAW_FIELDS_MAP.get(resourceType) ?? EMPTY_FIELD_SET;
}

function normalizedFieldsFor(resourceType: ResourceTypeName): ReadonlySet<string> {
  return NORMALIZED_FIELDS_MAP.get(resourceType) ?? EMPTY_FIELD_SET;
}

const EMPTY_FIELD_SET: ReadonlySet<string> = new Set();

// --- the path-alias engine ---------------------------------------------------

/** `toNormalized` translates a path that may be raw-authored into the
 * normalized shape; `toRaw` translates a path that may be normalized-authored
 * into the raw shape. Either direction leaves an already-correctly-shaped path
 * alone, since no rename ever reuses the same spelling on both sides. */
export type AliasDirection = "toNormalized" | "toRaw";

function startsWithPrefix(path: readonly string[], prefix: readonly string[]): boolean {
  return (
    prefix.length <= path.length && prefix.every((segment, index) => path.at(index) === segment)
  );
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
 * one normalized concept (a `value[x]` choice type), any of which could be
 * the one a rule was actually written against.
 */
function longestMatch(
  path: readonly string[],
  aliases: readonly FieldAlias[],
  direction: AliasDirection,
): { length: number; matches: readonly FieldAlias[] } {
  let length = 0;
  let matches: FieldAlias[] = [];
  for (const alias of aliases) {
    for (const prefix of alternatives(alias, direction).from) {
      if (!startsWithPrefix(path, prefix)) continue;
      if (prefix.length > length) {
        length = prefix.length;
        matches = [];
      }
      if (prefix.length === length) matches.push(alias);
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
    for (const prefix of alternatives(alias, direction).to) {
      const candidate = [...prefix, ...remainder];
      candidates.set(pathKey(candidate), candidate);
    }
  }
  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Iterator#toArray() needs a lib newer than the ES2022 one this Worker compiles against (see the `Array#toSorted` note in `worker/policy/filter.ts`).
  return [...candidates.values()];
}

/** The first segment of every candidate path, skipping the one candidate that
 * cannot have one: an alias-translated empty path never occurs (every alias's
 * `normalized`/`raw` side has at least one segment), but the type of `path[0]`
 * is `string | undefined` regardless. */
function candidateHeads(candidates: readonly (readonly string[])[]): string[] {
  const heads: string[] = [];
  for (const candidate of candidates) {
    const head = candidate.at(0);
    if (head !== undefined) heads.push(head);
  }
  return heads;
}

/**
 * True when `path` (below `resourceType`) names something real in either the
 * normalized shape or the raw FHIR shape, trying both vocabularies via
 * {@link expandPath}. Only the first segment of each candidate is checked --
 * deeper mismatches are the ordinary "matches nothing" case a rule is allowed
 * to hit at apply time, not a reason to refuse the rule outright.
 *
 * An unmodeled resource type (not in `NORMALIZED_TYPES`) has no vocabulary to
 * check against here, so it resolves unconditionally: this module cannot
 * prove such a rule wrong, and the choke point still applies it verbatim.
 */
export function fieldResolves(resourceType: string, path: readonly string[]): boolean {
  if (!isKnownResourceType(resourceType)) return true;

  const normalizedFields = normalizedFieldsFor(resourceType);
  const normalizedHeads = candidateHeads(expandPath(resourceType, path, "toNormalized"));
  if (normalizedHeads.some((head) => normalizedFields.has(head))) return true;

  const rawFields = rawFieldsFor(resourceType);
  return candidateHeads(expandPath(resourceType, path, "toRaw")).some((head) =>
    rawFields.has(head),
  );
}
