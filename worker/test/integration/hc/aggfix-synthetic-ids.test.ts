// The platform's hourly totals are uploaded under an id the phone makes up
// from the metric and the hour (`agg:<Metric>:<hourStartMs>`), and it sends a
// delete for every hour of a window that has no total. An hour that is empty
// today and walked in tomorrow therefore sees a delete and THEN an upsert of
// the same id -- which a Health Connect record never does.
//
// A tombstone must not outlive that: the total of an hour that was once empty
// would otherwise be refused for ever, and every bucket holding the hour would
// be short by it.
//
// The same holds for an ordinary record, for another reason: Health Connect
// derives the id of a record written with a client record id from the app,
// that id and the type, so an app that deletes a record and writes it again
// gets the id back. What a tombstone refuses is an upsert OLDER than the
// delete -- from a batch that arrived before the deleting batch did -- and
// nothing else.
//
// "Arrived before" is the queue's sequence number, which two batches in one
// second still differ by; only a tombstone older than that column is compared
// by the second it arrived in.
//
// Every record is synthetic: see helpers.ts.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { makeRepos } from "../../../src/db/index.ts";
import { HOUR_MS } from "../../../src/hc/store/keys.ts";
import { readHourRollups, readRecords, storeBacklog } from "../../../src/hc/store/read.ts";
import { clock } from "../db/helpers.ts";

import {
  drain,
  enqueue,
  interval,
  logRow,
  resetHc,
  seedDevice,
  steps,
  T,
  testCtx,
} from "./helpers.ts";

import type { HcRecord } from "../../../src/hc/wire.ts";

beforeEach(resetHc);

const time = clock();
const ctx = testCtx({ now: time.now });
const repos = makeRepos(ctx);

const PLATFORM = "healthconnect";
const TIMEOUT = 30_000;

const aggId = (hourMs: number): string => `agg:Steps:${String(hourMs)}`;

/** The platform's total for one UTC hour, as the phone uploads it. */
function platformHour(hourMs: number, value: number, lastModified: number): HcRecord {
  return interval(
    aggId(hourMs),
    "Agg.Steps",
    hourMs,
    hourMs + HOUR_MS,
    { value, unit: "count", origins: [] },
    { origin: PLATFORM, lastModified },
  );
}

async function totals(deviceId: string): Promise<Record<string, unknown>> {
  const records = await readRecords(ctx, {
    deviceId,
    type: "Agg.Steps",
    startMs: T - 10 * HOUR_MS,
    endMs: T + 10 * HOUR_MS,
  });
  return Object.fromEntries(records.map((record) => [record.id, record.data.value]));
}

describe("a platform total whose hour was once empty", () => {
  it(
    "is stored when the hour gets its first total after a delete of the same id",
    async () => {
      const deviceId = await seedDevice(repos);
      const next = T + HOUR_MS;
      // The hour ahead has no total yet: the phone says so, with a delete.
      await enqueue(repos, deviceId, {
        batchId: "batch-0001",
        upserts: [platformHour(T, 300, 1000)],
        deletes: [aggId(next)],
      });
      await drain(ctx, deviceId);

      // An hour later it has one.
      await enqueue(repos, deviceId, {
        batchId: "batch-0002",
        upserts: [platformHour(next, 450, 2000)],
      });
      await drain(ctx, deviceId);

      expect(await totals(deviceId)).toStrictEqual({ [aggId(T)]: 300, [aggId(next)]: 450 });
      expect(await logRow(deviceId, "batch-0002")).toMatchObject({ applied: 1, superseded: 0 });
      const hours = await readHourRollups(ctx, {
        deviceId,
        type: "Agg.Steps",
        startMs: T,
        endMs: T + 2 * HOUR_MS,
      });
      expect(hours.map((row) => row.rollup.fields.value?.sum)).toStrictEqual([300, 450]);
      expect(await storeBacklog(ctx, deviceId)).toMatchObject({ dirty: 0 });
    },
    TIMEOUT,
  );

  it(
    "comes back after its hour was emptied and then filled again",
    async () => {
      const deviceId = await seedDevice(repos);
      await enqueue(repos, deviceId, {
        batchId: "batch-0001",
        upserts: [platformHour(T, 300, 1000)],
      });
      await drain(ctx, deviceId);
      await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: [aggId(T)] });
      await drain(ctx, deviceId);
      expect(await totals(deviceId)).toStrictEqual({});

      await enqueue(repos, deviceId, {
        batchId: "batch-0003",
        upserts: [platformHour(T, 120, 3000)],
      });
      await drain(ctx, deviceId);
      expect(await totals(deviceId)).toStrictEqual({ [aggId(T)]: 120 });

      // And it can be emptied again: the delete still finds it.
      await enqueue(repos, deviceId, { batchId: "batch-0004", deletes: [aggId(T)] });
      await drain(ctx, deviceId);
      expect(await totals(deviceId)).toStrictEqual({});
    },
    TIMEOUT,
  );

  it(
    "is the same whether the batch is applied once or replayed",
    async () => {
      const deviceId = await seedDevice(repos);
      await enqueue(repos, deviceId, { batchId: "batch-0001", deletes: [aggId(T)] });
      await drain(ctx, deviceId);
      const again = { upserts: [platformHour(T, 75, 2000)] };
      await enqueue(repos, deviceId, { batchId: "batch-0002", ...again });
      await drain(ctx, deviceId);
      await enqueue(repos, deviceId, { batchId: "batch-0003", ...again });
      await drain(ctx, deviceId);

      expect(await totals(deviceId)).toStrictEqual({ [aggId(T)]: 75 });
    },
    TIMEOUT,
  );
});

/** The Steps records the device holds in the test hour, as `id:count`. */
async function held(deviceId: string): Promise<string[]> {
  const records = await readRecords(ctx, {
    deviceId,
    type: "Steps",
    startMs: T,
    endMs: T + HOUR_MS,
  });
  return records.map((record) => `${record.id}:${String(record.data.count)}`);
}

describe("a record deleted and written again under the same id", () => {
  it(
    "is there when the rewrite comes in a later batch than the delete",
    async () => {
      const deviceId = await seedDevice(repos);
      await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 10)] });
      await drain(ctx, deviceId);
      time.advance(30);
      await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["a", "never-seen"] });
      await drain(ctx, deviceId);
      expect(await held(deviceId)).toStrictEqual([]);

      time.advance(30);
      await enqueue(repos, deviceId, {
        batchId: "batch-0003",
        // An older `lastModified` than the copy that was deleted: the phone's
        // clock is not what decides.
        upserts: [steps("a", T, 11, { lastModified: 500 }), steps("never-seen", T + 1000, 20)],
      });
      await drain(ctx, deviceId);

      expect(await held(deviceId)).toStrictEqual(["a:11", "never-seen:20"]);
      expect(await logRow(deviceId, "batch-0003")).toMatchObject({ applied: 2, superseded: 0 });
    },
    TIMEOUT,
  );

  it(
    "is there even when the rewrite was queued before the delete was applied",
    async () => {
      const deviceId = await seedDevice(repos);
      await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 10)] });
      await drain(ctx, deviceId);
      // Both wait in the queue together, and are applied long after they came.
      time.advance(30);
      await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["a"] });
      time.advance(1);
      await enqueue(repos, deviceId, { batchId: "batch-0003", upserts: [steps("a", T, 12)] });
      time.advance(3600);
      await drain(ctx, deviceId);

      expect(await held(deviceId)).toStrictEqual(["a:12"]);
    },
    TIMEOUT,
  );

  it(
    "stays deleted when the upsert is from a batch that arrived before the delete",
    async () => {
      const deviceId = await seedDevice(repos);
      // The upsert arrives first, and is set aside before it is applied.
      await enqueue(repos, deviceId, {
        batchId: "batch-0001",
        upserts: [steps("a", T, 10, { lastModified: 9_000_000 })],
      });
      await repos.hcIngestQueue.park(deviceId, "batch-0001");
      // The delete arrives ten minutes later, and is applied.
      time.advance(600);
      await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["a"] });
      await drain(ctx, deviceId);
      // Only now is the older batch queued again.
      time.advance(600);
      await repos.hcIngestQueue.unpark(deviceId);
      await drain(ctx, deviceId);

      expect(await held(deviceId)).toStrictEqual([]);
      expect(await logRow(deviceId, "batch-0001")).toMatchObject({ applied: 0, superseded: 1 });
    },
    TIMEOUT,
  );

  it(
    "stays deleted after a second delete, until a batch later than that one",
    async () => {
      const deviceId = await seedDevice(repos);
      await enqueue(repos, deviceId, { batchId: "batch-0001", deletes: ["a"] });
      await drain(ctx, deviceId);
      // An upsert arrives and is held back; a second delete arrives after it
      // and is applied first.
      time.advance(100);
      await enqueue(repos, deviceId, { batchId: "batch-0002", upserts: [steps("a", T, 10)] });
      await repos.hcIngestQueue.park(deviceId, "batch-0002");
      time.advance(100);
      await enqueue(repos, deviceId, { batchId: "batch-0003", deletes: ["a"] });
      await drain(ctx, deviceId);
      time.advance(1000);
      await repos.hcIngestQueue.unpark(deviceId);
      await drain(ctx, deviceId);
      expect(await held(deviceId)).toStrictEqual([]);

      await enqueue(repos, deviceId, { batchId: "batch-0004", upserts: [steps("a", T, 13)] });
      await drain(ctx, deviceId);
      expect(await held(deviceId)).toStrictEqual(["a:13"]);
    },
    TIMEOUT,
  );
});

/** The tombstone of every deleted id a device has, as the index holds it. */
async function tombstones(
  deviceId: string,
): Promise<{ deleted_at: number | null; deleted_seq: number | null }[]> {
  const { results } = await env.DB.prepare(
    `SELECT deleted_at, deleted_seq FROM hc_record_index
      WHERE device_id = ? AND deleted_at IS NOT NULL`,
  )
    .bind(deviceId)
    .all<{ deleted_at: number | null; deleted_seq: number | null }>();
  return results;
}

/** The queue sequence number of a batch that is still queued. */
async function seqOf(deviceId: string, batchId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT min(seq) AS seq FROM hc_ingest_queue WHERE device_id = ? AND batch_id = ?",
  )
    .bind(deviceId, batchId)
    .first<{ seq: number | null }>();
  return row?.seq ?? -1;
}

// The clock does not move in these: every batch arrives in the same second,
// so `received_at` cannot tell them apart and only the sequence number can.
describe("a delete and a rewrite that arrive in the same second", () => {
  it(
    "stays deleted when the upsert's batch arrived first, however late it is applied",
    async () => {
      const deviceId = await seedDevice(repos);
      await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 10)] });
      await repos.hcIngestQueue.park(deviceId, "batch-0001");
      await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["a"] });
      const deleting = await seqOf(deviceId, "batch-0002");
      await drain(ctx, deviceId);
      expect(await tombstones(deviceId)).toStrictEqual([
        { deleted_at: time.now(), deleted_seq: deleting },
      ]);

      await repos.hcIngestQueue.unpark(deviceId);
      await drain(ctx, deviceId);

      expect(await held(deviceId)).toStrictEqual([]);
      expect(await logRow(deviceId, "batch-0001")).toMatchObject({ applied: 0, superseded: 1 });
      // And the late batch left the stamp alone.
      expect(await tombstones(deviceId)).toStrictEqual([
        { deleted_at: time.now(), deleted_seq: deleting },
      ]);
    },
    TIMEOUT,
  );

  it(
    "comes back when the upsert's batch arrived after the delete's",
    async () => {
      const deviceId = await seedDevice(repos);
      await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 10)] });
      await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["a", "never-seen"] });
      await enqueue(repos, deviceId, {
        batchId: "batch-0003",
        upserts: [steps("a", T, 11), steps("never-seen", T + 1000, 20)],
      });
      await drain(ctx, deviceId);

      expect(await held(deviceId)).toStrictEqual(["a:11", "never-seen:20"]);
      // Brought back to life: neither half of the stamp is left behind.
      expect(await tombstones(deviceId)).toStrictEqual([]);
    },
    TIMEOUT,
  );

  it(
    "stays deleted when one batch both deletes and upserts the id",
    async () => {
      const deviceId = await seedDevice(repos);
      await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 10)] });
      await enqueue(repos, deviceId, {
        batchId: "batch-0002",
        deletes: ["a", "never-seen"],
        upserts: [steps("a", T, 11), steps("never-seen", T + 1000, 20)],
      });
      await drain(ctx, deviceId);

      expect(await held(deviceId)).toStrictEqual([]);
      expect(await logRow(deviceId, "batch-0002")).toMatchObject({ applied: 0, superseded: 2 });
    },
    TIMEOUT,
  );

  it(
    "takes the later delete's place when a parked delete is applied after a newer one",
    async () => {
      const deviceId = await seedDevice(repos);
      await enqueue(repos, deviceId, { batchId: "batch-0001", deletes: ["a"] });
      await repos.hcIngestQueue.park(deviceId, "batch-0001");
      await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["a"] });
      const newer = await seqOf(deviceId, "batch-0002");
      await drain(ctx, deviceId);
      await repos.hcIngestQueue.unpark(deviceId);
      await drain(ctx, deviceId);

      // The older delete, applied late, did not move the stamp back.
      expect(await tombstones(deviceId)).toStrictEqual([
        { deleted_at: time.now(), deleted_seq: newer },
      ]);
    },
    TIMEOUT,
  );
});

/** Make every tombstone of a device one from before `deleted_seq` was kept. */
async function forgetSeq(deviceId: string, deletedAt: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE hc_record_index SET deleted_seq = NULL, deleted_at = ?
      WHERE device_id = ? AND deleted_at IS NOT NULL`,
  )
    .bind(deletedAt, deviceId)
    .run();
}

describe("a tombstone from before the sequence number was kept", () => {
  it(
    "is brought back by a batch that arrived in the same second, as it always was",
    async () => {
      const deviceId = await seedDevice(repos);
      await enqueue(repos, deviceId, { batchId: "batch-0001", deletes: ["a"] });
      await drain(ctx, deviceId);
      await forgetSeq(deviceId, time.now());

      await enqueue(repos, deviceId, { batchId: "batch-0002", upserts: [steps("a", T, 10)] });
      await drain(ctx, deviceId);

      expect(await held(deviceId)).toStrictEqual(["a:10"]);
    },
    TIMEOUT,
  );

  it(
    "is not brought back by a same-second batch that deletes the id too",
    async () => {
      const deviceId = await seedDevice(repos);
      await enqueue(repos, deviceId, { batchId: "batch-0001", deletes: ["a"] });
      await drain(ctx, deviceId);
      await forgetSeq(deviceId, time.now());

      await enqueue(repos, deviceId, {
        batchId: "batch-0002",
        deletes: ["a"],
        upserts: [steps("a", T, 10)],
      });
      await drain(ctx, deviceId);

      expect(await held(deviceId)).toStrictEqual([]);
      // Not later by the second, so the old stamp stands, without a number.
      expect(await tombstones(deviceId)).toStrictEqual([
        { deleted_at: time.now(), deleted_seq: null },
      ]);
    },
    TIMEOUT,
  );

  it(
    "refuses a batch from an earlier second and takes one from a later second",
    async () => {
      const deviceId = await seedDevice(repos);
      await enqueue(repos, deviceId, { batchId: "batch-0001", deletes: ["a"] });
      await drain(ctx, deviceId);
      // The delete is on record as having arrived a minute from now.
      const deletedAt = time.now() + 60;
      await forgetSeq(deviceId, deletedAt);

      // A higher sequence number, but the tombstone has none to compare with.
      await enqueue(repos, deviceId, { batchId: "batch-0002", upserts: [steps("a", T, 10)] });
      await drain(ctx, deviceId);
      expect(await held(deviceId)).toStrictEqual([]);

      time.advance(120);
      await enqueue(repos, deviceId, { batchId: "batch-0003", upserts: [steps("a", T, 12)] });
      await drain(ctx, deviceId);
      expect(await held(deviceId)).toStrictEqual(["a:12"]);
    },
    TIMEOUT,
  );

  it(
    "takes a number, and the exact order with it, when a later batch deletes the id again",
    async () => {
      const deviceId = await seedDevice(repos);
      await enqueue(repos, deviceId, { batchId: "batch-0001", deletes: ["a"] });
      await drain(ctx, deviceId);
      await forgetSeq(deviceId, time.now());

      time.advance(1);
      await enqueue(repos, deviceId, { batchId: "batch-0002", upserts: [steps("a", T, 10)] });
      await repos.hcIngestQueue.park(deviceId, "batch-0002");
      await enqueue(repos, deviceId, { batchId: "batch-0003", deletes: ["a"] });
      const deleting = await seqOf(deviceId, "batch-0003");
      await drain(ctx, deviceId);
      expect(await tombstones(deviceId)).toStrictEqual([
        { deleted_at: time.now(), deleted_seq: deleting },
      ]);

      // Same second as the second delete, but before it: refused.
      await repos.hcIngestQueue.unpark(deviceId);
      await drain(ctx, deviceId);
      expect(await held(deviceId)).toStrictEqual([]);
    },
    TIMEOUT,
  );
});
