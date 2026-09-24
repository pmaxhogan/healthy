// The MCP page's exposure policy: every rule listed as a sentence, grouped by
// what it applies to, with the tools it changes and an on/off switch -- and the
// one thing the page must never do quietly: list a rule that is not enforced.

import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import McpView from "../../src/views/McpView.vue";

import { fakeResponse, healthSystem, installFakeApi, settings, testRouter } from "./helpers.ts";
import { policyRule, testSchema } from "./policy-fixtures.ts";

import type { FakeFetch } from "./helpers.ts";
import type { PolicyRuleDto } from "@shared/types.ts";

async function mountMcp(
  rules: PolicyRuleDto[],
): Promise<{ wrapper: ReturnType<typeof mount>; api: FakeFetch }> {
  const api = installFakeApi({
    "/api/settings": () => fakeResponse({ body: settings() }),
    "/api/mcp/policy": () => fakeResponse({ body: rules }),
    "/api/mcp/policy/schema": () => fakeResponse({ body: testSchema() }),
    "/api/mcp/policy/*": () => fakeResponse({ body: rules[0] }),
    "/api/mcp/grants": () => fakeResponse({ body: [] }),
    "/api/mcp/audit": () => fakeResponse({ body: [] }),
    "/api/mcp/tools": () => fakeResponse({ body: [] }),
    "/api/mcp/tools/schema": () => fakeResponse({ body: [] }),
    "/api/health-systems": () => fakeResponse({ body: [healthSystem()] }),
  });
  const router = await testRouter("/connectors");
  const wrapper = mount(McpView, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, api };
}

describe("McpView policy rules", () => {
  it("lists each rule as a sentence under its group, with the tools it changes", async () => {
    const { wrapper } = await mountMcp([
      policyRule(),
      policyRule({ id: "rule-2", ruleType: "tool", target: "get_patient_profile", field: null }),
      policyRule({
        id: "rule-3",
        field: {
          effect: "hide",
          tool: null,
          resourceType: "CareTeam",
          healthSystemId: "prov-1",
          paths: ["participants[].role"],
        },
      }),
    ]);
    const text = wrapper.text();

    expect(text).toContain("Fields in get_care_team");
    expect(text).toContain("Hide participants → name in get_care_team at all health systems");
    expect(text).toContain("Blocked tools");
    expect(text).toContain("Block the tool get_patient_profile");
    expect(text).toContain("Fields on CareTeam");
    expect(text).toContain(
      "Hide participants → role on CareTeam items in every tool at Example Health",
    );
    expect(wrapper.find(".warn-text").exists()).toBe(false);
  });

  it("switches a rule off with PATCH, and shows it as off", async () => {
    const { wrapper, api } = await mountMcp([policyRule({ enabled: false })]);

    expect(wrapper.find('[data-test="rule"]').text()).toContain("off");
    await wrapper.find('[data-test="rule"] input[type="checkbox"]').setValue(true);
    await flushPromises();

    const patch = api.calls.find((call) => call.method === "PATCH");
    expect(patch?.url).toBe("/api/mcp/policy/rule-1");
    expect(JSON.parse(patch?.body ?? "{}")).toStrictEqual({ enabled: true });
  });

  it("asks before deleting, naming the rule, and deletes on confirm", async () => {
    const { wrapper, api } = await mountMcp([policyRule()]);

    await wrapper.find('[data-test="rule"] button.danger').trigger("click");
    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.text()).toContain("Delete this rule?");
    expect(dialog.text()).toContain("Hide participants → name in get_care_team");

    const confirm = dialog.findAll("button").find((button) => button.text() === "Delete rule");
    await confirm?.trigger("click");
    await flushPromises();

    expect(
      api.calls.some((call) => call.method === "DELETE" && call.url === "/api/mcp/policy/rule-1"),
    ).toBe(true);
  });

  it("warns on a rule the engine could not read, and names it", async () => {
    const { wrapper } = await mountMcp([
      policyRule(),
      policyRule({ id: "rule-2", target: "Patient", field: null, unparsed: true }),
    ]);
    const text = wrapper.text();

    expect(text).toContain("One rule below denies nothing");
    // The target itself, because that is what the owner has to go and fix.
    expect(text).toContain("could not read Patient.");
    expect(text).toContain("not enforced");
    // The rule that is fine is not flagged: one badge, on one row.
    expect(wrapper.findAll('[data-test="rule"] .warn-text')).toHaveLength(1);
  });
});
