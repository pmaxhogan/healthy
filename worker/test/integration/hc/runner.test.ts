// The HcIngestRunner Durable Object's own glue: `wake` arms an alarm, the alarm
// runs slices until the device has nothing left, and then it rests. What a
// slice does is `apply.test.ts`'s and `rebuild.test.ts`'s job.
//
// The runner arms its alarm for "now", and the test runtime fires real alarms,
// so by the time a test looks the alarm may already have run by itself.
// `runDurableObjectAlarm` answers false in that case; either way, what is
// asserted is the state the work leaves behind.
//
// The object reads the runtime's own `DATA_KEY`, so these tests seal with that
// one (a dummy generated per run, see vitest.config.ts) rather than the db
// helpers' key.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { makeCtx } from "../../../src/db/client.ts";
import { makeRepos } from "../../../src/db/index.ts";
import { HOUR_MS } from "../../../src/hc/store/keys.ts";
import { pokeIngestRunners } from "../../../src/hc/store/poke.ts";
import { readRecords, storeBacklog } from "../../../src/hc/store/read.ts";
import { wipeDevice } from "../../../src/hc/store/wipe.ts";

import { T, count, enqueue, logRow, resetHc, seedDevice, steps } from "./helpers.ts";

import type { Env } from "../../../src/env.ts";

beforeEach(resetHc);

// `Cloudflare.Env` types the namespaces more narrowly than the hand-written Env.
const ctx = makeCtx(env.DB, env as unknown as Env);
const repos = makeRepos(ctx);

type RunnerStub = ReturnType<typeof env.HC_INGEST.getByName>;

/** Run the alarm if it has not run yet, then wait for the device to go idle. */
async function settle(stub: RunnerStub, deviceId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await runDurableObjectAlarm(stub);
    const backlog = await storeBacklog(ctx, deviceId);
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    if (alarm === null && backlog.queuedBatches === 0 && backlog.dirty === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the runner never went idle");
}

describe("HcIngestRunner", () => {
  it("applies what is queued from its alarm, then rests with no alarm armed", async () => {
    const deviceId = await seedDevice(repos);
    const records = Array.from({ length: 6 }, (_, index) =>
      steps(`s-${String(index)}`, T + index * HOUR_MS, 10 + index),
    );
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: records });
    await enqueue(repos, deviceId, { batchId: "batch-0002", deletes: ["s-0"] });
    const stub = env.HC_INGEST.getByName(deviceId);

    await stub.wake(deviceId);
    await settle(stub, deviceId);

    expect(await logRow(deviceId, "batch-0001")).toMatchObject({ status: "applied", applied: 6 });
    expect(await logRow(deviceId, "batch-0002")).toMatchObject({ status: "applied", removed: 1 });
    const read = await readRecords(ctx, {
      deviceId,
      type: "Steps",
      startMs: T,
      endMs: T + 6 * HOUR_MS,
    });
    expect(read).toStrictEqual(records.slice(1));
    expect(await count("hc_rollup_day", deviceId)).toBeGreaterThan(0);
    const job = await runInDurableObject(stub, (_instance, state) => state.storage.get("job"));
    expect(job).toMatchObject({ deviceId, failures: 0, state: { cursor: null } });
  });

  it("can be woken again for a later batch", async () => {
    const deviceId = await seedDevice(repos);
    const stub = env.HC_INGEST.getByName(deviceId);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 100)] });
    await stub.wake(deviceId);
    await settle(stub, deviceId);

    await enqueue(repos, deviceId, {
      batchId: "batch-0002",
      upserts: [steps("b", T + HOUR_MS, 200)],
    });
    await stub.wake(deviceId);
    // Twice in a row is one alarm, not two.
    await stub.wake(deviceId);
    await settle(stub, deviceId);

    expect(await logRow(deviceId, "batch-0002")).toMatchObject({ status: "applied", applied: 1 });
  });

  it("does nothing when an alarm fires on an object that was never woken", async () => {
    const stub = env.HC_INGEST.getByName(`never-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now()));

    await runDurableObjectAlarm(stub);

    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.get("job")),
    ).toBeUndefined();
  });

  it("is woken for every device by the scheduled poke", async () => {
    const first = await seedDevice(repos, "First phone");
    const second = await seedDevice(repos, "Second phone");
    await enqueue(repos, first, { batchId: "batch-0001", upserts: [steps("a", T, 100)] });
    await enqueue(repos, second, { batchId: "batch-0001", upserts: [steps("b", T, 200)] });

    await pokeIngestRunners(ctx);
    await settle(env.HC_INGEST.getByName(first), first);
    await settle(env.HC_INGEST.getByName(second), second);

    expect(await logRow(first, "batch-0001")).toMatchObject({ status: "applied" });
    expect(await logRow(second, "batch-0001")).toMatchObject({ status: "applied" });
  });

  it("forgets its job and its alarm when the device is wiped", async () => {
    const deviceId = await seedDevice(repos);
    const stub = env.HC_INGEST.getByName(deviceId);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 100)] });
    await stub.wake(deviceId);
    await settle(stub, deviceId);
    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.get("job")),
    ).toBeDefined();

    for (let pass = 0; pass < 50; pass += 1) {
      const { done } = await wipeDevice(ctx, deviceId);
      if (done) break;
    }

    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.get("job")),
    ).toBeUndefined();
    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).toBeNull();
    // An alarm that fires anyway finds no job, and brings nothing back.
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now()));
    await runDurableObjectAlarm(stub);
    for (const table of ["devices", "hc_chunks", "hc_sync_state", "hc_ingest_log", "hc_dirty"]) {
      expect(await count(table, deviceId), table).toBe(0);
    }
  });

  it("writes down each attempt before it runs, and clears the count when one succeeds", async () => {
    const deviceId = await seedDevice(repos);
    const stub = env.HC_INGEST.getByName(deviceId);
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 100)] });
    await env.DB.prepare(
      `CREATE TRIGGER synthetic_failure BEFORE INSERT ON hc_chunks
         BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`,
    ).run();
    const job = (): Promise<unknown> =>
      runInDurableObject(stub, (_instance, state) => state.storage.get("job"));
    try {
      await stub.wake(deviceId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await runDurableObjectAlarm(stub);
        const stored = (await job()) as { failures: number } | undefined;
        if ((stored?.failures ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(await job()).toMatchObject({
        failures: 1,
        head: { batchId: "batch-0001", failures: 1 },
      });
      // Retried later, not at once and not never.
      const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
      expect(alarm).toBeGreaterThan(Date.now());
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS synthetic_failure").run();
    }

    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now()));
    await settle(stub, deviceId);

    expect(await logRow(deviceId, "batch-0001")).toMatchObject({ status: "applied", applied: 1 });
    expect(await job()).toMatchObject({ failures: 0, head: { batchId: null, failures: 0 } });
  });
});
