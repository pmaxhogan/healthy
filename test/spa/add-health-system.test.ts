import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AddHealthSystemForm from "../../src/components/AddHealthSystemForm.vue";
import { SEARCH_DEBOUNCE_MS } from "../../src/lib/debounce.ts";

import { brand, fakeResponse, installFakeApi, healthSystem } from "./helpers.ts";

import type { FakeFetch } from "./helpers.ts";
import type { DOMWrapper } from "@vue/test-utils";

function searchCalls(api: FakeFetch): string[] {
  return api.calls.filter((call) => call.url.startsWith("/api/brands")).map((call) => call.url);
}

function mountForm(): ReturnType<typeof mount> {
  return mount(AddHealthSystemForm);
}

describe("AddHealthSystemForm", () => {
  let api: FakeFetch;

  beforeEach(() => {
    vi.useFakeTimers();
    api = installFakeApi({
      "/api/brands": () => fakeResponse({ body: [brand()] }),
      "/api/health-systems": () => fakeResponse({ body: healthSystem() }),
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
    expect(created?.url).toBe("/api/health-systems");
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

  it("emits the created health system and resets the form", async () => {
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

  describe("manual FHIR base URL entry", () => {
    type Wrapper = ReturnType<typeof mount>;

    // Fixed field order inside the manual block: display name, FHIR base URL,
    // client secret, patient portal URL. Nothing else in that template renders
    // a bare <input>.
    function manualInputs(wrapper: Wrapper): {
      displayName: DOMWrapper<Element>;
      fhirBaseUrl: DOMWrapper<Element>;
      clientSecret: DOMWrapper<Element>;
      portalUrl: DOMWrapper<Element>;
    } {
      const [displayName, fhirBaseUrl, clientSecret, portalUrl] = wrapper.findAll("input");
      if (!displayName || !fhirBaseUrl || !clientSecret || !portalUrl) {
        throw new Error("manual entry did not render its four fields");
      }
      return { displayName, fhirBaseUrl, clientSecret, portalUrl };
    }

    async function toManualMode(wrapper: Wrapper): Promise<void> {
      await wrapper
        .findAll("button")
        .find((b) => b.text() === "Enter a FHIR base URL manually")
        ?.trigger("click");
    }

    /** Fills the two required fields with a valid, synthetic endpoint. */
    async function fillRequired(wrapper: Wrapper): Promise<void> {
      const { displayName, fhirBaseUrl } = manualInputs(wrapper);
      await displayName.setValue("Example Health");
      await fhirBaseUrl.setValue("https://fhir.example.test/api/FHIR/R4");
    }

    it("swaps the brands search for the manual fields, and back, without searching", async () => {
      const wrapper = mountForm();
      await toManualMode(wrapper);
      expect(wrapper.find('input[type="search"]').exists()).toBe(false);
      expect(wrapper.text()).toContain("FHIR base URL");

      await wrapper
        .findAll("button")
        .find((b) => b.text() === "Search health systems instead")
        ?.trigger("click");
      expect(wrapper.find('input[type="search"]').exists()).toBe(true);
      expect(searchCalls(api)).toHaveLength(0);
    });

    it("hints at an https URL and keeps the submit button disabled until the URL is one", async () => {
      const wrapper = mountForm();
      await toManualMode(wrapper);
      const { displayName, fhirBaseUrl } = manualInputs(wrapper);
      await displayName.setValue("Example Health");
      // eslint-disable-next-line unicorn/prefer-https -- the assertion IS that http is refused.
      await fhirBaseUrl.setValue("http://fhir.example.test/api/FHIR/R4");
      await fhirBaseUrl.trigger("blur");

      expect(wrapper.text()).toContain("Must be an https URL");
      expect(wrapper.find("button.primary").attributes("disabled")).toBeDefined();
      expect(api.calls.some((call) => call.method === "POST")).toBe(false);
    });

    it("posts the manual FHIR base URL with no brandId", async () => {
      const wrapper = mountForm();
      await toManualMode(wrapper);
      await fillRequired(wrapper);
      await wrapper.find("button.primary").trigger("click");
      await flushPromises();

      const created = api.calls.find((call) => call.method === "POST");
      expect(created?.url).toBe("/api/health-systems");
      expect(JSON.parse(created?.body ?? "null")).toEqual({
        displayName: "Example Health",
        fhirBaseUrl: "https://fhir.example.test/api/FHIR/R4",
        environment: "prod",
      });
    });

    it("carries the optional secret, portal and a non-default environment when they are filled in", async () => {
      const wrapper = mountForm();
      await toManualMode(wrapper);
      await fillRequired(wrapper);
      const { clientSecret, portalUrl } = manualInputs(wrapper);
      await clientSecret.setValue("a-secret");
      await portalUrl.setValue("https://portal.example.test");
      await wrapper.find("select").setValue("sandbox");
      await wrapper.find("button.primary").trigger("click");
      await flushPromises();

      const created = api.calls.find((call) => call.method === "POST");
      expect(JSON.parse(created?.body ?? "null")).toEqual({
        displayName: "Example Health",
        fhirBaseUrl: "https://fhir.example.test/api/FHIR/R4",
        environment: "sandbox",
        clientSecret: "a-secret",
        portalUrl: "https://portal.example.test",
      });
    });

    it("carries the CSRF header on a manual create", async () => {
      const wrapper = mountForm();
      await toManualMode(wrapper);
      await fillRequired(wrapper);
      await wrapper.find("button.primary").trigger("click");
      await flushPromises();

      const created = api.calls.find((call) => call.method === "POST");
      expect(created?.headers.get("x-healthy-csrf")).toBe("1");
    });

    it("emits the created health system and resets the manual fields", async () => {
      const wrapper = mountForm();
      await toManualMode(wrapper);
      await fillRequired(wrapper);
      await wrapper.find("button.primary").trigger("click");
      await flushPromises();

      expect(wrapper.emitted("created")).toEqual([
        [{ id: "prov-1", displayName: "Example Health" }],
      ]);
      const { displayName, fhirBaseUrl } = manualInputs(wrapper);
      expect((displayName.element as HTMLInputElement).value).toBe("");
      expect((fhirBaseUrl.element as HTMLInputElement).value).toBe("");
    });
  });
});
