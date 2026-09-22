// The patient-portal pass, against real D1 and the in-memory Google Calendar.
//
// The portal itself is a fake adapter (`test/integration/portal/helpers.ts`) --
// what the real client does to real markup is `test/unit/providers/mychart/**`'s
// job. What matters here is everything the portal pass decides, and most of it is
// about *not* writing something twice:
//
//   - one upcoming visit, one event, and the row that proves where it came from
//   - a visit the FHIR pass already calendared is skipped, not duplicated
//   - an Encounter that turns up later takes over the portal's row and its event
//   - a visit that vanishes while it is ahead is a cancellation; one that vanishes
//     after its start time is simply over, and must not be ghosted
//   - a dead session costs exactly one sign-in, and a spent budget costs none

import { beforeEach, describe, expect, it } from "vitest";

import { setSetting } from "../../../worker/db/settings.ts";
import { AppError } from "../../../worker/lib/errors.ts";
import { runCalendarSync } from "../../../worker/sync/calendar-sync.ts";
import {
  PORTAL_ORIGIN,
  fakePortal,
  portalVisit,
  seedOtp,
  seedPortalAccount,
  spendAttempts,
} from "../portal/helpers.ts";

import {
  T0,
  encounter,
  fhirServer,
  organization,
  recordingLog,
  resetSyncDb,
  searchBundle,
  seedConnectedProvider,
  seedGoogle,
  seedSettings,
  stubUpstreams,
  syncCtx,
  syncRepos,
} from "./helpers.ts";

import type { FhirServer, SeededProvider, Upstreams } from "./helpers.ts";
import type { Ctx } from "../../../worker/db/client.ts";
import type { FakePortal } from "../portal/helpers.ts";
import type { RunSummary } from "@shared/types.ts";
import type * as fhir4 from "fhir/r4";

beforeEach(resetSyncDb);

const HOST = "fhir.a.example.test";
/** An hour ahead of the fixed clock, so a visit is unambiguously upcoming. */
const SOON = "2026-06-20T14:30:00+00:00";

interface Fixture {
  ctx: Ctx;
  provider: SeededProvider;
  portal: FakePortal;
  upstreams: Upstreams;
  server: FhirServer;
}

/** A connected provider, a Google account, settings, and an active portal account. */
async function fixture(options: { portal?: Partial<FakePortal> } = {}): Promise<Fixture> {
  const ctx = syncCtx();
  const provider = await seedConnectedProvider(ctx, { host: HOST });
  await seedGoogle(ctx);
  await seedSettings(ctx);
  await seedPortalAccount(ctx, provider.providerId);
  const server = fhirServer({ patientId: provider.patientId });
  return {
    ctx,
    provider,
    portal: fakePortal(options.portal),
    upstreams: stubUpstreams({ [HOST]: server }),
    server,
  };
}

/** The portal pass only: no FHIR search at all. What the manual button asks for. */
async function portalRun(fix: Fixture, portalOnly = true): Promise<RunSummary> {
  return runCalendarSync(fix.ctx, {
    trigger: "manual",
    ...(portalOnly && { portalOnly: true }),
    deps: { ...fix.upstreams.deps, portalAdapter: fix.portal.adapter },
  });
}

/** The keys of every event this app owns on the fake calendar, in insertion order. */
function calendarKeys(fix: Fixture): string[] {
  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Iterator#toArray is ES2025 and the test project compiles against the same ES2022 lib the Worker does.
  return [...fix.upstreams.calendar.byKey().keys()];
}

/** An Encounter at `start`, optionally publishing the portal's CSN. */
function appointment(id: string, start: string, csn?: string): fhir4.Encounter {
  const base = encounter({ id, start, visitType: "Office Visit" });
  return csn === undefined
    ? base
    : { ...base, identifier: [{ type: { text: "CSN" }, value: csn }] };
}

/** What the FHIR host answers with, plus the organisation its Encounters name. */
function withEncounters(fix: Fixture, encounters: readonly fhir4.Encounter[]): void {
  fix.server.encounters = searchBundle(encounters);
  fix.server.resources.set("Organization/org-1", organization("org-1", "Example Health"));
}

/** The `<providerId>:csn:<csn>` key a portal visit is calendared under. */
function portalKey(provider: SeededProvider, csn: string): string {
  return `${provider.providerId}:csn:${csn}`;
}

describe("portal visits on the calendar", () => {
  it("inserts one event per upcoming visit and records where it came from", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });

    const summary = await portalRun(fix);

    expect(summary.portalVisits).toBe(1);
    expect(summary.eventsInserted).toBe(1);
    expect(summary.portalErrors).toStrictEqual([]);
    const key = portalKey(fix.provider, "csn-1");
    const event = fix.upstreams.calendar.byKey().get(key);
    expect(event?.summary).toBe("Follow-up · A. Example, MD");
    expect(event?.visibility).toBe("private");

    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(key);
    expect(row?.source).toBe("portal");
    expect(row?.portal_csn).toBe("csn-1");
    expect(row?.state).toBe("active");
  });

  it("does nothing on a second run when nothing changed, then patches when something does", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);
    expect(fix.upstreams.calendar.inserts).toBe(1);

    const unchanged = await portalRun(fix);
    expect(unchanged.eventsInserted).toBe(0);
    expect(unchanged.eventsPatched).toBe(0);

    fix.portal.visits = [portalVisit({ csn: "csn-1", visitType: "Annual physical" })];
    const changed = await portalRun(fix);
    expect(changed.eventsPatched).toBe(1);
    expect(fix.upstreams.calendar.inserts).toBe(1);
    expect(fix.upstreams.calendar.byKey().get(portalKey(fix.provider, "csn-1"))?.summary).toBe(
      "Annual physical · A. Example, MD",
    );
  });

  it("ghosts a visit the portal reports as canceled, with its own details", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);

    fix.portal.visits = [portalVisit({ csn: "csn-1", status: "canceled" })];
    const summary = await portalRun(fix);

    expect(summary.eventsGhosted).toBe(1);
    const event = fix.upstreams.calendar.byKey().get(portalKey(fix.provider, "csn-1"));
    expect(event?.summary).toBe("Cancelled: Follow-up · A. Example, MD");
    expect(event?.transparency).toBe("transparent");
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(portalKey(fix.provider, "csn-1"));
    expect(row?.state).toBe("ghost");
  });

  it("never calendars a visit that is already canceled the first time it is seen", async () => {
    const fix = await fixture({
      portal: { visits: [portalVisit({ csn: "csn-1", status: "canceled" })] },
    });

    const summary = await portalRun(fix);

    // A ghost for something that was never on the calendar would invent history.
    expect(summary.eventsInserted).toBe(0);
    expect(summary.eventsGhosted).toBe(0);
    expect(calendarKeys(fix)).toStrictEqual([]);
  });

  it("restores a ghosted visit that the portal starts reporting again", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);
    fix.portal.visits = [portalVisit({ csn: "csn-1", status: "canceled" })];
    await portalRun(fix);

    fix.portal.visits = [portalVisit({ csn: "csn-1" })];
    const summary = await portalRun(fix);

    expect(summary.eventsRestored).toBe(1);
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(portalKey(fix.provider, "csn-1"));
    expect(row?.state).toBe("active");
    expect(fix.upstreams.calendar.byKey().get(portalKey(fix.provider, "csn-1"))?.summary).toBe(
      "Follow-up · A. Example, MD",
    );
  });

  it("ghosts the row, but not the calendar entry, when a future visit vanishes", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);
    const patchesBefore = fix.upstreams.calendar.patches;

    fix.portal.visits = [];
    const summary = await portalRun(fix);

    expect(summary.eventsGhosted).toBe(1);
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(portalKey(fix.provider, "csn-1"));
    expect(row?.state).toBe("ghost");
    // Nothing caches portal payloads, so there is no model to render a ghost from:
    // the row is marked and the entry the owner is looking at is left alone.
    expect(fix.upstreams.calendar.patches).toBe(patchesBefore);
    expect(fix.upstreams.calendar.byKey().get(portalKey(fix.provider, "csn-1"))?.summary).toBe(
      "Follow-up · A. Example, MD",
    );
  });

  it("leaves a visit alone once it is in the past and drops out of the list", async () => {
    // Just before the fixed clock: the portal only ever reports what is ahead, so
    // this one dropping out means it happened, not that it was cancelled.
    const past = "2026-06-15T11:00:00+00:00";
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1", start: past })] } });
    await portalRun(fix);

    fix.portal.visits = [];
    const summary = await portalRun(fix);

    expect(summary.eventsGhosted).toBe(0);
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(portalKey(fix.provider, "csn-1"));
    expect(row?.state).toBe("active");
  });
});

describe("portal visits that FHIR also knows about", () => {
  it("skips a portal visit the FHIR pass calendared at the same time", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1", start: SOON })] } });
    withEncounters(fix, [appointment("enc-1", SOON)]);

    const summary = await portalRun(fix, false);

    expect(summary.portalVisits).toBe(1);
    expect(summary.portalSkipped).toBe(1);
    expect(calendarKeys(fix)).toStrictEqual([`${fix.provider.providerId}:enc-1`]);
    const stray = await syncRepos(fix.ctx).calendarEvents.getByKey(
      portalKey(fix.provider, "csn-1"),
    );
    expect(stray).toBeNull();
  });

  it("leaves a portal row alone when the FHIR pass runs and has no Encounter for it", async () => {
    // The premise of the whole feature: the portal knows about a visit the FHIR
    // view does not return yet. The FHIR pass sees a row with no Encounter, and
    // must not read that as "vanished upstream" -- doing so ghosts the row, the
    // portal pass restores it, and the owner's event is patched twice an hour for
    // ever.
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1", start: SOON })] } });
    await portalRun(fix);
    const patchesBefore = fix.upstreams.calendar.patches;
    withEncounters(fix, []);

    const first = await portalRun(fix, false);
    const second = await portalRun(fix, false);

    for (const summary of [first, second]) {
      expect(summary.eventsGhosted).toBe(0);
      expect(summary.eventsRestored).toBe(0);
      expect(summary.eventsPatched).toBe(0);
    }
    expect(fix.upstreams.calendar.patches).toBe(patchesBefore);
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(portalKey(fix.provider, "csn-1"));
    expect(row?.state).toBe("active");
  });

  it("hands the portal's row and event to the Encounter that turns up later", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1", start: SOON })] } });
    await portalRun(fix);
    expect(fix.upstreams.calendar.inserts).toBe(1);

    // The Encounter appears, publishing the same CSN but a minute out: the CSN is
    // what matches, which is the point of preferring it over the clock.
    withEncounters(fix, [appointment("enc-1", "2026-06-20T14:31:00+00:00", "csn-1")]);
    const summary = await portalRun(fix, false);

    // One event, still the one the portal created.
    expect(fix.upstreams.calendar.inserts).toBe(1);
    expect(summary.eventsPatched).toBe(1);
    expect(calendarKeys(fix)).toStrictEqual([`${fix.provider.providerId}:enc-1`]);

    const repos = syncRepos(fix.ctx);
    const stray = await repos.calendarEvents.getByKey(portalKey(fix.provider, "csn-1"));
    expect(stray).toBeNull();
    const row = await repos.calendarEvents.getByKey(`${fix.provider.providerId}:enc-1`);
    expect(row?.source).toBe("fhir");
    expect(row?.portal_csn).toBeNull();
    expect(row?.state).toBe("active");
  });
});

describe("portal sessions", () => {
  it("signs in once with the emailed code when the stored session is dead", async () => {
    const fix = await fixture({
      portal: {
        alive: false,
        loginStatus: "awaiting_code",
        visits: [portalVisit({ csn: "csn-1" })],
      },
    });
    await seedOtp(fix.ctx, "424242");

    const summary = await portalRun(fix);

    expect(fix.portal.calls.logins).toBe(1);
    expect(fix.portal.calls.sendCodes).toBe(1);
    expect(fix.portal.submitted).toStrictEqual(["424242"]);
    expect(summary.eventsInserted).toBe(1);
    expect(summary.portalErrors).toStrictEqual([]);

    const account = await syncRepos(fix.ctx).portalAccounts.get(fix.provider.providerId);
    expect(account?.session_state).toBe("active");
    expect(account?.login_attempts_today).toBe(1);
    // The code is single use: nothing may claim it twice.
    const again = await syncRepos(fix.ctx).mailInbox.takeFreshOtp({ since: 0, now: T0 });
    expect(again).toBeNull();
  });

  it("passes the shell API base and the MFA contact to the adapter when signing in", async () => {
    const ctx = syncCtx();
    const provider = await seedConnectedProvider(ctx, { host: HOST });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    // Falls back to the setting: the account's own endpoint never learned one.
    await setSetting(ctx, "portal_api_base_path", "/api/shell/v1");
    await seedPortalAccount(ctx, provider.providerId, {
      mfaContact: "owner@example.test",
    });
    const portal = fakePortal({ alive: false, loginStatus: "awaiting_code" });
    await seedOtp(ctx, "135790");
    const upstreams = stubUpstreams({ [HOST]: fhirServer({ patientId: provider.patientId }) });

    await runCalendarSync(ctx, {
      trigger: "manual",
      portalOnly: true,
      deps: { ...upstreams.deps, portalAdapter: portal.adapter },
    });

    expect(portal.clientDeps.length).toBeGreaterThan(0);
    for (const deps of portal.clientDeps) {
      expect(deps.custom).toStrictEqual({
        apiBasePath: "/api/shell/v1",
        mfaContact: "owner@example.test",
      });
    }
  });

  it("prefers the endpoint's own API base over the settings fallback", async () => {
    const ctx = syncCtx();
    const provider = await seedConnectedProvider(ctx, { host: HOST });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    await setSetting(ctx, "portal_api_base_path", "/from/settings");
    await seedPortalAccount(ctx, provider.providerId, { apiBasePath: "/from/endpoint" });
    const portal = fakePortal({ alive: true, visits: [] });
    const upstreams = stubUpstreams({ [HOST]: fhirServer({ patientId: provider.patientId }) });

    await runCalendarSync(ctx, {
      trigger: "manual",
      portalOnly: true,
      deps: { ...upstreams.deps, portalAdapter: portal.adapter },
    });

    expect(portal.clientDeps.at(-1)?.custom?.apiBasePath).toBe("/from/endpoint");
  });

  it("marks the account and opens one reconnect card when the code never arrives", async () => {
    const ctx = syncCtx({ trello: true });
    const provider = await seedConnectedProvider(ctx, { host: HOST });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    await seedPortalAccount(ctx, provider.providerId);
    const portal = fakePortal({ alive: false, loginStatus: "awaiting_code" });
    const upstreams = stubUpstreams({ [HOST]: fhirServer({ patientId: provider.patientId }) });

    const summary = await runCalendarSync(ctx, {
      trigger: "manual",
      portalOnly: true,
      deps: { ...upstreams.deps, portalAdapter: portal.adapter },
    });

    expect(summary.portalErrors).toStrictEqual(["portal_2fa_required"]);
    // A portal that needs the owner is an expected state, not a failed run.
    expect(summary.errors).toStrictEqual([]);
    const account = await syncRepos(ctx).portalAccounts.get(provider.providerId);
    expect(account?.session_state).toBe("needs_reauth");
    expect(account?.last_error_code).toBe("portal_2fa_required");
    // `portal_2fa_required` is not one of the codes that raises a card: the owner
    // will see it on the Providers page, and a card per missing email would be noise.
    expect(upstreams.trelloCards).toStrictEqual([]);
  });

  it("refuses to sign in at all once the daily attempt budget is spent, and alerts", async () => {
    const ctx = syncCtx({ trello: true });
    const provider = await seedConnectedProvider(ctx, {
      host: HOST,
      displayName: "A Example Health",
    });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    await seedPortalAccount(ctx, provider.providerId);
    await spendAttempts(ctx, provider.providerId, 3);
    const portal = fakePortal({ alive: false });
    const upstreams = stubUpstreams({ [HOST]: fhirServer({ patientId: provider.patientId }) });

    const summary = await runCalendarSync(ctx, {
      trigger: "manual",
      portalOnly: true,
      deps: { ...upstreams.deps, portalAdapter: portal.adapter },
    });

    expect(portal.calls.logins).toBe(0);
    expect(summary.portalErrors).toStrictEqual(["portal_attempts_exhausted"]);
    const account = await syncRepos(ctx).portalAccounts.get(provider.providerId);
    expect(account?.session_state).toBe("needs_reauth");

    // The card names the portal, not the FHIR connection, and links to /providers.
    expect(upstreams.trelloCards).toHaveLength(1);
    expect(upstreams.trelloCards[0]?.name).toBe("Reconnect A Example Health MyChart to Healthy");
    expect(upstreams.trelloCards[0]?.desc).toContain("/providers");
    const alert = await syncRepos(ctx).alerts.getOpen(`portal:${provider.providerId}`);
    expect(alert).not.toBeNull();
  });

  it("isolates one portal's failure from the rest of the run", async () => {
    const fix = await fixture({
      portal: {
        visits: [portalVisit({ csn: "csn-1" })],
        loadError: new AppError("portal_bot_blocked", "a wall answered"),
      },
    });

    const summary = await portalRun(fix);

    expect(summary.portalErrors).toStrictEqual(["portal_bot_blocked"]);
    expect(summary.errors).toStrictEqual([]);
    expect(summary.eventsInserted).toBe(0);
  });

  it("skips an account that is not active, without touching the portal", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await syncRepos(fix.ctx).portalAccounts.markNeedsReauth(
      fix.provider.providerId,
      "portal_login_failed",
    );

    const summary = await portalRun(fix);

    expect(fix.portal.calls.sessionChecks).toBe(0);
    expect(summary.portalVisits).toBe(0);
    expect(summary.eventsInserted).toBe(0);
  });

  it("never logs the emailed code, the portal host or a visit", async () => {
    const fix = await fixture({
      portal: {
        alive: false,
        loginStatus: "awaiting_code",
        visits: [portalVisit({ csn: "csn-1" })],
      },
    });
    await seedOtp(fix.ctx, "424242");
    const { log, lines } = recordingLog();
    const ctx = { ...fix.ctx, log };

    await runCalendarSync(ctx, {
      trigger: "manual",
      portalOnly: true,
      deps: { ...fix.upstreams.deps, portalAdapter: fix.portal.adapter },
    });

    const all = lines.join("\n");
    expect(all).not.toContain("424242");
    expect(all).not.toContain(PORTAL_ORIGIN);
    expect(all).not.toContain("A. Example");
    expect(all).not.toContain("csn-1");
  });
});
