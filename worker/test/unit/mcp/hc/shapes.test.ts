// Two lists the exposure policy offers the owner, each held to what is real:
//
//   - the record types (`worker/src/hc/record-types.ts`) against the contract
//     fixture, which carries one record of every type the companion app maps;
//   - the field tree (`worker/src/policy/tree.ts`) against what the Health
//     Connect tools actually emit, with every optional part switched on. A
//     key a tool returns that no shape of that tool names is a key the owner
//     cannot write a rule on, so it fails here until it is added.
//
// Everything is synthetic.

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

import { HC_RECORD_FIELDS, HC_RECORD_TYPES } from "../../../../src/hc/record-types.ts";
import { resolveInShape, toolShapes } from "../../../../src/policy/tree.ts";
import { hcWorld, hcWorldRecords } from "../hc-fake.ts";
import { NOW, callTool, connectTools, fakeDeps, fakeState } from "../helpers.ts";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface FixtureRecord {
  type: string;
  data: Record<string, unknown>;
}

interface Fixture {
  batches: { name: string; body: { upserts?: FixtureRecord[] } }[];
}

function fixtureRecords(): FixtureRecord[] {
  const fixture = JSON.parse(
    readFileSync(new URL("../../../fixtures/hc/phone-batches.json", import.meta.url), "utf8"),
  ) as Fixture;
  const changes = fixture.batches.find((batch) => batch.name === "changes");
  return (changes?.body.upserts ?? []).filter((record) => !record.type.startsWith("Agg."));
}

function sorted(values: Iterable<string>): string[] {
  const out = [...values];
  out.sort((left, right) => left.localeCompare(right));
  return out;
}

describe("the record type list", () => {
  it("is exactly the types the contract fixture carries", () => {
    const types = new Set(fixtureRecords().map((record) => record.type));

    expect(types.size).toBe(41);
    expect(sorted(HC_RECORD_TYPES)).toStrictEqual(sorted(types));
  });

  it("names every `data` key the fixture's record of each type has", () => {
    const fields: Record<string, readonly string[]> = HC_RECORD_FIELDS;
    for (const record of fixtureRecords()) {
      const known = new Set(fields[record.type]);
      const missing = Object.keys(record.data).filter((key) => !known.has(key));
      expect(missing, record.type).toStrictEqual([]);
    }
  });
});

// --- emitted keys against the tree ---------------------------------------------

const RANGE = {
  start: new Date((NOW - 2 * 86_400) * 1000).toISOString().slice(0, 10),
  end: new Date((NOW - 1) * 1000).toISOString().slice(0, 10),
};
const BIG = { max_bytes: 10_000_000 };

/** Every call that shows a shape: each tool with each optional part on. */
function callsOf(): [string, Record<string, unknown>][] {
  const types = new Set(hcWorldRecords(NOW * 1000).map((record) => record.type));
  const typed: [string, Record<string, unknown>][] = [];
  for (const type of types) {
    typed.push(
      ["hc_records", { type, ...RANGE, include_metadata: true, ...BIG }],
      ["hc_aggregate", { type, ...RANGE, bucket: "hour", ...BIG }],
      ["hc_aggregate", { type, ...RANGE, origin_mode: "all_separately", ...BIG }],
    );
  }
  return [
    ...typed,
    ["hc_aggregate", { type: "TotalCaloriesBurned", ...RANGE, bmr_fill: true, ...BIG }],
    ["hc_coverage", BIG],
    ["hc_sync_status", BIG],
    ["hr_series", { ...RANGE, ...BIG }],
    ["hr_events", { ...RANGE, ...BIG }],
    ["hr_events", { ...RANGE, min_delta_bpm: 5, ...BIG }],
    ["sleep_sessions", { ...RANGE, include_stages: true, ...BIG }],
    ["exercise_sessions", { ...RANGE, ...BIG }],
    ["blood_pressure", { ...RANGE, ...BIG }],
    ["blood_pressure", { ...RANGE, group_sessions: false, dedupe: false, ...BIG }],
    ["daily_summary", { ...RANGE, ...BIG }],
    ["data_quality", { ...RANGE, ...BIG }],
    ["get_health_summary", {}],
  ];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every key path in a value, arrays stepped into without a segment of their own. */
function keyPaths(value: unknown, prefix: readonly string[], out: Map<string, string[]>): void {
  if (Array.isArray(value)) {
    for (const entry of value as unknown[]) keyPaths(entry, prefix, out);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const path = [...prefix, key];
    out.set(path.join("."), path);
    keyPaths(child, path, out);
  }
}

const world: { client: Client } = { client: undefined as unknown as Client };

beforeEach(async () => {
  const state = fakeState({ hc: hcWorld(NOW) });
  world.client = await connectTools(fakeDeps(state));
});

describe("the field tree", () => {
  it("names every key the Health Connect tools emit, optional parts included", async () => {
    const unnamed = new Set<string>();
    const seen = new Set<string>();
    for (const [tool, args] of callsOf()) {
      const answer = await callTool(world.client, tool, args);
      if (answer.isError) {
        unnamed.add(`${tool}: answered an error`);
        continue;
      }
      const shapes = toolShapes(tool) ?? [];
      const paths = new Map<string, string[]>();
      keyPaths(answer.items, [], paths);
      for (const [text, path] of paths) {
        seen.add(`${tool}: ${text}`);
        if (shapes.every((shape) => !resolveInShape(shape, path).ok)) {
          unnamed.add(`${tool}: ${text}`);
        }
      }
    }

    expect(sorted(unnamed)).toStrictEqual([]);
    // The optional parts really were on.
    expect(seen).toContain("hc_records: recordingMethod");
    expect(seen).toContain("sleep_sessions: stages");
  });
});
