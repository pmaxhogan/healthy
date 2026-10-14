// Stale platform totals: the hours whose `Agg.<Metric>` total counts a record
// the store no longer holds, marked when the apply takes the record out,
// cleared by a total from a later batch, and found by the one-off scan where
// nothing marked them (worker/src/hc/store/platform-stale.ts).
//
// Every record is synthetic: see helpers.ts.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { makeRepos } from "../../../src/db/index.ts";
import { Meter } from "../../../src/hc/store/budget.ts";
import { HOUR_MS } from "../../../src/hc/store/keys.ts";
import { SCAN_REVISION, scanPlatformTotals } from "../../../src/hc/store/platform-stale.ts";

import {
  MINUTE_MS,
  PHONE,
  T,
  WEARABLE,
  aggSteps,
  drain,
  enqueue,
  interval,
  resetHc,
  seedDevice,
  steps,
  testCtx,
} from "./helpers.ts";

/** Unix seconds, moved by the tests: when a batch is queued and when the scan runs. */
const clock = { now: 1_790_000_000 };
const ctx = testCtx({ now: () => clock.now });
const repos = makeRepos(ctx);

/** An hour well before "now", by its number: the deletions arrive long after. */
const H = T / HOUR_MS - 24 * 60;
const at = (hour: number, minutes = 0): number => hour * HOUR_MS + minutes * MINUTE_MS;

interface StaleRow {
  record_type: string;
  hour_utc: number;
  marked_seq: number | null;
}

async function stale(deviceId: string): Promise<StaleRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT record_type, hour_utc, marked_seq FROM hc_platform_stale
      WHERE device_id = ? ORDER BY record_type, hour_utc`,
  )
    .bind(deviceId)
    .all<StaleRow>();
  return results;
}

const hoursOf = (rows: readonly StaleRow[]): string[] =>
  rows.map((row) => `${row.record_type}:${String(row.hour_utc - H)}`);

/** The queue sequence number the next batch of the device will be given. */
async function lastSeq(): Promise<number> {
  const row = await env.DB.prepare("SELECT max(seq) AS seq FROM hc_ingest_queue").first<{
    seq: number | null;
  }>();
  return row?.seq ?? 0;
}

beforeEach(async () => {
  await resetHc();
  clock.now += 10;
});

describe("marking a stale platform total", () => {
  it("marks every hour a deleted record covered, stamped with the deleting batch, and a later total clears it", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        // Ninety minutes across two hours, and a one-minute record beside it.
        steps("long", at(H, 30), 900, { end: at(H + 2) }),
        steps("short", at(H + 5), 10),
        aggSteps(at(H), 300),
        aggSteps(at(H + 1), 600),
        aggSteps(at(H + 5), 10),
      ],
    });
    await drain(ctx, deviceId);
    expect(await stale(deviceId)).toStrictEqual([]);

    clock.now += 1;
    await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["long", "short"] });
    const deleting = await lastSeq();
    await drain(ctx, deviceId);
    const marked = await stale(deviceId);
    expect(hoursOf(marked)).toStrictEqual(["Steps:0", "Steps:1", "Steps:5"]);
    expect(marked.every((row) => row.marked_seq === deleting)).toBe(true);

    // The phone works two of them out again: one has a total, one has none.
    clock.now += 1;
    await enqueue(repos, deviceId, {
      batchId: "batch-0003",
      upserts: [aggSteps(at(H + 1), 0, [PHONE], { lastModified: 2000 })],
      deletes: [`agg:Steps:${String(at(H + 5))}`],
    });
    await drain(ctx, deviceId);
    expect(hoursOf(await stale(deviceId))).toStrictEqual(["Steps:0"]);
  });

  it("is not cleared by a total from a batch that arrived before the deletion", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [steps("s", at(H, 10), 10), aggSteps(at(H), 10)],
    });
    await drain(ctx, deviceId);
    // A total from before the deletion, set aside and queued again only after it.
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [aggSteps(at(H), 10, [WEARABLE], { lastModified: 1500 })],
    });
    await repos.hcIngestQueue.park(deviceId, "batch-0002");
    await enqueue(repos, deviceId, { batchId: "batch-0003", deletes: ["s"] });
    await drain(ctx, deviceId);
    expect(hoursOf(await stale(deviceId))).toStrictEqual(["Steps:0"]);

    await repos.hcIngestQueue.unpark(deviceId);
    await drain(ctx, deviceId);
    expect(hoursOf(await stale(deviceId))).toStrictEqual(["Steps:0"]);
  });

  it("does not mark an hour whose total the deleting batch carries", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        steps("a", at(H, 10), 10),
        steps("b", at(H + 1, 10), 10),
        steps("stays", at(H, 20), 5, { origin: PHONE }),
      ],
    });
    await drain(ctx, deviceId);
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [aggSteps(at(H), 5, [PHONE])],
      deletes: ["a", "b", `agg:Steps:${String(at(H + 1))}`],
    });
    await drain(ctx, deviceId);
    expect(await stale(deviceId)).toStrictEqual([]);
  });

  it("marks the hours a rewritten record left, not the ones it moved to", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        steps("moves", at(H, 10), 10),
        interval("night", "SleepSession", at(H + 2), at(H + 4), {}),
      ],
    });
    await drain(ctx, deviceId);
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [
        steps("moves", at(H + 8, 10), 10, { lastModified: 2000 }),
        interval("night", "SleepSession", at(H + 3), at(H + 5), {}, { lastModified: 2000 }),
      ],
    });
    await drain(ctx, deviceId);
    expect(hoursOf(await stale(deviceId))).toStrictEqual([
      "SleepSession:2",
      "SleepSession:3",
      "Steps:0",
    ]);
  });

  it("marks nothing for a type the platform keeps no total of, nor for the totals themselves", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        interval("hr", "HeartRate", at(H), at(H, 5), { samples: [] }),
        steps("s", at(H, 10), 10),
        aggSteps(at(H), 10),
      ],
    });
    await drain(ctx, deviceId);
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [aggSteps(at(H), 20, [WEARABLE], { start: at(H), lastModified: 2000 })],
      deletes: ["hr"],
    });
    await enqueue(repos, deviceId, {
      batchId: "batch-0003",
      deletes: [`agg:Steps:${String(at(H))}`],
    });
    await drain(ctx, deviceId);
    expect(await stale(deviceId)).toStrictEqual([]);
  });
});

describe("the one-off scan of stored totals", () => {
  it("marks a total that names an app with no record there, or has records of nobody, once", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        steps("w", at(H, 10), 10),
        // A record of the hour before, running into H + 3: that app is there.
        steps("p", at(H + 2, 50), 10, { origin: PHONE, end: at(H + 3, 20) }),
        aggSteps(at(H), 10, [WEARABLE]),
        // Counts the phone app, which has nothing in H + 1.
        aggSteps(at(H + 1), 10, [WEARABLE, PHONE]),
        aggSteps(at(H + 3), 10, [PHONE]),
        // Nothing of any app in H + 9.
        aggSteps(at(H + 9), 10, [WEARABLE]),
      ],
    });
    const { state } = await drain(ctx, deviceId);
    const found = await stale(deviceId);
    expect(hoursOf(found)).toStrictEqual(["Steps:1", "Steps:9"]);
    expect(found.every((row) => row.marked_seq === null)).toBe(true);
    // The runner knows the scan is done, and so does the table.
    expect(state.platformScanned).toBe(SCAN_REVISION);
    const row = await env.DB.prepare(
      "SELECT revision, done FROM hc_platform_scan WHERE device_id = ?",
    )
      .bind(deviceId)
      .first();
    expect(row).toStrictEqual({ revision: SCAN_REVISION, done: 1 });

    // Asked again, it finds the walk done and marks nothing.
    await env.DB.prepare("DELETE FROM hc_platform_stale").run();
    expect(
      await scanPlatformTotals(ctx, deviceId, new Meter({ maxQueries: 650, maxMs: 20_000 })),
    ).toBe(false);
    expect(await stale(deviceId)).toStrictEqual([]);
  });

  it("walks a long history a pass at a time, and a total from a later batch clears what it found", async () => {
    const deviceId = await seedDevice(repos);
    // Two hundred totals with no records under them: more than one pass.
    const hours = Array.from({ length: 200 }, (_, index) => H + index);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: hours.map((hour) => aggSteps(at(hour), 5, [WEARABLE])),
    });
    await drain(ctx, deviceId, { budget: { maxQueries: 30, maxMs: 20_000 } });
    expect(await stale(deviceId)).toHaveLength(200);

    // Arrived in the same second as the scan wrote its marks: it may have been
    // worked out before them, so it clears nothing.
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [aggSteps(at(H), 0, [PHONE], { lastModified: 2000 })],
    });
    await drain(ctx, deviceId);
    expect(await stale(deviceId)).toHaveLength(200);

    clock.now += 1;
    await enqueue(repos, deviceId, {
      batchId: "batch-0003",
      upserts: [aggSteps(at(H), 0, [PHONE], { lastModified: 3000 })],
      deletes: [`agg:Steps:${String(at(H + 1))}`],
    });
    await drain(ctx, deviceId);
    expect(await stale(deviceId)).toHaveLength(198);
  });
});
