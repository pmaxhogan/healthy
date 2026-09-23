import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import JsonEditor from "../../src/components/JsonEditor.vue";

describe("JsonEditor", () => {
  it("renders the initial modelValue as editable text", async () => {
    const wrapper = mount(JsonEditor, { props: { modelValue: '{\n  "a": 1\n}' } });
    await flushPromises();

    expect(wrapper.text()).toContain('"a"');
    expect(wrapper.find(".cm-content").attributes("contenteditable")).toBe("true");
  });

  it("re-renders when modelValue changes from outside", async () => {
    const wrapper = mount(JsonEditor, { props: { modelValue: '{"first":true}' } });
    await flushPromises();
    expect(wrapper.text()).toContain("first");

    await wrapper.setProps({ modelValue: '{"second":true}' });
    await flushPromises();

    expect(wrapper.text()).not.toContain("first");
    expect(wrapper.text()).toContain("second");
  });

  it("emits run on Ctrl/Cmd+Enter", async () => {
    const wrapper = mount(JsonEditor, { props: { modelValue: "{}" } });
    await flushPromises();

    await wrapper.find(".cm-content").trigger("keydown", { key: "Enter", ctrlKey: true });
    await flushPromises();

    expect(wrapper.emitted("run")).toBeTruthy();
  });
});
