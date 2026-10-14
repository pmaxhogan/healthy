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
    reasonCode: null,
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

  it("says which code a connection needs re-authenticating for, when it has one", async () => {
    const wrapper = await mounted([alert({ reasonCode: "needs_reauth" })]);

    expect(wrapper.get("ul.alerts li").text()).toContain("needs re-auth (needs reauth)");
  });

  it("says a sync keeps failing, with its code, and that nothing needs reconnecting", async () => {
    const system = healthSystem();
    const wrapper = await mounted([
      alert({
        kind: "sync_failing",
        subject: `health_system:${system.id}`,
        healthSystemId: system.id,
        reasonCode: "upstream_unavailable",
        trelloCardId: "c1",
      }),
    ]);

    const item = wrapper.get("ul.alerts li");
    expect(item.get(".subject").text()).toBe(system.displayName);
    expect(item.text()).toContain("sync keeps failing (upstream unavailable)");
    expect(item.text()).toContain("nothing to reconnect");
    expect(item.text()).not.toContain("needs re-auth");
    expect(item.text()).toContain("card opened");
  });

  it("tells a failing portal from the health system's own connection", async () => {
    const system = healthSystem();
    const wrapper = await mounted([
      alert({
        kind: "sync_failing",
        subject: `portal:${system.id}`,
        healthSystemId: system.id,
        reasonCode: "portal_parse_failed",
      }),
      alert({
        id: "alert-3",
        kind: "reconnect",
        subject: `portal:${system.id}`,
        healthSystemId: system.id,
        resolvedAt: "2026-09-21T11:30:00.000Z",
      }),
    ]);

    const subjects = wrapper.findAll("ul.alerts li .subject").map((node) => node.text());
    expect(subjects).toStrictEqual([
      `${system.displayName} patient portal`,
      `${system.displayName} patient portal`,
    ]);
    expect(wrapper.text()).toContain("sync keeps failing (portal parse failed)");
  });

  it("names Google and the sync itself rather than showing a raw subject", async () => {
    const wrapper = await mounted([
      alert({ kind: "sync_failing", subject: "google", reasonCode: "upstream_auth" }),
      alert({ id: "alert-4", kind: "sync_failing", subject: "sync", reasonCode: null }),
    ]);

    const items = wrapper.findAll("ul.alerts li");
    expect(items.map((item) => item.get(".subject").text())).toStrictEqual([
      "Google Calendar",
      "Scheduled sync",
    ]);
    // No code recorded: the sentence still reads, without empty brackets.
    expect(items[1]?.text()).toContain("sync keeps failing");
    expect(items[1]?.text()).not.toContain("()");
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
