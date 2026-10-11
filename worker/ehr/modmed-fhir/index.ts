/**
 * The ModMed health system adapter, for ModMed's certified FHIR API: the shared
 * SMART machinery (`../smart.ts`) plus what ModMed does its own way.
 *
 * Not to be confused with `../modmed/`, which is the patient-portal client. The
 * certified API has no Appointment resource, so upcoming visits still come from
 * the portal; this adapter is the clinical record.
 *
 * ModMed-specific behaviour this encodes:
 *
 *  - **Every practice has its own FHIR base**, and that base is what a health
 *    system row stores and what `aud` carries. ModMed also runs a base with no
 *    practice attached; it answers discovery like any other, and its sign-in page
 *    then rejects every patient's password, because it has no practice to look
 *    the patient up in. Nothing here can tell the two apart, so the admin UI says
 *    which one to enter.
 *  - **An unregistered scope refuses the whole request.** The authorization server
 *    answers `invalid_scope` rather than dropping what it does not know, so
 *    `scopesFor` asks only for the resource types ModMed registers patient apps
 *    for, whatever the search registry would like.
 *  - **A patient search needs no `category`**, and narrowing by one loses data:
 *    the server files documents under categories the registry has no name for,
 *    and a plain `patient=` search returns all of them.
 *  - **An Encounter is a visit record, not an appointment.** Its start is when the
 *    visit was opened in the chart, not when it was booked, and there is no
 *    Appointment resource at all. So the calendar is left to the patient portal
 *    (`../modmed/`), and Encounters are cached with the rest of the record.
 *  - **`launch/patient` is required** for the token response to carry `patient`.
 *  - **The token endpoint takes `client_secret_post` only.** Discovery says so,
 *    which is all the shared code needs.
 *  - **Access tokens are short-lived** (minutes), with a refresh token that is
 *    rotated on every use. The token manager scales its refresh margin to the
 *    lifetime it is told (`worker/sync/tokens.ts`).
 */

import { SMART_BASE_SCOPES } from "../adapter.ts";
import { createSmartAdapter, patientReadScopes } from "../smart.ts";

import type { AdapterDeps, EhrAdapter } from "../adapter.ts";

/**
 * The resource types ModMed's vendor dashboard lets a patient app register
 * `patient/<type>.rs` for. An app is registered for all of them or it is not
 * registered, so this is the list rather than a per-deployment setting.
 */
const REGISTERED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
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
  "Medication",
  "MedicationDispense",
  "MedicationRequest",
  "Observation",
  "Organization",
  "Patient",
  "Practitioner",
  "PractitionerRole",
  "Procedure",
  "Provenance",
  "Questionnaire",
  "QuestionnaireResponse",
  "RelatedPerson",
  "ServiceRequest",
  "Specimen",
]);

/**
 * A ModMed access token lives five minutes, so the default five-minute margin
 * would refresh before every request. One minute still covers a slow page.
 */
const REFRESH_SKEW_MS = 60 * 1000;

const MODMED_BASE_SCOPES: readonly string[] = [...SMART_BASE_SCOPES, "launch/patient"];

export function createModMedFhirAdapter(deps: AdapterDeps): EhrAdapter {
  return createSmartAdapter(
    {
      vendor: "modmed",
      refreshSkewMs: REFRESH_SKEW_MS,
      categoryScopedSearches: false,
      encountersAreAppointments: false,
      scopesFor: (resourceTypes) =>
        patientReadScopes(
          resourceTypes.filter((type) => REGISTERED_RESOURCE_TYPES.has(type)),
          MODMED_BASE_SCOPES,
        ),
    },
    deps,
  );
}
