// The FullRefreshRunner Durable Object's own glue: the job it stores, the alarm
// that runs it, and the cleanup when the job is done. The chunk logic itself is
// `full-refresh.test.ts`'s job; here the job names a provider that no longer
// exists, so a chunk finishes at once without reaching any upstream.
//
// The runner arms its alarm for "now", and the test runtime fires real alarms,
// so by the time a test looks the alarm may already have run by itself.
// `runDurableObjectAlarm` answers false in that case; either way, what is
// asserted is the state the job leaves behind.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { resetSyncDb } from "./helpers.ts";

beforeEach(resetSyncDb);

const GONE = "01PROVIDERTHATWASDELETED00";

type RunnerStub = ReturnType<typeof env.FULL_REFRESH.getByName>;

async function storedJob(stub: RunnerStub): Promise<unknown> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get("job"));
}

/** Run the alarm if it has not run yet, then wait for the job to be cleared. */
async function settle(stub: RunnerStub): Promise<unknown> {
  await runDurableObjectAlarm(stub);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = await storedJob(stub);
    if (job === undefined) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return storedJob(stub);
}

async function fullRuns(): Promise<{ finished_at: number | null }[]> {
  const { results } = await env.DB.prepare(
    `SELECT finished_at FROM run_log WHERE kind = 'full'`,
  ).all<{ finished_at: number | null }>();
  return results;
}

describe("FullRefreshRunner", () => {
  it("runs a queued job from its alarm, leaves no job behind, and closes its run row", async () => {
    const stub = env.FULL_REFRESH.getByName(`runner-${crypto.randomUUID()}`);

    expect(await stub.start([GONE])).toStrictEqual({ started: true });

    expect(await settle(stub)).toBeUndefined();
    const runs = await fullRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.finished_at).not.toBeNull();
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeNull();
  });

  it("accepts a new job once the previous one has finished", async () => {
    const stub = env.FULL_REFRESH.getByName(`runner-${crypto.randomUUID()}`);
    await stub.start([GONE]);
    await settle(stub);

    expect(await stub.start([GONE])).toStrictEqual({ started: true });
    expect(await settle(stub)).toBeUndefined();
  });

  it("refuses a second job while one is stored", async () => {
    const stub = env.FULL_REFRESH.getByName(`runner-${crypto.randomUUID()}`);
    // Stored directly, with no alarm armed, so it cannot finish under the test.
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("job", {
        pending: [GONE],
        cycleStartedAt: 0,
        runId: null,
        state: null,
        chunks: 0,
      }),
    );

    expect(await stub.start([GONE])).toStrictEqual({ started: false });
  });

  it("does nothing when an alarm fires with no job stored", async () => {
    const stub = env.FULL_REFRESH.getByName(`runner-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now()));

    await runDurableObjectAlarm(stub);

    expect(await storedJob(stub)).toBeUndefined();
    expect(await fullRuns()).toStrictEqual([]);
  });
});
