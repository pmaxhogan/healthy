// The apply side of the Health Connect pipeline: a queued batch becomes chunks,
// index rows, rollups and bookkeeping -- and stays the same however often, and
// in however many slices, it is applied.
//
// Every record is synthetic: see helpers.ts.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { makeRepos } from "../../../src/db/index.ts";
import {
  EMPTY_RUNNER_STATE,
  MAX_BATCH_FAILURES,
  NO_HEAD_FAILURES,
  beginAttempt,
  runHcSlice,
} from "../../../src/hc/apply.ts";
import { markStatements } from "../../../src/hc/store/dirty.ts";
import { HOUR_MS } from "../../../src/hc/store/keys.ts";
import {
  listOrigins,
  listTypes,
  readHourRollups,
  readHrMinutes,
  readRecords,
  storeBacklog,
} from "../../../src/hc/store/read.ts";
import { OTHER_DATA_KEY, clock, recordingLog } from "../db/helpers.ts";

import {
  count,
  drain,
  enqueue,
  H0,
  heartRate,
  logRow,
  MINUTE_MS,
  PHONE,
  resetHc,
  seedDevice,
  steps,
  syncRows,
  T,
  testCtx,
  WEARABLE,
} from "./helpers.ts";

import type { HcRecord } from "../../../src/hc/wire.ts";

beforeEach(resetHc);

/** Forty kilobytes of text that will not compress. */
function noise(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(30_000));
  return btoa(String.fromCodePoint(...bytes));
}

const time = clock();
const ctx = testCtx({ now: time.now });
const repos = makeRepos(ctx);

/** Every Steps record the device holds, as `id:count`, in start order. */
async function stored(deviceId: string, type = "Steps"): Promise<string[]> {
  const records = await readRecords(ctx, { deviceId, type, startMs: 0, endMs: T + 1000 * HOUR_MS });
  return records.map((record) => `${record.id}:${String(record.data.count)}`);
}

async function maxUpdatedAt(deviceId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT max(updated_at) AS at FROM hc_chunks WHERE device_id = ?",
  )
    .bind(deviceId)
    .first<{ at: number | null }>();
  return row?.at ?? null;
}

describe("applying a batch", () => {
  it("stores the records sealed, by hour, and reads them back", async () => {
    const deviceId = await seedDevice(repos);
    const records = [
      steps("a", T, 110),
      steps("b", T + 5 * MINUTE_MS, 120),
      steps("c", T + HOUR_MS, 130),
    ];
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: records });

    await drain(ctx, deviceId);

    expect(await count("hc_chunks", deviceId)).toBe(2);
    expect(await count("hc_record_index", deviceId)).toBe(3);
    expect(await count("hc_ingest_queue", deviceId)).toBe(0);
    expect(await storeBacklog(ctx, deviceId)).toStrictEqual({
      queuedBatches: 0,
      parkedBatches: 0,
      dirty: 0,
      parkedMarks: 0,
      rezonePending: false,
    });
    const read = await readRecords(ctx, {
      deviceId,
      type: "Steps",
      startMs: T,
      endMs: T + 2 * HOUR_MS,
    });
    expect(read).toStrictEqual(records);
    expect(await listTypes(ctx, deviceId)).toStrictEqual(["Steps"]);

    const log = await logRow(deviceId, "batch-0001");
    expect(log).toMatchObject({ status: "applied", error_code: null, applied: 3, superseded: 0 });
    expect(log?.applied_at).toBe(time.now());

    // Nothing clinical, and no app's name, is readable in the table.
    const { results } = await env.DB.prepare(
      "SELECT origin_hash, payload_enc, record_count, min_start_ms, max_end_ms FROM hc_chunks ORDER BY hour_utc",
    ).all<{ origin_hash: string; payload_enc: string; record_count: number; max_end_ms: number }>();
    expect(results.map((row) => row.record_count)).toStrictEqual([2, 1]);
    expect(results[0]?.max_end_ms).toBe(T + 6 * MINUTE_MS);
    for (const row of results) {
      expect(row.payload_enc.startsWith("v3:")).toBe(true);
      expect(row.origin_hash).not.toContain("example");
    }
  });

  it("reads a window by overlap, opening a chunk that starts before it", async () => {
    const deviceId = await seedDevice(repos);
    const night: HcRecord = {
      id: "long",
      type: "SleepSession",
      origin: WEARABLE,
      lastModified: 1000,
      start: T - 3 * HOUR_MS,
      end: T + 5 * HOUR_MS,
      data: {},
    };
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [night] });
    await drain(ctx, deviceId);

    const window = { deviceId, type: "SleepSession" };
    const during = await readRecords(ctx, { ...window, startMs: T, endMs: T + HOUR_MS });
    const after = await readRecords(ctx, {
      ...window,
      startMs: T + 5 * HOUR_MS,
      endMs: T + 6 * HOUR_MS,
    });
    const before = await readRecords(ctx, {
      ...window,
      startMs: T - 9 * HOUR_MS,
      endMs: T - 3 * HOUR_MS,
    });

    expect(during.map((record) => record.id)).toStrictEqual(["long"]);
    expect(after).toStrictEqual([]);
    expect(before).toStrictEqual([]);
  });

  it("changes nothing when the same records arrive again", async () => {
    const deviceId = await seedDevice(repos);
    const records = [steps("a", T, 110), steps("b", T + HOUR_MS, 120)];
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: records });
    await drain(ctx, deviceId);
    const written = await maxUpdatedAt(deviceId);

    time.advance(600);
    await enqueue(repos, deviceId, { batchId: "batch-0002", upserts: records });
    await drain(ctx, deviceId);

    // The chunks were recognised as unchanged and not rewritten.
    expect(await maxUpdatedAt(deviceId)).toBe(written);
    expect(await stored(deviceId)).toStrictEqual(["a:110", "b:120"]);
    expect(await logRow(deviceId, "batch-0002")).toMatchObject({
      status: "applied",
      applied: 2,
      superseded: 0,
    });
    const sync = await syncRows(deviceId);
    expect(sync.Steps?.record_count).toBe(2);
  });

  it("keeps the copy with the greater lastModified", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [steps("a", T, 100, { lastModified: 2000 })],
    });
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [steps("a", T, 200, { lastModified: 3000 })],
    });
    // Older than what is held: late, and dropped.
    await enqueue(repos, deviceId, {
      batchId: "batch-0003",
      upserts: [steps("a", T, 300, { lastModified: 2500 })],
    });
    // Two copies in one batch: the newer one is the batch's say.
    await enqueue(repos, deviceId, {
      batchId: "batch-0004",
      upserts: [
        steps("b", T, 400, { lastModified: 5000 }),
        steps("b", T, 500, { lastModified: 4000 }),
      ],
    });

    await drain(ctx, deviceId);

    expect(await stored(deviceId)).toStrictEqual(["a:200", "b:400"]);
    expect(await logRow(deviceId, "batch-0002")).toMatchObject({ applied: 1, superseded: 0 });
    expect(await logRow(deviceId, "batch-0003")).toMatchObject({ applied: 0, superseded: 1 });
    expect(await logRow(deviceId, "batch-0004")).toMatchObject({ applied: 1, superseded: 1 });
  });

  it("deletes by id, and drops a late upsert of a deleted id", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [steps("a", T, 100), steps("b", T + MINUTE_MS, 200)],
    });
    await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["a", "a"] });
    await drain(ctx, deviceId);

    expect(await stored(deviceId)).toStrictEqual(["b:200"]);
    expect(await logRow(deviceId, "batch-0002")).toMatchObject({ status: "applied", removed: 1 });

    // Health Connect never reuses an id: this is the deleted record, late.
    await enqueue(repos, deviceId, {
      batchId: "batch-0003",
      upserts: [steps("a", T, 999, { lastModified: 9000 })],
    });
    await drain(ctx, deviceId);

    expect(await stored(deviceId)).toStrictEqual(["b:200"]);
    expect(await logRow(deviceId, "batch-0003")).toMatchObject({ applied: 0, superseded: 1 });
  });

  it("deletes the chunk and its rollup when its last record goes", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 100)] });
    await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["a"] });

    await drain(ctx, deviceId);

    expect(await count("hc_chunks", deviceId)).toBe(0);
    expect(await count("hc_rollup_hour", deviceId)).toBe(0);
    expect(await count("hc_rollup_day", deviceId)).toBe(0);
    // The tombstone stays.
    expect(await count("hc_record_index", deviceId)).toBe(1);
  });

  it("keeps a record deleted when its upsert and its delete share a batch, or arrive reversed", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [steps("gone", T, 100), steps("kept", T, 200)],
      deletes: ["gone"],
    });
    await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["never-seen"] });
    await enqueue(repos, deviceId, {
      batchId: "batch-0003",
      upserts: [steps("never-seen", T, 300)],
    });

    await drain(ctx, deviceId);

    expect(await stored(deviceId)).toStrictEqual(["kept:200"]);
    expect(await logRow(deviceId, "batch-0001")).toMatchObject({
      applied: 1,
      superseded: 1,
      removed: 0,
    });
  });

  it("moves a record whose start hour changed, and only for a newer copy", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [steps("a", T, 100, { lastModified: 2000 })],
    });
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [steps("a", T + 3 * HOUR_MS, 150, { lastModified: 3000 })],
    });
    await drain(ctx, deviceId);

    const hours = async (): Promise<number[]> => {
      const { results } = await env.DB.prepare(
        "SELECT hour_utc FROM hc_chunks WHERE device_id = ? ORDER BY hour_utc",
      )
        .bind(deviceId)
        .all<{ hour_utc: number }>();
      return results.map((row) => row.hour_utc);
    };
    expect(await hours()).toStrictEqual([H0 + 3]);
    expect(await stored(deviceId)).toStrictEqual(["a:150"]);
    expect(await count("hc_rollup_hour", deviceId)).toBe(1);
    expect(await count("hc_record_index", deviceId)).toBe(1);

    // An older copy naming yet another hour does not drag it back.
    await enqueue(repos, deviceId, {
      batchId: "batch-0003",
      upserts: [steps("a", T + 6 * HOUR_MS, 175, { lastModified: 2500 })],
    });
    await drain(ctx, deviceId);

    expect(await hours()).toStrictEqual([H0 + 3]);
    expect(await logRow(deviceId, "batch-0003")).toMatchObject({ applied: 0, superseded: 1 });

    // A delete finds it where it now is.
    await enqueue(repos, deviceId, { batchId: "batch-0004", deletes: ["a"] });
    await drain(ctx, deviceId);
    expect(await hours()).toStrictEqual([]);
  });

  it("keeps each origin app's records in a chunk of their own", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        steps("w1", T, 100),
        steps("w2", T + MINUTE_MS, 50),
        steps("p1", T + 2 * MINUTE_MS, 70, { origin: PHONE }),
      ],
    });

    await drain(ctx, deviceId);

    expect(await count("hc_chunks", deviceId)).toBe(2);
    const window = { deviceId, type: "Steps", startMs: T, endMs: T + HOUR_MS };
    const fromPhone = await readRecords(ctx, { ...window, origins: [PHONE] });
    expect(fromPhone.map((record) => record.id)).toStrictEqual(["p1"]);

    const origins = await listOrigins(ctx, deviceId, "Steps");
    expect(origins.map((origin) => origin.origin)).toStrictEqual([PHONE, WEARABLE]);

    const rollups = await readHourRollups(ctx, window);
    const sums = Object.fromEntries(
      rollups.map((row) => [
        row.origin,
        [row.hourUtc, row.rollup.records, row.rollup.fields.count?.sum],
      ]),
    );
    expect(sums).toStrictEqual({ [PHONE]: [H0, 1, 70], [WEARABLE]: [H0, 2, 150] });
    const onlyWearable = await readHourRollups(ctx, { ...window, origins: [WEARABLE] });
    expect(onlyWearable).toHaveLength(1);
  });

  it("applies a body that had to be queued in several parts", async () => {
    const deviceId = await seedDevice(repos);
    // Random text does not compress, so this body is over one queue row.
    const records = Array.from({ length: 48 }, (_, index) =>
      steps(`big-${String(index)}`, T + index * HOUR_MS, index, {
        data: { count: index, notes: noise() },
      }),
    );
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: records });
    const parts = await env.DB.prepare(
      "SELECT max(parts) AS parts FROM hc_ingest_queue WHERE device_id = ?",
    )
      .bind(deviceId)
      .first<{ parts: number }>();
    expect(parts?.parts).toBeGreaterThan(1);

    await drain(ctx, deviceId);

    expect(await count("hc_ingest_queue", deviceId)).toBe(0);
    const read = await readRecords(ctx, {
      deviceId,
      type: "Steps",
      startMs: T,
      endMs: T + 48 * HOUR_MS,
    });
    expect(read).toStrictEqual(records);
  });

  it("works through a batch of many hours over several slices", async () => {
    const deviceId = await seedDevice(repos);
    const records = Array.from({ length: 60 }, (_, index) =>
      steps(`s-${String(index)}`, T + index * HOUR_MS, 10 + index),
    );
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: records, deletes: ["x"] });
    const budget = { maxQueries: 40, maxMs: 20_000 };

    const first = await runHcSlice(ctx, deviceId, EMPTY_RUNNER_STATE, budget);

    expect(first.more).toBe(true);
    expect(first.progressed).toBe(true);
    expect(first.state.cursor).toMatchObject({ batchId: "batch-0001", phase: "upserts" });
    const done = first.state.cursor?.offset ?? 0;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(60);
    // What the slice finished is durable; the batch is still queued.
    expect(await count("hc_chunks", deviceId)).toBe(done);
    expect(await logRow(deviceId, "batch-0001")).toMatchObject({ status: "applying" });

    const rest = await drain(ctx, deviceId, { budget, state: first.state });

    expect(rest.slices).toBeGreaterThan(3);
    expect(await count("hc_chunks", deviceId)).toBe(60);
    expect(await count("hc_ingest_queue", deviceId)).toBe(0);
    expect(await logRow(deviceId, "batch-0001")).toMatchObject({ status: "applied", applied: 60 });
    expect(await storeBacklog(ctx, deviceId)).toStrictEqual({
      queuedBatches: 0,
      parkedBatches: 0,
      dirty: 0,
      parkedMarks: 0,
      rezonePending: false,
    });
  });

  it("reaches the same store when the cursor is lost between slices", async () => {
    const deviceId = await seedDevice(repos);
    const records = Array.from({ length: 30 }, (_, index) =>
      steps(`s-${String(index)}`, T + index * HOUR_MS, 10 + index),
    );
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: records });
    const budget = { maxQueries: 40, maxMs: 20_000 };
    const first = await runHcSlice(ctx, deviceId, EMPTY_RUNNER_STATE, budget);
    const second = await runHcSlice(ctx, deviceId, first.state, budget);
    expect(second.state.cursor?.offset).toBeGreaterThan(first.state.cursor?.offset ?? 0);

    // The rest starts from nothing, as a runner that lost its storage would:
    // the batch is replayed from its start over what is already stored.
    await drain(ctx, deviceId, { budget });

    const read = await readRecords(ctx, {
      deviceId,
      type: "Steps",
      startMs: T,
      endMs: T + 30 * HOUR_MS,
    });
    expect(read).toStrictEqual(records);
    expect(await count("hc_record_index", deviceId)).toBe(30);
    expect(await logRow(deviceId, "batch-0001")).toMatchObject({ status: "applied", applied: 30 });
    const sync = await syncRows(deviceId);
    expect(sync.Steps?.record_count).toBe(30);
  });

  it("applies a device's batches in the order they arrived", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 100)] });
    await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["a"] });
    await enqueue(repos, deviceId, { batchId: "batch-0003", upserts: [steps("b", T, 200)] });

    await drain(ctx, deviceId);

    expect(await stored(deviceId)).toStrictEqual(["b:200"]);
  });
});

/** The rows a device has in `hc_chunks`: chunks, and their continuations. */
async function rows(
  deviceId: string,
): Promise<{ origin_hash: string; part: number; record_count: number }[]> {
  const { results } = await env.DB.prepare(
    "SELECT origin_hash, part, record_count FROM hc_chunks WHERE device_id = ? ORDER BY origin_hash, part",
  )
    .bind(deviceId)
    .all<{ origin_hash: string; part: number; record_count: number }>();
  return results;
}

describe("a chunk larger than one row", () => {
  /** Sixty records in ONE hour, each carrying text that will not compress. */
  const heavy = (): HcRecord[] =>
    Array.from({ length: 60 }, (_, index) =>
      steps(`heavy-${String(index).padStart(2, "0")}`, T + index * MINUTE_MS, index, {
        data: { count: index, notes: noise() },
      }),
    );
  const window = { type: "Steps", startMs: T, endMs: T + HOUR_MS };

  it("is stored across continuation rows and read back whole", async () => {
    const deviceId = await seedDevice(repos);
    const records = heavy();
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: records });

    await drain(ctx, deviceId);

    expect(await logRow(deviceId, "batch-0001")).toMatchObject({ status: "applied", applied: 60 });
    const stored = await rows(deviceId);
    expect(stored.length).toBeGreaterThan(1);
    const [base, ...continuations] = stored;
    expect(base?.record_count).toBe(60);
    // The same plain blind on every row; the part number is its own column.
    expect(stored.map((row) => row.part)).toStrictEqual(stored.map((_, index) => index));
    expect(new Set(stored.map((row) => row.origin_hash)).size).toBe(1);
    expect(base?.origin_hash).toMatch(/^~[\w-]{22}$/u);
    expect(continuations.every((row) => row.record_count === 0)).toBe(true);

    expect(await readRecords(ctx, { deviceId, ...window })).toStrictEqual(records);
    const filtered = await readRecords(ctx, { deviceId, ...window, origins: [WEARABLE] });
    expect(filtered).toHaveLength(60);
    expect(await readRecords(ctx, { deviceId, ...window, origins: [PHONE] })).toStrictEqual([]);
    // A continuation is not an origin, a second chunk, or more records.
    const origins = await listOrigins(ctx, deviceId, "Steps");
    expect(origins.map((origin) => origin.origin)).toStrictEqual([WEARABLE]);
    const rollups = await readHourRollups(ctx, { deviceId, ...window });
    expect(rollups.map((row) => row.rollup.records)).toStrictEqual([60]);
    const sync = await syncRows(deviceId);
    expect(sync.Steps?.record_count).toBe(60);
    expect(await count("hc_record_index", deviceId)).toBe(60);
  });

  it("is not rewritten on a replay, and shrinks back to one row, then to none", async () => {
    const deviceId = await seedDevice(repos);
    const records = heavy();
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: records });
    await drain(ctx, deviceId);
    const written = await maxUpdatedAt(deviceId);

    time.advance(600);
    await enqueue(repos, deviceId, { batchId: "batch-0002", upserts: records });
    await drain(ctx, deviceId);
    expect(await maxUpdatedAt(deviceId)).toBe(written);

    // A record that arrives later joins the split chunk.
    const extra = steps("extra", T + 59 * MINUTE_MS + 1000, 7);
    await enqueue(repos, deviceId, { batchId: "batch-0003", upserts: [extra] });
    await drain(ctx, deviceId);
    expect(await readRecords(ctx, { deviceId, ...window })).toStrictEqual([...records, extra]);

    const most = records.slice(5).map((record) => record.id);
    await enqueue(repos, deviceId, { batchId: "batch-0004", deletes: most });
    await drain(ctx, deviceId);

    const shrunk = await rows(deviceId);
    expect(shrunk).toHaveLength(1);
    expect(shrunk[0]?.record_count).toBe(6);
    expect(await readRecords(ctx, { deviceId, ...window })).toStrictEqual([
      ...records.slice(0, 5),
      extra,
    ]);

    const rest = [...records.slice(0, 5).map((record) => record.id), "extra"];
    await enqueue(repos, deviceId, { batchId: "batch-0005", deletes: rest });
    await drain(ctx, deviceId);
    expect(await rows(deviceId)).toStrictEqual([]);
    const sync = await syncRows(deviceId);
    expect(sync.Steps?.record_count).toBe(0);
  });

  it("goes whole when emptied from several rows at once", async () => {
    const deviceId = await seedDevice(repos);
    const records = heavy();
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: records });
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      deletes: records.map((record) => record.id),
    });

    await drain(ctx, deviceId);

    expect(await rows(deviceId)).toStrictEqual([]);
    expect(await count("hc_rollup_hour", deviceId)).toBe(0);
  });
});

describe("sync state", () => {
  it("keeps counts and instants per type, and the phone's own report", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        steps("a", T, 100),
        steps("b", T + 2 * HOUR_MS, 200),
        steps("c", T + 4 * HOUR_MS, 300),
      ],
      syncState: {
        types: [
          {
            type: "Steps",
            permission: "granted",
            tokenAgeS: 120,
            backlog: 7,
            backfill: { complete: false, oldestDoneMs: T - HOUR_MS },
          },
          { type: "BloodGlucose", permission: "denied" },
        ],
      },
    });
    const at = time.now();
    await drain(ctx, deviceId);

    const first = await syncRows(deviceId);
    expect(first.Steps).toMatchObject({
      permission_state: "granted",
      record_count: 3,
      first_ms: T,
      last_ms: T + 4 * HOUR_MS + MINUTE_MS,
      last_upload_at: at,
      token_age_s: 120,
      backlog: 7,
      backfill_complete: 0,
      backfill_oldest_ms: T - HOUR_MS,
    });
    // Reported, never uploaded: a row that says so.
    expect(first.BloodGlucose).toMatchObject({
      permission_state: "denied",
      record_count: 0,
      first_ms: null,
    });

    time.advance(60);
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      deletes: ["c"],
      syncState: {
        types: [
          {
            type: "Steps",
            permission: "granted",
            tokenAgeS: 5,
            backlog: 0,
            backfill: { complete: true },
          },
        ],
      },
    });
    await drain(ctx, deviceId);

    const second = await syncRows(deviceId);
    expect(second.Steps).toMatchObject({
      record_count: 2,
      first_ms: T,
      last_ms: T + 2 * HOUR_MS + MINUTE_MS,
      last_upload_at: at + 60,
      token_age_s: 5,
      backlog: 0,
      backfill_complete: 1,
    });
    // Not mentioned by the second batch: left as it was.
    expect(second.BloodGlucose?.permission_state).toBe("denied");
  });
});

describe("a batch that can never be applied", () => {
  it("is marked failed and removed, and does not hold up the next one", async () => {
    const deviceId = await seedDevice(repos);
    await repos.hcIngestQueue.enqueue({
      deviceId,
      batchId: "batch-junk",
      body: new TextEncoder().encode("this is not gzip") as Uint8Array<ArrayBuffer>,
      rawBytes: 16,
      upserts: 1,
      deletes: 0,
      rejected: 0,
      phoneTime: T,
    });
    await enqueue(repos, deviceId, { batchId: "batch-0002", upserts: [steps("a", T, 100)] });

    await drain(ctx, deviceId);

    expect(await logRow(deviceId, "batch-junk")).toMatchObject({
      status: "failed",
      error_code: "batch_unreadable",
    });
    // Set aside with its body, not deleted: it is the only copy of what it held.
    expect(await count("hc_ingest_queue", deviceId)).toBe(1);
    expect(await repos.hcIngestQueue.parked(deviceId)).toMatchObject({ batches: 1 });
    expect(await storeBacklog(ctx, deviceId)).toMatchObject({ queuedBatches: 0, parkedBatches: 1 });
    expect(await stored(deviceId)).toStrictEqual(["a:100"]);
  });

  it("fails a batch sealed under another key rather than retrying it for ever", async () => {
    const deviceId = await seedDevice(repos);
    const foreign = makeRepos(testCtx({ dataKey: OTHER_DATA_KEY }));
    await enqueue(foreign, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 100)] });

    await drain(ctx, deviceId);

    expect(await logRow(deviceId, "batch-0001")).toMatchObject({
      status: "failed",
      error_code: "crypto",
    });
    expect(await repos.hcIngestQueue.parked(deviceId)).toMatchObject({ batches: 1 });
    expect(await count("hc_chunks", deviceId)).toBe(0);
  });

  it("fails a batch that names another device", async () => {
    const deviceId = await seedDevice(repos);
    const other = await seedDevice(repos, "Other phone");
    // Queued under one device, but the body says it is the other's.
    const json = JSON.stringify({
      v: 1,
      deviceId: other,
      appVersion: "0.0.1",
      batchId: "batch-0001",
      phoneTime: T,
      upserts: [steps("a", T, 100)],
      deletes: [],
    });
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    await repos.hcIngestQueue.enqueue({
      deviceId,
      batchId: "batch-0001",
      body: new Uint8Array(await new Response(stream).arrayBuffer()),
      rawBytes: json.length,
      upserts: 1,
      deletes: 0,
      rejected: 0,
      phoneTime: T,
    });

    await drain(ctx, deviceId);

    expect(await logRow(deviceId, "batch-0001")).toMatchObject({
      status: "failed",
      error_code: "batch_mismatch",
    });
    expect(await count("hc_chunks", other)).toBe(0);
  });
});

describe("heart rate at one-minute resolution", () => {
  it("files each sample under its own hour, however long the series runs", async () => {
    const deviceId = await seedDevice(repos);
    // Starts at :58 and runs three minutes into the next hour.
    const series = heartRate("hr-1", T + 58 * MINUTE_MS, [
      [30_000, 60],
      [90_000, 62],
      [210_000, 64],
      [270_000, 66],
    ]);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [series] });
    await drain(ctx, deviceId);

    const minutes = async (): Promise<Record<number, number[]>> => {
      const rows = await readHrMinutes(ctx, { deviceId, startMs: T, endMs: T + 2 * HOUR_MS });
      expect(rows.every((row) => row.origin === WEARABLE)).toBe(true);
      return Object.fromEntries(
        rows.map((row) => [row.hourUtc, row.minutes.map((minute) => minute.m)]),
      );
    };
    expect(await minutes()).toStrictEqual({ [H0]: [58, 59], [H0 + 1]: [1, 2] });

    // A record of the next hour's own: its row keeps the spilled samples.
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [heartRate("hr-2", T + HOUR_MS + 10 * MINUTE_MS, [[30_000, 70]])],
    });
    await drain(ctx, deviceId);
    expect(await minutes()).toStrictEqual({ [H0]: [58, 59], [H0 + 1]: [1, 2, 10] });

    // Deleting the long series takes its samples out of both hours.
    await enqueue(repos, deviceId, { batchId: "batch-0003", deletes: ["hr-1"] });
    await drain(ctx, deviceId);
    expect(await minutes()).toStrictEqual({ [H0 + 1]: [10] });
  });

  it("keeps the far end of a series that runs for more than a day", async () => {
    const deviceId = await seedDevice(repos);
    const series = heartRate("hr-long", T, [
      [30_000, 60],
      [25 * HOUR_MS + 30_000, 61],
      [30 * HOUR_MS + 90_000, 62],
    ]);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [series] });
    await drain(ctx, deviceId);

    const minutes = async (): Promise<Record<number, number[]>> => {
      const rows = await readHrMinutes(ctx, { deviceId, startMs: T, endMs: T + 31 * HOUR_MS });
      return Object.fromEntries(
        rows.map((row) => [row.hourUtc, row.minutes.map((minute) => minute.m)]),
      );
    };
    expect(await minutes()).toStrictEqual({ [H0]: [0], [H0 + 25]: [0], [H0 + 30]: [1] });

    // Thirty hours on, a chunk of that hour's own still finds the old series.
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [heartRate("hr-own", T + 30 * HOUR_MS + 10 * MINUTE_MS, [[30_000, 70]])],
    });
    await drain(ctx, deviceId);
    expect(await minutes()).toStrictEqual({ [H0]: [0], [H0 + 25]: [0], [H0 + 30]: [1, 10] });
  });
});

describe("heart-rate samples timed outside their record", () => {
  it("stay in the stored record, are left out of the minute rows, and are counted", async () => {
    const deviceId = await seedDevice(repos);
    const logged = recordingLog();
    const loud = testCtx({ now: time.now, log: logged.log });
    // A two-minute series with one sample claiming an instant five hours on.
    const series = heartRate("hr-odd", T, [
      [30_000, 60],
      [90_000, 61],
    ]);
    series.data = {
      samples: [...(series.data.samples as unknown[]), { t: T + 5 * HOUR_MS, bpm: 200 }],
    };
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [series] });

    await drain(loud, deviceId);

    const rows = await readHrMinutes(ctx, { deviceId, startMs: T, endMs: T + 6 * HOUR_MS });
    expect(rows.map((row) => [row.hourUtc, row.minutes.map((minute) => minute.m)])).toStrictEqual([
      [H0, [0, 1]],
    ]);
    // Lossless: the raw record still has all three.
    const [raw] = await readRecords(ctx, {
      deviceId,
      type: "HeartRate",
      startMs: T,
      endMs: T + HOUR_MS,
    });
    expect(raw?.data.samples).toHaveLength(3);
    const applied = logged.lines.find((line) => line.includes("hc.batch_applied"));
    expect(applied).toContain('"outOfInterval":1');
  });
});

describe("dirty marks", () => {
  it("are written a page at a time, however many one record touched", async () => {
    const deviceId = await seedDevice(repos);
    const marks = Array.from(
      { length: 7 },
      (_, index) => ["hr", `~origin|${String(index)}`] as const,
    );

    const statements = markStatements(ctx, deviceId, marks, 3);

    expect(statements).toHaveLength(3);
    await env.DB.batch(statements);
    expect(await count("hc_dirty", deviceId)).toBe(7);
    expect(markStatements(ctx, deviceId, [])).toStrictEqual([]);
  });
});

describe("the parsed head batch", () => {
  it("is reused by the next slice from the caller's cache, not read again", async () => {
    const deviceId = await seedDevice(repos);
    const records = Array.from({ length: 20 }, (_, index) =>
      steps(`s-${String(index)}`, T + index * HOUR_MS, 10 + index),
    );
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: records });
    const budget = { maxQueries: 40, maxMs: 20_000 };
    const cache = { head: null };

    const first = await runHcSlice(ctx, deviceId, EMPTY_RUNNER_STATE, budget, cache);
    expect(first.more).toBe(true);
    expect(cache.head).not.toBeNull();
    // Make the queued body unreadable. A slice that read it again would close
    // the batch as failed; one that uses the cache never notices.
    await env.DB.prepare("UPDATE hc_ingest_queue SET body_enc = 'v3:AAAA' WHERE device_id = ?")
      .bind(deviceId)
      .run();

    let state = first.state;
    for (let slice = 0; slice < 100; slice += 1) {
      const result = await runHcSlice(ctx, deviceId, state, budget, cache);
      state = result.state;
      if (!result.more) break;
    }

    expect(await logRow(deviceId, "batch-0001")).toMatchObject({ status: "applied", applied: 20 });
    // Dropped once the batch has left the queue.
    expect(cache.head).toBeNull();
  });
});

/** Start, and fail, as many slices on the head batch as it is allowed. */
async function exhaustAttempts(deviceId: string): Promise<void> {
  let head = NO_HEAD_FAILURES;
  for (let attempt = 1; attempt <= MAX_BATCH_FAILURES; attempt += 1) {
    const begun = await beginAttempt(ctx, deviceId, head);
    expect(begun.gaveUp).toBe(false);
    ({ head } = begun);
    await expect(runHcSlice(ctx, deviceId)).rejects.toThrow();
  }
  // One more would be an attempt too many: it is given up on instead.
  const last = await beginAttempt(ctx, deviceId, head);
  expect(last).toStrictEqual({ head: NO_HEAD_FAILURES, gaveUp: true });
}

async function failInserts(when: string): Promise<void> {
  await env.DB.prepare(
    `CREATE TRIGGER synthetic_failure BEFORE INSERT ON hc_chunks
       WHEN ${when}
       BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`,
  ).run();
}

async function stopFailing(): Promise<void> {
  await env.DB.prepare("DROP TRIGGER IF EXISTS synthetic_failure").run();
}

describe("a batch that keeps making slices fail", () => {
  it("is tried a bounded number of times, then parked so the next batch is applied", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 100)] });
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [steps("b", T + HOUR_MS, 200)],
    });
    // A failure the apply code has no name for: only the first batch's hour trips it.
    await failInserts(`NEW.hour_utc = ${String(H0)}`);
    try {
      await exhaustAttempts(deviceId);

      expect(await logRow(deviceId, "batch-0001")).toMatchObject({
        status: "failed",
        error_code: "apply_gave_up",
      });
      await drain(ctx, deviceId);

      expect(await logRow(deviceId, "batch-0002")).toMatchObject({ status: "applied", applied: 1 });
      expect(await stored(deviceId)).toStrictEqual(["b:200"]);
      // Parked, not deleted, and no longer in anything's way.
      expect(await storeBacklog(ctx, deviceId)).toMatchObject({
        queuedBatches: 0,
        parkedBatches: 1,
      });
    } finally {
      await stopFailing();
    }

    // The cause is gone: queued again, it is applied and its records appear.
    expect(await repos.hcIngestQueue.unpark(deviceId)).toBe(1);
    // It starts with a clean count: all its attempts again.
    const again = await beginAttempt(ctx, deviceId, NO_HEAD_FAILURES);
    expect(again.head).toStrictEqual({ batchId: "batch-0001", failures: 1 });
    await drain(ctx, deviceId);

    expect(await logRow(deviceId, "batch-0001")).toMatchObject({
      status: "applied",
      error_code: null,
      applied: 1,
    });
    expect(await stored(deviceId)).toStrictEqual(["a:100", "b:200"]);
    expect(await count("hc_ingest_queue", deviceId)).toBe(0);
  });

  it("is counted before each slice starts, so a slice that never returns counts too", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 100)] });

    // No slice is run at all between these: as if each invocation had been killed.
    let head = NO_HEAD_FAILURES;
    for (let attempt = 1; attempt <= MAX_BATCH_FAILURES; attempt += 1) {
      const begun = await beginAttempt(ctx, deviceId, head);
      expect(begun).toStrictEqual({
        head: { batchId: "batch-0001", failures: attempt },
        gaveUp: false,
      });
      ({ head } = begun);
    }
    const last = await beginAttempt(ctx, deviceId, head);

    expect(last.gaveUp).toBe(true);
    expect(await logRow(deviceId, "batch-0001")).toMatchObject({
      status: "failed",
      error_code: "apply_gave_up",
    });
    expect(await repos.hcIngestQueue.parked(deviceId)).toMatchObject({ batches: 1 });
  });

  it("counts against what is at the head, and starts again for anything else", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 100)] });

    const once = await beginAttempt(ctx, deviceId, NO_HEAD_FAILURES);
    const twice = await beginAttempt(ctx, deviceId, once.head);
    const other = await beginAttempt(ctx, deviceId, { batchId: "batch-9999", failures: 7 });

    expect(once.head).toStrictEqual({ batchId: "batch-0001", failures: 1 });
    expect(twice.head).toStrictEqual({ batchId: "batch-0001", failures: 2 });
    expect(other).toStrictEqual({ head: { batchId: "batch-0001", failures: 1 }, gaveUp: false });
    // Nothing queued: the work is the rebuild, and it has its own count.
    await drain(ctx, deviceId);
    const idle = await beginAttempt(ctx, deviceId, twice.head);
    expect(idle).toStrictEqual({ head: { batchId: null, failures: 1 }, gaveUp: false });
  });

  it("when applied late, neither overwrites a newer copy nor revives a deleted id", async () => {
    const deviceId = await seedDevice(repos);
    // The old batch: two records in one hour. Only a chunk of two trips the trigger.
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [
        steps("x", T, 1, { lastModified: 1000 }),
        steps("y", T + MINUTE_MS, 2, { lastModified: 1000 }),
      ],
    });
    // What the phone sent afterwards: a newer copy of one, the deletion of the other.
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [steps("x", T, 9, { lastModified: 2000 })],
      deletes: ["y"],
    });
    await failInserts("NEW.record_count = 2");
    try {
      await exhaustAttempts(deviceId);
      await drain(ctx, deviceId);
    } finally {
      await stopFailing();
    }
    expect(await stored(deviceId)).toStrictEqual(["x:9"]);

    await repos.hcIngestQueue.unpark(deviceId);
    await drain(ctx, deviceId);

    expect(await logRow(deviceId, "batch-0001")).toMatchObject({
      status: "applied",
      applied: 0,
      superseded: 2,
    });
    expect(await stored(deviceId)).toStrictEqual(["x:9"]);
  });
});

describe("a record that moves to another chunk", () => {
  it("stays where it was when the write of where it is going fails", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [steps("a", T, 100, { lastModified: 2000 })],
    });
    await drain(ctx, deviceId);
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [steps("a", T + 3 * HOUR_MS, 150, { lastModified: 3000 })],
    });
    await failInserts(`NEW.hour_utc = ${String(H0 + 3)}`);
    try {
      await expect(runHcSlice(ctx, deviceId)).rejects.toThrow();

      // Leaving the old chunk and arriving in the new one are one transaction:
      // with the arrival refused, the record has not left.
      expect(await stored(deviceId)).toStrictEqual(["a:100"]);
      const { results } = await env.DB.prepare(
        "SELECT hour_utc FROM hc_record_index WHERE device_id = ?",
      )
        .bind(deviceId)
        .all<{ hour_utc: number }>();
      expect(results.map((row) => row.hour_utc)).toStrictEqual([H0]);
    } finally {
      await stopFailing();
    }

    await drain(ctx, deviceId);
    expect(await stored(deviceId)).toStrictEqual(["a:150"]);
    expect(await count("hc_chunks", deviceId)).toBe(1);
  });

  // A page's chunks are read together, before any of them is written. These
  // two batches make one group's write change a chunk another group of the
  // same page was shown: what was read ahead must not be used after that.
  it("leaves a chunk that the same batch has just written another record to", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [steps("a", T, 100), steps("b", T + HOUR_MS, 200)],
    });
    await drain(ctx, deviceId);
    // The first hour gains `c`, then the second hour takes `a` out of it.
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [
        steps("c", T + MINUTE_MS, 300),
        steps("a", T + HOUR_MS + MINUTE_MS, 150, { lastModified: 3000 }),
      ],
    });

    await drain(ctx, deviceId);

    expect(await stored(deviceId)).toStrictEqual(["c:300", "b:200", "a:150"]);
    expect(await count("hc_record_index", deviceId)).toBe(3);
    const sync = await syncRows(deviceId);
    expect(sync.Steps?.record_count).toBe(3);
  });

  it("is gone from the chunk it left when the same batch then writes to that chunk", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [steps("a", T + HOUR_MS, 100), steps("b", T + HOUR_MS + MINUTE_MS, 200)],
    });
    await drain(ctx, deviceId);
    // The first hour takes `a` out of the second, then the second gains `d`.
    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [
        steps("a", T, 150, { lastModified: 3000 }),
        steps("d", T + HOUR_MS + 2 * MINUTE_MS, 400),
      ],
    });

    await drain(ctx, deviceId);

    expect(await stored(deviceId)).toStrictEqual(["a:150", "b:200", "d:400"]);
    expect(await count("hc_record_index", deviceId)).toBe(3);
    const sync = await syncRows(deviceId);
    expect(sync.Steps?.record_count).toBe(3);
  });
});

describe("sync state after a slice that died", () => {
  it("is still recounted for a type that only lost records", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [steps("a", T, 1), steps("b", T + HOUR_MS, 2), steps("c", T + 2 * HOUR_MS, 3)],
    });
    await drain(ctx, deviceId);
    await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["c"] });
    // The delete commits; the bookkeeping that closes the batch does not.
    await env.DB.prepare(
      `CREATE TRIGGER synthetic_failure BEFORE INSERT ON hc_sync_state
         BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`,
    ).run();
    try {
      await expect(runHcSlice(ctx, deviceId)).rejects.toThrow();
    } finally {
      await stopFailing();
    }
    expect(await stored(deviceId)).toStrictEqual(["a:1", "b:2"]);
    const stale = await syncRows(deviceId);
    expect(stale.Steps?.record_count).toBe(3);

    // The next slice knows nothing of the last one, and sees only a tombstone.
    await drain(ctx, deviceId);

    const sync = await syncRows(deviceId);
    expect(sync.Steps).toMatchObject({ record_count: 2, last_ms: T + HOUR_MS + MINUTE_MS });
  });
});

describe("the ingest log", () => {
  it("loses applied rows older than thirty days, and keeps failed ones", async () => {
    const deviceId = await seedDevice(repos);
    const old = time.now() - 31 * 86_400;
    const insert = (batchId: string, status: string, receivedAt: number): D1PreparedStatement =>
      env.DB.prepare(
        "INSERT INTO hc_ingest_log (device_id, batch_id, received_at, status, body_digest) VALUES (?, ?, ?, ?, '~synthetic')",
      ).bind(deviceId, batchId, receivedAt, status);
    await env.DB.batch([
      insert("old-applied", "applied", old),
      insert("old-failed", "failed", old),
      insert("new-applied", "applied", time.now() - 86_400),
    ]);

    await drain(ctx, deviceId);

    const { results } = await env.DB.prepare(
      "SELECT batch_id FROM hc_ingest_log WHERE device_id = ? ORDER BY batch_id",
    )
      .bind(deviceId)
      .all<{ batch_id: string }>();
    expect(results.map((row) => row.batch_id)).toStrictEqual(["new-applied", "old-failed"]);
  });
});

describe("closing a batch", () => {
  it("records it applied and takes it out of the queue in one transaction, or does neither", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 100)] });
    // The queued body may not go: so the log must not say the batch is applied.
    await env.DB.prepare(
      `CREATE TRIGGER synthetic_failure BEFORE DELETE ON hc_ingest_queue
         BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`,
    ).run();
    try {
      await expect(runHcSlice(ctx, deviceId)).rejects.toThrow();
    } finally {
      await stopFailing();
    }

    // Its records are stored, it is still queued, and the log has not closed it.
    expect(await stored(deviceId)).toStrictEqual(["a:100"]);
    expect(await count("hc_ingest_queue", deviceId)).toBe(1);
    expect(await logRow(deviceId, "batch-0001")).toMatchObject({
      status: "applying",
      applied: 0,
      applied_at: null,
    });

    await drain(ctx, deviceId);

    expect(await count("hc_ingest_queue", deviceId)).toBe(0);
    expect(await logRow(deviceId, "batch-0001")).toMatchObject({ status: "applied", applied: 1 });
  });
});

describe("what a slice asks of D1", () => {
  it("is measured and logged, and a small batch is a handful of round trips", async () => {
    const logged = recordingLog();
    const loud = testCtx({ now: time.now, log: logged.log });
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [steps("a", T, 100), steps("b", T + 5 * MINUTE_MS, 120), steps("c", T + HOUR_MS, 3)],
    });

    const result = await runHcSlice(loud, deviceId);

    expect(result.more).toBe(false);
    const line = logged.lines.find((entry) => entry.includes('"hc.slice"'));
    const slice = JSON.parse(line ?? "{}") as Record<string, number>;
    expect(slice).toMatchObject({ batches: 1, queuedBatches: 0 });
    // The batch (head, index, chunks, one commit, one closing transaction), its
    // day rollup, and the checks that end an idle slice. A bound, so that a
    // round trip added per batch or per chunk is noticed here.
    expect(slice.roundTrips).toBeGreaterThan(5);
    expect(slice.roundTrips).toBeLessThanOrEqual(16);
    expect(slice.executed).toBeGreaterThanOrEqual(slice.roundTrips ?? 0);
    expect(slice.rowsWritten).toBeGreaterThan(5);
    expect(slice.rowsRead).toBeGreaterThan(0);
    expect(slice.d1Ms).toBeGreaterThanOrEqual(0);
    expect(slice.sqlMs).toBeGreaterThanOrEqual(0);
    expect(slice.rebuildMs).toBeGreaterThanOrEqual(0);
    // No earlier slice in this cache: nothing to say about the wait between two.
    expect(slice.idleMs).toBeUndefined();
  });

  it("says how long the runner sat between two slices of one instance", async () => {
    const logged = recordingLog();
    const loud = testCtx({ now: time.now, log: logged.log });
    const deviceId = await seedDevice(repos);
    const cache = { head: null };

    await runHcSlice(loud, deviceId, EMPTY_RUNNER_STATE, undefined, cache);
    await runHcSlice(loud, deviceId, EMPTY_RUNNER_STATE, undefined, cache);

    const slices = logged.lines
      .filter((entry) => entry.includes('"hc.slice"'))
      .map((entry) => JSON.parse(entry) as Record<string, number>);
    expect(slices).toHaveLength(2);
    expect(slices[0]?.idleMs).toBeUndefined();
    expect(slices[1]?.idleMs).toBeGreaterThanOrEqual(0);
  });
});
