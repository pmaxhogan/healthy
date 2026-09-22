// Output shapes for the normalize layer: slim, stable, LLM-friendly JSON
// projections of Epic-flavored FHIR R4 resources. Every interface here is a
// plain data shape -- no methods, no class instances -- so it serializes with
// `JSON.stringify` exactly as written. Optional fields are omitted by the
// normalizers rather than set to `undefined`, so the wire format never carries
// noise.
import type { RefResolver } from "./refs.ts";

/** Context every `normalizeX` function receives: which provider connection
 * the resource came from, and a synchronous resolver for its references. */
export interface NormalizeCtx {
  provider: string;
  refs: RefResolver;
}

/** Fields every normalized output object carries. */
interface NormalizedBase {
  resourceType: string;
  id: string;
  provider: string;
  lastUpdated?: string;
}

export interface NormalizedAddress {
  lines?: string[];
  city?: string;
  state?: string;
  postalCode?: string;
}

export interface NormalizedLocationRef {
  name?: string;
  address?: NormalizedAddress;
  phone?: string;
}

export interface NormalizedPractitionerRef {
  name?: string;
  specialty?: string;
  role?: string;
}

export interface NormalizedEncounter extends NormalizedBase {
  resourceType: "Encounter";
  status: string;
  class?: string;
  visitType?: string;
  start?: string;
  end?: string;
  practitioners: NormalizedPractitionerRef[];
  location?: NormalizedLocationRef;
  organization?: string;
  department?: string;
  reasons: string[];
  telehealth: boolean;
  identifiers: { csn?: string };
}

/** The calendar-facing projection of an `Encounter`: exactly the fields the
 * Google Calendar sync needs to build an event, nothing more. */
export interface NormalizedAppointmentView {
  provider: string;
  encounterId: string;
  status: string;
  start?: string;
  end?: string;
  visitType?: string;
  practitioner?: string;
  specialty?: string;
  location?: NormalizedLocationRef;
  org?: string;
  department?: string;
  telehealth: boolean;
  csn?: string;
}

export interface NormalizedCodeableConcept {
  text?: string;
  system?: string;
  code?: string;
}

export interface NormalizedCondition extends NormalizedBase {
  resourceType: "Condition";
  code?: NormalizedCodeableConcept;
  category: string[];
  clinicalStatus?: string;
  verificationStatus?: string;
  onset?: string;
  recorded?: string;
  abatement?: string;
}

export interface NormalizedObservationValue {
  value: string | number;
  unit?: string;
}

export interface NormalizedObservationComponent {
  code?: string;
  value?: NormalizedObservationValue;
}

export interface NormalizedObservation extends NormalizedBase {
  resourceType: "Observation";
  code?: string;
  category: string[];
  value?: NormalizedObservationValue;
  interpretation?: string;
  referenceRange?: string;
  effective?: string;
  issued?: string;
  status: string;
  components: NormalizedObservationComponent[];
}

export interface NormalizedMedicationRequest extends NormalizedBase {
  resourceType: "MedicationRequest";
  medication?: string;
  status: string;
  intent: string;
  authoredOn?: string;
  dosageText: string[];
  requester?: string;
  reasons: string[];
}

export interface NormalizedMedicationDispense extends NormalizedBase {
  resourceType: "MedicationDispense";
  medication?: string;
  status: string;
  quantity?: NormalizedObservationValue;
  daysSupply?: NormalizedObservationValue;
  whenHandedOver?: string;
  dosageText: string[];
}

export interface NormalizedAllergyReaction {
  manifestation: string[];
  severity?: string;
}

export interface NormalizedAllergy extends NormalizedBase {
  resourceType: "AllergyIntolerance";
  substance?: string;
  reactions: NormalizedAllergyReaction[];
  criticality?: string;
  clinicalStatus?: string;
  onset?: string;
}

export interface NormalizedImmunization extends NormalizedBase {
  resourceType: "Immunization";
  vaccine?: string;
  occurrence?: string;
  status: string;
  lot?: string;
  site?: string;
  route?: string;
  doseNumber?: string;
}

export interface NormalizedProcedurePerformer {
  name?: string;
  function?: string;
}

export interface NormalizedProcedure extends NormalizedBase {
  resourceType: "Procedure";
  code?: string;
  performed?: string;
  status: string;
  performers: NormalizedProcedurePerformer[];
  reasons: string[];
}

export interface NormalizedDiagnosticReport extends NormalizedBase {
  resourceType: "DiagnosticReport";
  code?: string;
  category: string[];
  effective?: string;
  issued?: string;
  status: string;
  conclusion?: string;
  resultRefs: string[];
  presentedFormRefs: string[];
}

export interface NormalizedDocumentAttachment {
  contentType?: string;
  url?: string;
  title?: string;
}

export interface NormalizedDocumentReference extends NormalizedBase {
  resourceType: "DocumentReference";
  type?: string;
  category: string[];
  date?: string;
  status: string;
  description?: string;
  author: string[];
  attachments: NormalizedDocumentAttachment[];
}

export interface NormalizedCarePlan extends NormalizedBase {
  resourceType: "CarePlan";
  title?: string;
  status: string;
  intent: string;
  category: string[];
  period?: { start?: string; end?: string };
  activities: string[];
}

export interface NormalizedCareTeamParticipant {
  name?: string;
  role?: string;
}

export interface NormalizedCareTeam extends NormalizedBase {
  resourceType: "CareTeam";
  name?: string;
  status?: string;
  participants: NormalizedCareTeamParticipant[];
}

export interface NormalizedGoal extends NormalizedBase {
  resourceType: "Goal";
  description?: string;
  lifecycleStatus: string;
  achievementStatus?: string;
  startDate?: string;
  targets: string[];
}

export interface NormalizedDevice extends NormalizedBase {
  resourceType: "Device";
  type?: string;
  manufacturer?: string;
  model?: string;
  status?: string;
  udi?: string;
}

export interface NormalizedCoverage extends NormalizedBase {
  resourceType: "Coverage";
  payor: string[];
  type?: string;
  subscriberId?: string;
  status: string;
  /** Field names in this object the policy layer must be able to strip. */
  sensitive: string[];
}

export interface NormalizedServiceRequest extends NormalizedBase {
  resourceType: "ServiceRequest";
  code?: string;
  status: string;
  intent: string;
  occurrence?: string;
  requester?: string;
  reasons: string[];
}

export interface NormalizedSpecimen extends NormalizedBase {
  resourceType: "Specimen";
  type?: string;
  status?: string;
  collected?: string;
}

export interface NormalizedPatient extends NormalizedBase {
  resourceType: "Patient";
  name?: string;
  birthDate?: string;
  gender?: string;
  address?: { city?: string; state?: string };
  /** Field names in this object the policy layer must be able to strip. */
  sensitive: string[];
}

export interface NormalizedPractitioner extends NormalizedBase {
  resourceType: "Practitioner";
  name?: string;
  gender?: string;
  qualifications: string[];
}

export interface NormalizedLocation extends NormalizedBase {
  resourceType: "Location";
  name?: string;
  address?: NormalizedAddress;
  phone?: string;
  status?: string;
}

export interface NormalizedOrganization extends NormalizedBase {
  resourceType: "Organization";
  name?: string;
  type?: string;
  address?: NormalizedAddress;
  phone?: string;
}

/** Fallback for any resource type without a dedicated normalizer. */
export interface NormalizedGeneric extends NormalizedBase {
  text?: string;
}

/** The union of every shape `normalizeResource` can hand back. */
export type NormalizedResource =
  | NormalizedEncounter
  | NormalizedCondition
  | NormalizedObservation
  | NormalizedMedicationRequest
  | NormalizedMedicationDispense
  | NormalizedAllergy
  | NormalizedImmunization
  | NormalizedProcedure
  | NormalizedDiagnosticReport
  | NormalizedDocumentReference
  | NormalizedCarePlan
  | NormalizedCareTeam
  | NormalizedGoal
  | NormalizedDevice
  | NormalizedCoverage
  | NormalizedServiceRequest
  | NormalizedSpecimen
  | NormalizedPatient
  | NormalizedPractitioner
  | NormalizedLocation
  | NormalizedOrganization
  | NormalizedGeneric;
