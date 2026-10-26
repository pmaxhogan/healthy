/**
Every tool this server registers, in the order a caller would meet them.

Re-exported by `tools/index.ts`, which is where a reader looks for it; kept
in a module of its own, with no imports, so `worker/src/policy/tree.ts` can key
its per-tool field shapes by it without an import cycle through the tools.
*/
export const TOOL_NAMES = [
  "get_health_summary",
  "list_health_systems",
  "get_sync_status",
  // The one tool that acts: it asks the sync engine for a run.
  "sync_health_systems",
  "get_patient_profile",
  "get_appointments",
  "get_encounters",
  "get_conditions",
  "get_medications",
  "get_medication_fills",
  "get_allergies",
  "get_immunizations",
  "get_lab_results",
  "get_vitals",
  "get_social_history",
  "get_procedures",
  "get_diagnostic_reports",
  "get_documents",
  "get_document_text",
  "get_messages",
  "get_message_thread",
  "get_message_attachment",
  // The second tool that acts: it re-reads one health system's portal messages.
  "refresh_messages",
  "get_care_team",
  "get_care_plans",
  "get_goals",
  "get_devices",
  "get_coverage",
  "get_service_requests",
  // The paired phone's Health Connect data: a source of its own, beside the
  // health systems. Names as the tool specification fixed them.
  "hc_coverage",
  "hc_sync_status",
  "hc_records",
  "hc_aggregate",
  "hr_series",
  "hr_events",
  "sleep_sessions",
  "exercise_sessions",
  "blood_pressure",
  "daily_summary",
  "data_quality",
] as const;

/** One tool's name. */
export type ToolName = (typeof TOOL_NAMES)[number];
