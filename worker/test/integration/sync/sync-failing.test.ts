// A sync that keeps failing while nothing needs signing in to: the streak, the
// one alert and one card it opens, and how it ends. Real workerd, real D1.
//
// Every upstream is the in-memory one from `helpers.ts`, Trello included: no
// test here can reach a real board, a real health system or a real portal.
// Hosts are `*.example.test` and the names are invented.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../../src/lib/errors.ts";
import {
  FAILING_AFTER_ATTEMPTS,
  FAILING_MIN_SPAN_SECONDS,
  noteSyncFailure,
  noteSyncOk,
  openReconnectAlert,
  resolveReconnectAlert,
  sweepReconnectAlerts,
} from "../../../src/sync/alerts.ts";
import { runCalendarSync } from "../../../src/sync/calendar-sync.ts";
import { failSignIn, portalDeps } from "../../../src/sync/portal-signin.ts";
import { fakePortal, portalVisit, seedPortalAccount } from "../portal/helpers.ts";

import {
  clock,
  encounter,
  fhirServer,
  recordingLog,
  referencePool,
  resetSyncDb,
  searchBundle,
  seedConnectedHealthSystem,
  seedGoogle,
  seedSettings,
  stubUpstreams,
  syncCtx,
  syncRepos,
} from "./helpers.ts";

import type { FhirServer, SeededHealthSystem, Upstreams } from "./helpers.ts";
import type { Ctx } from "../../../src/db/client.ts";
import type { SyncDeps } from "../../../src/sync/deps.ts";
import type { FakePortal } from "../portal/helpers.ts";
import type { RunSummary } from "@shared/types.ts";

beforeEach(resetSyncDb);

const HOST_A = "fhir.a.example.test";
const HOST_B = "fhir.b.example.test";
const NAME_A = "A Example Health";
/** Two weeks after the fixed clock: inside the window and still upcoming. */
const UPCOMING = "2026-06-29T15:30:00Z";
const HOUR = 3600;

interface Harness {
  ctx: Ctx;
  time: ReturnType<typeof clock>;
  a: SeededHealthSystem;
  b: SeededHealthSystem;
  serverA: FhirServer;
  serverB: FhirServer;
  upstreams: Upstreams;
  portal: FakePortal;
  deps: SyncDeps;
  lines: string[];
}

/**
Two connected health systems, Google and Trello. A's access token is inside
the refresh skew, so every run of A starts at its token endpoint.
*/
async function setup(): Promise<Harness> {
  const time = clock();
  const { log, lines } = recordingLog();
  const ctx = syncCtx({ now: time.now, log, trello: true });
  const a = await seedConnectedHealthSystem(ctx, {
    host: HOST_A,
    displayName: NAME_A,
    accessTtlSeconds: 60,
  });
  const b = await seedConnectedHealthSystem(ctx, { host: HOST_B, displayName: "B Example Health" });
  await seedGoogle(ctx);
  await seedSettings(ctx);

  const serverA = fhirServer({ resources: referencePool() });
  const serverB = fhirServer({ resources: referencePool() });
  serverA.encounters = searchBundle([encounter({ id: "enc-a", start: UPCOMING })]);
  serverB.encounters = searchBundle([encounter({ id: "enc-b", start: UPCOMING })]);
  const upstreams = stubUpstreams({ [HOST_A]: serverA, [HOST_B]: serverB });
  const portal = fakePortal();
  return {
    ctx,
    time,
    a,
    b,
    serverA,
    serverB,
    upstreams,
    portal,
    deps: { ...upstreams.deps, portalAdapter: portal.adapter },
    lines,
  };
}

function sync(h: Harness): Promise<RunSummary> {
  return runCalendarSync(h.ctx, { deps: h.deps });
}

/** `runs` scheduled runs an hour apart; the clock is left at the last one. */
async function hourly(h: Harness, runs: number): Promise<RunSummary> {
  let summary = await sync(h);
  for (let index = 1; index < runs; index++) {
    h.time.advance(HOUR);
    summary = await sync(h);
  }
  return summary;
}

function subjectA(h: Harness): string {
  return `health_system:${h.a.healthSystemId}`;
}

function completedCards(h: Harness): number {
  return h.upstreams.trelloCalls.filter((call) => call.method === "PUT").length;
}

async function failThrice(h: Harness, code = "upstream_error"): Promise<void> {
  for (let index = 0; index < 3; index++) {
    if (index > 0) h.time.advance(HOUR);
    await noteSyncFailure(h.ctx, { healthSystemId: h.a.healthSystemId }, "calendar", code, h.deps);
  }
}

async function withPortal(overrides: Partial<FakePortal> = {}): Promise<Harness> {
  const h = await setup();
  await seedPortalAccount(h.ctx, h.a.healthSystemId);
  Object.assign(h.portal, { visits: [portalVisit({ csn: "csn-1" })], ...overrides });
  return h;
}

function portalSubjectOf(h: Harness): string {
  return `portal:${h.a.healthSystemId}`;
}

/** A config column nothing can open: listing what to sync throws. */
async function breakConfig(h: Harness): Promise<string> {
  const row = await env.DB.prepare("SELECT config_enc FROM health_systems WHERE id = ?")
    .bind(h.a.healthSystemId)
    .first<{ config_enc: string }>();
  await env.DB.prepare("UPDATE health_systems SET config_enc = ? WHERE id = ?")
    .bind("not a sealed value", h.a.healthSystemId)
    .run();
  return row?.config_enc ?? "";
}

describe("the threshold", () => {
  it("is three attempts, over at least an hour and a half", () => {
    // What the owner was told, and what the cards say: pinned so that changing
    // either is a decision and not a slip.
    expect(FAILING_AFTER_ATTEMPTS).toBe(3);
    expect(FAILING_MIN_SPAN_SECONDS).toBe(90 * 60);
  });
});

describe("a token endpoint that keeps failing", () => {
  it("says nothing for two runs, then opens one alert and one card on the third", async () => {
    const h = await setup();
    h.serverA.tokenStatus = 500;

    await hourly(h, 2);

    const repos = syncRepos(h.ctx);
    await expect(repos.alerts.listOpen()).resolves.toStrictEqual([]);
    expect(h.upstreams.trelloCards).toStrictEqual([]);
    await expect(repos.syncFailures.listForSubject(subjectA(h))).resolves.toMatchObject([
      { check_name: "calendar", failures: 2, last_error_code: "upstream_unavailable" },
    ]);

    h.time.advance(HOUR);
    const summary = await sync(h);

    const open = await repos.alerts.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: "sync_failing",
      subject: subjectA(h),
      reason_code: "upstream_unavailable",
      trello_card_id: "card-1",
    });
    expect(h.upstreams.trelloCards).toHaveLength(1);
    const card = h.upstreams.trelloCards[0];
    expect(card?.name).toBe(`Healthy cannot sync ${NAME_A}`);
    expect(card?.desc).toContain("The appointment sync");
    expect(card?.desc).toContain("3 runs in a row");
    expect(card?.desc).toContain("(upstream_unavailable)");
    expect(card?.desc).toContain("https://healthy.example.test/health-systems");
    // The grant is fine: the card must not send the owner to a consent screen.
    expect(card?.desc).toContain("Nothing needs reconnecting");
    expect(card?.desc).not.toContain("/oauth/");
    // The connection is not parked, and the other health system never noticed.
    await expect(repos.connections.get(h.a.connectionId)).resolves.toMatchObject({
      status: "error",
    });
    expect(summary.errors).toStrictEqual([
      { healthSystemId: h.a.healthSystemId, code: "upstream_unavailable" },
    ]);
    await expect(
      repos.syncFailures.listForSubject(`health_system:${h.b.healthSystemId}`),
    ).resolves.toStrictEqual([]);
  });

  it("opens no second card however long it goes on", async () => {
    const h = await setup();
    h.serverA.tokenStatus = 500;

    await hourly(h, 8);

    const repos = syncRepos(h.ctx);
    expect(h.upstreams.trelloCards).toHaveLength(1);
    await expect(repos.alerts.listOpen()).resolves.toHaveLength(1);
    await expect(repos.alerts.listRecent()).resolves.toHaveLength(1);
    await expect(repos.syncFailures.listForSubject(subjectA(h))).resolves.toMatchObject([
      { failures: 8 },
    ]);
  });

  it("closes the alert and completes the card on the next run that works", async () => {
    const h = await setup();
    h.serverA.tokenStatus = 500;
    await hourly(h, 3);
    expect(completedCards(h)).toBe(0);

    h.serverA.tokenStatus = null;
    h.time.advance(HOUR);
    const summary = await sync(h);

    expect(summary.errors).toStrictEqual([]);
    const repos = syncRepos(h.ctx);
    await expect(repos.alerts.listOpen()).resolves.toStrictEqual([]);
    await expect(repos.syncFailures.listForSubject(subjectA(h))).resolves.toStrictEqual([]);
    expect(completedCards(h)).toBe(1);
    const [closed] = await repos.alerts.listRecent();
    expect(closed?.resolved_at).toBe(h.time.now());
  });

  it("starts the count again after one good run", async () => {
    const h = await setup();
    h.serverA.tokenStatus = 500;
    await hourly(h, 2);
    h.serverA.tokenStatus = null;
    h.time.advance(HOUR);
    await sync(h);

    h.serverA.tokenStatus = 500;
    h.time.advance(HOUR);
    await hourly(h, 2);

    await expect(syncRepos(h.ctx).alerts.listOpen()).resolves.toStrictEqual([]);
    expect(h.upstreams.trelloCards).toStrictEqual([]);
  });

  it("does not count three failures in one bad quarter of an hour as persistence", async () => {
    const h = await setup();
    h.serverA.tokenStatus = 500;

    await sync(h);
    h.time.advance(300);
    await sync(h);
    h.time.advance(300);
    await sync(h);

    const repos = syncRepos(h.ctx);
    await expect(repos.syncFailures.listForSubject(subjectA(h))).resolves.toMatchObject([
      { failures: 3 },
    ]);
    await expect(repos.alerts.listOpen()).resolves.toStrictEqual([]);

    // Still failing once the span has passed: now it is.
    h.time.advance(FAILING_MIN_SPAN_SECONDS);
    await sync(h);
    await expect(repos.alerts.listOpen()).resolves.toHaveLength(1);
  });

  it("logs the subject and the code, never the health system's name", async () => {
    const h = await setup();
    h.serverA.tokenStatus = 500;

    await hourly(h, 3);

    const logged = h.lines.join("\n");
    expect(logged).toContain("alert.sync_failure");
    expect(logged).toContain("alert.opened");
    expect(logged).not.toContain(NAME_A);
    expect(logged).not.toContain("Healthy cannot sync");
  });
});

describe("a health system that fails after a good token", () => {
  it("alerts when its appointment search keeps failing upstream", async () => {
    const h = await setup();
    h.serverA.encounterStatus = 500;

    const summary = await hourly(h, 3);

    const code = summary.errors[0]?.code;
    expect(summary.errors).toStrictEqual([{ healthSystemId: h.a.healthSystemId, code }]);
    const open = await syncRepos(h.ctx).alerts.listOpen();
    expect(open).toMatchObject([{ kind: "sync_failing", subject: subjectA(h), reason_code: code }]);
    expect(h.upstreams.trelloCards).toHaveLength(1);
    expect(h.upstreams.trelloCards[0]?.desc).toContain(`(${String(code)})`);

    h.serverA.encounterStatus = null;
    h.time.advance(HOUR);
    await sync(h);
    await expect(syncRepos(h.ctx).alerts.listOpen()).resolves.toStrictEqual([]);
    expect(completedCards(h)).toBe(1);
  });

  it("opens the reconnect card, and no failing one, when the grant itself is rejected", async () => {
    const h = await setup();
    h.serverA.tokenInvalidGrant = true;

    await hourly(h, 4);

    const repos = syncRepos(h.ctx);
    const open = await repos.alerts.listOpen();
    expect(open).toMatchObject([{ kind: "reconnect", subject: subjectA(h) }]);
    expect(h.upstreams.trelloCards).toHaveLength(1);
    expect(h.upstreams.trelloCards[0]?.name).toBe(`Reconnect ${NAME_A} to Healthy`);
    // `needs_reauth` is never a streak: the reconnect card is the whole answer.
    await expect(repos.syncFailures.listForSubject(subjectA(h))).resolves.toStrictEqual([]);
  });
});

describe("Trello failing", () => {
  it("costs the run nothing, keeps the alert row, and cards it on the next report", async () => {
    const h = await setup();
    h.serverA.tokenStatus = 500;
    h.upstreams.failTrello(401);

    const summary = await hourly(h, 3);

    // The run is exactly what it would have been: A's own failure, B synced.
    expect(summary.errors).toStrictEqual([
      { healthSystemId: h.a.healthSystemId, code: "upstream_unavailable" },
    ]);
    expect(h.upstreams.calendar.events()).toHaveLength(1);
    const repos = syncRepos(h.ctx);
    const open = await repos.alerts.listOpen();
    expect(open).toMatchObject([{ kind: "sync_failing", trello_card_id: null }]);
    expect(h.upstreams.trelloCards).toStrictEqual([]);
    expect(h.lines.join("\n")).toContain("alert.open_failed");

    h.upstreams.failTrello(null);
    h.time.advance(HOUR);
    await sync(h);

    expect(h.upstreams.trelloCards).toHaveLength(1);
    await expect(repos.alerts.listOpen()).resolves.toMatchObject([
      { id: open[0]?.id, trello_card_id: "card-1" },
    ]);
  });

  it("does not keep an alert open when the card cannot be completed", async () => {
    const h = await setup();
    h.serverA.tokenStatus = 500;
    await hourly(h, 3);

    h.serverA.tokenStatus = null;
    h.upstreams.failTrello(401);
    h.time.advance(HOUR);
    const summary = await sync(h);

    expect(summary.errors).toStrictEqual([]);
    await expect(syncRepos(h.ctx).alerts.listOpen()).resolves.toStrictEqual([]);
  });
});

describe("one open alert per subject", () => {
  it("does not stack a failing sync on an open reconnect card", async () => {
    const h = await setup();
    await openReconnectAlert(h.ctx, { healthSystemId: h.a.healthSystemId }, "needs_reauth", h.deps);

    await failThrice(h);

    const repos = syncRepos(h.ctx);
    await expect(repos.alerts.listRecent()).resolves.toMatchObject([{ kind: "reconnect" }]);
    expect(h.upstreams.trelloCards).toHaveLength(1);
    expect(h.upstreams.trelloCards[0]?.name).toBe(`Reconnect ${NAME_A} to Healthy`);
  });

  it("replaces a failing-sync card with the reconnect card when the grant dies", async () => {
    const h = await setup();
    await failThrice(h);
    expect(h.upstreams.trelloCards).toHaveLength(1);

    await openReconnectAlert(h.ctx, { healthSystemId: h.a.healthSystemId }, "needs_reauth", h.deps);

    const repos = syncRepos(h.ctx);
    await expect(repos.alerts.listOpen()).resolves.toMatchObject([
      { kind: "reconnect", reason_code: "needs_reauth", trello_card_id: "card-2" },
    ]);
    // The card that said nothing needed reconnecting is done, not left beside it.
    expect(completedCards(h)).toBe(1);
    expect(h.upstreams.trelloCards.map((card) => card.name)).toStrictEqual([
      `Healthy cannot sync ${NAME_A}`,
      `Reconnect ${NAME_A} to Healthy`,
    ]);
  });

  it("is not closed by a token that refreshes: only by the pass that was failing", async () => {
    const h = await setup();
    await failThrice(h);

    await resolveReconnectAlert(h.ctx, { healthSystemId: h.a.healthSystemId }, h.deps);
    await noteSyncOk(h.ctx, { healthSystemId: h.a.healthSystemId }, "refresh", h.deps);

    const repos = syncRepos(h.ctx);
    await expect(repos.alerts.listOpen()).resolves.toMatchObject([{ kind: "sync_failing" }]);

    await noteSyncOk(h.ctx, { healthSystemId: h.a.healthSystemId }, "calendar", h.deps);
    await expect(repos.alerts.listOpen()).resolves.toStrictEqual([]);
  });

  it("stays open while another pass of the same subject is still failing", async () => {
    const h = await setup();
    const subject = { healthSystemId: h.a.healthSystemId };
    for (let index = 0; index < 3; index++) {
      if (index > 0) h.time.advance(HOUR);
      await noteSyncFailure(h.ctx, subject, "calendar", "upstream_error", h.deps);
      await noteSyncFailure(h.ctx, subject, "refresh", "upstream_auth", h.deps);
    }
    expect(h.upstreams.trelloCards).toHaveLength(1);

    await noteSyncOk(h.ctx, subject, "calendar", h.deps);
    const repos = syncRepos(h.ctx);
    await expect(repos.alerts.listOpen()).resolves.toHaveLength(1);

    await noteSyncOk(h.ctx, subject, "refresh", h.deps);
    await expect(repos.alerts.listOpen()).resolves.toStrictEqual([]);
  });

  it("never counts needs_reauth or not_connected", async () => {
    const h = await setup();

    await failThrice(h, "needs_reauth");
    await failThrice(h, "not_connected");

    const repos = syncRepos(h.ctx);
    await expect(repos.syncFailures.listForSubject(subjectA(h))).resolves.toStrictEqual([]);
    await expect(repos.alerts.listOpen()).resolves.toStrictEqual([]);
  });
});

describe("Google Calendar", () => {
  it("is what a refused write counts against, once a run, and not the health systems", async () => {
    const h = await setup();
    h.upstreams.calendar.writeStatus = 403;

    const summary = await hourly(h, 3);

    // Both passes threw at their first insert, and the run says so.
    expect(summary.errors.map((error) => error.code)).toStrictEqual([
      "upstream_auth",
      "upstream_auth",
    ]);
    const repos = syncRepos(h.ctx);
    await expect(repos.syncFailures.listForSubject("google")).resolves.toMatchObject([
      { check_name: "calendar", failures: 3, last_error_code: "upstream_auth" },
    ]);
    await expect(repos.syncFailures.listForSubject(subjectA(h))).resolves.toStrictEqual([]);
    await expect(
      repos.syncFailures.listForSubject(`health_system:${h.b.healthSystemId}`),
    ).resolves.toStrictEqual([]);

    await expect(repos.alerts.listOpen()).resolves.toMatchObject([
      { kind: "sync_failing", subject: "google", reason_code: "upstream_auth" },
    ]);
    expect(h.upstreams.trelloCards).toHaveLength(1);
    const card = h.upstreams.trelloCards[0];
    expect(card?.name).toBe("Healthy cannot sync Google Calendar");
    expect(card?.desc).toContain("Reading or writing the calendar");
    expect(card?.desc).toContain("https://healthy.example.test/calendar");
    expect(card?.desc).not.toContain("/oauth/google/start");
  });

  it("recovers when the writes go through again", async () => {
    const h = await setup();
    h.upstreams.calendar.writeStatus = 403;
    await hourly(h, 3);

    h.upstreams.calendar.writeStatus = null;
    h.time.advance(HOUR);
    const summary = await sync(h);

    expect(summary.errors).toStrictEqual([]);
    expect(summary.eventsInserted).toBe(2);
    await expect(syncRepos(h.ctx).alerts.listOpen()).resolves.toStrictEqual([]);
    expect(completedCards(h)).toBe(1);
  });

  it("alerts when the listing itself keeps failing", async () => {
    const h = await setup();
    h.upstreams.calendar.listStatus = 403;

    const summary = await hourly(h, 3);

    expect(summary.errors).toStrictEqual([{ healthSystemId: "google", code: "upstream_auth" }]);
    await expect(syncRepos(h.ctx).alerts.listOpen()).resolves.toMatchObject([
      { kind: "sync_failing", subject: "google" },
    ]);
    expect(h.upstreams.trelloCards).toHaveLength(1);
  });

  it("raises nothing for a calendar that was never connected", async () => {
    const h = await setup();
    await syncRepos(h.ctx).google.disconnect();

    await hourly(h, 4);

    const repos = syncRepos(h.ctx);
    await expect(repos.alerts.listOpen()).resolves.toStrictEqual([]);
    await expect(repos.syncFailures.listForSubject("google")).resolves.toStrictEqual([]);
  });
});

describe("a patient portal", () => {
  it("alerts when its visit list keeps failing, and says what the owner can do", async () => {
    const h = await withPortal({
      loadError: new AppError("portal_parse_failed", "the page changed"),
    });

    const summary = await hourly(h, 3);

    expect(summary.portalErrors).toStrictEqual(["portal_parse_failed"]);
    const repos = syncRepos(h.ctx);
    await expect(repos.alerts.listOpen()).resolves.toMatchObject([
      { kind: "sync_failing", subject: portalSubjectOf(h), reason_code: "portal_parse_failed" },
    ]);
    // The FHIR connection of the same health system is a different subject, and fine.
    await expect(repos.syncFailures.listForSubject(subjectA(h))).resolves.toStrictEqual([]);
    expect(h.upstreams.trelloCards).toHaveLength(1);
    const card = h.upstreams.trelloCards[0];
    expect(card?.name).toBe(`Healthy cannot sync ${NAME_A} patient portal`);
    expect(card?.desc).toContain("The sync of portal visits");
    expect(card?.desc).toContain("(portal_parse_failed)");
    expect(card?.desc).toContain('press "Sign in now"');
    // The account was not parked: the scheduled sync is still trying.
    await expect(repos.portalAccounts.get(h.a.healthSystemId)).resolves.toMatchObject({
      session_state: "active",
    });

    h.portal.loadError = null;
    h.time.advance(HOUR);
    await sync(h);
    await expect(repos.alerts.listOpen()).resolves.toStrictEqual([]);
    expect(completedCards(h)).toBe(1);
  });

  it("counts a message read that keeps failing on its own, apart from the visits", async () => {
    const h = await withPortal({
      messagesError: new AppError("portal_unreachable", "the message centre is down"),
    });

    const summary = await hourly(h, 3);

    // The visits were read and calendared every time.
    expect(summary.portalErrors).toStrictEqual([]);
    const repos = syncRepos(h.ctx);
    await expect(repos.syncFailures.listForSubject(portalSubjectOf(h))).resolves.toMatchObject([
      { check_name: "messages", failures: 3, last_error_code: "portal_unreachable" },
    ]);
    await expect(repos.alerts.listOpen()).resolves.toMatchObject([
      { kind: "sync_failing", subject: portalSubjectOf(h), reason_code: "portal_unreachable" },
    ]);
    expect(h.upstreams.trelloCards).toHaveLength(1);
    expect(h.upstreams.trelloCards[0]?.desc).toContain("Reading portal messages");

    h.portal.messagesError = null;
    h.time.advance(HOUR);
    await sync(h);
    await expect(repos.alerts.listOpen()).resolves.toStrictEqual([]);
  });

  it("is not blamed for a calendar that refuses its events", async () => {
    const h = await withPortal();
    h.upstreams.calendar.writeStatus = 403;

    await hourly(h, 3);

    const repos = syncRepos(h.ctx);
    await expect(repos.syncFailures.listForSubject(portalSubjectOf(h))).resolves.toStrictEqual([]);
    await expect(repos.alerts.listOpen()).resolves.toMatchObject([{ subject: "google" }]);
  });

  it("gets its card from the sweep when a first missed code opened none", async () => {
    const h = await withPortal();
    await failSignIn(h.ctx, h.a.healthSystemId, "portal_2fa_required", portalDeps(h.deps));
    expect(h.upstreams.trelloCards).toStrictEqual([]);

    await sweepReconnectAlerts(h.ctx, h.deps);
    await sweepReconnectAlerts(h.ctx, h.deps);

    expect(h.upstreams.trelloCards).toHaveLength(1);
    expect(h.upstreams.trelloCards[0]?.name).toBe(
      `Sign in to ${NAME_A} patient portal again in Healthy`,
    );
    await expect(syncRepos(h.ctx).alerts.listOpen()).resolves.toMatchObject([
      { kind: "reconnect", subject: portalSubjectOf(h), reason_code: "portal_2fa_required" },
    ]);
  });
});

describe("a run that stops before reaching anything", () => {
  it("alerts about the sync itself, and closes when a run finishes", async () => {
    const h = await setup();
    const original = await breakConfig(h);

    const summary = await hourly(h, 3);

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.healthSystemId).toBe("");
    const repos = syncRepos(h.ctx);
    await expect(repos.alerts.listOpen()).resolves.toMatchObject([
      { kind: "sync_failing", subject: "sync", reason_code: summary.errors[0]?.code },
    ]);
    expect(h.upstreams.trelloCards).toHaveLength(1);
    const card = h.upstreams.trelloCards[0];
    expect(card?.name).toBe("Healthy's sync keeps stopping");
    expect(card?.desc).toContain("has stopped before reaching any health system");
    expect(card?.desc).not.toContain(NAME_A);

    await env.DB.prepare("UPDATE health_systems SET config_enc = ? WHERE id = ?")
      .bind(original, h.a.healthSystemId)
      .run();
    h.time.advance(HOUR);
    await sync(h);
    await expect(repos.alerts.listOpen()).resolves.toStrictEqual([]);
    expect(completedCards(h)).toBe(1);
  });
});

describe("the sweep", () => {
  it("closes a failing-sync alert for a health system that is no longer synced", async () => {
    const h = await setup();
    h.serverA.tokenStatus = 500;
    await hourly(h, 3);
    const repos = syncRepos(h.ctx);
    await expect(repos.alerts.listOpen()).resolves.toHaveLength(1);

    await repos.connections.disconnect(h.a.connectionId);
    await sweepReconnectAlerts(h.ctx, h.deps);

    await expect(repos.alerts.listOpen()).resolves.toStrictEqual([]);
    await expect(repos.syncFailures.listForSubject(subjectA(h))).resolves.toStrictEqual([]);
    expect(completedCards(h)).toBe(1);
  });

  it("leaves a failing-sync alert alone while the health system is still synced", async () => {
    const h = await setup();
    h.serverA.tokenStatus = 500;
    await hourly(h, 3);

    await sweepReconnectAlerts(h.ctx, h.deps);

    await expect(syncRepos(h.ctx).alerts.listOpen()).resolves.toMatchObject([
      { kind: "sync_failing", subject: subjectA(h) },
    ]);
    expect(h.upstreams.trelloCards).toHaveLength(1);
  });

  it("never throws, whatever the database holds", async () => {
    const h = await setup();
    await env.DB.prepare("UPDATE health_systems SET config_enc = ?")
      .bind("not a sealed value")
      .run();

    await expect(sweepReconnectAlerts(h.ctx, h.deps)).resolves.toBeUndefined();
  });
});
