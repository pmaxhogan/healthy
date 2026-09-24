// Nested field rules end to end: through the real tool registrations, the real
// `respond` and the real jq engine, over the fake cache.
//
// What is pinned: a rule on a key inside an array of objects reaches every
// tool that can carry it -- the clinical tools with and without `raw`, the
// summary's sections, the portal's upcoming visits, a document's text -- and
// `jq`, which runs after the policy, cannot reach what it removed.
// Every record below is synthetic.

import { beforeEach, describe, expect, it } from "vitest";

import { buildRules } from "../../../worker/policy/rules.ts";

import { HEALTH_SYSTEM_A, NOW, callTool, connectTools, fakeDeps, fakeState } from "./helpers.ts";

import type { FakeState } from "./helpers.ts";
import type { PolicyRuleInput } from "../../../worker/policy/rules.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** A 0012-shaped field rule. */
function hide(
  paths: string[],
  scope: { tool?: string; resourceType?: string } = {},
): PolicyRuleInput {
  return {
    rule_type: "field",
    target: JSON.stringify(paths),
    effect: "hide",
    scope_tool: scope.tool ?? null,
    scope_resource: scope.resourceType ?? null,
    scope_health_system: null,
    paths_json: JSON.stringify(paths),
  };
}

const world: { state: FakeState; client: Client } = {
  state: fakeState(),
  client: undefined as unknown as Client,
};

beforeEach(async () => {
  world.state = fakeState();
  world.client = await connectTools(fakeDeps(world.state));
});

describe("a nested rule and jq", () => {
  it("jq cannot select a key the policy removed from inside an array", async () => {
    world.state.rules = buildRules([hide(["components[].value"], { resourceType: "Observation" })]);

    const answer = await callTool(world.client, "get_vitals", {
      jq: "[.[] | .components[]? | .value]",
    });

    expect(answer.isError).toBe(false);
    expect(answer.text).not.toContain("118");
    expect(answer.text).not.toContain("74");
    // jq output is always the array of every output: one output, one array.
    expect(JSON.parse(answer.text)).toMatchObject({ items: [[null, null]] });
  });

  it("jq cannot reach it through the raw resource either", async () => {
    world.state.rules = buildRules([hide(["components[].value"], { resourceType: "Observation" })]);

    const answer = await callTool(world.client, "get_vitals", {
      raw: true,
      jq: "[.[] | .raw.resource.component[]? | .valueQuantity]",
    });

    expect(answer.isError).toBe(false);
    expect(answer.text).not.toContain("mm[Hg]");
    expect(answer.text).not.toContain("118");
  });
});

describe("summary sections", () => {
  it("a Condition rule reaches the summary's recent conditions, and nothing else there", async () => {
    world.state.rules = buildRules([hide(["code.text"], { resourceType: "Condition" })]);

    const answer = await callTool(world.client, "get_health_summary");

    expect(answer.text).not.toContain("Seasonal allergic rhinitis");
    expect(answer.text).not.toContain("Migraine without aura");
    // Medications and labs are other sections, other types.
    expect(answer.text).toContain("Cetirizine 10 mg");
    expect(answer.warnings).toContain("policy_field_removed:Condition.code.text");
  });

  it("a tool-scoped rule reaches the summary and not the section's own tool", async () => {
    world.state.rules = buildRules([hide(["medication"], { tool: "get_health_summary" })]);

    const summary = await callTool(world.client, "get_health_summary");
    const medications = await callTool(world.client, "get_medications");

    expect(summary.text).not.toContain("Cetirizine 10 mg");
    expect(medications.text).toContain("Cetirizine 10 mg");
  });
});

describe("portal appointment items", () => {
  beforeEach(() => {
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [
      {
        visit: {
          csn: "csn-nested",
          start: new Date((NOW + 86_400) * 1000).toISOString(),
          timeZone: "UTC",
          visitType: "Follow-up",
          practitioner: "P. Example, MD",
          department: "Example Clinic",
          locationName: "Example Tower",
          address: "1 Example Way",
          phone: "555-0199",
          isVideo: false,
          status: "scheduled",
        },
        missing: false,
        fetchedAt: NOW,
      },
    ]);
  });

  it("removes the address lines inside a portal visit's location and keeps its name", async () => {
    world.state.rules = buildRules([
      hide(["location.address.lines"], { tool: "get_appointments" }),
    ]);

    const answer = await callTool(world.client, "get_appointments");
    const portal = answer.items.filter((item) => item.source === "portal");

    expect(portal).toHaveLength(1);
    expect(answer.text).not.toContain("1 Example Way");
    expect(answer.text).toContain("Example Tower");
  });
});

describe("get_document_text", () => {
  it("a rule on the document's text removes it and says so", async () => {
    world.state.rules = buildRules([hide(["text"], { tool: "get_document_text" })]);

    const answer = await callTool(world.client, "get_document_text", {
      healthSystem: HEALTH_SYSTEM_A,
      id: "doc-1",
    });

    expect(answer.isError).toBe(false);
    expect(answer.text).not.toContain("seasonal symptoms");
    expect(answer.items).toMatchObject([{ kind: "document_text", chars: 34 }]);
    expect(answer.warnings).toContain("policy_field_removed:*.text");
  });
});
