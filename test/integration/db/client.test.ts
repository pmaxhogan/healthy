import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  BATCH_CHUNK,
  all,
  batch,
  chunk,
  makeCtx,
  nowIso,
  one,
  run,
  sha256Hex,
  ttlSeconds,
} from "../../../worker/db/client.ts";
import { reposFor } from "../../../worker/db/index.ts";

import { T0, resetDb, testCtx } from "./helpers.ts";

beforeEach(resetDb);

describe("one / all / run", () => {
  it("return a typed row, a typed list, and a change count", async () => {
    const ctx = testCtx();
    const insert = await run(
      ctx.db
        .prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('calendar_id', ?, ?)")
        .bind('"primary"', T0),
    );

    expect(insert.changes).toBe(1);
    expect(await one<{ key: string }>(ctx.db.prepare("SELECT key FROM settings"))).toStrictEqual({
      key: "calendar_id",
    });
    expect(await all<{ key: string }>(ctx.db.prepare("SELECT key FROM settings"))).toStrictEqual([
      { key: "calendar_id" },
    ]);
  });

  it("give null and an empty list for no rows", async () => {
    const ctx = testCtx();

    expect(await one(ctx.db.prepare("SELECT key FROM settings"))).toBeNull();
    expect(await all(ctx.db.prepare("SELECT key FROM settings"))).toStrictEqual([]);
  });

  it("report zero changes for an UPDATE that matched nothing", async () => {
    // The lease CAS depends on this being exact, not merely truthy.
    const ctx = testCtx();
    const result = await run(
      ctx.db.prepare("UPDATE settings SET updated_at = 1 WHERE key = 'nope'"),
    );

    expect(result.changes).toBe(0);
  });
});

describe("batch", () => {
  it("applies every statement and returns their rows", async () => {
    const ctx = testCtx();

    const results = await batch<{ key: string }>(ctx.db, [
      ctx.db
        .prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('a', '1', ?)")
        .bind(T0),
      ctx.db
        .prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('b', '2', ?)")
        .bind(T0),
      ctx.db.prepare("SELECT key FROM settings ORDER BY key"),
    ]);

    expect(results.at(-1)).toStrictEqual([{ key: "a" }, { key: "b" }]);
  });

  it("does nothing for an empty batch rather than erroring", async () => {
    // D1 rejects an empty batch, and "nothing to write" is a normal state for a
    // settings PUT that changed nothing.
    const ctx = testCtx();

    expect(await batch(ctx.db, [])).toStrictEqual([]);
  });

  it("rolls the whole batch back when one statement fails", async () => {
    const ctx = testCtx();

    await expect(
      batch(ctx.db, [
        ctx.db
          .prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('a', '1', ?)")
          .bind(T0),
        ctx.db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('a', '1', 0)"),
      ]),
    ).rejects.toThrow();

    expect(await all(ctx.db.prepare("SELECT key FROM settings"))).toStrictEqual([]);
  });
});

describe("chunk", () => {
  it("splits a list into pages of at most `size`", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toStrictEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toStrictEqual([]);
    expect(chunk([1, 2], 5)).toStrictEqual([[1, 2]]);
  });

  it("defaults to the batch size the FHIR cache uses", () => {
    expect(chunk(Array.from({ length: BATCH_CHUNK + 1 }, (_unused, index) => index))).toHaveLength(
      2,
    );
  });
});

describe("nowIso and ttlSeconds", () => {
  it("renders the clock as an ISO instant, for logs and descriptions", () => {
    expect(nowIso(() => T0)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rounds a millisecond TTL up to whole seconds, never to zero", () => {
    expect(ttlSeconds(1000)).toBe(1);
    expect(ttlSeconds(1500)).toBe(2);
    expect(ttlSeconds(1)).toBe(1);
    expect(ttlSeconds(0)).toBe(1);
    expect(ttlSeconds(86_400_000)).toBe(86_400);
  });
});

describe("sha256Hex", () => {
  it("is the standard digest, as lower-case hex", async () => {
    // The empty-string digest is a well-known constant, so this pins the encoding
    // as well as the algorithm.
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("a")).not.toBe(await sha256Hex("b"));
    expect(await sha256Hex("a")).toHaveLength(64);
  });
});

describe("makeCtx", () => {
  it("defaults to a real clock in unix seconds and a logger that says nothing", () => {
    const ctx = makeCtx(env.DB, { ...env, DATA_KEY: "unused" } as never);

    expect(ctx.now()).toBeGreaterThan(1_700_000_000);
    expect(ctx.now()).toBeLessThan(4_000_000_000);
    expect(() => {
      ctx.log.info("nothing is written anywhere");
    }).not.toThrow();
  });
});

describe("reposFor", () => {
  it("builds the whole set from a binding and an env, which is what a handler has", async () => {
    const repos = reposFor(env.DB, { ...env, DATA_KEY: "unused" } as never, { now: () => T0 });

    // A set, because the order the factory happens to build them in is not part
    // of the contract (and `toSorted` is not in the Worker project's lib).
    expect(new Set(Object.keys(repos))).toStrictEqual(
      new Set([
        "alerts",
        "calendarEvents",
        "connections",
        "ctx",
        "fhirCache",
        "fhirSyncState",
        "google",
        "loginAttempts",
        "mailInbox",
        "mcpAudit",
        "mcpPolicy",
        "oauthStates",
        "portalAccounts",
        "portalVisits",
        "providers",
        "runLog",
      ]),
    );
    expect(repos.ctx.now()).toBe(T0);
    // Reaches the real database, not a stub.
    expect(await repos.providers.list()).toStrictEqual([]);
  });
});
