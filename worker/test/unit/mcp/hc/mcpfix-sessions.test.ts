// Exercise rows: the left-running flag judged against the session's own active
// phase, and steps as a whole number.
//
// The first rule only fires on a tail AT REST. A session forgotten while its
// wearer stays on their feet ends with a raised pulse and a few steps, so it
// is also judged against what the session itself looked like when it was a
// workout. Both rules are applied when the summary is built, so the flag and
// its reason are stored and no tool reads anything to find them. The two sessions the rule has to tell apart:
//
//   - a workout that stopped and ran on: its last half hour far below its
//     busiest in heart rate, and next to no cadence where there was plenty;
//   - a long steady hike: an easier last half hour than its climb, and still
//     walking.
//
// Everything is synthetic: invented values, RFC 2606 style package names.

import { beforeEach, describe, expect, it } from "vitest";

import { isLikelyLeftRunning, tailBelowActivePhase } from "../../../../src/hc/rules.ts";
import { leftRunningReasons } from "../../../../src/mcp/hc/sessions.ts";
import { buildRules } from "../../../../src/policy/rules.ts";
import {
  HOUR_MS,
  MINUTE_MS,
  PHONE,
  addDevice,
  device,
  emptyHc,
  fakeHcReads,
  heartRate,
  interval,
} from "../hc-fake.ts";
import { NOW, callTool, connectTools, fakeDeps, fakeState } from "../helpers.ts";

import type { HcRecord } from "../../../../src/hc/wire.ts";
import type { FakeHc } from "../hc-fake.ts";
import type { FakeState, ToolAnswer } from "../helpers.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const DEVICE = "dev_sessions";
const NOW_MS = NOW * 1000;
/** The invented day: the UTC day that ends at the fake clock. */
const DAY = NOW_MS - 24 * HOUR_MS;
const at = (hour: number, minute = 0): number => DAY + hour * HOUR_MS + minute * MINUTE_MS;
const date = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const RANGE = { start: date(DAY), end: date(DAY) };

/** One heart-rate sample a minute over `[fromMs, toMs)`, at `bpm(minute)`. */
function pulse(id: string, fromMs: number, toMs: number, bpm: (minute: number) => number) {
  const samples: [number, number][] = [];
  for (let minute = 0; fromMs + minute * MINUTE_MS < toMs; minute += 1) {
    samples.push([minute * MINUTE_MS, bpm(minute)]);
  }
  return heartRate(id, fromMs, samples);
}

/** A Steps record every five minutes over `[fromMs, toMs)`, at `perMinute(minute)` steps a minute. */
function walking(
  id: string,
  fromMs: number,
  toMs: number,
  perMinute: (minute: number) => number,
): HcRecord[] {
  const records: HcRecord[] = [];
  for (let minute = 0; fromMs + minute * MINUTE_MS < toMs; minute += 5) {
    const start = fromMs + minute * MINUTE_MS;
    records.push(
      interval(`${id}-${String(minute)}`, "Steps", start, start + 5 * MINUTE_MS, {
        count: perMinute(minute) * 5,
      }),
    );
  }
  return records;
}

/** A four-hour workout that stopped after two and a half: the wearer stayed up and about. */
const RAN_ON = { startMs: at(1), endMs: at(5) };
/** A five-hour hike: a climb early on, a steady walk to the very end. */
const HIKE = { startMs: at(8), endMs: at(13) };

function sessionRecords(): HcRecord[] {
  return [
    interval("ran-on", "ExerciseSession", RAN_ON.startMs, RAN_ON.endMs, {
      exerciseType: "OTHER_WORKOUT",
      title: "Class",
    }),
    // 140 while it was a workout, 118 afterwards: above any resting rate.
    pulse("hr-ran-on", RAN_ON.startMs, RAN_ON.endMs, (minute) => (minute < 150 ? 140 : 118)),
    // Plenty of steps in the workout, ten a minute after: 300 in the last half hour.
    ...walking("st-ran-on", RAN_ON.startMs, RAN_ON.endMs, (minute) => (minute < 150 ? 100 : 10)),

    interval("hike", "ExerciseSession", HIKE.startMs, HIKE.endMs, {
      exerciseType: "HIKING",
      title: "Ridge",
    }),
    // A climb at 150 for forty minutes, then 125 all the way back.
    pulse("hr-hike", HIKE.startMs, HIKE.endMs, (minute) =>
      minute >= 60 && minute < 100 ? 150 : 125,
    ),
    ...walking("st-hike", HIKE.startMs, HIKE.endMs, () => 90),
  ];
}

const world: { state: FakeState; client: Client; hc: FakeHc } = {
  state: undefined as unknown as FakeState,
  client: undefined as unknown as Client,
  hc: undefined as unknown as FakeHc,
};

beforeEach(async () => {
  world.hc = emptyHc();
  addDevice(world.hc, device(DEVICE, "Session phone", NOW - 600), sessionRecords());
  world.state = fakeState({ hc: world.hc });
  world.client = await connectTools(fakeDeps(world.state));
});

const call = (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> =>
  callTool(world.client, name, { max_bytes: 1_000_000, ...args });

describe("a long session judged against its own active phase", () => {
  it("flags the workout that stopped and ran on, though its tail is not at rest", async () => {
    const answer = await call("exercise_sessions", RANGE);
    const ranOn = answer.items.find((item) => item.id === "ran-on");

    expect(ranOn).toMatchObject({
      overThreeHours: true,
      likelyLeftRunning: true,
      leftRunningReason: "tail_below_active_phase",
      // A flag only: the session keeps its times and its duration.
      durationMin: 240,
    });
  });

  it("leaves a long steady hike alone", async () => {
    const answer = await call("exercise_sessions", RANGE);
    const hike = answer.items.find((item) => item.id === "hike");

    expect(hike).toMatchObject({
      overThreeHours: true,
      likelyLeftRunning: false,
      leftRunningReason: null,
      durationMin: 300,
    });
  });

  it("is what the resting rule misses, and is stored with the summary all the same", async () => {
    const stored = await fakeHcReads(world.hc).exerciseSessions({
      deviceId: DEVICE,
      startMs: DAY,
      endMs: NOW_MS,
    });

    // Neither session ends at rest ...
    expect(stored.map(({ session }) => isLikelyLeftRunning(session, [], []))).toStrictEqual([
      true,
      true,
    ]);
    // ... (with nothing to judge by, duration alone would flag both) and with
    // their heart rate and steps only the one that ran on is flagged, by the
    // second rule, on the summary itself.
    expect(
      stored.map(({ session }) => [session.likelyLeftRunning, session.leftRunningReason]),
    ).toStrictEqual([
      [true, "tail_below_active_phase"],
      [false, null],
    ]);
  });

  it("reports it in `data_quality` with the rule that found it", async () => {
    const answer = await call("data_quality", { ...RANGE, types: ["ExerciseSession"] });
    const kinds = answer.items.map((item) => [item.kind, item.start, item.reason ?? null]);

    expect(kinds).toStrictEqual([
      ["long_session", new Date(RAN_ON.startMs).toISOString().replace(".000Z", "+00:00"), null],
      [
        "likely_left_running",
        new Date(RAN_ON.startMs).toISOString().replace(".000Z", "+00:00"),
        "tail_below_active_phase",
      ],
      ["long_session", new Date(HIKE.startMs).toISOString().replace(".000Z", "+00:00"), null],
    ]);
  });

  it("names the stored rule when that is the one that fired", async () => {
    world.hc.records.get(DEVICE)?.push(
      // Four hours with nothing measured during them: duration alone decides.
      interval(
        "forgotten",
        "ExerciseSession",
        at(15),
        at(19),
        { exerciseType: "YOGA" },
        { origin: PHONE },
      ),
    );

    const answer = await call("exercise_sessions", RANGE);

    expect(answer.items.find((item) => item.id === "forgotten")).toMatchObject({
      likelyLeftRunning: true,
      leftRunningReason: "resting_tail",
    });
  });

  it("reads neither heart rate nor steps when a tool answers, whatever the policy says", async () => {
    await call("exercise_sessions", RANGE);
    await call("data_quality", { ...RANGE, types: ["ExerciseSession"] });

    const judged = world.hc.calls.filter(
      (entry) =>
        entry.reader === "hrMinutes" || (entry.reader === "records" && entry.type === "Steps"),
    );
    expect(judged).toStrictEqual([]);
  });

  it("agrees with `daily_summary` and `hc_aggregate` about the session that ran on", async () => {
    const days = await call("daily_summary", RANGE);
    const flagged = days.items.flatMap((day) =>
      (day.exercises as { likelyLeftRunning: boolean; durationMin: number }[]).filter(
        (workout) => workout.likelyLeftRunning,
      ),
    );

    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ durationMin: 240 });
    expect(
      days.items.some((day) => (day.flags as string[]).includes("exercise_likely_left_running")),
    ).toBe(true);
  });

  it("shows no flag when the policy withholds steps", async () => {
    world.state.rules = buildRules([{ rule_type: "resource", target: "hc:Steps" }]);

    const answer = await call("exercise_sessions", RANGE);
    const judged = world.hc.calls.filter(
      (entry) => entry.reader === "hrMinutes" || entry.type === "Steps",
    );

    expect(answer.items).toHaveLength(2);
    for (const item of answer.items) {
      expect(item).not.toHaveProperty("likelyLeftRunning");
      expect(item).not.toHaveProperty("leftRunningReason");
    }
    expect(judged).toStrictEqual([]);
  });

  it("only opens heart rate and steps for sessions over three hours", async () => {
    world.hc.records.set(DEVICE, [
      interval("short", "ExerciseSession", at(1), at(2), { exerciseType: "WALKING" }),
      pulse("hr-short", at(1), at(2), () => 120),
      ...walking("st-short", at(1), at(2), () => 100),
    ]);

    const answer = await call("exercise_sessions", RANGE);
    const judged = world.hc.calls.filter(
      (entry) => entry.reader === "hrMinutes" || entry.type === "Steps",
    );

    expect(answer.items).toHaveLength(1);
    expect(judged).toStrictEqual([]);
  });
});

/** Four hours of per-minute heart-rate means, at `bpm(minute)`. */
const minutes = (bpm: (minute: number) => number) =>
  Array.from({ length: 240 }, (_unused, minute) => ({
    t: minute * MINUTE_MS,
    mean: bpm(minute),
  }));

describe("tailBelowActivePhase", () => {
  const span = { startMs: 0, endMs: 4 * HOUR_MS };
  const dropped = minutes((minute) => (minute < 150 ? 140 : 118));
  const steps = (perMinute: (minute: number) => number) =>
    walking("steps", span.startMs, span.endMs, perMinute);

  it("fires when the tail is far below the busiest half hour in pulse and cadence", () => {
    expect(
      tailBelowActivePhase(
        span,
        dropped,
        steps((minute) => (minute < 150 ? 100 : 10)),
      ),
    ).toBe(true);
  });

  it("does not fire on an activity that never made steps: a ride, a swim", () => {
    expect(tailBelowActivePhase(span, dropped, [])).toBe(false);
    expect(
      tailBelowActivePhase(
        span,
        dropped,
        steps(() => 0),
      ),
    ).toBe(false);
  });

  it("does not fire while the wearer is still walking at the end", () => {
    expect(
      tailBelowActivePhase(
        span,
        dropped,
        steps(() => 90),
      ),
    ).toBe(false);
  });

  it("does not fire when the tail's pulse is within twenty of the busiest half hour", () => {
    const steady = minutes((minute) => (minute < 150 ? 130 : 115));

    expect(
      tailBelowActivePhase(
        span,
        steady,
        steps((minute) => (minute < 150 ? 100 : 10)),
      ),
    ).toBe(false);
  });

  it("does not fire without heart rate in the tail, or under three hours", () => {
    const cutOff = dropped.filter((minute) => minute.t < 200 * MINUTE_MS);
    const cadence = steps((minute) => (minute < 150 ? 100 : 10));

    expect(tailBelowActivePhase(span, cutOff, cadence)).toBe(false);
    expect(tailBelowActivePhase({ startMs: 0, endMs: 3 * HOUR_MS }, dropped, cadence)).toBe(false);
  });

  it("leaves a session longer than twelve hours to the clock", () => {
    const long = { startMs: 0, endMs: 13 * HOUR_MS };
    const stepsAll = walking("steps", long.startMs, long.endMs, (minute) =>
      minute < 150 ? 100 : 10,
    );

    expect(tailBelowActivePhase(long, dropped, stepsAll)).toBe(false);
  });
});

describe("leftRunningReasons", () => {
  it("reads the stored reason, and takes a flag without one for the first rule's", () => {
    const span = { origin: PHONE, startMs: 0, endMs: 4 * HOUR_MS };
    const reasons = leftRunningReasons([
      { id: "old", summary: { ...span, likelyLeftRunning: true } },
      {
        id: "new",
        summary: {
          ...span,
          likelyLeftRunning: true,
          leftRunningReason: "tail_below_active_phase" as const,
        },
      },
      { id: "fine", summary: { ...span, likelyLeftRunning: false, leftRunningReason: null } },
    ]);

    expect([...reasons]).toStrictEqual([
      ["old", "resting_tail"],
      ["new", "tail_below_active_phase"],
    ]);
  });
});

describe("steps on an exercise row", () => {
  it("are a whole number, rounded once after the sum", async () => {
    world.hc.records.set(DEVICE, [
      interval("stroll", "ExerciseSession", at(1), at(1, 30), { exerciseType: "WALKING" }),
      // Half of this record is before the session: 166.5 of its 333 steps count.
      interval("st-edge", "Steps", at(0, 55), at(1, 5), { count: 333 }),
      interval("st-in", "Steps", at(1, 10), at(1, 20), { count: 1000 }),
    ]);

    const stored = await fakeHcReads(world.hc).exerciseSessions({
      deviceId: DEVICE,
      startMs: DAY,
      endMs: NOW_MS,
    });
    const answer = await call("exercise_sessions", RANGE);

    expect(stored[0]?.session.steps).toBe(1166.5);
    expect(answer.items[0]).toMatchObject({ id: "stroll", steps: 1167 });
  });

  it("stay null when nothing counted steps", async () => {
    world.hc.records.set(DEVICE, [
      interval("swim", "ExerciseSession", at(1), at(1, 30), { exerciseType: "SWIMMING_POOL" }),
    ]);

    const answer = await call("exercise_sessions", RANGE);

    expect(answer.items[0]).toMatchObject({ id: "swim", steps: null });
  });
});
