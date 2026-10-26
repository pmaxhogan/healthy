// `mcp_message_refreshes`: the token bucket `refresh_messages` is held to.
//
// Real D1, because the whole guarantee is one SQL statement: the upsert whose
// `WHERE` decides, from the refilled level, whether a token is there to spend.

import { beforeEach, describe, expect, it } from "vitest";

import { bucketLevel } from "../../../src/mcp/message-refresh.ts";

import { T0, clock, resetDb, seedHealthSystem, testRepos } from "./helpers.ts";

beforeEach(resetDb);

const LIMITS = { capacity: 3, refillSeconds: 60 };

describe("mcp_message_refreshes.take", () => {
  it("lets a full bucket be spent at once, then refuses and writes nothing", async () => {
    const repos = testRepos();
    const id = await seedHealthSystem(repos);

    for (let take = 0; take < LIMITS.capacity; take += 1) {
      expect(await repos.mcpMessageRefreshes.take(id, LIMITS, "client-1")).toBe(true);
    }
    expect(await repos.mcpMessageRefreshes.get(id)).toStrictEqual({ tokens: 0, updatedAt: T0 });

    expect(await repos.mcpMessageRefreshes.take(id, LIMITS, "client-2")).toBe(false);
    expect(await repos.mcpMessageRefreshes.get(id)).toStrictEqual({ tokens: 0, updatedAt: T0 });
    const row = await repos.ctx.db
      .prepare("SELECT client_id FROM mcp_message_refreshes WHERE health_system_id = ?")
      .bind(id)
      .first<{ client_id: string | null }>();
    expect(row?.client_id).toBe("client-1");
  });

  it("earns one token back per refill period, continuously", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const id = await seedHealthSystem(repos);
    for (let take = 0; take < LIMITS.capacity; take += 1) {
      await repos.mcpMessageRefreshes.take(id, LIMITS, null);
    }

    time.advance(LIMITS.refillSeconds - 1);
    expect(await repos.mcpMessageRefreshes.take(id, LIMITS, null)).toBe(false);

    time.advance(1);
    expect(await repos.mcpMessageRefreshes.take(id, LIMITS, null)).toBe(true);
    expect(await repos.mcpMessageRefreshes.take(id, LIMITS, null)).toBe(false);

    // Half a period banks half a token; the next half completes it.
    time.advance(LIMITS.refillSeconds / 2);
    expect(await repos.mcpMessageRefreshes.take(id, LIMITS, null)).toBe(false);
    time.advance(LIMITS.refillSeconds / 2);
    expect(await repos.mcpMessageRefreshes.take(id, LIMITS, null)).toBe(true);
  });

  it("never refills past capacity, however long it sat", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const id = await seedHealthSystem(repos);
    await repos.mcpMessageRefreshes.take(id, LIMITS, null);

    time.advance(LIMITS.refillSeconds * 100);
    expect(await repos.mcpMessageRefreshes.take(id, LIMITS, null)).toBe(true);
    expect(await repos.mcpMessageRefreshes.get(id)).toMatchObject({
      tokens: LIMITS.capacity - 1,
    });
  });

  it("earns nothing from a clock that went backwards", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const id = await seedHealthSystem(repos);
    for (let take = 0; take < LIMITS.capacity; take += 1) {
      await repos.mcpMessageRefreshes.take(id, LIMITS, null);
    }
    time.advance(-LIMITS.refillSeconds * 10);
    expect(await repos.mcpMessageRefreshes.take(id, LIMITS, null)).toBe(false);
  });

  it("keeps each health system's bucket apart", async () => {
    const repos = testRepos();
    const a = await seedHealthSystem(repos);
    const b = await seedHealthSystem(repos);
    for (let take = 0; take < LIMITS.capacity; take += 1) {
      await repos.mcpMessageRefreshes.take(a, LIMITS, null);
    }
    expect(await repos.mcpMessageRefreshes.take(a, LIMITS, null)).toBe(false);
    expect(await repos.mcpMessageRefreshes.take(b, LIMITS, null)).toBe(true);
  });

  it("agrees with the tool's own arithmetic on what is left", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const id = await seedHealthSystem(repos);
    await repos.mcpMessageRefreshes.take(id, LIMITS, null);
    await repos.mcpMessageRefreshes.take(id, LIMITS, null);
    time.advance(LIMITS.refillSeconds / 4);

    const level = bucketLevel(await repos.mcpMessageRefreshes.get(id), time.now(), LIMITS);
    expect(level).toBeCloseTo(1.25);
  });
});

describe("mcp_message_refreshes.refund", () => {
  it("gives a token back, never past capacity", async () => {
    const repos = testRepos();
    const id = await seedHealthSystem(repos);
    await repos.mcpMessageRefreshes.take(id, LIMITS, null);

    await repos.mcpMessageRefreshes.refund(id, LIMITS);
    expect(await repos.mcpMessageRefreshes.get(id)).toMatchObject({ tokens: LIMITS.capacity });
    await repos.mcpMessageRefreshes.refund(id, LIMITS);
    expect(await repos.mcpMessageRefreshes.get(id)).toMatchObject({ tokens: LIMITS.capacity });
  });

  it("does nothing for a bucket never used", async () => {
    const repos = testRepos();
    const id = await seedHealthSystem(repos);
    await repos.mcpMessageRefreshes.refund(id, LIMITS);
    expect(await repos.mcpMessageRefreshes.get(id)).toBeNull();
  });
});
