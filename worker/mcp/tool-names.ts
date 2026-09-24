/**
 * Every tool this server registers, in the order a caller would meet them.
 *
 * Re-exported by `tools/index.ts`, which is where a reader looks for it; kept
 * in a module of its own, with no imports, so `worker/policy/tree.ts` can key
 * its per-tool field shapes by it without an import cycle through the tools.
 */
export const TOOL_NAMES = [
  "get_health_summary",
  "list_health_systems",
  "get_sync_status",
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
  "get_care_team",
  "get_care_plans",
  "get_goals",
  "get_devices",
  "get_coverage",
  "get_service_requests",
] as const;
