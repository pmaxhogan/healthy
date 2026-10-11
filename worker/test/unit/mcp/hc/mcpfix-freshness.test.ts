// How current a Health Connect answer says it is, and what `hc_coverage` and
// `hc_sync_status` say of the phone:
//
//   - `hoursSinceUpload` to one decimal, never floored;
//   - `freshness` on every answer: the last upload, and where the newest
//     stored record of each covered type ends (`dataThrough`);
//   - `hc_upload_stale:device:<id>:<hours>h` once the last upload is more
//     than an hour old, on every tool, without turning the phone `stale`;
//   - a type named in `types` is always answered, an `Agg.` name included;
//   - `lastRecordFrom` for a type whose newest record is an interval;
//   - `backfillOldestAt` as a UTC instant whatever zone the answer is in.
//
// Everything is synthetic: one invented day, RFC 2606 style package names.

import { beforeEach, describe, expect, it } from "vitest";

import {
  HC_STALE_AFTER_SECONDS,
  HC_UPLOAD_LATE_AFTER_SECONDS,
  hoursSince,
  uploadLateHours,
} from "../../../../src/hc/coverage.ts";
import { buildRules } from "../../../../src/policy/rules.ts";
import { DEVICE_ID, HOUR_MS, MINUTE_MS, WEARABLE, addDevice, device, hcWorld } from "../hc-fake.ts";
import { NOW, callTool, connectTools, fakeDeps, fakeState } from "../helpers.ts";

import type { FakeState, ToolAnswer } from "../helpers.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const SOURCE = `device:${DEVICE_ID}`;
const NOW_MS = NOW * 1000;
/** The invented day: the UTC day that ends at the fake clock. */
const DAY = NOW_MS - 24 * HOUR_MS;
const at = (hour: number, minute = 0): number => DAY + hour * HOUR_MS + minute * MINUTE_MS;
const date = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** An instant as the tools write one in the fake store's zone: with its offset, not `Z`. */
const zoned = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "+00:00");
const RANGE = { start: date(DAY - 1), end: date(DAY) };

/** A zone with a fixed offset and no name of a place. */
const FIXED_WEST = "Etc/GMT+5";

const world: { state: FakeState; client: Client } = {
  state: undefined as unknown as FakeState,
  client: undefined as unknown as Client,
};

beforeEach(async () => {
  world.state = fakeState({ hc: hcWorld(NOW) });
  world.client = await connectTools(fakeDeps(world.state));
});

const call = (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> =>
  callTool(world.client, name, args);

interface Freshness {
  healthSystemId: string;
  lastUploadAt: string | null;
  hoursSinceUpload: number | null;
  dataThrough: Record<string, string>;
}

const freshnessOf = (answer: ToolAnswer): Freshness[] =>
  (JSON.parse(answer.text) as { freshness: Freshness[] }).freshness;

function thePhone() {
  const [phone] = world.state.hc.devices;
  if (phone === undefined) throw new Error("one phone");
  return phone;
}

/** Every Health Connect tool, with arguments that give it something to answer. */
const HC_TOOLS: [string, Record<string, unknown>][] = [
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

describe("the age of an upload", () => {
  it("is in hours to one decimal, not floored", () => {
    expect(hoursSince(NOW, NOW - 9720)).toBeCloseTo(2.7, 9);
    expect(hoursSince(NOW, NOW - 3600)).toBe(1);
    expect(hoursSince(NOW, NOW - 600)).toBeCloseTo(0.2, 9);
    // An upload stamped after the answer is not a negative age.
    expect(hoursSince(NOW, NOW + 30)).toBe(0);
  });

  it("is late one second past the hour, and never for a phone that will not upload", () => {
    const times = { revokedAt: null, lastUploadAt: NOW - HC_UPLOAD_LATE_AFTER_SECONDS };

    expect(uploadLateHours(times, NOW)).toBeNull();
    expect(uploadLateHours({ ...times, lastUploadAt: times.lastUploadAt - 1 }, NOW)).toBe(1);
    expect(uploadLateHours({ revokedAt: null, lastUploadAt: null }, NOW)).toBeNull();
    expect(uploadLateHours({ revokedAt: NOW - 60, lastUploadAt: NOW - 90_000 }, NOW)).toBeNull();
  });

  it("reaches `hc_sync_status` and the summary with its decimal", async () => {
    thePhone().lastUploadAt = NOW - 9720;

    const status = await call("hc_sync_status");
    const summary = await call("get_health_summary", {
      jq: '.[] | select(.kind == "phone" and .section == "sync")',
    });

    expect(status.items[0]).toMatchObject({ kind: "device", hoursSinceUpload: 2.7 });
    expect(summary.items[0]).toMatchObject({ hoursSinceUpload: 2.7 });
  });
});

describe("freshness, on every answer", () => {
  it.each(HC_TOOLS)("%s says when the phone last uploaded", async (tool, args) => {
    const answer = await call(tool, args);

    expect(answer.isError, answer.text).toBe(false);
    expect(freshnessOf(answer)).toStrictEqual([
      expect.objectContaining({
        healthSystemId: SOURCE,
        lastUploadAt: zoned(NOW_MS - 600_000),
        hoursSinceUpload: 0.2,
      }),
    ]);
  });

  it("names where the newest record of each covered type ends", async () => {
    const hr = await call("hr_series", RANGE);
    const [phone] = freshnessOf(hr);
    const lastMs = world.state.hc.syncRows
      .get(DEVICE_ID)
      ?.find((row) => row.recordType === "HeartRate")?.lastMs;
    if (lastMs === null || lastMs === undefined) throw new Error("heart rate in the fixture");

    // The tool is about heart rate: that is the type its coverage, and so its freshness, lists.
    expect(phone?.dataThrough).toStrictEqual({ "hc:HeartRate": zoned(lastMs) });
  });

  it("covers every type the answer's coverage lists with records, and no other", async () => {
    const answer = await call("hc_coverage", { origins: false });
    const listed = (answer.coverage ?? []).map((entry) => String(entry.resourceType));
    const [phone] = freshnessOf(answer);

    const named = new Set(Object.keys(phone?.dataThrough ?? {}));

    expect(listed.length).toBeGreaterThan(5);
    expect(named.size).toBe(listed.length);
    expect(listed.filter((resourceType) => !named.has(resourceType))).toStrictEqual([]);
  });

  it("leaves out a type the caller named that has no records", async () => {
    const answer = await call("hc_coverage", { types: ["Steps", "Hydration"], origins: false });
    const [phone] = freshnessOf(answer);

    expect(Object.keys(phone?.dataThrough ?? {})).toStrictEqual(["hc:Steps"]);
  });

  it("never names a type the policy withholds", async () => {
    world.state.rules = buildRules([{ rule_type: "resource", target: "hc:HeartRate" }]);

    const coverage = await call("hc_coverage", { origins: false });
    const sleep = await call("sleep_sessions", RANGE);

    for (const answer of [coverage, sleep]) {
      const [phone] = freshnessOf(answer);

      expect(Object.keys(phone?.dataThrough ?? {})).not.toContain("hc:HeartRate");
      expect(Object.keys(phone?.dataThrough ?? {})).toContain("hc:SleepSession");
    }
  });

  it("writes its times in the answer's zone", async () => {
    const answer = await call("hr_series", { ...RANGE, tz: FIXED_WEST });
    const [phone] = freshnessOf(answer);

    expect(phone?.lastUploadAt).toMatch(/-05:00$/u);
    expect(phone?.dataThrough["hc:HeartRate"]).toMatch(/-05:00$/u);
  });

  it("is null for a phone that has never uploaded", async () => {
    addDevice(world.state.hc, device("dev_new", "New phone", null), []);

    const answer = await call("hc_coverage", { devices: ["dev_new"] });

    expect(freshnessOf(answer)).toStrictEqual([
      {
        healthSystemId: "device:dev_new",
        lastUploadAt: null,
        hoursSinceUpload: null,
        dataThrough: {},
      },
    ]);
  });
});

describe("an upload more than an hour old", () => {
  it.each(HC_TOOLS)("is warned of on %s", async (tool, args) => {
    thePhone().lastUploadAt = NOW - 9720;

    const answer = await call(tool, args);

    expect(answer.warnings).toContain(`hc_upload_stale:${SOURCE}:2.7h`);
  });

  it("is not warned of at exactly an hour, and is one second later", async () => {
    thePhone().lastUploadAt = NOW - HC_UPLOAD_LATE_AFTER_SECONDS;
    const onTime = await call("hr_series", RANGE);
    thePhone().lastUploadAt = NOW - HC_UPLOAD_LATE_AFTER_SECONDS - 1;
    const late = await call("hr_series", RANGE);

    expect(
      onTime.warnings.filter((warning) => warning.startsWith("hc_upload_stale")),
    ).toStrictEqual([]);
    expect(late.warnings).toContain(`hc_upload_stale:${SOURCE}:1.0h`);
  });

  it("leaves the phone `active` and its types `ok` until six hours have passed", async () => {
    thePhone().lastUploadAt = NOW - 2 * HC_UPLOAD_LATE_AFTER_SECONDS;

    const status = await call("hc_sync_status");
    const coverage = await call("hc_coverage", { types: ["Steps"], origins: false });

    expect(status.items[0]).toMatchObject({ status: "active", hoursSinceUpload: 2 });
    expect(coverage.items[0]).toMatchObject({ availability: "ok", staleHours: null });
    // The coverage warning for a stale type is a different one, and not yet due.
    expect(coverage.warnings).toStrictEqual([`hc_upload_stale:${SOURCE}:2.0h`]);
  });

  it("is said beside the six-hour `stale` once that is due too", async () => {
    thePhone().lastUploadAt = NOW - HC_STALE_AFTER_SECONDS - 1;

    const coverage = await call("hc_coverage", { types: ["Steps"], origins: false });

    expect(coverage.warnings).toStrictEqual([
      `hc_upload_stale:${SOURCE}:6.0h`,
      `stale:hc:Steps:${SOURCE}:6h`,
    ]);
  });

  it("is not said of a revoked phone, whose types read stale already", async () => {
    const phone = thePhone();
    phone.lastUploadAt = NOW - 90_000;
    phone.revokedAt = NOW - 80_000;

    const answer = await call("hr_series", RANGE);

    expect(
      answer.warnings.filter((warning) => warning.startsWith("hc_upload_stale")),
    ).toStrictEqual([]);
    expect(answer.warnings).toContain(`stale:hc:HeartRate:${SOURCE}:25h`);
  });
});

describe("a type named in `types`", () => {
  it("is answered as unknown when it is an `Agg.` name of no platform total", async () => {
    const answer = await call("hc_coverage", {
      types: ["Agg.Weight", "Agg.NoSuchMetric", "Steps"],
      origins: false,
    });

    expect(answer.items.map((item) => item.type)).toStrictEqual(["Steps"]);
    expect(answer.warnings).toStrictEqual([
      "unknown_type:hc:Agg.NoSuchMetric",
      "unknown_type:hc:Agg.Weight",
    ]);
  });

  it("is answered with its row when it is a platform total the phone uploaded", async () => {
    const answer = await call("hc_coverage", { types: ["Agg.Steps"], origins: false });

    expect(answer.items).toStrictEqual([
      expect.objectContaining({ type: "Agg.Steps", availability: "ok", recordCount: 4 }),
    ]);
    expect(answer.warnings).toStrictEqual([]);
  });

  it("is answered as `no_data` when it is a platform total with nothing stored", async () => {
    const answer = await call("hc_coverage", { types: ["Agg.Floors"], origins: false });

    expect(answer.items).toStrictEqual([
      expect.objectContaining({ type: "Agg.Floors", availability: "no_data", recordCount: 0 }),
    ]);
    expect(answer.warnings).toStrictEqual([`no_data:hc:Agg.Floors:${SOURCE}`]);
  });

  it("is answered as unknown when it is no record type at all", async () => {
    const answer = await call("hc_coverage", { types: ["NoSuchType"], origins: false });

    expect(answer.items).toStrictEqual([]);
    expect(answer.warnings).toStrictEqual(["unknown_type:hc:NoSuchType"]);
  });

  it("is answered as withheld when the policy denies it, a platform total with its type", async () => {
    world.state.rules = buildRules([{ rule_type: "resource", target: "hc:Steps" }]);

    const answer = await call("hc_coverage", {
      types: ["Steps", "Agg.Steps", "Agg.Weight"],
      origins: false,
    });

    expect(answer.items).toStrictEqual([]);
    // One warning for the type the rule is on, and the unknown name still unknown.
    expect(answer.warnings).toStrictEqual([
      "policy_resource_denied:hc:Steps",
      "unknown_type:hc:Agg.Weight",
    ]);
  });
});

describe("lastRecordFrom", () => {
  it("is the app behind the newest record of an interval type, found by its end", async () => {
    // As the store keeps it: `last_ms` is where the newest record ENDS.
    const ends = new Map([
      ["Steps", at(17, 1)],
      ["SleepSession", at(7)],
      ["HeartRate", at(19, 9) + 1000],
    ]);
    const rows = world.state.hc.syncRows.get(DEVICE_ID) ?? [];
    for (const row of rows) row.lastMs = ends.get(row.recordType) ?? row.lastMs;

    const answer = await call("hc_coverage", {
      types: ["Steps", "SleepSession", "HeartRate"],
      max_bytes: 1_000_000,
    });
    const from = new Map(answer.items.map((item) => [item.type, item.lastRecordFrom]));

    expect(from.get("SleepSession")).toStrictEqual({ origin: WEARABLE });
    expect(from.get("HeartRate")).toStrictEqual({ origin: WEARABLE });
    // Two apps wrote the last hour's steps: one of them, never null.
    expect(from.get("Steps")).toStrictEqual({ origin: expect.stringMatching(/^com\.example\./u) });
  });

  it("is null only for a type with nothing stored", async () => {
    const answer = await call("hc_coverage", { max_bytes: 1_000_000, types: ["Hydration"] });
    const everything = await call("hc_coverage", { max_bytes: 1_000_000 });

    expect(answer.items[0]).toMatchObject({ type: "Hydration", lastRecordFrom: null });
    expect(everything.items.filter((item) => item.lastRecordFrom === null)).toStrictEqual([]);
  });
});

describe("backfillOldestAt", () => {
  it("is a UTC instant, whatever zone the answer is in", async () => {
    const monthStart = Date.UTC(2024, 5, 1);
    const rows = world.state.hc.syncRows.get(DEVICE_ID) ?? [];
    for (const row of rows) {
      if (row.recordType === "Steps") row.backfillOldestMs = monthStart;
    }

    const answer = await call("hc_sync_status", { tz: FIXED_WEST, max_bytes: 1_000_000 });
    const steps = answer.items.find((item) => item.kind === "type_sync" && item.type === "Steps");
    const other = answer.items.find((item) => item.kind === "type_sync" && item.type === "Weight");

    expect(steps?.backfillOldestAt).toBe("2024-06-01T00:00:00Z");
    // Every other time on the row is still in the answer's zone.
    expect(steps?.lastUploadAt).toMatch(/-05:00$/u);
    expect(other?.backfillOldestAt).toBeNull();
  });
});
