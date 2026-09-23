// The "Try a tool" panel: the argument editor's live validation (parse errors,
// schema errors, Run disabled while invalid) and the Ctrl/Cmd+Enter shortcut.
// The read-only JSON viewer's own behaviour (fold/expand, search, copy) is
// covered by test/spa/json-viewer.test.ts; this file only checks that a result
// makes it onto the page at all once a call succeeds or fails.

import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import McpToolTester from "../../src/components/McpToolTester.vue";

import { fakeResponse, installFakeApi } from "./helpers.ts";

import type { McpToolCallResponse, McpToolSchemaDto } from "@shared/types.ts";

const TOOLS: McpToolSchemaDto[] = [
  {
    name: "list_providers",
    description: "The connected health systems and what each one exposes.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
  },
  {
    name: "get_document_text",
    description: "The text of one clinical note.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", minLength: 1 },
        id: { type: "string", minLength: 1 },
      },
      required: ["provider", "id"],
      additionalProperties: false,
    },
  },
];

function mountTester(routes: Record<string, () => Response> = {}): ReturnType<typeof mount> {
  installFakeApi({ "/api/mcp/tools/schema": () => fakeResponse({ body: TOOLS }), ...routes });
  return mount(McpToolTester);
}

/** Waits out both the schema load and the lazily-imported JsonViewer chunk. */
async function settle(): Promise<void> {
  await flushPromises();
  await flushPromises();
  await flushPromises();
}

describe("McpToolTester argument validation", () => {
  it("picks the first tool and starts valid with its empty skeleton", async () => {
    const wrapper = mountTester();
    await settle();

    expect((wrapper.find("select").element as HTMLSelectElement).value).toBe("list_providers");
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value.trim()).toBe("{}");
    expect(wrapper.find("button.primary").attributes("disabled")).toBeUndefined();
  });

  it("prefills a skeleton of the required fields when a tool needs them, and disables Run", async () => {
    const wrapper = mountTester();
    await settle();

    await wrapper.find("select").setValue("get_document_text");
    await settle();

    const textarea = wrapper.find("textarea").element as HTMLTextAreaElement;
    const skeleton = JSON.parse(textarea.value) as Record<string, unknown>;
    expect(skeleton).toStrictEqual({ provider: "", id: "" });
    // Both required strings are still empty, which minLength: 1 refuses.
    expect(wrapper.find("button.primary").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("too short");
  });

  it("shows a parse error and disables Run for invalid JSON", async () => {
    const wrapper = mountTester();
    await settle();

    await wrapper.find("textarea").setValue("{ not json");
    await settle();

    expect(wrapper.find("button.primary").attributes("disabled")).toBeDefined();
    expect(wrapper.text().toLowerCase()).toContain("json");
  });

  it("re-enables Run once the arguments satisfy the schema", async () => {
    const wrapper = mountTester();
    await settle();
    await wrapper.find("select").setValue("get_document_text");
    await settle();

    await wrapper.find("textarea").setValue(JSON.stringify({ provider: "prov-1", id: "doc-1" }));
    await settle();

    expect(wrapper.find("button.primary").attributes("disabled")).toBeUndefined();
  });
});

describe("McpToolTester running a call", () => {
  it("runs on Ctrl+Enter and renders the request and result once it lands", async () => {
    const response: McpToolCallResponse = {
      request: { name: "list_providers", arguments: {} },
      result: { isError: false, data: { items: [], warnings: [], truncated: false } },
      durationMs: 4,
    };
    const wrapper = mountTester({
      "/api/mcp/tools/list_providers/call": () => fakeResponse({ body: response }),
    });
    await settle();

    await wrapper.find("textarea").trigger("keydown", { key: "Enter", ctrlKey: true });
    await settle();
    await settle();

    expect(wrapper.text()).toContain("Request");
    expect(wrapper.text()).toContain("Result");
    expect(wrapper.text()).not.toContain("error");
  });

  it("shows the server's structured issues when the call itself is rejected", async () => {
    const wrapper = mountTester({
      "/api/mcp/tools/list_providers/call": () =>
        fakeResponse({
          status: 400,
          body: {
            error: "bad_request",
            message: "the arguments did not match the tool's input schema",
            details: { issues: ["Input validation error: bad limit"] },
          },
        }),
    });
    await settle();

    await wrapper.find("button.primary").trigger("click");
    await settle();
    await settle();

    expect(wrapper.text()).toContain("Input validation error: bad limit");
  });
});
