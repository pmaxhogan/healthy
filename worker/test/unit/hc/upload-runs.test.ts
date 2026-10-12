// Grouping the upload log into sync runs. Synthetic rows only: counts and
// invented instants.

import { describe, expect, it } from "vitest";

import { newestRuns } from "../../../src/hc/upload-runs.ts";

import type { RunLogRow } from "../../../src/hc/upload-runs.ts";

/** Unix seconds of an arbitrary instant, and the same in the phone's milliseconds. */
const AT = 1_790_000_000;
const ms = (seconds: number): number => seconds * 1000;

function row(receivedAt: number, change: Partial<RunLogRow> = {}): RunLogRow {
  return {
    receivedAt,
    upserts: 0,
    deletes: 0,
    rejected: 0,
    runTrigger: null,
    runStartedMs: null,
    prevRunStartedMs: null,
    prevRunEnd: null,
    ...change,
  };
}

/** A batch of the run that began at `started`, newest first in every list below. */
function ofRun(
  started: number,
  receivedAt: number,
  trigger: string,
  change: Partial<RunLogRow> = {},
): RunLogRow {
  return row(receivedAt, { runStartedMs: ms(started), runTrigger: trigger, ...change });
}

describe("newestRuns", () => {
  it("groups the batches that name one start, and adds up what they sent", () => {
    const rows = [
      ofRun(AT, AT + 9, "periodic"),
      ofRun(AT, AT + 6, "periodic", { upserts: 40, deletes: 2 }),
      ofRun(AT, AT + 3, "periodic", { upserts: 100 }),
    ];

    expect(newestRuns(rows, 20)).toStrictEqual({
      runs: [
        {
          startedMs: ms(AT),
          receivedAt: AT + 9,
          trigger: "periodic",
          batches: 3,
          upserts: 140,
          deletes: 2,
          closed: true,
          ended: null,
        },
      ],
      whole: false,
    });
  });

  it("counts a run that sent only its closing report", () => {
    const { runs } = newestRuns([ofRun(AT, AT + 1, "alarm")], 20);

    expect(runs).toMatchObject([
      { trigger: "alarm", batches: 1, upserts: 0, deletes: 0, closed: true },
    ]);
  });

  it("says a run with no closing report did not finish", () => {
    const rows = [
      ofRun(AT, AT + 2, "periodic", { upserts: 5 }),
      // Nothing usable in it, but not a report of nothing either.
      ofRun(AT, AT + 1, "periodic", { rejected: 3 }),
    ];

    expect(newestRuns(rows, 20).runs).toMatchObject([{ batches: 2, closed: false }]);
  });

  it("takes how a run ended from the batches of a later one", () => {
    const rows = [
      ofRun(AT + 900, AT + 905, "periodic", {
        prevRunStartedMs: ms(AT),
        prevRunEnd: "interrupted",
      }),
      ofRun(AT, AT + 4, "periodic", { upserts: 12 }),
    ];

    expect(newestRuns(rows, 20).runs).toMatchObject([
      { startedMs: ms(AT + 900), closed: true, ended: null },
      { startedMs: ms(AT), closed: false, ended: "interrupted" },
    ]);
  });

  it("lets the newest batch to speak of a run say how it ended", () => {
    const rows = [
      ofRun(AT + 1800, AT + 1801, "manual", { prevRunStartedMs: ms(AT), prevRunEnd: "ok" }),
      ofRun(AT + 900, AT + 901, "periodic", { prevRunStartedMs: ms(AT), prevRunEnd: "network" }),
      ofRun(AT, AT + 1, "periodic"),
    ];

    expect(newestRuns(rows, 20).runs.at(-1)).toMatchObject({ startedMs: ms(AT), ended: "ok" });
  });

  it("makes a batch that names no run a run of its own", () => {
    const rows = [row(AT + 20, { upserts: 3 }), row(AT + 10), ofRun(AT, AT + 1, "periodic")];

    expect(newestRuns(rows, 20).runs).toStrictEqual([
      {
        startedMs: null,
        receivedAt: AT + 20,
        trigger: null,
        batches: 1,
        upserts: 3,
        deletes: 0,
        closed: null,
        ended: null,
      },
      {
        startedMs: null,
        receivedAt: AT + 10,
        trigger: null,
        batches: 1,
        upserts: 0,
        deletes: 0,
        closed: null,
        ended: null,
      },
      expect.objectContaining({ startedMs: ms(AT), batches: 1 }),
    ]);
  });

  it("returns the newest runs asked for, and says whether the rows reach past them", () => {
    const rows = [
      ofRun(AT + 1800, AT + 1801, "periodic"),
      ofRun(AT + 900, AT + 902, "periodic"),
      ofRun(AT + 900, AT + 901, "periodic", { upserts: 1 }),
    ];

    const two = newestRuns(rows, 2);
    const one = newestRuns(rows, 1);

    // The second run may go on beyond the rows: nothing older was seen behind it.
    expect(two.whole).toBe(false);
    expect(two.runs.map((run) => run.batches)).toStrictEqual([1, 2]);
    expect(one.whole).toBe(true);
    expect(one.runs.map((run) => run.startedMs)).toStrictEqual([ms(AT + 1800)]);
  });

  it("keeps the code a run was started by when only some of its batches carry it", () => {
    const rows = [
      row(AT + 2, { runStartedMs: ms(AT) }),
      ofRun(AT, AT + 1, "backfill", { upserts: 9 }),
    ];

    expect(newestRuns(rows, 20).runs).toMatchObject([{ trigger: "backfill", batches: 2 }]);
  });
});
