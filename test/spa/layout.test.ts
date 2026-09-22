import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { AUTH_REQUIRED_HEADER } from "@shared/types.ts";

import { configureClient } from "../../src/api/client.ts";
import App from "../../src/App.vue";
import { toasts } from "../../src/lib/toasts.ts";
import { NAV } from "../../src/router.ts";

import { fakeResponse, installFakeApi, testRouter } from "./helpers.ts";

async function mountApp(): Promise<ReturnType<typeof mount>> {
  const router = await testRouter();
  const wrapper = mount(App, {
    global: { plugins: [router], stubs: { RouterView: { template: '<div class="routed" />' } } },
  });
  await flushPromises();
  return wrapper;
}

describe("App layout", () => {
  it("renders every nav entry in order", async () => {
    installFakeApi({ "/api/whoami": () => fakeResponse({ body: { ok: true } }) });
    const wrapper = await mountApp();
    const labels = wrapper.findAll("nav a").map((link) => link.text());
    expect(labels).toEqual(NAV.map((item) => item.label));
  });

  it("links the nav to the routed paths", async () => {
    installFakeApi({ "/api/whoami": () => fakeResponse({ body: { ok: true } }) });
    const wrapper = await mountApp();
    const hrefs = wrapper.findAll("nav a").map((link) => link.attributes("href"));
    expect(hrefs).toEqual(NAV.map((item) => item.path));
  });

  it("probes the session before showing the page", async () => {
    const api = installFakeApi({ "/api/whoami": () => fakeResponse({ body: { ok: true } }) });
    const wrapper = await mountApp();
    expect(api.calls.map((call) => call.url)).toEqual(["/api/whoami"]);
    expect(wrapper.find(".routed").exists()).toBe(true);
  });

  it("keeps the page blank while a re-auth navigation is under way", async () => {
    const navigated: string[] = [];
    installFakeApi({
      "/api/whoami": () =>
        fakeResponse({
          status: 401,
          headers: { [AUTH_REQUIRED_HEADER]: "required" },
          html: "<html>login</html>",
        }),
    });
    configureClient({
      navigate: (url) => {
        navigated.push(url);
      },
    });

    const wrapper = await mountApp();

    expect(navigated).toHaveLength(1);
    expect(wrapper.find(".routed").exists()).toBe(false);
    expect(wrapper.text()).toContain("Checking your session");
  });

  it("still renders the UI when the probe fails for another reason", async () => {
    toasts.length = 0;
    installFakeApi({
      "/api/whoami": () => fakeResponse({ status: 500, body: { error: "internal" } }),
    });
    const wrapper = await mountApp();
    expect(wrapper.find(".routed").exists()).toBe(true);
    expect(toasts.map((toast) => toast.text)).toContain("Could not confirm the session.");
  });

  it("offers a log out button", async () => {
    installFakeApi({ "/api/whoami": () => fakeResponse({ body: { ok: true } }) });
    const wrapper = await mountApp();
    expect(wrapper.find("header button").text()).toBe("Log out");
  });
});
