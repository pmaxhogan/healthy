// The Settings page's owner-facing controls that have no better home: the MCP
// toggle (covered elsewhere by inspection) and the patient-portal sign-in
// limit tested here -- seeded from the loaded value, refused client-side
// outside 1-20, and saved on its own.

import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { toasts } from "../../src/lib/toasts.ts";
import SettingsView from "../../src/views/SettingsView.vue";

import { fakeResponse, installFakeApi, settings, testRouter } from "./helpers.ts";

import type { FakeFetch } from "./helpers.ts";
import type { SettingsDto } from "@shared/types.ts";

async function mountView(options: {
  settingsDto?: SettingsDto;
  onSettingsPut?: () => Response;
}): Promise<{ wrapper: ReturnType<typeof mount>; api: FakeFetch }> {
  const api = installFakeApi({
    "/api/settings": () =>
      (
        options.onSettingsPut ?? (() => fakeResponse({ body: options.settingsDto ?? settings() }))
      )(),
  });
  const router = await testRouter("/settings");
  const wrapper = mount(SettingsView, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, api };
}

function limitInput(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll("input[type='number']")[0]!;
}

function saveButton(wrapper: ReturnType<typeof mount>) {
  return wrapper
    .findAll("button")
    .find((button) => button.text().includes("Save") && !button.text().includes("Saving"));
}

describe("SettingsView: portal sign-in limit", () => {
  it("shows the current value from the loaded settings", async () => {
    const { wrapper } = await mountView({ settingsDto: settings({ portalLoginAttemptLimit: 12 }) });

    expect((limitInput(wrapper).element as HTMLInputElement).value).toBe("12");
    expect(wrapper.text()).toContain("Portal sign-ins per day");
    expect(wrapper.text()).toContain("resets at 00:00 UTC");
  });

  it("flags an out-of-range value and disables Save, without sending a request", async () => {
    const { wrapper, api } = await mountView({
      settingsDto: settings({ portalLoginAttemptLimit: 12 }),
    });

    await limitInput(wrapper).setValue(25);

    expect(wrapper.text()).toContain("Must be a whole number from 1 to 20");
    expect(saveButton(wrapper)?.attributes("disabled")).toBeDefined();
    expect(api.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("flags zero, the empty box and a fraction as invalid too", async () => {
    const { wrapper } = await mountView({ settingsDto: settings({ portalLoginAttemptLimit: 12 }) });

    await limitInput(wrapper).setValue(0);
    expect(wrapper.text()).toContain("Must be a whole number from 1 to 20");

    await limitInput(wrapper).setValue("");
    expect(wrapper.text()).toContain("Must be a whole number from 1 to 20");

    await limitInput(wrapper).setValue(1.5);
    expect(wrapper.text()).toContain("Must be a whole number from 1 to 20");
  });

  it("clears the hint and re-enables Save once the value is back in range", async () => {
    const { wrapper } = await mountView({ settingsDto: settings({ portalLoginAttemptLimit: 12 }) });

    await limitInput(wrapper).setValue(25);
    expect(saveButton(wrapper)?.attributes("disabled")).toBeDefined();

    await limitInput(wrapper).setValue(12);

    expect(wrapper.text()).not.toContain("Must be a whole number from 1 to 20");
    expect(saveButton(wrapper)?.attributes("disabled")).toBeUndefined();
  });

  it("saves the typed value and toasts success", async () => {
    const { wrapper, api } = await mountView({
      settingsDto: settings({ portalLoginAttemptLimit: 12 }),
      onSettingsPut: () => fakeResponse({ body: settings({ portalLoginAttemptLimit: 5 }) }),
    });

    await limitInput(wrapper).setValue(5);
    await saveButton(wrapper)?.trigger("click");
    await flushPromises();

    const put = api.calls.find((call) => call.url === "/api/settings" && call.method === "PUT");
    expect(put).toBeDefined();
    expect(JSON.parse(put?.body ?? "null")).toStrictEqual({ portalLoginAttemptLimit: 5 });
    expect(toasts.map((toast) => toast.text)).toContain("Portal sign-in limit saved.");
  });

  it("shows the server's zod issue on a 400 and reloads rather than keeping a stale draft", async () => {
    // The first call is the mount's GET, the second the PUT, the third the reload.
    const seen = { calls: 0 };
    const { wrapper } = await mountView({
      settingsDto: settings({ portalLoginAttemptLimit: 12 }),
      onSettingsPut: () => {
        seen.calls += 1;
        return fakeResponse(
          seen.calls === 2
            ? {
                status: 400,
                body: {
                  error: "bad_request",
                  message: "the request body is not valid",
                  details: { issues: ["portalLoginAttemptLimit: too_big"] },
                },
              }
            : { body: settings({ portalLoginAttemptLimit: 12 }) },
        );
      },
    });

    await limitInput(wrapper).setValue(20);
    await saveButton(wrapper)?.trigger("click");
    await flushPromises();

    expect(toasts.map((toast) => toast.text)).toContain(
      "the request body is not valid: portalLoginAttemptLimit too big",
    );
    expect(seen.calls).toBe(3);
  });
});
