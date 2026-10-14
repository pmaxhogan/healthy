/**
The MCP tool catalogue the admin UI lists next to the exposure deny-list.

### Why this is a hard-coded table

The obvious source is the MCP server itself -- `worker/src/mcp/` registers these
tools and knows their real descriptions. It does not export a catalogue today,
and importing the server module to enumerate them would drag `McpAgent`, the
Durable Object base class and the MCP SDK into every `/api` request.

So this is a *description* of that surface, not its definition, and the two can
drift. The guard against drift is `worker/test/unit/api/tool-catalog.test.ts`, which
pins the names, plus this note:

WHEN `worker/src/mcp/` EXPORTS `TOOL_CATALOG`, delete this file and re-export from
there. The names below are the locked list from the build spec, and the
`resourceTypes` are what the exposure filter matches a `resource` deny-rule
against -- so a name that exists here and not there is a deny-rule the owner can
write and that will never fire, which is the failure mode worth avoiding.
*/

import { HC_RECORD_TYPES } from "../hc/record-types.ts";

import type { McpToolInfoDto } from "@shared/types.ts";

/**
What a `resource` deny-rule matches the Health Connect tools' rows by:
`hc:<Type>` for every record type the companion app maps -- the ones with
nothing numeric to summarise included. The tools that read whichever type
the caller names list all of them.
*/
const HC_TYPES: readonly string[] = HC_RECORD_TYPES.map((type) => `hc:${type}`);

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
    name: "sync_health_systems",
    description:
      "Asks for a sync now (ordinary, full or patient portal). The one tool that acts; never signs in.",
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
    name: "get_messages",
    description: "Patient-portal secure messages, every folder, one item per conversation.",
    resourceTypes: ["Communication"],
  },
  {
    name: "get_message_thread",
    description: "One patient-portal conversation, every message in full, in order.",
    resourceTypes: ["Communication"],
  },
  {
    name: "get_message_attachment",
    description: "One secure message's attached file, as the portal pass stored it.",
    resourceTypes: ["Communication"],
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
    // Not Specimen: it is synced where a health system offers it (few do to
    // patient apps), but no tool returns specimens.
    resourceTypes: ["ServiceRequest"],
  },
  {
    name: "get_health_summary",
    description: "Counts and the most recent items per category, across every health system.",
    resourceTypes: [],
  },
  // Health Connect, from a paired phone. `hc:<Type>` is what a `resource`
  // deny-rule matches these tools' rows by.
  {
    name: "hc_coverage",
    description: "What the paired phone holds per record type, and whether each is permitted.",
    resourceTypes: [...HC_TYPES],
  },
  {
    name: "hc_sync_status",
    description: "How the phone's uploads are doing: last upload, backlog, backfill, failures.",
    resourceTypes: [...HC_TYPES],
  },
  {
    name: "hc_records",
    description: "Raw Health Connect records of one type in a time range.",
    resourceTypes: [...HC_TYPES],
  },
  {
    name: "hc_aggregate",
    description: "One Health Connect record type in calendar buckets, duplicates handled.",
    resourceTypes: [...HC_TYPES],
  },
  {
    name: "hr_series",
    description: "Heart rate from the phone as a time series, at a chosen resolution.",
    resourceTypes: ["hc:HeartRate"],
  },
  {
    name: "hr_events",
    description: "Sustained rises in heart rate: standing up, waking, spikes.",
    resourceTypes: ["hc:HeartRate", "hc:SleepSession", "hc:ExerciseSession"],
  },
  {
    name: "sleep_sessions",
    description: "One row per night: stages, both wake times, overnight heart rate and HRV.",
    resourceTypes: [
      "hc:SleepSession",
      "hc:HeartRate",
      "hc:HeartRateVariabilityRmssd",
      "hc:RespiratoryRate",
      "hc:SkinTemperature",
      "hc:RestingHeartRate",
    ],
  },
  {
    name: "exercise_sessions",
    description: "Workouts, overlaps merged, with heart rate, energy, distance and steps.",
    resourceTypes: [
      "hc:ExerciseSession",
      "hc:HeartRate",
      "hc:Steps",
      "hc:Distance",
      "hc:ActiveCaloriesBurned",
    ],
  },
  {
    name: "blood_pressure",
    description: "Blood-pressure readings from the phone, duplicates dropped, grouped by sitting.",
    resourceTypes: ["hc:BloodPressure", "hc:HeartRate"],
  },
  {
    name: "daily_summary",
    description: "One row per day joining steps, energy, sleep, heart, blood pressure and weight.",
    resourceTypes: [
      "hc:DailySummary",
      "hc:Steps",
      "hc:Distance",
      "hc:ActiveCaloriesBurned",
      "hc:TotalCaloriesBurned",
      "hc:SleepSession",
      "hc:RestingHeartRate",
      "hc:HeartRateVariabilityRmssd",
      "hc:RespiratoryRate",
      "hc:BloodPressure",
      "hc:Weight",
      "hc:ExerciseSession",
    ],
  },
  {
    name: "data_quality",
    description: "Duplicates, artefacts, gaps and source changes in the phone's data.",
    resourceTypes: [...HC_TYPES],
  },
];
