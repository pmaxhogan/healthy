/**
 * The tool catalogue.
 *
 * `registerTools` is called from `HealthyMcp.init()` with the real dependencies
 * and from the unit tests with in-memory ones, which is what makes every tool
 * testable without workerd, a Durable Object or D1.
 *
 * `TOOL_NAMES` is the same list as a value, exported so a test can assert that
 * what is registered matches what is documented -- and so the admin UI's policy
 * editor can offer the tool names without hard-coding them a second time.
 */

import { registerAppointmentTools } from "./appointments.ts";
import { registerClinicalTools } from "./clinical.ts";
import { registerDocumentTools } from "./documents.ts";
import { registerHealthSystemTools } from "./health-systems.ts";
import { registerSummaryTool } from "./summary.ts";

import type { ToolDeps } from "../deps.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Every tool this server registers, in the order a caller would meet them. */
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

export function registerTools(server: McpServer, deps: ToolDeps): void {
  registerSummaryTool(server, deps);
  registerHealthSystemTools(server, deps);
  registerAppointmentTools(server, deps);
  registerClinicalTools(server, deps);
  registerDocumentTools(server, deps);
}
