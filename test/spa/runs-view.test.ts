// RunsView used to do one reload after the manual-sync 202, which usually caught
// the run mid-flight and left the row reading "running" until the owner pressed
// Refresh by hand. These pin the fix: polling `GET /api/runs` while any row is
// still running, stopping once none is (or after the cap), and never spinning the
// whole table while it does.

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RunsView from "../../src/views/RunsView.vue";

import { fakeResponse, installFakeApi, settings, testRouter } from "./helpers.ts";

import type { RunDto } from "@shared/types.ts";

function run(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: "run-1",
    kind: "calendar",
    startedAt: "2026-09-21T11:07:00.000Z",
    finishedAt: null,
    ok: null,
    summary: null,
    ...overrides,
  };
}

const FINISHED: RunDto = {
  ...run(),
  finishedAt: "2026-09-21T11:07:04.000Z",
  ok: true,
  summary: {
    healthSystems: 1,
    encountersSeen: 1,
    eventsInserted: 1,
    eventsPatched: 0,
    eventsGhosted: 0,
    eventsRestored: 0,
    resourcesCached: 3,
    warnings: 2,
    warningCodes: ["4119"],
    portalVisits: 0,
    portalSkipped: 0,
    portalErrors: [],
    filteredView: false,
    backedOff: false,
    errors: ["needs_reauth"],
  },
};

/** Answers `/api/runs` with the given bodies in order, then repeats the last one. */
function sequencedRuns(...bodies: RunDto[][]): { calls: () => number } {
  let call = 0;
  installFakeApi({
    "/api/settings": () => fakeResponse({ body: settings() }),
    "/api/runs": () => {
      const body = bodies[Math.min(call, bodies.length - 1)] ?? [];
      call += 1;
      return fakeResponse({ body });
    },
  });
  return { calls: () => call };
}

async function mountRuns(): Promise<ReturnType<typeof mount>> {
  const router = await testRouter("/runs");
  const wrapper = mount(RunsView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

describe("RunsView polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls while a run is running and stops once it finishes", async () => {
    const seq = sequencedRuns([run()], [run()], [FINISHED]);
    const wrapper = await mountRuns();
    expect(wrapper.text()).toContain("running");
    expect(seq.calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(seq.calls()).toBe(2);
    expect(wrapper.text()).toContain("running");

    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
    expect(seq.calls()).toBe(3);
    expect(wrapper.text()).not.toContain("running");
    expect(wrapper.text()).toContain("ok");

    // Stopped: no further polling once nothing is running.
    await vi.advanceTimersByTimeAsync(9000);
    expect(seq.calls()).toBe(3);
  });

  it("does not poll at all when nothing is running", async () => {
    const seq = sequencedRuns([FINISHED]);
    await mountRuns();
    expect(seq.calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(9000);
    expect(seq.calls()).toBe(1);
  });

  it("gives up polling after about two minutes of a run that never finishes", async () => {
    const seq = sequencedRuns([run()]);
    await mountRuns();

    // 2 minutes at a 3-second interval: the initial load plus roughly 40 polls,
    // then nothing more however long the clock keeps advancing.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 30_000);
    const callsAtCap = seq.calls();
    expect(callsAtCap).toBeGreaterThan(30);
    expect(callsAtCap).toBeLessThan(45);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(seq.calls()).toBe(callsAtCap);
  });

  it("does not flash a loading spinner on a poll tick", async () => {
    const seq = sequencedRuns([run()], [run()]);
    const wrapper = await mountRuns();

    await vi.advanceTimersByTimeAsync(3000);
    expect(seq.calls()).toBe(2);
    // The table (with its "Kind" header) stayed on screen through the poll --
    // `loading` never flipped back to true, which would have replaced it with
    // the spinner text instead.
    expect(wrapper.text()).toContain("Kind");
    expect(wrapper.text()).not.toContain("Loading runs");
  });
});

describe("RunsView warning and error codes", () => {
  it("shows the distinct codes in the expanded summary", async () => {
    sequencedRuns([FINISHED]);
    const wrapper = await mountRuns();

    const showButton = wrapper.findAll("button").find((b) => b.text() === "Show");
    await showButton?.trigger("click");

    expect(wrapper.text()).toContain("Warnings: 4119");
    expect(wrapper.text()).toContain("Errors: needs_reauth");
  });
});
