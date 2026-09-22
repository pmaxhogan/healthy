// TimezoneSelect displays `modelValue ?? detected`, so a blank model looked
// configured on screen while Save was about to persist `null`. These pin the fix:
// the detected zone has to reach the model, not just the dropdown.

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import TimezoneSelect from "../../src/components/TimezoneSelect.vue";

/** Stubs what the browser reports, without touching the real host timezone. */
function stubDetectedZone(zone: string): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    timeZone: zone,
  } as Intl.ResolvedDateTimeFormatOptions);
}

describe("TimezoneSelect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits the detected zone into the model as soon as it mounts with nothing set", () => {
    // Not a real owner zone -- see CLAUDE.md -- and deliberately not UTC, so the
    // assertion cannot pass by coincidence with the component's own UTC fallback.
    stubDetectedZone("Asia/Tokyo");
    const wrapper = mount(TimezoneSelect, { props: { modelValue: null } });

    expect(wrapper.emitted("update:modelValue")).toStrictEqual([["Asia/Tokyo"]]);
  });

  it("does not emit on mount once a zone is already chosen", () => {
    stubDetectedZone("Asia/Tokyo");
    const wrapper = mount(TimezoneSelect, { props: { modelValue: "UTC" } });

    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("re-emits the detected zone if the model is cleared back to null later", async () => {
    stubDetectedZone("Asia/Tokyo");
    const wrapper = mount(TimezoneSelect, { props: { modelValue: "UTC" } });

    await wrapper.setProps({ modelValue: null });

    expect(wrapper.emitted("update:modelValue")).toStrictEqual([["Asia/Tokyo"]]);
  });

  it("still emits the manually chosen zone on change", async () => {
    stubDetectedZone("Asia/Tokyo");
    const wrapper = mount(TimezoneSelect, { props: { modelValue: "Asia/Tokyo" } });

    await wrapper.find("select").setValue("UTC");

    expect(wrapper.emitted("update:modelValue")?.at(-1)).toStrictEqual(["UTC"]);
  });
});
