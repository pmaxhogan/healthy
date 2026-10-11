// `field` rules on a paired phone's data: one measurement, every spelling,
// every tool.
//
// A phone's measurement is spelled several ways (`systolic`, `data.systolic`,
// `values.systolic.mean`, `readings[].systolic`, `bloodPressure.systolic`) and
// lands on rows of several types (a night's row carries heart rate). What is
// pinned here, against the real tools over an in-memory store:
//
//   - a rule on a SOURCE type removes that type's data from rows of other
//     types (`hc:HeartRate` / `hr` empties the night's heart rate);
//   - a rule in any one spelling removes all of them, on every tool;
//   - for EVERY numeric field of every record type the rollups know, a rule on
//     its plain name leaves the value nowhere in any tool's serialised answer;
//   - a rule that could remove nothing is refused when it is saved, with a
//     sentence saying why.
//
// Everything is synthetic. The exhaustive test plants one record per type
// whose every numeric field holds a number that appears nowhere else, so
// "is it gone" is a search of the answer's text.

import { beforeEach, describe, expect, it } from "vitest";

import { HC_RECORD_TYPES } from "../../../../src/hc/record-types.ts";
import { ROLLUP_FIELD_TABLE } from "../../../../src/hc/rollup/hour.ts";
import { buildRules } from "../../../../src/policy/rules.ts";
import { shapesForScope } from "../../../../src/policy/tree.ts";
import { checkFieldSpec } from "../../../../src/policy/validate.ts";
import {
  DEVICE_ID,
  HOUR_MS,
  MINUTE_MS,
  addDevice,
  device,
  emptyHc,
  hcWorld,
  interval,
} from "../hc-fake.ts";
import { NOW, callTool, connectTools, fakeDeps, fakeState } from "../helpers.ts";

import type { HcRecord } from "../../../../src/hc/wire.ts";
import type { PolicyRules } from "../../../../src/policy/rules.ts";
import type { FakeState } from "../helpers.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { FieldRuleSpec } from "@shared/types.ts";

const SOURCE = `device:${DEVICE_ID}`;
const NOW_MS = NOW * 1000;
const DAY = NOW_MS - 24 * HOUR_MS;
const date = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const RANGE = { start: date(DAY - 1), end: date(DAY) };

/** One `field` rule hiding `paths`, scoped as given. */
function hide(
  resourceType: string | null,
  paths: readonly string[],
  scope: { tool?: string; healthSystemId?: string } = {},
): PolicyRules {
  return buildRules([
    {
      rule_type: "field",
      target: JSON.stringify([resourceType, paths, scope]),
      effect: "hide",
      scope_tool: scope.tool ?? null,
      scope_resource: resourceType,
      scope_health_system: scope.healthSystemId ?? null,
      paths_json: JSON.stringify(paths),
    },
  ]);
}

const world: { state: FakeState; client: Client } = {
  state: undefined as unknown as FakeState,
  client: undefined as unknown as Client,
};

async function start(state: FakeState): Promise<void> {
  world.state = state;
  world.client = await connectTools(fakeDeps(state));
}

/** `args` with the byte budget lifted, on the tools that have one. */
function withoutBudget(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  return tool === "get_health_summary" ? args : { ...args, max_bytes: 100_000_000 };
}

/** A tool's rows, never cut by the byte budget. */
async function rows(
  tool: string,
  args: Record<string, unknown> = RANGE,
): Promise<Record<string, unknown>[]> {
  const answer = await callTool(world.client, tool, withoutBudget(tool, args));
  expect(answer.isError, answer.text).toBe(false);
  return answer.items;
}

describe("a rule on a source type reaches the rows that carry its data", () => {
  beforeEach(async () => {
    await start(fakeState({ hc: hcWorld(NOW) }));
  });

  it("removes the joined heart rate named under hc:HeartRate from nights, workouts and readings", async () => {
    const [nightBefore] = await rows("sleep_sessions");
    const [walkBefore] = await rows("exercise_sessions");
    const [sittingBefore] = await rows("blood_pressure");
    const before = { night: nightBefore, walk: walkBefore, sitting: sittingBefore };
    world.state.rules = hide("hc:HeartRate", ["hr", "pulse", "hrWake"]);

    const [night] = await rows("sleep_sessions");
    const [walk] = await rows("exercise_sessions");
    const [sitting] = await rows("blood_pressure");
    const answer = await callTool(world.client, "sleep_sessions", RANGE);

    expect(Object.keys(before.night ?? {})).toStrictEqual(expect.arrayContaining(["hr", "hrWake"]));
    expect(before.walk?.hr).toMatchObject({ mean: 128 });
    expect(before.sitting?.pulse).toBe(68);
    expect(Object.keys(night ?? {})).not.toStrictEqual(expect.arrayContaining(["hr"]));
    expect(night).not.toHaveProperty("hrWake");
    expect(night).toMatchObject({ asleepMin: 460, restingHr: 52 });
    expect(walk).not.toHaveProperty("hr");
    expect(walk).toMatchObject({ distance: 3000 });
    expect(sitting).not.toHaveProperty("pulse");
    expect(JSON.stringify(sitting)).not.toContain('"pulse"');
    expect(sitting).toMatchObject({ systolic: 119 });
    expect(answer.warnings).toContain("policy_field_removed:hc:HeartRate.hr");
  });

  it("removes every figure derived from the type when the rule names the type's own field", async () => {
    world.state.rules = hide("hc:HeartRate", ["bpm"]);

    const [night] = await rows("sleep_sessions");
    const [walk, forgotten] = await rows("exercise_sessions");
    const [sitting] = await rows("blood_pressure");
    const [point] = await rows("hr_series");
    const [event] = await rows("hr_events");

    expect(night).not.toHaveProperty("hr");
    expect(night).not.toHaveProperty("hrWake");
    expect(walk).not.toHaveProperty("hr");
    // Read off heart rate and steps, so it goes with either.
    expect(forgotten).not.toHaveProperty("likelyLeftRunning");
    expect(JSON.stringify(sitting)).not.toContain('"pulse"');
    expect(new Set(Object.keys(point ?? {}))).toStrictEqual(
      new Set(["healthSystemId", "n", "origin", "resourceType", "t"]),
    );
    expect(event).not.toHaveProperty("peakBpm");
    expect(event).not.toHaveProperty("baselineBpm");
    expect(event).toHaveProperty("durationS");
  });

  it("removes steps from a day, whose rows are not tagged hc:Steps at all", async () => {
    world.state.rules = hide("hc:Steps", ["steps"]);

    const [, day] = await rows("daily_summary");
    const [walk] = await rows("exercise_sessions");

    expect(day).not.toHaveProperty("steps");
    expect(day).toMatchObject({ resourceType: "hc:DailySummary", distance: 3000 });
    expect(walk).not.toHaveProperty("steps");
  });

  it("is scoped: one tool, one phone, and no other type's rows", async () => {
    world.state.rules = hide("hc:HeartRate", ["hr"], { tool: "sleep_sessions" });
    const [walk] = await rows("exercise_sessions");
    const [night] = await rows("sleep_sessions");
    world.state.rules = hide("hc:HeartRate", ["hr"], { healthSystemId: "device:another" });
    const [other] = await rows("sleep_sessions");
    world.state.rules = hide("hc:HeartRate", ["hr"], { healthSystemId: SOURCE });
    const [mine] = await rows("sleep_sessions");
    // A rule on respiratory rate has nothing to say about the night's heart rate.
    world.state.rules = hide("hc:RespiratoryRate", ["rate"]);
    const [breathing] = await rows("sleep_sessions");

    expect(walk).toHaveProperty("hr");
    expect(night).not.toHaveProperty("hr");
    expect(other).toHaveProperty("hr");
    expect(mine).not.toHaveProperty("hr");
    expect(breathing).toHaveProperty("hr");
    expect(breathing).not.toHaveProperty("respiratoryRate");
  });
});

/** Every place the day's systolic pressure appears, across the tools. */
async function systolicEverywhere(): Promise<unknown[]> {
  const [sitting] = await rows("blood_pressure");
  const [reading] = await rows("blood_pressure", { ...RANGE, group_sessions: false });
  const [record] = await rows("hc_records", { type: "BloodPressure", ...RANGE });
  const [, bucket] = await rows("hc_aggregate", { type: "BloodPressure", ...RANGE });
  const [, day] = await rows("daily_summary");
  const summary = await rows("get_health_summary", {
    jq: '.[] | select(.section == "latest_blood_pressure")',
  });
  const readings = (sitting?.readings ?? []) as Record<string, unknown>[];
  return [
    sitting?.systolic,
    readings[0]?.systolic,
    reading?.systolic,
    (record?.data as Record<string, unknown>).systolic,
    (bucket?.values as Record<string, unknown>).systolic,
    (day?.bloodPressure as Record<string, unknown>).systolic,
    summary[0]?.systolic,
  ];
}

describe("a rule in one spelling removes every spelling", () => {
  beforeEach(async () => {
    await start(fakeState({ hc: hcWorld(NOW) }));
  });

  it("finds the value in seven places with no rule", async () => {
    const found = await systolicEverywhere();

    expect(found.every((value) => value !== undefined)).toBe(true);
  });

  it.each([
    ["systolic"],
    ["data.systolic"],
    ["values.systolic"],
    ["values.systolic.mean"],
    ["readings[].systolic"],
    ["bloodPressure.systolic"],
  ])("written as %s", async (path) => {
    const spec: FieldRuleSpec = {
      effect: "hide",
      tool: null,
      resourceType: "hc:BloodPressure",
      healthSystemId: null,
      paths: [path],
    };
    world.state.rules = hide("hc:BloodPressure", [path]);

    const found = await systolicEverywhere();
    const [, day] = await rows("daily_summary");
    const [sitting] = await rows("blood_pressure");

    expect(checkFieldSpec(spec, new Set()).ok).toBe(true);
    expect(found.filter((value) => value !== undefined)).toStrictEqual([]);
    // The other number of the same reading stays, everywhere.
    expect(day?.bloodPressure).toMatchObject({ diastolic: 78, readings: 2 });
    expect(sitting).toMatchObject({ diastolic: 78 });
  });

  it("applies a rule on every type to each row's own spellings too", async () => {
    world.state.rules = hide(null, ["systolic"]);

    const found = await systolicEverywhere();

    expect(found.filter((value) => value !== undefined)).toStrictEqual([]);
  });

  it("takes the day's weighings with the weight, and a finding's value", async () => {
    world.state.rules = hide("hc:Weight", ["weight"]);

    const [, day] = await rows("daily_summary");
    const findings = await rows("data_quality", { ...RANGE, types: ["Weight", "Height"] });

    expect(day).not.toHaveProperty("weight");
    expect(day?.weighings).toStrictEqual([
      expect.not.objectContaining({ weight: expect.anything() }),
      expect.not.objectContaining({ weight: expect.anything() }),
    ]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => !Object.hasOwn(finding, "value"))).toBe(true);
  });

  it("does not pad total calories from a basal metabolic rate the policy hides", async () => {
    world.state.rules = hide("hc:BasalMetabolicRate", ["bmr"]);

    const answer = await callTool(world.client, "hc_aggregate", {
      type: "TotalCaloriesBurned",
      ...RANGE,
      bmr_fill: true,
    });

    expect(answer.items.every((item) => !Object.hasOwn(item, "bmrFillKcal"))).toBe(true);
    expect((answer.items[1]?.values as { energy: { sum: number } }).energy.sum).toBe(1000);
    expect(answer.warnings).toContain("policy_field_removed:hc:BasalMetabolicRate.bmr");
  });
});

// --- every numeric field of every record type ------------------------------

/** Values a rule would otherwise flag as artefacts and drop, which would make the test vacuous. */
const PLAUSIBLE: Readonly<Record<string, number>> = {
  "HeartRate.bpm": 151.5,
  "Speed.speed": 7.25,
  "FloorsClimbed.floors": 3.5,
};

interface Planted {
  type: string;
  field: string;
  value: number;
}

/** One sentinel per numeric field of every type the rollups know. */
function plant(): { planted: Planted[]; records: HcRecord[] } {
  const planted: Planted[] = [];
  const records: HcRecord[] = [];
  const at = DAY + 10 * HOUR_MS;
  let next = 300.5;
  for (const spec of ROLLUP_FIELD_TABLE) {
    const data: Record<string, unknown> = {};
    for (const field of spec.fields) {
      const value = PLAUSIBLE[`${spec.type}.${field.name}`] ?? next;
      next += 1;
      planted.push({ type: spec.type, field: field.name, value });
      if (field.kind === "scalar") {
        data[field.name] = value;
        continue;
      }
      const [list = ""] = field.path.split("[].", 1);
      data[list] = [{ t: at + 30_000, [field.name]: value }];
    }
    if (spec.fields.length === 0) continue;
    records.push(interval(`one-${spec.type}`, spec.type, at, at + MINUTE_MS, data));
  }
  // A night and a workout around them, so the joins have rows to land on.
  records.push(
    interval("night", "SleepSession", at - 30 * MINUTE_MS, at + 30 * MINUTE_MS, {
      stages: [{ start: at - 30 * MINUTE_MS, end: at + 30 * MINUTE_MS, stage: "LIGHT" }],
    }),
    interval("workout", "ExerciseSession", at - HOUR_MS, at + HOUR_MS, { exerciseType: "WALKING" }),
  );
  return { planted, records };
}

const { planted: PLANTED, records: PLANTED_RECORDS } = plant();

/** The whole serialised answer of every tool that could carry a field of `type`. */
async function everyAnswer(type: string): Promise<string> {
  const typed = { type, ...RANGE };
  const calls: [string, Record<string, unknown>][] = [
    ["hc_coverage", {}],
    ["hc_sync_status", {}],
    ["hc_records", { ...typed, include_metadata: true }],
    ["hc_records", { ...typed, order: "desc" }],
    [
      "hc_aggregate",
      { ...typed, metrics: ["sum", "mean", "min", "max", "n", "first", "last", "records"] },
    ],
    ["hc_aggregate", { ...typed, bucket: "hour", origin_mode: "all_separately" }],
    ["hc_aggregate", { ...typed, bucket: "15min", metrics: ["max"] }],
    ["hr_series", RANGE],
    ["hr_series", { ...RANGE, resolution: "raw" }],
    ["hr_series", { ...RANGE, resolution: "5min" }],
    ["hr_events", RANGE],
    ["sleep_sessions", { ...RANGE, include_stages: true }],
    ["exercise_sessions", RANGE],
    ["blood_pressure", RANGE],
    ["blood_pressure", { ...RANGE, group_sessions: false, dedupe: false }],
    ["daily_summary", RANGE],
    ["data_quality", RANGE],
    ["get_health_summary", {}],
  ];
  const texts: string[] = [];
  for (const [tool, args] of calls) {
    const answer = await callTool(world.client, tool, withoutBudget(tool, args));
    expect(answer.isError, `${tool}: ${answer.text}`).toBe(false);
    texts.push(`${tool}\u{1}${JSON.stringify(answer.items)}`);
  }
  return texts.join("\n");
}

/** True when `value` appears in `text` as a number of its own, not inside another. */
function holds(text: string, value: number): boolean {
  const pattern = String(value).replace(".", String.raw`\.`);
  return new RegExp(String.raw`(?<![\d.])${pattern}(?![\d.])`, "u").test(text);
}

describe("every numeric field of every record type", () => {
  beforeEach(async () => {
    const hc = emptyHc();
    addDevice(hc, device(DEVICE_ID, "Test phone", NOW - 600), PLANTED_RECORDS);
    await start(fakeState({ hc }));
  });

  it("plants a number that is unique to its field", () => {
    expect(new Set(PLANTED.map((entry) => entry.value)).size).toBe(PLANTED.length);
    expect(PLANTED.length).toBeGreaterThan(70);
  });

  it.each(PLANTED)("$type.$field is gone from every tool once a rule names it", async (entry) => {
    const { type, field, value } = entry;
    const before = await everyAnswer(type);
    world.state.rules = hide(`hc:${type}`, [field]);
    const after = await everyAnswer(type);

    // Present before, or the test would prove nothing.
    expect(holds(before, value), `${type}.${field} is not in any answer to begin with`).toBe(true);
    const leaks = after
      .split("\n")
      .filter((text) => holds(text, value))
      .map((text) => text.split("\u{1}", 1)[0]);
    expect(leaks, `${type}.${field} = ${String(value)} still in`).toStrictEqual([]);
  });

  it.each(PLANTED)("$type.$field is a rule the builder accepts", ({ type, field }) => {
    const check = checkFieldSpec(
      {
        effect: "hide",
        tool: null,
        resourceType: `hc:${type}`,
        healthSystemId: null,
        paths: [field],
      },
      new Set(),
    );

    expect(check, JSON.stringify(check)).toMatchObject({ ok: true });
  });
});

// --- refusing a rule that could reach nothing ------------------------------

function check(resourceType: string, paths: string[], tool: string | null = null) {
  return checkFieldSpec(
    { effect: "hide", tool, resourceType, healthSystemId: null, paths },
    new Set(),
  );
}

function refusal(resourceType: string, paths: string[], tool: string | null = null): string {
  const result = check(resourceType, paths, tool);
  if (result.ok) throw new Error(`accepted ${JSON.stringify(result.spec)}`);
  return result.issues.join("\n");
}

describe("a rule that could remove nothing is refused", () => {
  it("accepts a joined field under its source type, and a type's own field in any spelling", () => {
    expect(check("hc:HeartRate", ["hr", "pulse", "hrWake"])).toMatchObject({ ok: true });
    expect(check("hc:Steps", ["steps"])).toMatchObject({ ok: true });
    expect(check("hc:Steps", ["count"])).toMatchObject({ ok: true });
    expect(check("hc:HeartRate", ["data.samples[].bpm"])).toMatchObject({ ok: true });
    expect(check("hc:SkinTemperature", ["sleep.skinTempDelta"])).toMatchObject({ ok: true });
    expect(check("hc:SleepSession", ["stages", "title"])).toMatchObject({ ok: true });
    expect(check("hc:SexualActivity", ["protectionUsed"])).toMatchObject({ ok: true });
    expect(check("hc:DailySummary", ["flags", "sleep.naps"])).toMatchObject({ ok: true });
  });

  it("refuses a field the type does not have, saying so and what it does have", () => {
    const message = refusal("hc:HeartRate", ["appVersion"]);

    expect(message).toContain('"appVersion" would hide nothing');
    expect(message).toContain("hc:HeartRate");
    expect(message).toContain("samples");
    expect(message).toContain("hr");
  });

  it("refuses another type's joined field, and suggests a near miss", () => {
    expect(refusal("hc:Steps", ["hr"])).toContain("would hide nothing");
    expect(refusal("hc:HeartRate", ["steps"])).toContain("would hide nothing");
    expect(refusal("hc:BloodPressure", ["sistolic"])).toContain('Did you mean "systolic"?');
    expect(refusal("hc:Weight", ["data.wieght"])).toContain("would hide nothing");
  });

  it("refuses a field in a tool that never carries that type's data", () => {
    expect(refusal("hc:Steps", ["count"], "blood_pressure")).toContain(
      "blood_pressure never returns hc:Steps items",
    );
    expect(refusal("hc:HeartRate", ["hr"], "hc_sync_status")).toContain("would hide nothing");
    expect(check("hc:HeartRate", ["hr"], "sleep_sessions")).toMatchObject({ ok: true });
    expect(check("hc:HeartRate", ["pulse"], "blood_pressure")).toMatchObject({ ok: true });
    // `pulse` is heart rate by another name, so in a tool with no pulse it still
    // names the heart rate that tool does carry.
    expect(check("hc:HeartRate", ["pulse"], "sleep_sessions")).toMatchObject({ ok: true });
    expect(refusal("hc:RespiratoryRate", ["pulse"], "sleep_sessions")).toContain(
      "would hide nothing",
    );
  });

  it("reaches only the shapes whose rows can carry the type or its data", () => {
    const heart = shapesForScope({ tool: null, resourceType: "hc:HeartRate" });
    const steps = shapesForScope({ tool: "blood_pressure", resourceType: "hc:Steps" });
    const pulse = shapesForScope({ tool: "blood_pressure", resourceType: "hc:HeartRate" });

    // The phone's sync row carries no type: no typed rule reaches it.
    expect(heart).not.toContain("hc:device");
    expect(heart).toStrictEqual(
      expect.arrayContaining(["hc:hr_point", "hc:hr_event", "hc:sleep", "hc:exercise", "hc:day"]),
    );
    expect(heart.every((id) => id.startsWith("hc:"))).toBe(true);
    expect(steps).toStrictEqual([]);
    expect(pulse).toStrictEqual(["hc:bp_session", "hc:bp_reading"]);
  });

  it("offers every mapped record type, the ones with nothing numeric included", () => {
    for (const type of ["SexualActivity", "MenstruationFlow", "CervicalMucus", "OvulationTest"]) {
      expect(HC_RECORD_TYPES).toContain(type);
      // Its whole `data` can be hidden; a field it does not have cannot.
      expect(check(`hc:${type}`, ["data"]).ok, type).toBe(true);
      expect(check(`hc:${type}`, ["systolic"]).ok, type).toBe(false);
    }
  });
});
