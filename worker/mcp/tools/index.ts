/**
 * The tool catalogue.
 *
 * `registerTools` is called from `HealthyMcp.init()` with the real dependencies
 * and from the unit tests with in-memory ones, which is what makes every tool
 * testable without workerd, a Durable Object or D1.
 *
 * `TOOL_NAMES` is the same list as a value, exported so a test can assert that
 * what is registered matches what is documented -- and so the admin UI's policy
 * editor can offer the tool names without hard-coding them a second time. It
 * lives in `../tool-names.ts`, a module with no imports, so the exposure
 * policy's field tree can name every tool without importing the tools (which
 * import the policy filter).
 */

import { registerAppointmentTools } from "./appointments.ts";
import { registerClinicalTools } from "./clinical.ts";
import { registerDocumentTools } from "./documents.ts";
import { registerHealthSystemTools } from "./health-systems.ts";
import { registerSummaryTool } from "./summary.ts";

import type { ToolDeps } from "../deps.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export { TOOL_NAMES } from "../tool-names.ts";

export function registerTools(server: McpServer, deps: ToolDeps): void {
  registerSummaryTool(server, deps);
  registerHealthSystemTools(server, deps);
  registerAppointmentTools(server, deps);
  registerClinicalTools(server, deps);
  registerDocumentTools(server, deps);
}
