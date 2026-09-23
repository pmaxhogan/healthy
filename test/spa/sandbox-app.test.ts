// SandboxApp.vue: the sandboxed half of "Try a tool". It has no /api access and
// no parent app around it, so everything it does is driven by postMessage --
// tested here the same way, by dispatching `message` events on `globalThis` and
// reading `globalThis.parent.postMessage` calls back out. `JsonEditor`'s own
// typing mechanics are covered by json-editor.test.ts; here it is driven through
// its public contract (`update:modelValue`, `run`), the same seam SandboxApp
// itself is written against.

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import JsonEditor from "../../src/components/JsonEditor.vue";
import SandboxApp from "../../src/sandbox/SandboxApp.vue";

const TOOL_MESSAGE = {
  type: "tool",
  name: "get_document_text",
  description: "The text of one clinical note.",
  inputSchema: {
    type: "object",
    properties: {
      healthSystem: { type: "string", minLength: 1 },
      id: { type: "string", minLength: 1 },
    },
    required: ["healthSystem", "id"],
    additionalProperties: false,
  },
  skeleton: { healthSystem: "", id: "" },
};

const world: { postMessage: ReturnType<typeof vi.fn> } = { postMessage: vi.fn() };

beforeEach(() => {
  world.postMessage = vi.fn();
  vi.stubGlobal("parent", { postMessage: world.postMessage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Simulates the parent posting to this page, as only the real parent could. */
function sendFromParent(data: unknown): void {
  globalThis.dispatchEvent(new MessageEvent("message", { data, source: globalThis.parent }));
}

function editorOf(wrapper: ReturnType<typeof mount>) {
  return wrapper.findComponent(JsonEditor);
}

describe("SandboxApp", () => {
  it("announces itself ready as soon as it mounts", async () => {
    mount(SandboxApp);
    await flushPromises();

    expect(world.postMessage).toHaveBeenCalledWith({ type: "ready" }, "*");
  });

  it("shows a waiting message until a tool arrives", async () => {
    const wrapper = mount(SandboxApp);
    await flushPromises();

    expect(wrapper.text()).toContain("Waiting for a tool");
  });

  it("ignores a message whose source is not globalThis.parent", async () => {
    const wrapper = mount(SandboxApp);
    await flushPromises();

    globalThis.dispatchEvent(
      new MessageEvent("message", { data: TOOL_MESSAGE, source: globalThis as unknown as Window }),
    );
    await flushPromises();

    expect(wrapper.text()).toContain("Waiting for a tool");
  });

  it("loads a tool's description and skeleton, and disables Run while both required fields are blank", async () => {
    const wrapper = mount(SandboxApp);
    await flushPromises();

    sendFromParent(TOOL_MESSAGE);
    await flushPromises();

    expect(wrapper.text()).toContain("The text of one clinical note.");
    expect(wrapper.find("button.primary").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("too short");
  });

  it("enables Run once the frame's own edit satisfies the schema", async () => {
    const wrapper = mount(SandboxApp);
    await flushPromises();
    sendFromParent(TOOL_MESSAGE);
    await flushPromises();

    editorOf(wrapper).vm.$emit(
      "update:modelValue",
      JSON.stringify({ healthSystem: "prov-1", id: "doc-1" }),
    );
    await flushPromises();

    expect(wrapper.find("button.primary").attributes("disabled")).toBeUndefined();
  });

  it("disables Run again on invalid JSON, with a parse error shown", async () => {
    const wrapper = mount(SandboxApp);
    await flushPromises();
    sendFromParent(TOOL_MESSAGE);
    await flushPromises();

    editorOf(wrapper).vm.$emit("update:modelValue", "{ not json");
    await flushPromises();

    expect(wrapper.find("button.primary").attributes("disabled")).toBeDefined();
    expect(wrapper.text().toLowerCase()).toContain("json");
  });

  it("posts a run message on the editor's run event, with the parsed arguments", async () => {
    const wrapper = mount(SandboxApp);
    await flushPromises();
    sendFromParent(TOOL_MESSAGE);
    await flushPromises();
    editorOf(wrapper).vm.$emit(
      "update:modelValue",
      JSON.stringify({ healthSystem: "prov-1", id: "doc-1" }),
    );
    await flushPromises();

    editorOf(wrapper).vm.$emit("run");
    await flushPromises();

    expect(world.postMessage).toHaveBeenCalledWith(
      {
        type: "run",
        name: "get_document_text",
        arguments: { healthSystem: "prov-1", id: "doc-1" },
      },
      "*",
    );
    expect(wrapper.text()).toContain("Running");
  });

  it("renders the result once the parent posts one back", async () => {
    const wrapper = mount(SandboxApp);
    await flushPromises();
    sendFromParent(TOOL_MESSAGE);
    await flushPromises();
    editorOf(wrapper).vm.$emit(
      "update:modelValue",
      JSON.stringify({ healthSystem: "prov-1", id: "doc-1" }),
    );
    await flushPromises();
    editorOf(wrapper).vm.$emit("run");
    await flushPromises();

    sendFromParent({ type: "result", isError: false, data: { text: "hello" }, durationMs: 7 });
    await flushPromises();

    expect(wrapper.text()).toContain("ok");
    expect(wrapper.text()).toContain("7 ms");
    expect(wrapper.text()).toContain("hello");
  });

  it("renders a call-error and its issues", async () => {
    const wrapper = mount(SandboxApp);
    await flushPromises();
    sendFromParent(TOOL_MESSAGE);
    await flushPromises();
    editorOf(wrapper).vm.$emit(
      "update:modelValue",
      JSON.stringify({ healthSystem: "prov-1", id: "doc-1" }),
    );
    await flushPromises();
    editorOf(wrapper).vm.$emit("run");
    await flushPromises();

    sendFromParent({ type: "call-error", message: "no such MCP tool", issues: ["detail one"] });
    await flushPromises();

    expect(wrapper.text()).toContain("no such MCP tool");
    expect(wrapper.text()).toContain("detail one");
  });

  it("resets to the new tool's skeleton when the parent sends another", async () => {
    const wrapper = mount(SandboxApp);
    await flushPromises();
    sendFromParent(TOOL_MESSAGE);
    await flushPromises();
    editorOf(wrapper).vm.$emit("run");
    await flushPromises();

    sendFromParent({
      type: "tool",
      name: "list_health_systems",
      description: "The connected health systems.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      skeleton: {},
    });
    await flushPromises();

    expect(wrapper.text()).toContain("The connected health systems.");
    expect(wrapper.text()).not.toContain("Running");
    expect(wrapper.find("button.primary").attributes("disabled")).toBeUndefined();
  });
});
