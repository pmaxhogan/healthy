// The one thing the MCP page must never do quietly: list a policy rule that is
// not being enforced.
//
// A rule whose target the policy engine cannot parse is stored and listed like any
// other, so the row alone tells the owner that an exposure is denied when it is
// not. `GET /api/mcp/policy` reports `unparsed` per rule and this is the assertion
// that the page acts on it.

import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import McpView from "../../src/views/McpView.vue";

import { fakeResponse, installFakeApi, settings, testRouter } from "./helpers.ts";

import type { PolicyRuleDto } from "@shared/types.ts";

function rule(overrides: Partial<PolicyRuleDto> = {}): PolicyRuleDto {
  return {
    id: "rule-1",
    ruleType: "field",
    target: "Patient.telecom",
    note: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    unparsed: false,
    ...overrides,
  };
}

async function mountMcp(rules: PolicyRuleDto[]): Promise<ReturnType<typeof mount>> {
  installFakeApi({
    "/api/settings": () => fakeResponse({ body: settings() }),
    "/api/mcp/policy": () => fakeResponse({ body: rules }),
    "/api/mcp/grants": () => fakeResponse({ body: [] }),
    "/api/mcp/audit": () => fakeResponse({ body: [] }),
    "/api/mcp/tools": () => fakeResponse({ body: [] }),
    "/api/providers": () => fakeResponse({ body: [] }),
  });
  const router = await testRouter("/connectors");
  const wrapper = mount(McpView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

describe("McpView policy rules", () => {
  it("says nothing extra when every rule parses", async () => {
    const wrapper = await mountMcp([rule()]);

    expect(wrapper.text()).toContain("Patient.telecom");
    expect(wrapper.text()).not.toContain("not enforced");
    expect(wrapper.find(".warn-text").exists()).toBe(false);
  });

  it("warns on a rule the engine could not read, and names it", async () => {
    const wrapper = await mountMcp([
      rule(),
      rule({ id: "rule-2", target: "Patient", unparsed: true }),
    ]);
    const text = wrapper.text();

    expect(text).toContain("One rule below denies nothing");
    // The target itself, because that is what the owner has to go and fix.
    expect(text).toContain("could not read Patient.");
    expect(text).toContain("not enforced");
    // The rule that is fine is not flagged: one badge, on one row.
    expect(wrapper.findAll("tbody tr .warn-text")).toHaveLength(1);
  });
});
