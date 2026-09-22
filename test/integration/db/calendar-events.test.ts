import { beforeEach, describe, expect, it } from "vitest";

import { T0, clock, column, resetDb, seedProvider, testRepos } from "./helpers.ts";

import type { Repos } from "../../../worker/db/index.ts";

beforeEach(resetDb);

const START = 1_769_960_000;

async function seedEvent(
  repos: Repos,
  providerId: string,
  overrides: {
    encounterId?: string;
    fingerprint?: string;
    startAt?: number;
    restore?: boolean;
  } = {},
) {
  const encounterId = overrides.encounterId ?? "enc-1";
  return repos.calendarEvents.upsert({
    eventKey: `${providerId}:${encounterId}`,
    providerId,
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
    const providerId = await seedProvider(repos);

    const row = await seedEvent(repos, providerId);

    expect(row.state).toBe("active");
    expect(row.ghosted_at).toBeNull();
    expect(row.first_seen_at).toBe(T0);
    expect(row.last_seen_at).toBe(T0);
    expect(await repos.calendarEvents.getByKey(row.event_key)).toStrictEqual(row);
  });

  it("keeps first_seen_at and updates the rest on a second pass", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    await seedEvent(repos, providerId);

    time.advance(3600);
    const updated = await seedEvent(repos, providerId, { fingerprint: "fingerprint-b" });

    expect(updated.first_seen_at).toBe(T0);
    expect(updated.last_seen_at).toBe(T0 + 3600);
    expect(updated.fingerprint).toBe("fingerprint-b");
  });

  it("refuses two keys pointing at the same Google event", async () => {
    // The unique index on (calendar_id, google_event_id) is what stops two
    // encounters silently sharing one calendar entry.
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await seedEvent(repos, providerId, { encounterId: "enc-1" });

    await expect(
      repos.calendarEvents.upsert({
        eventKey: `${providerId}:enc-2`,
        providerId,
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
    const providerId = await seedProvider(repos);
    const row = await seedEvent(repos, providerId);

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
    const providerId = await seedProvider(repos);
    const row = await seedEvent(repos, providerId);

    await repos.calendarEvents.markGhost(row.event_key);
    time.advance(86_400);

    expect(await repos.calendarEvents.markGhost(row.event_key)).toBe(false);
    await expect(repos.calendarEvents.getByKey(row.event_key)).resolves.toMatchObject({
      ghosted_at: T0,
    });
  });

  it("restores a ghost and can update its fingerprint at the same time", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const row = await seedEvent(repos, providerId);
    await repos.calendarEvents.markGhost(row.event_key);

    expect(await repos.calendarEvents.restore(row.event_key, "fingerprint-c")).toBe(true);

    const restored = await repos.calendarEvents.getByKey(row.event_key);

    expect(restored?.state).toBe("active");
    expect(restored?.ghosted_at).toBeNull();
    expect(restored?.fingerprint).toBe("fingerprint-c");
  });

  it("keeps the fingerprint when restore is not given one", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const row = await seedEvent(repos, providerId);
    await repos.calendarEvents.markGhost(row.event_key);

    await repos.calendarEvents.restore(row.event_key);

    await expect(repos.calendarEvents.getByKey(row.event_key)).resolves.toMatchObject({
      fingerprint: "fingerprint-a",
    });
  });

  it("does not restore an event that was never ghosted", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const row = await seedEvent(repos, providerId);

    expect(await repos.calendarEvents.restore(row.event_key)).toBe(false);
  });

  it("un-ghosts through a restoring upsert, because reappearing upstream is the signal", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const row = await seedEvent(repos, providerId);
    await repos.calendarEvents.markGhost(row.event_key);

    const back = await seedEvent(repos, providerId, { restore: true });

    expect(back.state).toBe("active");
    expect(back.ghosted_at).toBeNull();
  });

  it("leaves a ghost ghosted through a plain upsert", async () => {
    // The ghost write patches the calendar entry and then records its fingerprint.
    // If that upsert un-ghosted the row, the next run would stamp a fresh
    // `ghosted_at`, re-render the "as of" line, and patch the event again for ever.
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    const row = await seedEvent(repos, providerId);
    await repos.calendarEvents.markGhost(row.event_key);

    time.advance(3600);
    const again = await seedEvent(repos, providerId, { fingerprint: "fingerprint-ghost" });

    expect(again.state).toBe("ghost");
    expect(again.ghosted_at).toBe(T0);
    expect(again.fingerprint).toBe("fingerprint-ghost");
  });

  it("moves the fingerprint of a row that is already a ghost, and only then", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    const row = await seedEvent(repos, providerId);

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
});

describe("calendar_events.list and touch", () => {
  it("filters by provider, state and start, ordered by start", async () => {
    const repos = testRepos();
    const first = await seedProvider(repos, { displayName: "A Example Health" });
    const second = await seedProvider(repos, { displayName: "B Example Health" });

    await seedEvent(repos, first, { encounterId: "late", startAt: START + 7200 });
    await seedEvent(repos, first, { encounterId: "early", startAt: START });
    const ghosted = await seedEvent(repos, first, { encounterId: "gone", startAt: START + 3600 });
    await repos.calendarEvents.markGhost(ghosted.event_key);
    await seedEvent(repos, second, { encounterId: "other", startAt: START });

    expect(
      await column(repos.calendarEvents.list({ providerId: first }), "encounter_id"),
    ).toStrictEqual(["early", "gone", "late"]);
    expect(
      await column(
        repos.calendarEvents.list({ providerId: first, state: "active" }),
        "encounter_id",
      ),
    ).toStrictEqual(["early", "late"]);
    expect(
      await column(repos.calendarEvents.list({ startsAfter: START + 3600 }), "encounter_id"),
    ).toStrictEqual(["gone", "late"]);
    expect(await repos.calendarEvents.list({ limit: 1 })).toHaveLength(1);
  });

  it("sorts rows with no start time last rather than first", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    await repos.calendarEvents.upsert({
      eventKey: `${providerId}:undated`,
      providerId,
      encounterId: "undated",
      calendarId: "primary",
      googleEventId: "google-undated",
      fingerprint: "f",
    });
    await seedEvent(repos, providerId, { encounterId: "dated" });

    expect(await column(repos.calendarEvents.list(), "encounter_id")).toStrictEqual([
      "dated",
      "undated",
    ]);
  });

  it("touches many keys at once and ignores the ones it does not have", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    const a = await seedEvent(repos, providerId, { encounterId: "a" });
    const b = await seedEvent(repos, providerId, { encounterId: "b" });

    time.advance(600);

    expect(await repos.calendarEvents.touch([a.event_key, b.event_key, "nope:nope"])).toBe(2);
    await expect(repos.calendarEvents.getByKey(a.event_key)).resolves.toMatchObject({
      last_seen_at: T0 + 600,
    });
    expect(await repos.calendarEvents.touch([])).toBe(0);
  });
});
