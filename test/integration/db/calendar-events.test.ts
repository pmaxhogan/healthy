import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { blindCalendarId, blindCsn, blindResourceId } from "../../../worker/db/blind.ts";

import {
  T0,
  blindKey,
  clock,
  column,
  rawColumn,
  recordingLog,
  resetDb,
  seedHealthSystem,
  testBlinder,
  testRepos,
} from "./helpers.ts";

import type { Repos } from "../../../worker/db/index.ts";

beforeEach(resetDb);

const START = 1_769_960_000;

async function seedEvent(
  repos: Repos,
  healthSystemId: string,
  overrides: {
    encounterId?: string;
    fingerprint?: string;
    startAt?: number;
    restore?: boolean;
  } = {},
) {
  const encounterId = overrides.encounterId ?? "enc-1";
  return repos.calendarEvents.upsert({
    eventKey: await blindKey(`${healthSystemId}:${encounterId}`),
    healthSystemId,
    encounterId,
    calendarId: "primary",
    googleEventId: `google-${encounterId}`,
    fingerprint: overrides.fingerprint ?? "fingerprint-a",
    startAt: overrides.startAt ?? START,
    ...(overrides.restore !== undefined && { restore: overrides.restore }),
  });
}

describe("calendar_events.upsert", () => {
  it("inserts an active row and stamps both clocks", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);

    const row = await seedEvent(repos, healthSystemId);

    expect(row.state).toBe("active");
    expect(row.ghosted_at).toBeNull();
    expect(row.first_seen_at).toBe(T0);
    expect(row.last_seen_at).toBe(T0);
    expect(await repos.calendarEvents.getByKey(row.event_key)).toStrictEqual(row);
  });

  it("keeps first_seen_at and updates the rest on a second pass", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    await seedEvent(repos, healthSystemId);

    time.advance(3600);
    const updated = await seedEvent(repos, healthSystemId, { fingerprint: "fingerprint-b" });

    expect(updated.first_seen_at).toBe(T0);
    expect(updated.last_seen_at).toBe(T0 + 3600);
    expect(updated.fingerprint).toBe("fingerprint-b");
  });

  it("refuses two keys pointing at the same Google event", async () => {
    // The unique index on (calendar_id, google_event_id) is what stops two
    // encounters silently sharing one calendar entry.
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    await seedEvent(repos, healthSystemId, { encounterId: "enc-1" });

    await expect(
      repos.calendarEvents.upsert({
        eventKey: await blindKey(`${healthSystemId}:enc-2`),
        healthSystemId,
        encounterId: "enc-2",
        calendarId: "primary",
        googleEventId: "google-enc-1",
        fingerprint: "fingerprint-a",
      }),
    ).rejects.toThrow();
  });
});

describe("ghosting and restoring", () => {
  it("ghosts an event, keeping the row and stamping when it vanished", async () => {
    // Ghosts are never deleted: a cancelled appointment stays in the owner's
    // history, greyed out, with the time it disappeared.
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    const row = await seedEvent(repos, healthSystemId);

    time.advance(7200);

    expect(await repos.calendarEvents.markGhost(row.event_key)).toBe(true);

    const ghost = await repos.calendarEvents.getByKey(row.event_key);

    expect(ghost?.state).toBe("ghost");
    expect(ghost?.ghosted_at).toBe(T0 + 7200);
    expect(ghost?.google_event_id).toBe(row.google_event_id);
  });

  it("is idempotent and keeps the original ghosted_at", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    const row = await seedEvent(repos, healthSystemId);

    await repos.calendarEvents.markGhost(row.event_key);
    time.advance(86_400);

    expect(await repos.calendarEvents.markGhost(row.event_key)).toBe(false);
    await expect(repos.calendarEvents.getByKey(row.event_key)).resolves.toMatchObject({
      ghosted_at: T0,
    });
  });

  it("restores a ghost and can update its fingerprint at the same time", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    const row = await seedEvent(repos, healthSystemId);
    await repos.calendarEvents.markGhost(row.event_key);

    expect(await repos.calendarEvents.restore(row.event_key, "fingerprint-c")).toBe(true);

    const restored = await repos.calendarEvents.getByKey(row.event_key);

    expect(restored?.state).toBe("active");
    expect(restored?.ghosted_at).toBeNull();
    expect(restored?.fingerprint).toBe("fingerprint-c");
  });

  it("keeps the fingerprint when restore is not given one", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    const row = await seedEvent(repos, healthSystemId);
    await repos.calendarEvents.markGhost(row.event_key);

    await repos.calendarEvents.restore(row.event_key);

    await expect(repos.calendarEvents.getByKey(row.event_key)).resolves.toMatchObject({
      fingerprint: "fingerprint-a",
    });
  });

  it("does not restore an event that was never ghosted", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    const row = await seedEvent(repos, healthSystemId);

    expect(await repos.calendarEvents.restore(row.event_key)).toBe(false);
  });

  it("un-ghosts through a restoring upsert, because reappearing upstream is the signal", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    const row = await seedEvent(repos, healthSystemId);
    await repos.calendarEvents.markGhost(row.event_key);

    const back = await seedEvent(repos, healthSystemId, { restore: true });

    expect(back.state).toBe("active");
    expect(back.ghosted_at).toBeNull();
  });

  it("leaves a ghost ghosted through a plain upsert", async () => {
    // The ghost write patches the calendar entry and then records its fingerprint.
    // If that upsert un-ghosted the row, the next run would stamp a fresh
    // `ghosted_at`, re-render the "as of" line, and patch the event again for ever.
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    const row = await seedEvent(repos, healthSystemId);
    await repos.calendarEvents.markGhost(row.event_key);

    time.advance(3600);
    const again = await seedEvent(repos, healthSystemId, { fingerprint: "fingerprint-ghost" });

    expect(again.state).toBe("ghost");
    expect(again.ghosted_at).toBe(T0);
    expect(again.fingerprint).toBe("fingerprint-ghost");
  });

  it("moves the fingerprint of a row that is already a ghost, and only then", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    const row = await seedEvent(repos, healthSystemId);

    expect(await repos.calendarEvents.markGhost(row.event_key, { fingerprint: "ghost-1" })).toBe(
      true,
    );
    time.advance(86_400);
    // Already a ghost and nothing new to say: no write, so nothing moves.
    expect(await repos.calendarEvents.markGhost(row.event_key)).toBe(false);
    // Already a ghost but the ghost variant re-rendered: the fingerprint moves and
    // `ghosted_at` does not, which is what lets the next run settle.
    expect(await repos.calendarEvents.markGhost(row.event_key, { fingerprint: "ghost-2" })).toBe(
      true,
    );

    await expect(repos.calendarEvents.getByKey(row.event_key)).resolves.toMatchObject({
      state: "ghost",
      ghosted_at: T0,
      fingerprint: "ghost-2",
    });
  });

  it("reports nothing to do for a key it does not have", async () => {
    const repos = testRepos();

    expect(await repos.calendarEvents.markGhost("nope:nope")).toBe(false);
    expect(await repos.calendarEvents.getByKey("nope:nope")).toBeNull();
  });

  it("logs the health system id and a digest, never the encounter id, when ghosting or restoring", async () => {
    // Regression: `eventKey` is `<healthSystemId>:<encounterId>` -- the encounter half
    // is Epic's own resource id, and the `:` defeats the log redactor's 32-char
    // opaque-string rule (see worker/lib/log.ts's header and SECURITY.md, "No PHI
    // in logs"). `calendar_events.ghosted` and `calendar_events.restored` must
    // carry `healthSystemId` (our own row id) and a short digest instead.
    const { log, lines } = recordingLog();
    const repos = testRepos({ log });
    const healthSystemId = await seedHealthSystem(repos);
    const row = await seedEvent(repos, healthSystemId, { encounterId: "enc-secret" });

    await repos.calendarEvents.markGhost(row.event_key);
    await repos.calendarEvents.restore(row.event_key);

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const ghosted = parsed.filter((line) => line.event === "calendar_events.ghosted");
    const restored = parsed.filter((line) => line.event === "calendar_events.restored");
    expect(ghosted).toHaveLength(1);
    expect(restored).toHaveLength(1);

    for (const line of [...ghosted, ...restored]) {
      expect(line.healthSystemId).toBe(healthSystemId);
      expect(typeof line.eventKeyHash).toBe("string");
      expect(line.eventKey).toBeUndefined();
      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain("enc-secret");
      expect(serialized).not.toContain(`${healthSystemId}:`);
    }
  });
});

describe("calendar_events.list and touch", () => {
  it("filters by health system, state and start, ordered by start", async () => {
    const repos = testRepos();
    const first = await seedHealthSystem(repos, { displayName: "A Example Health" });
    const second = await seedHealthSystem(repos, { displayName: "B Example Health" });

    await seedEvent(repos, first, { encounterId: "late", startAt: START + 7200 });
    await seedEvent(repos, first, { encounterId: "early", startAt: START });
    const ghosted = await seedEvent(repos, first, { encounterId: "gone", startAt: START + 3600 });
    await repos.calendarEvents.markGhost(ghosted.event_key);
    await seedEvent(repos, second, { encounterId: "other", startAt: START });

    expect(
      await column(repos.calendarEvents.list({ healthSystemId: first }), "google_event_id"),
    ).toStrictEqual(["google-early", "google-gone", "google-late"]);
    expect(
      await column(
        repos.calendarEvents.list({ healthSystemId: first, state: "active" }),
        "google_event_id",
      ),
    ).toStrictEqual(["google-early", "google-late"]);
    expect(
      await column(repos.calendarEvents.list({ startsAfter: START + 3600 }), "google_event_id"),
    ).toStrictEqual(["google-gone", "google-late"]);
    expect(await repos.calendarEvents.list({ limit: 1 })).toHaveLength(1);
  });

  it("sorts rows with no start time last rather than first", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);

    await repos.calendarEvents.upsert({
      eventKey: await blindKey(`${healthSystemId}:undated`),
      healthSystemId,
      encounterId: "undated",
      calendarId: "primary",
      googleEventId: "google-undated",
      fingerprint: "f",
    });
    await seedEvent(repos, healthSystemId, { encounterId: "dated" });

    expect(await column(repos.calendarEvents.list(), "google_event_id")).toStrictEqual([
      "google-dated",
      "google-undated",
    ]);
  });

  it("touches many keys at once and ignores the ones it does not have", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    const a = await seedEvent(repos, healthSystemId, { encounterId: "a" });
    const b = await seedEvent(repos, healthSystemId, { encounterId: "b" });

    time.advance(600);

    expect(await repos.calendarEvents.touch([a.event_key, b.event_key, "nope:nope"])).toBe(2);
    await expect(repos.calendarEvents.getByKey(a.event_key)).resolves.toMatchObject({
      last_seen_at: T0 + 600,
    });
    expect(await repos.calendarEvents.touch([])).toBe(0);
  });
});

describe("what calendar_events stores", () => {
  it("blinds the key, the encounter, the calendar and the CSN, and seals the start", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    const blinder = testBlinder();
    const eventKey = await blindKey(`${healthSystemId}:csn:csn-secret`);

    const row = await repos.calendarEvents.upsert({
      eventKey,
      healthSystemId,
      encounterId: "csn:csn-secret",
      calendarId: "owner@example.test",
      googleEventId: "google-1",
      fingerprint: "~fp",
      startAt: START,
      source: "portal",
      portalCsn: "csn-secret",
    });

    // What the sync reads: the real start and calendar, opened.
    expect(row.start_at).toBe(START);
    expect(row.calendar_id).toBe("owner@example.test");
    expect(row.portal_csn).toBe(await blindCsn(blinder, healthSystemId, "csn-secret"));
    expect(row.encounter_id).toBe(await blindCsn(blinder, healthSystemId, "csn-secret"));

    // What a D1 snapshot holds.
    const raw = await env.DB.prepare("SELECT * FROM calendar_events WHERE event_key = ?")
      .bind(eventKey)
      .first();
    const dump = JSON.stringify(raw);
    expect(dump).not.toContain("csn-secret");
    expect(dump).not.toContain("owner@example.test");
    expect(dump).not.toContain(String(START));
    expect(raw).not.toHaveProperty("start_at");
    expect(raw?.calendar_id).toBe(await blindCalendarId(blinder, "owner@example.test"));
    expect(String(raw?.detail_enc).startsWith("v2:")).toBe(true);
  });

  it("stores a FHIR row's encounter as the same blind the cache keys the Encounter by", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);

    const row = await seedEvent(repos, healthSystemId, { encounterId: "enc-9" });

    expect(row.encounter_id).toBe(
      await blindResourceId(testBlinder(), healthSystemId, "Encounter", "enc-9"),
    );
  });

  it("refuses a key that still carries the upstream id", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);

    await expect(
      repos.calendarEvents.upsert({
        eventKey: `${healthSystemId}:enc-1`,
        healthSystemId,
        encounterId: "enc-1",
        calendarId: "primary",
        googleEventId: "google-1",
        fingerprint: "f",
      }),
    ).rejects.toMatchObject({ code: "internal" });
  });

  it("keeps the sealed detail readable across a rekey and re-seals it on a calendar move", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    const row = await seedEvent(repos, healthSystemId, { encounterId: "csn:c-1" });
    const toKey = await blindKey(`${healthSystemId}:enc-7`);

    expect(
      await repos.calendarEvents.rekey(row.event_key, toKey, {
        encounterId: "enc-7",
        source: "fhir",
      }),
    ).toBe(true);
    await expect(repos.calendarEvents.getByKey(toKey)).resolves.toMatchObject({
      start_at: START,
      calendar_id: "primary",
      source: "fhir",
    });

    await repos.calendarEvents.moveCalendar(toKey, "other@example.test");

    await expect(repos.calendarEvents.getByKey(toKey)).resolves.toMatchObject({
      start_at: START,
      calendar_id: "other@example.test",
    });
    expect(await rawColumn("calendar_events", "calendar_id", "event_key = ?", toKey)).toBe(
      await blindCalendarId(testBlinder(), "other@example.test"),
    );
  });

  it("filters by health system and state through the index, not a table walk", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM calendar_events WHERE health_system_id = ? AND state = ?`,
    )
      .bind("p", "active")
      .all<{ detail: string }>();
    const details = plan.results.map((step) => step.detail).join("\n");

    expect(details).toMatch(/USING INDEX calendar_events_health_system/u);
    expect(details).not.toMatch(/^SCAN calendar_events$/mu);
  });

  it("finds a row by its key through the primary key", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM calendar_events WHERE event_key = ?`,
    )
      .bind("k")
      .all<{ detail: string }>();

    expect(plan.results.map((step) => step.detail).join("\n")).toMatch(
      /USING INDEX sqlite_autoindex_calendar_events_1/u,
    );
  });
});
