// End-to-end calendar sync, in real workerd against real D1.
//
// The FHIR server and the Google Calendar are in-memory but real in shape: events
// are built by `buildEventBody`, stored, and read back through the same
// `events.list` response the API sends -- so "the second run must not duplicate
// anything" is an assertion about the diff, not about a mock.

import { beforeEach, describe, expect, it } from "vitest";

import { getSetting, setSetting } from "../../../worker/db/settings.ts";
import { runCalendarSync } from "../../../worker/sync/calendar-sync.ts";

import {
  T0,
  clock,
  encounter,
  fhirServer,
  loggedEvent,
  loggedFields,
  recordingLog,
  referencePool,
  resetSyncDb,
  searchBundle,
  seedConnectedProvider,
  seedGoogle,
  seedSettings,
  stubUpstreams,
  syncCtx,
  syncRepos,
} from "./helpers.ts";

import type { FhirServer, Upstreams } from "./helpers.ts";
import type { Ctx } from "../../../worker/db/client.ts";
import type * as fhir4 from "fhir/r4";

beforeEach(resetSyncDb);

const HOST_A = "fhir.a.example.test";
const HOST_B = "fhir.b.example.test";

/** Two weeks after T0: comfortably inside the window and still upcoming. */
const UPCOMING = "2026-06-29T15:30:00Z";
/** Ten days before T0: inside the 90-day past window, already over. */
const PAST = "2026-06-05T14:00:00Z";

interface Harness {
  ctx: Ctx;
  time: ReturnType<typeof clock>;
  server: FhirServer;
  upstreams: Upstreams;
  providerId: string;
  connectionId: string;
  lines: string[];
}

/** One provider, one Google account, two appointments: the ordinary case. */
async function setup(
  options: { encounters?: Parameters<typeof encounter>[0][]; trello?: boolean } = {},
): Promise<Harness> {
  const time = clock();
  const { log, lines } = recordingLog();
  const ctx = syncCtx({ now: time.now, log, ...(options.trello === true && { trello: true }) });
  const seeded = await seedConnectedProvider(ctx, { host: HOST_A });
  await seedGoogle(ctx);
  await seedSettings(ctx);

  const server = fhirServer({ resources: referencePool() });
  server.encounters = searchBundle(
    (
      options.encounters ?? [
        { id: "enc-1", start: UPCOMING },
        { id: "enc-2", start: PAST, status: "finished" },
      ]
    ).map((spec) => encounter(spec)),
  );
  const upstreams = stubUpstreams({ [HOST_A]: server });
  return { ctx, time, server, upstreams, ...seeded, lines };
}

describe("the first run", () => {
  it("inserts one event per appointment and records them", async () => {
    const h = await setup();

    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.providers).toBe(1);
    expect(summary.encountersSeen).toBe(2);
    expect(summary.eventsInserted).toBe(2);
    expect(summary.eventsPatched).toBe(0);
    expect(summary.eventsGhosted).toBe(0);
    expect(summary.errors).toStrictEqual([]);
    expect(h.upstreams.calendar.events()).toHaveLength(2);

    const rows = await syncRepos(h.ctx).calendarEvents.list({ providerId: h.providerId });
    expect(rows.map((row) => row.encounter_id)).toStrictEqual(["enc-2", "enc-1"]);
    expect(rows.every((row) => row.state === "active")).toBe(true);
  });

  it("writes the invariant marker, the title and the resolved details", async () => {
    const h = await setup();

    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    const event = h.upstreams.calendar.byKey().get(`${h.providerId}:enc-1`);
    expect(event).toBeDefined();
    const properties = (event?.extendedProperties as { private: Record<string, string> }).private;
    expect(properties.healthy).toBe("1");
    expect(properties.provider).toBe(h.providerId);
    expect(event?.summary).toBe("Office Visit · Test Alpha");
    expect(event?.visibility).toBe("private");
    expect(event?.transparency).toBe("opaque");
    // The reference resolution is what supplies all three of these.
    expect(String(event?.description)).toContain("Example Regional");
    expect(String(event?.description)).toContain("Test Alpha — Cardiology");
    expect(String(event?.location)).toContain("1 Test Way");
  });

  it("caches the Encounters and their references for the MCP", async () => {
    const h = await setup();

    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    const counts = await syncRepos(h.ctx).fhirCache.countsByType();
    const byType = new Map(counts.map((row) => [row.resourceType, row.count]));
    expect(byType.get("Encounter")).toBe(2);
    expect(byType.get("Practitioner")).toBe(1);
    expect(byType.get("Location")).toBe(1);
    expect(byType.get("Organization")).toBe(1);
    // Discovery is cached in the same table under synthetic types; see
    // discovery.ts and the hand-off note about filtering them out.
    expect(byType.get("_smart")).toBe(1);
    expect(byType.get("_capability")).toBe(1);
  });

  it("writes one run_log row with counts and no personal data", async () => {
    const h = await setup();

    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    const runs = await syncRepos(h.ctx).runLog.listRecent();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.kind).toBe("calendar");
    expect(runs[0]?.ok).toBe(true);
    expect(runs[0]?.summary.inserted).toBe(2);
    expect(runs[0]?.summary.providers).toBe(1);
    expect(JSON.stringify(runs[0]?.summary)).not.toContain(h.providerId);
  });

  it("records the trigger as manual when a human asked for it", async () => {
    const h = await setup();

    await runCalendarSync(h.ctx, { trigger: "manual", deps: h.upstreams.deps });

    await expect(syncRepos(h.ctx).runLog.listRecent()).resolves.toMatchObject([{ kind: "manual" }]);
  });

  it("resolves each reference once however many appointments share it", async () => {
    const h = await setup();

    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    // Two Encounters, one practitioner, one location, one organization.
    expect(h.server.readCalls).toBe(3);
  });

  it("re-reads nothing on the next run, because the cache holds the references", async () => {
    const h = await setup();
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const after = h.server.readCalls;

    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(h.server.readCalls).toBe(after);
  });
});

describe("the second run", () => {
  it("patches a moved appointment and ghosts one that vanished", async () => {
    const h = await setup();
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const firstIds = h.upstreams.calendar.events().map((event) => event.id);

    // enc-1 moved an hour later; enc-2 is no longer on the schedule at all.
    h.time.advance(3600);
    h.server.encounters = searchBundle([encounter({ id: "enc-1", start: "2026-06-29T16:30:00Z" })]);

    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.eventsPatched).toBe(1);
    expect(summary.eventsGhosted).toBe(1);
    expect(summary.eventsInserted).toBe(0);
    // No duplicates: the same two Google events, patched in place.
    expect(h.upstreams.calendar.events().map((event) => event.id)).toStrictEqual(firstIds);

    const ghost = h.upstreams.calendar.byKey().get(`${h.providerId}:enc-2`);
    expect(ghost?.summary).toBe("Cancelled: Office Visit · Test Alpha");
  });

  it("dresses the ghost as a cancellation and keeps its details", async () => {
    const h = await setup();
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    h.time.advance(3600);
    h.server.encounters = searchBundle([encounter({ id: "enc-1", start: UPCOMING })]);
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    const ghost = h.upstreams.calendar.byKey().get(`${h.providerId}:enc-2`);
    expect(String(ghost?.summary).startsWith("Cancelled: ")).toBe(true);
    expect(ghost?.transparency).toBe("transparent");
    expect(ghost?.colorId).toBe("8");
    // Rebuilt from fhir_cache, so the original details survive the disappearance.
    expect(String(ghost?.description)).toContain("Example Regional");
    expect(String(ghost?.description)).toContain("No longer on the provider's schedule as of");

    const row = await syncRepos(h.ctx).calendarEvents.getByKey(`${h.providerId}:enc-2`);
    expect(row?.state).toBe("ghost");
    expect(row?.ghosted_at).toBe(T0 + 3600);
  });

  it("does nothing at all when nothing changed", async () => {
    const h = await setup();
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const patchesAfterFirst = h.upstreams.calendar.patches;

    // An hour later the footer's "last checked" time has moved, and that must not
    // be enough to provoke a patch.
    h.time.advance(3600);
    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.eventsInserted).toBe(0);
    expect(summary.eventsPatched).toBe(0);
    expect(summary.eventsGhosted).toBe(0);
    expect(h.upstreams.calendar.patches).toBe(patchesAfterFirst);
  });

  it("settles a ghost after one pass", async () => {
    const h = await setup();
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    h.time.advance(3600);
    h.server.encounters = searchBundle([encounter({ id: "enc-1", start: UPCOMING })]);
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const patches = h.upstreams.calendar.patches;

    h.time.advance(3600);
    const third = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(third.eventsGhosted).toBe(0);
    expect(h.upstreams.calendar.patches).toBe(patches);
  });

  it("writes the ghost row once and leaves it alone on every run after", async () => {
    // The regression this pins: ghosting has to move the state and the fingerprint
    // in the same statement, and leave `ghosted_at` where it first landed. Move
    // either half on its own and the third run sees a stale fingerprint, patches
    // the same event again, re-stamps `ghosted_at`, and so does every run after it.
    const h = await setup();
    const key = `${h.providerId}:enc-2`;
    const repos = syncRepos(h.ctx);
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const active = await repos.calendarEvents.getByKey(key);

    h.time.advance(3600);
    h.server.encounters = searchBundle([encounter({ id: "enc-1", start: UPCOMING })]);
    const second = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const ghosted = await repos.calendarEvents.getByKey(key);

    h.time.advance(3600);
    const third = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const settled = await repos.calendarEvents.getByKey(key);

    expect(second.eventsGhosted).toBe(1);
    expect(third.eventsGhosted).toBe(0);
    // The one patch is the ghost dressing, and the fingerprint now describes it.
    expect(ghosted?.state).toBe("ghost");
    expect(ghosted?.ghosted_at).toBe(T0 + 3600);
    expect(ghosted?.fingerprint).not.toBe(active?.fingerprint);
    // Third run: still a ghost, same disappearance time, same fingerprint. Only
    // `last_seen_at` is allowed to move, and `touch` is what moves it.
    expect(settled?.state).toBe("ghost");
    expect(settled?.ghosted_at).toBe(T0 + 3600);
    expect(settled?.fingerprint).toBe(ghosted?.fingerprint);
  });
});

describe("the third run", () => {
  it("restores an appointment that reappeared", async () => {
    const h = await setup();
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const both = searchBundle([
      encounter({ id: "enc-1", start: UPCOMING }),
      encounter({ id: "enc-2", start: PAST, status: "finished" }),
    ]);

    h.time.advance(3600);
    h.server.encounters = searchBundle([encounter({ id: "enc-1", start: UPCOMING })]);
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    h.time.advance(3600);
    h.server.encounters = both;
    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.eventsRestored).toBe(1);
    expect(summary.eventsGhosted).toBe(0);
    const restored = h.upstreams.calendar.byKey().get(`${h.providerId}:enc-2`);
    expect(String(restored?.summary).startsWith("Cancelled: ")).toBe(false);
    expect(restored?.transparency).toBe("opaque");
    expect(String(restored?.description)).not.toContain("No longer on the provider's schedule");

    const row = await syncRepos(h.ctx).calendarEvents.getByKey(`${h.providerId}:enc-2`);
    expect(row?.state).toBe("active");
    expect(row?.ghosted_at).toBeNull();
  });
});

describe("cancellation and other statuses", () => {
  it("ghosts an appointment the organisation reports as cancelled", async () => {
    const h = await setup({ encounters: [{ id: "enc-1", start: UPCOMING }] });
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    h.time.advance(3600);
    h.server.encounters = searchBundle([
      encounter({ id: "enc-1", start: UPCOMING, status: "cancelled" }),
    ]);
    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.eventsGhosted).toBe(1);
    const ghost = h.upstreams.calendar.byKey().get(`${h.providerId}:enc-1`);
    expect(ghost?.transparency).toBe("transparent");
  });

  it("never writes an event for a cancellation it has not seen before", async () => {
    // A ghost for something that was never on the calendar would invent history.
    const h = await setup({ encounters: [{ id: "enc-1", start: UPCOMING, status: "cancelled" }] });

    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.eventsInserted).toBe(0);
    expect(summary.eventsGhosted).toBe(0);
    expect(h.upstreams.calendar.events()).toHaveLength(0);
  });

  it("ignores a status the calendar does not care about", async () => {
    const h = await setup({
      encounters: [
        { id: "enc-1", start: UPCOMING },
        { id: "enc-2", start: UPCOMING, status: "unknown" },
      ],
    });

    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.encountersSeen).toBe(1);
    expect(summary.eventsInserted).toBe(1);
  });

  it("ignores an Encounter with no start time", async () => {
    const h = await setup({ encounters: [{ id: "enc-1", start: UPCOMING }] });
    h.server.encounters = searchBundle([
      encounter({ id: "enc-1", start: UPCOMING }),
      { resourceType: "Encounter", id: "enc-undated", status: "planned", class: { code: "AMB" } },
    ]);

    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.eventsInserted).toBe(1);
  });
});

describe("an event the owner deleted by hand", () => {
  it("is re-created while the appointment is still ahead", async () => {
    const h = await setup({ encounters: [{ id: "enc-1", start: UPCOMING }] });
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const [first] = h.upstreams.calendar.events();
    h.upstreams.calendar.remove(String(first?.id));

    h.time.advance(3600);
    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.eventsInserted).toBe(1);
    expect(h.upstreams.calendar.events()).toHaveLength(1);
    const row = await syncRepos(h.ctx).calendarEvents.getByKey(`${h.providerId}:enc-1`);
    expect(row?.google_event_id).not.toBe(first?.id);
  });

  it("is left deleted and the row ghosted once the appointment is over", async () => {
    const h = await setup({ encounters: [{ id: "enc-1", start: PAST, status: "finished" }] });
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const [first] = h.upstreams.calendar.events();
    h.upstreams.calendar.remove(String(first?.id));

    h.time.advance(3600);
    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.eventsInserted).toBe(0);
    expect(summary.eventsGhosted).toBe(1);
    expect(h.upstreams.calendar.events()).toHaveLength(0);
    await expect(
      syncRepos(h.ctx).calendarEvents.getByKey(`${h.providerId}:enc-1`),
    ).resolves.toMatchObject({ state: "ghost" });
    expect(loggedEvent(h.lines, "sync.ghost.row_only")).toBe(true);

    // Regression: neither the sync's own ghost log nor the repo's must carry the
    // upstream encounter id, joined or bare. `providerId` (our row id) and a short
    // digest are the only identifiers allowed through -- see
    // `worker/db/repos/calendar-events.ts`'s `logSafeKey` and SECURITY.md, "No PHI
    // in logs".
    for (const event of ["sync.ghost.row_only", "calendar_events.ghosted"]) {
      const fields = loggedFields(h.lines, event);
      expect(fields.length).toBeGreaterThan(0);
      for (const line of fields) {
        const serialized = JSON.stringify(line);
        expect(serialized).not.toContain(`${h.providerId}:`);
        expect(serialized).not.toContain("enc-1");
      }
    }
  });
});

describe("the invariant", () => {
  it("never touches an event that does not carry the marker", async () => {
    const h = await setup({ encounters: [{ id: "enc-1", start: UPCOMING }] });
    h.upstreams.calendar.plant({
      summary: "Dinner",
      start: { dateTime: UPCOMING, timeZone: "UTC" },
      end: { dateTime: "2026-06-29T17:00:00Z", timeZone: "UTC" },
    });

    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    const planted = h.upstreams.calendar.events().find((event) => event.summary === "Dinner");
    expect(planted).toBeDefined();
    expect(planted?.transparency).toBeUndefined();
  });

  it("reports an event of ours whose key it does not recognise, and leaves it alone", async () => {
    const h = await setup({ encounters: [{ id: "enc-1", start: UPCOMING }] });
    h.upstreams.calendar.plant({
      summary: "Old sync artefact",
      start: { dateTime: UPCOMING, timeZone: "UTC" },
      end: { dateTime: "2026-06-29T17:00:00Z", timeZone: "UTC" },
      extendedProperties: {
        private: { healthy: "1", key: `${h.providerId}:gone-forever`, provider: h.providerId },
      },
    });

    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(loggedEvent(h.lines, "sync.orphans")).toBe(true);
    const orphan = h.upstreams.calendar
      .events()
      .find((event) => event.summary === "Old sync artefact");
    expect(orphan?.transparency).toBeUndefined();
  });
});

describe("the window", () => {
  it("never ghosts a row that is simply older than the search window", async () => {
    // The search asks for `date >= today - 90d`, so an older appointment is absent
    // from every run by construction. Ghosting it would be wrong.
    const h = await setup({ encounters: [{ id: "enc-1", start: UPCOMING }] });
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const repos = syncRepos(h.ctx);
    await repos.calendarEvents.upsert({
      eventKey: `${h.providerId}:ancient`,
      providerId: h.providerId,
      encounterId: "ancient",
      calendarId: "primary",
      googleEventId: "google-ancient",
      fingerprint: "ancient-fp",
      startAt: T0 - 400 * 86_400,
    });

    h.time.advance(3600);
    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.eventsGhosted).toBe(0);
    await expect(repos.calendarEvents.getByKey(`${h.providerId}:ancient`)).resolves.toMatchObject({
      state: "active",
    });
  });
});

/** Epic's "the patient-facing view filtered these results" warning (4119). */
function filteredViewOutcome(): fhir4.OperationOutcome {
  return {
    resourceType: "OperationOutcome",
    issue: [
      {
        severity: "warning",
        code: "incomplete",
        details: { coding: [{ code: "4119" }], text: "patient view filtered results" },
      },
    ],
  };
}

describe("Epic 4119, the filtered patient view", () => {
  it("still inserts, but refuses to ghost on absence alone", async () => {
    const h = await setup({ encounters: [{ id: "enc-1", start: UPCOMING }] });
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    h.time.advance(3600);
    h.server.encounters = {
      resourceType: "Bundle",
      type: "searchset",
      entry: [
        { resource: encounter({ id: "enc-2", start: UPCOMING }), search: { mode: "match" } },
        { search: { mode: "outcome" }, resource: filteredViewOutcome() },
      ],
    };
    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.filteredView).toBe(true);
    expect(summary.warnings).toBeGreaterThan(0);
    expect(summary.eventsInserted).toBe(1);
    expect(summary.eventsGhosted).toBe(0);
    await expect(
      syncRepos(h.ctx).calendarEvents.getByKey(`${h.providerId}:enc-1`),
    ).resolves.toMatchObject({ state: "active" });
  });
});

/**
 * Two providers, sorted so "A" is attempted first.
 *
 * A's access token is already inside the five-minute refresh skew, so its very
 * first request goes through the refresh path -- which is what lets a test make
 * that refresh fail without touching anything B does.
 */
async function twoProviders(options: { trello?: boolean } = {}) {
  const time = clock();
  const { log, lines } = recordingLog();
  const ctx = syncCtx({ now: time.now, log, ...(options.trello === true && { trello: true }) });
  const a = await seedConnectedProvider(ctx, {
    host: HOST_A,
    displayName: "A Example Health",
    accessTtlSeconds: 60,
  });
  const b = await seedConnectedProvider(ctx, { host: HOST_B, displayName: "B Example Health" });
  await seedGoogle(ctx);
  await seedSettings(ctx);

  const serverA = fhirServer({ resources: referencePool() });
  const serverB = fhirServer({ resources: referencePool() });
  serverA.encounters = searchBundle([encounter({ id: "enc-a", start: UPCOMING })]);
  serverB.encounters = searchBundle([encounter({ id: "enc-b", start: UPCOMING })]);
  const upstreams = stubUpstreams({ [HOST_A]: serverA, [HOST_B]: serverB });
  return { ctx, time, a, b, serverA, serverB, upstreams, lines };
}

describe("per-provider isolation", () => {
  it("marks a rejected grant, opens an alert, and syncs the other provider anyway", async () => {
    const h = await twoProviders();
    h.serverA.tokenInvalidGrant = true;

    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    const repos = syncRepos(h.ctx);
    await expect(repos.connections.get(h.a.connectionId)).resolves.toMatchObject({
      status: "needs_reauth",
      last_error_code: "needs_reauth",
    });
    expect(summary.errors).toStrictEqual([{ providerId: h.a.providerId, code: "needs_reauth" }]);

    const alerts = await repos.alerts.listOpen();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.subject).toBe(`provider:${h.a.providerId}`);
    // Trello is unconfigured in this env, so the row still lands and the fact is
    // logged rather than throwing into the sync.
    expect(alerts[0]?.trello_card_id).toBeNull();
    expect(loggedEvent(h.lines, "alert.trello.unconfigured")).toBe(true);

    // The other organisation's appointment is on the calendar regardless.
    expect(summary.eventsInserted).toBe(1);
    expect(h.upstreams.calendar.byKey().has(`${h.b.providerId}:enc-b`)).toBe(true);
  });

  it("opens a Trello card, once, when Trello is configured", async () => {
    const h = await twoProviders({ trello: true });
    h.serverA.tokenInvalidGrant = true;

    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(h.upstreams.trelloCards).toHaveLength(1);
    expect(h.upstreams.trelloCards[0]?.name).toBe("Reconnect A Example Health to Healthy");
    expect(h.upstreams.trelloCards[0]?.desc).toContain(
      `https://healthy.example.test/oauth/reconnect/${h.a.connectionId}`,
    );
    await expect(syncRepos(h.ctx).alerts.listOpen()).resolves.toMatchObject([
      { trello_card_id: "card-1" },
    ]);

    // A second failing run must not open a second card.
    h.time.advance(3600);
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    expect(h.upstreams.trelloCards).toHaveLength(1);
  });

  it("clears the alert once the connection works again", async () => {
    const h = await twoProviders({ trello: true });
    h.serverA.tokenInvalidGrant = true;
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const repos = syncRepos(h.ctx);

    // The owner reconnects: status back to connected, and the grant works.
    h.serverA.tokenInvalidGrant = false;
    await repos.connections.markConnected(h.a.connectionId);
    h.time.advance(3600);

    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    await expect(repos.alerts.listOpen()).resolves.toStrictEqual([]);
    // dueComplete + a move to the Done list: one PUT on the card.
    expect(h.upstreams.trelloCalls.some((call) => call.method === "PUT")).toBe(true);
  });

  it("keeps the tokens when the token endpoint merely fails", async () => {
    // The rule this protects: only `invalid_grant` means the grant is gone. A 500
    // is a blip, and throwing away a working refresh token over one would cost the
    // owner a re-authorisation they did not need. The connection goes to `error`,
    // which `syncTargets` retries on the next run.
    const h = await twoProviders();
    h.serverA.tokenStatus = 500;

    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    const repos = syncRepos(h.ctx);
    await expect(repos.connections.get(h.a.connectionId)).resolves.toMatchObject({
      status: "error",
    });
    const secrets = await repos.connections.getSecrets(h.a.connectionId);
    expect(secrets?.refreshToken).toBe("seeded-refresh-token");
    expect(secrets?.accessToken).toBe("seeded-access-token");

    // No reconnect alert: there is nothing for the owner to do about a 500.
    await expect(repos.alerts.listOpen()).resolves.toStrictEqual([]);
    expect(summary.errors).toStrictEqual([
      { providerId: h.a.providerId, code: "upstream_unavailable" },
    ]);
    // And the other organisation is unaffected.
    expect(summary.eventsInserted).toBe(1);
    expect(h.upstreams.calendar.byKey().has(`${h.b.providerId}:enc-b`)).toBe(true);
  });

  it("recovers on the next run once the token endpoint is back", async () => {
    const h = await twoProviders();
    h.serverA.tokenStatus = 500;
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    h.serverA.tokenStatus = null;

    h.time.advance(3600);
    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.errors).toStrictEqual([]);
    expect(h.upstreams.calendar.byKey().has(`${h.a.providerId}:enc-a`)).toBe(true);
    await expect(syncRepos(h.ctx).connections.get(h.a.connectionId)).resolves.toMatchObject({
      status: "connected",
    });
  });

  it("rotates and stores the refresh token before the new access token is used", async () => {
    const h = await twoProviders();

    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    const repos = syncRepos(h.ctx);
    const secrets = await repos.connections.getSecrets(h.a.connectionId);
    expect(secrets?.refreshToken).toBe("refreshed-refresh-token");
    expect(secrets?.accessToken).toBe("refreshed-access-token");
    await expect(repos.connections.get(h.a.connectionId)).resolves.toMatchObject({
      status: "connected",
      last_refresh_at: T0,
    });
  });

  it("stops every provider and backs off when one returns 429", async () => {
    const h = await twoProviders();
    // Provider A sorts first by display name, so B is the one that must be spared.
    h.serverA.encounterStatus = 429;
    h.serverA.retryAfter = "60";

    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.backedOff).toBe(true);
    expect(summary.errors.map((error) => error.providerId)).toStrictEqual([h.a.providerId]);
    // Two hours, not the 60 seconds the header asked for: see backoff.ts.
    const until = await getSetting(h.ctx, "sync_backoff_until");
    expect(until).toBe(T0 + 2 * 60 * 60);
    expect(h.serverB.searchCalls).toBe(0);
    expect(h.upstreams.calendar.events()).toHaveLength(0);
  });

  it("skips the next hourly run while the backoff stands", async () => {
    const h = await twoProviders();
    h.serverA.encounterStatus = 429;
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const repos = syncRepos(h.ctx);
    const firstRuns = await repos.runLog.listRecent();
    h.serverA.encounterStatus = null;

    h.time.advance(3600);
    const skipped = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(skipped.backedOff).toBe(true);
    expect(skipped.eventsInserted).toBe(0);
    // A skipped run writes no row: an hour of them would bury the real ones.
    await expect(repos.runLog.listRecent()).resolves.toHaveLength(firstRuns.length);
    expect(loggedEvent(h.lines, "sync.backoff.skip")).toBe(true);
  });

  it("runs anyway when a human forces it, and clears the backoff", async () => {
    const h = await twoProviders();
    h.serverA.encounterStatus = 429;
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    h.serverA.encounterStatus = null;

    h.time.advance(3600);
    const forced = await runCalendarSync(h.ctx, {
      force: true,
      trigger: "manual",
      deps: h.upstreams.deps,
    });

    expect(forced.backedOff).toBe(false);
    expect(forced.eventsInserted).toBe(2);
    await expect(getSetting(h.ctx, "sync_backoff_until")).resolves.toBeNull();
  });

  it("narrows the run to the providers it was asked for", async () => {
    const h = await twoProviders();

    await runCalendarSync(h.ctx, {
      providerIds: [h.b.providerId],
      deps: h.upstreams.deps,
    });

    expect(h.serverA.searchCalls).toBe(0);
    expect(h.serverB.searchCalls).toBe(1);
  });

  it("skips a provider switched off in its own config", async () => {
    const h = await twoProviders();
    await syncRepos(h.ctx).providers.update(h.b.providerId, { config: { enabled: false } });

    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.providers).toBe(1);
    expect(h.serverB.searchCalls).toBe(0);
  });

  it("retries a provider left in the error state by a previous run", async () => {
    // `connections.listActive()` would have hidden it; the sync deliberately
    // does not use that.
    const h = await twoProviders();
    await syncRepos(h.ctx).connections.markError(h.b.connectionId, "upstream_unavailable");

    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(h.serverB.searchCalls).toBe(1);
    expect(summary.eventsInserted).toBeGreaterThan(0);
    await expect(syncRepos(h.ctx).connections.get(h.b.connectionId)).resolves.toMatchObject({
      status: "connected",
    });
  });
});

describe("Google unavailable", () => {
  it("does not ask any organisation for appointments it cannot write down", async () => {
    const time = clock();
    const { log } = recordingLog();
    const ctx = syncCtx({ now: time.now, log });
    await seedConnectedProvider(ctx, { host: HOST_A });
    await seedSettings(ctx);
    // Google is never connected.
    const server = fhirServer({ resources: referencePool() });
    server.encounters = searchBundle([encounter({ id: "enc-1", start: UPCOMING })]);
    const upstreams = stubUpstreams({ [HOST_A]: server });

    const summary = await runCalendarSync(ctx, { deps: upstreams.deps });

    expect(summary.errors).toStrictEqual([{ providerId: "google", code: "not_connected" }]);
    expect(server.searchCalls).toBe(0);
  });

  it("refreshes an expiring Google token before it writes", async () => {
    const time = clock();
    const ctx = syncCtx({ now: time.now });
    await seedConnectedProvider(ctx, { host: HOST_A });
    await seedGoogle(ctx, 60);
    await seedSettings(ctx);
    const server = fhirServer({ resources: referencePool() });
    server.encounters = searchBundle([encounter({ id: "enc-1", start: UPCOMING })]);
    const upstreams = stubUpstreams({ [HOST_A]: server });

    const summary = await runCalendarSync(ctx, { deps: upstreams.deps });

    expect(upstreams.googleRefreshes).toBe(1);
    expect(summary.eventsInserted).toBe(1);
    // The refresh returned no `scope`, and the stored one must survive that.
    await expect(syncRepos(ctx).google.get()).resolves.toMatchObject({
      scope: "https://www.googleapis.com/auth/calendar.events.owned",
      status: "connected",
    });
  });
});

describe("per-provider configuration", () => {
  it("uses the provider's title template, colour and arrival offset", async () => {
    const time = clock();
    const ctx = syncCtx({ now: time.now });
    const seeded = await seedConnectedProvider(ctx, {
      host: HOST_A,
      config: {
        title_template: "{orgShort}: {visitType}",
        color_id: "5",
        arrival_offset_min: 25,
        org_short: "AEH",
      },
    });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    const server = fhirServer({ resources: referencePool() });
    server.encounters = searchBundle([encounter({ id: "enc-1", start: UPCOMING })]);
    const upstreams = stubUpstreams({ [HOST_A]: server });

    await runCalendarSync(ctx, { deps: upstreams.deps });

    const event = upstreams.calendar.byKey().get(`${seeded.providerId}:enc-1`);
    expect(event?.summary).toBe("AEH: Office Visit (appt 3:30 PM)");
    expect(event?.colorId).toBe("5");
    expect((event?.start as { dateTime: string }).dateTime).toBe("2026-06-29T15:05:00.000Z");
  });
});

describe("nothing to do", () => {
  it("writes a clean run when there are no providers at all", async () => {
    const ctx = syncCtx();
    await seedGoogle(ctx);
    await seedSettings(ctx);
    const upstreams = stubUpstreams({});

    const summary = await runCalendarSync(ctx, { deps: upstreams.deps });

    expect(summary.providers).toBe(0);
    expect(summary.errors).toStrictEqual([]);
    await expect(syncRepos(ctx).runLog.listRecent()).resolves.toMatchObject([{ ok: true }]);
  });
});

describe("changing the target calendar", () => {
  it("moves a tracked event instead of duplicating it", async () => {
    const h = await setup({ encounters: [{ id: "enc-1", start: UPCOMING }] });
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const original = h.upstreams.calendar.byKeyOn("primary").get(`${h.providerId}:enc-1`);
    expect(original).toBeDefined();

    await setSetting(h.ctx, "calendar_id", "vacation");
    h.time.advance(3600);
    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.errors).toStrictEqual([]);
    expect(summary.eventsInserted).toBe(0);
    // Exactly one event, anywhere: the same Google event id as before, now on
    // the new calendar -- not a second, duplicate insert.
    expect(h.upstreams.calendar.events()).toHaveLength(1);
    expect(h.upstreams.calendar.byKeyOn("primary").size).toBe(0);
    const moved = h.upstreams.calendar.byKeyOn("vacation").get(`${h.providerId}:enc-1`);
    expect(moved?.id).toBe(original?.id);
    expect(h.upstreams.calendar.moves).toBe(1);

    const row = await syncRepos(h.ctx).calendarEvents.getByKey(`${h.providerId}:enc-1`);
    expect(row?.calendar_id).toBe("vacation");
    expect(row?.google_event_id).toBe(original?.id);
  });

  it("ghosts a cancellation on the new calendar rather than stranding a live-looking copy on the old one", async () => {
    const h = await setup({ encounters: [{ id: "enc-1", start: UPCOMING }] });
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    await setSetting(h.ctx, "calendar_id", "vacation");
    h.time.advance(3600);
    // The appointment is gone from the schedule -- cancelled, in this app's terms.
    h.server.encounters = searchBundle([]);
    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.eventsGhosted).toBe(1);
    expect(summary.eventsInserted).toBe(0);
    expect(h.upstreams.calendar.byKeyOn("primary").size).toBe(0);
    const ghost = h.upstreams.calendar.byKeyOn("vacation").get(`${h.providerId}:enc-1`);
    expect(ghost).toBeDefined();
    expect(String(ghost?.summary).startsWith("Cancelled: ")).toBe(true);

    const row = await syncRepos(h.ctx).calendarEvents.getByKey(`${h.providerId}:enc-1`);
    expect(row?.calendar_id).toBe("vacation");
    expect(row?.state).toBe("ghost");
  });

  it("re-creates on the new calendar when the event is also gone from the old one", async () => {
    const h = await setup({ encounters: [{ id: "enc-1", start: UPCOMING }] });
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const [original] = h.upstreams.calendar.events();
    // The owner deleted the event by hand before ever switching calendars.
    h.upstreams.calendar.remove(String(original?.id));

    await setSetting(h.ctx, "calendar_id", "vacation");
    h.time.advance(3600);
    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.errors).toStrictEqual([]);
    // The plan's ordinary "owner deleted it" handling: an upcoming appointment
    // is re-created, on the calendar this run actually targets.
    expect(summary.eventsInserted).toBe(1);
    expect(h.upstreams.calendar.byKeyOn("vacation").size).toBe(1);
    expect(h.upstreams.calendar.byKeyOn("primary").size).toBe(0);
    expect(h.upstreams.calendar.moves).toBe(0);
  });
});
