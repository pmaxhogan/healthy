// These tests pin the update payload to the Worker's schema, which is a strict
// object whose optional strings are all `min(1)`. Sending "" is a 400, and the
// config is replaced wholesale -- so an omitted key is how a field is cleared.
// Get either of those wrong and the Save button silently stops working.

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";

import HealthSystemEditor from "../../src/components/HealthSystemEditor.vue";

import { fakeResponse, installFakeApi, portalAccount, healthSystem, settings } from "./helpers.ts";

import type { FakeFetch } from "./helpers.ts";
import type { HealthSystemDto } from "@shared/types.ts";

function mountEditor(dto: HealthSystemDto = healthSystem()): ReturnType<typeof mount> {
  return mount(HealthSystemEditor, {
    props: { healthSystem: dto, colors: [], settings: settings() },
    global: { stubs: { RouterLink: true } },
  });
}

async function save(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.find("button.primary").trigger("click");
  await flushPromises();
}

function lastMutation(api: FakeFetch): { url: string; method: string; body: unknown } | undefined {
  const call = api.calls.findLast((entry) => entry.method !== "GET");
  return call
    ? { url: call.url, method: call.method, body: JSON.parse(call.body ?? "null") }
    : undefined;
}

describe("HealthSystemEditor", () => {
  let api: FakeFetch;

  beforeEach(() => {
    // HealthSystemEditor embeds PortalAccountCard, which loads
    // `GET /api/health-systems/prov-1/portal` on mount. An exact key beats the
    // wildcard below (installFakeApi checks it first), so that load gets a
    // real `PortalAccountStatusDto` rather than a `HealthSystemDto` from the
    // wildcard -- which would leave `.signIn` undefined and throw.
    api = installFakeApi({
      "/api/health-systems*": () => fakeResponse({ body: healthSystem() }),
      "/api/health-systems/prov-1/portal": () => fakeResponse({ body: portalAccount() }),
    });
  });

  // A regression guard for a bug this exact shape would produce: if Connect or
  // Reconnect were ever written as a <RouterLink> instead of a plain <a>, the
  // stubbed RouterLink here would render as <router-link-stub>, not <a>, and
  // these lookups would fail -- so a router-intercepted OAuth start link is
  // caught here rather than only by a live click going nowhere.
  it("renders Reconnect as a real anchor at the connection's reconnect path", () => {
    const wrapper = mountEditor();
    const link = wrapper.find('a[href^="/reconnect"]');
    expect(link.exists()).toBe(true);
    expect(link.attributes("href")).toBe("/reconnect/conn-1");
    expect(link.text()).toBe("Reconnect");
  });

  it("renders Connect as a real anchor at the epic start route when there is no connection yet", () => {
    const wrapper = mountEditor(healthSystem({ connection: null }));
    const link = wrapper.find('a[href^="/oauth/epic/start"]');
    expect(link.exists()).toBe(true);
    expect(link.attributes("href")).toBe("/oauth/epic/start?healthSystem=prov-1");
    expect(link.text()).toBe("Connect");
  });

  it("saves with PATCH, not PUT", async () => {
    await save(mountEditor());
    expect(lastMutation(api)?.method).toBe("PATCH");
    expect(lastMutation(api)?.url).toBe("/api/health-systems/prov-1");
  });

  it("sends the CSRF header on the save", async () => {
    await save(mountEditor());
    expect(api.calls.at(-1)?.headers.get("x-healthy-csrf")).toBe("1");
  });

  it("sends the whole config, because the Worker replaces rather than merges", async () => {
    await save(mountEditor());
    expect(lastMutation(api)?.body).toEqual({
      displayName: "Example Health",
      portalUrl: "https://portal.example.test",
      config: {
        titleTemplate: "{visitType} · {practitioner}",
        arrivalOffsetsByVisitType: {},
        enabled: true,
      },
    });
  });

  it("omits a cleared title template rather than sending an empty string", async () => {
    const wrapper = mountEditor();
    const template = wrapper.findAll("input").find((input) => {
      return (input.element as HTMLInputElement).value.includes("{visitType}");
    });
    await template?.setValue("");
    await save(wrapper);

    const config = (lastMutation(api)?.body as { config: Record<string, unknown> }).config;
    expect(config).not.toHaveProperty("titleTemplate");
  });

  it("omits a blank org short label", async () => {
    await save(mountEditor(healthSystem({ config: { orgShort: "", enabled: true } })));
    const config = (lastMutation(api)?.body as { config: Record<string, unknown> }).config;
    expect(config).not.toHaveProperty("orgShort");
  });

  it("sends portalUrl as null when it is cleared, so it can be removed", async () => {
    const wrapper = mountEditor();
    await wrapper.find('input[type="url"]').setValue("");
    await save(wrapper);
    expect((lastMutation(api)?.body as { portalUrl: unknown }).portalUrl).toBeNull();
  });

  it("carries the arrival offset only when one is set on this health system", async () => {
    await save(mountEditor(healthSystem({ config: { arrivalOffsetMin: 30, enabled: true } })));
    const first = (lastMutation(api)?.body as { config: Record<string, unknown> }).config;
    expect(first.arrivalOffsetMin).toBe(30);

    api = installFakeApi({
      "/api/health-systems*": () => fakeResponse({ body: healthSystem() }),
      "/api/health-systems/prov-1/portal": () => fakeResponse({ body: portalAccount() }),
    });
    await save(mountEditor(healthSystem({ config: { enabled: true } })));
    const second = (lastMutation(api)?.body as { config: Record<string, unknown> }).config;
    expect(second).not.toHaveProperty("arrivalOffsetMin");
  });

  it("reports whether a client secret is on file", () => {
    expect(mountEditor().text()).toContain("secret set");
    expect(mountEditor(healthSystem({ hasClientSecret: false })).text()).toContain(
      "no client secret",
    );
  });

  it("posts a new client secret to its own endpoint", async () => {
    const wrapper = mountEditor();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Replace secret")
      ?.trigger("click");
    await wrapper.find('input[type="password"]').setValue("a-secret");
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Store")
      ?.trigger("click");
    await flushPromises();

    expect(lastMutation(api)).toEqual({
      url: "/api/health-systems/prov-1/secret",
      method: "POST",
      body: { clientSecret: "a-secret" },
    });
  });

  it("asks for the health system name before removing it, with no window.confirm", async () => {
    const wrapper = mountEditor();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Remove")
      ?.trigger("click");

    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain("Remove Example Health?");

    const confirm = dialog.find("button.confirm");
    expect(confirm.attributes("disabled")).toBeDefined();

    await dialog.find("input").setValue("Example Health");
    await confirm.trigger("click");
    await flushPromises();

    expect(lastMutation(api)).toEqual({
      url: "/api/health-systems/prov-1",
      method: "DELETE",
      body: null,
    });
    expect(wrapper.emitted("removed")).toHaveLength(1);
  });

  it("runs each per-health system operation against its own route", async () => {
    const wrapper = mountEditor();
    for (const [label, path] of [
      ["Sync now", "/api/health-systems/prov-1/sync"],
      ["Refresh token", "/api/health-systems/prov-1/refresh-token"],
      ["Full refresh", "/api/health-systems/prov-1/full-refresh"],
    ] as const) {
      await wrapper
        .findAll("button")
        .find((b) => b.text() === label)
        ?.trigger("click");
      await flushPromises();
      expect(lastMutation(api), label).toEqual({ url: path, method: "POST", body: null });
    }
  });
});
