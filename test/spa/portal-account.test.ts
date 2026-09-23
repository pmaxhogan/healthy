// PortalAccountCard covers the wave B2 admin UI: saving a login, starting a
// sign-in and watching it through the emailed-code round trip, and the two
// destructive actions. `GET`, `PUT` and `DELETE` (remove) all share the exact
// path `/api/providers/prov-1/portal`, so `installPortal` below branches on
// the method of the *last recorded call* rather than registering three routes
// that `installFakeApi` (which keys on path only) could not tell apart.
//
// Saving is two calls, deliberately: Save probes (`POST .../portal/discover`),
// the card shows the origin the probe landed on, and only Confirm sends the PUT
// with that origin echoed back. The origin the chain settles on is where the
// owner's portal password gets POSTed, so a human agrees to it first -- see
// `worker/api/routes/portal.ts`. The one exception is a password change against
// the origin already stored, which needs no probe.

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { codeMessage } from "../../src/api/client.ts";
import PortalAccountCard from "../../src/components/PortalAccountCard.vue";
import { toasts } from "../../src/lib/toasts.ts";

import { fakeResponse, installFakeApi, portalAccount } from "./helpers.ts";

import type { FakeFetch } from "./helpers.ts";
import type {
  PortalAccountStatusDto,
  PortalDiscoveryDto,
  PortalSignInPhase,
} from "@shared/types.ts";

const PORTAL_PATH = "/api/providers/prov-1/portal";

interface PortalRoutes {
  /** Answers every GET; `n` is the 1-based count of GETs served so far. */
  get?: (n: number) => PortalAccountStatusDto;
  put?: () => Response;
  signIn?: () => Response;
  discover?: () => Response;
}

/** What the fake `POST .../portal/discover` reports unless a test says otherwise. */
const DISCOVERED: PortalDiscoveryDto = {
  origin: "https://portal.example.test",
  mountPath: "/MyChart/",
  flavor: "classic",
};

function installPortal(routes: PortalRoutes = {}): FakeFetch {
  let loadCount = 0;
  // `api` is read inside these handlers only once they are actually invoked
  // (on a later, real fetch call), by which point `installFakeApi` below has
  // long since returned -- so the self-reference below is safe despite
  // textually preceding the assignment.
  const api: FakeFetch = installFakeApi({
    [PORTAL_PATH]: () => {
      const method = api.calls.at(-1)?.method;
      if (method === "PUT")
        return (routes.put ?? (() => fakeResponse({ body: portalAccount() })))();
      if (method === "DELETE") return fakeResponse({ status: 204 });
      loadCount += 1;
      return fakeResponse({ body: routes.get ? routes.get(loadCount) : portalAccount() });
    },
    [`${PORTAL_PATH}/sign-in`]: () =>
      (
        routes.signIn ??
        (() => fakeResponse({ status: 202, body: { accepted: true, started: true } }))
      )(),
    [`${PORTAL_PATH}/discover`]: () =>
      (routes.discover ?? (() => fakeResponse({ body: DISCOVERED })))(),
    [`${PORTAL_PATH}/session`]: () => fakeResponse({ status: 204 }),
    [`${PORTAL_PATH}/sync`]: () => fakeResponse({ status: 202, body: { accepted: true } }),
  });
  return api;
}

function mountCard(portalUrl: string | null = null): ReturnType<typeof mount> {
  return mount(PortalAccountCard, { props: { providerId: "prov-1", portalUrl } });
}

async function mountLoaded(routes: PortalRoutes = {}): Promise<{
  wrapper: ReturnType<typeof mount>;
  api: FakeFetch;
}> {
  const api = installPortal(routes);
  const wrapper = mountCard();
  await flushPromises();
  return { wrapper, api };
}

/** Every GET call recorded, in order. */
function getCallCount(api: FakeFetch): number {
  return api.calls.filter((call) => call.url === PORTAL_PATH && call.method === "GET").length;
}

/**
 * GET #n's response, by 1-based call order: #1 is the initial load.
 *
 * `signInCode` is `PortalSignInState.code` -- the stable failure code the
 * sign-in runner attaches once `phase` reaches `"failed"` -- not the emailed
 * 2FA code, which never leaves the Worker.
 */
function phaseSequence(phases: PortalSignInPhase[], signInCode: string | null = null) {
  return (n: number): PortalAccountStatusDto =>
    portalAccount({
      hasCredentials: true,
      signIn: {
        phase: phases[Math.min(n - 1, phases.length - 1)] ?? "idle",
        code: n >= phases.length ? signInCode : null,
        startedAt: null,
        updatedAt: null,
      },
    });
}

/** Click a button by its exact label. */
async function click(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
  await wrapper
    .findAll("button")
    .find((b) => b.text() === label)
    ?.trigger("click");
  await flushPromises();
}

/** The body of the one PUT the card sent, parsed. */
function putBody(api: FakeFetch): Record<string, unknown> {
  const put = api.calls.find((call) => call.url === PORTAL_PATH && call.method === "PUT");
  return JSON.parse(put?.body ?? "null") as Record<string, unknown>;
}

/** Fill the credential fields a save needs. */
async function fillLogin(
  wrapper: ReturnType<typeof mount>,
  extra: { baseUrl?: string; mfaContact?: string; otpSenderDomain?: string } = {},
): Promise<void> {
  if (extra.baseUrl !== undefined) await wrapper.find('input[type="url"]').setValue(extra.baseUrl);
  await wrapper.find("input[autocomplete='username']").setValue("alice");
  await wrapper.find('input[type="password"]').setValue("hunter2");
  if (extra.mfaContact !== undefined) {
    await wrapper.find('input[type="email"]').setValue(extra.mfaContact);
  }
  if (extra.otpSenderDomain !== undefined) {
    await wrapper.find('input[name="otpSenderDomain"]').setValue(extra.otpSenderDomain);
  }
}

async function clickSignIn(wrapper: ReturnType<typeof mount>): Promise<void> {
  const button = wrapper.findAll("button").find((b) => b.text().includes("Sign in now"));
  await button?.trigger("click");
  await flushPromises();
}

describe("PortalAccountCard: state badge", () => {
  it.each([
    ["none", { state: "none", hasCredentials: false, hasSession: false } as const, "none"],
    ["active", { state: "active" } as const, "active"],
    ["needs re-auth", { state: "needs_reauth" } as const, "needs re-auth"],
  ] as const)("shows %s", async (_label, overrides, expected) => {
    const { wrapper } = await mountLoaded({ get: () => portalAccount(overrides) });
    expect(wrapper.find(".chip").text()).toBe(expected);
  });

  it("shows 'signing in…' while the phase is in progress, overriding the underlying state", async () => {
    const { wrapper } = await mountLoaded({
      get: () =>
        portalAccount({
          state: "none",
          signIn: { phase: "awaiting_code", code: null, startedAt: null, updatedAt: null },
        }),
    });
    expect(wrapper.find(".chip").text()).toBe("signing in…");
  });
});

describe("PortalAccountCard: credentials", () => {
  it("never shows a stored username or password back, only that one is stored", async () => {
    const { wrapper } = await mountLoaded({
      get: () => portalAccount({ hasCredentials: true }),
    });

    expect((wrapper.find("input[autocomplete='username']").element as HTMLInputElement).value).toBe(
      "",
    );
    expect((wrapper.find('input[type="password"]').element as HTMLInputElement).value).toBe("");
    expect(wrapper.text()).toContain("stored");
  });

  it("says not set when there is no saved login yet", async () => {
    const { wrapper } = await mountLoaded({
      get: () => portalAccount({ hasCredentials: false }),
    });
    expect(wrapper.text()).toContain("not set");
  });

  it("prefills the base URL from the account when one is discovered", async () => {
    const { wrapper } = await mountLoaded({
      get: () => portalAccount({ baseUrl: "https://portal.saved.test" }),
    });
    expect((wrapper.find('input[type="url"]').element as HTMLInputElement).value).toBe(
      "https://portal.saved.test",
    );
  });

  it("falls back to the provider's own portal URL when the account has none yet", async () => {
    installPortal({ get: () => portalAccount({ baseUrl: null }) });
    const wrapper = mountCard("https://portal.fromprovider.test");
    await flushPromises();
    expect((wrapper.find('input[type="url"]').element as HTMLInputElement).value).toBe(
      "https://portal.fromprovider.test",
    );
  });

  it("disables Save until both a username and a password are entered", async () => {
    const { wrapper } = await mountLoaded();
    const saveButton = wrapper.findAll("button").find((b) => b.text() === "Save");
    expect(saveButton?.attributes("disabled")).toBeDefined();

    await wrapper.find("input[autocomplete='username']").setValue("alice");
    expect(saveButton?.attributes("disabled")).toBeDefined();

    await wrapper.find('input[type="password"]').setValue("hunter2");
    expect(saveButton?.attributes("disabled")).toBeUndefined();
  });

  it("probes first, shows where the portal is, and PUTs nothing until Confirm", async () => {
    const { wrapper, api } = await mountLoaded({ get: () => portalAccount({ baseUrl: null }) });

    await fillLogin(wrapper, { baseUrl: "https://portal.example.test" });
    await click(wrapper, "Save");

    // Step one: a probe, and no credential anywhere near it.
    const discover = api.calls.find((call) => call.url === `${PORTAL_PATH}/discover`);
    expect(discover?.method).toBe("POST");
    expect(JSON.parse(discover?.body ?? "null")).toEqual({
      baseUrl: "https://portal.example.test",
    });
    expect(api.calls.some((call) => call.method === "PUT")).toBe(false);
    expect(wrapper.text()).toContain("Portal found at");
    expect(wrapper.text()).toContain("https://portal.example.test");
    expect(wrapper.text()).toContain("classic");

    // Step two: the owner agrees to that origin, and only now is anything stored.
    await click(wrapper, "Confirm and save");

    const put = api.calls.find((call) => call.url === PORTAL_PATH && call.method === "PUT");
    expect(put?.headers.get("x-healthy-csrf")).toBe("1");
    expect(putBody(api)).toEqual({
      username: "alice",
      password: "hunter2",
      baseUrl: "https://portal.example.test",
      confirmedOrigin: "https://portal.example.test",
    });
    expect((wrapper.find('input[type="password"]').element as HTMLInputElement).value).toBe("");
    expect(toasts.map((t) => t.text)).toContain("Portal login saved.");
    // The confirmation line goes with it: there is nothing left to confirm.
    expect(wrapper.text()).not.toContain("Portal found at");
  });

  it("confirms the origin the probe reported, not the one that was typed", async () => {
    // Discovery follows redirects, so these two genuinely differ -- and the one
    // that matters is where the password will be sent.
    const { wrapper, api } = await mountLoaded({
      get: () => portalAccount({ baseUrl: null }),
      discover: () =>
        fakeResponse({ body: { ...DISCOVERED, origin: "https://real.example.test" } }),
    });

    await fillLogin(wrapper, { baseUrl: "https://vanity.example.test" });
    await click(wrapper, "Save");
    expect(wrapper.text()).toContain("https://real.example.test");
    await click(wrapper, "Confirm and save");

    expect(putBody(api).confirmedOrigin).toBe("https://real.example.test");
  });

  it("skips the probe and saves straight away when only the password is changing", async () => {
    const { wrapper, api } = await mountLoaded({
      get: () => portalAccount({ baseUrl: "https://portal.saved.test" }),
    });

    await fillLogin(wrapper);
    await click(wrapper, "Save");

    // Re-probing a portal already stored is several unauthenticated requests to a
    // host with bot protection, for an answer the owner already confirmed.
    expect(api.calls.some((call) => call.url === `${PORTAL_PATH}/discover`)).toBe(false);
    expect(putBody(api)).toEqual({
      username: "alice",
      password: "hunter2",
      baseUrl: "https://portal.saved.test",
      confirmedOrigin: "https://portal.saved.test",
    });
  });

  it("omits baseUrl from the payload when it is left blank", async () => {
    const { wrapper, api } = await mountLoaded({ get: () => portalAccount({ baseUrl: null }) });

    await fillLogin(wrapper);
    await click(wrapper, "Save");
    await click(wrapper, "Confirm and save");

    expect(Object.keys(putBody(api)).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "confirmedOrigin",
      "password",
      "username",
    ]);
  });

  it("includes mfaContact in the payload when filled, and omits it when blank", async () => {
    const { wrapper, api } = await mountLoaded({ get: () => portalAccount({ baseUrl: null }) });

    await fillLogin(wrapper, { mfaContact: "owner@example.test" });
    await click(wrapper, "Save");
    await click(wrapper, "Confirm and save");

    expect(putBody(api)).toEqual({
      username: "alice",
      password: "hunter2",
      confirmedOrigin: DISCOVERED.origin,
      mfaContact: "owner@example.test",
    });
  });

  it("includes otpSenderDomain when filled, and says whether one is stored", async () => {
    const { wrapper, api } = await mountLoaded({
      get: () => portalAccount({ baseUrl: null, hasOtpSender: false }),
    });

    expect(wrapper.text()).toContain("Sender of your verification-code emails");

    await fillLogin(wrapper, { otpSenderDomain: "mail.example.test" });
    await click(wrapper, "Save");
    await click(wrapper, "Confirm and save");

    expect(putBody(api)).toEqual({
      username: "alice",
      password: "hunter2",
      confirmedOrigin: DISCOVERED.origin,
      otpSenderDomain: "mail.example.test",
    });
  });

  it("never shows the stored sender domain back, only that one is stored", async () => {
    // A sending domain names the health system, so the DTO reports a boolean and
    // the field stays blank -- exactly like the MFA contact beside it.
    const { wrapper } = await mountLoaded({
      get: () => portalAccount({ hasOtpSender: true }),
    });

    const input = wrapper.find('input[name="otpSenderDomain"]');
    expect((input.element as HTMLInputElement).value).toBe("");
    expect(wrapper.text()).toContain("stored");
  });

  it("omits mfaContact from the payload when it is left blank", async () => {
    const { wrapper, api } = await mountLoaded({ get: () => portalAccount({ baseUrl: null }) });

    await fillLogin(wrapper);
    await click(wrapper, "Save");
    await click(wrapper, "Confirm and save");

    expect(putBody(api).mfaContact).toBeUndefined();
  });

  it("stores nothing when the probe fails, and offers no Confirm", async () => {
    const { wrapper, api } = await mountLoaded({
      get: () => portalAccount({ baseUrl: null }),
      // Message equal to the code, as `worker/api/http.ts` answers when there is
      // nothing safe to add: `errorMessage` then reaches for the mapped sentence.
      discover: () =>
        fakeResponse({
          status: 400,
          body: { error: "portal_redirected_offsite", message: "portal_redirected_offsite" },
        }),
    });

    await fillLogin(wrapper, { baseUrl: "https://vanity.example.test" });
    await click(wrapper, "Save");

    expect(api.calls.some((call) => call.method === "PUT")).toBe(false);
    expect(wrapper.findAll("button").some((b) => b.text() === "Confirm and save")).toBe(false);
    // `useAction` surfaces a failure as a toast, so that is where the mapped
    // sentence for the new code lands.
    expect(toasts.map((t) => t.text).join(" ")).toContain("different site");
  });

  it("drops a pending confirmation as soon as the base URL is edited again", async () => {
    const { wrapper } = await mountLoaded({ get: () => portalAccount({ baseUrl: null }) });

    await fillLogin(wrapper, { baseUrl: "https://portal.example.test" });
    await click(wrapper, "Save");
    expect(wrapper.text()).toContain("Portal found at");

    // The origin on screen would no longer be the one being agreed to.
    await wrapper.find('input[type="url"]').setValue("https://elsewhere.example.test");
    await flushPromises();
    expect(wrapper.text()).not.toContain("Portal found at");
  });
});

describe("PortalAccountCard: sign-in polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls every 3 s through the phases to signed_in, then stops", async () => {
    const { wrapper, api } = await mountLoaded({
      get: phaseSequence(["idle", "logging_in", "awaiting_code", "validating", "signed_in"]),
    });

    await clickSignIn(wrapper);
    expect(getCallCount(api)).toBe(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(wrapper.text()).toContain("Signing in…");
    expect(getCallCount(api)).toBe(2);

    await vi.advanceTimersByTimeAsync(3000);
    expect(wrapper.text()).toContain(
      "Waiting for the emailed code — it arrives via your Gmail forwarding filter",
    );

    await vi.advanceTimersByTimeAsync(3000);
    expect(wrapper.text()).toContain("Checking the code…");

    await vi.advanceTimersByTimeAsync(3000);
    expect(wrapper.text()).toContain("Signed in");
    expect(getCallCount(api)).toBe(5);

    // Stopped: a run past the terminal phase does not poll again.
    await vi.advanceTimersByTimeAsync(9000);
    expect(getCallCount(api)).toBe(5);
  });

  it("polls through to a failure, showing the mapped error message, then stops", async () => {
    const { wrapper, api } = await mountLoaded({
      get: phaseSequence(["idle", "logging_in", "failed"], "portal_2fa_rejected"),
    });

    await clickSignIn(wrapper);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(wrapper.text()).toContain(`Failed: ${codeMessage("portal_2fa_rejected")}`);
    const callsAtFailure = getCallCount(api);

    await vi.advanceTimersByTimeAsync(9000);
    expect(getCallCount(api)).toBe(callsAtFailure);
  });

  it("does not offer Sign in now without a saved login", async () => {
    const { wrapper } = await mountLoaded({ get: () => portalAccount({ hasCredentials: false }) });
    const button = wrapper.findAll("button").find((b) => b.text().includes("Sign in now"));
    expect(button?.attributes("disabled")).toBeDefined();
  });
});

describe("PortalAccountCard: sync, forget and remove", () => {
  it("posts a manual sync", async () => {
    const { wrapper, api } = await mountLoaded();
    const button = wrapper.findAll("button").find((b) => b.text() === "Sync upcoming now");
    await button?.trigger("click");
    await flushPromises();

    const call = api.calls.find((c) => c.url === `${PORTAL_PATH}/sync`);
    expect(call?.method).toBe("POST");
    expect(toasts.map((t) => t.text)).toContain("Portal sync started.");
  });

  it("asks for confirmation before forgetting the session, and disables the button without one", async () => {
    const { wrapper: noSession } = await mountLoaded({
      get: () => portalAccount({ hasSession: false }),
    });
    expect(
      noSession
        .findAll("button")
        .find((b) => b.text() === "Forget session")
        ?.attributes("disabled"),
    ).toBeDefined();

    const { wrapper, api } = await mountLoaded({ get: () => portalAccount({ hasSession: true }) });
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Forget session")
      ?.trigger("click");

    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain("Forget this portal session?");
    await dialog.find("button.confirm").trigger("click");
    await flushPromises();

    expect(api.calls.some((c) => c.url === `${PORTAL_PATH}/session` && c.method === "DELETE")).toBe(
      true,
    );
    expect(toasts.map((t) => t.text)).toContain("Portal session forgotten.");
  });

  it("asks for confirmation before removing the login, and disables the button without one", async () => {
    const { wrapper: noCreds } = await mountLoaded({
      get: () => portalAccount({ hasCredentials: false }),
    });
    expect(
      noCreds
        .findAll("button")
        .find((b) => b.text() === "Remove login")
        ?.attributes("disabled"),
    ).toBeDefined();

    const { wrapper, api } = await mountLoaded({
      get: () => portalAccount({ hasCredentials: true }),
    });
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Remove login")
      ?.trigger("click");

    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.text()).toContain("Remove this portal login?");
    await dialog.find("button.confirm").trigger("click");
    await flushPromises();

    expect(api.calls.some((c) => c.url === PORTAL_PATH && c.method === "DELETE")).toBe(true);
    expect(toasts.map((t) => t.text)).toContain("Portal login removed.");
  });
});

describe("portal error codes: human messages", () => {
  it.each([
    ["portal_login_failed", "username or password"],
    ["portal_2fa_required", "emailed verification code"],
    ["portal_2fa_rejected", "wrong, expired, or already used"],
    ["portal_locked", "locked or disabled"],
    ["portal_bot_blocked", "automated traffic"],
    ["portal_session_expired", "signed this session out"],
    ["portal_parse_failed", "not in a shape"],
    ["portal_unreachable", "could not be reached"],
    ["portal_attempts_exhausted", "Too many sign-in attempts"],
    ["portal_discovery_failed", "Could not find MyChart"],
    ["portal_redirected_offsite", "different site"],
    ["portal_insecure_redirect", "not https"],
    ["portal_origin_unconfirmed", "no longer at the address you confirmed"],
  ])("maps %s to a human sentence", (code, fragment) => {
    expect(codeMessage(code)).toContain(fragment);
  });
});
