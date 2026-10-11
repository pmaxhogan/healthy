// Where the exposure policy meets Health Connect's joined and derived data.
//
// A row of one record type can carry a number measured as another: a night's
// heart rate, a day's skin temperature, a reading's pulse. `JOINED_FIELDS` is
// the one table saying which field belongs to which type, and what is pinned
// here is that the table is COMPLETE and that it BITES:
//
//   - every field a joining tool really emits is in `JOINED_FIELDS` or in
//     `OWN_FIELDS`, read off the tools' actual output, so a field added to a
//     row without a decision about its type fails this file;
//   - for every (field, source type) in the table, denying that type removes
//     the field from every row, while the rows themselves stay;
//   - a platform aggregate (`Agg.Steps`) follows the type it aggregates.
//
// Everything is synthetic: the invented day of `hc-fake.ts`.

import { beforeEach, describe, expect, it } from "vitest";

import {
  JOINED_FIELDS,
  OWN_FIELDS,
  deniedJoins,
  policyResourceType,
  sourceTypeOf,
  stripJoined,
  typeAllowed,
} from "../../../../src/mcp/hc/policy.ts";
import { EMPTY_RULES, buildRules } from "../../../../src/policy/rules.ts";
import { DEVICE_ID, hcWorld } from "../hc-fake.ts";
import { NOW, callTool, connectTools, fakeDeps, fakeState } from "../helpers.ts";

import type { JoiningTool } from "../../../../src/mcp/hc/policy.ts";
import type { FakeState } from "../helpers.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const TOOLS = Object.keys(JOINED_FIELDS) as JoiningTool[];

/** The two UTC days up to the fake clock: the invented day and the one before. */
const RANGE = {
  start: new Date((NOW - 2 * 86_400) * 1000).toISOString().slice(0, 10),
  end: new Date((NOW - 1) * 1000).toISOString().slice(0, 10),
};

const deny = (...types: string[]) =>
  buildRules(types.map((type) => ({ rule_type: "resource" as const, target: `hc:${type}` })));

const world: { state: FakeState; client: Client } = {
  state: undefined as unknown as FakeState,
  client: undefined as unknown as Client,
};

beforeEach(async () => {
  world.state = fakeState({ hc: hcWorld(NOW) });
  world.client = await connectTools(fakeDeps(world.state));
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first segment of a field path: the parent of a nested field, or the field itself. */
function parentOf(path: string): string {
  return path.split(".", 1)[0] ?? path;
}

/** The parents a table names a nested field of: only those are looked inside. */
function nestedParents(tool: JoiningTool): Set<string> {
  const names = [...Object.keys(JOINED_FIELDS[tool]), ...OWN_FIELDS[tool]];
  return new Set(names.filter((name) => name.includes(".")).map((name) => parentOf(name)));
}

/** The paths one level into a parent: `parent.key` for each key of each object it holds. */
function childPaths(parent: string, value: unknown): string[] {
  const children = Array.isArray(value) ? (value as unknown[]) : [value];
  return children.flatMap((child) =>
    isObject(child) ? Object.keys(child).map((name) => `${parent}.${name}`) : [],
  );
}

/** `paths`, plus the parent of every nested one: a parent is there when one of its fields is. */
function withParents(paths: ReadonlySet<string>): Set<string> {
  const out = new Set(paths);
  for (const path of paths) out.add(parentOf(path));
  return out;
}

/** Every field path the rows carry: top-level keys, and one level into the named parents. */
function pathsOf(tool: JoiningTool, rows: readonly Record<string, unknown>[]): Set<string> {
  const parents = nestedParents(tool);
  const paths = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      const found = parents.has(key) ? childPaths(key, value) : [key];
      for (const path of found) paths.add(path);
    }
  }
  return paths;
}

/** Every row of a tool, in both of `blood_pressure`'s shapes. */
async function rowsOf(tool: JoiningTool): Promise<Record<string, unknown>[]> {
  const answer = await callTool(world.client, tool, { ...RANGE, max_bytes: 10_000_000 });
  expect(answer.isError, answer.text).toBe(false);
  if (tool !== "blood_pressure") return answer.items;
  const flat = await callTool(world.client, tool, { ...RANGE, group_sessions: false });
  return [...answer.items, ...flat.items];
}

describe("the field tables", () => {
  it.each(TOOLS)("name every field %s really emits", async (tool) => {
    const emitted = pathsOf(tool, await rowsOf(tool));
    const known = new Set<string>([...Object.keys(JOINED_FIELDS[tool]), ...OWN_FIELDS[tool]]);
    // A parent with nested entries is known through them.
    for (const parent of nestedParents(tool)) known.add(parent);

    expect([...emitted].filter((path) => !known.has(path))).toStrictEqual([]);
  });

  it.each(TOOLS)("list no field of %s as both joined and its own", (tool) => {
    const joined = new Set(Object.keys(JOINED_FIELDS[tool]));

    expect(OWN_FIELDS[tool].filter((field) => joined.has(field))).toStrictEqual([]);
  });

  it.each(TOOLS)("has every joined field of %s present in the fixture", async (tool) => {
    // Otherwise "the field is gone once denied" below would pass vacuously.
    const emitted = withParents(pathsOf(tool, await rowsOf(tool)));

    expect(Object.keys(JOINED_FIELDS[tool]).filter((field) => !emitted.has(field))).toStrictEqual(
      [],
    );
  });
});

const CASES = TOOLS.flatMap((tool) =>
  Object.entries(JOINED_FIELDS[tool] as Record<string, readonly string[]>).flatMap(
    ([field, types]) => types.map((type) => ({ tool, field, type })),
  ),
);

describe("a joined field follows its source type", () => {
  it.each(CASES)("$tool drops $field when hc:$type is denied", async ({ tool, field, type }) => {
    world.state.rules = deny(type);

    const rows = await rowsOf(tool);
    const answer = await callTool(world.client, tool, RANGE);
    const emitted = withParents(pathsOf(tool, rows));

    expect(emitted.has(field)).toBe(false);
    expect(answer.warnings).toContain(`policy_resource_denied:hc:${type}`);
  });

  it("keeps the rows, and every field of the row's own type", async () => {
    world.state.rules = deny("HeartRate", "Steps", "SkinTemperature");

    const nights = await rowsOf("sleep_sessions");
    const workouts = await rowsOf("exercise_sessions");

    expect(nights).toHaveLength(1);
    expect(nights[0]).toMatchObject({ asleepMin: 460, wearableWake: expect.any(String) });
    expect(workouts.map((row) => row.zeroLength)).toStrictEqual([false, false]);
    // Dropped, not recomputed from duration alone.
    expect(workouts.every((row) => !Object.hasOwn(row, "likelyLeftRunning"))).toBe(true);
  });

  it("does not read the denied type either", async () => {
    world.state.rules = deny("HeartRate");
    world.state.hc.calls.length = 0;

    await callTool(world.client, "blood_pressure", RANGE);

    expect(world.state.hc.calls.map((call) => call.reader)).toStrictEqual(["records"]);
  });

  it("raises no daily flag from a type the call may not see", async () => {
    world.state.rules = deny("BloodPressure", "Steps");

    const [, day] = await rowsOf("daily_summary");

    // What is left was read off types the call may see: workouts and weight.
    expect(day?.flags).toStrictEqual([
      "exercise_over_three_hours",
      "weight_profile_artefact_excluded",
    ]);
    // The cuff's pulse can no longer be recognised as one -- the readings that
    // would tell are withheld, and are not read to apply the rule -- so it is
    // not "excluded": 60 is the wearable's 52 averaged with the cuff's 68. That
    // figure is NOT a clean resting heart rate, and the answer has to say so.
    expect(day?.restingHr).toBe(60);
    const answer = await callTool(world.client, "daily_summary", RANGE);
    expect(answer.warnings).toContain("resting_hr_cuff_rule_not_applied");
    expect(answer.warnings).not.toContain("weight_artefact_rule_not_applied");
  });
});

describe("stripJoined", () => {
  it("removes the key, top level and one level down, and never nulls it", () => {
    const row = {
      date: "d",
      sleep: { asleepMin: 1, skinTempDelta: 0.2 },
      exercises: [{ title: "t", likelyLeftRunning: true }],
      weight: 70,
    };

    expect(
      stripJoined(deny("SkinTemperature", "Steps", "Weight"), "daily_summary", row),
    ).toStrictEqual({ date: "d", sleep: { asleepMin: 1 }, exercises: [{ title: "t" }] });
    expect(stripJoined(EMPTY_RULES, "daily_summary", row)).toStrictEqual(row);
  });

  it("names each denied type once", () => {
    const { fields, warnings } = deniedJoins(deny("HeartRate"), "sleep_sessions");

    expect(fields).toStrictEqual(["hr", "hrWake"]);
    expect(warnings).toStrictEqual(["policy_resource_denied:hc:HeartRate"]);
  });
});

describe("a platform aggregate is its source type's data", () => {
  it("maps every Agg type to the type it aggregates", () => {
    expect(sourceTypeOf("Agg.Steps")).toBe("Steps");
    expect(sourceTypeOf("Agg.ActiveCalories")).toBe("ActiveCaloriesBurned");
    expect(sourceTypeOf("Agg.SleepDuration")).toBe("SleepSession");
    expect(sourceTypeOf("Steps")).toBeNull();
    expect(policyResourceType("Agg.Floors")).toBe("hc:FloorsClimbed");
  });

  it("is denied when its source is, and when nothing says what its source is", () => {
    expect(typeAllowed(deny("Steps"), "Agg.Steps")).toBe(false);
    expect(typeAllowed(deny("Agg.Steps"), "Agg.Steps")).toBe(false);
    expect(typeAllowed(EMPTY_RULES, "Agg.Steps")).toBe(true);
    expect(typeAllowed(EMPTY_RULES, "Agg.SomethingNew")).toBe(false);
  });

  it("cannot be read around a deny on the source type", async () => {
    world.state.rules = deny("Steps");
    world.state.hc.calls.length = 0;

    const raw = await callTool(world.client, "hc_records", { type: "Agg.Steps", ...RANGE });
    const summed = await callTool(world.client, "hc_aggregate", { type: "Agg.Steps", ...RANGE });
    const listed = await callTool(world.client, "hc_coverage");
    const status = await callTool(world.client, "hc_sync_status");

    expect(raw.items).toStrictEqual([]);
    expect(summed.items).toStrictEqual([]);
    expect(raw.warnings).toContain("policy_resource_denied:hc:Steps");
    expect(world.state.hc.calls.filter((call) => call.type?.includes("Steps"))).toStrictEqual([]);
    // The listings do not so much as name the type, under either spelling.
    for (const answer of [listed, status]) expect(answer.text).not.toContain("Steps");
  });

  it("tags its rows as the source type, so the filter itself reaches them", async () => {
    const answer = await callTool(world.client, "hc_records", { type: "Agg.Steps", ...RANGE });

    expect(answer.items).toHaveLength(4);
    expect(new Set(answer.items.map((item) => item.resourceType))).toStrictEqual(
      new Set(["hc:Steps"]),
    );
  });
});

describe("a denied phone", () => {
  it("yields no row, no coverage entry, no origin and no count from any tool", async () => {
    world.state.rules = buildRules([{ rule_type: "health_system", target: `device:${DEVICE_ID}` }]);
    world.state.hc.calls.length = 0;
    const tools: [string, Record<string, unknown>][] = [
      ["hc_coverage", {}],
      ["hc_sync_status", {}],
      ["hc_records", { type: "Steps", ...RANGE }],
      ["hc_aggregate", { type: "Steps", ...RANGE }],
      ["hr_series", RANGE],
      ["hr_events", RANGE],
      ["sleep_sessions", RANGE],
      ["exercise_sessions", RANGE],
      ["blood_pressure", RANGE],
      ["daily_summary", RANGE],
      ["data_quality", RANGE],
    ];

    for (const [tool, args] of tools) {
      const answer = await callTool(world.client, tool, args);
      expect(answer.items, tool).toStrictEqual([]);
      expect(answer.coverage, tool).toStrictEqual([]);
      expect(answer.text, tool).not.toContain("com.example");
      expect(answer.text, tool).not.toContain(DEVICE_ID);
    }
    const summary = await callTool(world.client, "get_health_summary");
    expect(summary.text).not.toContain(DEVICE_ID);
    // Never queried at all: not one read of the store.
    expect(world.state.hc.calls).toStrictEqual([]);
  });
});
