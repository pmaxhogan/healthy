// The heart-rate spill a page reads ahead (worker/src/hc/store/hr-spill.ts)
// against the statement it stands in for (`HR_SPILL_SQL`, through `hrSpillIn`).
//
// Applying a page of heart-rate chunks no longer asks D1, chunk by chunk, which
// earlier records reach into each hour: it asks once, and works the rest out
// from what the page has built. These tests hold the working-out to the
// statement's own answer -- for a store as it is, and for a store as it will
// be once a set of writes has landed.
//
// Every record is synthetic: see helpers.ts.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { makeRepos } from "../../../src/db/index.ts";
import { hrSpillIn, readChunks } from "../../../src/hc/store/chunks.ts";
import { HrSpillView, reaches } from "../../../src/hc/store/hr-spill.ts";
import { HOUR_MS, compareText, keyId, sortedBy } from "../../../src/hc/store/keys.ts";

import {
  drain,
  enqueue,
  H0,
  heartRate,
  MINUTE_MS,
  PHONE,
  resetHc,
  seedDevice,
  T,
  testCtx,
} from "./helpers.ts";

import type { ChunkKey } from "../../../src/hc/store/keys.ts";
import type { HcRecord } from "../../../src/hc/wire.ts";

beforeEach(resetHc);

const ctx = testCtx();
const repos = makeRepos(ctx);

/** A series from `startMs` to `endMs`, with a sample at each end. */
function series(id: string, startMs: number, endMs: number, extra: Partial<HcRecord> = {}) {
  return heartRate(
    id,
    startMs,
    [
      [0, 60],
      [endMs - startMs, 70],
    ],
    { end: endMs, ...extra },
  );
}

const at = (hours: number, minutes = 0): number => T + hours * HOUR_MS + minutes * MINUTE_MS;

/**
 * Chunks that end every way the rule tells apart: inside their hour, exactly
 * on the next, a little past it, hours past it, and exactly on a boundary two
 * hours on -- for one origin, and a second origin that must stay out of it.
 */
function shapes(): HcRecord[] {
  return [
    series("on-boundary", at(0, 10), at(1)),
    series("inside", at(1, 5), at(1, 50)),
    series("just-past", at(2, 40), at(3, 5)),
    series("long", at(3, 30), at(6, 20)),
    series("two-hours-on-the-dot", at(4, 15), at(6)),
    series("other-app", at(0, 20), at(1), { origin: PHONE }),
    series("other-app-long", at(2), at(5, 30), { origin: PHONE }),
  ];
}

/** The origin blinds in the store, in a stable order, with the hours each has a chunk in. */
async function origins(deviceId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT origin_hash FROM hc_chunks WHERE device_id = ? ORDER BY origin_hash",
  )
    .bind(deviceId)
    .all<{ origin_hash: string }>();
  return results.map((row) => row.origin_hash);
}

/** The ids of some records, in a stable order: what two answers are compared by. */
function ids(records: readonly HcRecord[]): string[] {
  return sortedBy(
    records.map((record) => record.id),
    compareText,
  );
}

/** Every (origin, hour) from one before the first chunk to two after the last. */
function everyHour(originHashes: readonly string[]): ChunkKey[] {
  return originHashes.flatMap((originHash) =>
    Array.from({ length: 10 }, (_, index) => ({
      type: "HeartRate",
      originHash,
      hourUtc: H0 - 1 + index,
    })),
  );
}

describe("the spill a page reads ahead", () => {
  it("is what the statement returns, hour by hour and origin by origin", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: shapes() });
    await drain(ctx, deviceId);
    const keys = everyHour(await origins(deviceId));

    const view = await HrSpillView.load(ctx, deviceId, keys);

    const answers: Record<string, string[]> = {};
    for (const key of keys) {
      const fromTable = await hrSpillIn(ctx, deviceId, key.originHash, key.hourUtc);
      expect(view.covers(key)).toBe(true);
      expect(ids(view.into(key)), `into hour ${String(key.hourUtc - H0)}`).toStrictEqual(
        ids(fromTable),
      );
      answers[`${String(keys.indexOf(key) >= 10 ? 1 : 0)}:${String(key.hourUtc - H0)}`] =
        ids(fromTable);
    }
    // And the statement's answers are the ones the rule describes, so the
    // comparison above is not of two empty lists.
    const nonEmpty = Object.values(answers).filter((list) => list.length > 0);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(8);
    const all = new Set(nonEmpty.flat());
    // `inside` ends in its own hour, and reaches into no other.
    expect(all.has("inside")).toBe(false);
    expect(all.has("on-boundary")).toBe(true);
    expect(all.has("two-hours-on-the-dot")).toBe(true);
  });

  it("does not answer for an hour it was not asked to read", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: shapes() });
    await drain(ctx, deviceId);
    const [originHash = ""] = await origins(deviceId);
    const asked: ChunkKey = { type: "HeartRate", originHash, hourUtc: H0 + 1 };

    const view = await HrSpillView.load(ctx, deviceId, [
      asked,
      { type: "Steps", originHash, hourUtc: H0 + 2 },
    ]);

    expect(view.covers(asked)).toBe(true);
    expect(view.covers({ ...asked, hourUtc: H0 + 2 })).toBe(false);
    expect(view.covers({ type: "Steps", originHash, hourUtc: H0 + 2 })).toBe(false);
  });

  it("follows the chunks a page has built: the statement's answer once they are stored", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: shapes() });
    await drain(ctx, deviceId);
    const keys = everyHour(await origins(deviceId));
    // Read ahead from the store as it is now...
    const view = await HrSpillView.load(ctx, deviceId, keys);

    // ...then change it every way a batch can: a series cut back to end inside
    // its hour, one stretched across two more, one deleted, one that now ends
    // on the dot, a new chunk, and the other origin's long series gone.
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [
        series("on-boundary", at(0, 10), at(0, 40), { lastModified: 2000 }),
        series("inside", at(1, 5), at(3, 10), { lastModified: 2000 }),
        series("long", at(3, 30), at(4), { lastModified: 2000 }),
        series("new", at(5, 1), at(7, 30)),
      ],
      deletes: ["just-past", "other-app-long"],
    });
    await drain(ctx, deviceId);
    // Tell the view what each of its chunks holds now (an hour with no chunk
    // left holds nothing), as `rewriteChunk` does when it builds one.
    const stored = await readChunks(ctx, deviceId, keys);
    for (const key of keys) {
      const now = stored.get(keyId(key));
      view.wrote(key, now?.records ?? []);
    }

    let reaching = 0;
    for (const key of keys) {
      const fromTable = await hrSpillIn(ctx, deviceId, key.originHash, key.hourUtc);
      reaching += fromTable.length;
      expect(ids(view.into(key)), `into hour ${String(key.hourUtc - H0)}`).toStrictEqual(
        ids(fromTable),
      );
    }
    expect(reaching).toBeGreaterThan(5);
  });
});

/** The first instant of a UTC hour. */
const start = (hour: number): number => hour * HOUR_MS;

describe("whether a chunk reaches into an hour", () => {
  it("is true of an earlier chunk that runs past the hour's start", () => {
    expect(reaches(10, start(12) + 1, 12)).toBe(true);
    expect(reaches(11, start(12) + 1, 12)).toBe(true);
    expect(reaches(3, start(40), 12)).toBe(true);
  });

  it("is true of the hour before when it ends exactly on the start, and of no earlier one", () => {
    expect(reaches(11, start(12), 12)).toBe(true);
    // An earlier chunk ending on the dot is past its own hour, but the
    // statement reads the boundary case by primary key, for the hour before only.
    expect(reaches(10, start(12), 12)).toBe(false);
  });

  it("is false of a chunk that ends before the hour, and of the hour itself or a later one", () => {
    expect(reaches(11, start(12) - 1, 12)).toBe(false);
    expect(reaches(12, start(14), 12)).toBe(false);
    expect(reaches(13, start(15), 12)).toBe(false);
  });
});
