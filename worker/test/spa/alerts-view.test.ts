// The Alerts page: what it says for each kind of alert. Every request goes
// through the fake fetch, which 404s a path the test did not declare.

import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import AlertsView from "../../ui/views/AlertsView.vue";

import { fakeResponse, healthSystem, installFakeApi, settings, testRouter } from "./helpers.ts";

import type { AlertDto } from "@shared/types.ts";

function alert(overrides: Partial<AlertDto> = {}): AlertDto {
  return {
    id: "alert-1",
    kind: "reconnect",
    subject: "google",
    healthSystemId: null,
    trelloCardId: null,
    openedAt: "2026-09-21T11:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

async function mounted(alerts: AlertDto[]) {
  installFakeApi({
    "/api/alerts": () => fakeResponse({ body: alerts }),
    "/api/health-systems": () => fakeResponse({ body: [healthSystem()] }),
    "/api/settings": () => fakeResponse({ body: settings() }),
  });
  const wrapper = mount(AlertsView, { global: { plugins: [await testRouter("/alerts")] } });
  await flushPromises();
  return wrapper;
}

describe("AlertsView", () => {
  it("says a phone's uploads are being kept, and links to the Phone page", async () => {
    const wrapper = await mounted([
      alert({
        id: "alert-2",
        kind: "hc_parked",
        subject: "device:01SYNTHETICDEVICE",
        trelloCardId: "c1",
      }),
    ]);

    const item = wrapper.get("ul.alerts li");
    expect(item.get(".subject").text()).toBe("Phone uploads");
    expect(item.text()).toContain("could not be applied and are being kept");
    expect(item.text()).not.toContain("needs re-auth");
    // This app's own row id is not shown: it says nothing to the owner.
    expect(item.text()).not.toContain("01SYNTHETICDEVICE");
    expect(item.get("a").attributes("href")).toBe("/phone");
    expect(item.text()).toContain("card opened");
  });

  it("still says a connection needs re-authenticating", async () => {
    const wrapper = await mounted([alert()]);

    const item = wrapper.get("ul.alerts li");
    expect(item.get(".subject").text()).toBe("Google Calendar");
    expect(item.text()).toContain("needs re-auth");
    expect(item.find("a").exists()).toBe(false);
  });

  it("lists a resolved phone alert under Resolved, and says so when nothing is open", async () => {
    const wrapper = await mounted([
      alert({
        kind: "hc_parked",
        subject: "device:01SYNTHETICDEVICE",
        resolvedAt: "2026-09-21T11:30:00.000Z",
      }),
    ]);

    expect(wrapper.text()).toContain("Nothing needs attention.");
    expect(wrapper.text()).toContain("Resolved");
    expect(wrapper.get("ul.alerts li").classes()).toContain("resolved");
  });
});
