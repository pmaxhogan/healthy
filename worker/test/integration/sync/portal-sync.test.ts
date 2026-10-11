// The patient-portal pass, against real D1 and the in-memory Google Calendar.
//
// The portal itself is a fake adapter (`worker/test/integration/portal/helpers.ts`) --
// what the real client does to real markup is `worker/test/unit/ehr/mychart/**`'s
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

import { blindCsn } from "../../../src/db/blind.ts";
import { setSetting } from "../../../src/db/settings.ts";
import { AppError } from "../../../src/lib/errors.ts";
import { runCalendarSync } from "../../../src/sync/calendar-sync.ts";
import { acquirePortalSignIn, releasePortalSignIn } from "../../../src/sync/portal-gate.ts";
import {
  RECENT_SESSION_SECONDS,
  UNATTENDED_CODES_PER_DAY,
  UNATTENDED_CODE_GAP_SECONDS,
  recentSessionAge,
} from "../../../src/sync/portal-signin.ts";
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
  referencePool,
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
import type { Ctx } from "../../../src/db/client.ts";
import type { PortalAccountRow } from "../../../src/db/rows.ts";
import type { PortalVisit, PortalThread } from "../../../src/ehr/mychart/index.ts";
import type { FakePortal } from "../portal/helpers.ts";
import type { RunSummary } from "@shared/types.ts";
import type * as fhir4 from "fhir/r4";

beforeEach(resetSyncDb);

/** A copy, sorted. */
function sorted(values: readonly string[]): string[] {
  // eslint-disable-next-line unicorn/no-array-sort -- Array#toSorted is ES2023 and the integration project compiles against the Worker's ES2022 lib; this sorts a fresh copy.
  return [...values].sort((a, b) => a.localeCompare(b));
}

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

  it("puts the address in the location and the phone in the description, as FHIR events have", async () => {
    const fix = await fixture({
      portal: {
        visits: [
          portalVisit({
            csn: "csn-1",
            locationName: "Example Tower",
            address: "1 Example Way, Testville, TS 00001",
            phone: "\u{202A}555-0100\u{202C}",
          }),
        ],
      },
    });
    await seedSettings(fix.ctx, { default_arrival_offset_min: 15 });

    await portalRun(fix);

    const event = fix.upstreams.calendar.byKey().get(await portalKey(fix.healthSystem, "csn-1"));
    expect(event?.location).toBe("Example Tower, 1 Example Way, Testville, TS 00001");
    const description = String(event?.description);
    expect(description).toContain("1 Example Way, Testville, TS 00001 · 555-0100");
    expect(description).not.toMatch(/[\u{202A}\u{202C}]/u);
    // The same arrive-early rule: the event starts early and the title says when
    // the appointment really is.
    expect(event?.summary).toBe("Follow-up · A. Example, MD (appt 2:30 PM)");
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

  it("keeps the owner's text above the rule through a patch and a ghost", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);
    const event = fix.upstreams.calendar.byKey().get(await portalKey(fix.healthSystem, "csn-1"));
    if (event === undefined) throw new Error("csn-1 was not calendared");
    const owner = "Owner note<br><br>";
    event.description = `${owner}${String(event.description)}`;

    // An edit above the rule alone costs no write.
    const untouched = await portalRun(fix);
    expect(untouched.eventsPatched).toBe(0);

    fix.portal.visits = [portalVisit({ csn: "csn-1", visitType: "Annual physical" })];
    const patched = await portalRun(fix);
    expect(patched.eventsPatched).toBe(1);
    expect(String(event.description).startsWith(`${owner}-------<br>Synced by Healthy`)).toBe(true);

    fix.portal.visits = [portalVisit({ csn: "csn-1", status: "canceled" })];
    const ghosted = await portalRun(fix);
    expect(ghosted.eventsGhosted).toBe(1);
    expect(String(event.description).startsWith(`${owner}-------<br>`)).toBe(true);
    expect(String(event.description)).toContain("No longer on the health system");
    const settled = await portalRun(fix);
    expect(settled.eventsGhosted).toBe(0);
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

  it("ghosts the calendar entry from the stored copy when a future visit vanishes", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);
    const key = await portalKey(fix.healthSystem, "csn-1");

    fix.portal.visits = [];
    const summary = await portalRun(fix);

    expect(summary.eventsGhosted).toBe(1);
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(key);
    expect(row?.state).toBe("ghost");
    // A cancelled visit must not stay on the calendar looking live: grey, free,
    // "Cancelled:", and its status line says so too.
    const event = fix.upstreams.calendar.byKey().get(key);
    expect(event?.summary).toBe("Cancelled: Follow-up · A. Example, MD");
    expect(event?.transparency).toBe("transparent");
    expect(event?.colorId).toBe("8");
    expect(event?.description).toContain("canceled");
    expect(event?.description).not.toContain("scheduled");
    // A cancellation keeps its event: only a duplicate is ever deleted.
    expect(fix.upstreams.calendar.events()).toHaveLength(1);

    // Settled: the next run writes nothing.
    const patchesBefore = fix.upstreams.calendar.patches;
    const again = await portalRun(fix);
    expect(again.eventsGhosted).toBe(0);
    expect(fix.upstreams.calendar.patches).toBe(patchesBefore);
  });

  it("repairs a vanished visit an earlier build ghosted in the row only", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);
    const key = await portalKey(fix.healthSystem, "csn-1");
    const repos = syncRepos(fix.ctx);
    // What the earlier build left: the row a ghost with the active fingerprint,
    // the event untouched.
    await repos.calendarEvents.markGhost(key);
    const before = await repos.calendarEvents.getByKey(key);

    fix.portal.visits = [];
    const summary = await portalRun(fix);

    expect(summary.eventsGhosted).toBe(1);
    const event = fix.upstreams.calendar.byKey().get(key);
    expect(event?.summary).toBe("Cancelled: Follow-up · A. Example, MD");
    expect(event?.transparency).toBe("transparent");
    // The original disappearance is kept, not moved to this run.
    const after = await repos.calendarEvents.getByKey(key);
    expect(after?.ghosted_at).toBe(before?.ghosted_at);
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

describe("a ghosted FHIR row is not a copy of a live visit (security review L3)", () => {
  it("keeps a calendared portal visit that a ghosted FHIR row shares a start with", async () => {
    // A cancelled Encounter at the same time as a live, different portal visit
    // used to count as covering it: the live event was deleted and only the grey
    // ghost was left.
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1", start: SOON })] } });
    await portalRun(fix);
    const key = await portalKey(fix.healthSystem, "csn-1");
    const repos = syncRepos(fix.ctx);
    const live = await repos.calendarEvents.getByKey(key);
    expect(live?.start_at).toBeTypeOf("number");

    const ghostKey = await sk(`${fix.healthSystem.healthSystemId}:enc-cancelled`);
    await repos.calendarEvents.upsert({
      eventKey: ghostKey,
      healthSystemId: fix.healthSystem.healthSystemId,
      encounterId: "enc-cancelled",
      calendarId: "primary",
      googleEventId: "fhir-ghost-event",
      fingerprint: "ghost",
      startAt: live?.start_at ?? null,
      source: "fhir",
    });
    await repos.calendarEvents.markGhost(ghostKey);

    const summary = await portalRun(fix);

    expect(summary.portalSkipped).toBe(0);
    expect(calendarKeys(fix)).toStrictEqual([key]);
    const kept = await repos.calendarEvents.getByKey(key);
    expect(kept?.state).toBe("active");
  });

  it("calendars a live portal visit that this run's cancelled Encounter shares a start with", async () => {
    // The in-run half of the same rule: the FHIR pass's own sightings. This pins
    // the first run, where the live visit used to be left out; the next describe
    // block pins a visit that was already calendared.
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1", start: SOON })] } });
    const key = await portalKey(fix.healthSystem, "csn-1");
    withEncounters(fix, [
      encounter({ id: "enc-cancelled", start: SOON, status: "cancelled", visitType: "Consult" }),
    ]);

    const summary = await portalRun(fix, false);

    expect(summary.portalSkipped).toBe(0);
    expect(calendarKeys(fix)).toContain(key);
    const kept = await syncRepos(fix.ctx).calendarEvents.getByKey(key);
    expect(kept?.state).toBe("active");
  });
});

/** Let the FHIR host resolve the fixture's practitioners, so an Encounter names one. */
function withPractitioners(fix: Fixture): void {
  for (const [reference, resource] of referencePool()) {
    if (reference.startsWith("Practitioner/")) fix.server.resources.set(reference, resource);
  }
}

describe("an Encounter adopts a portal row only on identity", () => {
  it("never adopts or ghosts a live portal event on a shared start time alone", async () => {
    // A cancelled Encounter with no CSN, a different practitioner, and the same
    // start as a live portal visit already on the calendar. It used to take over
    // the portal's row and event, then grey the event out as cancelled.
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1", start: SOON })] } });
    await portalRun(fix);
    const key = await portalKey(fix.healthSystem, "csn-1");
    expect(calendarKeys(fix)).toStrictEqual([key]);
    withEncounters(fix, [
      encounter({
        id: "enc-cancelled",
        start: SOON,
        status: "cancelled",
        visitType: "Consult",
        practitionerRef: "Practitioner/prac-2",
      }),
    ]);
    withPractitioners(fix);

    const first = await portalRun(fix, false);
    const second = await portalRun(fix, false);

    for (const summary of [first, second]) {
      expect(summary.eventsGhosted).toBe(0);
      expect(summary.eventsPatched).toBe(0);
      expect(summary.eventsInserted).toBe(0);
    }
    expect(calendarKeys(fix)).toStrictEqual([key]);
    const event = fix.upstreams.calendar.byKey().get(key);
    expect(event?.summary).toBe("Follow-up · A. Example, MD");
    expect(event?.transparency).not.toBe("transparent");
    const repos = syncRepos(fix.ctx);
    const row = await repos.calendarEvents.getByKey(key);
    expect(row?.source).toBe("portal");
    expect(row?.state).toBe("active");
    expect(
      await repos.calendarEvents.getByKey(
        await sk(`${fix.healthSystem.healthSystemId}:enc-cancelled`),
      ),
    ).toBeNull();
  });

  it("adopts on the same practitioner at the same time when the Encounter has no CSN", async () => {
    // The fixture's prac-1 renders as "Test Alpha"; the portal writes it its own way.
    const fix = await fixture({
      portal: {
        visits: [portalVisit({ csn: "csn-1", start: SOON, practitioner: "Alpha, Test MD" })],
      },
    });
    await portalRun(fix);
    expect(fix.upstreams.calendar.inserts).toBe(1);

    withEncounters(fix, [appointment("enc-1", "2026-06-20T14:31:00+00:00")]);
    withPractitioners(fix);
    const summary = await portalRun(fix, false);

    expect(fix.upstreams.calendar.inserts).toBe(1);
    expect(summary.eventsPatched).toBe(1);
    expect(calendarKeys(fix)).toStrictEqual([await sk(`${fix.healthSystem.healthSystemId}:enc-1`)]);
  });

  it("still adopts, and ghosts, the portal event of a visit its own CSN says was cancelled", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1", start: SOON })] } });
    await portalRun(fix);

    withEncounters(fix, [
      {
        ...encounter({ id: "enc-1", start: SOON, status: "cancelled", visitType: "Office Visit" }),
        identifier: [{ type: { text: "CSN" }, value: "csn-1" }],
      },
    ]);
    const summary = await portalRun(fix, false);

    expect(fix.upstreams.calendar.inserts).toBe(1);
    expect(summary.eventsGhosted).toBe(1);
    const key = await sk(`${fix.healthSystem.healthSystemId}:enc-1`);
    expect(calendarKeys(fix)).toStrictEqual([key]);
    expect(fix.upstreams.calendar.byKey().get(key)?.summary).toMatch(/^Cancelled: /u);
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
    // With what its (empty) details page added: no wait list offered.
    expect(stored[1]?.visit).toStrictEqual({
      ...portalVisit({ csn: "csn-2", start: "2026-12-01T15:00:00+00:00", isVideo: true }),
      waitlist: null,
    });
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

  it("never deletes an event on a department-only match (security review L3)", async () => {
    // The better copy names no practitioner, so all the two share is a label
    // ("Example Clinic") -- which two different same-time visits at two
    // organisations can share. That may stop a second copy being inserted; it
    // must not delete the event already written for this one.
    const fix = await fixture({ portal: { visits: [shared()] } });
    const mine = await calendaredSecondHand(fix);
    const theirs = portalVisit({ csn: "csn-b-own", start: SOON });
    delete theirs.practitioner;
    const owner = await secondOrganisation(fix, [theirs]);
    const theirsKey = await ownersEvent(fix, owner, "csn-b-own");

    const summary = await portalRun(fix);

    expect(summary.eventsGhosted).toBe(0);
    expect(summary.eventsInserted).toBe(0);
    expect(calendarKeys(fix)).toStrictEqual([mine, theirsKey]);
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(mine);
    expect(row?.state).toBe("active");
  });

  it("still does not insert a copy on a department-only match", async () => {
    const fix = await fixture({ portal: { visits: [shared()] } });
    const theirs = portalVisit({ csn: "csn-b-own", start: SOON });
    delete theirs.practitioner;
    await secondOrganisation(fix, [theirs]);

    const summary = await portalRun(fix);

    expect(summary.eventsInserted).toBe(0);
    expect(summary.portalSkipped).toBe(1);
    expect(calendarKeys(fix)).toStrictEqual([]);
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
    expect(upstreams.trelloCards[0]?.name).toBe(
      "Reconnect A Example Health patient portal to Healthy",
    );
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
    await syncRepos(then).portalAccounts.recordUnattendedCode(fix.healthSystem.healthSystemId);
  }
}

/** The fixture's portal account row. */
async function accountOf(fix: Fixture): Promise<PortalAccountRow | null> {
  return syncRepos(fix.ctx).portalAccounts.get(fix.healthSystem.healthSystemId);
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
    const healthSystem = await seedConnectedHealthSystem(ctx, {
      host: HOST,
      displayName: "A Example Health",
    });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    await seedPortalAccount(ctx, healthSystem.healthSystemId);
    const fix: Fixture = {
      ctx,
      healthSystem,
      portal: fakePortal({ alive: false, loginStatus: "awaiting_code" }),
      upstreams: stubUpstreams({ [HOST]: fhirServer({ patientId: healthSystem.patientId }) }),
      server: fhirServer({ patientId: healthSystem.patientId }),
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
    expect(fix.upstreams.trelloCards[0]?.desc).toContain("/health-systems");
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
    await spendAttempts(fix.ctx, fix.healthSystem.healthSystemId, 1);

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
    await spendAttempts(fix.ctx, fix.healthSystem.healthSystemId, 1);
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

/** A file's per-session handle, as the crawl hands it over. */
function attachmentHandle(dcsId: string) {
  return { dcsId, fileExtension: "PNG", organizationId: "" };
}

/** A conversation whose reply carries two fetchable files and a clinical reference. */
function withAttachments(unread: boolean): PortalThread {
  return {
    subject: "Invented subject",
    folder: "conversations",
    external: false,
    practitioners: [{ name: "Nurse Example A" }],
    messages: [
      { sent: "2026-05-01T10:00:00.000Z", role: "patient", body: "A question.", attachments: [] },
      {
        sent: "2026-05-01T12:00:00.000Z",
        role: "practitioner",
        body: "An invented answer with files.",
        unread,
        attachments: [
          { name: "invented-a", extension: "PNG", handle: attachmentHandle("WP-a") },
          { name: "invented-b", extension: "PNG", handle: attachmentHandle("WP-b") },
          // A clinical reference: no file behind it, so nothing to fetch.
          { name: "invented-reference" },
        ],
      },
    ],
  };
}

/** What the fake portal serves per `dcsId`. */
function files(entries: [string, AppError | { contentType: string; bytes: Uint8Array }][]) {
  return new Map(entries) as FakePortal["files"];
}

describe("portal secure messages", () => {
  const THREAD = {
    subject: "Invented subject",
    folder: "conversations" as const,
    external: false,
    practitioners: [{ name: "Nurse Example A" }],
    messages: [
      {
        sent: "2026-05-01T10:00:00.000Z",
        role: "patient" as const,
        body: "An invented question.",
        attachments: [],
      },
      {
        sent: "2026-05-01T12:00:00.000Z",
        role: "practitioner" as const,
        author: "Nurse Example A",
        body: "An invented answer.",
        attachments: [],
      },
    ],
  };

  it("reads the Message Center with the same session and stores every message", async () => {
    const fix = await fixture({ portal: { threads: [THREAD] } });

    const summary = await portalRun(fix);

    expect(fix.portal.calls.loadMessages).toBe(1);
    expect(summary.portalMessages).toBe(2);
    expect(summary.portalErrors).toStrictEqual([]);
    const repos = syncRepos(fix.ctx);
    const stored = await repos.portalMessages.list(fix.healthSystem.healthSystemId);
    expect(sorted(stored.map((row) => row.message.body))).toStrictEqual([
      "An invented answer.",
      "An invented question.",
    ]);
    expect(await repos.portalMessages.listSync()).toStrictEqual([
      expect.objectContaining({
        healthSystemId: fix.healthSystem.healthSystemId,
        lastErrorCode: null,
        complete: true,
        threads: 1,
        messages: 2,
      }),
    ]);
  });

  it("records a failed read without costing the visits, and never signs in for it", async () => {
    const fix = await fixture({
      portal: {
        visits: [portalVisit({ csn: "csn-1" })],
        messagesError: new AppError("portal_session_expired", "the session died mid-read"),
      },
    });

    const summary = await portalRun(fix);

    expect(summary.eventsInserted).toBe(1);
    expect(summary.portalMessages).toBe(0);
    expect(fix.portal.calls.logins).toBe(0);
    const [sync] = await syncRepos(fix.ctx).portalMessages.listSync();
    expect(sync).toMatchObject({ lastErrorCode: "portal_session_expired", lastOkAt: null });
  });

  describe("attachments", () => {
    const FILE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

    it("fetches and seals every file the read listed, once, and never stores the handle", async () => {
      const fix = await fixture({
        portal: {
          threads: [withAttachments(false)],
          files: files([
            ["WP-a", { contentType: "image/png", bytes: FILE }],
            ["WP-b", new AppError("portal_parse_failed", "a page where the file should be")],
          ]),
        },
      });

      await portalRun(fix);
      await portalRun(fix);

      // WP-b failed on the first run and is not retried within the day; WP-a is stored.
      expect(fix.portal.calls.attachments).toStrictEqual(["WP-a", "WP-b"]);
      const repos = syncRepos(fix.ctx);
      const id = fix.healthSystem.healthSystemId;
      const rows = await repos.portalMessageAttachments.list(id);
      expect(sorted(rows.map((row) => `${row.state}:${row.errorCode ?? ""}`))).toStrictEqual([
        "failed:portal_parse_failed",
        "stored:",
      ]);
      const stored = rows.find((row) => row.state === "stored");
      expect(stored?.meta).toStrictEqual({
        name: "invented-a",
        extension: "PNG",
        contentType: "image/png",
        size: FILE.length,
      });
      expect([
        ...((await repos.portalMessageAttachments.content(id, stored?.attachmentKey ?? "")) ?? []),
      ]).toStrictEqual([...FILE]);
      const messages = await repos.portalMessages.list(id);
      expect(JSON.stringify(messages)).not.toContain("WP-a");
    });

    it("leaves a message the portal still marks unread alone until it has been read", async () => {
      const fix = await fixture({
        portal: {
          threads: [withAttachments(true)],
          files: files([
            ["WP-a", { contentType: "image/png", bytes: FILE }],
            ["WP-b", { contentType: "image/png", bytes: FILE }],
          ]),
        },
      });

      await portalRun(fix);
      expect(fix.portal.calls.attachments).toStrictEqual([]);

      fix.portal.threads = [withAttachments(false)];
      await portalRun(fix);
      expect(fix.portal.calls.attachments).toStrictEqual(["WP-a", "WP-b"]);
    });

    it("stops at an expired session without marking anything failed", async () => {
      const fix = await fixture({
        portal: {
          threads: [withAttachments(false)],
          files: files([["WP-a", new AppError("portal_session_expired", "gone")]]),
        },
      });

      await portalRun(fix);

      expect(fix.portal.calls.attachments).toStrictEqual(["WP-a"]);
      const rows = await syncRepos(fix.ctx).portalMessageAttachments.list(
        fix.healthSystem.healthSystemId,
      );
      expect(rows).toStrictEqual([]);
      const [sync] = await syncRepos(fix.ctx).portalMessages.listSync();
      expect(sync).toMatchObject({ lastErrorCode: null });
    });
  });

  it("does not read messages at all when the session is dead and the run will not sign in", async () => {
    const fix = await fixture({ portal: { alive: false, threads: [THREAD] } });

    await runCalendarSync(fix.ctx, {
      trigger: "manual",
      portalOnly: true,
      signInWaitSeconds: 0,
      deps: { ...fix.upstreams.deps, portalAdapter: fix.portal.adapter },
    });

    expect(fix.portal.calls.loadMessages).toBe(0);
    expect(fix.portal.calls.logins).toBe(0);
  });
});

/** The one calendared copy of a portal visit, or a test failure. */
async function eventOf(fix: Fixture, csn: string): Promise<Record<string, unknown>> {
  const event = fix.upstreams.calendar.byKey().get(await portalKey(fix.healthSystem, csn));
  if (event === undefined) throw new Error(`${csn} was not calendared`);
  return event;
}

describe("the owner's edits to a title", () => {
  it("survive a change that patches the event, and cost no write once settled", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);
    const event = await eventOf(fix, "csn-1");
    event.summary = "Follow-up · A. Example, MD (bring the forms)";

    // The edit alone is not a change to write back.
    const untouched = await portalRun(fix);
    expect(untouched.eventsPatched).toBe(0);

    fix.portal.visits = [portalVisit({ csn: "csn-1", department: "Another Clinic" })];
    const patched = await portalRun(fix);
    expect(patched.eventsPatched).toBe(1);
    expect(event.summary).toBe("Follow-up · A. Example, MD (bring the forms)");
    expect(String(event.description)).toContain("Another Clinic");

    // A title Healthy would now write differently still does not move it.
    fix.portal.visits = [portalVisit({ csn: "csn-1", visitType: "Annual physical" })];
    await portalRun(fix);
    expect(event.summary).toBe("Follow-up · A. Example, MD (bring the forms)");
    const settled = await portalRun(fix);
    expect(settled.eventsPatched).toBe(0);
  });

  it("hand the title back when the owner restores exactly what Healthy last wrote", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);
    const event = await eventOf(fix, "csn-1");
    event.summary = "My own name for it";
    fix.portal.visits = [portalVisit({ csn: "csn-1", visitType: "Annual physical" })];
    await portalRun(fix);
    expect(event.summary).toBe("My own name for it");

    // Back to the title Healthy last wrote: Healthy's again, and the title it
    // computes now replaces it (the fingerprint already matched: `title_drift`).
    event.summary = "Follow-up · A. Example, MD";
    const drift = await portalRun(fix);
    expect(drift.eventsPatched).toBe(1);
    expect(event.summary).toBe("Annual physical · A. Example, MD");
    const again1 = await portalRun(fix);
    expect(again1.eventsPatched).toBe(0);
  });

  it("survive ghosting: a cancelled visit keeps the owner's title, without the prefix", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);
    const event = await eventOf(fix, "csn-1");
    event.summary = "Dentist, finally";

    fix.portal.visits = [portalVisit({ csn: "csn-1", status: "canceled" })];
    const ghosted = await portalRun(fix);
    expect(ghosted.eventsGhosted).toBe(1);
    expect(event.summary).toBe("Dentist, finally");
    expect(event.transparency).toBe("transparent");
    const again2 = await portalRun(fix);
    expect(again2.eventsGhosted).toBe(0);
  });

  it("seed a row written before titles were tracked, so a later edit still survives", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);
    await fix.ctx.db.prepare("UPDATE calendar_events SET title_digest = NULL").run();

    // Google's title is the one Healthy computes: Healthy's, seeded, no write.
    const seeded = await portalRun(fix);
    expect(seeded.eventsPatched).toBe(0);
    const row = await syncRepos(fix.ctx).calendarEvents.getByKey(
      await portalKey(fix.healthSystem, "csn-1"),
    );
    expect(row?.title_digest).not.toBeNull();

    const event = await eventOf(fix, "csn-1");
    event.summary = "Edited after the upgrade";
    fix.portal.visits = [portalVisit({ csn: "csn-1", department: "Another Clinic" })];
    await portalRun(fix);
    expect(event.summary).toBe("Edited after the upgrade");
  });

  it("treat a legacy title Healthy provably did not write as the owner's", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    await portalRun(fix);
    await fix.ctx.db.prepare("UPDATE calendar_events SET title_digest = NULL").run();
    // Edited before titles were tracked, with nothing upstream moving since: the
    // row's fingerprint still vouches for the title Healthy wrote.
    const event = await eventOf(fix, "csn-1");
    event.summary = "An edit from before the upgrade";

    const again3 = await portalRun(fix);
    expect(again3.eventsPatched).toBe(0);
    fix.portal.visits = [portalVisit({ csn: "csn-1", department: "Another Clinic" })];
    await portalRun(fix);
    expect(event.summary).toBe("An edit from before the upgrade");
  });

  it("keep the recorded title when the FHIR pass adopts the portal's event", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1", start: SOON })] } });
    await portalRun(fix);
    const event = await eventOf(fix, "csn-1");
    event.summary = "Mine";

    withEncounters(fix, [appointment("enc-1", "2026-06-20T14:31:00+00:00", "csn-1")]);
    await portalRun(fix, false);

    // Rekeyed and patched from the Encounter, and the owner's title is still there.
    expect(calendarKeys(fix)).toStrictEqual([await sk(`${fix.healthSystem.healthSystemId}:enc-1`)]);
    expect(event.summary).toBe("Mine");
  });
});

describe("a visit's details page", () => {
  it("links the visit line to the visit itself, by the portal's own token", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "tok-1/+" })] } });
    await portalRun(fix);

    const event = await eventOf(fix, "tok-1/+");
    expect(String(event.description)).toContain(
      `<a href="${PORTAL_ORIGIN}/MyChart/Visits/VisitDetails?csn=tok-1%2F%2B">Follow-up · scheduled</a>`,
    );
    expect(fix.portal.calls.visitDetails).toStrictEqual(["tok-1/+"]);
  });

  it("never deep-links a second-hand visit, as the portal's own client does not", async () => {
    const fix = await fixture({
      portal: { visits: [portalVisit({ csn: "csn-x", external: true })] },
    });
    await portalRun(fix);

    const event = await eventOf(fix, "csn-x");
    // The health system's own portal url, as before: no details page for it.
    expect(String(event.description)).toContain("<a href=");
    expect(String(event.description)).not.toContain("VisitDetails");
  });

  it("puts the directions and instructions first, and stores them with the wait list", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    fix.portal.details.set("csn-1", {
      waitlist: { enrolled: false },
      directions: "Suite 200, second floor.",
      visitInstructions: "Bring a list of your medicines.",
    });
    await portalRun(fix);

    const event4 = await eventOf(fix, "csn-1");
    const text = String(event4.description);
    const header = text.indexOf("Synced by Healthy");
    const directions = text.indexOf("Directions:<br>Suite 200, second floor.");
    const instructions = text.indexOf("Visit instructions:<br>Bring a list of your medicines.");
    const clinic = text.indexOf("Example Clinic");
    expect(header).toBeGreaterThanOrEqual(0);
    expect(directions).toBeGreaterThan(header);
    expect(instructions).toBeGreaterThan(directions);
    expect(clinic).toBeGreaterThan(instructions);

    const stored = await syncRepos(fix.ctx).portalVisits.list(fix.healthSystem.healthSystemId);
    expect(stored[0]?.visit.waitlist).toStrictEqual({ enrolled: false });
    expect(stored[0]?.visit.directions).toBe("Suite 200, second floor.");
  });

  it("strips the paragraphs the health system repeats under every department", async () => {
    const boiler = "Check in online before you arrive.";
    const visits = [
      portalVisit({ csn: "csn-1", start: SOON }),
      portalVisit({
        csn: "csn-2",
        department: "Other Clinic",
        practitioner: "B. Example, DO",
        start: "2026-07-01T14:30:00+00:00",
      }),
      portalVisit({
        csn: "csn-3",
        department: "Other Clinic",
        practitioner: "B. Example, DO",
        start: "2026-07-02T14:30:00+00:00",
      }),
    ];
    const fix = await fixture({ portal: { visits } });
    fix.portal.details.set("csn-1", {
      waitlist: null,
      directions: `${boiler}\n\nTower A, suite 1.`,
    });
    fix.portal.details.set("csn-2", {
      waitlist: null,
      directions: `Tower B, suite 2.\n\n${boiler}`,
    });
    fix.portal.details.set("csn-3", {
      waitlist: null,
      directions: `Tower B, suite 2.\n\n${boiler}`,
    });
    await portalRun(fix);

    const event5 = await eventOf(fix, "csn-1");
    const first = String(event5.description);
    expect(first).toContain("Directions:<br>Tower A, suite 1.");
    expect(first).not.toContain(boiler);
    // Repeated, but only ever under one department: real directions, kept.
    const event6 = await eventOf(fix, "csn-2");
    expect(String(event6.description)).toContain("Tower B, suite 2.");
  });

  it("keeps the stored details when a page cannot be read, so nothing is re-patched", async () => {
    const fix = await fixture({ portal: { visits: [portalVisit({ csn: "csn-1" })] } });
    fix.portal.details.set("csn-1", { waitlist: { enrolled: true }, directions: "Suite 200." });
    await portalRun(fix);

    fix.portal.details.set("csn-1", new AppError("portal_parse_failed", "the page failed"));
    const summary = await portalRun(fix);
    expect(summary.eventsPatched).toBe(0);
    const stored = await syncRepos(fix.ctx).portalVisits.list(fix.healthSystem.healthSystemId);
    expect(stored[0]?.visit.waitlist).toStrictEqual({ enrolled: true });
    expect(stored[0]?.visit.directions).toBe("Suite 200.");
  });

  it("stops reading pages at an expired session, keeping every visit's stored copy", async () => {
    const visits = [
      portalVisit({ csn: "csn-1" }),
      portalVisit({ csn: "csn-2", start: "2026-07-01T14:30:00+00:00" }),
    ];
    const fix = await fixture({ portal: { visits } });
    fix.portal.details.set("csn-2", { waitlist: null, directions: "Suite 9." });
    await portalRun(fix);

    fix.portal.calls.visitDetails.length = 0;
    fix.portal.details.set("csn-1", new AppError("portal_session_expired", "signed out"));
    await portalRun(fix);
    expect(fix.portal.calls.visitDetails).toStrictEqual(["csn-1"]);
    const stored = await syncRepos(fix.ctx).portalVisits.list(fix.healthSystem.healthSystemId);
    expect(stored.find((row) => row.csn === "csn-2")?.visit.directions).toBe("Suite 9.");
  });

  it("gives an Encounter the portal copy's link and directions for the same visit", async () => {
    // The fixture's prac-1 renders as "Test Alpha"; the portal writes it its own way.
    const visit = portalVisit({ csn: "csn-1", start: SOON, practitioner: "Alpha, Test MD" });
    const fix = await fixture({ portal: { visits: [visit] } });
    fix.portal.details.set("csn-1", { waitlist: null, directions: "Suite 200." });
    // Stored by a first run, as the portal pass always has before the next FHIR pass.
    await portalRun(fix);
    withEncounters(fix, [appointment("enc-1", "2026-06-20T14:31:00+00:00")]);
    withPractitioners(fix);
    await portalRun(fix, false);

    const event = fix.upstreams.calendar
      .byKey()
      .get(await sk(`${fix.healthSystem.healthSystemId}:enc-1`));
    expect(String(event?.description)).toContain("VisitDetails?csn=csn-1");
    expect(String(event?.description)).toContain("Directions:<br>Suite 200.");
  });
});
