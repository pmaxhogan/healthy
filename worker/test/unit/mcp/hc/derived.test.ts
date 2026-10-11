// Regression tests for the Health Connect tools that derive an answer from
// several records: sessions, the daily join, data quality, the heart-rate
// series, and what they all say about the store they read.
//
// Each case is a reviewer's scenario rebuilt from invented data: what the tool
// answered before is in the comment beside what it has to answer.
//
// Everything is synthetic: RFC 2606 style package names, invented values.

import { beforeEach, describe, expect, it } from "vitest";

import { resampleMinutes } from "../../../../src/mcp/hc/heart.ts";
import { buildRules } from "../../../../src/policy/rules.ts";
import {
  CUFF,
  DEVICE_ID,
  HOUR_MS,
  MINUTE_MS,
  PHONE,
  WEARABLE,
  addDevice,
  device,
  hcWorld,
  heartRate,
  instant as instantRecord,
  interval,
} from "../hc-fake.ts";
import { NOW, callTool, connectTools, fakeDeps, fakeState } from "../helpers.ts";

import type { HrMinutePoint } from "../../../../src/hc/rollup/hr.ts";
import type { HcRecord } from "../../../../src/hc/wire.ts";
import type { FakeState, ToolAnswer } from "../helpers.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const SOURCE = `device:${DEVICE_ID}`;
const NOW_MS = NOW * 1000;
const DAY_MS = 24 * HOUR_MS;
/** The invented day: the UTC day that ends at the fake clock. */
const DAY = NOW_MS - DAY_MS;
const at = (hour: number, minute = 0): number => DAY + hour * HOUR_MS + minute * MINUTE_MS;
const date = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const iso = (ms: number): string => new Date(ms).toISOString();

const TODAY = date(DAY);
const YESTERDAY = date(DAY - 1);
const RANGE = { start: YESTERDAY, end: TODAY };
const EVERYTHING = { max_bytes: 10_000_000 };

const world: { state: FakeState; client: Client } = {
  state: undefined as unknown as FakeState,
  client: undefined as unknown as Client,
};

/** Connect a client to the current state: the store's readers are bound here. */
async function connect(): Promise<void> {
  world.client = await connectTools(fakeDeps(world.state));
}

beforeEach(async () => {
  world.state = fakeState({ hc: hcWorld(NOW) });
  await connect();
});

const call = (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> =>
  callTool(world.client, name, args);

const envelope = (answer: ToolAnswer): Record<string, unknown> =>
  JSON.parse(answer.text) as Record<string, unknown>;

const records = (): HcRecord[] => world.state.hc.records.get(DEVICE_ID) ?? [];

const deny = (...types: string[]) =>
  buildRules(types.map((type) => ({ rule_type: "resource" as const, target: `hc:${type}` })));

function workout(
  id: string,
  type: string,
  startMs: number,
  endMs: number,
  origin: string,
): HcRecord {
  return interval(
    id,
    "ExerciseSession",
    startMs,
    endMs,
    { exerciseType: type, title: id },
    { origin },
  );
}

describe("a session nobody stopped does not swallow the real workouts", () => {
  // A "walk" forgotten for thirty hours by one app, and a forty-minute run
  // recorded by another the next morning, while the walk was still "running".
  beforeEach(() => {
    records().push(
      workout("Forgotten walk", "HIKING", at(-20), at(10), WEARABLE),
      workout("Morning run", "RUNNING", at(8), at(8, 40), PHONE),
    );
  });

  it("returns both: the run keeps its own row, type, times and duration", async () => {
    const answer = await call("exercise_sessions", { ...RANGE, types: ["HIKING", "RUNNING"] });

    // Was ONE row: Walk, 1800 min, `mergedSessions: 2`, and no run anywhere.
    expect(
      answer.items.map((item) => [
        item.title,
        item.exerciseType,
        item.durationMin,
        item.mergedSessions,
        item.overThreeHours,
      ]),
    ).toStrictEqual([
      ["Forgotten walk", "HIKING", 1800, 1, true],
      ["Morning run", "RUNNING", 40, 1, false],
    ]);
    expect(answer.items[1]).toMatchObject({
      start: `${TODAY}T08:00:00+00:00`,
      end: `${TODAY}T08:40:00+00:00`,
      members: [expect.objectContaining({ id: "blind-Morning run", origin: PHONE })],
    });
  });

  it("does not merge into it even when both are the same exercise type", async () => {
    records().push(workout("Run inside", "HIKING", at(2), at(2, 30), PHONE));

    const answer = await call("exercise_sessions", { ...RANGE, types: ["HIKING"] });

    expect(answer.items.map((item) => [item.title, item.mergedSessions])).toStrictEqual([
      ["Forgotten walk", 1],
      ["Run inside", 1],
    ]);
  });

  it("shows the run on its day in daily_summary", async () => {
    const answer = await call("daily_summary", { ...RANGE, ...EVERYTHING });
    const [before, day] = answer.items as { exercises: Record<string, unknown>[] }[];

    // Was on neither day: absorbed into a row filed on the day before.
    expect(day?.exercises).toContainEqual(
      expect.objectContaining({ exerciseType: "RUNNING", durationMin: 40, overThreeHours: false }),
    );
    expect(before?.exercises).toStrictEqual([
      expect.objectContaining({ exerciseType: "HIKING", durationMin: 1800, overThreeHours: true }),
    ]);
  });

  it("reports every session over three hours, and the long one as a finding", async () => {
    const sessions = await call("exercise_sessions", RANGE);
    const quality = await call("data_quality", {
      ...RANGE,
      types: ["ExerciseSession"],
      ...EVERYTHING,
    });

    // The acceptance test counts these: the forgotten walk and the fixture's four-hour session.
    expect(sessions.items.filter((item) => item.overThreeHours === true)).toHaveLength(2);
    expect(quality.items.filter((item) => item.kind === "long_session")).toHaveLength(2);
    expect(quality.items.filter((item) => item.kind === "overlapping_sessions")).toHaveLength(0);
  });

  it("still merges two apps' copies of one ordinary workout, and never across types", async () => {
    records().push(
      workout("Ride", "BIKING", at(12), at(13), WEARABLE),
      workout("Ride copy", "BIKING", at(12, 5), at(13, 5), PHONE),
      workout("Stretch", "YOGA", at(12, 30), at(12, 50), PHONE),
    );

    const answer = await call("exercise_sessions", { ...RANGE, types: ["BIKING", "YOGA"] });

    expect(
      answer.items.map((item) => [item.exerciseType, item.mergedSessions, item.spanMin]),
    ).toStrictEqual([
      ["BIKING", 2, 65],
      ["YOGA", 1, 20],
    ]);
  });
});

describe("sleep that was never closed", () => {
  it("does not absorb the next night", async () => {
    // Thirty hours of "sleep" that runs straight through the fixture's real night.
    records().push(
      interval(
        "sleep-stuck",
        "SleepSession",
        at(-20),
        at(10),
        { title: "Stuck" },
        { origin: PHONE },
      ),
    );

    const answer = await call("sleep_sessions", RANGE);

    expect(
      answer.items.map((item) => [item.title, item.inBedMin, item.mergedSessions]),
    ).toStrictEqual([
      ["Stuck", 1800, 1],
      ["Night", 480, 1],
    ]);
    expect(answer.items[1]).toMatchObject({
      contextClamped: false,
      members: [{ id: "blind-sleep-1", origin: WEARABLE }],
    });
  });
});

/** The summary's phone items, picked out with `jq`. */
async function lastNight(): Promise<Record<string, unknown> | undefined> {
  const answer = await call("get_health_summary", {
    jq: '.[] | select(.kind == "phone" and .section == "last_night_sleep")',
  });
  return answer.items[0];
}

describe("get_health_summary's last night", () => {
  it("is the latest night in the window, not the longest", async () => {
    // The night before last, ending yesterday at 13:00: eleven hours, longer
    // than last night's eight, and still inside the day-and-a-half window.
    records().push(interval("sleep-long", "SleepSession", at(-22), at(-11), { title: "Long" }));

    // Was the eleven-hour one.
    expect(await lastNight()).toMatchObject({
      date: TODAY,
      end: `${TODAY}T07:00:00+00:00`,
      inBedMin: 480,
    });
  });

  it("is the longest of the stretches that ended on that date: a nap is not the night", async () => {
    records().push(interval("nap", "SleepSession", at(14), at(15), { title: "Nap" }));

    expect(await lastNight()).toMatchObject({ date: TODAY, inBedMin: 480 });
  });

  it("writes the last upload in the answer's zone, like every other instant", async () => {
    const answer = await call("get_health_summary", {
      jq: '.[] | select(.kind == "phone" and .section == "sync")',
    });

    expect(answer.items[0]?.lastUploadAt).toBe(iso(NOW_MS - 600_000).replace(".000Z", "+00:00"));
  });
});

async function findings(args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const answer = await call("data_quality", { ...args, ...EVERYTHING });
  expect(answer.isError, answer.text).toBe(false);
  return answer.items;
}

const kinds = (items: readonly Record<string, unknown>[]): string[] =>
  items.map((item) => `${String(item.resourceType)}:${String(item.kind)}`);

describe("data_quality's `types` narrows the report, not what a rule may read", () => {
  it("still finds a left-running session when only exercise is asked about", async () => {
    // Was: nothing, because heart rate and steps were no longer "in scope".
    expect(kinds(await findings({ ...RANGE, types: ["ExerciseSession"] }))).toStrictEqual([
      "hc:ExerciseSession:long_session",
      "hc:ExerciseSession:likely_left_running",
    ]);
  });

  it("still finds a profile-setup weight when only weight is asked about", async () => {
    const items = await findings({ ...RANGE, types: ["Weight"] });

    // Was: nothing, because the height that tells it was not asked for.
    expect(items).toStrictEqual([
      expect.objectContaining({
        resourceType: "hc:Weight",
        kind: "artefact",
        reason: "weight_profile_setup",
        value: 70,
      }),
    ]);
  });

  it("is still gated by the policy: a denied context type is not read", async () => {
    world.state.rules = deny("Height", "HeartRate");
    world.state.hc.calls.length = 0;

    const weight = await findings({ ...RANGE, types: ["Weight"] });
    const exercise = await findings({ ...RANGE, types: ["ExerciseSession"] });

    expect(weight).toStrictEqual([]);
    expect(kinds(exercise)).toStrictEqual(["hc:ExerciseSession:long_session"]);
    const read = new Set(world.state.hc.calls.map((entry) => entry.type));
    expect(read.has("Height") || read.has("HeartRate")).toBe(false);
  });
});

describe("data_quality's source_switch", () => {
  const floors = (id: string, daysAgo: number, count: number, origin: string): HcRecord => {
    const start = DAY - daysAgo * DAY_MS + 10 * HOUR_MS;
    return interval(id, "FloorsClimbed", start, start + MINUTE_MS, { floors: count }, { origin });
  };
  // Up to yesterday: the fixture has its own floors on the invented day.
  const range = { start: date(DAY - 12 * DAY_MS), end: YESTERDAY, types: ["FloorsClimbed"] };

  it("does not fire while two apps record side by side, whoever leads", async () => {
    // Ten days of both, the lead changing hands every day.
    for (let daysAgo = 10; daysAgo >= 1; daysAgo -= 1) {
      const wearableLeads = daysAgo % 2 === 0;
      records().push(
        floors(`w-${String(daysAgo)}`, daysAgo, wearableLeads ? 6 : 4, WEARABLE),
        floors(`p-${String(daysAgo)}`, daysAgo, wearableLeads ? 4 : 6, PHONE),
      );
    }

    const items = await findings(range);

    // Was nine findings, one for every day the lead changed.
    expect(items.filter((item) => item.kind === "source_switch")).toStrictEqual([]);
    expect(envelope(await call("data_quality", range)).rules).toMatchObject({
      sourceSwitchMaxPreviousShare: 0.1,
    });
  });

  it("fires when the app that supplied the type goes away, weighed by what was recorded", async () => {
    for (let daysAgo = 10; daysAgo >= 6; daysAgo -= 1) {
      records().push(
        // The wearable supplies it; the phone writes many small records beside it.
        floors(`w-${String(daysAgo)}`, daysAgo, 9, WEARABLE),
        floors(`p-${String(daysAgo)}a`, daysAgo, 1, PHONE),
        floors(`p-${String(daysAgo)}b`, daysAgo, 1, PHONE),
        floors(`p-${String(daysAgo)}c`, daysAgo, 1, PHONE),
      );
    }
    // Then the wearable is gone and the phone carries on.
    for (let daysAgo = 5; daysAgo >= 1; daysAgo -= 1) {
      records().push(floors(`p-${String(daysAgo)}`, daysAgo, 3, PHONE));
    }

    const items = await findings(range);

    // By record count the phone "led" all along and nothing would be found.
    expect(items.filter((item) => item.kind === "source_switch")).toStrictEqual([
      expect.objectContaining({
        date: date(DAY - 5 * DAY_MS),
        from: WEARABLE,
        to: PHONE,
        previousShare: 0,
      }),
    ]);
  });
});

describe("data_quality reads suspect hours in runs", () => {
  it("opens two adjacent suspect hours with one read", async () => {
    records().push(
      heartRate("hr-bad-1", at(20), [[0, 230]]),
      heartRate("hr-bad-2", at(21), [[0, 231]]),
    );
    world.state.hc.calls.length = 0;

    const items = await findings({ start: iso(at(19)), end: iso(at(23)), types: ["HeartRate"] });

    expect(items.map((item) => item.maxValue)).toStrictEqual([230, 231]);
    expect(world.state.hc.calls.filter((entry) => entry.reader === "records")).toStrictEqual([
      { reader: "records", type: "HeartRate", startMs: at(20), endMs: at(22) },
    ]);
  });
});

const sparse = (count: number, everyMs: number): HrMinutePoint[] =>
  Array.from({ length: count }, (_unused, index) => ({
    t: Date.UTC(2021, 0, 1) + index * everyMs,
    n: 1,
    min: 60,
    max: 60,
    mean: 60,
  }));

describe("resampling a minute series", () => {
  it("finds the width for a sparse series over years at once, not by counting up", () => {
    // 7,300 points six hours apart: five years. Climbing the factor by one took 90 s.
    const points = sparse(7300, 6 * HOUR_MS);
    const started = performance.now();

    const result = resampleMinutes(points, MINUTE_MS, 5);

    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.points.length).toBeLessThanOrEqual(5);
    expect(result.points.reduce((sum, point) => sum + point.n, 0)).toBe(7300);
    expect(result).toMatchObject({ decimated: true, totalPoints: 7300 });
    expect(result.decimation).toBe((result.bucketMs ?? 0) / MINUTE_MS);
  });

  it("puts a decimated series on a width a person would choose", () => {
    // A week of minutes into 2,000 points needs 5.04 minutes: ten is the next rung.
    const week = resampleMinutes(sparse(7 * 24 * 60, MINUTE_MS), MINUTE_MS, 2000);
    // A month of hours into 100 points needs 7.2 hours: twelve.
    const month = resampleMinutes(sparse(30 * 24, HOUR_MS), HOUR_MS, 100);

    expect(week).toMatchObject({ bucketMs: 10 * MINUTE_MS, decimation: 10 });
    expect(week.points).toHaveLength(1008);
    expect(month).toMatchObject({ bucketMs: 12 * HOUR_MS, decimation: 12 });
    expect(month.points).toHaveLength(60);
  });

  it("leaves a series that fits alone", () => {
    expect(resampleMinutes(sparse(10, MINUTE_MS), MINUTE_MS, 10)).toMatchObject({
      bucketMs: MINUTE_MS,
      decimated: false,
      decimation: 1,
      totalPoints: 10,
    });
  });
});

describe("hr_series with two series", () => {
  it("says how each was resampled, and no single figure when they differ", async () => {
    // The wearable has forty minutes here; the cuff one reading.
    const range = { start: iso(at(8, 20)), end: iso(at(9, 5)), origins: [CUFF, WEARABLE] };

    const answer = await call("hr_series", { ...range, max_points: 10 });
    const body = envelope(answer);

    // Was `decimation: 4` and `bucketMs` for both, though the cuff's is not decimated.
    expect(body.series).toStrictEqual([
      { bucketMs: 60_000, decimated: false, decimation: 1, totalPoints: 1, points: 1 },
      { bucketMs: 300_000, decimated: true, decimation: 5, totalPoints: 40, points: 8 },
    ]);
    expect(body).toMatchObject({ decimated: true, decimation: null, bucketMs: null });
    expect(answer.warnings).toContain("hr_series_decimated:5");
  });
});

describe("blood_pressure's pulse", () => {
  it("reads heart rate only for the hours a reading falls in", async () => {
    records().push(
      instantRecord(
        "bp-old",
        "BloodPressure",
        at(9) - 20 * DAY_MS,
        { systolic: 118, diastolic: 76 },
        { origin: CUFF },
      ),
    );
    world.state.hc.calls.length = 0;

    await call("blood_pressure", { start: date(DAY - 21 * DAY_MS), end: TODAY });

    // Was one read of every hour between the first reading and the last: twenty days.
    expect(world.state.hc.calls.filter((entry) => entry.reader === "hrMinutes")).toStrictEqual([
      { reader: "hrMinutes", startMs: at(9) - 20 * DAY_MS, endMs: at(10) - 20 * DAY_MS },
      { reader: "hrMinutes", startMs: at(9), endMs: at(10) },
    ]);
  });
});

describe("daily_summary's arguments", () => {
  it.each([
    ["`end` without `start`", { end: TODAY }, "`end` needs `start`"],
    ["a range that ends before it starts", { start: TODAY, end: YESTERDAY }, "not after `start`"],
    ["`date` beside a range", { date: TODAY, start: YESTERDAY }, "not both"],
  ])("refuses %s", async (_name, args, detail) => {
    const answer = await call("daily_summary", args);

    // Was an answer for today, or for no day at all.
    expect(answer).toMatchObject({ isError: true, error: "invalid_range" });
    expect(answer.text).toContain(detail);
  });

  it("still takes `start` alone, up to now", async () => {
    const answer = await call("daily_summary", { start: YESTERDAY, ...EVERYTHING });

    // The fake clock is the first instant of the next day, which has not begun.
    expect(answer.items.map((item) => item.date)).toStrictEqual([YESTERDAY, TODAY]);
  });
});

describe("a range given backwards", () => {
  const backwards = { start: iso(at(10)), end: iso(at(9)) };

  it.each([
    "hr_series",
    "hr_events",
    "blood_pressure",
    "sleep_sessions",
    "exercise_sessions",
    "data_quality",
  ])("is refused by %s, not answered empty", async (tool) => {
    expect(await call(tool, backwards)).toMatchObject({ isError: true, error: "invalid_range" });
  });
});

describe("a cursor over a store that has changed", () => {
  it.each([
    ["hr_series", { start: iso(at(8)), end: iso(at(9)) }],
    ["blood_pressure", { ...RANGE, group_sessions: false }],
    ["exercise_sessions", RANGE],
    ["daily_summary", RANGE],
    ["data_quality", RANGE],
  ])("%s answers cursor_expired after an upload", async (tool, args) => {
    const first = await call(tool, { ...args, limit: 1 });
    const { cursor } = envelope(first);
    const sameStore = await call(tool, { ...args, limit: 1, cursor });
    const [phone] = world.state.hc.devices;
    if (phone === undefined) throw new Error("one phone");
    phone.lastUploadAt = NOW - 1;

    const stale = await call(tool, { ...args, limit: 1, cursor });

    expect(first.truncated).toBe(true);
    expect(sameStore.isError).toBe(false);
    expect(stale).toMatchObject({ isError: true, error: "cursor_expired" });
  });
});

describe("a rule whose context type is withheld", () => {
  it("is not applied, does not read the type, and says so", async () => {
    world.state.rules = deny("Height");
    world.state.hc.calls.length = 0;

    const answer = await call("daily_summary", { ...RANGE, ...EVERYTHING });
    const day = answer.items[1];

    // The day's last weight is the one typed into a profile screen. Nothing
    // but the warning can say so: the height that would is withheld.
    expect(day?.weight).toBe(70);
    expect(day?.flags).not.toContain("weight_profile_artefact_excluded");
    expect(answer.warnings).toContain("weight_artefact_rule_not_applied");
    expect(answer.warnings).not.toContain("resting_hr_cuff_rule_not_applied");
    expect(world.state.hc.calls.some((entry) => entry.type === "Height")).toBe(false);
  });

  it("warns the same way from hc_aggregate, where the weight is then the minimum", async () => {
    world.state.rules = deny("Height");

    const answer = await call("hc_aggregate", { type: "Weight", ...RANGE, metrics: ["min"] });

    expect(answer.items[1]).toMatchObject({ values: { weight: { min: 70 } } });
    expect(answer.warnings).toContain("weight_artefact_rule_not_applied");
  });

  it("applies when the policy allows it: the profile weight is out, and counted", async () => {
    const answer = await call("hc_aggregate", { type: "Weight", ...RANGE, metrics: ["min", "n"] });
    const kept = await call("hc_aggregate", {
      type: "Weight",
      ...RANGE,
      metrics: ["min", "n"],
      exclude_artefacts: false,
    });

    expect(answer.items[1]).toMatchObject({
      values: { weight: { min: 70.5, n: 1 } },
      artefactsExcluded: 1,
    });
    expect(answer.warnings).toContain("hc_artefacts_excluded:1");
    expect(kept.items[1]).toMatchObject({ values: { weight: { min: 70, n: 2 } } });
    expect(kept.warnings).not.toContain("hc_artefacts_excluded:1");
  });
});

describe("hc_aggregate on sleep", () => {
  it("files the night on the day it ended, as sleep_sessions and daily_summary do", async () => {
    const aggregate = await call("hc_aggregate", { type: "SleepSession", ...RANGE });
    const nights = await call("sleep_sessions", RANGE);
    const days = await call("daily_summary", { ...RANGE, ...EVERYTHING });
    const [night] = nights.items;
    const [, day] = days.items;

    // Was on YESTERDAY: the date the night started.
    expect(aggregate.items.map((item) => [item.bucket, item.durationMs])).toStrictEqual([
      [YESTERDAY, 0],
      [TODAY, 8 * HOUR_MS],
    ]);
    expect(envelope(aggregate).bucketing).toBe("end_time");
    expect(night?.date).toBe(TODAY);
    expect(day).toMatchObject({ date: TODAY, sleep: { inBedMin: 480 } });
  });
});

describe("more than one phone in an answer", () => {
  beforeEach(async () => {
    // The same phone paired again: the old pairing was revoked, its data kept.
    const old = { ...device("dev_old_phone", "Old phone", NOW - 9000), revokedAt: NOW - 8000 };
    addDevice(world.state.hc, old, [
      interval("old-steps", "Steps", at(9), at(9, 1), { count: 500 }),
      workout("Old walk", "WALKING", at(18, 30), at(19, 10), WEARABLE),
    ]);
    await connect();
  });

  it.each([
    ["hc_aggregate", { type: "Steps", ...RANGE }],
    ["exercise_sessions", RANGE],
    ["daily_summary", RANGE],
  ])("is said by %s, since every total is then doubled", async (tool, args) => {
    const both = await call(tool, { ...args, ...EVERYTHING });
    const one = await call(tool, { ...args, ...EVERYTHING, devices: [DEVICE_ID] });

    expect(both.warnings).toContain("multiple_devices:2");
    expect(one.warnings.some((warning) => warning.startsWith("multiple_devices"))).toBe(false);
    expect(new Set(one.items.map((item) => item.healthSystemId))).toStrictEqual(new Set([SOURCE]));
  });

  it("is not said by the tools that list phones", async () => {
    const status = await call("hc_sync_status");

    expect(status.warnings.some((warning) => warning.startsWith("multiple_devices"))).toBe(false);
  });
});

const dayRollupTypes = (): string[] =>
  world.state.hc.calls.flatMap((entry) =>
    entry.reader === "dayRollups" && entry.type !== undefined ? [entry.type] : [],
  );
const pending = { queuedBatches: 0, parkedBatches: 0, dirty: 2, rezonePending: false };

describe("day rollups while the store has work outstanding", () => {
  it("are not used at all when the store cannot say which are waiting", async () => {
    world.state.hc.backlog.set(DEVICE_ID, pending);
    world.state.hc.calls.length = 0;

    await call("daily_summary", { date: YESTERDAY });

    expect(dayRollupTypes()).toStrictEqual([]);
  });

  it("are used for every type but the one whose days are waiting, when it can", async () => {
    world.state.hc.backlog.set(DEVICE_ID, pending);
    world.state.hc.dirtyDays = new Map([[DEVICE_ID, [{ type: "Steps", day: YESTERDAY }]]]);
    await connect();
    world.state.hc.calls.length = 0;

    await call("daily_summary", { date: YESTERDAY });
    const yesterday = dayRollupTypes();
    world.state.hc.calls.length = 0;
    // A day the mark does not touch: steps come from day rollups again.
    await call("hc_aggregate", { type: "Steps", start: TODAY, end: TODAY });

    // Was: none of them, for as long as any mark of any type existed.
    expect(yesterday).not.toContain("Steps");
    expect(yesterday).toStrictEqual(
      expect.arrayContaining(["Distance", "ActiveCaloriesBurned", "TotalCaloriesBurned"]),
    );
    expect(dayRollupTypes()).toStrictEqual(["Agg.Steps", "Steps"]);
  });

  it("are not used while a change of zone is being rebuilt, whatever the marks say", async () => {
    world.state.hc.backlog.set(DEVICE_ID, { ...pending, rezonePending: true });
    world.state.hc.dirtyDays = new Map();
    await connect();
    world.state.hc.calls.length = 0;

    await call("daily_summary", { date: YESTERDAY });

    expect(dayRollupTypes()).toStrictEqual([]);
  });

  it("are used beside parked marks, which are reported and are not 'pending'", async () => {
    world.state.hc.backlog.set(DEVICE_ID, { ...pending, dirty: 0, parkedMarks: 4 });
    world.state.hc.calls.length = 0;

    const answer = await call("daily_summary", { date: YESTERDAY });

    // Was: `hc_store_pending` for ever, and every aggregate sent to hour rollups.
    expect(answer.warnings).toContain(`hc_rollups_parked:${SOURCE}:4`);
    expect(answer.warnings).not.toContain(`hc_store_pending:${SOURCE}`);
    expect(dayRollupTypes()).toContain("Steps");
  });
});
