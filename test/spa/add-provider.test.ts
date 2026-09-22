import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AddProviderForm from "../../src/components/AddProviderForm.vue";
import { SEARCH_DEBOUNCE_MS } from "../../src/lib/debounce.ts";

import { brand, fakeResponse, installFakeApi, provider } from "./helpers.ts";

import type { FakeFetch } from "./helpers.ts";

function searchCalls(api: FakeFetch): string[] {
  return api.calls.filter((call) => call.url.startsWith("/api/brands")).map((call) => call.url);
}

function mountForm(): ReturnType<typeof mount> {
  return mount(AddProviderForm);
}

describe("AddProviderForm", () => {
  let api: FakeFetch;

  beforeEach(() => {
    vi.useFakeTimers();
    api = installFakeApi({
      "/api/brands": () => fakeResponse({ body: [brand()] }),
      "/api/providers": () => fakeResponse({ body: provider() }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not search until typing has settled", async () => {
    const wrapper = mountForm();
    const input = wrapper.find('input[type="search"]');

    await input.setValue("Exa");
    await input.setValue("Examp");
    await input.setValue("Example");
    expect(searchCalls(api)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(searchCalls(api)).toEqual(["/api/brands?q=Example"]);
  });

  it("searches again once the debounce window has passed", async () => {
    const wrapper = mountForm();
    const input = wrapper.find('input[type="search"]');

    await input.setValue("Example");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await input.setValue("Example Two");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(searchCalls(api)).toEqual(["/api/brands?q=Example", "/api/brands?q=Example%20Two"]);
  });

  it("does not search for a single character", async () => {
    const wrapper = mountForm();
    await wrapper.find('input[type="search"]').setValue("E");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(searchCalls(api)).toHaveLength(0);
  });

  it("lists a match with its FHIR host and location count", async () => {
    const wrapper = mountForm();
    await wrapper.find('input[type="search"]').setValue("Example");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flushPromises();

    const result = wrapper.find(".result");
    expect(result.text()).toContain("Example Health");
    expect(result.text()).toContain("fhir.example.test");
    expect(result.text()).toContain("2 locations");
  });

  it("says so when nothing matched", async () => {
    api = installFakeApi({ "/api/brands": () => fakeResponse({ body: [] }) });
    const wrapper = mountForm();
    await wrapper.find('input[type="search"]').setValue("Nothing");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flushPromises();
    expect(wrapper.text()).toContain("Nothing matched");
  });

  it("prefills the display name and portal from the picked brand", async () => {
    const wrapper = mountForm();
    await wrapper.find('input[type="search"]').setValue("Example");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flushPromises();
    await wrapper.find(".result").trigger("click");

    const inputs = wrapper.findAll("input");
    const values = inputs.map((input) => (input.element as HTMLInputElement).value);
    expect(values).toContain("Example Health");
    expect(values).toContain("https://portal.example.test");
  });

  it("posts the brand id, environment and optional fields", async () => {
    const wrapper = mountForm();
    await wrapper.find('input[type="search"]').setValue("Example");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flushPromises();
    await wrapper.find(".result").trigger("click");

    await wrapper.find("select").setValue("sandbox");
    await wrapper.find('input[type="password"]').setValue("a-secret");
    await wrapper.find("button.primary").trigger("click");
    await flushPromises();

    const created = api.calls.find((call) => call.method === "POST");
    expect(created?.url).toBe("/api/providers");
    expect(JSON.parse(created?.body ?? "null")).toEqual({
      displayName: "Example Health",
      brandId: "example-health",
      environment: "sandbox",
      portalUrl: "https://portal.example.test",
      clientSecret: "a-secret",
    });
  });

  it("leaves the optional fields out of the payload when they are blank", async () => {
    const wrapper = mountForm();
    await wrapper.find('input[type="search"]').setValue("Example");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flushPromises();
    await wrapper.find(".result").trigger("click");

    // Clear what picking the brand prefilled.
    const urlInput = wrapper.find('input[type="url"]');
    await urlInput.setValue("");
    await wrapper.find("button.primary").trigger("click");
    await flushPromises();

    const created = api.calls.find((call) => call.method === "POST");
    const payload = JSON.parse(created?.body ?? "null") as Record<string, unknown>;
    expect(Object.keys(payload).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "brandId",
      "displayName",
      "environment",
    ]);
    expect(payload.environment).toBe("prod");
  });

  it("carries the CSRF header on the create request", async () => {
    const wrapper = mountForm();
    await wrapper.find('input[type="search"]').setValue("Example");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flushPromises();
    await wrapper.find(".result").trigger("click");
    await wrapper.find("button.primary").trigger("click");
    await flushPromises();

    const created = api.calls.find((call) => call.method === "POST");
    expect(created?.headers.get("x-healthy-csrf")).toBe("1");
  });

  it("emits the created provider and resets the form", async () => {
    const wrapper = mountForm();
    await wrapper.find('input[type="search"]').setValue("Example");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flushPromises();
    await wrapper.find(".result").trigger("click");
    await wrapper.find("button.primary").trigger("click");
    await flushPromises();

    expect(wrapper.emitted("created")).toEqual([[{ id: "prov-1", displayName: "Example Health" }]]);
    expect((wrapper.find('input[type="search"]').element as HTMLInputElement).value).toBe("");
    expect(wrapper.find(".result").exists()).toBe(false);
  });

  it("shows the search failure without taking the form down", async () => {
    api = installFakeApi({
      "/api/brands": () => fakeResponse({ status: 500, body: { error: "brands_unavailable" } }),
    });
    const wrapper = mountForm();
    await wrapper.find('input[type="search"]').setValue("Example");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flushPromises();
    expect(wrapper.text()).toContain("brands unavailable");
    expect(wrapper.find('input[type="search"]').exists()).toBe(true);
  });
});
