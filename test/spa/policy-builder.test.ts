// The rule builder, mounted: the tree picker, search, picking several fields
// into one rule, the live preview with removed keys highlighted, and what is
// sent on save. The API is faked; every value is synthetic.

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PolicyRuleBuilder from "../../src/components/PolicyRuleBuilder.vue";

import { fakeResponse, healthSystem, installFakeApi } from "./helpers.ts";
import { policyRule, testSchema } from "./policy-fixtures.ts";

import type { FakeFetch } from "./helpers.ts";
import type { PolicyPreviewDto } from "@shared/types.ts";

const preview: PolicyPreviewDto = {
  tool: "get_care_team",
  total: 3,
  affected: 2,
  sample: {
    before: { id: "ct-1", participants: [{ name: "Alpha Example", role: "Primary care" }] },
    after: { id: "ct-1", participants: [{ role: "Primary care" }] },
    rawBefore: {
      resourceType: "CareTeam",
      participant: [{ member: { display: "Alpha Example" } }],
    },
    rawAfter: { resourceType: "CareTeam", participant: [{ member: {} }] },
  },
  warnings: ["policy_field_removed:*.participants[].name"],
  synthetic: false,
};

const world: { api: FakeFetch } = { api: undefined as unknown as FakeFetch };

function routes(overrides: Record<string, () => Response> = {}): Record<string, () => Response> {
  return {
    "/api/mcp/policy/preview": () => fakeResponse({ body: preview }),
    "/api/mcp/policy/structure": () =>
      fakeResponse({
        body: {
          tool: "get_care_team",
          items: 1,
          item: [{ name: "participants", array: true, children: [{ name: "name" }] }],
          raw: [],
        },
      }),
    "/api/mcp/policy": () => fakeResponse({ status: 201, body: policyRule() }),
    ...overrides,
  };
}

function mountBuilder(props: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(PolicyRuleBuilder, {
    props: {
      schema: testSchema(),
      tools: [
        { name: "get_care_team", description: "The care team.", resourceTypes: ["CareTeam"] },
      ],
      healthSystems: [healthSystem()],
      ...props,
    },
    attachTo: document.body,
  });
}

async function chooseTool(wrapper: ReturnType<typeof mount>, tool: string): Promise<void> {
  await wrapper.find('input[type="radio"][value="tool"]').setValue(true);
  await wrapper.find('[data-test="scope-tool"]').setValue(tool);
  await flushPromises();
}

function checkbox(wrapper: ReturnType<typeof mount>, path: string) {
  return wrapper.find(`input[type="checkbox"][data-path="${path}"]`);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  world.api = installFakeApi(routes());
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("PolicyRuleBuilder", () => {
  it("shows the scope's shapes as a tree, and opens a list to pick inside it", async () => {
    const wrapper = mountBuilder();
    await chooseTool(wrapper, "get_care_team");

    const groupHeads = wrapper.findAll(".group-head").map((head) => head.text());
    expect(groupHeads[0]).toContain("CareTeam item");
    expect(groupHeads[1]).toContain("Raw FHIR CareTeam");

    await wrapper.findAll(".group-head")[0]!.trigger("click");
    expect(checkbox(wrapper, "participants").exists()).toBe(true);
    expect(checkbox(wrapper, "participants[].name").exists()).toBe(false);

    await wrapper.find('button[aria-label="Expand participants"]').trigger("click");
    expect(checkbox(wrapper, "participants[].name").exists()).toBe(true);
    expect(wrapper.text()).toContain("list");
  });

  it("finds a nested field by search, across every group", async () => {
    const wrapper = mountBuilder();
    await chooseTool(wrapper, "get_care_team");

    await wrapper.find('[data-test="field-search"]').setValue("display");

    expect(checkbox(wrapper, "participant[].member.display").exists()).toBe(true);
    expect(checkbox(wrapper, "participants").exists()).toBe(false);
  });

  it("picks several fields into one rule, previews it, and saves it as one rule", async () => {
    const wrapper = mountBuilder();
    await chooseTool(wrapper, "get_care_team");
    await wrapper.find('[data-test="field-search"]').setValue("name");
    await checkbox(wrapper, "participants[].name").setValue(true);
    await checkbox(wrapper, "name").setValue(true);

    const picked = wrapper.find('[data-test="picked"]').text();
    expect(picked).toContain("participants → name");
    expect(picked).toContain("name");
    expect(wrapper.find('[data-test="draft-sentence"]').text()).toBe(
      "Hide participants → name and name in get_care_team at all health systems",
    );

    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();

    const previewCall = world.api.calls.find((call) => call.url === "/api/mcp/policy/preview");
    expect(JSON.parse(previewCall?.body ?? "{}")).toStrictEqual({
      tool: "get_care_team",
      field: {
        effect: "hide",
        tool: "get_care_team",
        resourceType: null,
        healthSystemId: null,
        paths: ["participants[].name", "name"],
      },
    });
    const shown = wrapper.find('[data-test="policy-preview"]');
    expect(shown.text()).toContain("Changes 2 of the 3 items get_care_team returns");
    const struck = shown.findAll(".line.gone").map((line) => line.text().trim());
    expect(struck).toStrictEqual(['"name": "Alpha Example",']);

    await wrapper.find("form").trigger("submit");
    await flushPromises();

    const saveCall = world.api.calls.find(
      (call) => call.url === "/api/mcp/policy" && call.method === "POST",
    );
    expect(JSON.parse(saveCall?.body ?? "{}")).toStrictEqual({
      ruleType: "field",
      field: {
        effect: "hide",
        tool: "get_care_team",
        resourceType: null,
        healthSystemId: null,
        paths: ["participants[].name", "name"],
      },
    });
    expect(wrapper.emitted("saved")).toHaveLength(1);
  });

  it("shows the raw FHIR before and after on its own tab", async () => {
    const wrapper = mountBuilder();
    await chooseTool(wrapper, "get_care_team");
    await wrapper.find('[data-test="field-search"]').setValue("name");
    await checkbox(wrapper, "participants[].name").setValue(true);
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();

    await wrapper.find('button[role="tab"]:nth-of-type(2)').trigger("click");

    const struck = wrapper.findAll(".line.gone").map((line) => line.text().trim());
    expect(struck).toStrictEqual(['"display": "Alpha Example"']);
  });

  it("adds a typed path, canonicalized, and refuses one that is not a path", async () => {
    const wrapper = mountBuilder();
    await chooseTool(wrapper, "get_care_team");

    await wrapper.find('[data-test="raw-path"]').setValue("participant.[].member.display");
    await wrapper.find('[data-test="raw-path"]').trigger("keydown", { key: "Enter" });
    expect(wrapper.find('[data-test="picked"]').text()).toContain("participant → member → display");

    await wrapper.find('[data-test="raw-path"]').setValue("a..b");
    await wrapper.find('[data-test="raw-path"]').trigger("keydown", { key: "Enter" });
    expect(wrapper.text()).toContain("That is not a path");
  });

  it("shows the Worker's reasons inline when it refuses the draft", async () => {
    world.api = installFakeApi(
      routes({
        "/api/mcp/policy/preview": () =>
          fakeResponse({
            status: 400,
            body: {
              error: "bad_request",
              message: "x",
              details: { problems: ['"nmae" matches nothing. Did you mean "name"?'] },
            },
          }),
      }),
    );
    const wrapper = mountBuilder();
    await chooseTool(wrapper, "get_care_team");
    await wrapper.find('[data-test="raw-path"]').setValue("participants[].nmae");
    await wrapper.find('[data-test="raw-path"]').trigger("keydown", { key: "Enter" });
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();

    expect(wrapper.find('[data-test="problems"]').text()).toContain('Did you mean "name"?');
  });

  it("loads a rule for editing and saves it with PATCH", async () => {
    world.api = installFakeApi(
      routes({ "/api/mcp/policy/rule-1": () => fakeResponse({ body: policyRule() }) }),
    );
    const wrapper = mountBuilder({ editing: policyRule({ note: "names stay home" }) });
    await flushPromises();

    expect(wrapper.find('[data-test="picked"]').text()).toContain("participants → name");
    expect(wrapper.find('[data-test="save"]').text()).toBe("Save changes");

    await wrapper.find("form").trigger("submit");
    await flushPromises();

    const patch = world.api.calls.find((call) => call.method === "PATCH");
    expect(patch?.url).toBe("/api/mcp/policy/rule-1");
    expect(JSON.parse(patch?.body ?? "{}")).toMatchObject({
      note: "names stay home",
      field: { tool: "get_care_team", paths: ["participants[].name"] },
    });
  });

  it("in allow mode, only a field withheld by default can be picked", async () => {
    const wrapper = mountBuilder();
    await wrapper.findAll('button[role="radio"]').at(4)!.trigger("click");
    await wrapper.find('input[type="radio"][value="resource"]').setValue(true);
    await wrapper.find('[data-test="scope-resource"]').setValue("Patient");
    await flushPromises();

    expect(checkbox(wrapper, "birthDate").attributes("disabled")).toBeUndefined();
    expect(checkbox(wrapper, "name").attributes("disabled")).toBeDefined();
  });

  it("builds the simple kinds from a list", async () => {
    const wrapper = mountBuilder();
    await wrapper.findAll('button[role="radio"]').at(1)!.trigger("click");
    await wrapper.find('[data-test="target"]').setValue("get_patient_profile");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    const saveCall = world.api.calls.find(
      (call) => call.method === "POST" && call.url === "/api/mcp/policy",
    );
    expect(JSON.parse(saveCall?.body ?? "{}")).toStrictEqual({
      ruleType: "tool",
      target: "get_patient_profile",
    });
  });
});
