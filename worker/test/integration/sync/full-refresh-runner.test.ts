// The FullRefreshRunner Durable Object's own glue: the job it stores, the alarm
// that runs it, and the cleanup when the job is done. The chunk logic itself is
// `full-refresh.test.ts`'s job; here the job names a health system that no longer
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

const GONE = "01HEALTH_SYSTEMTHATWASDELETED00";

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

  it("says it is busy exactly while a job is stored", async () => {
    const stub = env.FULL_REFRESH.getByName(`runner-${crypto.randomUUID()}`);

    expect(await stub.busy()).toBe(false);
    await stub.start([GONE]);
    await settle(stub);
    expect(await stub.busy()).toBe(false);

    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("job", {
        pending: [GONE],
        cycleStartedAt: 0,
        runId: null,
        state: null,
        chunks: 0,
      }),
    );
    expect(await stub.busy()).toBe(true);
  });

  it("does nothing when an alarm fires with no job stored", async () => {
    const stub = env.FULL_REFRESH.getByName(`runner-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now()));

    await runDurableObjectAlarm(stub);

    expect(await storedJob(stub)).toBeUndefined();
    expect(await fullRuns()).toStrictEqual([]);
  });
});

// The second kind of job: a calendar sync asked for over MCP. The run itself is
// `calendar-sync.test.ts`'s and `portal-sync.test.ts`'s job (including the run
// that will not sign in, which is the `signInWaitSeconds: 0` this job always
// passes); here the job names a health system that no longer exists, so the run
// opens its row, finds nothing to sync and closes it, reaching no upstream.
async function manualRuns(): Promise<{ ok: number | null; finished_at: number | null }[]> {
  const { results } = await env.DB.prepare(
    `SELECT ok, finished_at FROM run_log WHERE kind = 'manual'`,
  ).all<{ ok: number | null; finished_at: number | null }>();
  return results;
}

describe("FullRefreshRunner, calendar job", () => {
  it.each([{ portalOnly: false }, { portalOnly: true }])(
    "runs one calendar sync from its alarm and leaves no job behind ($portalOnly)",
    async (options) => {
      const stub = env.FULL_REFRESH.getByName(`runner-${crypto.randomUUID()}`);

      expect(await stub.startCalendar([GONE], options)).toStrictEqual({ started: true });

      expect(await settle(stub)).toBeUndefined();
      expect(await stub.busy()).toBe(false);
      const runs = await manualRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ ok: 1 });
      expect(runs[0]?.finished_at).not.toBeNull();
      // A calendar job is never mistaken for a refresh.
      expect(await fullRuns()).toStrictEqual([]);
    },
  );

  it("refuses a second job, of either kind, while one is stored", async () => {
    const stub = env.FULL_REFRESH.getByName(`runner-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("job", {
        pending: [GONE],
        cycleStartedAt: 0,
        runId: null,
        state: null,
        chunks: 0,
        calendar: { portalOnly: false },
      }),
    );

    expect(await stub.startCalendar([GONE], { portalOnly: true })).toStrictEqual({
      started: false,
    });
    expect(await stub.start([GONE])).toStrictEqual({ started: false });
    expect(await stub.busy()).toBe(true);
  });

  it("drops a job whose run already began, instead of running the sync twice", async () => {
    // What a redelivered alarm finds when the invocation that held the run died:
    // the mark is set and the job is still stored.
    const stub = env.FULL_REFRESH.getByName(`runner-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("job", {
        pending: [GONE],
        cycleStartedAt: 0,
        runId: null,
        state: null,
        chunks: 1,
        calendar: { portalOnly: false },
      });
      await state.storage.setAlarm(Date.now());
    });

    expect(await settle(stub)).toBeUndefined();
    expect(await manualRuns()).toStrictEqual([]);
  });
});
