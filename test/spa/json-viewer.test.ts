import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

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
});
