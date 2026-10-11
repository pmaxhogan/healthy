/**
 * The field tree: what a `field` rule can name, for every shape a tool answers in.
 *
 * Two jobs, one source:
 *
 *  - The admin UI's rule builder draws it as an expandable tree the owner picks
 *    fields from (served by `GET /api/mcp/policy/schema`).
 *  - `POST /api/mcp/policy` walks it to refuse a path that cannot match anything
 *    for the rule's scope (`resolvePath` below).
 *
 * A "shape" is one kind of object a tool puts in its answer: the normalized item
 * of a resource type (`normalized:Observation`), the raw FHIR resource behind it
 * (`raw:Observation`, returned with `raw: true`), or one of the tool-specific
 * shapes -- the appointment view `get_appointments` and the summary serve, the
 * summary's count rows, a document's decoded text, a health system row. Each
 * tool lists the shapes it can emit (`TOOL_SHAPES`).
 *
 * The normalized shapes are complete: every key a `normalizeX` function can
 * emit, each list compile-checked against the `NormalizedX` interface. The raw
 * FHIR shapes cover every top-level element of each R4 resource (compile-checked
 * against `fhir/r4`), and the datatypes and backbone elements below them that
 * carry anything a person would want to hide; a node marked `open` stops the
 * model there, and any path below it is accepted rather than refused, because
 * this module cannot prove such a path wrong. The UI overlays the owner's real
 * cached key structure on top (`POST /api/mcp/policy/structure`), so a key the
 * model does not know is still pickable.
 */

import { ARRAY_SEGMENT } from "@shared/policy-path.ts";

import { HC_RECORD_TYPES } from "../hc/record-types.ts";
import { TOOL_NAMES } from "../mcp/tool-names.ts";

import { HC_TYPE_PREFIX, hcRuleCanReach, isHcResourceType } from "./hc-aliases.ts";

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
import type {
  PolicyDatatypeDto,
  PolicyFieldNode,
  PolicySchemaDto,
  PolicyShapeDto,
  PolicyToolShapesDto,
} from "@shared/types.ts";
import type * as fhir4 from "fhir/r4";

// --- the spec mini-language --------------------------------------------------
//
// A field is `"Type"` or `"Type[]"` (an array of Type), optionally with a
// description: `["CodeableConcept", "What was measured"]`. A Type that names a
// datatype below gets its children from there, lazily; a primitive is a leaf; a
// Type ending `?` is open (structure not modelled, anything below accepted).

type Spec = string | readonly [type: string, description: string];

type FieldSpecs = Readonly<Record<string, Spec>>;

/** FHIR primitives and the normalized scalars: leaves. */
const PRIMITIVES: ReadonlySet<string> = new Set([
  "string",
  "code",
  "boolean",
  "integer",
  "decimal",
  "number",
  "dateTime",
  "date",
  "instant",
  "time",
  "uri",
  "url",
  "canonical",
  "id",
  "oid",
  "uuid",
  "markdown",
  "positiveInt",
  "unsignedInt",
  "base64Binary",
  "xhtml",
  "string|number",
]);

/** Descriptions by key name, for raw FHIR elements that have none of their own. */
const COMMON_DESCRIPTIONS = new Map<string, string>([
  ["id", "The record's id at the health system"],
  ["meta", "Version, last-updated time, profiles and tags"],
  ["text", "Human-readable narrative (HTML) the health system generated"],
  ["contained", "Resources embedded inline in this one"],
  ["extension", "Health-system-specific additional data"],
  ["modifierExtension", "Extensions that change the meaning of the record"],
  ["implicitRules", "Rules the record was created under"],
  ["language", "Language of the record"],
  ["identifier", "Business identifiers (MRNs, order numbers, CSNs)"],
  ["status", "Status code"],
  ["category", "Classification"],
  ["code", "What this is, as codes and text"],
  ["subject", "Who this is about"],
  ["patient", "The patient it is about"],
  ["encounter", "The visit it happened in"],
  ["performer", "Who did it"],
  ["note", "Free-text comments"],
  ["reasonCode", "Why, as codes"],
  ["reasonReference", "Why, as references to other records"],
  ["basedOn", "The order or plan this fulfils"],
  ["partOf", "The larger event this is part of"],
  ["bodySite", "Where on the body"],
  ["recorder", "Who recorded it"],
  ["asserter", "Who asserted it"],
  ["location", "Where it happened"],
  ["period", "Start and end"],
  ["telecom", "Phone numbers and email addresses"],
  ["address", "Postal address"],
  ["name", "Name"],
  ["type", "Kind"],
  ["reference", "Link to another record"],
  ["display", "Human-readable text for the reference or code"],
  ["coding", "Codes from terminologies (SNOMED, LOINC, ICD-10...)"],
  ["system", "The code system"],
  ["value", "The value"],
  ["unit", "Unit of measure"],
  ["issued", "When it was released"],
  ["interpretation", "High, low, normal, abnormal..."],
  ["referenceRange", "The normal range for the result"],
  ["low", "Lower bound"],
  ["high", "Upper bound"],
  ["start", "Start"],
  ["end", "End"],
]);

// --- datatypes and backbone elements (raw FHIR) ------------------------------

const DATATYPES: Readonly<Record<string, FieldSpecs>> = {
  Coding: {
    system: ["uri", "The code system (SNOMED, LOINC, ICD-10, ...)"],
    version: "string",
    code: ["code", "The code"],
    display: ["string", "The code's human-readable label"],
    userSelected: "boolean",
  },
  CodeableConcept: {
    coding: ["Coding[]", "The same concept in one or more code systems"],
    text: ["string", "Plain-text label"],
  },
  Reference: {
    reference: ["string", "Link to the referenced record"],
    type: "uri",
    identifier: "Identifier",
    display: ["string", "The referenced record's name, as text"],
  },
  Identifier: {
    use: "code",
    type: "CodeableConcept",
    system: ["uri", "Namespace the value belongs to"],
    value: ["string", "The identifier itself"],
    period: "Period",
    assigner: "Reference",
  },
  Period: { start: ["dateTime", "Start"], end: ["dateTime", "End"] },
  Quantity: {
    value: ["decimal", "The number"],
    comparator: "code",
    unit: ["string", "Unit, as text"],
    system: "uri",
    code: "code",
  },
  Range: { low: ["Quantity", "Lower bound"], high: ["Quantity", "Upper bound"] },
  Ratio: { numerator: "Quantity", denominator: "Quantity" },
  HumanName: {
    use: "code",
    text: ["string", "The full name as text"],
    family: ["string", "Family name"],
    given: ["string[]", "Given names"],
    prefix: "string[]",
    suffix: "string[]",
    period: "Period",
  },
  Address: {
    use: "code",
    type: "code",
    text: ["string", "The full address as text"],
    line: ["string[]", "Street lines"],
    city: "string",
    district: "string",
    state: "string",
    postalCode: "string",
    country: "string",
    period: "Period",
  },
  ContactPoint: {
    system: ["code", "phone, email, fax..."],
    value: ["string", "The number or address"],
    use: "code",
    rank: "positiveInt",
    period: "Period",
  },
  Annotation: {
    authorReference: "Reference",
    authorString: "string",
    time: "dateTime",
    text: ["markdown", "The comment"],
  },
  Attachment: {
    contentType: "code",
    language: "code",
    data: ["base64Binary", "The content itself, inline"],
    url: ["url", "Where the content is"],
    size: "unsignedInt",
    hash: "base64Binary",
    title: ["string", "Label"],
    creation: "dateTime",
  },
  Meta: {
    versionId: "id",
    lastUpdated: ["instant", "When the health system last changed it"],
    source: "uri",
    profile: "canonical[]",
    security: "Coding[]",
    tag: "Coding[]",
  },
  Narrative: { status: "code", div: ["xhtml", "The HTML"] },
  Dosage: {
    sequence: "integer",
    text: ["string", "The instructions as text"],
    additionalInstruction: "CodeableConcept[]",
    patientInstruction: "string",
    timing: "Timing?",
    asNeededBoolean: "boolean",
    asNeededCodeableConcept: "CodeableConcept",
    site: "CodeableConcept",
    route: "CodeableConcept",
    method: "CodeableConcept",
    doseAndRate: "DoseAndRate?[]",
    maxDosePerPeriod: "Ratio",
  },

  // Backbone elements, named `Resource.element`.
  "Encounter.participant": {
    type: ["CodeableConcept[]", "Their role in the visit"],
    period: "Period",
    individual: ["Reference", "The clinician"],
  },
  "Encounter.diagnosis": { condition: "Reference", use: "CodeableConcept", rank: "positiveInt" },
  "Encounter.location": {
    location: ["Reference", "The place"],
    status: "code",
    physicalType: "CodeableConcept",
    period: "Period",
  },
  "Encounter.statusHistory": { status: "code", period: "Period" },
  "Encounter.classHistory": { class: "Coding", period: "Period" },
  "Encounter.hospitalization": {
    preAdmissionIdentifier: "Identifier",
    origin: "Reference",
    admitSource: "CodeableConcept",
    reAdmission: "CodeableConcept",
    dietPreference: "CodeableConcept[]",
    specialCourtesy: "CodeableConcept[]",
    specialArrangement: "CodeableConcept[]",
    destination: "Reference",
    dischargeDisposition: "CodeableConcept",
  },
  "Condition.stage": {
    summary: "CodeableConcept",
    assessment: "Reference[]",
    type: "CodeableConcept",
  },
  "Condition.evidence": { code: "CodeableConcept[]", detail: "Reference[]" },
  "Observation.referenceRange": {
    low: ["Quantity", "Lower bound of the normal range"],
    high: ["Quantity", "Upper bound of the normal range"],
    type: "CodeableConcept",
    appliesTo: "CodeableConcept[]",
    age: "Range",
    text: ["string", "The range as text"],
  },
  "Observation.component": {
    code: ["CodeableConcept", "What this part measures"],
    valueQuantity: "Quantity",
    valueCodeableConcept: "CodeableConcept",
    valueString: "string",
    valueBoolean: "boolean",
    valueInteger: "integer",
    valueRange: "Range",
    valueRatio: "Ratio",
    valueSampledData: "SampledData?",
    valueTime: "time",
    valueDateTime: "dateTime",
    valuePeriod: "Period",
    dataAbsentReason: "CodeableConcept",
    interpretation: "CodeableConcept[]",
    referenceRange: ["Observation.referenceRange[]", "The normal range for this part"],
  },
  "AllergyIntolerance.reaction": {
    substance: "CodeableConcept",
    manifestation: ["CodeableConcept[]", "What happened"],
    description: "string",
    onset: "dateTime",
    severity: "code",
    exposureRoute: "CodeableConcept",
    note: "Annotation[]",
  },
  "Immunization.performer": { function: "CodeableConcept", actor: "Reference" },
  "Immunization.protocolApplied": {
    series: "string",
    authority: "Reference",
    targetDisease: "CodeableConcept[]",
    doseNumberPositiveInt: "positiveInt",
    doseNumberString: "string",
    seriesDosesPositiveInt: "positiveInt",
    seriesDosesString: "string",
  },
  "Immunization.reaction": { date: "dateTime", detail: "Reference", reported: "boolean" },
  "Procedure.performer": {
    function: "CodeableConcept",
    actor: ["Reference", "Who performed it"],
    onBehalfOf: "Reference",
  },
  "Procedure.focalDevice": { action: "CodeableConcept", manipulated: "Reference" },
  "DiagnosticReport.media": { comment: "string", link: "Reference" },
  "DocumentReference.relatesTo": { code: "code", target: "Reference" },
  "DocumentReference.content": {
    attachment: ["Attachment", "Where the document is, and its type"],
    format: "Coding",
  },
  "DocumentReference.context": {
    encounter: "Reference[]",
    event: "CodeableConcept[]",
    period: "Period",
    facilityType: "CodeableConcept",
    practiceSetting: "CodeableConcept",
    sourcePatientInfo: "Reference",
    related: "Reference[]",
  },
  "CarePlan.activity": {
    outcomeCodeableConcept: "CodeableConcept[]",
    outcomeReference: "Reference[]",
    progress: "Annotation[]",
    reference: "Reference",
    detail: "CarePlanDetail?",
  },
  "CareTeam.participant": {
    role: ["CodeableConcept[]", "Their role on the team"],
    member: ["Reference", "The team member"],
    onBehalfOf: "Reference",
    period: "Period",
  },
  "Goal.target": {
    measure: "CodeableConcept",
    detailQuantity: "Quantity",
    detailRange: "Range",
    detailCodeableConcept: "CodeableConcept",
    detailString: "string",
    detailBoolean: "boolean",
    detailInteger: "integer",
    detailRatio: "Ratio",
    dueDate: "date",
    dueDuration: "Quantity",
  },
  "Device.udiCarrier": {
    deviceIdentifier: "string",
    issuer: "uri",
    jurisdiction: "uri",
    carrierAIDC: "base64Binary",
    carrierHRF: "string",
    entryType: "code",
  },
  "Device.deviceName": { name: "string", type: "code" },
  "Device.specialization": { systemType: "CodeableConcept", version: "string" },
  "Device.version": { type: "CodeableConcept", component: "Identifier", value: "string" },
  "Device.property": {
    type: "CodeableConcept",
    valueQuantity: "Quantity[]",
    valueCode: "CodeableConcept[]",
  },
  "Coverage.class": { type: "CodeableConcept", value: "string", name: "string" },
  "Coverage.costToBeneficiary": {
    type: "CodeableConcept",
    valueQuantity: "Quantity",
    valueMoney: "Money?",
    exception: "CoverageException?[]",
  },
  "MedicationRequest.dispenseRequest": {
    initialFill: "InitialFill?",
    dispenseInterval: "Quantity",
    validityPeriod: "Period",
    numberOfRepeatsAllowed: "unsignedInt",
    quantity: "Quantity",
    expectedSupplyDuration: "Quantity",
    performer: "Reference",
  },
  "MedicationRequest.substitution": {
    allowedBoolean: "boolean",
    allowedCodeableConcept: "CodeableConcept",
    reason: "CodeableConcept",
  },
  "MedicationDispense.performer": { function: "CodeableConcept", actor: "Reference" },
  "MedicationDispense.substitution": {
    wasSubstituted: "boolean",
    type: "CodeableConcept",
    reason: "CodeableConcept[]",
    responsibleParty: "Reference[]",
  },
  "Patient.contact": {
    relationship: "CodeableConcept[]",
    name: "HumanName",
    telecom: "ContactPoint[]",
    address: "Address",
    gender: "code",
    organization: "Reference",
    period: "Period",
  },
  "Patient.communication": { language: "CodeableConcept", preferred: "boolean" },
  "Patient.link": { other: "Reference", type: "code" },
  "Practitioner.qualification": {
    identifier: "Identifier[]",
    code: "CodeableConcept",
    period: "Period",
    issuer: "Reference",
  },
  "Location.position": { longitude: "decimal", latitude: "decimal", altitude: "decimal" },
  "Location.hoursOfOperation": {
    daysOfWeek: "code[]",
    allDay: "boolean",
    openingTime: "time",
    closingTime: "time",
  },
  "Organization.contact": {
    purpose: "CodeableConcept",
    name: "HumanName",
    telecom: "ContactPoint[]",
    address: "Address",
  },
  "Specimen.collection": {
    collector: "Reference",
    collectedDateTime: "dateTime",
    collectedPeriod: "Period",
    duration: "Quantity",
    quantity: "Quantity",
    method: "CodeableConcept",
    bodySite: "CodeableConcept",
    fastingStatusCodeableConcept: "CodeableConcept",
    fastingStatusDuration: "Quantity",
  },
  "Specimen.processing": {
    description: "string",
    procedure: "CodeableConcept",
    additive: "Reference[]",
    timeDateTime: "dateTime",
    timePeriod: "Period",
  },
  "Specimen.container": {
    identifier: "Identifier[]",
    description: "string",
    type: "CodeableConcept",
    capacity: "Quantity",
    specimenQuantity: "Quantity",
    additiveCodeableConcept: "CodeableConcept",
    additiveReference: "Reference",
  },

  // Normalized sub-shapes, named `N.<shape>`.
  "N.Address": {
    lines: ["string[]", "Street lines"],
    city: "string",
    state: "string",
    postalCode: "string",
  },
  "N.LocationRef": {
    name: ["string", "The place's name"],
    address: ["N.Address", "Its postal address"],
    phone: ["string", "Its phone number"],
  },
  "N.PractitionerRef": {
    name: ["string", "The clinician's name"],
    specialty: "string",
    role: "string",
  },
  "N.CodeableConcept": {
    text: ["string", "Plain-text label"],
    system: ["string", "The code system"],
    code: ["string", "The code"],
  },
  "N.ConditionCode": {
    text: ["string", "Plain-text label"],
    system: ["string", "The first code's system"],
    code: ["string", "The first code"],
    codings: ["N.Coding[]", "Every code it carries"],
  },
  "N.Coding": {
    system: ["string", "The code system"],
    code: ["string", "The code"],
  },
  "N.Value": {
    value: ["string|number", "The number or text"],
    unit: ["string", "Unit of measure"],
  },
  "N.ObservationComponent": {
    code: ["string", "What this part measures"],
    value: ["N.Value", "Its result"],
  },
  "N.AllergyReaction": {
    manifestation: ["string[]", "What happened"],
    severity: "string",
  },
  "N.ProcedurePerformer": { name: ["string", "Who performed it"], function: "string" },
  "N.DocumentAttachment": {
    contentType: "string",
    url: ["string", "Where the document body is"],
    title: "string",
  },
  "N.CareTeamParticipant": {
    name: ["string", "The team member's name"],
    role: ["string", "Their role on the team"],
  },
  "N.Period": { start: "string", end: "string" },
  "N.PatientAddress": { city: "string", state: "string" },
  "N.Identifiers": { csn: ["string", "The visit's contact serial number"] },
  "N.GetReady": {
    complete: ["boolean", "True when no pre-visit task is left"],
    stepsRemaining: ["number", "Tasks still outstanding"],
  },
  "N.Payment": {
    kind: ["string", "copay, prepay or balance"],
    amount: ["number", "Due while unpaid, paid once paid (USD)"],
    amountDue: ["number", "Still due (USD)"],
    amountPaid: ["number", "Already paid (USD)"],
    paid: "boolean",
  },
  "N.Waitlist": { enrolled: ["boolean", "On the list for an earlier slot"] },
  "N.MessageSender": {
    role: ["string", "patient, proxy, practitioner or system"],
    name: ["string", "The sender's name"],
  },
  "N.PractitionerName": { name: ["string", "The clinician's name"] },
  "N.MessageAttachment": {
    name: ["string", "The file's name"],
    extension: ["string", "Its file type"],
    id: ["string", "What get_message_attachment takes"],
    status: ["string", "stored, failed, waiting_until_read or not_fetched"],
    errorCode: ["string", "Why the portal would not serve it"],
    contentType: ["string", "The stored file's content type"],
    size: ["integer", "The stored file's size in bytes"],
  },
  "N.AttachmentImage": {
    contentType: ["string", "The image's type"],
    returnedAs: ["string", "Always image content block"],
  },
  "N.SyncCode": {
    code: "string",
    meaning: ["string", "What the code means"],
    severity: ["string", "info, warning, error or unknown"],
  },
  "N.SyncWarning": {
    code: "string",
    count: "integer",
    meaning: ["string", "What the code means"],
    severity: ["string", "info, warning, error or unknown"],
  },
  "N.LastMessage": {
    id: ["string", "The message's id"],
    sent: ["string", "When it was delivered"],
    direction: ["string", "from_patient or to_patient"],
    from: ["N.MessageSender", "Who wrote it"],
    preview: ["string", "The start of its text, whitespace collapsed"],
    previewTruncated: ["boolean", "True when the text goes on past the preview"],
  },
  "N.ThreadMessage": {
    id: ["string", "The message's id"],
    sent: ["string", "When it was delivered"],
    direction: ["string", "from_patient or to_patient"],
    from: ["N.MessageSender", "Who wrote it"],
    unread: ["boolean", "The portal's own unread flag"],
    body: ["string", "The message's full text"],
    attachments: ["N.MessageAttachment[]", "Attached files"],
    noLongerListed: ["boolean", "True when the portal stopped listing it"],
  },
  "HC.BpReading": {
    id: "string",
    time: "string",
    systolic: "number",
    diastolic: "number",
    bodyPosition: "string",
    measurementLocation: "string",
    pulse: ["number", "The same app's heart rate in the reading's minute"],
    origin: ["string", "The app that wrote it, by package name"],
  },
};

// --- raw FHIR resources, top level -----------------------------------------

/** Every DomainResource's own elements. */
const RAW_BASE = {
  resourceType: ["code", "The FHIR resource type"],
  id: "id",
  meta: "Meta",
  implicitRules: "uri",
  language: "code",
  text: "Narrative",
  contained: "Resource?[]",
  extension: "Extension?[]",
  modifierExtension: "Extension?[]",
} as const satisfies { [K in keyof fhir4.DomainResource]?: Spec };

type RawSpecs<T> = { readonly [K in keyof T]?: Spec };

const RAW_ENCOUNTER = {
  ...RAW_BASE,
  identifier: ["Identifier[]", "Visit identifiers, the CSN among them"],
  status: "code",
  statusHistory: "Encounter.statusHistory[]",
  class: ["Coding", "Inpatient, outpatient, virtual..."],
  classHistory: "Encounter.classHistory[]",
  type: ["CodeableConcept[]", "Kind of visit"],
  serviceType: "CodeableConcept",
  priority: "CodeableConcept",
  subject: "Reference",
  episodeOfCare: "Reference[]",
  basedOn: "Reference[]",
  participant: ["Encounter.participant[]", "The clinicians involved"],
  appointment: "Reference[]",
  period: ["Period", "When the visit started and ended"],
  length: "Quantity",
  reasonCode: "CodeableConcept[]",
  reasonReference: "Reference[]",
  diagnosis: "Encounter.diagnosis[]",
  account: "Reference[]",
  hospitalization: "Encounter.hospitalization",
  location: ["Encounter.location[]", "Where the visit took place"],
  serviceProvider: ["Reference", "The organisation responsible"],
  partOf: "Reference",
} as const satisfies RawSpecs<fhir4.Encounter>;

const RAW_CONDITION = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  clinicalStatus: "CodeableConcept",
  verificationStatus: "CodeableConcept",
  category: "CodeableConcept[]",
  severity: "CodeableConcept",
  code: ["CodeableConcept", "The condition, as codes and text"],
  bodySite: "CodeableConcept[]",
  subject: "Reference",
  encounter: "Reference",
  onsetDateTime: "dateTime",
  onsetAge: "Quantity",
  onsetPeriod: "Period",
  onsetRange: "Range",
  onsetString: "string",
  abatementDateTime: "dateTime",
  abatementAge: "Quantity",
  abatementPeriod: "Period",
  abatementRange: "Range",
  abatementString: "string",
  recordedDate: "dateTime",
  recorder: "Reference",
  asserter: "Reference",
  stage: "Condition.stage[]",
  evidence: "Condition.evidence[]",
  note: "Annotation[]",
} as const satisfies RawSpecs<fhir4.Condition>;

const RAW_OBSERVATION = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  basedOn: "Reference[]",
  partOf: "Reference[]",
  status: "code",
  category: "CodeableConcept[]",
  code: ["CodeableConcept", "What was measured"],
  subject: "Reference",
  focus: "Reference[]",
  encounter: "Reference",
  effectiveDateTime: "dateTime",
  effectivePeriod: "Period",
  effectiveTiming: "Timing?",
  effectiveInstant: "instant",
  issued: "instant",
  performer: "Reference[]",
  valueQuantity: "Quantity",
  valueCodeableConcept: "CodeableConcept",
  valueString: "string",
  valueBoolean: "boolean",
  valueInteger: "integer",
  valueRange: "Range",
  valueRatio: "Ratio",
  valueSampledData: "SampledData?",
  valueTime: "time",
  valueDateTime: "dateTime",
  valuePeriod: "Period",
  dataAbsentReason: "CodeableConcept",
  interpretation: "CodeableConcept[]",
  note: "Annotation[]",
  bodySite: "CodeableConcept",
  method: "CodeableConcept",
  specimen: "Reference",
  device: "Reference",
  referenceRange: "Observation.referenceRange[]",
  hasMember: "Reference[]",
  derivedFrom: "Reference[]",
  component: ["Observation.component[]", "The parts of a multi-part result"],
} as const satisfies RawSpecs<fhir4.Observation>;

const RAW_MEDICATION_REQUEST = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  status: "code",
  statusReason: "CodeableConcept",
  intent: "code",
  category: "CodeableConcept[]",
  priority: "code",
  doNotPerform: "boolean",
  reportedBoolean: "boolean",
  reportedReference: "Reference",
  medicationCodeableConcept: ["CodeableConcept", "The medication"],
  medicationReference: ["Reference", "The medication"],
  subject: "Reference",
  encounter: "Reference",
  supportingInformation: "Reference[]",
  authoredOn: "dateTime",
  requester: ["Reference", "Who prescribed it"],
  performer: "Reference",
  performerType: "CodeableConcept",
  recorder: "Reference",
  reasonCode: "CodeableConcept[]",
  reasonReference: "Reference[]",
  instantiatesCanonical: "canonical[]",
  instantiatesUri: "uri[]",
  basedOn: "Reference[]",
  groupIdentifier: "Identifier",
  courseOfTherapyType: "CodeableConcept",
  insurance: "Reference[]",
  note: "Annotation[]",
  dosageInstruction: ["Dosage[]", "How to take it"],
  dispenseRequest: "MedicationRequest.dispenseRequest",
  substitution: "MedicationRequest.substitution",
  priorPrescription: "Reference",
  detectedIssue: "Reference[]",
  eventHistory: "Reference[]",
} as const satisfies RawSpecs<fhir4.MedicationRequest>;

const RAW_MEDICATION_DISPENSE = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  partOf: "Reference[]",
  status: "code",
  statusReasonCodeableConcept: "CodeableConcept",
  statusReasonReference: "Reference",
  category: "CodeableConcept",
  medicationCodeableConcept: ["CodeableConcept", "The medication"],
  medicationReference: ["Reference", "The medication"],
  subject: "Reference",
  context: "Reference",
  supportingInformation: "Reference[]",
  performer: "MedicationDispense.performer[]",
  location: ["Reference", "The pharmacy"],
  authorizingPrescription: "Reference[]",
  type: "CodeableConcept",
  quantity: "Quantity",
  daysSupply: "Quantity",
  whenPrepared: "dateTime",
  whenHandedOver: "dateTime",
  destination: "Reference",
  receiver: "Reference[]",
  note: "Annotation[]",
  dosageInstruction: "Dosage[]",
  substitution: "MedicationDispense.substitution",
  detectedIssue: "Reference[]",
  eventHistory: "Reference[]",
} as const satisfies RawSpecs<fhir4.MedicationDispense>;

const RAW_ALLERGY = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  clinicalStatus: "CodeableConcept",
  verificationStatus: "CodeableConcept",
  type: "code",
  category: "code[]",
  criticality: "code",
  code: ["CodeableConcept", "The substance"],
  patient: "Reference",
  encounter: "Reference",
  onsetDateTime: "dateTime",
  onsetAge: "Quantity",
  onsetPeriod: "Period",
  onsetRange: "Range",
  onsetString: "string",
  recordedDate: "dateTime",
  recorder: "Reference",
  asserter: "Reference",
  lastOccurrence: "dateTime",
  note: "Annotation[]",
  reaction: ["AllergyIntolerance.reaction[]", "Reactions that occurred"],
} as const satisfies RawSpecs<fhir4.AllergyIntolerance>;

const RAW_IMMUNIZATION = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  status: "code",
  statusReason: "CodeableConcept",
  vaccineCode: ["CodeableConcept", "The vaccine"],
  patient: "Reference",
  encounter: "Reference",
  occurrenceDateTime: "dateTime",
  occurrenceString: "string",
  recorded: "dateTime",
  primarySource: "boolean",
  reportOrigin: "CodeableConcept",
  location: "Reference",
  manufacturer: "Reference",
  lotNumber: "string",
  expirationDate: "date",
  site: "CodeableConcept",
  route: "CodeableConcept",
  doseQuantity: "Quantity",
  performer: "Immunization.performer[]",
  note: "Annotation[]",
  reasonCode: "CodeableConcept[]",
  reasonReference: "Reference[]",
  isSubpotent: "boolean",
  subpotentReason: "CodeableConcept[]",
  education: "ImmunizationEducation?[]",
  programEligibility: "CodeableConcept[]",
  fundingSource: "CodeableConcept",
  reaction: "Immunization.reaction[]",
  protocolApplied: "Immunization.protocolApplied[]",
} as const satisfies RawSpecs<fhir4.Immunization>;

const RAW_PROCEDURE = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  instantiatesCanonical: "canonical[]",
  instantiatesUri: "uri[]",
  basedOn: "Reference[]",
  partOf: "Reference[]",
  status: "code",
  statusReason: "CodeableConcept",
  category: "CodeableConcept",
  code: ["CodeableConcept", "The procedure"],
  subject: "Reference",
  encounter: "Reference",
  performedDateTime: "dateTime",
  performedPeriod: "Period",
  performedString: "string",
  performedAge: "Quantity",
  performedRange: "Range",
  recorder: "Reference",
  asserter: "Reference",
  performer: ["Procedure.performer[]", "Who performed it"],
  location: "Reference",
  reasonCode: "CodeableConcept[]",
  reasonReference: "Reference[]",
  bodySite: "CodeableConcept[]",
  outcome: "CodeableConcept",
  report: "Reference[]",
  complication: "CodeableConcept[]",
  complicationDetail: "Reference[]",
  followUp: "CodeableConcept[]",
  note: "Annotation[]",
  focalDevice: "Procedure.focalDevice[]",
  usedReference: "Reference[]",
  usedCode: "CodeableConcept[]",
} as const satisfies RawSpecs<fhir4.Procedure>;

const RAW_DIAGNOSTIC_REPORT = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  basedOn: "Reference[]",
  status: "code",
  category: "CodeableConcept[]",
  code: ["CodeableConcept", "The report's kind"],
  subject: "Reference",
  encounter: "Reference",
  effectiveDateTime: "dateTime",
  effectivePeriod: "Period",
  issued: "instant",
  performer: "Reference[]",
  resultsInterpreter: "Reference[]",
  specimen: "Reference[]",
  result: ["Reference[]", "The individual results"],
  imagingStudy: "Reference[]",
  media: "DiagnosticReport.media[]",
  conclusion: ["string", "The clinical conclusion, as text"],
  conclusionCode: "CodeableConcept[]",
  presentedForm: ["Attachment[]", "The full report as a document"],
} as const satisfies RawSpecs<fhir4.DiagnosticReport>;

const RAW_DOCUMENT_REFERENCE = {
  ...RAW_BASE,
  masterIdentifier: "Identifier",
  identifier: "Identifier[]",
  status: "code",
  docStatus: "code",
  type: ["CodeableConcept", "Kind of document"],
  category: "CodeableConcept[]",
  subject: "Reference",
  date: "instant",
  author: ["Reference[]", "Who wrote it"],
  authenticator: "Reference",
  custodian: "Reference",
  relatesTo: "DocumentReference.relatesTo[]",
  description: "string",
  securityLabel: "CodeableConcept[]",
  content: ["DocumentReference.content[]", "The document's attachments"],
  context: "DocumentReference.context",
} as const satisfies RawSpecs<fhir4.DocumentReference>;

const RAW_CARE_PLAN = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  instantiatesCanonical: "canonical[]",
  instantiatesUri: "uri[]",
  basedOn: "Reference[]",
  replaces: "Reference[]",
  partOf: "Reference[]",
  status: "code",
  intent: "code",
  category: "CodeableConcept[]",
  title: "string",
  description: "string",
  subject: "Reference",
  encounter: "Reference",
  period: "Period",
  created: "dateTime",
  author: "Reference",
  contributor: "Reference[]",
  careTeam: "Reference[]",
  addresses: "Reference[]",
  supportingInfo: "Reference[]",
  goal: "Reference[]",
  activity: "CarePlan.activity[]",
  note: "Annotation[]",
} as const satisfies RawSpecs<fhir4.CarePlan>;

const RAW_CARE_TEAM = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  status: "code",
  category: "CodeableConcept[]",
  name: "string",
  subject: "Reference",
  encounter: "Reference",
  period: "Period",
  participant: ["CareTeam.participant[]", "The team members"],
  reasonCode: "CodeableConcept[]",
  reasonReference: "Reference[]",
  managingOrganization: "Reference[]",
  telecom: "ContactPoint[]",
  note: "Annotation[]",
} as const satisfies RawSpecs<fhir4.CareTeam>;

const RAW_GOAL = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  lifecycleStatus: "code",
  achievementStatus: "CodeableConcept",
  category: "CodeableConcept[]",
  priority: "CodeableConcept",
  description: ["CodeableConcept", "The goal"],
  subject: "Reference",
  startDate: "date",
  startCodeableConcept: "CodeableConcept",
  target: "Goal.target[]",
  statusDate: "date",
  statusReason: "string",
  expressedBy: "Reference",
  addresses: "Reference[]",
  note: "Annotation[]",
  outcomeCode: "CodeableConcept[]",
  outcomeReference: "Reference[]",
} as const satisfies RawSpecs<fhir4.Goal>;

const RAW_DEVICE = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  definition: "Reference",
  udiCarrier: "Device.udiCarrier[]",
  status: "code",
  statusReason: "CodeableConcept[]",
  distinctIdentifier: "string",
  manufacturer: "string",
  manufactureDate: "dateTime",
  expirationDate: "dateTime",
  lotNumber: "string",
  serialNumber: "string",
  deviceName: "Device.deviceName[]",
  modelNumber: "string",
  partNumber: "string",
  type: "CodeableConcept",
  specialization: "Device.specialization[]",
  version: "Device.version[]",
  property: "Device.property[]",
  patient: "Reference",
  owner: "Reference",
  contact: "ContactPoint[]",
  location: "Reference",
  url: "uri",
  note: "Annotation[]",
  safety: "CodeableConcept[]",
  parent: "Reference",
} as const satisfies RawSpecs<fhir4.Device>;

const RAW_COVERAGE = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  status: "code",
  type: "CodeableConcept",
  policyHolder: "Reference",
  subscriber: "Reference",
  subscriberId: ["string", "The member id on the insurance card"],
  beneficiary: "Reference",
  dependent: "string",
  relationship: "CodeableConcept",
  period: "Period",
  payor: ["Reference[]", "The insurer"],
  class: "Coverage.class[]",
  order: "positiveInt",
  network: "string",
  costToBeneficiary: "Coverage.costToBeneficiary[]",
  subrogation: "boolean",
  contract: "Reference[]",
} as const satisfies RawSpecs<fhir4.Coverage>;

const RAW_SERVICE_REQUEST = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  instantiatesCanonical: "canonical[]",
  instantiatesUri: "uri[]",
  basedOn: "Reference[]",
  replaces: "Reference[]",
  requisition: "Identifier",
  status: "code",
  intent: "code",
  category: "CodeableConcept[]",
  priority: "code",
  doNotPerform: "boolean",
  code: ["CodeableConcept", "What was ordered"],
  orderDetail: "CodeableConcept[]",
  quantityQuantity: "Quantity",
  quantityRatio: "Ratio",
  quantityRange: "Range",
  subject: "Reference",
  encounter: "Reference",
  occurrenceDateTime: "dateTime",
  occurrencePeriod: "Period",
  occurrenceTiming: "Timing?",
  asNeededBoolean: "boolean",
  asNeededCodeableConcept: "CodeableConcept",
  authoredOn: "dateTime",
  requester: ["Reference", "Who ordered it"],
  performerType: "CodeableConcept",
  performer: "Reference[]",
  locationCode: "CodeableConcept[]",
  locationReference: "Reference[]",
  reasonCode: "CodeableConcept[]",
  reasonReference: "Reference[]",
  insurance: "Reference[]",
  supportingInfo: "Reference[]",
  specimen: "Reference[]",
  bodySite: "CodeableConcept[]",
  note: "Annotation[]",
  patientInstruction: "string",
  relevantHistory: "Reference[]",
} as const satisfies RawSpecs<fhir4.ServiceRequest>;

const RAW_SPECIMEN = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  accessionIdentifier: "Identifier",
  status: "code",
  type: "CodeableConcept",
  subject: "Reference",
  receivedTime: "dateTime",
  parent: "Reference[]",
  request: "Reference[]",
  collection: "Specimen.collection",
  processing: "Specimen.processing[]",
  container: "Specimen.container[]",
  condition: "CodeableConcept[]",
  note: "Annotation[]",
} as const satisfies RawSpecs<fhir4.Specimen>;

const RAW_PATIENT = {
  ...RAW_BASE,
  identifier: ["Identifier[]", "MRNs and other patient identifiers"],
  active: "boolean",
  name: ["HumanName[]", "The patient's names"],
  telecom: ["ContactPoint[]", "Phone numbers and email addresses"],
  gender: "code",
  birthDate: ["date", "Date of birth"],
  deceasedBoolean: "boolean",
  deceasedDateTime: "dateTime",
  address: ["Address[]", "Home and mailing addresses"],
  maritalStatus: "CodeableConcept",
  multipleBirthBoolean: "boolean",
  multipleBirthInteger: "integer",
  photo: "Attachment[]",
  contact: ["Patient.contact[]", "Emergency contacts and guardians"],
  communication: "Patient.communication[]",
  generalPractitioner: "Reference[]",
  managingOrganization: "Reference",
  link: "Patient.link[]",
} as const satisfies RawSpecs<fhir4.Patient>;

const RAW_PRACTITIONER = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  active: "boolean",
  name: "HumanName[]",
  telecom: "ContactPoint[]",
  address: "Address[]",
  gender: "code",
  birthDate: "date",
  photo: "Attachment[]",
  qualification: "Practitioner.qualification[]",
  communication: "CodeableConcept[]",
} as const satisfies RawSpecs<fhir4.Practitioner>;

const RAW_LOCATION = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  status: "code",
  operationalStatus: "Coding",
  name: "string",
  alias: "string[]",
  description: "string",
  mode: "code",
  type: "CodeableConcept[]",
  telecom: "ContactPoint[]",
  address: "Address",
  physicalType: "CodeableConcept",
  position: "Location.position",
  managingOrganization: "Reference",
  partOf: "Reference",
  hoursOfOperation: "Location.hoursOfOperation[]",
  availabilityExceptions: "string",
  endpoint: "Reference[]",
} as const satisfies RawSpecs<fhir4.Location>;

const RAW_ORGANIZATION = {
  ...RAW_BASE,
  identifier: "Identifier[]",
  active: "boolean",
  type: "CodeableConcept[]",
  name: "string",
  alias: "string[]",
  telecom: "ContactPoint[]",
  address: "Address[]",
  partOf: "Reference",
  contact: "Organization.contact[]",
  endpoint: "Reference[]",
} as const satisfies RawSpecs<fhir4.Organization>;

// --- normalized shapes -------------------------------------------------------

type NormalizedSpecs<T> = { readonly [K in keyof T]-?: Spec };

/**
 * Keys `collect` adds to every normalized item: the health system tags. Not part
 * of any `NormalizedX` interface (the normalizer does not know the id), but on
 * every item a tool answers with.
 */
const TAGS = {
  healthSystem: ["string", "The health system's display name"],
  healthSystemId: ["string", "The health system's id"],
} as const;

const N_BASE = {
  resourceType: ["string", "The FHIR resource type"],
  id: ["string", "The record's id at the health system"],
  ...TAGS,
  lastUpdated: ["string", "When the health system last changed it"],
} as const;

const N_ENCOUNTER = {
  ...N_BASE,
  status: "string",
  class: ["string", "Inpatient, outpatient, virtual..."],
  visitType: ["string", "Kind of visit"],
  start: "string",
  end: "string",
  practitioners: ["N.PractitionerRef[]", "The clinicians involved"],
  location: ["N.LocationRef", "Where the visit took place"],
  organization: ["string", "The organisation responsible"],
  department: "string",
  reasons: ["string[]", "Why the visit happened"],
  telehealth: ["boolean", "True for a video visit"],
  identifiers: ["N.Identifiers", "Visit identifiers"],
} as const satisfies NormalizedSpecs<NormalizedEncounter>;

/** Keys `appointment-items.ts` adds to an appointment view item. */
const APPOINTMENT_EXTRAS = {
  resourceType: ["string", "Always Encounter"],
  healthSystemId: ["string", "The health system's id"],
  source: ["string", "fhir or portal: where this visit was read from"],
  firstParty: ["boolean", "False when another organisation's portal listed it"],
  via: ["string", "The health system whose portal listed it second-hand"],
} as const;

const N_APPOINTMENT = {
  healthSystem: ["string", "The health system's display name"],
  encounterId: ["string", "The visit's id"],
  status: "string",
  start: "string",
  end: "string",
  visitType: ["string", "Kind of visit"],
  practitioner: ["string", "The clinician's name"],
  specialty: "string",
  location: ["N.LocationRef", "Where the visit takes place"],
  org: ["string", "The organisation"],
  department: "string",
  telehealth: ["boolean", "True for a video visit"],
  csn: ["string", "The visit's contact serial number"],
  detailCsn: ["string", "The portal's token for the visit's details page"],
  directions: ["string", "How to find the room, from the portal"],
  visitInstructions: ["string", "The visit's own instructions, from the portal"],
  confirmed: ["boolean", "Whether the appointment is confirmed; null: nothing to confirm"],
  getReady: ["N.GetReady", "The pre-visit tasks; null: not offered"],
  payment: ["N.Payment", "The copay or prepayment; null: none"],
  waitlist: ["N.Waitlist", "The earlier-appointment wait list; null: not offered"],
  ...APPOINTMENT_EXTRAS,
} as const satisfies NormalizedSpecs<NormalizedAppointmentView>;

const N_CONDITION = {
  ...N_BASE,
  code: ["N.ConditionCode", "The condition"],
  category: "string[]",
  encounterId: ["string", "The visit it was recorded at"],
  clinicalStatus: "string",
  verificationStatus: "string",
  onset: "string",
  recorded: "string",
  abatement: "string",
} as const satisfies NormalizedSpecs<NormalizedCondition>;

const N_OBSERVATION = {
  ...N_BASE,
  code: ["string", "What was measured"],
  category: "string[]",
  value: ["N.Value", "The result"],
  interpretation: "string",
  referenceRange: ["string", "The normal range, as text"],
  effective: "string",
  issued: "string",
  status: "string",
  components: ["N.ObservationComponent[]", "The parts of a multi-part result"],
} as const satisfies NormalizedSpecs<NormalizedObservation>;

const N_MEDICATION_REQUEST = {
  ...N_BASE,
  medication: ["string", "The medication"],
  status: "string",
  intent: "string",
  authoredOn: "string",
  dosageText: ["string[]", "How to take it"],
  requester: ["string", "Who prescribed it"],
  reasons: "string[]",
} as const satisfies NormalizedSpecs<NormalizedMedicationRequest>;

const N_MEDICATION_DISPENSE = {
  ...N_BASE,
  medication: ["string", "The medication"],
  status: "string",
  quantity: "N.Value",
  daysSupply: "N.Value",
  whenHandedOver: "string",
  dosageText: "string[]",
} as const satisfies NormalizedSpecs<NormalizedMedicationDispense>;

const N_ALLERGY = {
  ...N_BASE,
  substance: ["string", "What the patient is allergic to"],
  reactions: "N.AllergyReaction[]",
  criticality: "string",
  clinicalStatus: "string",
  onset: "string",
} as const satisfies NormalizedSpecs<NormalizedAllergy>;

const N_IMMUNIZATION = {
  ...N_BASE,
  vaccine: "string",
  occurrence: "string",
  status: "string",
  lot: "string",
  site: "string",
  route: "string",
  doseNumber: "string",
} as const satisfies NormalizedSpecs<NormalizedImmunization>;

const N_PROCEDURE = {
  ...N_BASE,
  code: ["string", "The procedure"],
  performed: "string",
  status: "string",
  performers: ["N.ProcedurePerformer[]", "Who performed it"],
  reasons: "string[]",
} as const satisfies NormalizedSpecs<NormalizedProcedure>;

const N_DIAGNOSTIC_REPORT = {
  ...N_BASE,
  code: "string",
  category: "string[]",
  effective: "string",
  issued: "string",
  status: "string",
  conclusion: ["string", "The clinical conclusion"],
  resultRefs: "string[]",
  presentedFormRefs: "string[]",
} as const satisfies NormalizedSpecs<NormalizedDiagnosticReport>;

const N_DOCUMENT_REFERENCE = {
  ...N_BASE,
  type: ["string", "Kind of document"],
  category: "string[]",
  date: "string",
  status: "string",
  description: "string",
  author: ["string[]", "Who wrote it"],
  attachments: "N.DocumentAttachment[]",
} as const satisfies NormalizedSpecs<NormalizedDocumentReference>;

const N_CARE_PLAN = {
  ...N_BASE,
  title: "string",
  status: "string",
  intent: "string",
  category: "string[]",
  period: "N.Period",
  activities: "string[]",
} as const satisfies NormalizedSpecs<NormalizedCarePlan>;

const N_CARE_TEAM = {
  ...N_BASE,
  name: "string",
  status: "string",
  participants: ["N.CareTeamParticipant[]", "The team members"],
} as const satisfies NormalizedSpecs<NormalizedCareTeam>;

const N_GOAL = {
  ...N_BASE,
  description: ["string", "The goal"],
  lifecycleStatus: "string",
  achievementStatus: "string",
  startDate: "string",
  targets: "string[]",
} as const satisfies NormalizedSpecs<NormalizedGoal>;

const N_DEVICE = {
  ...N_BASE,
  type: "string",
  manufacturer: "string",
  model: "string",
  status: "string",
  udi: ["string", "The device's unique identifier"],
} as const satisfies NormalizedSpecs<NormalizedDevice>;

const N_COVERAGE = {
  ...N_BASE,
  payor: ["string[]", "The insurer"],
  type: "string",
  subscriberId: ["string", "The member id on the insurance card"],
  status: "string",
  sensitive: "string[]",
} as const satisfies NormalizedSpecs<NormalizedCoverage>;

const N_SERVICE_REQUEST = {
  ...N_BASE,
  code: ["string", "What was ordered"],
  status: "string",
  intent: "string",
  occurrence: "string",
  requester: ["string", "Who ordered it"],
  reasons: "string[]",
} as const satisfies NormalizedSpecs<NormalizedServiceRequest>;

const N_SPECIMEN = {
  ...N_BASE,
  type: "string",
  status: "string",
  collected: "string",
} as const satisfies NormalizedSpecs<NormalizedSpecimen>;

const N_PATIENT = {
  ...N_BASE,
  name: ["string", "The patient's name"],
  birthDate: ["string", "Date of birth"],
  gender: "string",
  address: ["N.PatientAddress", "City and state"],
  sensitive: "string[]",
} as const satisfies NormalizedSpecs<NormalizedPatient>;

const N_PRACTITIONER = {
  ...N_BASE,
  name: "string",
  gender: "string",
  qualifications: "string[]",
} as const satisfies NormalizedSpecs<NormalizedPractitioner>;

const N_LOCATION = {
  ...N_BASE,
  name: "string",
  address: "N.Address",
  phone: "string",
  status: "string",
} as const satisfies NormalizedSpecs<NormalizedLocation>;

const N_ORGANIZATION = {
  ...N_BASE,
  name: "string",
  type: "string",
  address: "N.Address",
  phone: "string",
} as const satisfies NormalizedSpecs<NormalizedOrganization>;

/**
 * Fields a normalized shape names in its own `sensitive` array: withheld unless
 * an `allow` rule puts them back. Mirrors the normalizers; a test pins the two.
 */
export const SENSITIVE_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["Patient", ["birthDate"]],
  ["Coverage", ["subscriberId"]],
]);

// --- tool-specific shapes --------------------------------------------------

const SUMMARY_COUNT = {
  kind: ["string", "Always count"],
  ...TAGS,
  resourceType: ["string", "The resource type counted"],
  count: ["integer", "How many are cached"],
} as const;

const SUMMARY_RECENT = {
  kind: ["string", "Always recent"],
  section: ["string", "appointments, conditions, medications or labs"],
  source: ["string", "For a condition: problem_list, encounter_diagnosis or other"],
} as const;

/**
 * One condition, collapsed from every row that names it (`get_conditions` with
 * `collapse: true`, the summary's conditions). Built from rows the policy has
 * already filtered, so a rule on a Condition field reaches it through those.
 */
const CONDITION_GROUP = {
  resourceType: ["string", "Always Condition"],
  kind: ["string", "condition_group (recent, in the summary)"],
  ...TAGS,
  code: ["N.ConditionCode", "The condition"],
  categories: ["string[]", "Every category its rows carry"],
  onProblemList: ["boolean", "True when one of its rows is a problem-list entry"],
  clinicalStatus: "string",
  verificationStatus: "string",
  abatement: "string",
  firstSeen: ["string", "The earliest onset or recorded date"],
  lastSeen: ["string", "The latest onset or recorded date"],
  occurrences: ["integer", "How many rows it was collapsed from"],
  ids: ["string[]", "The rows' Condition ids"],
  encounterIds: ["string[]", "The visits it was recorded at"],
} as const;

const CONDITION_GROUP_SHAPE = "view:ConditionGroup";

const DOCUMENT_TEXT = {
  resourceType: ["string", "Always DocumentReference"],
  kind: ["string", "Always document_text"],
  ...TAGS,
  id: ["string", "The DocumentReference id"],
  contentType: "string",
  cached: ["boolean", "True when read from the thirty-day cache"],
  chars: ["integer", "Length of the text"],
  text: ["string", "The document's full text"],
} as const;

/**
 * One secure message, as both message tools hand it to the policy before
 * grouping messages into conversations. There is no FHIR resource behind it --
 * it is read from the patient portal -- so this view is the whole of its shape,
 * under FHIR's own name for a message.
 */
const MESSAGE = {
  resourceType: ["string", "Always Communication"],
  id: ["string", "The message's id"],
  threadId: ["string", "The conversation's id"],
  subject: ["string", "The conversation's subject line"],
  folder: ["string", "conversations, appointments, automated, archive or bookmarked"],
  sent: ["string", "When the message was delivered"],
  direction: ["string", "from_patient or to_patient"],
  from: ["N.MessageSender", "Who wrote it"],
  practitioners: ["N.PractitionerName[]", "The care team the conversation is with"],
  body: ["string", "The message's full text"],
  attachments: ["N.MessageAttachment[]", "Attached files"],
  unread: ["boolean", "The portal's own unread flag"],
  organization: ["string", "The organisation a second-hand copy belongs to"],
  source: ["string", "Always portal"],
  firstParty: ["boolean", "False when another organisation's portal showed it"],
  via: ["string", "The health system whose portal showed it second-hand"],
  noLongerListed: ["boolean", "True when the portal stopped listing it"],
  ...TAGS,
} as const;

const MESSAGE_SHAPE = "view:Message";

/**
 * What both message tools' conversation items share. Built by grouping message
 * items the policy has already filtered (`worker/src/mcp/message-threads.ts`), so a
 * rule on a message field reaches them through those; the policy also runs over
 * the conversation items themselves, so a rule on one of these fields reaches
 * them directly.
 */
const THREAD_BASE = {
  resourceType: ["string", "Always Communication"],
  kind: ["string", "message_thread, or message_thread_detail from get_message_thread"],
  threadId: ["string", "The conversation's id"],
  subject: ["string", "The conversation's subject line"],
  folder: ["string", "conversations, appointments, automated, archive or bookmarked"],
  firstMessageAt: ["string", "When its first message was delivered"],
  lastMessageAt: ["string", "When its newest message was delivered"],
  messageCount: ["integer", "How many messages it holds"],
  unreadCount: ["integer", "How many of them the portal marks unread"],
  attachmentCount: ["integer", "How many files are attached across its messages"],
  hasAttachments: ["boolean", "True when any message has an attachment"],
  practitioners: ["N.PractitionerName[]", "The care team the conversation is with"],
  participants: ["N.MessageSender[]", "Everyone who wrote in it"],
  organization: ["string", "The organisation a second-hand copy belongs to"],
  source: ["string", "Always portal"],
  firstParty: ["boolean", "False when another organisation's portal showed it"],
  via: ["string", "The health system whose portal showed it second-hand"],
  noLongerListed: ["boolean", "True when the portal stopped listing every message in it"],
  ...TAGS,
} as const;

/** One conversation in `get_messages`' list. */
const THREAD_SUMMARY = {
  ...THREAD_BASE,
  lastMessage: ["N.LastMessage", "The newest message, previewed"],
} as const;

/** One conversation from `get_message_thread`, every message in full. */
const THREAD_DETAIL = {
  ...THREAD_BASE,
  messages: ["N.ThreadMessage[]", "Every message, oldest first"],
} as const;

/** One attached file (`get_message_attachment`). */
const MESSAGE_ATTACHMENT = {
  resourceType: ["string", "Always Communication"],
  kind: ["string", "Always message_attachment"],
  id: ["string", "The attachment's id"],
  messageId: ["string", "The message it is attached to"],
  threadId: ["string", "The conversation's id"],
  subject: ["string", "The conversation's subject line"],
  sent: ["string", "When its message was delivered"],
  name: ["string", "The file's name"],
  extension: ["string", "Its file type"],
  status: ["string", "stored, failed, waiting_until_read or not_fetched"],
  errorCode: ["string", "Why the portal would not serve it"],
  contentType: ["string", "The stored file's content type"],
  size: ["integer", "The stored file's size in bytes"],
  chars: ["integer", "Length of the text"],
  text: ["string", "A text file's full text"],
  image: [
    "N.AttachmentImage",
    "An image, returned beside the item as an image content block; hiding this withholds it",
  ],
  note: ["string", "Why no content came back"],
  source: ["string", "Always portal"],
  firstParty: ["boolean", "False when another organisation's portal showed it"],
  via: ["string", "The health system whose portal showed it second-hand"],
  ...TAGS,
} as const;

const MESSAGE_ATTACHMENT_SHAPE = "view:MessageAttachment";

const THREAD_SUMMARY_SHAPE = "view:MessageThread";
const THREAD_DETAIL_SHAPE = "view:MessageThreadDetail";

const HEALTH_SYSTEM_ROW = {
  kind: ["string", "health_system"],
  ...TAGS,
  environment: "string",
  enabled: "boolean",
  status: ["string", "Connection status"],
  portalUrl: ["string", "The patient portal's address"],
  lastSyncAt: "string",
  lastFullRefreshAt: "string",
  lastErrorCode: "string",
  needsReauthSince: "string",
  portalState: ["string", "Patient-portal session: active, needs_reauth, none or no_portal"],
  portalLastOkAt: ["string", "When the patient portal last answered"],
  portalLastErrorCode: "string",
} as const;

const RESOURCE_SYNC_ROW = {
  kind: ["string", "resource_sync"],
  ...TAGS,
  resourceType: "string",
  status: ["string", "ok, partial, stale, failed, unsupported or never"],
  lastFullAt: "string",
  lastOk: "boolean",
  lastErrorCode: "string",
  lastError: ["N.SyncCode", "The last error, explained"],
  warnings: ["N.SyncWarning[]", "What the health system reported on the last refresh"],
} as const;

// --- Health Connect (a paired phone) -----------------------------------------
//
// A phone's rows are tagged `healthSystemId: "device:<id>"` and
// `resourceType: "hc:<Type>"`, the type being whichever record type the row
// is about -- so these shapes belong to no one resource type (`resourceType:
// null`) and are listed in `TYPED_ROWS`, which is what lets a rule scoped to
// `hc:HeartRate` reach them. A record's `data` is whatever the phone sent for
// its type, so it is an open node: any path below it is accepted.

const HC_TAGS = {
  resourceType: ["string", "hc:<Type>, the Health Connect record type the row is about"],
  healthSystemId: ["string", "device:<id> of the phone it came from"],
} as const;

const HC_NAMED = {
  healthSystem: ["string", "The phone's name"],
  ...HC_TAGS,
} as const;

const HC_COVERAGE_ROW = {
  kind: ["string", "Always type_coverage"],
  ...HC_NAMED,
  type: ["string", "The record type"],
  availability: ["string", "ok, stale, or no_data for a named type with no records"],
  status: "string",
  recordCount: "integer",
  firstAt: ["string", "The oldest record"],
  lastAt: ["string", "The newest record"],
  meanIntervalS: ["number", "Typical time between records"],
  lastSyncAt: "string",
  staleHours: "number",
  origins: ["string[]", "The apps that wrote the type, by package name"],
  lastRecordFrom: ["object?", "The app and hardware behind the newest record"],
} as const;

const HC_DEVICE_ROW = {
  kind: ["string", "Always device"],
  healthSystem: ["string", "The phone's name"],
  healthSystemId: ["string", "device:<id>"],
  status: ["string", "active, stale, revoked or never"],
  pairedAt: "string",
  revokedAt: "string",
  lastSeenAt: "string",
  lastUploadAt: "string",
  hoursSinceUpload: "number",
  appVersion: "string",
  backgroundRead: "boolean",
  historyRead: "boolean",
  batteryOptimisationExempt: "boolean",
  backfillComplete: "boolean",
  androidSdk: "integer",
  healthConnectVersion: "string",
  lastPhoneError: ["object?", "The phone's own last error: a stable code and when"],
  typesWithData: ["integer", "Record types with at least one stored record"],
  records: "integer",
  phoneBacklog: "integer",
  queuedBatches: "integer",
  rollupsPending: "integer",
  parkedBatches: "integer",
  recentBatches: "integer",
  recentFailures: ["object?[]", "Failed uploads among the recent ones"],
} as const;

const HC_TYPE_SYNC_ROW = {
  kind: ["string", "Always type_sync"],
  ...HC_NAMED,
  type: "string",
  availability: "string",
  recordCount: "integer",
  tokenAgeS: "number",
  backlog: "integer",
  backfillComplete: "boolean",
  backfillOldestAt: "string",
  lastUploadAt: "string",
} as const;

const HC_RECORD = {
  ...HC_TAGS,
  id: ["string", "Health Connect's id for the record"],
  origin: ["string", "The app that wrote it, by package name"],
  time: ["string", "When, for an instantaneous record"],
  start: "string",
  end: "string",
  data: ["object?", "The record type's own fields, as the phone sent them"],
  device: ["object?", "The hardware: type, manufacturer, model"],
  recordingMethod: "string",
  lastModified: "string",
  offsetMin: "integer",
  startOffsetMin: "integer",
  endOffsetMin: "integer",
  clientRecordId: "string",
  clientRecordVersion: "integer",
} as const;

const HC_BUCKET = {
  ...HC_TAGS,
  bucket: ["string", "The bucket's label"],
  start: "string",
  end: "string",
  hasData: "boolean",
  artefactsExcluded: ["integer", "Values left out of the bucket as measurement artefacts"],
  partial: "boolean",
  method: ["string", "platform, max_origin, all_origins or origin"],
  origins: ["string[]", "The apps whose records the numbers are"],
  records: "integer",
  durationMs: "number",
  values: ["object?", "Per field of the type, the metrics asked for"],
  duplicatesDropped: "integer",
  bmrFillKcal: "number",
} as const;

const HC_HR_POINT = {
  ...HC_TAGS,
  origin: "string",
  t: ["string", "Start of the point's bucket"],
  mean: "number",
  min: "number",
  max: "number",
  n: ["integer", "Samples behind the point"],
} as const;

const HC_HR_EVENT = {
  ...HC_TAGS,
  origin: "string",
  start: "string",
  end: "string",
  peakAt: "string",
  baselineBpm: "number",
  peakBpm: "number",
  deltaBpm: "number",
  timeToPeakS: "number",
  durationS: "number",
  context: ["string", "exercise, wake, sleep or other"],
} as const;

/** What a merged group of sessions says about itself. */
const HC_GROUP = {
  origin: ["string", "The app behind the session the row describes"],
  mergedSessions: ["integer", "How many stored sessions the row stands for"],
  exactDuplicates: "integer",
  origins: ["string[]", "Every app that wrote one of them"],
  spanStart: ["string", "Start of the stretch the merged sessions cover together"],
  spanEnd: "string",
  spanMin: "number",
  members: ["object?[]", "Every session the row stands for"],
  contextClamped: ["boolean", "True when only part of an over-long session was joined"],
} as const;

const HC_SLEEP = {
  ...HC_TAGS,
  id: "string",
  date: ["string", "The local date the sleep ended on"],
  start: "string",
  end: "string",
  title: "string",
  inBedMin: "number",
  asleepMin: "number",
  awakeMin: "number",
  stageMin: ["object?", "Minutes per sleep stage"],
  stagesOverlap: ["boolean", "True when the stages overlapped and were cut"],
  onset: ["string", "First moment asleep"],
  wearableWake: ["string", "End of the last sleep stage the wearable logged"],
  hrWake: ["string", "Where the heart rate left its overnight baseline"],
  hr: ["object?", "Overnight heart rate: min, mean, max, n"],
  hrv: ["object?", "Overnight HRV: median, q1, q3, iqr, n"],
  respiratoryRate: "number",
  skinTempDelta: "number",
  restingHr: "number",
  ...HC_GROUP,
  stages: ["object?[]", "The stage timeline (include_stages)"],
} as const;

const HC_EXERCISE = {
  ...HC_TAGS,
  id: "string",
  title: "string",
  exerciseType: "string",
  start: "string",
  end: "string",
  durationMin: "number",
  hr: ["object?", "Heart rate during the session: mean, max, min, n"],
  energy: ["number", "Active kcal"],
  distance: "number",
  steps: "number",
  likelyLeftRunning: "boolean",
  overThreeHours: "boolean",
  zeroLength: "boolean",
  exactDuplicate: "boolean",
  hasRoute: "boolean",
  ...HC_GROUP,
} as const;

const HC_BP_READING = {
  id: "string",
  time: "string",
  systolic: "number",
  diastolic: "number",
  bodyPosition: "string",
  measurementLocation: "string",
  pulse: ["number", "The same app's heart rate in the reading's minute"],
  origin: "string",
} as const;

const HC_BP_READING_ROW = {
  kind: ["string", "Always reading"],
  ...HC_TAGS,
  ...HC_BP_READING,
} as const;

const HC_BP_SESSION = {
  kind: ["string", "Always session"],
  ...HC_TAGS,
  start: "string",
  end: "string",
  systolic: ["number", "Mean of the sitting"],
  diastolic: ["number", "Mean of the sitting"],
  pulse: "number",
  readingCount: "integer",
  origins: "string[]",
  readings: ["HC.BpReading[]", "The sitting's readings"],
} as const;

const HC_DAY = {
  ...HC_TAGS,
  date: "string",
  steps: "number",
  distance: "number",
  activeKcal: "number",
  totalKcal: "number",
  sleep: ["object?", "The night that ended on the day"],
  restingHr: "number",
  hrvRmssd: "number",
  respiratoryRate: "number",
  bloodPressure: ["object?", "Mean of the day's readings"],
  weight: "number",
  weighings: ["object?[]", "Every weighing of the day, each with its flag"],
  exercises: ["object?[]", "The day's workouts"],
  flags: ["string[]", "What to read with care"],
} as const;

const HC_FINDING = {
  ...HC_TAGS,
  kind: ["string", "duplicate, artefact, gap, source_switch, overlapping_origins, ..."],
  reason: "string",
  origin: "string",
  origins: ["object?", "The apps involved"],
  at: "string",
  hour: "string",
  date: "string",
  start: "string",
  end: "string",
  from: "string",
  to: "string",
  resumed: "string",
  previousShare: ["number", "Share of the day the earlier app still recorded at a source switch"],
  days: "integer",
  count: "integer",
  value: "number",
  maxValue: "number",
  minValue: "number",
  field: "string",
  fromDecimals: "integer",
  toDecimals: "integer",
  decimals: "integer",
  sessions: "integer",
  exactDuplicates: "integer",
  durationMin: "number",
  duplicateOf: "string",
  note: "string",
} as const;

/** The phone's lines in `get_health_summary`. */
const HC_SUMMARY_ROW = {
  kind: ["string", "Always phone"],
  section: ["string", "sync, latest_blood_pressure or last_night_sleep"],
  ...HC_NAMED,
  status: "string",
  lastUploadAt: "string",
  hoursSinceUpload: "number",
  time: "string",
  systolic: "number",
  diastolic: "number",
  date: "string",
  start: "string",
  end: "string",
  inBedMin: "number",
  asleepMin: "number",
  origin: "string",
} as const;

/**
 * Every Health Connect shape, by id, with the record types its rows can be
 * tagged as: `"any"` for a shape whose rows are about whichever type the
 * caller named, a list for one that is always about the same types, and an
 * empty list for a row that carries no `resourceType` at all. A rule scoped to
 * a type reaches a shape only through a row that can carry that type -- or
 * through a joined field, which `./hc-aliases.ts` knows about.
 */
const HC_SHAPES: readonly {
  id: string;
  label: string;
  fields: FieldSpecs;
  rows: "any" | readonly string[];
}[] = [
  {
    id: "hc:coverage",
    label: "Phone record-type coverage row",
    fields: HC_COVERAGE_ROW,
    rows: "any",
  },
  { id: "hc:device", label: "Phone sync row", fields: HC_DEVICE_ROW, rows: [] },
  {
    id: "hc:type_sync",
    label: "Phone record-type sync row",
    fields: HC_TYPE_SYNC_ROW,
    rows: "any",
  },
  { id: "hc:record", label: "Health Connect record", fields: HC_RECORD, rows: "any" },
  { id: "hc:bucket", label: "Health Connect aggregate bucket", fields: HC_BUCKET, rows: "any" },
  {
    id: "hc:hr_point",
    label: "Heart-rate series point",
    fields: HC_HR_POINT,
    rows: ["HeartRate"],
  },
  { id: "hc:hr_event", label: "Heart-rate event", fields: HC_HR_EVENT, rows: ["HeartRate"] },
  {
    id: "hc:sleep",
    label: "Sleep session (one night)",
    fields: HC_SLEEP,
    rows: ["SleepSession"],
  },
  { id: "hc:exercise", label: "Exercise session", fields: HC_EXERCISE, rows: ["ExerciseSession"] },
  {
    id: "hc:bp_session",
    label: "Blood-pressure sitting",
    fields: HC_BP_SESSION,
    rows: ["BloodPressure"],
  },
  {
    id: "hc:bp_reading",
    label: "Blood-pressure reading",
    fields: HC_BP_READING_ROW,
    rows: ["BloodPressure"],
  },
  { id: "hc:day", label: "Daily summary row", fields: HC_DAY, rows: ["DailySummary"] },
  { id: "hc:finding", label: "Data-quality finding", fields: HC_FINDING, rows: "any" },
  {
    id: "hc:summary",
    label: "Phone lines of the health summary",
    fields: HC_SUMMARY_ROW,
    rows: ["BloodPressure", "SleepSession"],
  },
];

/** What a `daily_summary` row is tagged as: a view over several record types. */
const HC_DAILY_SUMMARY_TYPE = "DailySummary";

/**
 * The `hc:<Type>` resource types the rule builder offers: every record type
 * the companion app maps (`worker/src/hc/record-types.ts`) -- the ones with
 * nothing numeric to summarise included, which are the ones most worth hiding
 * -- plus the daily summary's own.
 */
const HC_RESOURCE_TYPES: readonly string[] = [
  ...HC_RECORD_TYPES.map((type) => `${HC_TYPE_PREFIX}${type}`),
  `${HC_TYPE_PREFIX}${HC_DAILY_SUMMARY_TYPE}`,
];

// --- the shape registry ------------------------------------------------------

/** Every resource type with a normalizer, a raw model and a vocabulary. */
const RESOURCES: readonly {
  type: string;
  normalized: FieldSpecs;
  raw: FieldSpecs;
}[] = [
  { type: "Encounter", normalized: N_ENCOUNTER, raw: RAW_ENCOUNTER },
  { type: "Condition", normalized: N_CONDITION, raw: RAW_CONDITION },
  { type: "Observation", normalized: N_OBSERVATION, raw: RAW_OBSERVATION },
  {
    type: "MedicationRequest",
    normalized: N_MEDICATION_REQUEST,
    raw: RAW_MEDICATION_REQUEST,
  },
  {
    type: "MedicationDispense",
    normalized: N_MEDICATION_DISPENSE,
    raw: RAW_MEDICATION_DISPENSE,
  },
  { type: "AllergyIntolerance", normalized: N_ALLERGY, raw: RAW_ALLERGY },
  { type: "Immunization", normalized: N_IMMUNIZATION, raw: RAW_IMMUNIZATION },
  { type: "Procedure", normalized: N_PROCEDURE, raw: RAW_PROCEDURE },
  { type: "DiagnosticReport", normalized: N_DIAGNOSTIC_REPORT, raw: RAW_DIAGNOSTIC_REPORT },
  {
    type: "DocumentReference",
    normalized: N_DOCUMENT_REFERENCE,
    raw: RAW_DOCUMENT_REFERENCE,
  },
  { type: "CarePlan", normalized: N_CARE_PLAN, raw: RAW_CARE_PLAN },
  { type: "CareTeam", normalized: N_CARE_TEAM, raw: RAW_CARE_TEAM },
  { type: "Goal", normalized: N_GOAL, raw: RAW_GOAL },
  { type: "Device", normalized: N_DEVICE, raw: RAW_DEVICE },
  { type: "Coverage", normalized: N_COVERAGE, raw: RAW_COVERAGE },
  { type: "ServiceRequest", normalized: N_SERVICE_REQUEST, raw: RAW_SERVICE_REQUEST },
  { type: "Specimen", normalized: N_SPECIMEN, raw: RAW_SPECIMEN },
  { type: "Patient", normalized: N_PATIENT, raw: RAW_PATIENT },
  { type: "Practitioner", normalized: N_PRACTITIONER, raw: RAW_PRACTITIONER },
  { type: "Location", normalized: N_LOCATION, raw: RAW_LOCATION },
  { type: "Organization", normalized: N_ORGANIZATION, raw: RAW_ORGANIZATION },
];

interface ShapeDef {
  id: string;
  label: string;
  resourceType: string | null;
  vocabulary: "normalized" | "raw";
  fields: FieldSpecs;
}

const APPOINTMENT_SHAPE = "view:Appointment";

const SHAPES: readonly ShapeDef[] = [
  ...RESOURCES.flatMap((resource): ShapeDef[] => [
    {
      id: `normalized:${resource.type}`,
      label: `${resource.type} item`,
      resourceType: resource.type,
      vocabulary: "normalized",
      fields: resource.normalized,
    },
    {
      id: `raw:${resource.type}`,
      label: `Raw FHIR ${resource.type} (raw: true)`,
      resourceType: resource.type,
      vocabulary: "raw",
      fields: resource.raw,
    },
  ]),
  {
    id: APPOINTMENT_SHAPE,
    label: "Appointment item",
    resourceType: "Encounter",
    vocabulary: "normalized",
    fields: N_APPOINTMENT,
  },
  {
    id: CONDITION_GROUP_SHAPE,
    label: "Collapsed condition item",
    resourceType: "Condition",
    vocabulary: "normalized",
    fields: CONDITION_GROUP,
  },
  {
    id: MESSAGE_SHAPE,
    label: "Secure message (each message, before grouping)",
    resourceType: "Communication",
    vocabulary: "normalized",
    fields: MESSAGE,
  },
  {
    id: THREAD_SUMMARY_SHAPE,
    label: "Message conversation (list item)",
    resourceType: "Communication",
    vocabulary: "normalized",
    fields: THREAD_SUMMARY,
  },
  {
    id: THREAD_DETAIL_SHAPE,
    label: "Message conversation, every message in full",
    resourceType: "Communication",
    vocabulary: "normalized",
    fields: THREAD_DETAIL,
  },
  {
    id: MESSAGE_ATTACHMENT_SHAPE,
    label: "Message attachment",
    resourceType: "Communication",
    vocabulary: "normalized",
    fields: MESSAGE_ATTACHMENT,
  },
  {
    id: "summary:count",
    label: "Summary count row",
    resourceType: null,
    vocabulary: "normalized",
    fields: SUMMARY_COUNT,
  },
  {
    id: "summary:recent",
    label: "Summary section labels",
    resourceType: null,
    vocabulary: "normalized",
    fields: SUMMARY_RECENT,
  },
  {
    id: "document:text",
    label: "Document text item",
    resourceType: "DocumentReference",
    vocabulary: "normalized",
    fields: DOCUMENT_TEXT,
  },
  {
    id: "system:health_system",
    label: "Health system row",
    resourceType: null,
    vocabulary: "normalized",
    fields: HEALTH_SYSTEM_ROW,
  },
  {
    id: "system:resource_sync",
    label: "Resource sync row",
    resourceType: null,
    vocabulary: "normalized",
    fields: RESOURCE_SYNC_ROW,
  },
  ...HC_SHAPES.map(({ rows: _rows, ...shape }): ShapeDef => ({
    ...shape,
    resourceType: null,
    vocabulary: "normalized",
  })),
];

const SHAPES_BY_ID: ReadonlyMap<string, ShapeDef> = new Map(
  SHAPES.map((shape) => [shape.id, shape]),
);

/** The two shapes one resource type's collection tool emits. */
function collectionShapes(resourceType: string): string[] {
  return [`normalized:${resourceType}`, `raw:${resourceType}`];
}

type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Every shape each tool can put in its answer. `satisfies Record<ToolName, ...>`
 * makes a new tool without an entry here a compile error, so the builder can
 * never offer a tool it has no tree for.
 */
const TOOL_SHAPES = {
  get_health_summary: [
    "summary:count",
    "summary:recent",
    APPOINTMENT_SHAPE,
    CONDITION_GROUP_SHAPE,
    "normalized:MedicationRequest",
    "normalized:Observation",
    "hc:summary",
  ],
  list_health_systems: ["system:health_system"],
  get_sync_status: ["system:health_system", "system:resource_sync"],
  get_patient_profile: collectionShapes("Patient"),
  get_appointments: [APPOINTMENT_SHAPE, "raw:Encounter"],
  get_encounters: collectionShapes("Encounter"),
  get_conditions: [...collectionShapes("Condition"), CONDITION_GROUP_SHAPE],
  get_medications: collectionShapes("MedicationRequest"),
  get_medication_fills: collectionShapes("MedicationDispense"),
  get_allergies: collectionShapes("AllergyIntolerance"),
  get_immunizations: collectionShapes("Immunization"),
  get_lab_results: collectionShapes("Observation"),
  get_vitals: collectionShapes("Observation"),
  get_social_history: collectionShapes("Observation"),
  get_procedures: collectionShapes("Procedure"),
  get_diagnostic_reports: collectionShapes("DiagnosticReport"),
  get_documents: collectionShapes("DocumentReference"),
  get_document_text: ["document:text"],
  get_messages: [MESSAGE_SHAPE, THREAD_SUMMARY_SHAPE],
  get_message_thread: [MESSAGE_SHAPE, THREAD_DETAIL_SHAPE],
  get_message_attachment: [MESSAGE_ATTACHMENT_SHAPE],
  get_care_team: collectionShapes("CareTeam"),
  get_care_plans: collectionShapes("CarePlan"),
  get_goals: collectionShapes("Goal"),
  get_devices: collectionShapes("Device"),
  get_coverage: collectionShapes("Coverage"),
  get_service_requests: collectionShapes("ServiceRequest"),
  hc_coverage: ["hc:coverage"],
  hc_sync_status: ["hc:device", "hc:type_sync"],
  hc_records: ["hc:record"],
  hc_aggregate: ["hc:bucket"],
  hr_series: ["hc:hr_point"],
  hr_events: ["hc:hr_event"],
  sleep_sessions: ["hc:sleep"],
  exercise_sessions: ["hc:exercise"],
  blood_pressure: ["hc:bp_session", "hc:bp_reading"],
  daily_summary: ["hc:day"],
  data_quality: ["hc:finding"],
} as const satisfies Record<ToolName, readonly string[]>;

const TOOL_SHAPES_MAP: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(TOOL_SHAPES),
);

/** Every tool's shapes, in `TOOL_NAMES` order. */
export function toolShapes(tool: string): readonly string[] | undefined {
  return TOOL_SHAPES_MAP.get(tool);
}

/**
 * Resource types a tool answers with that have a view of their own but no FHIR
 * normalizer or raw model behind them: a secure message is read from the patient
 * portal, not a FHIR server.
 */
const VIEW_ONLY_RESOURCE_TYPES: readonly string[] = ["Communication"];

/** Every resource type the tree models, in a stable order. */
export const MODELED_RESOURCE_TYPES: readonly string[] = [
  ...RESOURCES.map((resource) => resource.type),
  ...VIEW_ONLY_RESOURCE_TYPES,
  ...HC_RESOURCE_TYPES,
];

// --- building nodes ------------------------------------------------------------

interface ParsedType {
  base: string;
  array: boolean;
  open: boolean;
}

/** `"Coding[]"` -> Coding, array. `"Timing?"` -> open. `"DoseAndRate?[]"` -> both. */
function parseType(type: string): ParsedType {
  let base = type;
  let array = false;
  if (base.endsWith(ARRAY_SEGMENT)) {
    base = base.slice(0, -ARRAY_SEGMENT.length);
    array = true;
  }
  let open = false;
  if (base.endsWith("?")) {
    base = base.slice(0, -1);
    open = true;
  }
  return { base, array, open };
}

function specParts(spec: Spec): { type: string; description: string | undefined } {
  return typeof spec === "string"
    ? { type: spec, description: undefined }
    : { type: spec[0], description: spec[1] };
}

const DATATYPE_MAP: ReadonlyMap<string, FieldSpecs> = new Map(Object.entries(DATATYPES));

/** One field spec as a node: children by datatype reference, never inlined. */
function toNode(name: string, spec: Spec, sensitive: ReadonlySet<string>): PolicyFieldNode {
  const { type, description } = specParts(spec);
  const parsed = parseType(type);
  const known = DATATYPE_MAP.has(parsed.base);
  const leaf = PRIMITIVES.has(parsed.base);
  const text = description ?? COMMON_DESCRIPTIONS.get(name);
  return {
    name,
    ...(text !== undefined && { description: text }),
    ...(parsed.array && { array: true }),
    ...(known && { type: parsed.base }),
    ...((parsed.open || (!known && !leaf)) && { open: true }),
    ...(sensitive.has(name) && { sensitive: true }),
  };
}

/**
 * The choice-type stems among a shape's keys: `value` when it has
 * `valueQuantity` and `valueString`, `medication` for `medicationReference`
 * and `medicationCodeableConcept`. Two variants at least, each the stem plus a
 * capitalised type name -- which is how FHIR spells `[x]` once serialised.
 */
const CHOICE_TYPES = new Set([
  "Quantity",
  "CodeableConcept",
  "String",
  "Boolean",
  "Integer",
  "Range",
  "Ratio",
  "SampledData",
  "Time",
  "DateTime",
  "Period",
  "Timing",
  "Instant",
  "Age",
  "Reference",
  "PositiveInt",
  "Date",
  "Duration",
  "Money",
  "Code",
]);

/** The stem of a choice-type key (`value` of `valueDateTime`), or null. Longest type name wins. */
function choiceStem(key: string): string | null {
  let stem: string | null = null;
  for (const suffix of CHOICE_TYPES) {
    if (!key.endsWith(suffix) || key.length === suffix.length) continue;
    const candidate = key.slice(0, -suffix.length);
    if (stem === null || candidate.length < stem.length) stem = candidate;
  }
  return stem;
}

function choiceGroups(keys: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const stem = choiceStem(key);
    if (stem !== null) groups.set(stem, [...(groups.get(stem) ?? []), key]);
  }
  for (const [stem, members] of groups) if (members.length < 2) groups.delete(stem);
  return groups;
}

/** The nodes of one field-spec record, with a `stem[x]` node per choice group. */
function toNodes(fields: FieldSpecs, sensitive: ReadonlySet<string> = EMPTY): PolicyFieldNode[] {
  const nodes = Object.entries(fields).map(([name, spec]) => toNode(name, spec, sensitive));
  const groups = choiceGroups(Object.keys(fields));
  for (const [stem, members] of groups) {
    nodes.push({
      name: `${stem}[x]`,
      description: `Every form of ${stem}: ${members.join(", ")}`,
      choice: members,
      // The variants differ in structure, so nothing below the stem is refused.
      open: true,
    });
  }
  return nodes;
}

const EMPTY: ReadonlySet<string> = new Set();

/** The resource types a rule can be scoped to and still meet a row of this shape. */
function shapeScopeTypes(shape: ShapeDef): string[] {
  if (!isPhoneShape(shape.id)) return shape.resourceType === null ? [] : [shape.resourceType];
  return HC_RESOURCE_TYPES.filter((type) => phoneShapeReached(shape.id, null, type));
}

function shapeDto(shape: ShapeDef): PolicyShapeDto {
  const sensitive =
    shape.vocabulary === "normalized" && shape.resourceType !== null
      ? new Set(SENSITIVE_FIELDS.get(shape.resourceType))
      : EMPTY;
  return {
    id: shape.id,
    label: shape.label,
    resourceType: shape.resourceType,
    resourceTypes: shapeScopeTypes(shape),
    vocabulary: shape.vocabulary,
    fields: toNodes(shape.fields, sensitive),
  };
}

/** One entry, built on first use: the schema is static for the life of the isolate. */
const schemaCache = new Map<"schema", PolicySchemaDto>();

/** Everything the admin UI's field picker draws from. Static; built once. */
export function policySchema(): PolicySchemaDto {
  const cached = schemaCache.get("schema");
  if (cached !== undefined) return cached;
  const datatypes: PolicyDatatypeDto[] = [...DATATYPE_MAP].map(([name, fields]) => ({
    name,
    fields: toNodes(fields),
  }));
  const tools: PolicyToolShapesDto[] = TOOL_NAMES.map((name) => ({
    name,
    shapes: [...(toolShapes(name) ?? [])],
  }));
  const schema: PolicySchemaDto = {
    datatypes,
    shapes: SHAPES.map((shape) => shapeDto(shape)),
    resourceTypes: [...MODELED_RESOURCE_TYPES],
    tools,
  };
  schemaCache.set("schema", schema);
  return schema;
}

// --- resolving a path ---------------------------------------------------------

/** How far a path got into a shape, and why it stopped. */
export type Resolution =
  | {
      ok: true;
      /** The path with `[]` written in wherever it steps into an array. */
      canonical: readonly string[];
    }
  | {
      ok: false;
      /** Segments that did resolve. */
      matched: readonly string[];
      /** The segment that did not. */
      failed: string;
      /** What would have been accepted at that point, for a suggestion. */
      options: readonly string[];
    };

/** The children of a node, from its own list or its datatype. */
function childrenOf(node: PolicyFieldNode): readonly PolicyFieldNode[] {
  if (node.children !== undefined) return node.children;
  return node.type === undefined ? [] : datatypeNodes(node.type);
}

const datatypeNodeCache = new Map<string, PolicyFieldNode[]>();

function datatypeNodes(name: string): PolicyFieldNode[] {
  let nodes = datatypeNodeCache.get(name);
  if (nodes === undefined) {
    const fields = DATATYPE_MAP.get(name);
    nodes = fields === undefined ? [] : toNodes(fields);
    datatypeNodeCache.set(name, nodes);
  }
  return nodes;
}

const shapeNodeCache = new Map<string, PolicyFieldNode[]>();

function shapeNodes(shapeId: string): PolicyFieldNode[] {
  let nodes = shapeNodeCache.get(shapeId);
  if (nodes === undefined) {
    const shape = SHAPES_BY_ID.get(shapeId);
    nodes = shape === undefined ? [] : shapeDto(shape).fields;
    shapeNodeCache.set(shapeId, nodes);
  }
  return nodes;
}

/**
 * Walk `path` through one shape.
 *
 * `[]` must meet an array; a named segment that meets an array steps into its
 * elements implicitly, exactly as the filter does. A `stem[x]` segment resolves
 * against the choice node of that stem. An `open` node accepts anything below it.
 */
export function resolveInShape(shapeId: string, path: readonly string[]): Resolution {
  const walk: Walk = {
    nodes: shapeNodes(shapeId),
    current: undefined,
    inArray: false,
    matched: [],
  };
  for (const [index, segment] of path.entries()) {
    if (step(walk, segment)) continue;
    // Below an open node the rest of the path is taken as written.
    if (walk.current?.open === true) {
      return { ok: true, canonical: [...walk.matched, ...path.slice(index)] };
    }
    return {
      ok: false,
      matched: [...walk.matched],
      failed: segment,
      options: walk.nodes.map((node) => node.name),
    };
  }
  return { ok: true, canonical: walk.matched };
}

/** Where a path walk has got to. */
interface Walk {
  /** The children the next named segment is looked up among. */
  nodes: readonly PolicyFieldNode[];
  /** The node the last named segment matched. */
  current: PolicyFieldNode | undefined;
  /** True right after an `[]` stepped into `current`'s elements. */
  inArray: boolean;
  /** The canonical path so far. */
  matched: string[];
}

/** Advance one segment. False when it does not fit. */
function step(walk: Walk, segment: string): boolean {
  const steppable = walk.current?.array === true && !walk.inArray;
  if (segment === ARRAY_SEGMENT) {
    if (!steppable) return false;
    walk.inArray = true;
    walk.matched.push(segment);
    return true;
  }
  const next = walk.nodes.find((node) => node.name === segment);
  if (next === undefined) return false;
  // A named segment below an array steps into its elements, as the filter
  // does; the canonical path says so.
  if (steppable) walk.matched.push(ARRAY_SEGMENT);
  walk.current = next;
  walk.inArray = false;
  walk.nodes = childrenOf(next);
  walk.matched.push(segment);
  return true;
}

/** Tool-specific shapes whose rows carry the `resourceType` they describe. */
const TYPED_ROWS: ReadonlySet<string> = new Set([
  "summary:count",
  "summary:recent",
  "system:resource_sync",
]);

/** The Health Connect shapes, by id. Their rows carry an `hc:<Type>` and never a FHIR type. */
const HC_SHAPES_BY_ID: ReadonlyMap<string, (typeof HC_SHAPES)[number]> = new Map(
  HC_SHAPES.map((shape) => [shape.id, shape]),
);

/** True for one of the Health Connect shapes. */
export function isPhoneShape(shapeId: string): boolean {
  return HC_SHAPES_BY_ID.has(shapeId);
}

/**
 * The `resourceType`s a row of one Health Connect shape can carry when `tool`
 * answers with it, as far as a rule on `ruleType` is concerned: the shape's
 * own fixed types, or -- for a shape about whichever type the caller named --
 * the rule's own type and every type whose rows the tool joins it onto.
 */
export function phoneRowTypes(shapeId: string, tool: string, ruleType: string): string[] {
  const rows = HC_SHAPES_BY_ID.get(shapeId)?.rows ?? [];
  const candidates =
    rows === "any" ? [ruleType, ...HC_RESOURCE_TYPES] : rows.map((type) => asPhoneType(type));
  return [...new Set(candidates)].filter((rowType) => hcRuleCanReach(tool, rowType, ruleType));
}

function asPhoneType(type: string): string {
  return `${HC_TYPE_PREFIX}${type}`;
}

/** The tools a scope names: the one, or every one. */
function toolsInScope(tool: string | null): readonly string[] {
  return tool === null ? TOOL_NAMES : [tool];
}

/** True when a rule on `ruleType` can meet a row of this shape in some tool of the scope. */
function phoneShapeReached(shapeId: string, tool: string | null, ruleType: string): boolean {
  return toolsInScope(tool).some(
    (name) =>
      (toolShapes(name) ?? []).includes(shapeId) &&
      phoneRowTypes(shapeId, name, ruleType).length > 0,
  );
}

/**
 * The shape ids a rule with this scope can reach. No tool: every shape. A
 * resource type narrows to that type's shapes, plus the tool-specific rows
 * that carry a `resourceType` of whatever they describe (summary counts, sync
 * rows), which the filter matches by that field.
 *
 * A phone's rows are typed `hc:<Type>`, so the two families never reach each
 * other's shapes, and within the phone's a type reaches only the shapes whose
 * rows can carry it or its data: `hc:HeartRate` reaches a heart-rate point
 * and, through the joined overnight heart rate, a night -- but not a
 * blood-pressure-only shape's own fields, and not the phone's sync row, which
 * has no type at all.
 */
export function shapesForScope(scope: {
  tool: string | null;
  resourceType: string | null;
}): string[] {
  const fromTool =
    scope.tool === null ? SHAPES.map((shape) => shape.id) : [...(toolShapes(scope.tool) ?? [])];
  const { resourceType } = scope;
  if (resourceType === null) return fromTool;
  const phoneType = isHcResourceType(resourceType);
  return fromTool.filter((id) => {
    const shape = SHAPES_BY_ID.get(id);
    if (shape === undefined) return false;
    if (isPhoneShape(id)) return phoneType && phoneShapeReached(id, scope.tool, resourceType);
    return shape.resourceType === null
      ? TYPED_ROWS.has(shape.id) && !phoneType
      : shape.resourceType === resourceType;
  });
}

/** The vocabulary a shape is written in, for the alias engine. */
export function shapeVocabulary(shapeId: string): "normalized" | "raw" | undefined {
  return SHAPES_BY_ID.get(shapeId)?.vocabulary;
}

/** The resource type a shape belongs to, or null for a tool-specific one. */
export function shapeResourceType(shapeId: string): string | null {
  return SHAPES_BY_ID.get(shapeId)?.resourceType ?? null;
}

// --- renderings the alias engine derives from the tree -------------------------

/** Raw datatypes a normalizer renders to one string, and where that string comes from. */
function renderedSources(name: string, rawType: string): string[][] | null {
  const base = parseType(rawType).base;
  if (base === "CodeableConcept") {
    return [
      [name, "text"],
      [name, "coding", ARRAY_SEGMENT, "display"],
      [name, "coding", ARRAY_SEGMENT, "code"],
    ];
  }
  return base === "Reference" ? [[name, "display"]] : null;
}

/**
 * The renames that are not renames: a normalized string field with the same
 * name as a raw CodeableConcept or Reference -- `category`, `clinicalStatus`,
 * Observation's `code`, `requester`, `payor` -- is that element rendered to
 * text (`codeText`, `refs.display`). So a rule against the raw `display` of a
 * coding has to take the normalized text with it. Derived here from the two
 * trees rather than written out per module, because every such field follows
 * the same two rules.
 */
export function sameNameRenderings(resourceType: string): FieldAlias[] {
  const resource = RESOURCES.find((entry) => entry.type === resourceType);
  if (resource === undefined) return [];
  const raw = new Map(Object.entries(resource.raw));
  const out: FieldAlias[] = [];
  for (const [name, spec] of Object.entries(resource.normalized)) {
    const normalizedBase = parseType(specParts(spec).type).base;
    const rawSpec = raw.get(name);
    if (normalizedBase !== "string" || rawSpec === undefined) continue;
    const sources = renderedSources(name, specParts(rawSpec).type);
    if (sources !== null) out.push({ normalized: [name], raw: sources, rendered: true });
  }
  return out;
}
