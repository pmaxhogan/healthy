// Query plans of the store's hot statements.
//
// Each of these runs once per chunk, per record page or per mark, against
// tables that hold a lifetime of data. A plan that walks a table instead of
// seeking into it is invisible on a test-sized store and quadratic on a real
// one, so the plans themselves are asserted here -- with `EXPLAIN QUERY PLAN`
// on the very SQL the code runs -- and the rows actually read are checked on a
// small store, where a wrong plan already reads every row there is.
//
// Every record is synthetic: see helpers.ts.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { makeRepos } from "../../../src/db/index.ts";
import { HEAD_SQL } from "../../../src/db/repos/hc-ingest-queue.ts";
import { HR_SPILL_SQL, READ_CHUNKS_SQL } from "../../../src/hc/store/chunks.ts";
import {
  DIRTY_BACKLOG_SQL,
  dirtyBacklog,
  markSessionsSql,
  nextDirtySql,
} from "../../../src/hc/store/dirty.ts";
import { HOUR_MS } from "../../../src/hc/store/keys.ts";
import { SPILL_SCAN, WINDOW_SCAN, chunkScanSql, readRecords } from "../../../src/hc/store/read.ts";
import { PRUNE_DAY_SQL } from "../../../src/hc/store/rebuild.ts";
import { LOOKUP_INDEX_SQL, TOMBSTONE_SQL } from "../../../src/hc/store/record-index.ts";
import { RECOUNT_SQL } from "../../../src/hc/store/sync-state.ts";

import {
  drain,
  enqueue,
  H0,
  heartRate,
  interval,
  MINUTE_MS,
  resetHc,
  seedDevice,
  steps,
  T,
  testCtx,
} from "./helpers.ts";

beforeEach(resetHc);

const ctx = testCtx();
const repos = makeRepos(ctx);

/** Hours of hourly Steps the small store holds. */
const HOURS = 60;

/** The plan of a statement, one line per step. */
async function plan(sql: string, ...values: unknown[]): Promise<string[]> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...values)
    .all<{ detail: string }>();
  return results.map((row) => row.detail);
}

/** How many rows a statement read to give its answer. */
async function rowsRead(sql: string, ...values: unknown[]): Promise<number> {
  const { meta } = await env.DB.prepare(sql)
    .bind(...values)
    .all();
  return meta.rows_read;
}

/** A device with an hour chunk for each of `HOURS` hours, and one chunk that spills. */
async function populated(): Promise<{ deviceId: string; originHash: string }> {
  const deviceId = await seedDevice(repos);
  await enqueue(repos, deviceId, {
    batchId: "batch-0001",
    upserts: [
      ...Array.from({ length: HOURS }, (_, index) =>
        steps(`s-${String(index)}`, T + index * HOUR_MS, 10),
      ),
      // One record, early on, that runs far past its own hour.
      interval("long", "Steps", T + 30 * 60_000, T + 5 * HOUR_MS, { count: 1 }),
    ],
  });
  await drain(ctx, deviceId);
  const row = await env.DB.prepare("SELECT origin_hash FROM hc_chunks WHERE device_id = ? LIMIT 1")
    .bind(deviceId)
    .first<{ origin_hash: string }>();
  return { deviceId, originHash: row?.origin_hash ?? "" };
}

/** Hours, counted from the first, whose chunks run past the end of the hour in `contiguous`. */
const OVERRUNS = new Set([10, 40]);

/**
 * A device as a wearable fills one: `HOURS` hours of heart rate and of an
 * hourly total, nearly every record ending exactly on the hour -- a contiguous
 * series, an hourly aggregate -- and a few (`OVERRUNS`) running a minute past
 * it. On this store an index holding every chunk that so much as touches the
 * next hour holds every chunk there is; the strict one holds the few.
 */
async function contiguous(): Promise<{ deviceId: string; originHash: string }> {
  const deviceId = await seedDevice(repos);
  await enqueue(repos, deviceId, {
    batchId: "batch-0001",
    upserts: Array.from({ length: HOURS }, (_, index) => {
      const hour = T + index * HOUR_MS;
      const end = hour + HOUR_MS + (OVERRUNS.has(index) ? MINUTE_MS : 0);
      return [
        heartRate(`hr-${String(index)}`, hour + 59 * MINUTE_MS, [[0, 60]], { end }),
        interval(`total-${String(index)}`, "Agg.Steps", hour, end, { value: 1 }),
      ];
    }).flat(),
  });
  await drain(ctx, deviceId);
  const row = await env.DB.prepare(
    "SELECT origin_hash FROM hc_chunks WHERE device_id = ? AND record_type = 'HeartRate' LIMIT 1",
  )
    .bind(deviceId)
    .first<{ origin_hash: string }>();
  return { deviceId, originHash: row?.origin_hash ?? "" };
}

/** The hours `HR_SPILL_SQL` returns for an hour, and the rows D1 read to say so. */
async function spillInto(
  deviceId: string,
  originHash: string,
  hour: number,
): Promise<{ hours: number[]; read: number }> {
  const bound = [deviceId, "HeartRate", originHash, hour] as const;
  const { results } = await env.DB.prepare(HR_SPILL_SQL)
    .bind(...bound)
    .all<{ hour_utc: number }>();
  return {
    hours: results.map((row) => row.hour_utc),
    read: await rowsRead(HR_SPILL_SQL, ...bound),
  };
}

describe("reading chunks by key", () => {
  it("seeks each key on the primary key, the key list driving the join", async () => {
    const { deviceId, originHash } = await populated();
    const keys = JSON.stringify([
      ["Steps", originHash, H0 + 7],
      ["Steps", originHash, H0 + 41],
    ]);

    const detail = await plan(READ_CHUNKS_SQL, keys, deviceId);

    // The list first, then one lookup per key -- never the other way round.
    expect(detail[0]).toMatch(/^SCAN k\b/u);
    // Either index is a seek on all four key columns; neither is a walk.
    expect(detail[1]).toMatch(
      /^SEARCH c USING (PRIMARY KEY \(device_id=\? AND record_type=\? AND origin_hash=\? AND hour_utc=\?\)|INDEX hc_chunks_range \(device_id=\? AND record_type=\? AND hour_utc=\? AND origin_hash=\?\))/u,
    );
    // Two keys, two chunks: a handful of rows, not every chunk of the device.
    const n1 = await rowsRead(READ_CHUNKS_SQL, keys, deviceId);
    expect(n1).toBeLessThan(10);
  });
});

describe("the record index", () => {
  it("is looked up and tombstoned by id, not by walking the device's rows", async () => {
    const { deviceId } = await populated();
    const one = await env.DB.prepare(
      "SELECT record_id_blind FROM hc_record_index WHERE device_id = ? LIMIT 1",
    )
      .bind(deviceId)
      .first<{ record_id_blind: string }>();
    const ids = JSON.stringify([one?.record_id_blind ?? "", "~not-in-the-index"]);

    const lookup = await plan(LOOKUP_INDEX_SQL, ids, deviceId);
    const tombstone = await plan(TOMBSTONE_SQL, 0, ids, deviceId);

    for (const detail of [lookup, tombstone]) {
      expect(detail.join("\n")).toMatch(
        /SEARCH hc_record_index USING PRIMARY KEY \(record_id_blind=\?\)/u,
      );
      expect(detail.join("\n")).not.toContain("hc_record_index_device");
    }
    const n2 = await rowsRead(LOOKUP_INDEX_SQL, ids, deviceId);
    expect(n2).toBeLessThan(10);
  });
});

describe("reading a window of records", () => {
  it("finds earlier chunks that run into it through the spill index alone", async () => {
    const { deviceId } = await populated();
    const startHour = H0 + 50;

    const spill = await plan(
      chunkScanSql(SPILL_SCAN),
      deviceId,
      "Steps",
      startHour,
      startHour * HOUR_MS,
      200,
    );
    const window = await plan(
      chunkScanSql(WINDOW_SCAN),
      deviceId,
      "Steps",
      startHour,
      startHour + 1,
      200,
    );

    // The keys come from the index alone; only they are looked up in the table.
    expect(spill.join("\n")).toMatch(/USING COVERING INDEX hc_chunks_spill/u);
    expect(spill.join("\n")).toMatch(
      /SEARCH c USING PRIMARY KEY \(device_id=\? AND record_type=\? AND origin_hash=\? AND hour_utc=\? AND part=\?\)/u,
    );
    expect(window.join("\n")).toMatch(/USING INDEX hc_chunks_range|USING PRIMARY KEY/u);
    // Fifty earlier chunks, one of which runs past its hour (and not as far as
    // this): the spill index holds one row for the type, and that entry is all
    // that is read -- a handful of rows as D1 counts the subquery, none a chunk.
    const read = await rowsRead(
      chunkScanSql(SPILL_SCAN),
      deviceId,
      "Steps",
      startHour,
      startHour * HOUR_MS,
      200,
    );
    expect(read).toBeLessThanOrEqual(4);
  });

  it("still returns the long record to a window it reaches", async () => {
    const { deviceId } = await populated();

    const records = await readRecords(ctx, {
      deviceId,
      type: "Steps",
      startMs: T + 4 * HOUR_MS,
      endMs: T + 4 * HOUR_MS + 60_000,
    });

    expect(records.map((record) => record.id)).toStrictEqual(["long", "s-4"]);
  });

  it("finds heart-rate series reaching an hour by primary key and through the spill index", async () => {
    const { deviceId, originHash } = await populated();

    const detail = await plan(HR_SPILL_SQL, deviceId, "HeartRate", originHash, H0 + 50);
    const text = detail.join("\n");

    // The chunk of the hour before, which may end exactly on the boundary: a
    // seek on the whole key but the part, so every row of it. Either index is
    // that seek; neither is a walk.
    expect(text).toMatch(
      /SEARCH hc_chunks USING (PRIMARY KEY \(device_id=\? AND record_type=\? AND origin_hash=\? AND hour_utc=\?\)|INDEX hc_chunks_range \(device_id=\? AND record_type=\? AND hour_utc=\? AND origin_hash=\?\))/u,
    );
    // The chunks that run past their hour: the index by itself says which,
    // then each is fetched.
    expect(text).toMatch(
      /SEARCH hc_chunks USING COVERING INDEX hc_chunks_spill \(device_id=\? AND record_type=\? AND origin_hash=\? AND max_end_ms>\?\)/u,
    );
    expect(text).toMatch(
      /SEARCH c USING PRIMARY KEY \(device_id=\? AND record_type=\? AND origin_hash=\? AND hour_utc=\? AND part=\?\)/u,
    );
    expect(text).not.toMatch(/SCAN (hc_chunks|c)\b/u);
  });

  /** Rows a spill read may cost on `contiguous`: the two that overrun, the chunk, and D1's own steps. */
  const FEW = 8;

  it("reads a few rows, not one per later chunk, when nearly every chunk ends on the hour", async () => {
    const { deviceId, originHash } = await contiguous();
    const count = await env.DB.prepare(
      `SELECT count(*) AS n FROM hc_chunks INDEXED BY hc_chunks_spill
        WHERE device_id = ? AND max_end_ms > (hour_utc + 1) * 3600000`,
    )
      .bind(deviceId)
      .first<{ n: number }>();
    // A hundred and twenty chunks, every one of which reaches the end of its
    // hour; the index holds the four that run past it.
    expect(count?.n).toBe(2 * OVERRUNS.size);

    // Early on, with fifty-five chunks stored after it: the chunk of the hour
    // before, which ends on the boundary, read by primary key.
    const early = await spillInto(deviceId, originHash, H0 + 5);
    expect(early.hours).toStrictEqual([H0 + 4]);
    expect(early.read).toBeLessThanOrEqual(FEW);
    expect(early.read).toBeLessThan(HOURS / 2);

    // The hour after one that overruns: that chunk through the index, once.
    const after = await spillInto(deviceId, originHash, H0 + 11);
    expect(after.hours).toStrictEqual([H0 + 10]);
    expect(after.read).toBeLessThanOrEqual(FEW);

    // And the hour after that: the overrun stopped a minute in, so only the
    // chunk of the hour before reaches this one.
    const next = await spillInto(deviceId, originHash, H0 + 12);
    expect(next.hours).toStrictEqual([H0 + 11]);
    expect(next.read).toBeLessThanOrEqual(FEW);

    // The first hour there is: nothing before it.
    const first = await spillInto(deviceId, originHash, H0);
    expect(first.hours).toStrictEqual([]);
    expect(first.read).toBeLessThanOrEqual(FEW);
  });

  it("reads a window of an hourly total the same way", async () => {
    const { deviceId } = await contiguous();
    const sql = chunkScanSql(SPILL_SCAN);
    const scan = async (startHour: number): Promise<{ hours: number[]; read: number }> => {
      const bound = [deviceId, "Agg.Steps", startHour, startHour * HOUR_MS, 200] as const;
      const { results } = await env.DB.prepare(sql)
        .bind(...bound)
        .all<{ hour_utc: number }>();
      return { hours: results.map((row) => row.hour_utc), read: await rowsRead(sql, ...bound) };
    };

    // The hour before ends where this window starts: it has nothing in it,
    // and its chunk is not read at all.
    const early = await scan(H0 + 5);
    expect(early.hours).toStrictEqual([]);
    expect(early.read).toBeLessThanOrEqual(FEW);
    // The hour before runs a minute into this window.
    const after = await scan(H0 + 11);
    expect(after.hours).toStrictEqual([H0 + 10]);
    expect(after.read).toBeLessThanOrEqual(FEW);

    const ids = async (startHour: number): Promise<string[]> => {
      const records = await readRecords(ctx, {
        deviceId,
        type: "Agg.Steps",
        startMs: startHour * HOUR_MS,
        endMs: (startHour + 1) * HOUR_MS,
      });
      return records.map((record) => record.id);
    };
    expect(await ids(H0 + 5)).toStrictEqual(["total-5"]);
    expect(await ids(H0 + 11)).toStrictEqual(["total-10", "total-11"]);
  });
});

describe("the dirty list and the sessions a change touches", () => {
  it("are read along an index, without sorting or walking the whole table", async () => {
    const { deviceId } = await populated();

    const next = await plan(nextDirtySql("day"), deviceId, "day", 100);
    const nights = await plan(nextDirtySql("sleep"), deviceId, "sleep", 100);
    const sleep = await plan(markSessionsSql("sleep"), "sleep", 0, deviceId, 0, 1, 0);
    const exercise = await plan(markSessionsSql("exercise"), "exercise", 0, deviceId, 0, 1, 0);

    expect(next.join("\n")).toMatch(
      /SEARCH hc_dirty USING PRIMARY KEY \(device_id=\? AND kind=\?\)/u,
    );
    expect(next.join("\n")).not.toContain("TEMP B-TREE");
    expect(nights.join("\n")).not.toContain("TEMP B-TREE");
    expect(sleep.join("\n")).toMatch(
      /SEARCH hc_sleep_night USING INDEX hc_sleep_night_range \(device_id=\? AND start_ms>\? AND start_ms<\?\)/u,
    );
    expect(exercise.join("\n")).toMatch(
      /SEARCH hc_exercise_session USING INDEX hc_exercise_session_range \(device_id=\? AND start_ms>\? AND start_ms<\?\)/u,
    );
  });

  it("is counted no further than the cap, along the primary key", async () => {
    const { deviceId } = await populated();
    await env.DB.prepare(
      `INSERT INTO hc_dirty (device_id, kind, key, marked_at)
       SELECT ?, 'day', printf('d%06d|Steps', value), 0 FROM json_each(?)`,
    )
      .bind(deviceId, JSON.stringify(Array.from({ length: 300 }, (_, index) => index)))
      .run();
    await env.DB.prepare(
      "INSERT INTO hc_dirty (device_id, kind, key, marked_at) VALUES (?, 'parked:day', 'x', 0)",
    )
      .bind(deviceId)
      .run();

    const detail = await plan(DIRTY_BACKLOG_SQL, deviceId, 50);

    expect(detail.join("\n")).toMatch(
      /SEARCH hc_dirty USING PRIMARY KEY \(device_id=\? AND kind=\?\)/u,
    );
    // Parked marks are not waiting to be rebuilt, and the count stops at the cap.
    expect(await dirtyBacklog(ctx, deviceId, 1000)).toBe(300);
    expect(await dirtyBacklog(ctx, deviceId, 50)).toBe(50);
    expect(await rowsRead(DIRTY_BACKLOG_SQL, deviceId, 50)).toBeLessThanOrEqual(60);
  });
});

describe("rebuilding a day", () => {
  it("prunes that day's rows by the range index, not by walking every day of the type", async () => {
    const { deviceId } = await populated();
    // Three hundred days of rows for the type, beside the handful the store built.
    await env.DB.prepare(
      `INSERT INTO hc_rollup_day (device_id, record_type, origin_hash, day, tz_digest, updated_at, payload_enc)
       SELECT ?, 'Steps', '~gone', printf('2020-%03d', value), 'x', 0, 'x' FROM json_each(?)`,
    )
      .bind(deviceId, JSON.stringify(Array.from({ length: 300 }, (_, index) => index)))
      .run();
    const bound = [deviceId, "Steps", "2020-007", "[]"] as const;

    const detail = await plan(PRUNE_DAY_SQL, ...bound);
    const { meta } = await env.DB.prepare(PRUNE_DAY_SQL)
      .bind(...bound)
      .run();

    expect(detail.join("\n")).toMatch(
      /SEARCH hc_rollup_day USING INDEX hc_rollup_day_range \(device_id=\? AND record_type=\? AND day=\?\)/u,
    );
    // The one row of the one day is found and removed; the other 299 are not read.
    expect(meta.changes).toBe(1);
    expect(meta.rows_read).toBeLessThan(10);
  });
});

describe("recounting a type at the end of a batch", () => {
  it("reads the counts index and never a chunk row", async () => {
    const { deviceId } = await populated();

    const detail = await plan(RECOUNT_SQL, deviceId, JSON.stringify(["Steps"]), 0);

    // Covering: every column the recount needs is in the index, so no chunk
    // row -- and no payload behind one -- is read however many chunks there are.
    expect(detail.join(" / ")).toMatch(
      /USING COVERING INDEX hc_chunks_counts \(device_id=\? AND record_type=\?\)/u,
    );
  });
});

describe("reading the head of the queue", () => {
  it("finds the oldest batch and its rows by index, however long the queue is", async () => {
    const deviceId = await seedDevice(repos);
    for (let index = 0; index < 30; index += 1) {
      await enqueue(repos, deviceId, {
        batchId: `batch-${String(index).padStart(4, "0")}`,
        upserts: [steps(`q-${String(index)}`, T + index * HOUR_MS, 1)],
      });
    }

    const detail = await plan(HEAD_SQL, deviceId, deviceId);

    // The oldest unparked batch off the device index, then its rows by the
    // unique key: never a walk of the queue, whose rows carry the bodies.
    expect(detail.join(" / ")).toMatch(/USING (COVERING )?INDEX hc_ingest_queue_device/u);
    expect(await rowsRead(HEAD_SQL, deviceId, deviceId)).toBeLessThan(10);
    const head = await repos.hcIngestQueue.head(deviceId);
    expect(head?.batchId).toBe("batch-0000");
  });
});
