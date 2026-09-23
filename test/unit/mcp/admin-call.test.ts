// worker/mcp/admin-call.ts -- the admin console's own door onto the tools.
//
// Not a second implementation to keep in sync: every assertion here is really
// asserting that this module hands the real `McpServer` the real `ToolDeps` and
// gets back exactly what a normal MCP client would. `test/unit/mcp/tools.test.ts`
// already proves the tools themselves are correct; this file proves the admin
// door onto them adds nothing and hides nothing.

import { describe, expect, it } from "vitest";

import {
  ADMIN_CALLER_CLIENT_ID,
  adminCaller,
  callMcpTool,
  listMcpTools,
} from "../../../worker/mcp/admin-call.ts";
import { TOOL_NAMES } from "../../../worker/mcp/tools/index.ts";
import { buildRules } from "../../../worker/policy/rules.ts";

import { fakeDeps, fakeState } from "./helpers.ts";

import type { PolicyRuleInput } from "../../../worker/policy/rules.ts";

const rules = (...input: PolicyRuleInput[]) => buildRules(input);

describe("adminCaller", () => {
  it("is never mistaken for an OAuth client or a grant", () => {
    expect(adminCaller()).toStrictEqual({ clientId: ADMIN_CALLER_CLIENT_ID, grantId: null });
  });
});

describe("listMcpTools", () => {
  it("names exactly the tools worker/mcp/tools/index.ts registers", async () => {
    const tools = await listMcpTools(fakeDeps(fakeState()));

    expect(new Set(tools.map((tool) => tool.name))).toStrictEqual(new Set(TOOL_NAMES));
  });

  it("gives every tool a description and an object input schema", async () => {
    const tools = await listMcpTools(fakeDeps(fakeState()));

    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  it("carries the real zod schema's required fields, e.g. get_document_text's two", async () => {
    const tools = await listMcpTools(fakeDeps(fakeState()));

    const documentText = tools.find((tool) => tool.name === "get_document_text");
    expect(documentText?.inputSchema.required).toStrictEqual(["provider", "id"]);

    const conditions = tools.find((tool) => tool.name === "get_conditions");
    expect(conditions?.inputSchema.required ?? []).toStrictEqual([]);
  });
});

describe("callMcpTool", () => {
  it("answers null for a name nothing registers, rather than the SDK's own error text", async () => {
    const result = await callMcpTool(fakeDeps(fakeState()), "not_a_real_tool", {});

    expect(result).toBeNull();
  });

  it("runs a real tool and writes exactly one real audit row for it", async () => {
    const state = fakeState();

    const result = await callMcpTool(fakeDeps(state), "get_conditions", {});

    expect(result?.isError).not.toBe(true);
    const first = result?.content[0];
    const text = first?.type === "text" ? first.text : "";
    const parsed = JSON.parse(text) as { items: unknown[] };
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ tool: "get_conditions", ok: true });
  });

  it("applies the exposure policy, exactly as a real MCP client would see it", async () => {
    const state = fakeState({ rules: rules({ rule_type: "tool", target: "get_conditions" }) });

    const result = await callMcpTool(fakeDeps(state), "get_conditions", {});

    expect(result?.isError).toBe(true);
    const first = result?.content[0];
    const text = first?.type === "text" ? first.text : "";
    expect(JSON.parse(text)).toMatchObject({ error: "policy_denied" });
    expect(state.audits[0]).toMatchObject({
      tool: "get_conditions",
      ok: false,
      errorCode: "policy_denied",
    });
  });

  it("rejects arguments the real input schema refuses, before the tool ever runs", async () => {
    const state = fakeState();

    const result = await callMcpTool(fakeDeps(state), "get_conditions", { limit: "ten" });

    expect(result?.isError).toBe(true);
    const first = result?.content[0];
    const text = first?.type === "text" ? first.text : "";
    // The SDK's own rejection sentence, not this server's `{ error, message }`
    // envelope -- proof the tool body never ran, which the empty audit trail
    // below confirms independently.
    expect(() => {
      JSON.parse(text);
    }).toThrow();
    expect(state.audits).toHaveLength(0);
  });
});
