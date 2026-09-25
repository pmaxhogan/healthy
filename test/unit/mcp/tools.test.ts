// The tools, end to end, over the SDK's in-memory transport.
//
// This is the test that would catch a tool wired straight to `JSON.stringify`:
// every assertion here goes through the real `McpServer`, the real zod schemas and
// the real policy filter, so a tool that skipped `respond` would show up as an
// envelope with the wrong shape or as data that a deny rule failed to remove.

import { beforeEach, describe, expect, it } from "vitest";

import { TOOL_NAMES } from "../../../worker/mcp/tools/index.ts";
import { buildRules } from "../../../worker/policy/rules.ts";
import { UNSUPPORTED_ERROR_CODE } from "../../../worker/sync/sync-state-codes.ts";

import {
  NAME_A,
  NAME_B,
  NOW,
  HEALTH_SYSTEM_A,
  HEALTH_SYSTEM_B,
  callTool,
  connectTools,
  fakeDeps,
  fakeState,
} from "./helpers.ts";

import type { FakeState } from "./helpers.ts";
import type { PolicyRuleInput } from "../../../worker/policy/rules.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const rules = (...input: PolicyRuleInput[]) => buildRules(input);

/**
 * The world each test starts from, in a holder rather than two `let`s.
 *
 * `beforeEach` assigns into it, and a test mutates `world.state` to change what
 * the tools see mid-session.
 */
const world: { state: FakeState; client: Client } = {
  state: fakeState(),
  client: undefined as unknown as Client,
};

beforeEach(async () => {
  world.state = fakeState();
  world.client = await connectTools(fakeDeps(world.state));
});

describe("the registered surface", () => {
  it("registers exactly the documented tools", async () => {
    const { tools } = await world.client.listTools();

    expect(new Set(tools.map((tool) => tool.name))).toStrictEqual(new Set(TOOL_NAMES));
  });

  it("annotates every tool read-only, non-destructive and closed-world", async () => {
    const { tools } = await world.client.listTools();

    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it("gives every tool a description, because the description is the prompt", async () => {
    const { tools } = await world.client.listTools();

    for (const tool of tools) {
      expect(tool.description ?? "", tool.name).not.toBe("");
    }
  });

  it("tells a model that get_document_text also takes an attachment url", async () => {
    const { tools } = await world.client.listTools();
    const documents = tools.find((tool) => tool.name === "get_documents");
    const documentText = tools.find((tool) => tool.name === "get_document_text");
    const idProperty = documentText?.inputSchema.properties?.id as { description?: string };

    expect(documents?.description).toContain("attachment");
    expect(idProperty.description).toContain("attachments[].url");
  });
});

describe("the envelope", () => {
  it("carries items, total, matched, warnings, truncated and generatedAt", async () => {
    const answer = await callTool(world.client, "get_conditions");
    const parsed = JSON.parse(answer.text) as Record<string, unknown>;

    expect(Object.keys(parsed).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      "coverage",
      "generatedAt",
      "items",
      "matched",
      "total",
      "truncated",
      "warnings",
    ]);
    expect(parsed.generatedAt).toBe(new Date(NOW * 1000).toISOString());
  });

  it("tags every item with the health system display name and id", async () => {
    const answer = await callTool(world.client, "get_conditions");

    expect(answer.items.length).toBeGreaterThan(0);
    for (const item of answer.items) {
      expect([NAME_A, NAME_B]).toContain(item.healthSystem);
      expect([HEALTH_SYSTEM_A, HEALTH_SYSTEM_B]).toContain(item.healthSystemId);
    }
  });

  it("omits `raw` unless it was asked for, and includes it when it was", async () => {
    const plain = await callTool(world.client, "get_conditions");
    const withRaw = await callTool(world.client, "get_conditions", { raw: true });

    expect(plain.raw).toBeUndefined();
    expect(withRaw.raw).toHaveLength(withRaw.items.length);
    expect(withRaw.raw?.[0]?.resource.resourceType).toBe("Condition");
  });

  it("reports truncation and respects `limit`", async () => {
    const answer = await callTool(world.client, "get_conditions", { limit: 1 });

    expect(answer.items).toHaveLength(1);
    expect(answer.truncated).toBe(true);
    expect(answer.total).toBeGreaterThan(1);
  });

  it("returns everything and reports no truncation when `limit` is omitted", async () => {
    const answer = await callTool(world.client, "get_conditions");

    expect(answer.items).toHaveLength(answer.total);
    expect(answer.truncated).toBe(false);
  });

  it("orders newest first across health systems", async () => {
    const answer = await callTool(world.client, "get_conditions");
    const codes = answer.items.map((item) => (item.code as { text?: string } | undefined)?.text);

    // 2026-04-04 (A), 2026-02-02 (B), then 2025-11-11 (A).
    expect(codes).toStrictEqual([
      "Seasonal allergic rhinitis",
      "Migraine without aura",
      "Sprained ankle",
    ]);
  });
});

describe("health system selection", () => {
  it("reads every health system by default", async () => {
    const answer = await callTool(world.client, "list_health_systems");

    expect(answer.items.map((item) => item.healthSystem)).toStrictEqual([NAME_A, NAME_B]);
  });

  it("narrows by health system id", async () => {
    const answer = await callTool(world.client, "get_conditions", {
      healthSystems: [HEALTH_SYSTEM_B],
    });

    expect(new Set(answer.items.map((item) => item.healthSystemId))).toStrictEqual(
      new Set([HEALTH_SYSTEM_B]),
    );
  });

  it("narrows by a case-insensitive substring of the display name", async () => {
    const answer = await callTool(world.client, "get_conditions", { healthSystems: ["other cli"] });

    expect(new Set(answer.items.map((item) => item.healthSystem))).toStrictEqual(new Set([NAME_B]));
  });

  it("returns nothing for a name that matches nothing, rather than everything", async () => {
    const answer = await callTool(world.client, "get_conditions", { healthSystems: ["nonesuch"] });

    expect(answer.items).toStrictEqual([]);
  });
});

describe("strict inputs", () => {
  /** Every call that must be refused by the schema before the tool body runs. */
  const REFUSED: [string, Record<string, unknown>][] = [
    // The whole reason the schemas are strict: a model that invents an argument
    // must be told, not quietly served an unfiltered list.
    ["get_conditions", { patient: "me" }],
    // No ceiling on `limit` any more -- 5000 is a valid request for "everything,
    // and I mean it", not a schema violation. Zero is still refused: it is not a
    // meaningful count of items to return.
    ["get_conditions", { limit: 0 }],
    ["get_conditions", { healthSystems: "prov_a" }],
    ["get_conditions", { raw: "yes" }],
    ["get_encounters", { from: "last tuesday" }],
    ["get_document_text", { id: "doc-1" }],
    ["get_document_text", { healthSystem: HEALTH_SYSTEM_A }],
  ];

  it("refuses a bad argument instead of running the tool", async () => {
    for (const [name, args] of REFUSED) {
      const label = `${name} ${JSON.stringify(args)}`;
      const answer = await callTool(world.client, name, args);
      expect(answer.isError, label).toBe(true);
      expect(answer.text, label).toContain("Invalid arguments");
      expect(answer.items, label).toStrictEqual([]);
    }
  });

  it("rejects an unknown argument on every registered tool", async () => {
    for (const name of TOOL_NAMES) {
      const answer = await callTool(world.client, name, {
        nope: 1,
        ...(name === "get_document_text" && { healthSystem: HEALTH_SYSTEM_A, id: "doc-1" }),
      });
      expect(answer.isError, name).toBe(true);
      expect(answer.text, name).toContain("Invalid arguments");
    }
  });
});

describe("normalized output", () => {
  it("resolves practitioner references through the reference pool", async () => {
    const answer = await callTool(world.client, "get_appointments");
    const appointment = answer.items.find((item) => item.encounterId === "enc-future");

    expect(appointment?.practitioner).toBe("Dr Ada Rivers");
    expect(appointment?.visitType).toBe("Follow-up");
    // Tagged with the resource type it came from, so a `resource` deny rule on
    // Encounter reaches appointments too.
    expect(appointment?.resourceType).toBe("Encounter");
  });

  it("keeps vital-sign components", async () => {
    const answer = await callTool(world.client, "get_vitals");
    const [first] = answer.items;

    expect(first?.components).toStrictEqual([
      { code: "Systolic", value: { value: 118, unit: "mm[Hg]" } },
      { code: "Diastolic", value: { value: 74, unit: "mm[Hg]" } },
    ]);
  });

  it("separates labs, vitals and social history by category", async () => {
    const labs = await callTool(world.client, "get_lab_results");
    const vitals = await callTool(world.client, "get_vitals");
    const social = await callTool(world.client, "get_social_history");

    expect(labs.items.map((item) => item.id)).toStrictEqual(["obs-lab"]);
    expect(vitals.items.map((item) => item.id)).toStrictEqual(["obs-vital"]);
    expect(social.items.map((item) => item.id)).toStrictEqual(["obs-social"]);
  });

  it("narrows labs by code and by name substring", async () => {
    const byCode = await callTool(world.client, "get_lab_results", { code: "4548-4" });
    const byText = await callTool(world.client, "get_lab_results", { text: "hemoglobin" });
    const noMatch = await callTool(world.client, "get_lab_results", { code: "0000-0" });

    expect(byCode.items).toHaveLength(1);
    expect(byText.items).toHaveLength(1);
    expect(noMatch.items).toStrictEqual([]);
  });

  it("filters medications to the active list on request", async () => {
    const all = await callTool(world.client, "get_medications");
    const active = await callTool(world.client, "get_medications", { active: true });

    expect(all.items).toHaveLength(2);
    expect(active.items.map((item) => item.medication)).toStrictEqual(["Cetirizine 10 mg"]);
  });

  it("filters conditions by clinical status", async () => {
    const resolved = await callTool(world.client, "get_conditions", { status: "resolved" });

    expect(resolved.items.map((item) => item.id)).toStrictEqual(["cond-2"]);
  });

  it("shows only upcoming appointments by default, and says so", async () => {
    const upcoming = await callTool(world.client, "get_appointments");
    const everything = await callTool(world.client, "get_appointments", { includePast: true });

    // Soonest first: "what is next" is the question an upcoming window answers.
    expect(upcoming.items.map((item) => item.encounterId)).toStrictEqual(["enc-future", "enc-b"]);
    expect(upcoming.warnings).toContain("window_defaults_to_upcoming_only");
    expect(everything.items.map((item) => item.encounterId)).toContain("enc-past");
  });

  it("windows on from/to", async () => {
    const answer = await callTool(world.client, "get_encounters", {
      from: "2026-03-01",
      to: "2026-03-31",
    });

    expect(answer.items.map((item) => item.id)).toStrictEqual(["enc-past"]);
  });
});

describe("the sensitive default, through a tool", () => {
  it("withholds birth date from the profile, and from raw", async () => {
    const answer = await callTool(world.client, "get_patient_profile", { raw: true });

    expect(answer.text).not.toContain("1970-07-07");
    expect(answer.items[0]?.withheld).toStrictEqual(["birthDate"]);
  });

  it("withholds a coverage subscriber id", async () => {
    const answer = await callTool(world.client, "get_coverage");

    expect(answer.text).not.toContain("SUB-12345");
  });

  it("never exposes a raw Patient telecom or street address, because normalization drops them", async () => {
    const answer = await callTool(world.client, "get_patient_profile");

    expect(answer.text).not.toContain("555-0100");
    expect(answer.text).not.toContain("Nowhere Lane");
  });
});

describe("the policy, through a tool", () => {
  it("answers policy_denied for a denied tool and reads nothing", async () => {
    world.state.rules = rules({ rule_type: "tool", target: "get_conditions" });

    const answer = await callTool(world.client, "get_conditions");

    expect(answer.isError).toBe(true);
    expect(answer.error).toBe("policy_denied");
    expect(answer.text).not.toContain("rhinitis");
  });

  it("hides a denied health system everywhere, list_health_systems included", async () => {
    world.state.rules = rules({ rule_type: "health_system", target: HEALTH_SYSTEM_B });

    const listed = await callTool(world.client, "list_health_systems");
    const conditions = await callTool(world.client, "get_conditions");
    const summary = await callTool(world.client, "get_health_summary");

    for (const answer of [listed, conditions, summary]) {
      expect(answer.text).not.toContain(NAME_B);
      expect(answer.text).not.toContain(HEALTH_SYSTEM_B);
      expect(answer.text).not.toContain("Migraine");
    }
  });

  it("removes a denied resource type from the summary's counts as well as its items", async () => {
    world.state.rules = rules({ rule_type: "resource", target: "Condition" });

    const summary = await callTool(world.client, "get_health_summary");

    expect(summary.items.some((item) => item.resourceType === "Condition")).toBe(false);
    expect(summary.text).not.toContain("rhinitis");
    expect(summary.text).not.toContain("Migraine");
    // The rest of the summary is still there.
    expect(summary.items.some((item) => item.resourceType === "Observation")).toBe(true);
  });

  it("removes a denied field from the normalized item", async () => {
    world.state.rules = rules({ rule_type: "field", target: "Observation.components[].value" });

    const answer = await callTool(world.client, "get_vitals");

    expect(answer.text).not.toContain("118");
    expect(answer.text).toContain("Systolic");
  });

  it("needs the raw shape's own path to strip the raw shape, and honours it", async () => {
    // A field target is a literal path, and the raw FHIR path is not the
    // normalized one (`component[].valueQuantity` vs `components[].value`). The
    // cross-shape default is `sensitive`; a field rule is exact, by design.
    world.state.rules = rules(
      { rule_type: "field", target: "Observation.components[].value" },
      { rule_type: "field", target: "Observation.component[].valueQuantity" },
    );

    const answer = await callTool(world.client, "get_vitals", { raw: true });

    expect(answer.text).not.toContain("118");
    expect(answer.text).not.toContain("74");
    expect(answer.text).toContain("Systolic");
  });

  it("puts a sensitive field back for an allow rule", async () => {
    world.state.rules = rules({ rule_type: "field", target: "allow:Patient.birthDate" });

    const answer = await callTool(world.client, "get_patient_profile");

    expect(answer.text).toContain("1970-07-07");
  });
});

describe("the master switch", () => {
  it("answers mcp_disabled from every tool when settings say so", async () => {
    world.state.enabled = false;

    for (const name of ["get_conditions", "list_health_systems", "get_health_summary"]) {
      const answer = await callTool(world.client, name);
      expect(answer.isError, name).toBe(true);
      expect(answer.error, name).toBe("mcp_disabled");
    }
  });

  it("reads nothing at all when disabled", async () => {
    world.state.enabled = false;

    const answer = await callTool(world.client, "get_conditions");

    expect(answer.text).not.toContain("rhinitis");
  });
});

describe("get_document_text", () => {
  it("returns the decoded text for a resolvable health system", async () => {
    const answer = await callTool(world.client, "get_document_text", {
      healthSystem: HEALTH_SYSTEM_A,
      id: "doc-1",
    });

    expect(answer.items[0]?.text).toBe("Patient reports seasonal symptoms.");
    expect(answer.items[0]?.chars).toBe("Patient reports seasonal symptoms.".length);
  });

  it("reports the daily cap with its own code", async () => {
    world.state.document = { ok: false, reason: "cap_reached" };

    const answer = await callTool(world.client, "get_document_text", {
      healthSystem: HEALTH_SYSTEM_A,
      id: "doc-1",
    });

    expect(answer.isError).toBe(true);
    expect(answer.error).toBe("document_cap_reached");
    expect(answer.text).toContain("daily document cap reached");
  });

  it("refuses an unsupported format and a missing document distinctly", async () => {
    world.state.document = { ok: false, reason: "unsupported" };
    const unsupported = await callTool(world.client, "get_document_text", {
      healthSystem: HEALTH_SYSTEM_A,
      id: "d",
    });
    expect(unsupported.error).toBe("unsupported_document");

    world.state.document = { ok: false, reason: "not_found" };
    const missing = await callTool(world.client, "get_document_text", {
      healthSystem: HEALTH_SYSTEM_A,
      id: "d",
    });
    expect(missing.error).toBe("not_found");
  });

  it("passes a not_found detail through to the answer, when documentText gives one", async () => {
    world.state.document = {
      ok: false,
      reason: "not_found",
      detail: "looked like a Binary reference (Binary/nope); use the `id` get_documents reported",
    };

    const answer = await callTool(world.client, "get_document_text", {
      healthSystem: HEALTH_SYSTEM_A,
      id: "Binary/nope",
    });

    expect(answer.error).toBe("not_found");
    expect(answer.text).toContain("looked like a Binary reference");
    expect(answer.text).toContain("get_documents");
  });

  it("refuses a health system name that matches nothing", async () => {
    const answer = await callTool(world.client, "get_document_text", {
      healthSystem: "nonesuch",
      id: "doc-1",
    });

    expect(answer.error).toBe("not_found");
  });

  it("refuses a health system name that matches more than one", async () => {
    // Both display names contain "e"; an ambiguous match must not silently pick one.
    const answer = await callTool(world.client, "get_document_text", {
      healthSystem: "e",
      id: "doc-1",
    });

    expect(answer.error).toBe("not_found");
    expect(answer.text).toContain("more than one health system");
  });
});

describe("get_sync_status", () => {
  it("reports per-resource freshness with the organisation's warnings", async () => {
    const answer = await callTool(world.client, "get_sync_status");
    const row = answer.items.find((item) => item.kind === "resource_sync");

    expect(row?.resourceType).toBe("Condition");
    expect(row?.lastOk).toBe(true);
    expect(row?.warnings).toStrictEqual([{ code: "4119", count: 1 }]);
  });
});

describe("get_health_summary", () => {
  it("reports counts per health system and the most recent items per category", async () => {
    const answer = await callTool(world.client, "get_health_summary");
    const counts = answer.items.filter((item) => item.kind === "count");
    const recent = answer.items.filter((item) => item.kind === "recent");

    expect(counts.some((item) => item.resourceType === "Condition" && item.count === 2)).toBe(true);
    expect(new Set(recent.map((item) => item.section))).toStrictEqual(
      new Set(["appointments", "conditions", "medications", "labs"]),
    );
    // The section label must not shadow the resource's own FHIR category array.
    const condition = recent.find((item) => item.resourceType === "Condition");
    expect(condition?.category).toStrictEqual(["problem-list-item"]);
  });

  it("does not report its own decoded-document cache as a resource type", async () => {
    world.state.counts = [
      ...world.state.counts,
      { healthSystemId: HEALTH_SYSTEM_A, resourceType: "_binary_text", count: 3 },
    ];

    const answer = await callTool(world.client, "get_health_summary");

    expect(answer.text).not.toContain("_binary_text");
  });

  it("carries coverage for the appointments, conditions, medications and labs sections", async () => {
    const answer = await callTool(world.client, "get_health_summary");

    const types = new Set(answer.coverage?.map((entry) => entry.resourceType));
    expect(types).toStrictEqual(
      new Set(["Encounter", "Condition", "MedicationRequest", "Observation"]),
    );
  });
});

describe("coverage", () => {
  // Neither fixture health system has any CarePlan in its pool, so get_care_plans
  // always comes back with `items: []` -- the exact case an empty array must not
  // be read as "no care plans exist".
  it("reports failed, with the error code, when the last sync threw", async () => {
    world.state.syncStatus = [
      {
        healthSystemId: HEALTH_SYSTEM_A,
        resourceType: "CarePlan",
        lastFullAt: NOW - 3600,
        lastOk: false,
        lastErrorCode: "upstream_error:59109",
        warnings: [],
      },
    ];

    const answer = await callTool(world.client, "get_care_plans");

    expect(answer.items).toStrictEqual([]);
    const row = answer.coverage?.find(
      (entry) => entry.healthSystemId === HEALTH_SYSTEM_A && entry.resourceType === "CarePlan",
    );
    expect(row).toMatchObject({ status: "failed", errorCode: "upstream_error:59109" });
    expect(answer.warnings).toContain("incomplete_no_data_is_not_absence");
  });

  it("reports never for a health system CarePlan has not been synced for at all", async () => {
    world.state.syncStatus = [];

    const answer = await callTool(world.client, "get_care_plans");

    const rows = answer.coverage?.filter((entry) => entry.resourceType === "CarePlan") ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.every((entry) => entry.status === "never")).toBe(true);
    expect(answer.warnings).toContain("incomplete_no_data_is_not_absence");
  });

  it("reports stale once the last success is older than the refresh's own cadence", async () => {
    world.state.syncStatus = [
      {
        healthSystemId: HEALTH_SYSTEM_A,
        resourceType: "CarePlan",
        lastFullAt: NOW - 90_000, // 25 hours -- more than a day, still not stale
        lastOk: true,
        lastErrorCode: null,
        warnings: [],
      },
      {
        healthSystemId: HEALTH_SYSTEM_B,
        resourceType: "CarePlan",
        lastFullAt: NOW - 300_000, // over three days
        lastOk: true,
        lastErrorCode: null,
        warnings: [],
      },
    ];

    const answer = await callTool(world.client, "get_care_plans");

    const byHealthSystem = new Map(
      answer.coverage
        ?.filter((entry) => entry.resourceType === "CarePlan")
        .map((entry) => [entry.healthSystemId, entry]),
    );
    expect(byHealthSystem.get(HEALTH_SYSTEM_A)?.status).toBe("ok");
    expect(byHealthSystem.get(HEALTH_SYSTEM_B)?.status).toBe("stale");
  });

  it("reports unsupported, not failed, and does not add the incomplete warning for it alone", async () => {
    world.state.syncStatus = [
      {
        healthSystemId: HEALTH_SYSTEM_A,
        resourceType: "CarePlan",
        lastFullAt: NOW - 3600,
        lastOk: false,
        lastErrorCode: UNSUPPORTED_ERROR_CODE,
        warnings: [],
      },
      {
        healthSystemId: HEALTH_SYSTEM_B,
        resourceType: "CarePlan",
        lastFullAt: NOW - 3600,
        lastOk: false,
        lastErrorCode: UNSUPPORTED_ERROR_CODE,
        warnings: [],
      },
    ];

    const answer = await callTool(world.client, "get_care_plans");

    const rows = answer.coverage?.filter((entry) => entry.resourceType === "CarePlan") ?? [];
    expect(rows.every((entry) => entry.status === "unsupported")).toBe(true);
    expect(rows.every((entry) => entry.errorCode === undefined)).toBe(true);
    // Every covered pair is "unsupported", which is a complete answer, not a gap.
    expect(answer.warnings).not.toContain("incomplete_no_data_is_not_absence");
  });

  it("does not add the incomplete warning when items are not empty, whatever coverage says", async () => {
    world.state.syncStatus = [
      {
        healthSystemId: HEALTH_SYSTEM_B,
        resourceType: "Condition",
        lastFullAt: NOW - 3600,
        lastOk: false,
        lastErrorCode: "upstream_error",
        warnings: [],
      },
    ];

    const answer = await callTool(world.client, "get_conditions");

    expect(answer.items.length).toBeGreaterThan(0);
    expect(answer.warnings).not.toContain("incomplete_no_data_is_not_absence");
    // The gap is still reported, just not escalated into the top-level warning
    // -- both as a structured `coverage` entry and as a flat warning, so a
    // caller that only reads `warnings` cannot miss it either. System A's data
    // filling `items` must not hide system B's failing sync.
    expect(
      answer.coverage?.some(
        (entry) => entry.healthSystemId === HEALTH_SYSTEM_B && entry.status === "failed",
      ),
    ).toBe(true);
    expect(answer.warnings).toContain(`sync_failed:Condition:${HEALTH_SYSTEM_B}:upstream_error`);
  });

  it("never reveals a denied resource type through coverage", async () => {
    world.state.rules = rules({ rule_type: "resource", target: "CarePlan" });
    world.state.syncStatus = [
      {
        healthSystemId: HEALTH_SYSTEM_A,
        resourceType: "CarePlan",
        lastFullAt: NOW - 3600,
        lastOk: false,
        lastErrorCode: "upstream_error",
        warnings: [],
      },
    ];

    const answer = await callTool(world.client, "get_care_plans");

    expect(answer.coverage).toStrictEqual([]);
    expect(answer.text).not.toContain("CarePlan");
  });

  it("never reveals a denied health system through coverage", async () => {
    world.state.rules = rules({ rule_type: "health_system", target: HEALTH_SYSTEM_B });
    world.state.syncStatus = [
      {
        healthSystemId: HEALTH_SYSTEM_B,
        resourceType: "CarePlan",
        lastFullAt: NOW - 3600,
        lastOk: false,
        lastErrorCode: "upstream_error",
        warnings: [],
      },
    ];

    const answer = await callTool(world.client, "get_care_plans");

    expect(answer.coverage?.some((entry) => entry.healthSystemId === HEALTH_SYSTEM_B)).toBe(false);
    expect(answer.text).not.toContain(HEALTH_SYSTEM_B);
    expect(answer.text).not.toContain(NAME_B);
  });
});
