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

/**
 * happy-dom has no `ResizeObserver` at all, which SandboxApp.vue already
 * tolerates (it skips observing rather than throwing) -- exercising the
 * `resize` message it posts needs a real, if fake, implementation whose
 * callback the test can trigger itself, the same way the real browser would
 * once the observed element's box actually changed size.
 *
 * CodeMirror's own `EditorView` (inside `JsonEditor`) constructs a couple of
 * `ResizeObserver`s of its own the moment a global constructor exists to call,
 * entirely unrelated to the one SandboxApp.vue sets up on its own root -- so
 * `instances` is not "the" observer, and a test finds the right one by the
 * element it is watching (`observerFor`), the same way the browser would
 * dispatch a real resize to whichever observer registered for that element.
 */
class FakeResizeObserver {
  static readonly instances: FakeResizeObserver[] = [];
  readonly callback: ResizeObserverCallback;
  readonly targets: Element[] = [];
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  // Neither is exercised: SandboxApp.vue never calls `unobserve`, and its
  // `disconnect` call on unmount needs nothing behind it for these tests.
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- a fake only needs to satisfy the ResizeObserver shape, not do anything.
  unobserve(): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- see unobserve above.
  disconnect(): void {}
  /** Simulates the browser noticing the observed element's box changed. */
  fire(): void {
    this.callback([], this);
  }
}

/** The fake instance actually watching `element`, as only the real browser's dispatch would pick out. */
function observerFor(element: Element): FakeResizeObserver {
  const found = FakeResizeObserver.instances.find((instance) => instance.targets.includes(element));
  if (found === undefined) throw new Error("no ResizeObserver is watching this element");
  return found;
}

const world: { postMessage: ReturnType<typeof vi.fn> } = { postMessage: vi.fn() };

beforeEach(() => {
  world.postMessage = vi.fn();
  vi.stubGlobal("parent", { postMessage: world.postMessage });
  FakeResizeObserver.instances.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
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

  it("reports its height to the parent when its root element resizes", async () => {
    const wrapper = mount(SandboxApp);
    await flushPromises();
    world.postMessage.mockClear();

    observerFor(wrapper.find(".sandbox").element).fire();

    expect(world.postMessage).toHaveBeenCalledWith(
      { type: "resize", height: expect.any(Number) },
      "*",
    );
  });

  it("reserves extra room, and reports again, while the completion popup is open", async () => {
    const wrapper = mount(SandboxApp);
    await flushPromises();
    sendFromParent(TOOL_MESSAGE);
    await flushPromises();
    world.postMessage.mockClear();

    editorOf(wrapper).vm.$emit("completion-open", true);
    await flushPromises();

    expect(wrapper.find(".completion-reserve").exists()).toBe(true);
    // The reserve element is in-flow, so the same ResizeObserver that already
    // covers ordinary content growth (see the mock's docs) sees it too --
    // simulated here exactly like the plain-resize test above.
    observerFor(wrapper.find(".sandbox").element).fire();
    expect(world.postMessage).toHaveBeenCalledWith(
      { type: "resize", height: expect.any(Number) },
      "*",
    );

    editorOf(wrapper).vm.$emit("completion-open", false);
    await flushPromises();

    expect(wrapper.find(".completion-reserve").exists()).toBe(false);
  });
});
