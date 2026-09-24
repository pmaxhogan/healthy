// McpToolTester.vue: the parent side of "Try a tool". It fetches the tool
// list, embeds the sandboxed iframe, and is the ONLY thing on this side of the
// boundary that may call /api -- so what is worth pinning here is the
// postMessage traffic (both directions), not the argument editor or the JSON
// viewers, which now live inside the sandbox (see json-editor.test.ts,
// json-viewer.test.ts and sandbox-app.test.ts).
//
// happy-dom's <iframe> never really navigates, so `contentWindow` is always
// `null` -- which would make every `event.source` check pass by coincidence and
// prove nothing. `HTMLIFrameElement.prototype.contentWindow` is patched for
// the length of this file to a fake window with a spyable `postMessage`, so the
// identity check in McpToolTester.vue is exercised the way it is meant to be:
// a message from that exact object passes, a message from anywhere else does
// not.

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MCP_SANDBOX_PATH } from "@shared/mcp-sandbox.ts";

import { endpoints } from "../../src/api/endpoints.ts";
import McpToolTester from "../../src/components/McpToolTester.vue";

import { fakeResponse, installFakeApi } from "./helpers.ts";

import type { McpToolCallResponse, McpToolSchemaDto } from "@shared/types.ts";

const TOOLS: McpToolSchemaDto[] = [
  {
    name: "list_health_systems",
    description: "The connected health systems and what each one exposes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_document_text",
    description: "The text of one clinical note.",
    inputSchema: {
      type: "object",
      properties: { healthSystem: { type: "string" }, id: { type: "string" } },
      required: ["healthSystem", "id"],
      additionalProperties: false,
    },
  },
];

/**
 * Everything one test needs reset per run, held in one object rather than
 * several top-level `let`s that `beforeEach`/`afterEach` would have to
 * reassign (this project's tests use a holder for exactly that reason; see
 * test/unit/mcp/tools.test.ts's own comment on the same pattern).
 *
 * `mounted` matters beyond tidiness: `onMounted` adds a real
 * `window.addEventListener("message", ...)`, and happy-dom's `window` is
 * shared across the tests in this file -- an un-unmounted wrapper from an
 * earlier test keeps answering `sendFromFrame` calls in every test after it,
 * which is indistinguishable from a real bug until it silently inflates the
 * call count of a later test's assertions.
 */
const world: {
  contentWindow: { postMessage: ReturnType<typeof vi.fn> };
  originalDescriptor: PropertyDescriptor | undefined;
  mounted: ReturnType<typeof mount>[];
} = {
  contentWindow: { postMessage: vi.fn() },
  originalDescriptor: undefined,
  mounted: [],
};

beforeEach(() => {
  world.contentWindow = { postMessage: vi.fn() };
  world.originalDescriptor = Object.getOwnPropertyDescriptor(
    HTMLIFrameElement.prototype,
    "contentWindow",
  );
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get: () => world.contentWindow,
  });
  world.mounted = [];
});

afterEach(() => {
  for (const wrapper of world.mounted) wrapper.unmount();
  if (world.originalDescriptor) {
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", world.originalDescriptor);
  }
});

function mountTester(routes: Record<string, () => Response> = {}): ReturnType<typeof mount> {
  installFakeApi({ "/api/mcp/tools/schema": () => fakeResponse({ body: TOOLS }), ...routes });
  const wrapper = mount(McpToolTester);
  world.mounted.push(wrapper);
  return wrapper;
}

/** Simulates the frame answering, as only the real frame's window could. */
function sendFromFrame(data: unknown): void {
  globalThis.dispatchEvent(
    new MessageEvent("message", { data, source: world.contentWindow as unknown as Window }),
  );
}

describe("McpToolTester", () => {
  it("embeds the sandboxed page with no allow-same-origin", async () => {
    const wrapper = mountTester();
    await flushPromises();

    const iframe = wrapper.find("iframe");
    expect(iframe.attributes("src")).toBe(MCP_SANDBOX_PATH);
    expect(iframe.attributes("sandbox")).toBe("allow-scripts");
  });

  it("posts the selected tool to the frame once it says it is ready", async () => {
    mountTester();
    await flushPromises();

    sendFromFrame({ type: "ready" });
    await flushPromises();

    expect(world.contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool", name: "list_health_systems", skeleton: {} }),
      "*",
    );
  });

  it("ignores a message whose source is not the frame's own contentWindow", async () => {
    mountTester();
    await flushPromises();

    globalThis.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "ready" },
        source: globalThis as unknown as Window,
      }),
    );
    await flushPromises();

    expect(world.contentWindow.postMessage).not.toHaveBeenCalled();
  });

  it("ignores a message with a name this version does not recognise", async () => {
    mountTester();
    await flushPromises();

    sendFromFrame({ type: "not-a-real-message" });
    await flushPromises();

    expect(world.contentWindow.postMessage).not.toHaveBeenCalled();
  });

  it("ignores a run whose arguments are not a plain object", async () => {
    mountTester();
    await flushPromises();
    sendFromFrame({ type: "ready" });
    await flushPromises();
    world.contentWindow.postMessage.mockClear();

    sendFromFrame({ type: "run", name: "list_health_systems", arguments: "not an object" });
    await flushPromises();

    expect(world.contentWindow.postMessage).not.toHaveBeenCalled();
  });

  it("re-sends the newly selected tool's schema when the picker changes", async () => {
    const wrapper = mountTester();
    await flushPromises();
    sendFromFrame({ type: "ready" });
    await flushPromises();
    world.contentWindow.postMessage.mockClear();

    await wrapper.find("select").setValue("get_document_text");
    await flushPromises();

    expect(world.contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool",
        name: "get_document_text",
        skeleton: { healthSystem: "", id: "" },
      }),
      "*",
    );
  });

  it("runs a real tool and posts the exact result back to the frame", async () => {
    const response: McpToolCallResponse = {
      request: { name: "list_health_systems", arguments: {} },
      result: { isError: false, data: { items: [] } },
      durationMs: 12,
    };
    mountTester({
      "/api/mcp/tools/list_health_systems/call": () => fakeResponse({ body: response }),
    });
    await flushPromises();
    sendFromFrame({ type: "ready" });
    await flushPromises();

    sendFromFrame({ type: "run", name: "list_health_systems", arguments: {} });
    await flushPromises();

    expect(world.contentWindow.postMessage).toHaveBeenCalledWith(
      { type: "result", isError: false, data: { items: [] }, durationMs: 12 },
      "*",
    );
  });

  it("posts a call-error with the server's structured issues when the call is rejected", async () => {
    mountTester({
      "/api/mcp/tools/list_health_systems/call": () =>
        fakeResponse({
          status: 400,
          body: {
            error: "bad_request",
            message: "the arguments did not match the tool's input schema",
            details: { issues: ["boom"] },
          },
        }),
    });
    await flushPromises();
    sendFromFrame({ type: "ready" });
    await flushPromises();

    sendFromFrame({ type: "run", name: "list_health_systems", arguments: {} });
    await flushPromises();

    expect(world.contentWindow.postMessage).toHaveBeenCalledWith(
      {
        type: "call-error",
        message: "the arguments did not match the tool's input schema",
        issues: ["boom"],
      },
      "*",
    );
  });

  it("sizes the iframe to the frame's reported height, clamped to a sensible range", async () => {
    const wrapper = mountTester();
    await flushPromises();

    sendFromFrame({ type: "resize", height: 500 });
    await flushPromises();
    expect(wrapper.find("iframe").attributes("style")).toContain("height: 500px");

    sendFromFrame({ type: "resize", height: 10 });
    await flushPromises();
    expect(wrapper.find("iframe").attributes("style")).toContain("height: 240px");

    sendFromFrame({ type: "resize", height: 5000 });
    await flushPromises();
    expect(wrapper.find("iframe").attributes("style")).toContain("height: 1000px");
  });

  it("scrolls the frame into view on the resize that follows a run's result", async () => {
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockReturnValue(undefined);
    mountTester({
      "/api/mcp/tools/list_health_systems/call": () =>
        fakeResponse({
          body: { request: {}, result: { isError: false, data: {} }, durationMs: 1 },
        }),
    });
    await flushPromises();
    sendFromFrame({ type: "ready" });
    await flushPromises();

    // A resize with no run behind it at all -- e.g. the editor growing as the
    // owner types -- must not yank the page down to the frame.
    sendFromFrame({ type: "resize", height: 300 });
    await flushPromises();
    expect(scrollSpy).not.toHaveBeenCalled();

    sendFromFrame({ type: "run", name: "list_health_systems", arguments: {} });
    await flushPromises();
    // SandboxApp.vue would send this once it has rendered the result; the
    // frame stub here just needs to send it back to exercise the parent's own
    // side of that contract.
    sendFromFrame({ type: "resize", height: 450 });
    await flushPromises();

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });

    scrollSpy.mockClear();
    sendFromFrame({ type: "resize", height: 460 });
    await flushPromises();
    // Consumed by the resize right after the run -- a later one (the editor
    // moving again) is an unrelated event and must not scroll again.
    expect(scrollSpy).not.toHaveBeenCalled();

    scrollSpy.mockRestore();
  });

  it("drops a result for a tool the owner has since switched away from", async () => {
    // The fake API layer resolves synchronously, which leaves no window to
    // switch tools before the fetch settles. Controlling `endpoints.callMcpTool`
    // directly gives the test exactly that window.
    const { promise: pending, resolve: resolveCall } = Promise.withResolvers<McpToolCallResponse>();
    const callSpy = vi.spyOn(endpoints, "callMcpTool").mockReturnValue(pending);

    const wrapper = mountTester();
    await flushPromises();
    sendFromFrame({ type: "ready" });
    await flushPromises();

    sendFromFrame({ type: "run", name: "list_health_systems", arguments: {} });
    await flushPromises();
    await wrapper.find("select").setValue("get_document_text");
    await flushPromises();
    world.contentWindow.postMessage.mockClear();

    resolveCall({
      request: { name: "list_health_systems", arguments: {} },
      result: { isError: false, data: {} },
      durationMs: 1,
    });
    await flushPromises();

    expect(world.contentWindow.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "result" }),
      "*",
    );
    callSpy.mockRestore();
  });
});
