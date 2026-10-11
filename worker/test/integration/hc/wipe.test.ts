// Wiping a device: every row it has in every Health Connect table, in bounded
// passes, and the device row last. Another device's data is not touched.
//
// Every record is synthetic: see helpers.ts.

import { beforeEach, describe, expect, it } from "vitest";

import { makeRepos } from "../../../src/db/index.ts";
import { HOUR_MS } from "../../../src/hc/store/keys.ts";
import { readRecords } from "../../../src/hc/store/read.ts";
import { wipeDevice } from "../../../src/hc/store/wipe.ts";

import {
  count,
  drain,
  enqueue,
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

const HC_TABLES = [
  "hc_ingest_queue",
  "hc_ingest_log",
  "hc_dirty",
  "hc_chunks",
  "hc_record_index",
  "hc_rollup_hour",
  "hc_rollup_day",
  "hc_hr_minute",
  "hc_sleep_night",
  "hc_exercise_session",
  "hc_sync_state",
];

/** A device with a row in every table, one batch still queued. */
async function populated(name: string): Promise<string> {
  const deviceId = await seedDevice(repos, name);
  await enqueue(repos, deviceId, {
    batchId: "batch-0001",
    upserts: [
      ...Array.from({ length: 12 }, (_, index) =>
        steps(`s-${String(index)}`, T + index * HOUR_MS, 10),
      ),
      heartRate("hr-1", T, [[0, 60]]),
      interval("night-1", "SleepSession", T, T + 8 * HOUR_MS, {}),
      interval("run-1", "ExerciseSession", T, T + 30 * MINUTE_MS, { exerciseType: "RUNNING" }),
    ],
  });
  await drain(ctx, deviceId);
  // Left behind: one batch queued and unapplied, one parked.
  await enqueue(repos, deviceId, { batchId: "batch-0002", upserts: [steps("late", T, 5)] });
  await enqueue(repos, deviceId, { batchId: "batch-0003", upserts: [steps("set-aside", T, 6)] });
  await repos.hcIngestQueue.park(deviceId, "batch-0003");
  return deviceId;
}

describe("wipeDevice", () => {
  it("removes everything a device has, and the device, and nothing else", async () => {
    const kept = await populated("Kept phone");
    const wiped = await populated("Wiped phone");
    // The rebuild drained `hc_dirty`; every other table has rows to lose.
    const filled = HC_TABLES.filter((name) => name !== "hc_dirty");
    for (const table of filled) expect(await count(table, wiped), table).toBeGreaterThan(0);

    expect(await wipeDevice(ctx, wiped)).toStrictEqual({ done: true });

    for (const table of [...HC_TABLES, "devices"]) expect(await count(table, wiped), table).toBe(0);
    expect(await repos.devices.get(wiped)).toBeNull();

    // The other phone still has its records and its queued batch.
    expect(await count("devices", kept)).toBe(1);
    expect(await count("hc_ingest_queue", kept)).toBe(2);
    const records = await readRecords(ctx, {
      deviceId: kept,
      type: "Steps",
      startMs: T,
      endMs: T + 12 * HOUR_MS,
    });
    expect(records).toHaveLength(12);
  });

  it("works in bounded passes, with the device revoked from the first", async () => {
    const deviceId = await populated("Phone");
    const pass = { maxStatements: 3 };

    expect(await wipeDevice(ctx, deviceId, pass)).toStrictEqual({ done: false });

    // Still there, with rows left, and no longer accepting uploads.
    const row = await repos.devices.authRow(deviceId);
    expect(row?.revokedAt).not.toBeNull();
    expect(await count("hc_record_index", deviceId)).toBeGreaterThan(0);

    let passes = 1;
    for (; passes < 50; passes += 1) {
      const { done } = await wipeDevice(ctx, deviceId, pass);
      if (done) break;
    }

    expect(passes).toBeGreaterThan(1);
    expect(passes).toBeLessThan(50);
    for (const table of [...HC_TABLES, "devices"])
      expect(await count(table, deviceId), table).toBe(0);
  });

  it("is done at once for a device that does not exist", async () => {
    expect(await wipeDevice(ctx, "01NOSUCHDEVICE0000000000000")).toStrictEqual({ done: true });
  });
});
