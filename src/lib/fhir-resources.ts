// The FHIR resource types this deployment caches, offered as autocomplete when
// writing a policy rule.
//
// A hint, not a contract: the Worker's own search registry decides what is
// fetched, and a rule naming a type that is not listed here is still valid. The
// list is public FHIR vocabulary, so nothing personal lives in it.

export const RESOURCE_TYPES: readonly string[] = [
  "AllergyIntolerance",
  "CarePlan",
  "CareTeam",
  "Condition",
  "Coverage",
  "Device",
  "DiagnosticReport",
  "DocumentReference",
  "Encounter",
  "Goal",
  "Immunization",
  "Location",
  "MedicationDispense",
  "MedicationRequest",
  "Observation",
  "Organization",
  "Patient",
  "Practitioner",
  "PractitionerRole",
  "Procedure",
  "ServiceRequest",
  "Specimen",
];
