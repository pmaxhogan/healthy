import { beforeEach, describe, expect, it } from "vitest";

import { T0, clock, column, resetDb, testRepos } from "./helpers.ts";

beforeEach(resetDb);

describe("run_log.start and finish", () => {
  it("opens a run with no outcome and closes it with counts", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    const id = await repos.runLog.start("calendar");

    expect(await repos.runLog.get(id)).toStrictEqual({
      id,
      kind: "calendar",
      startedAt: T0,
      finishedAt: null,
      ok: null,
      summary: {
        providers: 0,
        inserted: 0,
        patched: 0,
        ghosted: 0,
        restored: 0,
        unchanged: 0,
        resources: 0,
        errors: [],
        warnings: [],
      },
    });

    time.advance(42);
    await repos.runLog.finish(id, {
      ok: true,
      summary: { providers: 2, inserted: 3, ghosted: 1, warnings: ["4119"] },
    });

    expect(await repos.runLog.get(id)).toMatchObject({
      finishedAt: T0 + 42,
      ok: true,
      summary: { providers: 2, inserted: 3, ghosted: 1, patched: 0, warnings: ["4119"] },
    });
  });

  it("leaves a run that was cut off mid-flight visible as unfinished", async () => {
    // The only way to see a Worker that hit its CPU limit halfway through a sync.
    const repos = testRepos();

    const id = await repos.runLog.start("full");

    await expect(repos.runLog.get(id)).resolves.toMatchObject({ finishedAt: null });
    const stats = await repos.runLog.stats();

    expect(stats[0]?.unfinished).toBe(1);
  });

  it("records a failure with its codes", async () => {
    const repos = testRepos();
    const id = await repos.runLog.start("calendar");

    await repos.runLog.finish(id, { ok: false, summary: { errors: ["needs_reauth"] } });

    expect(await repos.runLog.get(id)).toMatchObject({
      ok: false,
      summary: { errors: ["needs_reauth"] },
    });
  });

  it("rejects a summary that is not counts and codes", async () => {
    const repos = testRepos();
    const id = await repos.runLog.start("manual");

    await expect(
      repos.runLog.finish(id, { ok: true, summary: { inserted: -1 } }),
    ).rejects.toThrow();
  });

  it("returns null for a run id it does not have", async () => {
    const repos = testRepos();

    expect(await repos.runLog.get("NOPE")).toBeNull();
  });
});

describe("run_log.listRecent", () => {
  it("lists newest first, optionally filtered by kind, honouring the limit", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    const first = await repos.runLog.start("calendar");
    time.advance(60);
    const second = await repos.runLog.start("full");
    time.advance(60);
    const third = await repos.runLog.start("calendar");

    expect(await column(repos.runLog.listRecent(), "id")).toStrictEqual([third, second, first]);
    expect(await column(repos.runLog.listRecent({ kind: "calendar" }), "id")).toStrictEqual([
      third,
      first,
    ]);
    expect(await repos.runLog.listRecent({ limit: 1 })).toHaveLength(1);
  });
});

describe("run_log.stats", () => {
  it("summarises per kind, including the outcome of the last run", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    const ok = await repos.runLog.start("calendar");
    await repos.runLog.finish(ok, { ok: true });
    time.advance(60);
    const bad = await repos.runLog.start("calendar");
    await repos.runLog.finish(bad, { ok: false, summary: { errors: ["upstream_error"] } });
    time.advance(60);
    const fullRun = await repos.runLog.start("full");
    await repos.runLog.finish(fullRun, { ok: true });

    expect(await repos.runLog.stats()).toStrictEqual([
      {
        kind: "calendar",
        runs: 2,
        failures: 1,
        unfinished: 0,
        lastStartedAt: T0 + 60,
        lastOk: false,
      },
      { kind: "full", runs: 1, failures: 0, unfinished: 0, lastStartedAt: T0 + 120, lastOk: true },
    ]);
  });

  it("counts only inside the window it is given", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    await repos.runLog.finish(await repos.runLog.start("calendar"), { ok: true });
    time.advance(3600);
    await repos.runLog.finish(await repos.runLog.start("calendar"), { ok: true });

    const stats = await repos.runLog.stats(T0 + 1);

    expect(stats[0]?.runs).toBe(1);
  });

  it("is empty when nothing has run", async () => {
    const repos = testRepos();

    expect(await repos.runLog.stats()).toStrictEqual([]);
  });
});
