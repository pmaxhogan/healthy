// Which rows of a phone's `syncState.types` reach `hc_sync_state`: the types
// this Worker knows, and any other type that already holds stored records. An
// older app build's fake `ExerciseRoute` type, and a made-up type with no data,
// are not stored. Synthetic throughout.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { makeRepos } from "../../../src/db/index.ts";
import { reportStatement } from "../../../src/hc/store/sync-state.ts";

import { drain, enqueue, resetHc, seedDevice, steps, T, testCtx } from "./helpers.ts";

import type { HcSyncState } from "../../../src/hc/wire.ts";

beforeEach(resetHc);

const ctx = testCtx();
const repos = makeRepos(ctx);

const entry = (type: string): HcSyncState["types"][number] => ({ type, permission: "granted" });

async function storedTypes(deviceId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT record_type FROM hc_sync_state WHERE device_id = ? ORDER BY record_type",
  )
    .bind(deviceId)
    .all<{ record_type: string }>();
  return results.map((row) => row.record_type);
}

async function report(deviceId: string, types: string[]): Promise<void> {
  const statement = reportStatement(ctx, deviceId, { types: types.map((t) => entry(t)) }, 1000);
  await statement?.run();
}

describe("reportStatement", () => {
  it("stores known types and drops ExerciseRoute and unknown types with no data", async () => {
    const deviceId = await seedDevice(repos);

    await report(deviceId, ["Steps", "ExerciseRoute", "FutureThing"]);

    expect(await storedTypes(deviceId)).toStrictEqual(["Steps"]);
  });

  it("makes no statement for a report of only ExerciseRoute", () => {
    expect(reportStatement(ctx, "d", { types: [entry("ExerciseRoute")] }, 1000)).toBeNull();
  });

  it("still lists an unknown type that already has stored data", async () => {
    const deviceId = await seedDevice(repos);
    await enqueue(repos, deviceId, {
      batchId: "batch-0001",
      upserts: [steps("s1", T, 5, { type: "FutureThing" })],
    });
    await drain(ctx, deviceId);

    await report(deviceId, ["FutureThing", "ExerciseRoute"]);

    expect(await storedTypes(deviceId)).toContain("FutureThing");
    expect(await storedTypes(deviceId)).not.toContain("ExerciseRoute");
  });
});
