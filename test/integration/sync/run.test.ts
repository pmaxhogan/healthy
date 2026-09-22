// `run_log` bookkeeping, against real D1.
//
// What is worth proving here is the sweeper. A run row is opened before the work
// and closed after it, so a run whose invocation stopped existing -- a `waitUntil`
// cancelled thirty seconds after the response, a CPU limit, a deploy mid-run --
// leaves a row open, and *nothing inside that run* can ever close it: there was no
// `catch`, no `finally` and no isolate. A later run has to do it, which is why
// `record` sweeps before it opens its own row.

import { beforeEach, describe, expect, it } from "vitest";

import { toRunDto } from "../../../worker/api/dto.ts";
import { RUN_ABORTED_CODE } from "../../../worker/db/repos/run-log.ts";
import { record } from "../../../worker/sync/run.ts";

import { T0, clock, resetSyncDb, syncCtx, syncRepos } from "./helpers.ts";

beforeEach(resetSyncDb);

/** Long enough that an open row is presumed dead. See `STALE_RUN_SECONDS`. */
const PAST_THE_THRESHOLD = 31 * 60;

const noWork = (): Promise<void> => Promise.resolve();

describe("record", () => {
  it("closes a run left open by an invocation that no longer exists", async () => {
    const time = clock();
    const ctx = syncCtx({ now: time.now });
    const repos = syncRepos(ctx);
    const dead = await repos.runLog.start("full");
    time.advance(PAST_THE_THRESHOLD);

    // Any later run sweeps, whatever its own kind: a manual calendar sync is as
    // good a chance to notice as the cron is.
    await record(ctx, "manual", noWork);

    const swept = await repos.runLog.get(dead);
    expect(swept?.finishedAt).toBe(T0 + PAST_THE_THRESHOLD);
    expect(swept?.ok).toBe(false);
    expect(swept?.summary.errors).toStrictEqual([RUN_ABORTED_CODE]);
  });

  it("leaves a run that could still be going alone", async () => {
    const time = clock();
    const ctx = syncCtx({ now: time.now });
    const repos = syncRepos(ctx);
    time.advance(PAST_THE_THRESHOLD);
    // Opened five minutes ago: the daily refresh takes minutes, and sweeping a run
    // that is still working would be a worse bug than the one this fixes.
    const young = await repos.runLog.start("full");
    time.advance(5 * 60);

    await record(ctx, "manual", noWork);

    const entry = await repos.runLog.get(young);
    expect(entry?.finishedAt).toBeNull();
    expect(entry?.ok).toBeNull();
  });

  it("does not sweep the row of the run doing the sweeping", async () => {
    const time = clock(T0 - PAST_THE_THRESHOLD);
    const ctx = syncCtx({ now: time.now });
    const repos = syncRepos(ctx);

    // The clock is already past the threshold when this row is opened, so a sweep
    // that ran after `start` rather than before it would abort this very run.
    const outcome = await record(ctx, "manual", noWork);

    const runs = await repos.runLog.listRecent({ kind: "manual" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.ok).toBe(true);
    expect(runs[0]?.summary.errors).toStrictEqual([]);
    expect(outcome.unfinished).toBe(false);
  });

  it("surfaces an aborted run to the admin API as an error code", async () => {
    const time = clock();
    const ctx = syncCtx({ now: time.now });
    const repos = syncRepos(ctx);
    const dead = await repos.runLog.start("full");
    time.advance(PAST_THE_THRESHOLD);

    await record(ctx, "manual", noWork);

    const entry = await repos.runLog.get(dead);
    if (entry === null) throw new Error("the swept run row is missing");
    const dto = toRunDto(entry);
    expect(dto.ok).toBe(false);
    expect(dto.finishedAt).not.toBeNull();
    expect(dto.summary?.errors).toStrictEqual([RUN_ABORTED_CODE]);
  });

  it("keeps the row open when the work says it is coming back", async () => {
    const ctx = syncCtx();
    const repos = syncRepos(ctx);

    const first = await record(ctx, "full", (state) => {
      state.unfinished = true;
      return Promise.resolve();
    });

    expect(first.unfinished).toBe(true);
    const opened = await repos.runLog.get(first.runId);
    expect(opened?.finishedAt).toBeNull();

    // The continuation writes to the same row and carries the counts forward.
    const second = await record(
      ctx,
      "full",
      (state) => {
        state.summary.resourcesCached += 2;
        return Promise.resolve();
      },
      {
        runId: first.runId,
        state: { ...first.state, summary: { ...first.state.summary, resourcesCached: 5 } },
      },
    );

    expect(second.runId).toBe(first.runId);
    const runs = await repos.runLog.listRecent({ kind: "full" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.ok).toBe(true);
    expect(runs[0]?.summary.resources).toBe(7);
  });
});
