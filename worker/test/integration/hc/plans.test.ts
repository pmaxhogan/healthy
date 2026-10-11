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
import { HR_SPILL_SQL, READ_CHUNKS_SQL } from "../../../src/hc/store/chunks.ts";
import { markSessionsSql, nextDirtySql } from "../../../src/hc/store/dirty.ts";
import { HOUR_MS } from "../../../src/hc/store/keys.ts";
import { SPILL_SCAN, WINDOW_SCAN, chunkScanSql, readRecords } from "../../../src/hc/store/read.ts";
import { LOOKUP_INDEX_SQL, TOMBSTONE_SQL } from "../../../src/hc/store/record-index.ts";
import { RECOUNT_SQL } from "../../../src/hc/store/sync-state.ts";

import { drain, enqueue, H0, interval, resetHc, seedDevice, steps, T, testCtx } from "./helpers.ts";

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

    expect(spill.join("\n")).toMatch(/USING INDEX hc_chunks_spill/u);
    expect(window.join("\n")).toMatch(/USING INDEX hc_chunks_range|USING PRIMARY KEY/u);
    // Fifty earlier chunks, one of which spills (and not as far as this): the
    // spill index holds one row for the type, and one row is what is read.
    const read = await rowsRead(
      chunkScanSql(SPILL_SCAN),
      deviceId,
      "Steps",
      startHour,
      startHour * HOUR_MS,
      200,
    );
    expect(read).toBeLessThanOrEqual(2);
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

  it("finds heart-rate series running into an hour through the spill index", async () => {
    const { deviceId, originHash } = await populated();

    const detail = await plan(
      HR_SPILL_SQL,
      deviceId,
      "HeartRate",
      originHash,
      H0 + 50,
      (H0 + 50) * HOUR_MS,
    );

    expect(detail.join("\n")).toMatch(/USING INDEX hc_chunks_spill/u);
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
