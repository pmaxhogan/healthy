import { normalizeAllergy } from "./allergy.ts";
import { normalizeCarePlan } from "./care-plan.ts";
import { normalizeCareTeam } from "./care-team.ts";
import { normalizeCondition } from "./condition.ts";
import { normalizeCoverage } from "./coverage.ts";
import { normalizeDevice } from "./device.ts";
import { normalizeDiagnosticReport } from "./diagnostic-report.ts";
import { normalizeDocumentReference } from "./document-reference.ts";
import { normalizeEncounter } from "./encounter.ts";
import { normalizeGoal } from "./goal.ts";
import { normalizeImmunization } from "./immunization.ts";
import { normalizeLocation } from "./location.ts";
import { normalizeMedicationDispense } from "./medication-dispense.ts";
import { normalizeMedicationRequest } from "./medication-request.ts";
import { normalizeObservation } from "./observation.ts";
import { normalizeOrganization } from "./organization.ts";
import { normalizePatient } from "./patient.ts";
import { normalizePractitioner } from "./practitioner.ts";
import { normalizeProcedure } from "./procedure.ts";
import { normalizeServiceRequest } from "./service-request.ts";
import { normalizeSpecimen } from "./specimen.ts";

import type {
  NormalizeCtx,
  NormalizedAppointmentView,
  NormalizedEncounter,
  NormalizedGeneric,
  NormalizedResource,
} from "./types.ts";
import type * as fhir4 from "fhir/r4";

export type {
  NormalizeCtx,
  NormalizedAppointmentView,
  NormalizedEncounter,
  NormalizedResource,
} from "./types.ts";
export { mapResolver } from "./refs.ts";
/** Every resource type this module has a dedicated normalizer for. Anything
 * else falls back to the generic shape in {@link normalizeResource}. */
export const NORMALIZED_TYPES = [
  "Encounter",
  "Condition",
  "Observation",
  "MedicationRequest",
  "MedicationDispense",
  "AllergyIntolerance",
  "Immunization",
  "Procedure",
  "DiagnosticReport",
  "DocumentReference",
  "CarePlan",
  "CareTeam",
  "Goal",
  "Device",
  "Coverage",
  "ServiceRequest",
  "Specimen",
  "Patient",
  "Practitioner",
  "Location",
  "Organization",
] as const;

function normalizeGeneric(resource: fhir4.FhirResource, ctx: NormalizeCtx): NormalizedGeneric {
  // `text` (the narrative) lives on `DomainResource`, not the base `Resource`
  // -- most resources are domain resources, but the type only guarantees the
  // narrower shape, so it is read defensively.
  const narrative = (resource as fhir4.DomainResource).text?.div;
  return {
    resourceType: resource.resourceType,
    id: resource.id ?? "",
    healthSystem: ctx.healthSystem,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(narrative && { text: narrative }),
  };
}

/**
 * Dispatches on `resource.resourceType` to the matching `normalizeX`
 * function. A resource type with no dedicated normalizer (or a type not on
 * {@link NORMALIZED_TYPES}) falls back to a generic `{resourceType, id,
 * health system, text?}` shape, `text` being the resource's narrative if present.
 */

export function normalizeResource(
  resource: fhir4.FhirResource,
  ctx: NormalizeCtx,
): NormalizedResource {
  switch (resource.resourceType) {
    case "Encounter": {
      return normalizeEncounter(resource, ctx);
    }
    case "Condition": {
      return normalizeCondition(resource, ctx);
    }
    case "Observation": {
      return normalizeObservation(resource, ctx);
    }
    case "MedicationRequest": {
      return normalizeMedicationRequest(resource, ctx);
    }
    case "MedicationDispense": {
      return normalizeMedicationDispense(resource, ctx);
    }
    case "AllergyIntolerance": {
      return normalizeAllergy(resource, ctx);
    }
    case "Immunization": {
      return normalizeImmunization(resource, ctx);
    }
    case "Procedure": {
      return normalizeProcedure(resource, ctx);
    }
    case "DiagnosticReport": {
      return normalizeDiagnosticReport(resource, ctx);
    }
    case "DocumentReference": {
      return normalizeDocumentReference(resource, ctx);
    }
    case "CarePlan": {
      return normalizeCarePlan(resource, ctx);
    }
    case "CareTeam": {
      return normalizeCareTeam(resource, ctx);
    }
    case "Goal": {
      return normalizeGoal(resource, ctx);
    }
    case "Device": {
      return normalizeDevice(resource, ctx);
    }
    case "Coverage": {
      return normalizeCoverage(resource, ctx);
    }
    case "ServiceRequest": {
      return normalizeServiceRequest(resource, ctx);
    }
    case "Specimen": {
      return normalizeSpecimen(resource, ctx);
    }
    case "Patient": {
      return normalizePatient(resource, ctx);
    }
    case "Practitioner": {
      return normalizePractitioner(resource, ctx);
    }
    case "Location": {
      return normalizeLocation(resource, ctx);
    }
    case "Organization": {
      return normalizeOrganization(resource, ctx);
    }
    default: {
      return normalizeGeneric(resource, ctx);
    }
  }
}

/**
 * The calendar-facing projection of a normalized Encounter. Picks the primary
 * practitioner as the first entry of `encounter.practitioners` -- Epic's
 * primary-performer/attending participant, when present, is already sorted
 * there by {@link normalizeEncounter}. `end` is left `undefined` when the
 * source Encounter had none; the calendar sync's own default-duration rule
 * applies later, not here.
 */
export function appointmentViewFromEncounter(
  encounter: NormalizedEncounter,
  ctx: NormalizeCtx,
): NormalizedAppointmentView {
  const primary = encounter.practitioners[0];

  return {
    healthSystem: ctx.healthSystem,
    encounterId: encounter.id,
    status: encounter.status,
    ...(encounter.start && { start: encounter.start }),
    ...(encounter.end && { end: encounter.end }),
    ...(encounter.visitType && { visitType: encounter.visitType }),
    ...(primary?.name && { practitioner: primary.name }),
    ...(primary?.specialty && { specialty: primary.specialty }),
    ...(encounter.location && { location: encounter.location }),
    ...(encounter.organization && { org: encounter.organization }),
    ...(encounter.department && { department: encounter.department }),
    telehealth: encounter.telehealth,
    ...(encounter.identifiers.csn && { csn: encounter.identifiers.csn }),
  };
}
