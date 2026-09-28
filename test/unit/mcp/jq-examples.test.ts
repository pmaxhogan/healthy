// Every tool's worked `jq` examples, run for real.
//
// What is pinned here:
//
//   - every registered tool's `jq` argument description carries that tool's own
//     examples from `JQ_EXAMPLES`, and nothing still carries the generic one
//   - every example compiles in the real jq engine and, run through the real
//     tool over a synthetic record holding one of everything, emits at least one
//     value -- so an example that names a field an item does not have (and so
//     selects nothing) fails here rather than misleading a model
//
// Every resource below is synthetic; no real organisation or person is named.

import { beforeAll, describe, expect, it } from "vitest";

import { JQ_EXAMPLES } from "../../../worker/mcp/jq-examples.ts";
import { TOOL_NAMES } from "../../../worker/mcp/tools/index.ts";

import {
  HEALTH_SYSTEM_A,
  HEALTH_SYSTEM_B,
  NAME_A,
  NOW,
  callTool,
  connectTools,
  fakeDeps,
  fakeState,
} from "./helpers.ts";

import type { PortalMessageRecord } from "../../../worker/mcp/deps.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** One of every resource type a tool reads, each with the fields its examples use. */
function everything(): Record<string, unknown[]> {
  const practitioner = { reference: "Practitioner/prac-1" };
  return {
    Patient: [
      {
        resourceType: "Patient",
        id: "pat-1",
        name: [{ family: "Person", given: ["Test"] }],
        gender: "other",
        address: [{ city: "Testville", state: "TS" }],
      },
    ],
    Practitioner: [
      { resourceType: "Practitioner", id: "prac-1", name: [{ family: "Rivers", given: ["Ada"] }] },
    ],
    Location: [{ resourceType: "Location", id: "loc-1", name: "Example Clinic Building" }],
    Encounter: [
      {
        resourceType: "Encounter",
        id: "enc-upcoming",
        status: "planned",
        class: { code: "AMB", display: "ambulatory" },
        type: [{ text: "Follow-up" }],
        period: { start: "2026-07-01T09:00:00Z" },
        participant: [{ individual: practitioner }],
        location: [{ location: { reference: "Location/loc-1" } }],
      },
      {
        resourceType: "Encounter",
        id: "enc-past",
        status: "finished",
        class: { code: "AMB", display: "ambulatory" },
        type: [{ text: "Annual physical" }],
        period: { start: "2026-03-02T10:00:00Z" },
        participant: [{ individual: practitioner }],
      },
    ],
    Condition: [
      {
        resourceType: "Condition",
        id: "cond-1",
        category: [{ coding: [{ code: "problem-list-item" }] }],
        clinicalStatus: { coding: [{ code: "active" }] },
        code: { text: "Seasonal allergic rhinitis" },
        onsetDateTime: "2025-04-01",
        recordedDate: "2026-04-04T00:00:00Z",
      },
    ],
    MedicationRequest: [
      {
        resourceType: "MedicationRequest",
        id: "med-1",
        status: "active",
        intent: "order",
        authoredOn: "2026-05-05T00:00:00Z",
        medicationCodeableConcept: { text: "Amoxicillin 500 mg capsule" },
        dosageInstruction: [{ text: "One capsule three times a day" }],
        requester: practitioner,
      },
    ],
    MedicationDispense: [
      {
        resourceType: "MedicationDispense",
        id: "disp-1",
        status: "completed",
        medicationCodeableConcept: { text: "Amoxicillin 500 mg capsule" },
        whenHandedOver: "2026-05-06T00:00:00Z",
        quantity: { value: 30, unit: "capsule" },
        daysSupply: { value: 10, unit: "day" },
      },
    ],
    AllergyIntolerance: [
      {
        resourceType: "AllergyIntolerance",
        id: "alg-1",
        code: { text: "Penicillin" },
        criticality: "high",
        clinicalStatus: { coding: [{ code: "active" }] },
        reaction: [{ manifestation: [{ text: "Hives" }], severity: "moderate" }],
      },
    ],
    Immunization: [
      {
        resourceType: "Immunization",
        id: "imm-1",
        status: "completed",
        vaccineCode: { text: "Influenza, seasonal" },
        occurrenceDateTime: "2025-10-01",
      },
    ],
    Observation: [
      {
        resourceType: "Observation",
        id: "obs-lab",
        status: "final",
        category: [{ coding: [{ code: "laboratory" }] }],
        code: { text: "Hemoglobin A1c" },
        valueQuantity: { value: 5.4, unit: "%" },
        referenceRange: [{ text: "4.0-5.6" }],
        interpretation: [{ text: "Normal" }],
        effectiveDateTime: "2026-05-10T00:00:00Z",
      },
      {
        resourceType: "Observation",
        id: "obs-bp",
        status: "final",
        category: [{ coding: [{ code: "vital-signs" }] }],
        code: { text: "Blood pressure" },
        effectiveDateTime: "2026-05-11T00:00:00Z",
        component: [
          { code: { text: "Systolic" }, valueQuantity: { value: 118, unit: "mm[Hg]" } },
          { code: { text: "Diastolic" }, valueQuantity: { value: 74, unit: "mm[Hg]" } },
        ],
      },
      {
        resourceType: "Observation",
        id: "obs-weight",
        status: "final",
        category: [{ coding: [{ code: "vital-signs" }] }],
        code: { text: "Body weight" },
        valueQuantity: { value: 70, unit: "kg" },
        effectiveDateTime: "2026-05-11T00:00:00Z",
      },
      {
        resourceType: "Observation",
        id: "obs-social",
        status: "final",
        category: [{ coding: [{ code: "social-history" }] }],
        code: { text: "Tobacco smoking status" },
        valueCodeableConcept: { text: "Never smoker" },
        effectiveDateTime: "2026-01-20T00:00:00Z",
      },
    ],
    Procedure: [
      {
        resourceType: "Procedure",
        id: "proc-1",
        status: "completed",
        code: { text: "Skin biopsy" },
        performedDateTime: "2025-08-08",
        performer: [{ actor: practitioner }],
        reasonCode: [{ text: "Skin lesion" }],
      },
    ],
    DiagnosticReport: [
      {
        resourceType: "DiagnosticReport",
        id: "dr-1",
        status: "final",
        code: { text: "Chest X-ray" },
        category: [{ text: "Radiology" }],
        effectiveDateTime: "2026-02-02T00:00:00Z",
        conclusion: "No acute findings.",
      },
    ],
    DocumentReference: [
      {
        resourceType: "DocumentReference",
        id: "doc-1",
        status: "current",
        date: "2026-03-02T11:00:00Z",
        type: { text: "Progress note" },
        author: [practitioner],
        content: [{ attachment: { contentType: "text/html", url: "Binary/bin-1" } }],
      },
    ],
    CareTeam: [
      {
        resourceType: "CareTeam",
        id: "ct-1",
        name: "Primary care team",
        status: "active",
        participant: [{ member: practitioner, role: [{ text: "Primary care physician" }] }],
      },
    ],
    CarePlan: [
      {
        resourceType: "CarePlan",
        id: "cp-1",
        status: "active",
        intent: "plan",
        title: "Allergy management",
        period: { start: "2026-04-04" },
        activity: [{ detail: { code: { text: "Daily antihistamine" }, status: "in-progress" } }],
      },
    ],
    Goal: [
      {
        resourceType: "Goal",
        id: "goal-1",
        lifecycleStatus: "active",
        achievementStatus: { text: "In progress" },
        description: { text: "Walk 30 minutes a day" },
        startDate: "2026-04-04",
        target: [{ detailString: "30 minutes" }],
      },
    ],
    Device: [
      {
        resourceType: "Device",
        id: "dev-1",
        status: "active",
        type: { text: "Glucose monitor" },
        manufacturer: "Example Devices",
        deviceName: [{ name: "Monitor 2", type: "model-name" }],
        udiCarrier: [{ carrierHRF: "(01)00000000000000" }],
      },
    ],
    Coverage: [
      {
        resourceType: "Coverage",
        id: "cov-1",
        status: "active",
        payor: [{ display: "Example Insurer" }],
        type: { text: "PPO" },
      },
    ],
    ServiceRequest: [
      {
        resourceType: "ServiceRequest",
        id: "sr-1",
        status: "active",
        intent: "order",
        code: { text: "Allergy referral" },
        occurrenceDateTime: "2026-07-15",
        requester: practitioner,
        reasonCode: [{ text: "Seasonal allergic rhinitis" }],
      },
    ],
  };
}

function message(sent: string, role: "patient" | "practitioner", body: string) {
  return {
    threadId: "thread-1",
    messageId: `msg:${sent}`,
    fingerprint: `fp:${sent}`,
    thread: {
      subject: "Prescription question",
      folder: "conversations",
      external: false,
      practitioners: [{ name: "Nurse Example A" }],
    },
    message: { sent, role, body, attachments: [] },
    missing: false,
  } satisfies PortalMessageRecord;
}

const world = { client: undefined as unknown as Client };

function byName(a: string, b: string): number {
  return a.localeCompare(b);
}

beforeAll(async () => {
  const state = fakeState({
    pools: new Map([
      [HEALTH_SYSTEM_A, everything()],
      [HEALTH_SYSTEM_B, {}],
    ]),
    portalMessages: new Map([
      [
        HEALTH_SYSTEM_A,
        [
          message("2026-05-01T10:00:00.000Z", "patient", "Could I get a refill please?"),
          message("2026-05-01T15:00:00.000Z", "practitioner", "Sent to your pharmacy."),
        ],
      ],
    ]),
    messageSync: [
      {
        healthSystemId: HEALTH_SYSTEM_A,
        lastAttemptAt: NOW - 600,
        lastOkAt: NOW - 600,
        lastErrorCode: null,
        complete: true,
      },
    ],
    document: {
      ok: true,
      documentId: "doc-1",
      contentType: "text/html",
      text: "Seen for allergies. Follow up in three months.",
      cached: false,
    },
  });
  // A health system that needs attention, and sync rows in every state the
  // get_sync_status examples filter for.
  const [first, second] = state.healthSystems;
  if (first === undefined || second === undefined) throw new Error("two health systems");
  state.healthSystems = [first, { ...second, status: "needs_reauth", needsReauthSince: NOW - 60 }];
  state.syncStatus = [
    {
      healthSystemId: HEALTH_SYSTEM_A,
      resourceType: "Condition",
      lastFullAt: NOW - 3600,
      lastOk: true,
      lastErrorCode: null,
      warnings: [
        { code: "4119", count: 1 },
        { code: "59001", count: 2 },
      ],
    },
    {
      healthSystemId: HEALTH_SYSTEM_A,
      resourceType: "Specimen",
      lastFullAt: null,
      lastOk: false,
      lastErrorCode: "unsupported",
      warnings: [],
    },
    {
      healthSystemId: HEALTH_SYSTEM_B,
      resourceType: "Goal",
      lastFullAt: NOW - 86_400,
      lastOk: false,
      lastErrorCode: "upstream_error:4118",
      warnings: [],
    },
  ];
  world.client = await connectTools(fakeDeps(state));
});

/** The arguments each example runs with, beyond `jq`. */
const EXTRA_ARGS: Partial<Record<(typeof TOOL_NAMES)[number], Record<string, unknown>>> = {
  get_document_text: { healthSystem: NAME_A, id: "doc-1" },
  get_message_thread: { threadId: "thread-1" },
};

describe("jq examples", () => {
  it("covers every tool, and every tool's jq description carries its own", async () => {
    const { tools } = await world.client.listTools();
    expect(Object.keys(JQ_EXAMPLES).toSorted(byName)).toStrictEqual(
      [...TOOL_NAMES].toSorted(byName),
    );

    for (const tool of tools) {
      const examples: readonly string[] = JQ_EXAMPLES[tool.name as keyof typeof JQ_EXAMPLES];
      const jq = (tool.inputSchema.properties?.jq ?? {}) as { description?: string };
      expect(examples.length, tool.name).toBeGreaterThan(0);
      for (const example of examples) {
        expect(jq.description, tool.name).toContain(`\`${example}\``);
      }
      expect(jq.description, tool.name).toContain("before `limit`");
    }
  });

  describe.each(TOOL_NAMES)("%s", (tool) => {
    it.each(JQ_EXAMPLES[tool])("runs `%s` and gets output", async (program) => {
      const answer = await callTool(world.client, tool, {
        ...EXTRA_ARGS[tool],
        jq: program,
      });

      expect(answer.error, answer.text).toBeUndefined();
      expect(answer.isError, answer.text).toBe(false);
      expect(answer.warnings, answer.text).not.toContain("jq_result_empty");
      expect(answer.items.length, answer.text).toBeGreaterThan(0);
    });
  });
});
