// `GET /api/runs` -- the run log as the dashboard reads it.
//
// The behaviour worth pinning is the default filter. The token keepalive writes a
// `refresh` row every hour, so an unfiltered "last 25 runs" would be 25 keepalives
// and none of the syncs the owner opened the page to look at.

import { describe, expect, it } from "vitest";

import { freshOwner, json, testRepos } from "./helpers.ts";

import type { RunDto, RunKind } from "@shared/types.ts";

const owner = freshOwner();

/** Write one finished run of a kind, oldest first. */
async function seedRun(kind: RunKind, summary: Record<string, number> = {}): Promise<string> {
  const repos = testRepos();
  const id = await repos.runLog.start(kind);
  await repos.runLog.finish(id, { ok: true, summary });
  return id;
}

describe("GET /api/runs", () => {
  it("is empty on a fresh deployment", async () => {
    const runs = await json<RunDto[]>(await owner().get("/api/runs"));

    expect(runs).toStrictEqual([]);
  });

  it("hides the hourly keepalive unless it is asked for", async () => {
    await seedRun("calendar");
    for (let index = 0; index < 5; index++) await seedRun("refresh");

    const runs = await json<RunDto[]>(await owner().get("/api/runs"));

    expect(runs.map((run) => run.kind)).toStrictEqual(["calendar"]);
  });

  it("returns the keepalive rows for ?kind=refresh", async () => {
    await seedRun("calendar");
    await seedRun("refresh");
    await seedRun("refresh");

    const runs = await json<RunDto[]>(await owner().get("/api/runs?kind=refresh"));

    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.kind))).toStrictEqual(new Set(["refresh"]));
  });

  it("narrows to one kind for any other ?kind=", async () => {
    await seedRun("calendar");
    await seedRun("full");
    await seedRun("manual");

    const runs = await json<RunDto[]>(await owner().get("/api/runs?kind=full"));

    expect(runs.map((run) => run.kind)).toStrictEqual(["full"]);
  });

  it("refuses a kind the column does not allow", async () => {
    const response = await owner().get("/api/runs?kind=everything");

    expect(response.status).toBe(400);
  });

  it("honours ?limit= after the default filter has been applied", async () => {
    await seedRun("refresh");
    await seedRun("calendar");
    await seedRun("refresh");
    await seedRun("calendar");
    await seedRun("refresh");

    const runs = await json<RunDto[]>(await owner().get("/api/runs?limit=1"));

    expect(runs).toHaveLength(1);
    expect(runs[0]?.kind).toBe("calendar");
  });

  it("projects the stored counts into the UI's vocabulary", async () => {
    await seedRun("calendar", {
      providers: 2,
      inserted: 3,
      patched: 1,
      ghosted: 2,
      restored: 1,
      unchanged: 4,
      resources: 90,
    });

    const runs = await json<RunDto[]>(await owner().get("/api/runs"));
    const summary = runs[0]?.summary;

    expect(summary?.eventsInserted).toBe(3);
    expect(summary?.eventsGhosted).toBe(2);
    expect(summary?.resourcesCached).toBe(90);
    // Everything the run actually saw upstream; a ghost was by definition not there.
    expect(summary?.encountersSeen).toBe(9);
    expect(summary?.warnings).toBe(0);
    expect(runs[0]?.ok).toBe(true);
    expect(runs[0]?.finishedAt).not.toBeNull();
  });

  it("shows a run that was cut off mid-flight rather than hiding it", async () => {
    await testRepos().runLog.start("calendar");

    const runs = await json<RunDto[]>(await owner().get("/api/runs"));

    expect(runs[0]?.finishedAt).toBeNull();
    expect(runs[0]?.ok).toBeNull();
  });

  it("is never cached", async () => {
    const response = await owner().get("/api/runs");

    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
