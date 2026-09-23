// The MCP tool catalogue.
//
// It is a hand-written description of another module's surface (see the note at the
// top of worker/api/tool-catalog.ts), so what is worth pinning is its internal
// consistency and the locked names -- the two things a careless edit breaks.

import { describe, expect, it } from "vitest";

import { TOOL_CATALOG } from "../../../worker/api/tool-catalog.ts";

/** The locked list from the build spec. A rename here is a UI/MCP mismatch. */
const EXPECTED_NAMES = [
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
  "get_health_summary",
];

describe("TOOL_CATALOG", () => {
  it("lists exactly the tools the build spec locked", () => {
    expect(TOOL_CATALOG.map((tool) => tool.name)).toStrictEqual(EXPECTED_NAMES);
  });

  it("has no duplicate names", () => {
    expect(new Set(TOOL_CATALOG.map((tool) => tool.name)).size).toBe(TOOL_CATALOG.length);
  });

  it("names every tool in snake_case, as the MCP protocol expects", () => {
    for (const tool of TOOL_CATALOG) expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("describes every tool, so the deny-list UI is legible", () => {
    for (const tool of TOOL_CATALOG) {
      expect(tool.description.length, tool.name).toBeGreaterThan(10);
      expect(tool.description.endsWith("."), tool.name).toBe(true);
    }
  });

  it("names FHIR resource types, which is what a resource deny-rule matches", () => {
    for (const tool of TOOL_CATALOG) {
      for (const type of tool.resourceTypes) {
        // Upper camel: a lower-case entry would never match a rule the owner wrote
        // against a FHIR resource type.
        expect(type, tool.name).toMatch(/^[A-Z][A-Za-z]+$/);
      }
    }
  });

  it("gives the three cross-cutting tools no resource types", () => {
    const crossCutting = new Set(["list_health_systems", "get_sync_status", "get_health_summary"]);
    const summaries = TOOL_CATALOG.filter((tool) => crossCutting.has(tool.name));
    const perResource = TOOL_CATALOG.filter((tool) => !crossCutting.has(tool.name));

    expect(summaries.map((tool) => tool.resourceTypes)).toStrictEqual([[], [], []]);
    for (const tool of perResource) {
      expect(tool.resourceTypes.length, tool.name).toBeGreaterThan(0);
    }
  });
});
