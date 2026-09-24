// The rule builder, mounted: the tree picker, search, picking several fields
// into one rule, the live preview with removed keys highlighted, and what is
// sent on save. The API is faked; every value is synthetic.

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PolicyRuleBuilder from "../../src/components/PolicyRuleBuilder.vue";

import { fakeResponse, healthSystem, installFakeApi } from "./helpers.ts";
import { policyRule, testSchema } from "./policy-fixtures.ts";

import type { FakeFetch } from "./helpers.ts";
import type { PolicyPreviewDto, PolicyToolPreviewDto } from "@shared/types.ts";

const careTeamPreview: PolicyToolPreviewDto = {
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

/** A tool preview; `affected: 0` is a tool the draft reaches but changes nothing in. */
function toolPreview(tool: string, affected: number, total = 10): PolicyToolPreviewDto {
  return {
    tool,
    total,
    affected,
    sample: { before: { tool, name: "x" }, after: affected > 0 ? { tool } : { tool, name: "x" } },
    warnings: [],
    synthetic: false,
  };
}

const world: { api: FakeFetch; preview: PolicyPreviewDto } = {
  api: undefined as unknown as FakeFetch,
  preview: { tools: [careTeamPreview] },
};

function routes(overrides: Record<string, () => Response> = {}): Record<string, () => Response> {
  return {
    "/api/mcp/policy/preview": () => fakeResponse({ body: world.preview }),
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
  world.preview = { tools: [careTeamPreview] };
  world.api = installFakeApi(routes());
});

/** Let the debounced preview run and its answer render. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(600);
  await flushPromises();
}

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

    // One request for every tool in scope: no per-tool round trips.
    const previewCalls = world.api.calls.filter((call) => call.url === "/api/mcp/policy/preview");
    expect(previewCalls).toHaveLength(1);
    expect(JSON.parse(previewCalls[0]?.body ?? "{}")).toStrictEqual({
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

/** Mount with every-tool scope and one field picked, and let the preview land. */
async function drafted(): Promise<ReturnType<typeof mount>> {
  const wrapper = mountBuilder();
  await wrapper.find('[data-test="raw-path"]').setValue("name");
  await wrapper.find('[data-test="raw-path"]').trigger("keydown", { key: "Enter" });
  await settle();
  return wrapper;
}

function options(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('[data-test="preview-tool"] option').map((option) => option.text());
}

function selected(wrapper: ReturnType<typeof mount>): string {
  return (wrapper.find('[data-test="preview-tool"]').element as HTMLSelectElement).value;
}

/** Change the draft, so the preview is recomputed with `next` as its answer. */
async function redraft(
  wrapper: ReturnType<typeof mount>,
  next: PolicyPreviewDto,
  path: string,
): Promise<void> {
  world.preview = next;
  await wrapper.find('[data-test="raw-path"]').setValue(path);
  await wrapper.find('[data-test="raw-path"]').trigger("keydown", { key: "Enter" });
  await settle();
}

describe("the preview's tool choice", () => {
  it("lists only the tools the draft changes, each with its count", async () => {
    world.preview = {
      tools: [
        toolPreview("get_health_summary", 0, 40),
        toolPreview("get_appointments", 7, 106),
        toolPreview("get_encounters", 1, 1),
      ],
    };
    const wrapper = await drafted();

    expect(options(wrapper)).toStrictEqual([
      "get_appointments — 7 of 106 items change",
      "get_encounters — 1 of 1 item changes",
    ]);
    expect(selected(wrapper)).toBe("get_appointments");
    expect(wrapper.find('[data-test="policy-preview"]').text()).toContain(
      "Changes 7 of the 106 items get_appointments returns",
    );
  });

  it("shows an empty state, with the reason, when nothing changes", async () => {
    world.preview = {
      tools: [toolPreview("get_care_team", 0, 3), toolPreview("get_patient_profile", 0, 2)],
    };
    const wrapper = await drafted();

    expect(wrapper.find('[data-test="preview-tool"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="policy-preview"]').exists()).toBe(false);
    const empty = wrapper.find('[data-test="preview-empty"]').text();
    expect(empty).toContain("This rule doesn't change anything in your current data.");
    expect(empty).toContain("None of the 5 items from the 2 tools it reaches has name");
    expect(empty).toContain("isn't in your cached data");
  });

  it("moves the selection when the selected tool drops out, and never shows its diff", async () => {
    world.preview = {
      tools: [toolPreview("get_appointments", 7, 106), toolPreview("get_encounters", 3, 104)],
    };
    const wrapper = await drafted();
    await wrapper.find('[data-test="preview-tool"]').setValue("get_encounters");
    expect(selected(wrapper)).toBe("get_encounters");

    await redraft(
      wrapper,
      { tools: [toolPreview("get_appointments", 2, 106), toolPreview("get_encounters", 0, 104)] },
      "status",
    );

    expect(options(wrapper)).toStrictEqual(["get_appointments — 2 of 106 items change"]);
    expect(selected(wrapper)).toBe("get_appointments");
    expect(wrapper.find('[data-test="policy-preview"]').text()).not.toContain("get_encounters");

    await redraft(wrapper, { tools: [toolPreview("get_appointments", 0, 106)] }, "end");

    expect(wrapper.find('[data-test="preview-tool"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="policy-preview"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="preview-empty"]').exists()).toBe(true);
  });

  it("keeps the selection while the selected tool still qualifies", async () => {
    world.preview = {
      tools: [toolPreview("get_appointments", 7, 106), toolPreview("get_encounters", 3, 104)],
    };
    const wrapper = await drafted();
    await wrapper.find('[data-test="preview-tool"]').setValue("get_encounters");

    await redraft(
      wrapper,
      { tools: [toolPreview("get_appointments", 9, 106), toolPreview("get_encounters", 5, 104)] },
      "status",
    );

    expect(selected(wrapper)).toBe("get_encounters");
    expect(options(wrapper)).toContain("get_encounters — 5 of 104 items change");
  });
});
