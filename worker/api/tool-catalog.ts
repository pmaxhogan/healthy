/**
 * The MCP tool catalogue the admin UI lists next to the exposure deny-list.
 *
 * ### Why this is a hard-coded table
 *
 * The obvious source is the MCP server itself -- `worker/mcp/` registers these
 * tools and knows their real descriptions. It does not export a catalogue today,
 * and importing the server module to enumerate them would drag `McpAgent`, the
 * Durable Object base class and the MCP SDK into every `/api` request.
 *
 * So this is a *description* of that surface, not its definition, and the two can
 * drift. The guard against drift is `test/unit/api/tool-catalog.test.ts`, which
 * pins the names, plus this note:
 *
 * WHEN `worker/mcp/` EXPORTS `TOOL_CATALOG`, delete this file and re-export from
 * there. The names below are the locked list from the build spec, and the
 * `resourceTypes` are what the exposure filter matches a `resource` deny-rule
 * against -- so a name that exists here and not there is a deny-rule the owner can
 * write and that will never fire, which is the failure mode worth avoiding.
 */

import type { McpToolInfoDto } from "@shared/types.ts";

export const TOOL_CATALOG: readonly McpToolInfoDto[] = [
  {
    name: "list_health_systems",
    description: "The connected health systems and what each one exposes.",
    resourceTypes: [],
  },
  {
    name: "get_sync_status",
    description: "When each health system was last synced, and whether it needs re-authorising.",
    resourceTypes: [],
  },
  {
    name: "get_patient_profile",
    description: "Demographics as each health system holds them.",
    resourceTypes: ["Patient"],
  },
  {
    name: "get_appointments",
    description: "Upcoming and recent appointments in a date range.",
    resourceTypes: ["Encounter", "Location", "Practitioner", "Organization"],
  },
  {
    name: "get_encounters",
    description: "Visit history, including completed and cancelled encounters.",
    resourceTypes: ["Encounter"],
  },
  {
    name: "get_conditions",
    description: "Problem list, encounter diagnoses and health concerns.",
    resourceTypes: ["Condition"],
  },
  {
    name: "get_medications",
    description: "Prescribed and reported medications.",
    resourceTypes: ["MedicationRequest", "Medication"],
  },
  {
    name: "get_medication_fills",
    description: "Dispense records: what was actually picked up, and when.",
    resourceTypes: ["MedicationDispense"],
  },
  {
    name: "get_allergies",
    description: "Allergies and intolerances.",
    resourceTypes: ["AllergyIntolerance"],
  },
  {
    name: "get_immunizations",
    description: "Vaccination history.",
    resourceTypes: ["Immunization"],
  },
  {
    name: "get_lab_results",
    description: "Laboratory observations in a date range, optionally by code.",
    resourceTypes: ["Observation", "DiagnosticReport"],
  },
  {
    name: "get_vitals",
    description: "Vital-sign observations in a date range.",
    resourceTypes: ["Observation"],
  },
  {
    name: "get_social_history",
    description: "Social history and survey observations.",
    resourceTypes: ["Observation"],
  },
  { name: "get_procedures", description: "Procedures performed.", resourceTypes: ["Procedure"] },
  {
    name: "get_diagnostic_reports",
    description: "Diagnostic reports and their conclusions.",
    resourceTypes: ["DiagnosticReport"],
  },
  {
    name: "get_documents",
    description: "Clinical note metadata. The text is a separate tool.",
    resourceTypes: ["DocumentReference"],
  },
  {
    name: "get_document_text",
    description: "The text of one clinical note, fetched on demand and cached.",
    resourceTypes: ["DocumentReference", "Binary"],
  },
  {
    name: "get_care_team",
    description: "Care team members and their roles.",
    resourceTypes: ["CareTeam", "Practitioner", "PractitionerRole"],
  },
  {
    name: "get_care_plans",
    description: "Care plans and their activities.",
    resourceTypes: ["CarePlan"],
  },
  { name: "get_goals", description: "Care goals and their progress.", resourceTypes: ["Goal"] },
  {
    name: "get_devices",
    description: "Implanted and assigned devices.",
    resourceTypes: ["Device"],
  },
  { name: "get_coverage", description: "Insurance coverage on file.", resourceTypes: ["Coverage"] },
  {
    name: "get_service_requests",
    description: "Orders and referrals.",
    resourceTypes: ["ServiceRequest", "Specimen"],
  },
  {
    name: "get_health_summary",
    description: "Counts and the most recent items per category, across every health system.",
    resourceTypes: [],
  },
];
