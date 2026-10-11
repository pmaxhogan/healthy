// The Phone page: the device list, the one-time pairing panel, and the actions on
// a phone. Every request goes through the fake fetch, which 404s a path the test
// did not declare, so a call the page makes that nobody expected fails loudly.

import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { toasts } from "../../ui/lib/toasts.ts";
import PhoneView from "../../ui/views/PhoneView.vue";

import { fakeResponse, installFakeApi, settings, testRouter } from "./helpers.ts";

import type { FakeFetch } from "./helpers.ts";
import type {
  DeviceCoverageRowDto,
  DeviceDto,
  DeviceIngestLogDto,
  PairedDeviceDto,
} from "@shared/types.ts";

function device(overrides: Partial<DeviceDto> = {}): DeviceDto {
  return {
    id: "dev-1",
    name: "Example phone",
    status: "active",
    createdAt: "2026-09-20T00:00:00.000Z",
    rotatedAt: null,
    revokedAt: null,
    lastSeenAt: "2026-09-21T11:55:00.000Z",
    lastUploadAt: "2026-09-21T11:50:00.000Z",
    appVersion: "0.1.7",
    queue: { batches: 2, bytes: 2500 },
    parked: { batches: 0, bytes: 0, errorCodes: [] },
    parkedMarks: 0,
    report: {
      batteryExempt: true,
      backgroundRead: false,
      historyRead: true,
      backfillComplete: false,
      exerciseRoutes: "denied",
      lastErrorCode: "hc_rate_limited",
      lastErrorAt: "2026-09-21T11:00:00.000Z",
    },
    totals: { recordCount: 1234, typesGranted: 5, typesDenied: 1 },
    ...overrides,
  };
}

const PAIRED: PairedDeviceDto = {
  device: device({ id: "dev-2", name: "New phone", status: "never", lastUploadAt: null }),
  pairing: JSON.stringify({
    v: 1,
    url: "https://healthy.example.test",
    deviceId: "dev-2",
    token: "hcd1.SYNTHETICDEVICEID0000000000.synthetic-secret-synthetic-secret-00000",
  }),
};

const COVERAGE: DeviceCoverageRowDto[] = [
  {
    recordType: "HeartRate",
    permission: "granted",
    recordCount: 900,
    firstAt: "2026-08-01T00:00:00.000Z",
    lastAt: "2026-09-21T11:00:00.000Z",
    lastUploadAt: "2026-09-21T11:50:00.000Z",
    tokenAgeS: 30,
    backlog: 4,
    backfillComplete: false,
    backfillOldestAt: null,
    status: "ok",
    notice: null,
    ageHours: null,
  },
  {
    recordType: "Sleep",
    permission: "granted",
    recordCount: 0,
    firstAt: null,
    lastAt: null,
    lastUploadAt: "2026-09-21T11:50:00.000Z",
    tokenAgeS: null,
    backlog: null,
    backfillComplete: true,
    backfillOldestAt: null,
    status: "ok",
    notice: null,
    ageHours: null,
  },
  {
    recordType: "Weight",
    permission: "denied",
    recordCount: 0,
    firstAt: null,
    lastAt: null,
    lastUploadAt: null,
    tokenAgeS: null,
    backlog: null,
    backfillComplete: false,
    backfillOldestAt: null,
    status: "unsupported",
    notice: "Reading this record type is not permitted: it has not been granted.",
    ageHours: null,
  },
];

const LOG: DeviceIngestLogDto[] = [
  {
    receivedAt: "2026-09-21T11:50:00.000Z",
    appliedAt: "2026-09-21T11:50:02.000Z",
    status: "applied",
    errorCode: null,
    upserts: 120,
    deletes: 3,
    rejected: 1,
    applied: 119,
    superseded: 1,
    removed: 3,
    bodyBytes: 2048,
    rawBytes: 20_000,
    applyMs: 412,
  },
  {
    receivedAt: "2026-09-21T11:35:00.000Z",
    appliedAt: null,
    status: "failed",
    errorCode: "apply_failed",
    upserts: 5,
    deletes: 0,
    rejected: 0,
    applied: 0,
    superseded: 0,
    removed: 0,
    bodyBytes: 300,
    rawBytes: 900,
    applyMs: null,
  },
];

interface Setup {
  devices?: DeviceDto[];
  /** What each action answers; omitted actions 404. */
  extra?: Record<string, (api: () => FakeFetch) => Response>;
}

async function mountView(setup: Setup = {}): Promise<{
  wrapper: ReturnType<typeof mount>;
  api: FakeFetch;
}> {
  const holder: { api: FakeFetch | null } = { api: null };
  const get = (): FakeFetch => {
    if (holder.api === null) throw new Error("api not installed");
    return holder.api;
  };
  const lastMethod = (): string | undefined => get().calls.at(-1)?.method;
  let list = setup.devices ?? [device()];

  holder.api = installFakeApi({
    "/api/settings": () => fakeResponse({ body: settings() }),
    "/api/phone/devices": () =>
      fakeResponse(lastMethod() === "POST" ? { status: 201, body: PAIRED } : { body: list }),
    "/api/phone/devices/dev-1": () => {
      list = list.map((d) => (d.id === "dev-1" ? { ...d, name: "Renamed phone" } : d));
      return fakeResponse({ body: list[0] });
    },
    "/api/phone/devices/dev-1/rotate": () => fakeResponse({ body: PAIRED }),
    "/api/phone/devices/dev-1/revoke": () => {
      list = list.map((d) => ({ ...d, status: "revoked" as const }));
      return fakeResponse({ body: list[0] });
    },
    "/api/phone/devices/dev-1/coverage": () => fakeResponse({ body: COVERAGE }),
    "/api/phone/devices/dev-1/ingest-log": () => fakeResponse({ body: LOG }),
    ...Object.fromEntries(
      Object.entries(setup.extra ?? {}).map(([path, make]) => [path, () => make(get)]),
    ),
  });
  const router = await testRouter("/phone");
  const wrapper = mount(PhoneView, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, api: get() };
}

function buttonNamed(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll("button").find((b) => b.text().includes(text));
  if (button === undefined) throw new Error(`no button "${text}"`);
  return button;
}

describe("PhoneView: the list", () => {
  it("shows each phone with its status, counts, queue and the phone's own report", async () => {
    const { wrapper } = await mountView();

    const text = wrapper.text();
    expect(text).toContain("Example phone");
    expect(text).toContain("active");
    expect(text).toContain("v0.1.7");
    expect(text).toContain("1,234");
    expect(text).toContain("5 granted");
    expect(text).toContain("1 denied");
    expect(text).toContain("2 batches");
    expect(text).toContain("hc_rate_limited");
    expect(text).toContain("Battery exemption");
  });

  it("says so when no phone is paired", async () => {
    const { wrapper } = await mountView({ devices: [] });

    expect(wrapper.text()).toContain("No phones are paired yet");
  });

  it("shows a phone that has never uploaded as such", async () => {
    const { wrapper } = await mountView({
      devices: [device({ status: "never", lastUploadAt: null, report: null })],
    });

    expect(wrapper.text()).toContain("never uploaded");
  });

  it("disables rotate and revoke for a revoked phone but still lets it be deleted", async () => {
    const { wrapper } = await mountView({
      devices: [device({ status: "revoked", revokedAt: "2026-09-21T10:00:00.000Z" })],
    });

    expect(buttonNamed(wrapper, "Rotate token").attributes("disabled")).toBeDefined();
    expect(buttonNamed(wrapper, "Revoke").attributes("disabled")).toBeDefined();
    expect(buttonNamed(wrapper, "Delete phone and data").attributes("disabled")).toBeUndefined();
  });

  it("points at the install link and the setup guide", async () => {
    const { wrapper } = await mountView();

    expect(wrapper.text()).toContain("obtainium://add/https://github.com/pmaxhogan/healthy");
    expect(wrapper.text()).toContain("docs/setup-android.md");
  });
});

describe("PhoneView: pairing", () => {
  it("shows the QR code, the token and a shown-once warning, then forgets them on Done", async () => {
    const { wrapper, api } = await mountView();

    await wrapper.find("input").setValue("  New phone ");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    const post = api.calls.find((call) => call.method === "POST");
    expect(post?.url).toBe("/api/phone/devices");
    expect(JSON.parse(post?.body ?? "null")).toStrictEqual({ name: "New phone" });
    expect(post?.headers.get("x-healthy-csrf")).toBe("1");

    expect(wrapper.text()).toContain("Shown once");
    const svg = wrapper.find("svg[role='img']");
    expect(svg.exists()).toBe(true);
    expect(svg.find("path").attributes("d")?.length).toBeGreaterThan(100);
    // The paste box in the app wants the whole pairing code, so that is what is shown.
    const codeField = wrapper.find<HTMLTextAreaElement>("textarea.pairing-code");
    expect(codeField.element.value).toBe(PAIRED.pairing);
    expect(codeField.attributes("readonly")).toBeDefined();
    expect(wrapper.find("input.token").exists()).toBe(false);
    expect(wrapper.text()).toContain("Copy pairing code");
    // The form is hidden while the panel is up: one "Pair a phone" heading at most.
    expect(wrapper.findAll("h2").filter((h) => h.text() === "Pair a phone")).toHaveLength(0);
    // The list was reloaded behind the panel.
    expect(
      api.calls.filter((call) => call.url === "/api/phone/devices" && call.method === "GET"),
    ).toHaveLength(2);

    await buttonNamed(wrapper, "I have paired the phone").trigger("click");

    expect(wrapper.find("textarea.pairing-code").exists()).toBe(false);
    expect(wrapper.findAll("h2").some((h) => h.text() === "Pair a phone")).toBe(true);
    expect(wrapper.find("svg[role='img']").exists()).toBe(false);
    expect(wrapper.html()).not.toContain("synthetic-secret");
  });

  it("does not leak the token into a toast", async () => {
    const { wrapper } = await mountView();

    await wrapper.find("input").setValue("New phone");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(JSON.stringify(toasts)).not.toContain("synthetic-secret");
  });

  it("will not submit a blank name", async () => {
    const { wrapper, api } = await mountView();

    await wrapper.find("input").setValue(" ".repeat(3));

    expect(buttonNamed(wrapper, "Pair a phone").attributes("disabled")).toBeDefined();
    await wrapper.find("form").trigger("submit");
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("PhoneView: actions", () => {
  it("rotates after confirmation and shows the new token once", async () => {
    const { wrapper, api } = await mountView();

    await buttonNamed(wrapper, "Rotate token").trigger("click");
    expect(wrapper.find("[role='dialog']").exists()).toBe(true);
    expect(api.calls.some((call) => call.url.endsWith("/rotate"))).toBe(false);
    await wrapper.find("[role='dialog'] button.confirm").trigger("click");
    await flushPromises();

    const rotate = api.calls.find((call) => call.url === "/api/phone/devices/dev-1/rotate");
    expect(rotate?.method).toBe("POST");
    expect(wrapper.find<HTMLTextAreaElement>("textarea.pairing-code").element.value).toBe(
      PAIRED.pairing,
    );
    expect(wrapper.find("[role='dialog']").exists()).toBe(false);
  });

  it("revokes after confirmation and reloads", async () => {
    const { wrapper, api } = await mountView();

    await buttonNamed(wrapper, "Revoke").trigger("click");
    await wrapper.find("[role='dialog'] button.confirm").trigger("click");
    await flushPromises();

    expect(api.calls.find((call) => call.url === "/api/phone/devices/dev-1/revoke")?.method).toBe(
      "POST",
    );
    expect(wrapper.text()).toContain("revoked");
  });

  it("cancels without calling anything", async () => {
    const { wrapper, api } = await mountView();

    await buttonNamed(wrapper, "Revoke").trigger("click");
    await buttonNamed(wrapper, "Cancel").trigger("click");

    expect(wrapper.find("[role='dialog']").exists()).toBe(false);
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("renames", async () => {
    const { wrapper, api } = await mountView();

    await buttonNamed(wrapper, "Rename").trigger("click");
    const field = wrapper.findAll("input").find((input) => input.element.value === "Example phone");
    await field?.setValue("Renamed phone");
    await wrapper.findAll("form")[1]?.trigger("submit");
    await flushPromises();

    const patch = api.calls.find((call) => call.method === "PATCH");
    expect(patch?.url).toBe("/api/phone/devices/dev-1");
    expect(JSON.parse(patch?.body ?? "null")).toStrictEqual({ name: "Renamed phone" });
    expect(wrapper.text()).toContain("Renamed phone");
  });

  it("makes the owner type the phone's name before wiping, then sends the id until it is done", async () => {
    let calls = 0;
    const { wrapper, api } = await mountView({
      extra: {
        "/api/phone/devices/dev-1/wipe": () => {
          calls += 1;
          return fakeResponse({ body: { done: calls >= 3 } });
        },
      },
    });

    await buttonNamed(wrapper, "Delete phone and data").trigger("click");
    const confirm = wrapper.find("[role='dialog'] button.confirm");
    expect(confirm.attributes("disabled")).toBeDefined();

    await wrapper.find("[role='dialog'] input").setValue("Example");
    expect(wrapper.find("[role='dialog'] button.confirm").attributes("disabled")).toBeDefined();
    await wrapper.find("[role='dialog'] input").setValue("Example phone");
    expect(wrapper.find("[role='dialog'] button.confirm").attributes("disabled")).toBeUndefined();
    await wrapper.find("[role='dialog'] button.confirm").trigger("click");
    await flushPromises();

    const wipes = api.calls.filter((call) => call.url === "/api/phone/devices/dev-1/wipe");
    expect(wipes).toHaveLength(3);
    for (const wipe of wipes) {
      expect(wipe.method).toBe("POST");
      expect(JSON.parse(wipe.body ?? "null")).toStrictEqual({ confirm: "dev-1" });
    }
    expect(wrapper.find("[role='dialog']").exists()).toBe(false);
  });
});

describe("PhoneView: details", () => {
  it("loads the coverage table and the ingest log when opened, and not before", async () => {
    const { wrapper, api } = await mountView();
    expect(api.calls.some((call) => call.url.endsWith("/coverage"))).toBe(false);

    await buttonNamed(wrapper, "Show details").trigger("click");
    await flushPromises();

    expect(api.calls.some((call) => call.url === "/api/phone/devices/dev-1/coverage")).toBe(true);
    expect(api.calls.some((call) => call.url === "/api/phone/devices/dev-1/ingest-log")).toBe(true);
    const text = wrapper.text();
    expect(text).toContain("HeartRate");
    expect(text).toContain("900");
    expect(text).toContain("Permitted, no data.");
    expect(text).toContain("not permitted");
    expect(text).toContain("unsupported");
    expect(text).toContain("apply_failed");
    expect(text).toContain("412 ms");
    expect(text).toContain("2.0 KB");

    const headers = wrapper.findAll("th").map((th) => th.text());
    for (const column of ["Type", "Permission", "Records", "First", "Last", "Backlog", "Status"]) {
      expect(headers).toContain(column);
    }
  });

  it("shows an empty coverage table as such", async () => {
    const { wrapper } = await mountView({
      extra: {
        "/api/phone/devices/dev-1/coverage": () => fakeResponse({ body: [] }),
        "/api/phone/devices/dev-1/ingest-log": () => fakeResponse({ body: [] }),
      },
    });

    await buttonNamed(wrapper, "Show details").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("has not reported any record types");
    expect(wrapper.text()).toContain("Nothing has been uploaded yet");
  });
});

describe("PhoneView: parked uploads", () => {
  const parked = device({ parked: { batches: 2, bytes: 4096, errorCodes: ["apply_failed"] } });

  it("warns, names the error code, and retries", async () => {
    const { wrapper, api } = await mountView({
      devices: [parked],
      extra: {
        "/api/phone/devices/dev-1/retry-failed": () =>
          fakeResponse({ body: { requeued: 2, remarked: 1 } }),
      },
    });

    expect(wrapper.find(".parked").text()).toContain(
      "2 uploads could not be applied and are being kept",
    );
    expect(wrapper.find(".parked").text()).toContain("apply_failed");
    await buttonNamed(wrapper, "Retry").trigger("click");
    await flushPromises();

    const call = api.calls.find((c) => c.url.endsWith("/retry-failed"));
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("x-healthy-csrf")).toBe("1");
  });

  it("shows parked rebuilds and says what Retry put back", async () => {
    const { wrapper, api } = await mountView({
      devices: [device({ parkedMarks: 3 })],
      extra: {
        "/api/phone/devices/dev-1/retry-failed": () =>
          fakeResponse({ body: { requeued: 0, remarked: 3 } }),
      },
    });

    expect(wrapper.find(".parked").text()).toContain("3 summary rebuilds could not run");
    expect(wrapper.find(".parked").text()).not.toContain("uploads could not");
    await buttonNamed(wrapper, "Retry").trigger("click");
    await flushPromises();

    expect(api.calls.some((c) => c.url.endsWith("/retry-failed"))).toBe(true);
    expect(JSON.stringify(toasts)).toContain("3 rebuilds put back in the queue");
  });

  it("shows the exercise-route permission in the phone's report", async () => {
    const { wrapper } = await mountView();

    expect(wrapper.text()).toContain("Exercise routes");
    expect(wrapper.text()).toContain("denied");
  });

  it("omits the exercise-route row when the phone has not reported it", async () => {
    const base = device();
    const { wrapper } = await mountView({
      devices: [{ ...base, report: base.report && { ...base.report, exerciseRoutes: null } }],
    });

    expect(wrapper.text()).not.toContain("Exercise routes");
  });

  it("shows no warning when nothing is parked", async () => {
    const { wrapper } = await mountView();

    expect(wrapper.find(".parked").exists()).toBe(false);
  });
});

describe("PhoneView: page with data", () => {
  const unavailable: DeviceCoverageRowDto = {
    ...COVERAGE[2]!,
    recordType: "Vo2Max",
    permission: "unavailable",
    notice: "This record type is not available on this phone: it is not offered.",
  };
  const stale: DeviceCoverageRowDto = {
    ...COVERAGE[0]!,
    recordType: "Steps",
    status: "stale",
    ageHours: 9,
  };

  async function openDetails() {
    const mounted = await mountView({
      devices: [device({ status: "stale" })],
      extra: {
        "/api/phone/devices/dev-1/coverage": () =>
          fakeResponse({ body: [...COVERAGE, unavailable, stale] }),
      },
    });
    await buttonNamed(mounted.wrapper, "Show details").trigger("click");
    await flushPromises();
    return mounted;
  }

  it("renders denied, unavailable and stale types and a failed upload", async () => {
    const { wrapper } = await openDetails();
    const text = wrapper.text();

    expect(text).toContain("stale");
    expect(text).toContain("not permitted");
    expect(text).toContain("not available on this phone");
    expect(text).toContain("No upload for 9 h.");
    expect(text).toContain("apply_failed");
    expect(text).toContain("2 batches");
  });

  it("keeps wide tables inside their own scroll container and wraps long text", async () => {
    const { wrapper } = await openDetails();

    const tables = wrapper.findAll("table");
    expect(tables).toHaveLength(2);
    for (const table of tables) expect(table.element.parentElement?.className).toBe("table-wrap");
    expect(wrapper.find("code.link").exists()).toBe(true);
  });

  it("keeps Details open across a rename and its refresh", async () => {
    const { wrapper } = await openDetails();

    await buttonNamed(wrapper, "Rename").trigger("click");
    await wrapper.findAll("form")[1]?.find("input").setValue("Renamed phone");
    await wrapper.findAll("form")[1]?.trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("Renamed phone");
    expect(wrapper.text()).toContain("Recent uploads");
  });

  it("gives a long name a title so an ellipsis can be read in full", async () => {
    const long = "A very long phone name ".repeat(5).trim();
    const { wrapper } = await mountView({ devices: [device({ name: long })] });

    expect(wrapper.find("h3.name").attributes("title")).toBe(long);
  });

  it("copies the Obtainium link", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    const { wrapper } = await mountView();

    await buttonNamed(wrapper, "Copy link").trigger("click");
    await flushPromises();

    expect(written).toStrictEqual(["obtainium://add/https://github.com/pmaxhogan/healthy"]);
  });

  it("returns focus to the button that opened a dialog when it closes", async () => {
    const { wrapper } = await mountView();
    const host = document.createElement("div");
    document.body.append(host);
    const attached = mount(PhoneView, {
      attachTo: host,
      global: { plugins: [await testRouter("/phone")] },
    });
    await flushPromises();

    const revoke = attached.findAll("button").find((b) => b.text() === "Revoke");
    (revoke?.element as HTMLButtonElement).focus();
    await revoke?.trigger("click");
    expect(attached.find("[role='dialog']").exists()).toBe(true);
    await attached.find("[role='dialog']").trigger("keydown", { key: "Escape" });
    await flushPromises();

    expect(attached.find("[role='dialog']").exists()).toBe(false);
    expect(document.activeElement).toBe(revoke?.element);
    attached.unmount();
    host.remove();
    wrapper.unmount();
  });
});
