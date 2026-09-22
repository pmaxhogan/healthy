import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { toasts } from "../../src/lib/toasts.ts";
import OverviewView from "../../src/views/OverviewView.vue";

import {
  connection,
  fakeResponse,
  installFakeApi,
  overview,
  provider,
  testRouter,
} from "./helpers.ts";

import type { OverviewDto } from "@shared/types.ts";

async function mountOverview(dto: OverviewDto, at = "/"): Promise<ReturnType<typeof mount>> {
  installFakeApi({ "/api/overview": () => fakeResponse({ body: dto }) });
  const router = await testRouter(at);
  const wrapper = mount(OverviewView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

describe("OverviewView", () => {
  it("shows a loading state before the request resolves", async () => {
    installFakeApi({ "/api/overview": () => fakeResponse({ body: overview() }) });
    const router = await testRouter();
    const wrapper = mount(OverviewView, { global: { plugins: [router] } });
    expect(wrapper.text()).toContain("Loading the overview");
    await flushPromises();
    expect(wrapper.text()).not.toContain("Loading the overview");
  });

  it("renders one card per provider with its status pill", async () => {
    const wrapper = await mountOverview(overview());

    const cards = wrapper.findAll(".cards > .card");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.text()).toContain("Example Health");
    expect(cards[0]?.find(".pill").text()).toBe("connected");
    expect(cards[1]?.text()).toContain("Second Example Clinic");
    expect(cards[1]?.find(".pill").text()).toBe("needs re-auth");
  });

  it("marks a sandbox provider and one with no client secret", async () => {
    const wrapper = await mountOverview(overview());
    const second = wrapper.findAll(".cards > .card")[1];
    expect(second?.text()).toContain("sandbox");
    expect(second?.text()).toContain("No client secret set yet");
  });

  it("points Reconnect at the path the DTO supplies", async () => {
    const wrapper = await mountOverview(overview());
    const cards = wrapper.findAll(".cards > .card");
    expect(cards[0]?.find('a.btn[href^="/reconnect"]').attributes("href")).toBe(
      "/reconnect/conn-1",
    );
    expect(cards[1]?.find('a.btn[href^="/reconnect"]').attributes("href")).toBe(
      "/reconnect/conn-2",
    );
  });

  it("falls back to the epic start route for a provider that never connected", async () => {
    const wrapper = await mountOverview(overview({ providers: [provider({ connection: null })] }));
    const link = wrapper.find('.cards > .card a.btn[href^="/oauth"]');
    expect(link.attributes("href")).toBe("/oauth/epic/start?provider=prov-1");
    expect(link.text()).toBe("Connect");
  });

  it("shows the last error code when there is one", async () => {
    const wrapper = await mountOverview(overview());
    expect(wrapper.text()).toContain("invalid grant");
  });

  it("masks the Google account label and shows the event counts", async () => {
    const wrapper = await mountOverview(overview());
    expect(wrapper.text()).toContain("o…r@example.test");
    expect(wrapper.text()).toContain("5 active");
    expect(wrapper.text()).toContain("2 ghost");
  });

  it("offers Connect rather than Reconnect when Google is not linked", async () => {
    const dto = overview();
    const wrapper = await mountOverview({
      ...dto,
      google: { ...dto.google, status: "not_connected", accountLabel: null },
    });
    const googleLink = wrapper.findAll('a.btn[href="/oauth/google/start"]');
    expect(googleLink[0]?.text()).toBe("Connect");
  });

  it("builds the cache table as resource rows across provider columns", async () => {
    const wrapper = await mountOverview(overview());
    const rows = wrapper.findAll("tbody tr");
    const cacheRows = rows.filter((row) => row.text().includes("Condition"));
    expect(cacheRows).toHaveLength(1);
    const cells = cacheRows[0]?.findAll("td").map((cell) => cell.text());
    // Condition: 7 for the first provider, 3 for the second.
    expect(cells).toEqual(["Condition", "7", "3"]);
  });

  it("shows zero for a provider that has nothing cached of a type", async () => {
    const wrapper = await mountOverview(overview());
    const observationRow = wrapper
      .findAll("tbody tr")
      .find((row) => row.text().startsWith("Observation"));
    expect(observationRow?.findAll("td").map((cell) => cell.text())).toEqual([
      "Observation",
      "42",
      "0",
    ]);
  });

  it("summarises MCP", async () => {
    const wrapper = await mountOverview(overview());
    expect(wrapper.text()).toContain("enabled");
    expect(wrapper.text()).toContain("12");
  });

  it("falls back to empty states when nothing is configured", async () => {
    const wrapper = await mountOverview(
      overview({
        providers: [],
        openAlerts: [],
        lastRuns: [],
        cacheCounts: [],
      }),
    );
    const text = wrapper.text();
    expect(text).toContain("No providers yet");
    expect(text).toContain("Nothing needs re-authenticating");
    expect(text).toContain("Nothing has run yet");
    expect(text).toContain("The cache is empty");
  });

  it("shows an error and a retry when the request fails", async () => {
    installFakeApi({
      "/api/overview": () => fakeResponse({ status: 500, body: { error: "internal" } }),
    });
    const router = await testRouter();
    const wrapper = mount(OverviewView, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.text()).toContain("internal");
    expect(wrapper.find("button").text()).toBe("Try again");
  });

  it("toasts after an OAuth callback says a provider connected", async () => {
    toasts.length = 0;
    await mountOverview(overview(), "/?connected=prov-1");
    expect(toasts.map((toast) => toast.text)).toContain("Provider connected.");
  });

  it("toasts after the Google callback", async () => {
    toasts.length = 0;
    await mountOverview(overview(), "/?google=connected");
    expect(toasts.map((toast) => toast.text)).toContain("Google Calendar connected.");
  });

  it("does not toast on a plain visit", async () => {
    toasts.length = 0;
    await mountOverview(overview());
    expect(toasts).toHaveLength(0);
  });

  it("renders a run row with its counts", async () => {
    const wrapper = await mountOverview(overview());
    expect(wrapper.text()).toContain("calendar");
    // +2 inserted, ~1 patched, 9 cached.
    expect(wrapper.text()).toContain("+2");
    expect(wrapper.text()).toContain("~1");
  });

  it("renders a disconnected provider without a token expiry", async () => {
    const dormant = connection({
      status: "disconnected",
      accessExpiresAt: null,
      lastSyncAt: null,
    });
    const wrapper = await mountOverview(
      overview({ providers: [provider({ connection: dormant })] }),
    );
    expect(wrapper.find(".pill").text()).toBe("disconnected");
    expect(wrapper.text()).toContain("never");
  });
});
