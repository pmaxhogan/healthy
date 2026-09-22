import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { toasts } from "../../src/lib/toasts.ts";
import MailView from "../../src/views/MailView.vue";

import { fakeResponse, installFakeApi, mailInboxEntry, mailSettings, settings } from "./helpers.ts";

import type { FakeFetch } from "./helpers.ts";
import type { MailInboxEntryDto, MailSettingsDto } from "@shared/types.ts";

function install(options: {
  inbox?: MailInboxEntryDto[];
  settingsDto?: MailSettingsDto;
  onSettingsPut?: () => Response;
  onTest?: () => Response;
}): FakeFetch {
  return installFakeApi({
    "/api/settings": () => fakeResponse({ body: settings() }),
    "/api/mail/inbox": () => fakeResponse({ body: options.inbox ?? [] }),
    "/api/mail/settings": () =>
      (
        options.onSettingsPut ??
        (() => fakeResponse({ body: options.settingsDto ?? mailSettings() }))
      )(),
    "/api/mail/test": () =>
      (options.onTest ?? (() => fakeResponse({ status: 201, body: mailInboxEntry() })))(),
  });
}

async function mountView(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(MailView, {});
  await flushPromises();
  return wrapper;
}

describe("MailView: setup checklist", () => {
  it("explains the three Gmail steps", async () => {
    install({});
    const wrapper = await mountView();

    expect(wrapper.text()).toContain("Add a forwarding address");
    expect(wrapper.text()).toContain("Create a filter");
    expect(wrapper.text()).toContain("Forward it to");
  });
});

describe("MailView: pending Gmail verification", () => {
  it("is hidden when there is nothing pending", async () => {
    install({ inbox: [mailInboxEntry({ kind: "otp" })] });
    const wrapper = await mountView();

    expect(wrapper.text()).not.toContain("Pending Gmail verification");
  });

  it("shows the code and link once a forward_verify entry has arrived", async () => {
    install({
      inbox: [
        mailInboxEntry({
          kind: "forward_verify",
          fromDomain: "google.com",
          pendingCode: "123456789",
          pendingUrl: "https://mail-settings.google.com/mail/vf-abc",
        }),
      ],
    });
    const wrapper = await mountView();

    expect(wrapper.text()).toContain("Pending Gmail verification");
    expect(wrapper.text()).toContain("123456789");
    const link = wrapper.find('a[href="https://mail-settings.google.com/mail/vf-abc"]');
    expect(link.exists()).toBe(true);
  });

  it("never renders a link for an unsafe pendingUrl, even if one somehow reached the DTO", async () => {
    // Defense in depth: worker/mail/classify.ts should never produce anything
    // but a real https://…google.com link, but this view does not trust that
    // alone -- it re-checks the scheme itself before ever writing an <a href>.
    install({
      inbox: [
        mailInboxEntry({
          kind: "forward_verify",
          pendingCode: "123456789",
          pendingUrl: "javascript:alert(1)",
        }),
      ],
    });
    const wrapper = await mountView();

    expect(wrapper.text()).toContain("123456789");
    expect(wrapper.find("a[target='_blank']").exists()).toBe(false);
    expect(wrapper.html()).not.toContain("javascript:");
  });
});

describe("MailView: recent inbox table", () => {
  it("shows the empty state when nothing has arrived", async () => {
    install({ inbox: [] });
    const wrapper = await mountView();

    expect(wrapper.text()).toContain("Nothing has arrived yet");
  });

  it("renders one row per entry with kind, domain, subject and consumed state", async () => {
    install({
      inbox: [
        mailInboxEntry({
          id: "mail-a",
          kind: "otp",
          fromDomain: "mychart.example.org",
          subject: "Your MyChart security code",
          consumedAt: "2026-09-21T11:55:00.000Z",
        }),
        mailInboxEntry({
          id: "mail-b",
          kind: "other",
          fromDomain: "mychart.example.org",
          subject: null,
          consumedAt: null,
        }),
      ],
    });
    const wrapper = await mountView();

    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.text()).toContain("login code");
    expect(rows[0]?.text()).toContain("mychart.example.org");
    expect(rows[0]?.text()).toContain("Your MyChart security code");
    expect(rows[0]?.text()).toContain("yes");
    expect(rows[1]?.text()).toContain("other");
    expect(rows[1]?.text()).toContain("no");
  });

  it("sends a test entry and reloads the inbox", async () => {
    let served = false;
    const api = install({
      inbox: [],
      onTest: () => {
        served = true;
        return fakeResponse({ status: 201, body: mailInboxEntry() });
      },
    });
    const wrapper = await mountView();

    await wrapper.find("button.small").trigger("click");
    await flushPromises();

    expect(served).toBe(true);
    expect(api.calls.some((call) => call.url === "/api/mail/test" && call.method === "POST")).toBe(
      true,
    );
    expect(toasts.map((toast) => toast.text)).toContain("Test entry added to the inbox below.");
  });
});

describe("MailView: sender allowlist", () => {
  it("seeds the editor from the loaded settings", async () => {
    install({ settingsDto: mailSettings({ allowlist: ["mychart.", "google.com"] }) });
    const wrapper = await mountView();

    const textarea = wrapper.find("textarea");
    expect((textarea.element as HTMLTextAreaElement).value).toBe("mychart., google.com");
  });

  it("disables Save while the allowlist is empty", async () => {
    install({ settingsDto: mailSettings({ allowlist: ["google.com"] }) });
    const wrapper = await mountView();

    const textarea = wrapper.find("textarea");
    await textarea.setValue("   ,  ,");
    const saveButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Save allowlist"));

    expect(saveButton?.attributes("disabled")).toBeDefined();
  });

  it("saves the parsed, trimmed allowlist", async () => {
    const api = install({
      settingsDto: mailSettings({ allowlist: ["google.com"] }),
      onSettingsPut: () =>
        fakeResponse({ body: mailSettings({ allowlist: ["mychart.", "google.com"] }) }),
    });
    const wrapper = await mountView();

    const textarea = wrapper.find("textarea");
    await textarea.setValue(" mychart. , google.com ");
    const saveButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Save allowlist"));
    await saveButton?.trigger("click");
    await flushPromises();

    const put = api.calls.find(
      (call) => call.url === "/api/mail/settings" && call.method === "PUT",
    );
    expect(put).toBeDefined();
    expect(JSON.parse(put?.body ?? "null")).toStrictEqual({
      allowlist: ["mychart.", "google.com"],
    });
    expect(toasts.map((toast) => toast.text)).toContain("Sender allowlist saved.");
  });
});
