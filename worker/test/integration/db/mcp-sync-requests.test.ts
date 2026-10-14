// `mcp_sync_requests`: the cooldown an MCP client's sync requests are held to.
//
// Real D1, because the whole guarantee is one SQL statement: the upsert whose
// `WHERE` decides whether a request gets the slot. A fake of it would test the
// fake.

import { beforeEach, describe, expect, it } from "vitest";

import { T0, clock, resetDb, seedHealthSystem, testRepos } from "./helpers.ts";

beforeEach(resetDb);

const LIMITS = { cooldownSeconds: 900, dailyLimit: 3 };

/** T0 is midnight UTC, so a test can count on where the day turns. */
const DAY = 86_400;

describe("mcp_sync_requests.claim", () => {
  it("gives the first request the slot and records who asked", async () => {
    const repos = testRepos();
    const id = await seedHealthSystem(repos);

    expect(await repos.mcpSyncRequests.claim(id, "ordinary", LIMITS, "client-1")).toBe(true);

    expect(await repos.mcpSyncRequests.list("ordinary")).toStrictEqual([
      { healthSystemId: id, kind: "ordinary", requestedAt: T0, day: T0 / DAY, dayCount: 1 },
    ]);
    const row = await repos.ctx.db
      .prepare("SELECT client_id FROM mcp_sync_requests WHERE health_system_id = ?")
      .bind(id)
      .first<{ client_id: string | null }>();
    expect(row?.client_id).toBe("client-1");
  });

  it("refuses a second request inside the cooldown and writes nothing", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const id = await seedHealthSystem(repos);
    await repos.mcpSyncRequests.claim(id, "ordinary", LIMITS, "client-1");

    time.advance(LIMITS.cooldownSeconds - 1);
    const again = await repos.mcpSyncRequests.claim(id, "ordinary", LIMITS, "client-2");

    expect(again).toBe(false);
    expect(await repos.mcpSyncRequests.list("ordinary")).toStrictEqual([
      { healthSystemId: id, kind: "ordinary", requestedAt: T0, day: T0 / DAY, dayCount: 1 },
    ]);
  });

  it("gives the slot again once the cooldown has passed, and counts it", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const id = await seedHealthSystem(repos);
    await repos.mcpSyncRequests.claim(id, "ordinary", LIMITS, null);

    time.advance(LIMITS.cooldownSeconds);

    expect(await repos.mcpSyncRequests.claim(id, "ordinary", LIMITS, null)).toBe(true);
    expect(await repos.mcpSyncRequests.list("ordinary")).toMatchObject([
      { requestedAt: T0 + LIMITS.cooldownSeconds, dayCount: 2 },
    ]);
  });

  it("stops at the daily limit, and starts counting again when the UTC day turns", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const id = await seedHealthSystem(repos);
    for (let request = 0; request < LIMITS.dailyLimit; request += 1) {
      expect(await repos.mcpSyncRequests.claim(id, "full", LIMITS, null)).toBe(true);
      time.advance(LIMITS.cooldownSeconds);
    }

    // The cooldown has passed; the day's count is what refuses this one.
    expect(await repos.mcpSyncRequests.claim(id, "full", LIMITS, null)).toBe(false);

    time.advance(DAY);
    expect(await repos.mcpSyncRequests.claim(id, "full", LIMITS, null)).toBe(true);
    expect(await repos.mcpSyncRequests.list("full")).toMatchObject([
      { day: T0 / DAY + 1, dayCount: 1 },
    ]);
  });

  it("keeps a clock per health system and per kind", async () => {
    const repos = testRepos();
    const first = await seedHealthSystem(repos);
    const second = await seedHealthSystem(repos, { displayName: "Other Clinic" });
    await repos.mcpSyncRequests.claim(first, "ordinary", LIMITS, null);

    expect(await repos.mcpSyncRequests.claim(first, "ordinary", LIMITS, null)).toBe(false);
    expect(await repos.mcpSyncRequests.claim(first, "portal", LIMITS, null)).toBe(true);
    expect(await repos.mcpSyncRequests.claim(first, "full", LIMITS, null)).toBe(true);
    expect(await repos.mcpSyncRequests.claim(second, "ordinary", LIMITS, null)).toBe(true);
  });

  it("gives the slot to exactly one of several requests that arrive together", async () => {
    const repos = testRepos();
    const id = await seedHealthSystem(repos);

    const claims = await Promise.all(
      Array.from({ length: 8 }, () => repos.mcpSyncRequests.claim(id, "portal", LIMITS, null)),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await repos.mcpSyncRequests.list("portal")).toMatchObject([{ dayCount: 1 }]);
  });

  it("refuses a kind the schema does not know", async () => {
    const repos = testRepos();
    const id = await seedHealthSystem(repos);

    await expect(
      repos.mcpSyncRequests.claim(id, "everything" as "full", LIMITS, null),
    ).rejects.toThrow(/CHECK/u);
  });
});

describe("run_log.countOpen", () => {
  it("counts runs still open, and not ones that closed or went stale", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const stale = await repos.runLog.start("calendar");
    time.advance(3600);
    const closed = await repos.runLog.start("manual");
    await repos.runLog.finish(closed, { ok: true });

    expect(await repos.runLog.countOpen(time.now() - 1800)).toBe(0);

    const open = await repos.runLog.start("full");

    expect(await repos.runLog.countOpen(time.now() - 1800)).toBe(1);
    expect(stale).not.toBe(open);
  });
});
