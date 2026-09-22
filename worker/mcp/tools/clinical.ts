/**
 * The per-resource read tools: one per thing a medical record contains.
 *
 * Deliberately many small tools rather than one `query_fhir`. A model picks a
 * tool by name, and "get_allergies" is a better prompt than a resource type plus
 * a category parameter it has to get right. It also means the owner's deny-list
 * can switch off a whole subject area by naming one tool.
 *
 * Every one of them is a `collectionTool`: a description, the resource types to
 * read, the date to order by, and any predicate. No tool in this file touches the
 * network, the policy rules or the serialiser -- `collectionTool` owns all three.
 */

import { z } from "zod";

import { WINDOW_ARGS, sharedOnlyArgs, toolArgs } from "../args.ts";
import { spec } from "../collect.ts";
import {
  LABORATORY,
  SOCIAL_HISTORY,
  VITAL_SIGNS,
  hasCategory,
  hasCode,
  slug,
  textMatches,
} from "../match.ts";

import { collectionTool } from "./register.ts";

import type { ToolDeps } from "../deps.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** `A · B` style: the first non-empty of several optional strings. */
function firstOf(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value !== "");
}

export function registerClinicalTools(server: McpServer, deps: ToolDeps): void {
  collectionTool(server, deps, {
    name: "get_patient_profile",
    description:
      "The demographic record each connected health system holds: name, gender, " +
      "and city/state. Birth date is withheld unless the owner has allowed it.",
    schema: sharedOnlyArgs(),
    specs: () => [spec("Patient")],
  });

  collectionTool(server, deps, {
    name: "get_encounters",
    description:
      "Visits and admissions, newest first: status, type, times, practitioners, " +
      "department and location.",
    schema: toolArgs(WINDOW_ARGS),
    specs: () => [spec("Encounter", { dateOf: (item) => item.start })],
  });

  collectionTool(server, deps, {
    name: "get_conditions",
    description:
      "Diagnoses, problems and health concerns. Filter with `status` to see only " +
      "active or only resolved ones.",
    schema: toolArgs({
      ...WINDOW_ARGS,
      status: z
        .string()
        .min(1)
        .optional()
        .describe("Clinical status, e.g. active, inactive, resolved, remission."),
    }),
    specs: ({ status }) => [
      spec("Condition", {
        dateOf: (item) => firstOf(item.recorded, item.onset),
        ...(status !== undefined && {
          keep: (item) =>
            item.clinicalStatus !== undefined && slug(item.clinicalStatus) === slug(status),
        }),
      }),
    ],
  });

  collectionTool(server, deps, {
    name: "get_medications",
    description:
      "Prescriptions and medication orders. Pass `active: true` for the current " +
      "medication list rather than the whole history.",
    schema: toolArgs({
      ...WINDOW_ARGS,
      active: z.boolean().optional().describe("Only orders whose status is active."),
    }),
    specs: ({ active }) => [
      spec("MedicationRequest", {
        dateOf: (item) => item.authoredOn,
        ...(active === true && { keep: (item) => slug(item.status) === "active" }),
      }),
    ],
  });

  collectionTool(server, deps, {
    name: "get_medication_fills",
    description:
      "Dispense records: what was actually handed over, when, how much, and the " +
      "days supply. Complements get_medications, which is what was ordered.",
    schema: toolArgs(WINDOW_ARGS),
    specs: () => [spec("MedicationDispense", { dateOf: (item) => item.whenHandedOver })],
  });

  collectionTool(server, deps, {
    name: "get_allergies",
    description: "Allergies and intolerances with their reactions, severity and criticality.",
    schema: sharedOnlyArgs(),
    specs: () => [spec("AllergyIntolerance", { dateOf: (item) => item.onset })],
  });

  collectionTool(server, deps, {
    name: "get_immunizations",
    description: "Vaccination history: vaccine, date, status, site and route.",
    schema: toolArgs(WINDOW_ARGS),
    specs: () => [spec("Immunization", { dateOf: (item) => item.occurrence })],
  });

  collectionTool(server, deps, {
    name: "get_lab_results",
    description:
      "Laboratory observations with their values, units, reference ranges and " +
      "interpretations. Narrow with `code` (a LOINC or local code) or `text` " +
      "(a substring of the test name).",
    schema: toolArgs({
      ...WINDOW_ARGS,
      code: z.string().min(1).optional().describe("Match this observation code exactly."),
      text: z.string().min(1).optional().describe("Match this substring of the test name."),
    }),
    specs: ({ code, text }) => [
      spec("Observation", {
        dateOf: (item) => firstOf(item.effective, item.issued),
        keep: (item, resource) =>
          hasCategory(resource, item.category, LABORATORY) &&
          (code === undefined || hasCode(resource, code)) &&
          (text === undefined || textMatches(text, [item.code])),
      }),
    ],
  });

  collectionTool(server, deps, {
    name: "get_vitals",
    description:
      "Vital-sign observations: blood pressure (as systolic/diastolic components), " +
      "heart rate, temperature, weight, height and the rest.",
    schema: toolArgs(WINDOW_ARGS),
    specs: () => [
      spec("Observation", {
        dateOf: (item) => firstOf(item.effective, item.issued),
        keep: (item, resource) => hasCategory(resource, item.category, VITAL_SIGNS),
      }),
    ],
  });

  collectionTool(server, deps, {
    name: "get_social_history",
    description:
      "Social-history observations: smoking and alcohol status, occupation and " +
      "similar screening answers.",
    schema: toolArgs(WINDOW_ARGS),
    specs: () => [
      spec("Observation", {
        dateOf: (item) => firstOf(item.effective, item.issued),
        keep: (item, resource) => hasCategory(resource, item.category, SOCIAL_HISTORY),
      }),
    ],
  });

  collectionTool(server, deps, {
    name: "get_procedures",
    description: "Procedures performed, with who performed them and why.",
    schema: toolArgs(WINDOW_ARGS),
    specs: () => [spec("Procedure", { dateOf: (item) => item.performed })],
  });

  collectionTool(server, deps, {
    name: "get_diagnostic_reports",
    description:
      "Diagnostic reports (labs, imaging, pathology) with their conclusions. The " +
      "narrative text of an attached document is fetched separately with " +
      "get_document_text.",
    schema: toolArgs(WINDOW_ARGS),
    specs: () => [
      spec("DiagnosticReport", { dateOf: (item) => firstOf(item.effective, item.issued) }),
    ],
  });

  collectionTool(server, deps, {
    name: "get_care_team",
    description: "Care team members and their roles at each health system.",
    schema: sharedOnlyArgs(),
    specs: () => [spec("CareTeam")],
  });

  collectionTool(server, deps, {
    name: "get_care_plans",
    description: "Care plans: title, status, period and the activities they call for.",
    schema: toolArgs(WINDOW_ARGS),
    specs: () => [spec("CarePlan", { dateOf: (item) => item.period?.start })],
  });

  collectionTool(server, deps, {
    name: "get_goals",
    description: "Care goals with their lifecycle status, achievement status and targets.",
    schema: toolArgs(WINDOW_ARGS),
    specs: () => [spec("Goal", { dateOf: (item) => item.startDate })],
  });

  collectionTool(server, deps, {
    name: "get_devices",
    description: "Implanted and patient-associated devices: type, manufacturer, model, UDI.",
    schema: sharedOnlyArgs(),
    specs: () => [spec("Device")],
  });

  collectionTool(server, deps, {
    name: "get_coverage",
    description:
      "Insurance coverage: payor, plan type and status. The subscriber id is " +
      "withheld unless the owner has allowed it.",
    schema: sharedOnlyArgs(),
    specs: () => [spec("Coverage")],
  });

  collectionTool(server, deps, {
    name: "get_service_requests",
    description: "Orders and referrals that have been placed: what, why, by whom, and when.",
    schema: toolArgs(WINDOW_ARGS),
    specs: () => [spec("ServiceRequest", { dateOf: (item) => item.occurrence })],
  });
}
