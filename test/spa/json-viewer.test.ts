import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import JsonViewer from "../../src/components/JsonViewer.vue";

const NESTED = { a: { b: { c: 1 } }, d: [1, 2, 3] };

describe("JsonViewer", () => {
  it("mounts and renders the pretty-printed JSON text", async () => {
    const wrapper = mount(JsonViewer, { props: { value: { hello: "world", n: 1 } } });
    await flushPromises();

    expect(wrapper.text()).toContain("hello");
    expect(wrapper.text()).toContain("world");
  });

  it("collapseAll folds the tree, and expandAll unfolds it again", async () => {
    const wrapper = mount(JsonViewer, { props: { value: NESTED } });
    await flushPromises();

    expect(wrapper.find(".cm-foldPlaceholder").exists()).toBe(false);

    (wrapper.vm as unknown as { collapseAll: () => void }).collapseAll();
    await flushPromises();
    expect(wrapper.find(".cm-foldPlaceholder").exists()).toBe(true);

    (wrapper.vm as unknown as { expandAll: () => void }).expandAll();
    await flushPromises();
    expect(wrapper.find(".cm-foldPlaceholder").exists()).toBe(false);
  });

  it("re-renders when the value prop changes", async () => {
    const wrapper = mount(JsonViewer, { props: { value: { first: true } } });
    await flushPromises();
    expect(wrapper.text()).toContain("first");

    await wrapper.setProps({ value: { second: true } });
    await flushPromises();

    expect(wrapper.text()).not.toContain("first");
    expect(wrapper.text()).toContain("second");
  });

  it("shows the byte size of the rendered JSON", async () => {
    const wrapper = mount(JsonViewer, { props: { value: { a: 1 } } });
    await flushPromises();

    // `JSON.stringify({ a: 1 }, null, 2)` is `{\n  "a": 1\n}`, 12 bytes.
    expect(wrapper.text()).toContain("12 B");
  });

  // No global toast queue here: this component has to work inside the sandboxed
  // page (src/sandbox/SandboxApp.vue), which has no ToastStack to render one --
  // so "copied" is a local flash on the button itself.
  describe("Copy", () => {
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("copies the pretty-printed JSON and flashes Copied, then reverts", async () => {
      const wrapper = mount(JsonViewer, { props: { value: { a: 1 } } });
      await flushPromises();

      await wrapper.find("button.spacer").trigger("click");
      await flushPromises();

      expect(writeText).toHaveBeenCalledWith('{\n  "a": 1\n}');
      expect(wrapper.find("button.spacer").text()).toBe("Copied");

      vi.advanceTimersByTime(1500);
      await flushPromises();
      expect(wrapper.find("button.spacer").text()).toBe("Copy");
    });

    it("leaves the button reading Copy when the clipboard refuses", async () => {
      writeText.mockRejectedValueOnce(new Error("denied"));
      const wrapper = mount(JsonViewer, { props: { value: { a: 1 } } });
      await flushPromises();

      await wrapper.find("button.spacer").trigger("click");
      await flushPromises();

      expect(wrapper.find("button.spacer").text()).toBe("Copy");
    });
  });
});
