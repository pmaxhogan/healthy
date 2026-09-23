// The patient-portal pass, against real D1 and the in-memory Google Calendar.
//
// The portal itself is a fake adapter (`test/integration/portal/helpers.ts`) --
// what the real client does to real markup is `test/unit/ehr/mychart/**`'s
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

import { blindCsn } from "../../../worker/db/blind.ts";
import { setSetting } from "../../../worker/db/settings.ts";
import { AppError } from "../../../worker/lib/errors.ts";
import { runCalendarSync } from "../../../worker/sync/calendar-sync.ts";
import { acquirePortalSignIn, releasePortalSignIn } from "../../../worker/sync/portal-gate.ts";
import {
  RECENT_SESSION_SECONDS,
  UNATTENDED_CODES_PER_DAY,
  UNATTENDED_CODE_GAP_SECONDS,
  recentSessionAge,
} from "../../../worker/sync/portal-signin.ts";
import {
  OTP_SENDER_DOMAIN,
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
  seedConnectedHealthSystem,
  seedGoogle,
  seedSettings,
  sk,
  syncBlinder,
  stubUpstreams,
  syncCtx,
  syncRepos,
} from "./helpers.ts";

import type { FhirServer, SeededHealthSystem, Upstreams } from "./helpers.ts";
import type { Ctx } from "../../../worker/db/client.ts";
import type { PortalAccountRow } from "../../../worker/db/rows.ts";
import type { PortalVisit } from "../../../worker/ehr/mychart/index.ts";
import type { FakePortal } from "../portal/helpers.ts";
import type { RunSummary } from "@shared/types.ts";
import type * as fhir4 from "fhir/r4";

beforeEach(resetSyncDb);

const HOST = "fhir.a.example.test";
/** An hour ahead of the fixed clock, so a visit is unambiguously upcoming. */
const SOON = "2026-06-20T14:30:00+00:00";

interface Fixture {
  ctx: Ctx;
  healthSystem: SeededHealthSystem;
  portal: FakePortal;
  upstreams: Upstreams;
  server: FhirServer;
}

/** A connected health system, a Google account, settings, and an active portal account. */
async function fixture(options: { portal?: Partial<FakePortal> } = {}): Promise<Fixture> {
  const ctx = syncCtx();
  const healthSystem = await seedConnectedHealthSystem(ctx, { host: HOST });
  await seedGoogle(ctx);
  await seedSettings(ctx);
  await seedPortalAccount(ctx, healthSystem.healthSystemId);
  const server = fhirServer({ patientId: healthSystem.patientId });
  return {
    ctx,
    healthSystem,
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

/** The key a portal visit is calendared under: `<healthSystemId>:csn:<blind>`. */
function portalKey(healthSystem: SeededHealthSystem, csn: string): Promise<string> {
  return sk(`${healthSystem.healthSystemId}:csn:${csn}`);
}

describe("portal visits on the calendar", () => {
  it("inserts one event per upcoming visit and records where it came from", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });

    const summary = await portalRun(fix);

    expect(summary.portalVisits).toBe(1);
    expect(summary.eventsInserted).toBe(1);
    expect(summary.portalErrors).toStrictEqual([]);
    const key = await portalKey(fix.healthSystem, "csn-1");
    const event = fix.upstreams.calendar.byKey().get(key);
    expect(event?.summary).toBe("Follow-up · A. Example, MD");
    expect(event?.visibility).toBe("private");

    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(key);
    expect(row?.source).toBe("portal");
    expect(row?.portal_csn).toBe(
      await blindCsn(syncBlinder(), fix.healthSystem.healthSystemId, "csn-1"),
    );
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
    expect(
      fix.upstreams.calendar.byKey().get(await portalKey(fix.healthSystem, "csn-1"))?.summary,
    ).toBe("Annual physical · A. Example, MD");
  });

  it("ghosts a visit the portal reports as canceled, with its own details", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);

    fix.portal.visits = [portalVisit({ csn: "csn-1", status: "canceled" })];
    const summary = await portalRun(fix);

    expect(summary.eventsGhosted).toBe(1);
    const event = fix.upstreams.calendar.byKey().get(await portalKey(fix.healthSystem, "csn-1"));
    expect(event?.summary).toBe("Cancelled: Follow-up · A. Example, MD");
    expect(event?.transparency).toBe("transparent");
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(
      await portalKey(fix.healthSystem, "csn-1"),
    );
    expect(row?.state).toBe("ghost");
    // A cancellation keeps its event: only a duplicate is ever deleted.
    expect(fix.upstreams.calendar.events()).toHaveLength(1);
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
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(
      await portalKey(fix.healthSystem, "csn-1"),
    );
    expect(row?.state).toBe("active");
    expect(
      fix.upstreams.calendar.byKey().get(await portalKey(fix.healthSystem, "csn-1"))?.summary,
    ).toBe("Follow-up · A. Example, MD");
  });

  it("ghosts the row, but not the calendar entry, when a future visit vanishes", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);
    const patchesBefore = fix.upstreams.calendar.patches;

    fix.portal.visits = [];
    const summary = await portalRun(fix);

    expect(summary.eventsGhosted).toBe(1);
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(
      await portalKey(fix.healthSystem, "csn-1"),
    );
    expect(row?.state).toBe("ghost");
    // The calendar is not re-rendered from a copy it did not just read: the row is
    // marked and the entry the owner is looking at is left alone.
    expect(fix.upstreams.calendar.patches).toBe(patchesBefore);
    expect(
      fix.upstreams.calendar.byKey().get(await portalKey(fix.healthSystem, "csn-1"))?.summary,
    ).toBe("Follow-up · A. Example, MD");
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
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(
      await portalKey(fix.healthSystem, "csn-1"),
    );
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
    expect(calendarKeys(fix)).toStrictEqual([await sk(`${fix.healthSystem.healthSystemId}:enc-1`)]);
    const stray = await syncRepos(fix.ctx).calendarEvents.getByKey(
      await portalKey(fix.healthSystem, "csn-1"),
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
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(
      await portalKey(fix.healthSystem, "csn-1"),
    );
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
    expect(calendarKeys(fix)).toStrictEqual([await sk(`${fix.healthSystem.healthSystemId}:enc-1`)]);

    const repos = syncRepos(fix.ctx);
    const stray = await repos.calendarEvents.getByKey(await portalKey(fix.healthSystem, "csn-1"));
    expect(stray).toBeNull();
    const row = await repos.calendarEvents.getByKey(
      await sk(`${fix.healthSystem.healthSystemId}:enc-1`),
    );
    expect(row?.source).toBe("fhir");
    expect(row?.portal_csn).toBeNull();
    expect(row?.state).toBe("active");
  });
});

describe("portal visits stored for the MCP", () => {
  it("stores every visit the portal returned, including one FHIR already calendared", async () => {
    const fix = await fixture({
      portal: {
        visits: [
          portalVisit({ csn: "csn-1", start: SOON }),
          portalVisit({ csn: "csn-2", start: "2026-12-01T15:00:00+00:00", isVideo: true }),
        ],
      },
    });
    withEncounters(fix, [appointment("enc-1", SOON)]);

    await portalRun(fix, false);

    // The calendar skipped csn-1 as a duplicate; the MCP's copy keeps both, and
    // leaves the dedupe to the tool, which also sees the Encounter.
    const stored = await syncRepos(fix.ctx).portalVisits.list(fix.healthSystem.healthSystemId);
    expect(stored.map((row) => row.csn)).toStrictEqual(["csn-1", "csn-2"]);
    expect(stored[1]?.visit).toStrictEqual(
      portalVisit({ csn: "csn-2", start: "2026-12-01T15:00:00+00:00", isVideo: true }),
    );
    expect(stored.every((row) => row.state === "active")).toBe(true);
  });

  it("updates a stored visit when the portal changes it", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);

    fix.portal.visits = [portalVisit({ csn: "csn-1", visitType: "Annual physical" })];
    await portalRun(fix);

    const [row] = await syncRepos(fix.ctx).portalVisits.list(fix.healthSystem.healthSystemId);
    expect(row?.visit.visitType).toBe("Annual physical");
  });

  it("stores a canceled visit with its status, and marks a vanished future one missing", async () => {
    const fix = await fixture({
      portal: { visits: [portalVisit({ csn: "csn-1" }), portalVisit({ csn: "csn-2" })] },
    });
    await portalRun(fix);

    fix.portal.visits = [portalVisit({ csn: "csn-1", status: "canceled" })];
    await portalRun(fix);

    const stored = await syncRepos(fix.ctx).portalVisits.list(fix.healthSystem.healthSystemId);
    const byCsn = new Map(stored.map((row) => [row.csn, row]));
    expect(byCsn.get("csn-1")).toMatchObject({ state: "active", missingSince: null });
    expect(byCsn.get("csn-1")?.visit.status).toBe("canceled");
    expect(byCsn.get("csn-2")).toMatchObject({ state: "missing", missingSince: T0 });
  });

  it("leaves a stored visit alone once it is in the past and drops out of the list", async () => {
    const past = "2026-06-15T11:00:00+00:00";
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1", start: past })] } });
    await portalRun(fix);

    fix.portal.visits = [];
    await portalRun(fix);

    const [row] = await syncRepos(fix.ctx).portalVisits.list(fix.healthSystem.healthSystemId);
    expect(row).toMatchObject({ csn: "csn-1", state: "active" });
  });
});

async function secondOrganisation(
  fix: Fixture,
  visits: PortalVisit[],
): Promise<SeededHealthSystem> {
  const other = await seedConnectedHealthSystem(fix.ctx, {
    host: "fhir.b.example.test",
    displayName: "B Example Health",
  });
  await syncRepos(fix.ctx).portalVisits.record(other.healthSystemId, visits, { complete: true });
  return other;
}

/**
 * The owning organisation's own event for the visit, as its portal pass would
 * have written it. Health system B has no portal account in these tests, so nothing
 * touches it -- which is what lets a test prove the delete aimed at A's copy only.
 */
async function ownersEvent(fix: Fixture, owner: SeededHealthSystem, csn: string): Promise<string> {
  const key = await sk(`${owner.healthSystemId}:csn:${csn}`);
  fix.upstreams.calendar.plant({
    summary: "Follow-up · A. Example, MD",
    start: { dateTime: SOON },
    end: { dateTime: "2026-06-20T15:00:00+00:00" },
    extendedProperties: { private: { healthy: "1", key } },
  });
  return key;
}

/** Health system A calendars its second-hand copy before any better copy is known. */
async function calendaredSecondHand(fix: Fixture): Promise<string> {
  const summary = await portalRun(fix);
  expect(summary.eventsInserted).toBe(1);
  return await portalKey(fix.healthSystem, "csn-a-view");
}

const shared = (overrides: Partial<PortalVisit> = {}): PortalVisit =>
  portalVisit({ csn: "csn-a-view", start: SOON, external: true, ...overrides });

describe("one visit, one event, across organisations", () => {
  // Health system B's stored visits stand in for a second organisation whose portal
  // pass already ran (or whose session is failing now): the dedupe reads them from
  // `portal_visits` either way. Its copy of the visit is first-hand; health system A's
  // portal lists the same visit second-hand, through a shared record.
  it("does not calendar a second-hand copy of a visit its own organisation lists", async () => {
    const fix = await fixture({ portal: { visits: [shared()] } });
    await secondOrganisation(fix, [portalVisit({ csn: "csn-b-own", start: SOON })]);

    const summary = await portalRun(fix);

    expect(summary.eventsInserted).toBe(0);
    expect(summary.portalSkipped).toBe(1);
    // Still stored: the MCP decides between the two copies for itself.
    const stored = await syncRepos(fix.ctx).portalVisits.list(fix.healthSystem.healthSystemId);
    expect(stored.map((row) => row.csn)).toStrictEqual(["csn-a-view"]);
  });

  it("calendars the second-hand copy when it is the only one there is", async () => {
    const fix = await fixture({ portal: { visits: [shared()] } });

    const summary = await portalRun(fix);

    expect(summary.eventsInserted).toBe(1);
    expect(calendarKeys(fix)).toStrictEqual([await portalKey(fix.healthSystem, "csn-a-view")]);
  });

  it("deletes, rather than ghosts, a second-hand event once the owner's copy turns up", async () => {
    // The live case this exists for: a second organisation's portal calendared a
    // visit before the dedupe could tell it was the first organisation's. The visit
    // is not cancelled, so a grey "Cancelled:" twin would be wrong.
    const fix = await fixture({ portal: { visits: [shared()] } });
    const mine = await calendaredSecondHand(fix);
    const owner = await secondOrganisation(fix, [portalVisit({ csn: "csn-b-own", start: SOON })]);
    const theirs = await ownersEvent(fix, owner, "csn-b-own");

    const summary = await portalRun(fix);

    expect(summary.eventsGhosted).toBe(0);
    expect(summary.eventsInserted).toBe(0);
    expect(summary.portalSkipped).toBe(1);
    expect(calendarKeys(fix)).toStrictEqual([theirs]);
    expect(await syncRepos(fix.ctx).calendarEvents.getByKey(mine)).toBeNull();
  });

  it("deletes a second-hand event an earlier run had already ghosted", async () => {
    const fix = await fixture({ portal: { visits: [shared()] } });
    const mine = await calendaredSecondHand(fix);
    // What the build between the dedupe and this fix did: ghosted the copy.
    fix.portal.visits = [shared({ status: "canceled" })];
    await portalRun(fix);
    expect(fix.upstreams.calendar.byKey().get(mine)?.summary).toMatch(/^Cancelled: /u);
    fix.portal.visits = [shared()];
    const owner = await secondOrganisation(fix, [portalVisit({ csn: "csn-b-own", start: SOON })]);
    const theirs = await ownersEvent(fix, owner, "csn-b-own");

    const summary = await portalRun(fix);

    expect(summary.eventsRestored).toBe(0);
    expect(summary.eventsGhosted).toBe(0);
    expect(calendarKeys(fix)).toStrictEqual([theirs]);
    expect(await syncRepos(fix.ctx).calendarEvents.getByKey(mine)).toBeNull();
  });

  it("deletes only an event that still carries the healthy marker", async () => {
    const fix = await fixture({ portal: { visits: [shared()] } });
    const mine = await calendaredSecondHand(fix);
    // The owner took the event over by hand: it no longer says it is ours.
    const event = fix.upstreams.calendar.byKey().get(mine);
    expect(event).toBeDefined();
    if (event !== undefined) event.extendedProperties = { private: { key: mine } };
    await secondOrganisation(fix, [portalVisit({ csn: "csn-b-own", start: SOON })]);

    await portalRun(fix);

    // Left on the calendar, and no longer tracked -- so never written again.
    expect(fix.upstreams.calendar.events()).toHaveLength(1);
    expect(await syncRepos(fix.ctx).calendarEvents.getByKey(mine)).toBeNull();
  });

  it("is idempotent: later runs neither delete nor recreate anything", async () => {
    const fix = await fixture({ portal: { visits: [shared()] } });
    const mine = await calendaredSecondHand(fix);
    const owner = await secondOrganisation(fix, [portalVisit({ csn: "csn-b-own", start: SOON })]);
    const theirs = await ownersEvent(fix, owner, "csn-b-own");
    await portalRun(fix);
    const inserts = fix.upstreams.calendar.inserts;
    const patches = fix.upstreams.calendar.patches;

    for (const summary of [await portalRun(fix), await portalRun(fix)]) {
      expect(summary.eventsInserted).toBe(0);
      expect(summary.eventsGhosted).toBe(0);
      expect(summary.eventsPatched).toBe(0);
      expect(summary.portalErrors).toStrictEqual([]);
    }
    expect(fix.upstreams.calendar.inserts).toBe(inserts);
    expect(fix.upstreams.calendar.patches).toBe(patches);
    expect(calendarKeys(fix)).toStrictEqual([theirs]);
    expect(await syncRepos(fix.ctx).calendarEvents.getByKey(mine)).toBeNull();
  });

  it("calendars the second-hand copy again once the owner's copy goes away", async () => {
    const fix = await fixture({ portal: { visits: [shared()] } });
    const mine = await calendaredSecondHand(fix);
    const owner = await secondOrganisation(fix, [portalVisit({ csn: "csn-b-own", start: SOON })]);
    await portalRun(fix);
    expect(calendarKeys(fix)).toStrictEqual([]);

    // The owning organisation is disconnected: its stored visits are forgotten.
    await syncRepos(fix.ctx).portalVisits.clearHealthSystem(owner.healthSystemId);
    const summary = await portalRun(fix);

    expect(summary.eventsInserted).toBe(1);
    expect(calendarKeys(fix)).toStrictEqual([mine]);
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(mine);
    expect(row?.state).toBe("active");
  });

  it("calendars a visit at the same time as a different one elsewhere", async () => {
    const fix = await fixture({
      portal: { visits: [portalVisit({ csn: "csn-a-own", start: SOON })] },
    });
    await secondOrganisation(fix, [
      portalVisit({
        csn: "csn-b-own",
        start: SOON,
        practitioner: "Q. Other, DO",
        department: "Other Dermatology",
      }),
    ]);

    const summary = await portalRun(fix);

    expect(summary.eventsInserted).toBe(1);
    expect(calendarKeys(fix)).toStrictEqual([await portalKey(fix.healthSystem, "csn-a-own")]);
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

    const account = await syncRepos(fix.ctx).portalAccounts.get(fix.healthSystem.healthSystemId);
    expect(account?.session_state).toBe("active");
    expect(account?.login_attempts_today).toBe(1);
    // The code is single use: nothing may claim it twice.
    const again = await syncRepos(fix.ctx).mailInbox.takeFreshOtp({
      since: 0,
      now: T0,
      expectedSender: OTP_SENDER_DOMAIN,
      allowlist: [],
      // Irrelevant once there's an expected sender -- see `eligible` in
      // `mail-inbox.ts` -- included only because the field is required.
      portalHost: null,
    });
    expect(again).toBeNull();
  });

  it("never submits a code from a sender the account does not expect", async () => {
    // Vuln 1's exploit, end to end: a stranger who can reach the inbound mail
    // address floods it with codes of their own choosing. The account's expected
    // sender is what makes every one of those rows ineligible, so the sign-in
    // waits for the portal's own code rather than submitting theirs.
    const fix = await fixture({
      portal: {
        alive: false,
        loginStatus: "awaiting_code",
        visits: [portalVisit({ csn: "csn-1" })],
      },
    });
    await seedOtp(fix.ctx, "000000", { fromAddr: "attacker@mail.example.test.evil.test" });

    const summary = await portalRun(fix);

    expect(fix.portal.submitted).toStrictEqual([]);
    expect(summary.portalErrors).toStrictEqual(["portal_2fa_required"]);
    const account = await syncRepos(fix.ctx).portalAccounts.get(fix.healthSystem.healthSystemId);
    expect(account?.session_state).toBe("needs_reauth");
  });

  it("prefers the OLDEST eligible code, so a flood cannot outrun the portal's own", async () => {
    const fix = await fixture({
      portal: { alive: false, loginStatus: "awaiting_code", visits: [] },
    });
    // The portal's code lands first; the attacker keeps sending after it.
    await seedOtp(fix.ctx, "111111", { receivedAt: T0 + 10 });
    await seedOtp(fix.ctx, "222222", { receivedAt: T0 + 20 });

    await portalRun(fix);

    expect(fix.portal.submitted).toStrictEqual(["111111"]);
  });

  it("learns the sender of the first accepted code, binding later claims to it", async () => {
    const ctx = syncCtx();
    const healthSystem = await seedConnectedHealthSystem(ctx, { host: HOST });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    // No expected sender yet -- the very first sign-in, where the allowlist is
    // the only gate.
    await seedPortalAccount(ctx, healthSystem.healthSystemId, { otpSenderDomain: null });
    await setSetting(ctx, "mail_sender_allowlist", `${OTP_SENDER_DOMAIN},google.com`);
    const repos = syncRepos(ctx);
    await expect(
      repos.portalAccounts.getOtpSender(healthSystem.healthSystemId),
    ).resolves.toBeNull();
    const portal = fakePortal({ alive: false, loginStatus: "awaiting_code", visits: [] });
    await seedOtp(ctx, "246810");
    const upstreams = stubUpstreams({ [HOST]: fhirServer({ patientId: healthSystem.patientId }) });

    await runCalendarSync(ctx, {
      trigger: "manual",
      portalOnly: true,
      deps: { ...upstreams.deps, portalAdapter: portal.adapter },
    });

    expect(portal.submitted).toStrictEqual(["246810"]);
    // The portal itself confirmed the code, which makes its sender the
    // authoritative answer to "where do this account's codes come from".
    await expect(repos.portalAccounts.getOtpSender(healthSystem.healthSystemId)).resolves.toBe(
      OTP_SENDER_DOMAIN,
    );
  });

  it("does not sign in at all while another driver holds the gate", async () => {
    // Two sign-ins for one health system can each pass the attempt check before either
    // increments it -- overshooting the daily budget that exists to keep the
    // portal from locking the account -- and the second `SendCode` invalidates the
    // code the first is waiting for. The admin button's Durable Object is the one
    // gate, and the hourly pass takes it too.
    const fix = await fixture({
      portal: { alive: false, loginStatus: "awaiting_code", visits: [] },
    });
    await seedOtp(fix.ctx, "424242");
    const held = await acquirePortalSignIn(fix.ctx, fix.healthSystem.healthSystemId, "test");
    expect(held).toBe(true);

    try {
      const summary = await portalRun(fix);

      expect(fix.portal.calls.logins).toBe(0);
      expect(fix.portal.calls.sendCodes).toBe(0);
      expect(summary.portalErrors).toStrictEqual(["portal_signin_busy"]);
      // No attempt spent either: the budget is for sign-ins actually made.
      const account = await syncRepos(fix.ctx).portalAccounts.get(fix.healthSystem.healthSystemId);
      expect(account?.login_attempts_today).toBe(0);
    } finally {
      await releasePortalSignIn(fix.ctx, fix.healthSystem.healthSystemId);
    }
  });

  it("signs in again once the gate is released", async () => {
    const fix = await fixture({
      portal: { alive: false, loginStatus: "awaiting_code", visits: [] },
    });
    await seedOtp(fix.ctx, "424242");
    await acquirePortalSignIn(fix.ctx, fix.healthSystem.healthSystemId, "test");
    await releasePortalSignIn(fix.ctx, fix.healthSystem.healthSystemId);

    await portalRun(fix);

    expect(fix.portal.submitted).toStrictEqual(["424242"]);
  });

  it("has no cap on a large payload: every visit the portal reports is seen and stored", async () => {
    // There is no ceiling here any more, however unlikely a large schedule looks:
    // an owner with an unusually long list of upcoming visits gets every one of
    // them, not a silently trimmed page.
    const many = 300;
    const visits = Array.from({ length: many }, (_, index) =>
      portalVisit({ csn: `csn-${String(index)}` }),
    );
    const fix = await fixture({ portal: { visits } });

    const summary = await portalRun(fix);

    expect(summary.portalVisits).toBe(many);
    const stored = await syncRepos(fix.ctx).portalVisits.list(fix.healthSystem.healthSystemId);
    expect(stored).toHaveLength(many);
    const runs = await syncRepos(fix.ctx).runLog.listRecent({ limit: 1 });
    expect(runs[0]?.summary.warnings).not.toContain("portal_visits_truncated");
  });

  it("passes the shell API base and the MFA contact to the adapter when signing in", async () => {
    const ctx = syncCtx();
    const healthSystem = await seedConnectedHealthSystem(ctx, { host: HOST });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    // Falls back to the setting: the account's own endpoint never learned one.
    await setSetting(ctx, "portal_api_base_path", "/api/shell/v1");
    await seedPortalAccount(ctx, healthSystem.healthSystemId, {
      mfaContact: "owner@example.test",
    });
    const portal = fakePortal({ alive: false, loginStatus: "awaiting_code" });
    await seedOtp(ctx, "135790");
    const upstreams = stubUpstreams({ [HOST]: fhirServer({ patientId: healthSystem.patientId }) });

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
    const healthSystem = await seedConnectedHealthSystem(ctx, { host: HOST });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    await setSetting(ctx, "portal_api_base_path", "/from/settings");
    await seedPortalAccount(ctx, healthSystem.healthSystemId, { apiBasePath: "/from/endpoint" });
    const portal = fakePortal({ alive: true, visits: [] });
    const upstreams = stubUpstreams({ [HOST]: fhirServer({ patientId: healthSystem.patientId }) });

    await runCalendarSync(ctx, {
      trigger: "manual",
      portalOnly: true,
      deps: { ...upstreams.deps, portalAdapter: portal.adapter },
    });

    expect(portal.clientDeps.at(-1)?.custom?.apiBasePath).toBe("/from/endpoint");
  });

  it("marks the account and opens one reconnect card when the code never arrives", async () => {
    const ctx = syncCtx({ trello: true });
    const healthSystem = await seedConnectedHealthSystem(ctx, { host: HOST });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    await seedPortalAccount(ctx, healthSystem.healthSystemId);
    const portal = fakePortal({ alive: false, loginStatus: "awaiting_code" });
    const upstreams = stubUpstreams({ [HOST]: fhirServer({ patientId: healthSystem.patientId }) });

    const summary = await runCalendarSync(ctx, {
      trigger: "manual",
      portalOnly: true,
      deps: { ...upstreams.deps, portalAdapter: portal.adapter },
    });

    expect(summary.portalErrors).toStrictEqual(["portal_2fa_required"]);
    // A portal that needs the owner is an expected state, not a failed run.
    expect(summary.errors).toStrictEqual([]);
    const account = await syncRepos(ctx).portalAccounts.get(healthSystem.healthSystemId);
    expect(account?.session_state).toBe("needs_reauth");
    expect(account?.last_error_code).toBe("portal_2fa_required");
    // `portal_2fa_required` is not one of the codes that raises a card: the owner
    // will see it on the Health systems page, and a card per missing email would be noise.
    expect(upstreams.trelloCards).toStrictEqual([]);
  });

  it("refuses to sign in at all once the daily attempt budget is spent, and alerts", async () => {
    const ctx = syncCtx({ trello: true });
    const healthSystem = await seedConnectedHealthSystem(ctx, {
      host: HOST,
      displayName: "A Example Health",
    });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    await seedPortalAccount(ctx, healthSystem.healthSystemId);
    await spendAttempts(ctx, healthSystem.healthSystemId, 3);
    const portal = fakePortal({ alive: false });
    const upstreams = stubUpstreams({ [HOST]: fhirServer({ patientId: healthSystem.patientId }) });

    const summary = await runCalendarSync(ctx, {
      trigger: "manual",
      portalOnly: true,
      deps: { ...upstreams.deps, portalAdapter: portal.adapter },
    });

    expect(portal.calls.logins).toBe(0);
    expect(summary.portalErrors).toStrictEqual(["portal_attempts_exhausted"]);
    const account = await syncRepos(ctx).portalAccounts.get(healthSystem.healthSystemId);
    expect(account?.session_state).toBe("needs_reauth");

    // The card names the portal, not the FHIR connection, and links to /health systems.
    expect(upstreams.trelloCards).toHaveLength(1);
    expect(upstreams.trelloCards[0]?.name).toBe("Reconnect A Example Health MyChart to Healthy");
    expect(upstreams.trelloCards[0]?.desc).toContain("/health-systems");
    const alert = await syncRepos(ctx).alerts.getOpen(`portal:${healthSystem.healthSystemId}`);
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
      fix.healthSystem.healthSystemId,
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

/** The hourly cron's own run: trigger "calendar", portal pass only. */
function scheduledRun(fix: Fixture): Promise<RunSummary> {
  return runCalendarSync(fix.ctx, {
    trigger: "calendar",
    portalOnly: true,
    deps: { ...fix.upstreams.deps, portalAdapter: fix.portal.adapter },
  });
}

/** Codes an earlier unattended sign-in asked for, `hoursAgo` before T0. */
async function earlierCodes(fix: Fixture, count: number, hoursAgo: number): Promise<void> {
  const then = syncCtx({ now: () => T0 - hoursAgo * 3600 });
  for (let code = 0; code < count; code += 1) {
    await syncRepos(then).portalAccounts.recordUnattendedCode(fix.provider.providerId);
  }
}

/** The fixture's portal account row. */
async function accountOf(fix: Fixture): Promise<PortalAccountRow | null> {
  return syncRepos(fix.ctx).portalAccounts.get(fix.provider.providerId);
}

describe("the scheduled run, which nobody is watching", () => {
  // The incident these pin down: a portal whose session died every hour had the
  // hourly run email the owner a code every hour, until the day's whole sign-in
  // budget was gone and the owner could not even retry by hand. An unattended
  // run may still sign in -- it is the only thing that keeps the calendar
  // current overnight -- but within limits the owner's own buttons are not held to.

  it("signs in with an emailed code when the session is dead, and counts the code", async () => {
    const fix = await fixture({
      portal: { alive: false, loginStatus: "awaiting_code", visits: [portalVisit({ csn: "c-1" })] },
    });
    await seedOtp(fix.ctx, "424242");

    const summary = await scheduledRun(fix);

    expect(fix.portal.calls.sendCodes).toBe(1);
    expect(summary.portalErrors).toStrictEqual([]);
    expect(summary.eventsInserted).toBe(1);
    const row = await accountOf(fix);
    expect(row?.session_state).toBe("active");
    expect(row?.unattended_codes_today).toBe(1);
    expect(row?.last_unattended_code_at).toBe(T0);
  });

  it("does not sign in at all inside the spacing after its last code, and says so", async () => {
    const fix = await fixture({ portal: { alive: false, loginStatus: "awaiting_code" } });
    await earlierCodes(fix, 1, 1);

    const summary = await scheduledRun(fix);

    // Not even the password: every look at the trusted device costs an attempt.
    expect(fix.portal.calls.logins).toBe(0);
    expect(summary.portalErrors).toStrictEqual(["portal_signin_deferred"]);
    const row = await accountOf(fix);
    // A wait that ends on its own: still active, so a later run tries again.
    expect(row?.session_state).toBe("active");
    expect(row?.login_attempts_today).toBe(0);
    expect(fix.upstreams.trelloCards).toStrictEqual([]);
  });

  it("signs in again once the spacing has passed", async () => {
    const fix = await fixture({ portal: { alive: false, loginStatus: "awaiting_code" } });
    await earlierCodes(fix, 1, UNATTENDED_CODE_GAP_SECONDS / 3600);
    await seedOtp(fix.ctx, "424242");

    const summary = await scheduledRun(fix);

    expect(fix.portal.calls.sendCodes).toBe(1);
    expect(summary.portalErrors).toStrictEqual([]);
    const row = await accountOf(fix);
    expect(row?.unattended_codes_today).toBe(2);
  });

  it("stops before the email once the day's codes are spent, and hands over to the owner", async () => {
    const ctx = syncCtx({ trello: true });
    const provider = await seedConnectedProvider(ctx, {
      host: HOST,
      displayName: "A Example Health",
    });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    await seedPortalAccount(ctx, provider.providerId);
    const fix: Fixture = {
      ctx,
      provider,
      portal: fakePortal({ alive: false, loginStatus: "awaiting_code" }),
      upstreams: stubUpstreams({ [HOST]: fhirServer({ patientId: provider.patientId }) }),
      server: fhirServer({ patientId: provider.patientId }),
    };
    // Spent earlier today, long enough ago that the spacing is not the reason.
    await earlierCodes(fix, UNATTENDED_CODES_PER_DAY, UNATTENDED_CODE_GAP_SECONDS / 3600);

    const summary = await scheduledRun(fix);

    // The password went (a trusted device might have been enough), the email did not.
    expect(fix.portal.calls.logins).toBe(1);
    expect(fix.portal.calls.sendCodes).toBe(0);
    expect(summary.portalErrors).toStrictEqual(["portal_signin_needs_owner"]);
    const row = await accountOf(fix);
    expect(row?.session_state).toBe("needs_reauth");
    expect(row?.last_error_code).toBe("portal_signin_needs_owner");
    expect(fix.upstreams.trelloCards).toHaveLength(1);
    expect(fix.upstreams.trelloCards[0]?.desc).toContain("/providers");
  });

  it("still signs in on a trusted device once the day's codes are spent", async () => {
    const fix = await fixture({
      portal: { alive: false, loginStatus: "signed_in", visits: [portalVisit({ csn: "c-1" })] },
    });
    await earlierCodes(fix, UNATTENDED_CODES_PER_DAY, UNATTENDED_CODE_GAP_SECONDS / 3600);

    const summary = await scheduledRun(fix);

    expect(fix.portal.calls.logins).toBe(1);
    expect(summary.portalErrors).toStrictEqual([]);
    expect(summary.eventsInserted).toBe(1);
    const row = await accountOf(fix);
    expect(row?.session_state).toBe("active");
  });

  it("leaves the day's last attempts to the owner's own button, and waits", async () => {
    const fix = await fixture({ portal: { alive: false, loginStatus: "signed_in" } });
    // The seeded limit is three; one spent leaves two, which are the owner's.
    await spendAttempts(fix.ctx, fix.provider.providerId, 1);

    const summary = await scheduledRun(fix);

    expect(fix.portal.calls.logins).toBe(0);
    expect(summary.portalErrors).toStrictEqual(["portal_signin_deferred"]);
    const row = await accountOf(fix);
    // A wait that ends at the next UTC day: still active, and no card.
    expect(row?.session_state).toBe("active");
    expect(row?.login_attempts_today).toBe(1);
    expect(fix.upstreams.trelloCards).toStrictEqual([]);
  });

  it("does not hold the owner's own run to any of it", async () => {
    const fix = await fixture({ portal: { alive: false, loginStatus: "awaiting_code" } });
    await earlierCodes(fix, UNATTENDED_CODES_PER_DAY, 1);
    await spendAttempts(fix.ctx, fix.provider.providerId, 1);
    await seedOtp(fix.ctx, "424242");

    const summary = await portalRun(fix);

    expect(fix.portal.calls.sendCodes).toBe(1);
    expect(summary.portalErrors).toStrictEqual([]);
    // And an owner-driven code is not counted against the unattended allowance.
    const row = await accountOf(fix);
    expect(row?.unattended_codes_today).toBe(UNATTENDED_CODES_PER_DAY);
  });
});

describe("a session proven good minutes ago", () => {
  // What the manual sync consults before spending a sign-in attempt on a session
  // that failed its liveness check: one proven good this recently is not one a
  // fresh sign-in would fix. See `RECENT_SESSION_SECONDS`.

  it("is recent right after the account was marked active", async () => {
    const healthSystem = await seedConnectedHealthSystem(syncCtx(), { host: HOST });
    await seedPortalAccount(syncCtx(), healthSystem.healthSystemId);

    const later = syncCtx({ now: () => T0 + 60 });
    await expect(recentSessionAge(later, healthSystem.healthSystemId)).resolves.toBe(60);
  });

  it("stops being recent once the window has passed", async () => {
    const healthSystem = await seedConnectedHealthSystem(syncCtx(), { host: HOST });
    await seedPortalAccount(syncCtx(), healthSystem.healthSystemId);

    const later = syncCtx({ now: () => T0 + RECENT_SESSION_SECONDS });
    await expect(recentSessionAge(later, healthSystem.healthSystemId)).resolves.toBeNull();
  });

  it("is never recent for an account that has never been proven good", async () => {
    const healthSystem = await seedConnectedHealthSystem(syncCtx(), { host: HOST });
    await seedPortalAccount(syncCtx(), healthSystem.healthSystemId, { active: false });

    await expect(recentSessionAge(syncCtx(), healthSystem.healthSystemId)).resolves.toBeNull();
  });
});
