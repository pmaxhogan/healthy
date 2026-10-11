// The eleven Health Connect tools, driven as a client would drive them: the
// real McpServer, the real zod schemas, the real policy filter and `respond()`,
// over the in-memory store of `hc-fake.ts`.
//
// What is under test is each tool's shape, the rules it applies when it
// answers, and the three things every one of them promises: units once per
// answer, a byte budget that says when it cut and how to continue, and an
// empty answer that says WHY it is empty.
//
// Everything is synthetic: one invented day, RFC 2606 style package names.

import { beforeEach, describe, expect, it } from "vitest";

import { HC_STALE_AFTER_SECONDS } from "../../../../src/hc/coverage.ts";
import { buildRules } from "../../../../src/policy/rules.ts";
import {
  CUFF,
  DEVICE_ID,
  HOUR_MS,
  MINUTE_MS,
  PHONE,
  PLATFORM,
  WEARABLE,
  addDevice,
  device,
  hcWorld,
  heartRate,
  interval,
} from "../hc-fake.ts";
import { NOW, callTool, connectTools, fakeDeps, fakeState } from "../helpers.ts";

import type { FakeState, ToolAnswer } from "../helpers.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const FIXED_WEST = "Etc/GMT+5";

const SOURCE = `device:${DEVICE_ID}`;
const NOW_MS = NOW * 1000;
/** The invented day: the UTC day that ends at the fake clock. */
const DAY = NOW_MS - 24 * HOUR_MS;
const at = (hour: number, minute = 0): number => DAY + hour * HOUR_MS + minute * MINUTE_MS;
const date = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const instant = (ms: number): string => new Date(ms).toISOString();
/** An instant as the tools write one in the fake store's zone: with its offset, not `Z`. */
const zoned = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "+00:00");

const TODAY = date(DAY);
const YESTERDAY = date(DAY - 1);
const RANGE = { start: YESTERDAY, end: TODAY };

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

/** The whole envelope, for the fields `ToolAnswer` does not carry. */
const envelope = (answer: ToolAnswer): Record<string, unknown> =>
  JSON.parse(answer.text) as Record<string, unknown>;

const readers = (): string[] => world.state.hc.calls.map((entry) => entry.reader);

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

describe("every Health Connect tool", () => {
  it.each(HC_TOOLS)("%s answers in the standard envelope, with rows", async (tool, args) => {
    const answer = await call(tool, args);
    const body = envelope(answer);

    expect(answer.isError, answer.text).toBe(false);
    expect(Object.keys(body)).toStrictEqual(
      expect.arrayContaining([
        "items",
        "total",
        "matched",
        "coverage",
        "warnings",
        "truncated",
        "generatedAt",
        "timeZone",
      ]),
    );
    expect(answer.items.length, tool).toBeGreaterThan(0);
    expect(body.matched).toBe(body.total);
  });

  it.each(HC_TOOLS)("%s tags every row with the phone it came from", async (tool, args) => {
    const answer = await call(tool, { ...args, max_bytes: 10_000_000 });

    expect(new Set(answer.items.map((item) => item.healthSystemId))).toStrictEqual(
      new Set([SOURCE]),
    );
    const coverage = answer.coverage ?? [];
    for (const entry of coverage) {
      expect(entry.healthSystemId).toBe(SOURCE);
      expect(String(entry.resourceType)).toMatch(/^hc:/u);
    }
  });

  it.each(HC_TOOLS)(
    "%s answers policy_denied, and reads nothing, when it is denied",
    async (tool, args) => {
      world.state.rules = buildRules([{ rule_type: "tool", target: tool }]);
      world.state.hc.calls.length = 0;

      const answer = await call(tool, args);

      expect(answer).toMatchObject({ isError: true, error: "policy_denied" });
      expect(world.state.hc.calls).toStrictEqual([]);
      expect(world.state.audits.at(-1)).toMatchObject({
        tool,
        ok: false,
        errorCode: "policy_denied",
      });
    },
  );

  it.each(HC_TOOLS)(
    "%s writes one audit row naming the phone and no content",
    async (tool, args) => {
      const answer = await call(tool, args);

      expect(world.state.audits).toHaveLength(1);
      expect(world.state.audits[0]).toMatchObject({
        tool,
        ok: true,
        errorCode: null,
        healthSystemIds: [SOURCE],
        resultCount: answer.items.length,
      });
      expect(JSON.stringify(world.state.audits[0])).not.toContain("com.example");
    },
  );

  it.each(HC_TOOLS)("%s refuses an argument it does not know", async (tool, args) => {
    const answer = await call(tool, { ...args, raw: true });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("Invalid arguments");
  });

  it("refuses a date-time with no offset, and a zone that is not one", async () => {
    const naive = await call("hr_series", { start: `${TODAY}T08:00:00` });
    const zone = await call("hr_series", { ...RANGE, tz: "Not/AZone" });

    expect(naive.text).toContain("Invalid arguments");
    expect(zone.text).toContain("Invalid arguments");
  });

  it("answers in the owner's zone by default and in `tz` when given, naming it", async () => {
    world.state.hc.timezone = FIXED_WEST;

    const configured = await call("blood_pressure", {
      start: instant(at(0)),
      end: instant(NOW_MS),
    });
    const asked = await call("blood_pressure", {
      start: instant(at(0)),
      end: instant(NOW_MS),
      tz: "UTC",
    });

    expect(envelope(configured).timeZone).toBe(FIXED_WEST);
    expect(configured.items[0]?.start).toBe(`${TODAY}T04:00:00-05:00`);
    expect(envelope(asked).timeZone).toBe("UTC");
    expect(asked.items[0]?.start).toBe(`${TODAY}T09:00:00+00:00`);
  });

  it("selects phones by id or by name, and answers for none when nothing matches", async () => {
    const byName = await call("hc_sync_status", { devices: ["test PH"] });
    const bySource = await call("hc_sync_status", { devices: [SOURCE] });
    const none = await call("hc_sync_status", { devices: ["somebody else's"] });

    expect(byName.items.length).toBeGreaterThan(0);
    expect(bySource.items).toHaveLength(byName.items.length);
    expect(none.items).toStrictEqual([]);
  });
});

/** `availability` by record type, as `hc_coverage` reports it. */
async function availability(): Promise<Map<unknown, unknown>> {
  const answer = await call("hc_coverage", { origins: false, max_bytes: 10_000_000 });
  return new Map(answer.items.map((item) => [item.type, item.availability]));
}

/** Words a client must never be handed about a type the phone has nothing of. */
const BLAME = /permission|permitted|denied|unsupported|grant|not_available|never_synced/iu;

/** One zero-record row of the fake phone, by what the phone said of its permission. */
const EMPTY_TYPES = ["BodyTemperature", "OxygenSaturation", "Hydration"];

function setSyncRow(type: string, change: Record<string, unknown>): void {
  const rows = world.state.hc.syncRows.get(DEVICE_ID) ?? [];
  world.state.hc.syncRows.set(
    DEVICE_ID,
    rows.map((row) => (row.recordType === type ? { ...row, ...change } : row)),
  );
}

describe("a type the phone has no records of", () => {
  it("is not listed, whatever the phone said about reading it", async () => {
    const coverage = await call("hc_coverage", { origins: false, max_bytes: 10_000_000 });
    const status = await call("hc_sync_status", { max_bytes: 10_000_000 });
    const listed = new Map(coverage.items.map((item) => [item.type, item.availability]));

    // Refused, not offered by the phone, and allowed but empty: all three are just absent.
    for (const type of EMPTY_TYPES) {
      expect(listed.has(type), type).toBe(false);
      expect(
        status.items.some((item) => item.type === type),
        type,
      ).toBe(false);
      expect(coverage.text, type).not.toContain(type);
      expect(status.text, type).not.toContain(type);
    }
    expect(listed.get("Steps")).toBe("ok");
    expect(coverage.warnings).toStrictEqual([]);
    expect(coverage.text).not.toMatch(BLAME);
    expect(status.text).not.toMatch(BLAME);
    // And nothing counts them.
    const typeRows = status.items.filter((item) => item.kind === "type_sync");
    expect(status.items[0]).toMatchObject({ kind: "device", typesWithData: typeRows.length });
  });

  it("raises no warning and no coverage entry on a tool that joins it", async () => {
    // The fake phone has no skin temperature, HRV or respiratory rate.
    const nights = await call("sleep_sessions", RANGE);
    const days = await call("daily_summary", RANGE);
    const quality = await call("data_quality", RANGE);
    const summary = await call("get_health_summary", {});

    for (const answer of [nights, days, quality, summary]) {
      // The summary also carries the health systems' own lines; only the phone's are judged.
      const phoneWarnings = answer.warnings.filter((warning) => warning.includes("hc:"));
      expect(answer === summary ? phoneWarnings.join(" ") : answer.text).not.toMatch(BLAME);
      expect(answer.warnings.filter((warning) => warning.startsWith("no_data"))).toStrictEqual([]);
      const phoneEntries = (answer.coverage ?? []).filter((entry) =>
        String(entry.resourceType).startsWith("hc:"),
      );
      expect(phoneEntries.filter((entry) => Number(entry.recordCount) === 0)).toStrictEqual([]);
    }
  });

  it("answers the same `no_data` when named, for every reason there is none", async () => {
    // Refused, not offered, allowed but empty, and never mentioned by the phone.
    for (const type of [...EMPTY_TYPES, "Vo2Max"]) {
      const raw = await call("hc_records", { type, ...RANGE });
      const summed = await call("hc_aggregate", { type, ...RANGE });
      const listed = await call("hc_coverage", { types: [type] });

      expect(raw.isError, type).toBe(false);
      expect(raw.items, type).toStrictEqual([]);
      expect(raw.warnings, type).toStrictEqual([`no_data:hc:${type}:${SOURCE}`]);
      expect(raw.coverage, type).toStrictEqual([
        {
          healthSystemId: SOURCE,
          healthSystem: "Test phone",
          resourceType: `hc:${type}`,
          status: "ok",
          recordCount: 0,
        },
      ]);
      expect(summed.warnings, type).toContain(`no_data:hc:${type}:${SOURCE}`);
      expect(
        summed.items.every((item) => item.hasData === false),
        type,
      ).toBe(true);
      expect(listed.items, type).toStrictEqual([
        expect.objectContaining({ type, availability: "no_data", status: "ok", recordCount: 0 }),
      ]);
      for (const answer of [raw, summed, listed]) expect(answer.text, type).not.toMatch(BLAME);
    }
  });

  it("calls a name that is no record type unknown, not empty", async () => {
    const raw = await call("hc_records", { type: "NotARecordType", ...RANGE });
    const listed = await call("hc_coverage", { types: ["NotARecordType", "Steps"] });

    expect(raw.items).toStrictEqual([]);
    expect(raw.warnings).toStrictEqual(["unknown_type:hc:NotARecordType"]);
    expect(raw.coverage).toStrictEqual([]);
    expect(listed.items.map((item) => item.type)).toStrictEqual(["Steps"]);
    expect(listed.warnings).toStrictEqual(["unknown_type:hc:NotARecordType"]);
  });

  it("appears by itself with the first stored record, with nothing else changed", async () => {
    // Still refused on the phone; one record is in the store all the same.
    setSyncRow("BodyTemperature", { recordCount: 1, firstMs: at(8), lastMs: at(8) });

    const coverage = await call("hc_coverage", { origins: false, max_bytes: 10_000_000 });
    const status = await call("hc_sync_status", { max_bytes: 10_000_000 });
    const row = coverage.items.find((item) => item.type === "BodyTemperature");

    expect(row).toMatchObject({ availability: "ok", status: "ok", recordCount: 1 });
    expect(status.items.some((item) => item.type === "BodyTemperature")).toBe(true);
    expect(coverage.text).not.toMatch(BLAME);
  });

  it("reads a type that has records as its data after the phone loses the right to read it", async () => {
    setSyncRow("Steps", { permissionState: "denied" });

    const fresh = await call("hc_coverage", { types: ["Steps"], origins: false });
    const steps = await call("hc_aggregate", { type: "Steps", ...RANGE });
    const [phone] = world.state.hc.devices;
    if (phone === undefined) throw new Error("one phone");
    phone.lastUploadAt = NOW - HC_STALE_AFTER_SECONDS - 1;
    const later = await call("hc_coverage", { types: ["Steps"], origins: false });

    expect(fresh.items[0]).toMatchObject({ availability: "ok", recordCount: 20 });
    expect(steps.items.length).toBeGreaterThan(0);
    // Once uploads stop it goes stale like any phone that has stopped.
    expect(later.items[0]).toMatchObject({ availability: "stale", staleHours: 6 });
    expect(`${fresh.text}${later.text}${steps.text}`).not.toMatch(BLAME);
  });
});

describe("why an answer is empty", () => {
  it("calls a phone stale one second past six hours, on every type and every tool", async () => {
    const [phone] = world.state.hc.devices;
    if (phone === undefined) throw new Error("one phone");
    phone.lastUploadAt = NOW - HC_STALE_AFTER_SECONDS;
    const fresh = await availability();
    phone.lastUploadAt = NOW - HC_STALE_AFTER_SECONDS - 1;
    const stale = await availability();
    const steps = await call("hc_aggregate", { type: "Steps", ...RANGE });
    const status = await call("hc_sync_status");

    expect(fresh.get("Steps")).toBe("ok");
    expect(stale.get("Steps")).toBe("stale");
    // Stale data is still returned -- with the warning beside it.
    expect(steps.items.length).toBeGreaterThan(0);
    expect(steps.warnings).toContain(`stale:hc:Steps:${SOURCE}:6h`);
    expect(status.items[0]).toMatchObject({ kind: "device", status: "stale", hoursSinceUpload: 6 });
  });

  it("lists nothing for a phone that has never uploaded, and `no_data` for a named type", async () => {
    addDevice(world.state.hc, device("dev_new", "New phone", null), []);

    const everything = await call("hc_coverage", { devices: ["dev_new"] });
    const named = await call("hc_coverage", { devices: ["dev_new"], types: ["Steps"] });
    const status = await call("hc_sync_status", { devices: ["dev_new"] });

    expect(everything.items).toStrictEqual([]);
    expect(everything.warnings).toStrictEqual([]);
    expect(named.items).toStrictEqual([
      expect.objectContaining({ type: "Steps", availability: "no_data", recordCount: 0 }),
    ]);
    expect(named.warnings).toStrictEqual(["no_data:hc:Steps:device:dev_new"]);
    // That it never uploaded is said of the phone, once.
    expect(status.items).toStrictEqual([
      expect.objectContaining({ kind: "device", status: "never", hoursSinceUpload: null }),
    ]);
  });

  it("never reports a negative age when an upload is stamped after the answer", async () => {
    const [phone] = world.state.hc.devices;
    if (phone === undefined) throw new Error("one phone");
    phone.lastUploadAt = NOW + 5;

    const status = await call("hc_sync_status");
    const coverage = await call("hc_coverage", { types: ["Steps"], origins: false });
    const summary = await call("get_health_summary", {
      jq: '.[] | select(.kind == "phone" and .section == "sync")',
    });

    expect(status.items[0]).toMatchObject({ status: "active", hoursSinceUpload: 0 });
    expect(coverage.items[0]).toMatchObject({ availability: "ok", staleHours: null });
    expect(summary.items[0]).toMatchObject({ status: "active", hoursSinceUpload: 0 });
  });

  it("says when uploads are still being worked through", async () => {
    world.state.hc.backlog.set(DEVICE_ID, {
      queuedBatches: 1,
      parkedBatches: 0,
      dirty: 3,
      rezonePending: false,
    });
    world.state.hc.calls.length = 0;

    const answer = await call("hc_aggregate", { type: "Steps", ...RANGE });
    const status = await call("hc_sync_status");

    expect(answer.warnings).toContain(`hc_store_pending:${SOURCE}`);
    // Day rollups may lag the newest upload, so they are not what answered.
    expect(readers()).not.toContain("dayRollups");
    expect(status.items[0]).toMatchObject({ queuedBatches: 1, rollupsPending: 3 });
  });
});

describe("the byte budget", () => {
  it("cuts at a row boundary, says so, and continues from the cursor to the end", async () => {
    const whole = await call("hr_series", { ...RANGE, max_bytes: 10_000_000 });
    const pages: ToolAnswer[] = [];
    let cursor: unknown;
    for (let guard = 0; guard < 500; guard += 1) {
      const page = await call("hr_series", {
        ...RANGE,
        max_bytes: 6000,
        ...(cursor !== undefined && { cursor }),
      });
      pages.push(page);
      cursor = envelope(page).cursor;
      if (cursor === undefined) break;
    }

    expect(whole.truncated).toBe(false);
    expect(envelope(whole).cursor).toBeUndefined();
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.slice(0, -1).every((page) => page.truncated)).toBe(true);
    expect(pages.at(-1)?.truncated).toBe(false);
    expect(pages.flatMap((page) => page.items)).toStrictEqual(whole.items);
    for (const page of pages) {
      expect(JSON.stringify(page.items).length - 2).toBeLessThanOrEqual(6000);
      expect(page.total).toBe(whole.total);
    }
  });

  it("is lifted by max_bytes, and never returns less than one row", async () => {
    const tiny = await call("sleep_sessions", { ...RANGE, max_bytes: 1 });
    const one = await call("hc_records", { type: "Steps", ...RANGE, max_bytes: 1 });

    expect(tiny.items).toHaveLength(1);
    expect(tiny.truncated).toBe(false);
    expect(one.items).toHaveLength(1);
    expect(one.truncated).toBe(true);
    expect(envelope(one).cursor).toStrictEqual(expect.any(String));
  });

  it("counts the rows `jq` emits, not the ones it read", async () => {
    const args = { ...RANGE, jq: ".[] | [.t, .mean]" };

    const plain = await call("hr_series", RANGE);
    const projected = await call("hr_series", args);
    const small = await call("hr_series", { ...args, max_bytes: 2000 });
    const second = await call("hr_series", {
      ...args,
      max_bytes: 2000,
      cursor: envelope(small).cursor,
    });

    // The same rows do not fit the default budget whole, and do once projected.
    expect(plain.truncated).toBe(true);
    expect(projected.truncated).toBe(false);
    expect(projected.items).toHaveLength(plain.total);
    // And a cursor over a projected answer continues the projected rows.
    expect(small.truncated).toBe(true);
    expect(second.items[0]).toStrictEqual(projected.items[small.items.length]);
  });

  it("pages with limit the same way, and lets limit change between pages", async () => {
    const first = await call("hc_records", { type: "Steps", ...RANGE, limit: 7 });
    const rest = await call("hc_records", {
      type: "Steps",
      ...RANGE,
      limit: 100,
      cursor: envelope(first).cursor,
    });
    const whole = await call("hc_records", { type: "Steps", ...RANGE });

    expect(first.items).toHaveLength(7);
    expect(first.truncated).toBe(true);
    expect(rest.truncated).toBe(false);
    expect([...first.items, ...rest.items]).toStrictEqual(whole.items);
  });

  it("refuses a cursor from another question", async () => {
    const first = await call("hc_records", { type: "Steps", ...RANGE, limit: 3 });
    const { cursor } = envelope(first);

    const otherType = await call("hc_records", { type: "Distance", ...RANGE, cursor });
    const otherTool = await call("hc_aggregate", { type: "Steps", ...RANGE, cursor });
    const garbage = await call("hc_records", { type: "Steps", ...RANGE, cursor: "nope" });

    for (const answer of [otherType, otherTool, garbage]) {
      expect(answer).toMatchObject({ isError: true, error: "invalid_cursor" });
    }
    expect(world.state.audits.at(-1)).toMatchObject({ ok: false, errorCode: "invalid_cursor" });
  });
});

describe("hc_records", () => {
  it("returns records as stored: numbers as numbers, ISO times with offset, units once", async () => {
    const answer = await call("hc_records", { type: "BloodPressure", ...RANGE });

    expect(envelope(answer).units).toStrictEqual({ systolic: "mmHg", diastolic: "mmHg" });
    expect(answer.items[0]).toStrictEqual({
      resourceType: "hc:BloodPressure",
      healthSystemId: SOURCE,
      id: "bp-1",
      origin: CUFF,
      time: `${TODAY}T09:00:00+00:00`,
      data: {
        systolic: 121,
        diastolic: 79,
        bodyPosition: "SITTING_DOWN",
        measurementLocation: "LEFT_UPPER_ARM",
      },
    });
    // Nothing deduplicated here: the relayed copy is still a stored record.
    expect(answer.items.map((item) => item.id)).toStrictEqual(["bp-1", "bp-1-relayed", "bp-2"]);
  });

  it("converts the times inside nested lists too", async () => {
    const answer = await call("hc_records", { type: "SleepSession", ...RANGE });
    const data = answer.items[0]?.data as { stages: { start: string; stage: string }[] };

    expect(answer.items[0]).toMatchObject({
      start: `${YESTERDAY}T23:00:00+00:00`,
      end: `${TODAY}T07:00:00+00:00`,
    });
    expect(data.stages[0]).toStrictEqual({
      start: `${YESTERDAY}T23:00:00+00:00`,
      end: `${YESTERDAY}T23:20:00+00:00`,
      stage: "AWAKE",
    });
  });

  it("filters by origin, projects `fields`, orders, and adds metadata on request", async () => {
    const answer = await call("hc_records", {
      type: "BloodPressure",
      ...RANGE,
      origins: [CUFF],
      fields: ["systolic"],
      order: "desc",
      include_metadata: true,
    });

    expect(answer.items.map((item) => item.id)).toStrictEqual(["bp-2", "bp-1"]);
    expect(answer.items[0]?.data).toStrictEqual({ systolic: 117 });
    expect(answer.items[0]).toMatchObject({
      lastModified: `${TODAY}T09:02:00+00:00`,
      device: null,
      offsetMin: null,
    });
    expect(envelope(answer).order).toBe("desc");
  });

  it("reads only the range asked for, and on a continued call only from the cursor on", async () => {
    world.state.hc.calls.length = 0;
    const first = await call("hc_records", {
      type: "Steps",
      start: instant(at(8)),
      end: instant(at(12)),
      limit: 3,
    });
    const second = await call("hc_records", {
      type: "Steps",
      start: instant(at(8)),
      end: instant(at(12)),
      cursor: envelope(first).cursor,
    });

    expect(world.state.hc.calls).toStrictEqual([
      { reader: "records", type: "Steps", startMs: at(8), endMs: at(12) },
      // The third row was the wearable's 09:00 record; the phone's is next.
      { reader: "records", type: "Steps", startMs: at(9), endMs: at(12) },
    ]);
    expect(first.items.map((item) => item.id)).toStrictEqual([
      "steps-p-8",
      "steps-w-8",
      "steps-p-9",
    ]);
    expect(second.items.map((item) => item.id)).toStrictEqual([
      "steps-w-9",
      "steps-p-10",
      "steps-w-10",
      "steps-p-11",
      "steps-w-11",
    ]);
  });

  it("resumes a descending read backwards from the cursor", async () => {
    const args = { type: "Steps", start: instant(at(8)), end: instant(at(12)), order: "desc" };
    const first = await call("hc_records", { ...args, limit: 3 });
    world.state.hc.calls.length = 0;
    const second = await call("hc_records", { ...args, cursor: envelope(first).cursor });
    const whole = await call("hc_records", args);

    expect(world.state.hc.calls[0]).toStrictEqual({
      reader: "records",
      type: "Steps",
      startMs: at(8),
      endMs: at(10) + 1,
    });
    expect([...first.items, ...second.items]).toStrictEqual(whole.items);
  });
});

describe("hc_aggregate", () => {
  it("answers a day from day rollups and names the method and the levels it used", async () => {
    world.state.hc.calls.length = 0;
    const answer = await call("hc_aggregate", { type: "Steps", ...RANGE });
    const body = envelope(answer);

    expect(body).toMatchObject({
      bucket: "day",
      bucketing: "start_time",
      originMode: "hc_priority",
      metrics: ["sum"],
      units: { count: "steps" },
    });
    expect(answer.items[0]).toMatchObject({ bucket: YESTERDAY, hasData: false, origins: [] });
    // The platform's figure covers 08:00-12:00 only, so the day is composed
    // hour by hour: four platform hours and six of the wearable's own.
    expect(answer.items[1]).toMatchObject({
      bucket: TODAY,
      hasData: true,
      method: "platform_and_max_origin",
      origins: [WEARABLE, PLATFORM],
      values: { count: { sum: 4 * 520 + 6 * 500 } },
      duplicatesDropped: 6,
    });
    expect(answer.warnings).toStrictEqual(["hc_duplicates_dropped:6", "hc_priority_fallback"]);
    expect(readers()).not.toContain("records");
  });

  it("answers by hour from hour rollups, and by origin, without opening a record", async () => {
    world.state.hc.calls.length = 0;
    const range = { start: instant(at(7)), end: instant(at(14)) };

    const hourly = await call("hc_aggregate", { type: "Steps", ...range, bucket: "hour" });
    const phone = await call("hc_aggregate", {
      type: "Steps",
      ...range,
      bucket: "hour",
      origin_mode: `origin:${PHONE}`,
    });
    const each = await call("hc_aggregate", {
      type: "Steps",
      ...range,
      origin_mode: "all_separately",
    });

    expect(hourly.items.map((item) => [item.method ?? null, item.hasData])).toStrictEqual([
      [null, false],
      ["platform", true],
      ["platform", true],
      ["platform", true],
      ["platform", true],
      ["max_origin", true],
      ["max_origin", true],
    ]);
    expect(envelope(hourly).answeredFrom).toStrictEqual(["hour_rollup"]);
    expect(phone.items.filter((item) => item.hasData)).toHaveLength(6);
    expect(phone.items[1]).toMatchObject({ method: "origin", values: { count: { sum: 300 } } });
    expect(each.items.map((item) => item.origins)).toStrictEqual([[PHONE], [WEARABLE]]);
    expect(new Set(readers())).toStrictEqual(new Set(["hourRollups"]));
  });

  it("does not gap-fill total calories unless asked, and shows the fill when it does", async () => {
    const plain = await call("hc_aggregate", { type: "TotalCaloriesBurned", ...RANGE });
    const filled = await call("hc_aggregate", {
      type: "TotalCaloriesBurned",
      ...RANGE,
      bmr_fill: true,
    });
    const ignored = await call("hc_aggregate", { type: "Steps", ...RANGE, bmr_fill: true });

    expect(
      plain.items.map((item) => (item.values as { energy: { sum: number } }).energy.sum),
    ).toStrictEqual([0, 1000]);
    expect(plain.items.every((item) => !Object.hasOwn(item, "bmrFillKcal"))).toBe(true);
    // Ten of the day's hours were recorded; fourteen are padded at 1600 kcal/day.
    expect(filled.items[1]?.bmrFillKcal).toBeCloseTo((1600 * 14) / 24, 6);
    expect(filled.items[0]).toMatchObject({ hasData: false, bmrFillKcal: 1600 });
    expect(ignored.warnings).toContain("bmr_fill_ignored");
  });

  it("withholds the fill when the policy denies the basal-metabolic-rate type", async () => {
    world.state.rules = buildRules([{ rule_type: "resource", target: "hc:BasalMetabolicRate" }]);

    const answer = await call("hc_aggregate", {
      type: "TotalCaloriesBurned",
      ...RANGE,
      bmr_fill: true,
    });

    expect(answer.items.every((item) => item.bmrFillKcal === undefined)).toBe(true);
    expect(answer.warnings).toContain("policy_resource_denied:hc:BasalMetabolicRate");
  });

  it("never counts the future, and says so on the bucket now cuts", async () => {
    const tomorrow = date(NOW_MS + 36 * HOUR_MS);

    const answer = await call("hc_aggregate", { type: "Steps", start: TODAY, end: tomorrow });
    const all = await call("hc_aggregate", {
      type: "Steps",
      start: TODAY,
      end: tomorrow,
      exclude_future: false,
    });

    expect(answer.items.map((item) => item.bucket)).toStrictEqual([TODAY]);
    expect(all.items).toHaveLength(3);
  });

  it("refuses a bucket or an origin mode it does not know", async () => {
    const bucket = await call("hc_aggregate", { type: "Steps", ...RANGE, bucket: "fortnight" });
    const mode = await call("hc_aggregate", { type: "Steps", ...RANGE, origin_mode: "sum_all" });

    expect(bucket.text).toContain("Invalid arguments");
    expect(mode.text).toContain("Invalid arguments");
  });
});

describe("hr_series", () => {
  const morning = { start: instant(at(8, 20)), end: instant(at(9)) };

  it("defaults to one-minute points from the minute rows, one app only", async () => {
    world.state.hc.calls.length = 0;
    const answer = await call("hr_series", { start: instant(at(8)), end: instant(at(8, 40)) });

    expect(envelope(answer)).toMatchObject({
      resolution: "1min",
      bucketMs: 60_000,
      decimated: false,
      totalPoints: 40,
      units: { mean: "bpm" },
    });
    expect(answer.items[0]).toStrictEqual({
      resourceType: "hc:HeartRate",
      healthSystemId: SOURCE,
      origin: WEARABLE,
      t: `${TODAY}T08:00:00+00:00`,
      mean: 62,
      min: 62,
      max: 62,
      n: 1,
    });
    expect(answer.items[30]).toMatchObject({ t: `${TODAY}T08:30:00+00:00`, mean: 105 });
    // No minute in this range holds an implausible reading: no raw chunk opened.
    expect(readers()).toStrictEqual(["hrMinutes"]);
  });

  it("takes an implausible reading out of its minute, opening only that hour", async () => {
    world.state.hc.calls.length = 0;
    const answer = await call("hr_series", morning);
    const bad = answer.items.find((item) => item.t === `${TODAY}T08:50:00+00:00`);

    expect(answer.warnings).toStrictEqual(["hr_artefacts_dropped:1"]);
    expect(bad).toMatchObject({ mean: 62, max: 62, n: 1 });
    expect(world.state.hc.calls.filter((entry) => entry.reader === "records")).toStrictEqual([
      { reader: "records", type: "HeartRate", startMs: at(8), endMs: at(9) },
    ]);
  });

  it("takes out a reading too low to be a pulse as well", async () => {
    world.state.hc.records.get(DEVICE_ID)?.push(
      heartRate("hr-dropout", at(20), [
        [0, 64],
        [20_000, 0],
        [60_000, 66],
      ]),
    );

    const answer = await call("hr_series", { start: instant(at(20)), end: instant(at(20, 2)) });
    const quality = await call("data_quality", {
      start: instant(at(20)),
      end: instant(at(21)),
      types: ["HeartRate"],
    });

    expect(answer.items.map((item) => [item.mean, item.min, item.n])).toStrictEqual([
      [64, 64, 1],
      [66, 66, 1],
    ]);
    expect(answer.warnings).toStrictEqual(["hr_artefacts_dropped:1"]);
    expect(quality.items).toStrictEqual([
      expect.objectContaining({ kind: "artefact", count: 1, minValue: 0 }),
    ]);
    expect(envelope(quality).rules).toMatchObject({ heartRateMinBpm: 20, heartRateMaxBpm: 200 });
  });

  it("makes a long series coarser instead of cutting it, and says by how much", async () => {
    const answer = await call("hr_series", { ...morning, max_points: 10 });
    const body = envelope(answer);

    // Forty minutes into ten points needs four-minute buckets; the next width
    // on the ladder that fits is five.
    expect(answer.items).toHaveLength(8);
    expect(body).toMatchObject({
      decimated: true,
      decimation: 5,
      bucketMs: 300_000,
      totalPoints: 40,
      series: [{ bucketMs: 300_000, decimated: true, decimation: 5, totalPoints: 40, points: 8 }],
    });
    expect(answer.warnings).toContain("hr_series_decimated:5");
    // Coarser, not shorter: the last point still reaches the end of the range.
    expect(answer.items.at(-1)?.t).toBe(`${TODAY}T08:55:00+00:00`);
    expect(answer.items.reduce((sum, item) => sum + Number(item.n), 0)).toBe(40);
  });

  it("resamples to five minutes and an hour from the same rows", async () => {
    const five = await call("hr_series", { ...morning, resolution: "5min", stats: ["mean", "n"] });
    const hour = await call("hr_series", { ...morning, resolution: "1h" });

    expect(five.items).toHaveLength(8);
    expect(five.items[2]).toStrictEqual({
      resourceType: "hc:HeartRate",
      healthSystemId: SOURCE,
      origin: WEARABLE,
      t: `${TODAY}T08:30:00+00:00`,
      mean: 105,
      n: 5,
    });
    expect(hour.items).toHaveLength(1);
    expect(hour.items[0]).toMatchObject({ t: `${TODAY}T08:00:00+00:00`, min: 62, max: 105, n: 40 });
  });

  it("returns every sample at `raw`, from the records of that range", async () => {
    world.state.hc.calls.length = 0;
    const answer = await call("hr_series", { ...morning, resolution: "raw" });

    expect(answer.items).toHaveLength(40);
    expect(envelope(answer)).toMatchObject({ resolution: "raw", bucketMs: null });
    expect(answer.warnings).toStrictEqual(["hr_artefacts_dropped:1"]);
    expect(readers()).toStrictEqual(["records"]);
  });

  it("never blends two apps: the busier one by default, each its own series when named", async () => {
    const range = { start: instant(at(8, 55)), end: instant(at(9, 5)) };

    const chosen = await call("hr_series", range);
    const both = await call("hr_series", { ...range, origins: [CUFF, WEARABLE] });

    expect(new Set(chosen.items.map((item) => item.origin))).toStrictEqual(new Set([WEARABLE]));
    expect(chosen.warnings).toContain("hr_other_origins_not_shown:1");
    expect(both.items.filter((item) => item.origin === CUFF)).toStrictEqual([
      expect.objectContaining({ t: `${TODAY}T09:00:00+00:00`, mean: 68 }),
    ]);
  });
});

/** A minute-by-minute heart rate that sits at 60 for twelve minutes and then at 110. */
function rise(minutes: number): [number, number][] {
  return Array.from({ length: minutes }, (_, minute) => [
    minute * MINUTE_MS,
    minute < 12 ? 60 : 110,
  ]);
}

describe("hr_events", () => {
  it("finds a sustained rise with its baseline, peak and time to peak", async () => {
    const answer = await call("hr_events", RANGE);

    expect(envelope(answer).rule).toStrictEqual({ minDeltaBpm: 30, windowS: 600, sustainS: 60 });
    expect(answer.items).toStrictEqual([
      {
        resourceType: "hc:HeartRate",
        healthSystemId: SOURCE,
        origin: WEARABLE,
        start: `${TODAY}T08:30:00+00:00`,
        end: `${TODAY}T08:36:00+00:00`,
        peakAt: `${TODAY}T08:30:00+00:00`,
        baselineBpm: 62,
        peakBpm: 105,
        deltaBpm: 43,
        timeToPeakS: 0,
        durationS: 360,
        context: "other",
      },
    ]);
  });

  it("uses the caller's thresholds", async () => {
    const strict = await call("hr_events", { ...RANGE, min_delta_bpm: 50 });
    const long = await call("hr_events", { ...RANGE, sustain_s: 900 });

    expect(strict.items).toStrictEqual([]);
    expect(long.items).toStrictEqual([]);
  });

  it("says where an event fell: a workout, a waking", async () => {
    const records = world.state.hc.records.get(DEVICE_ID) ?? [];
    records.push(
      heartRate("hr-gym", at(13), rise(25)),
      interval("gym", "ExerciseSession", at(13, 10), at(13, 30), {
        exerciseType: "STRENGTH_TRAINING",
      }),
      // A second, short sleep that ends as the heart rate climbs.
      heartRate("hr-nap", at(15), rise(25)),
      interval("nap", "SleepSession", at(14, 30), at(15, 10), {}),
    );

    const answer = await call("hr_events", { start: instant(at(12)), end: instant(at(16)) });

    expect(answer.items.map((item) => [item.start, item.context])).toStrictEqual([
      [`${TODAY}T13:12:00+00:00`, "exercise"],
      [`${TODAY}T15:12:00+00:00`, "wake"],
    ]);
  });
});

describe("sleep_sessions", () => {
  it("returns one row per night with both wakes and the overnight joins", async () => {
    world.state.hc.calls.length = 0;
    const answer = await call("sleep_sessions", RANGE);

    expect(answer.items).toHaveLength(1);
    expect(answer.items[0]).toMatchObject({
      resourceType: "hc:SleepSession",
      date: TODAY,
      start: `${YESTERDAY}T23:00:00+00:00`,
      end: `${TODAY}T07:00:00+00:00`,
      inBedMin: 480,
      asleepMin: 460,
      awakeMin: 20,
      stageMin: { AWAKE: 20, LIGHT: 220, DEEP: 120, REM: 120 },
      onset: `${YESTERDAY}T23:20:00+00:00`,
      wearableWake: `${TODAY}T07:00:00+00:00`,
      hrv: { median: 43, q1: 41.5, q3: 44.5, iqr: 3, n: 7 },
      respiratoryRate: 14,
      restingHr: 52,
      origin: WEARABLE,
      mergedSessions: 1,
    });
    expect((answer.items[0]?.hr as { min: number }).min).toBe(54);
    expect(Object.hasOwn(answer.items[0] ?? {}, "hrWake")).toBe(true);
    expect(Object.hasOwn(answer.items[0] ?? {}, "stages")).toBe(false);
    // From the stored summary: no raw chunk, no heart-rate row.
    expect(readers()).toStrictEqual(["sleepNights"]);
  });

  it("adds the stage timeline on request", async () => {
    const answer = await call("sleep_sessions", { ...RANGE, include_stages: true });
    const stages = answer.items[0]?.stages as { stage: string; start: string }[];

    expect(stages.map((stage) => stage.stage)).toStrictEqual([
      "AWAKE",
      "LIGHT",
      "DEEP",
      "REM",
      "LIGHT",
    ]);
    expect(stages[0]?.start).toBe(`${YESTERDAY}T23:00:00+00:00`);
  });

  it("makes one row of a night two apps both wrote, described by the longer", async () => {
    world.state.hc.records
      .get(DEVICE_ID)
      ?.push(interval("sleep-phone", "SleepSession", at(0), at(6, 30), {}, { origin: PHONE }));

    const answer = await call("sleep_sessions", RANGE);

    expect(answer.items).toHaveLength(1);
    expect(answer.items[0]).toMatchObject({
      origin: WEARABLE,
      mergedSessions: 2,
      origins: [PHONE, WEARABLE],
      inBedMin: 480,
    });
  });
});

describe("a night whose stages overlap", () => {
  beforeEach(() => {
    // A nap whose second stage starts before its first has ended.
    world.state.hc.records.get(DEVICE_ID)?.push(
      interval("nap-overlap", "SleepSession", at(14), at(15), {
        stages: [
          { start: at(14), end: at(14, 40), stage: "LIGHT" },
          { start: at(14, 20), end: at(15), stage: "DEEP" },
        ],
      }),
    );
  });

  it("says so on the night, on the day and as a finding, and counts no minute twice", async () => {
    const nights = await call("sleep_sessions", RANGE);
    const days = await call("daily_summary", { date: TODAY });
    const quality = await call("data_quality", { ...RANGE, types: ["SleepSession"] });
    const nap = nights.items.find((item) => item.id === "blind-nap-overlap");

    expect(nights.items.map((item) => item.stagesOverlap)).toStrictEqual([false, true]);
    expect(Number(nap?.asleepMin)).toBeLessThanOrEqual(60);
    expect(days.items[0]?.flags).toContain("sleep_stages_overlap");
    expect(quality.items).toStrictEqual([
      {
        resourceType: "hc:SleepSession",
        healthSystemId: SOURCE,
        kind: "overlapping_stages",
        origin: WEARABLE,
        start: `${TODAY}T14:00:00+00:00`,
        end: `${TODAY}T15:00:00+00:00`,
      },
    ]);
  });
});

describe("exercise_sessions", () => {
  it("returns each workout with what was measured during it and the left-running flag", async () => {
    const answer = await call("exercise_sessions", RANGE);

    expect(answer.items).toStrictEqual([
      {
        resourceType: "hc:ExerciseSession",
        healthSystemId: SOURCE,
        id: "blind-walk-1",
        title: "Evening walk",
        exerciseType: "WALKING",
        start: `${TODAY}T18:30:00+00:00`,
        end: `${TODAY}T19:10:00+00:00`,
        durationMin: 40,
        hr: { min: 128, mean: 128, max: 128, n: 40 },
        energy: null,
        distance: 3000,
        steps: null,
        overThreeHours: false,
        likelyLeftRunning: false,
        zeroLength: false,
        exactDuplicate: false,
        hasRoute: false,
        contextClamped: false,
        origin: WEARABLE,
        mergedSessions: 1,
        exactDuplicates: 0,
        origins: [WEARABLE],
        spanStart: `${TODAY}T18:30:00+00:00`,
        spanEnd: `${TODAY}T19:10:00+00:00`,
        spanMin: 40,
        members: [
          {
            id: "blind-walk-1",
            start: `${TODAY}T18:30:00+00:00`,
            end: `${TODAY}T19:10:00+00:00`,
            exerciseType: "WALKING",
            origin: WEARABLE,
          },
        ],
      },
      expect.objectContaining({
        exerciseType: "OTHER_WORKOUT",
        durationMin: 240,
        overThreeHours: true,
        likelyLeftRunning: true,
        origin: PHONE,
      }),
    ]);
  });

  it("filters by exercise type, case-insensitively", async () => {
    const answer = await call("exercise_sessions", { ...RANGE, types: ["walking"] });

    expect(answer.items.map((item) => item.exerciseType)).toStrictEqual(["WALKING"]);
  });

  it("merges the same workout from two apps, spanning both, and counts the exact copy", async () => {
    world.state.hc.records.get(DEVICE_ID)?.push(
      interval(
        "walk-copy",
        "ExerciseSession",
        at(18, 30),
        at(19, 10),
        { exerciseType: "WALKING" },
        {
          origin: PHONE,
        },
      ),
      interval(
        "walk-tail",
        "ExerciseSession",
        at(19),
        at(19, 20),
        { exerciseType: "WALKING" },
        {
          origin: PHONE,
        },
      ),
    );

    const answer = await call("exercise_sessions", { ...RANGE, types: ["WALKING"] });

    expect(answer.items).toHaveLength(1);
    expect(answer.items[0]).toMatchObject({
      // The row's own times are its longest session's, like its heart rate...
      id: "blind-walk-1",
      start: `${TODAY}T18:30:00+00:00`,
      end: `${TODAY}T19:10:00+00:00`,
      durationMin: 40,
      hr: { n: 40 },
      // ...the stretch all three cover is beside them...
      spanStart: `${TODAY}T18:30:00+00:00`,
      spanEnd: `${TODAY}T19:20:00+00:00`,
      spanMin: 50,
      mergedSessions: 3,
      exactDuplicates: 1,
      origins: [PHONE, WEARABLE],
    });
    // ...and every session the row stands for is still listed.
    expect(
      (answer.items[0]?.members as { id: string; end: string }[]).map((m) => [m.id, m.end]),
    ).toStrictEqual([
      ["blind-walk-copy", `${TODAY}T19:10:00+00:00`],
      ["blind-walk-1", `${TODAY}T19:10:00+00:00`],
      ["blind-walk-tail", `${TODAY}T19:20:00+00:00`],
    ]);
  });
});

describe("blood_pressure", () => {
  it("drops the duplicate, groups the sitting, and joins the cuff's pulse", async () => {
    const answer = await call("blood_pressure", RANGE);

    expect(answer.warnings).toStrictEqual(["hc_duplicates_dropped:1"]);
    expect(envelope(answer)).toMatchObject({
      sessionWindowMin: 10,
      units: { systolic: "mmHg", diastolic: "mmHg", pulse: "bpm" },
    });
    expect(answer.items).toStrictEqual([
      {
        kind: "session",
        resourceType: "hc:BloodPressure",
        healthSystemId: SOURCE,
        start: `${TODAY}T09:00:00+00:00`,
        end: `${TODAY}T09:02:00+00:00`,
        systolic: 119,
        diastolic: 78,
        pulse: 68,
        readingCount: 2,
        origins: [CUFF],
        readings: [
          {
            id: "bp-1",
            time: `${TODAY}T09:00:00+00:00`,
            systolic: 121,
            diastolic: 79,
            bodyPosition: "SITTING_DOWN",
            measurementLocation: "LEFT_UPPER_ARM",
            pulse: 68,
            origin: CUFF,
          },
          expect.objectContaining({ id: "bp-2", systolic: 117, pulse: null }),
        ],
      },
    ]);
  });

  it("keeps every copy with dedupe off, and returns readings ungrouped on request", async () => {
    const all = await call("blood_pressure", { ...RANGE, dedupe: false, group_sessions: false });

    expect(all.warnings).toStrictEqual([]);
    expect(all.items.map((item) => [item.kind, item.id])).toStrictEqual([
      ["reading", "bp-1"],
      ["reading", "bp-1-relayed"],
      ["reading", "bp-2"],
    ]);
  });

  it("splits sittings by the caller's window", async () => {
    const answer = await call("blood_pressure", { ...RANGE, window_min: 1 });

    expect(answer.items.map((item) => item.readingCount)).toStrictEqual([1, 1]);
    expect(envelope(answer).sessionWindowMin).toBe(1);
  });
});

describe("daily_summary", () => {
  it("joins a day: totals, sleep, heart, pressure, weight, workouts and what to distrust", async () => {
    const answer = await call("daily_summary", RANGE);

    expect(answer.items[0]).toStrictEqual({
      resourceType: "hc:DailySummary",
      healthSystemId: SOURCE,
      date: YESTERDAY,
      steps: null,
      distance: null,
      activeKcal: null,
      totalKcal: null,
      sleep: null,
      restingHr: null,
      hrvRmssd: null,
      respiratoryRate: null,
      bloodPressure: null,
      weight: null,
      weighings: [],
      exercises: [],
      flags: [],
    });
    expect(answer.items[1]).toMatchObject({
      date: TODAY,
      steps: 4 * 520 + 6 * 500,
      distance: 3000,
      activeKcal: 200,
      // What was recorded: ten hours of it, and no basal padding.
      totalKcal: 1000,
      sleep: { asleepMin: 460, inBedMin: 480, naps: 0, origin: WEARABLE },
      // The wearable's 52, not the mean of it and the cuff's 68.
      restingHr: 52,
      hrvRmssd: 43,
      respiratoryRate: 14,
      bloodPressure: { systolic: 119, diastolic: 78, readings: 2 },
      // The weighing, not the weight typed into a profile beside a height --
      // which is still listed, with the flag that took it out of the figure.
      weight: 70.5,
      weighings: [
        { time: `${TODAY}T07:10:00+00:00`, weight: 70.5, origin: PHONE, flag: null },
        {
          time: `${TODAY}T12:00:00+00:00`,
          weight: 70,
          origin: PHONE,
          flag: "weight_profile_setup",
        },
      ],
      exercises: [
        {
          title: "Evening walk",
          exerciseType: "WALKING",
          durationMin: 40,
          overThreeHours: false,
          likelyLeftRunning: false,
        },
        {
          exerciseType: "OTHER_WORKOUT",
          durationMin: 240,
          overThreeHours: true,
          likelyLeftRunning: true,
        },
      ],
      flags: [
        "other_origins_dropped",
        "exercise_over_three_hours",
        "exercise_likely_left_running",
        "bp_duplicates_dropped",
        "resting_hr_cuff_pulse_excluded",
        "weight_profile_artefact_excluded",
      ],
    });
    // Counted per kind: a copy of a reading is not an app that lost an hour.
    expect(answer.warnings).toStrictEqual([
      "hc_bp_duplicates_dropped:1",
      "hc_other_origins_dropped:6",
      "resting_hr_cuff_pulse_excluded:1",
    ]);
  });

  it("takes one date, and today when given nothing", async () => {
    const one = await call("daily_summary", { date: TODAY });
    const none = await call("daily_summary");

    expect(one.items.map((item) => item.date)).toStrictEqual([TODAY]);
    // The fake clock is the first instant of the next day.
    expect(none.items.map((item) => [item.date, item.flags])).toStrictEqual([
      [date(NOW_MS), ["partial_day"]],
    ]);
  });

  it("answers totals from day rollups and reads only the sparse types raw", async () => {
    world.state.hc.calls.length = 0;
    // Yesterday alone has no platform figure to check hour by hour.
    await call("daily_summary", { date: YESTERDAY });
    const raw = world.state.hc.calls.filter((entry) => entry.reader === "records");

    expect(raw.map((entry) => entry.type)).toStrictEqual([
      "BloodPressure",
      "RestingHeartRate",
      "Weight",
      "Height",
    ]);
    expect(readers()).not.toContain("hourRollups");
    expect(readers()).not.toContain("hrMinutes");
  });
});

/** Every finding of a range, however many bytes that is. */
async function findings(args: Record<string, unknown> = RANGE): Promise<Record<string, unknown>[]> {
  const answer = await call("data_quality", { ...args, max_bytes: 10_000_000 });
  return answer.items;
}

/** `hc:<Type>:<kind>` of each finding. */
function kinds(items: readonly Record<string, unknown>[]): string[] {
  return items.map((item) => `${String(item.resourceType)}:${String(item.kind)}`);
}

describe("data_quality", () => {
  it("reports each kind of thing, tagged with the type it is about, and its thresholds", async () => {
    const answer = await call("data_quality", RANGE);

    expect(kinds(answer.items)).toStrictEqual([
      "hc:BloodPressure:duplicate",
      "hc:HeartRate:artefact",
      "hc:FloorsClimbed:noisy_series",
      "hc:Weight:artefact",
      "hc:ExerciseSession:long_session",
      "hc:ExerciseSession:likely_left_running",
      "hc:Steps:overlapping_origins",
    ]);
    expect(answer.items[0]).toMatchObject({
      reason: "same_second_same_reading",
      origin: PHONE,
      duplicateOf: "bp-1",
    });
    expect(answer.items[1]).toMatchObject({
      reason: "heart_rate_implausible",
      hour: `${TODAY}T08:00:00+00:00`,
      count: 1,
      maxValue: 232,
    });
    expect(answer.items[3]).toMatchObject({ reason: "weight_profile_setup", value: 70 });
    expect(answer.items[6]).toMatchObject({
      date: TODAY,
      origins: { [PHONE]: 10, [WEARABLE]: 10 },
    });
    expect(envelope(answer).rules).toMatchObject({
      heartRateMaxBpm: 200,
      speedMaxMps: 15,
      gapMinDayCoverage: 0.5,
    });
  });

  it("opens raw heart rate only for the hour whose rollup says a rule could fire", async () => {
    world.state.hc.calls.length = 0;
    await findings({ ...RANGE, types: ["HeartRate"] });

    // The record holding the bad sample starts at 07:00, so that is its hour.
    expect(world.state.hc.calls.filter((entry) => entry.reader === "records")).toStrictEqual([
      { reader: "records", type: "HeartRate", startMs: at(7), endMs: at(8) },
    ]);
  });

  it("finds a gap in a type recorded most days, and the app that supplies it changing", async () => {
    const records = world.state.hc.records.get(DEVICE_ID) ?? [];
    for (const [daysAgo, origin] of [
      [9, WEARABLE],
      [8, WEARABLE],
      [7, WEARABLE],
      [4, PHONE],
      [3, PHONE],
    ] as const) {
      const start = DAY - daysAgo * 24 * HOUR_MS + 10 * HOUR_MS;
      records.push(
        interval(
          `floors-${String(daysAgo)}`,
          "FloorsClimbed",
          start,
          start + MINUTE_MS,
          { floors: 3 },
          { origin },
        ),
      );
    }
    const start = date(DAY - 10 * 24 * HOUR_MS);

    const items = await findings({ start, end: TODAY, types: ["FloorsClimbed"] });

    expect(items.filter((item) => item.kind === "gap")).toStrictEqual([
      expect.objectContaining({
        from: date(DAY - 6 * 24 * HOUR_MS),
        days: 2,
        resumed: date(DAY - 4 * 24 * HOUR_MS),
      }),
      expect.objectContaining({ from: date(DAY - 2 * 24 * HOUR_MS), days: 2, resumed: TODAY }),
    ]);
    expect(items.filter((item) => item.kind === "source_switch")).toStrictEqual([
      expect.objectContaining({ date: date(DAY - 4 * 24 * HOUR_MS), from: WEARABLE, to: PHONE }),
      expect.objectContaining({ date: TODAY, from: PHONE, to: WEARABLE }),
    ]);
  });

  it("flags a change from rounded to unrounded values, not a value that happens to end in zero", async () => {
    const records = world.state.hc.records.get(DEVICE_ID) ?? [];
    records.push(
      {
        id: "w3",
        type: "Weight",
        origin: PHONE,
        lastModified: 1,
        time: at(13),
        data: { weight: 70.30684 },
      },
      {
        id: "w4",
        type: "Weight",
        origin: PHONE,
        lastModified: 1,
        time: at(14),
        data: { weight: 71 },
      },
    );

    const items = await findings({ ...RANGE, types: ["Weight"] });

    // 70.5 -> 70 is not a change; 70 -> 70.30684 and back are.
    expect(items.filter((item) => item.kind === "precision_change")).toStrictEqual([
      expect.objectContaining({ at: `${TODAY}T13:00:00+00:00`, from: "rounded", to: "unrounded" }),
      expect.objectContaining({ at: `${TODAY}T14:00:00+00:00`, from: "unrounded", to: "rounded" }),
    ]);
  });

  it("yields nothing for a type the policy denies, and does not use it as context", async () => {
    world.state.rules = buildRules([
      { rule_type: "resource", target: "hc:HeartRate" },
      { rule_type: "resource", target: "hc:Height" },
      { rule_type: "resource", target: "hc:BasalMetabolicRate" },
    ]);
    world.state.hc.calls.length = 0;

    const items = await findings();

    expect(kinds(items)).toStrictEqual([
      "hc:BloodPressure:duplicate",
      "hc:FloorsClimbed:noisy_series",
      // Without the height beside it the profile weight cannot be told apart,
      // and without heart rate the left-running flag is not reported -- only
      // that the session is long, which its own times say.
      "hc:ExerciseSession:long_session",
      "hc:Steps:overlapping_origins",
    ]);
    const read = new Set(world.state.hc.calls.map((entry) => entry.type));
    expect(read.has("HeartRate") || read.has("Height") || read.has("BasalMetabolicRate")).toBe(
      false,
    );
  });
});

describe("hc_coverage and hc_sync_status", () => {
  it("describes a type: counts, first and last, cadence, the apps and the newest record's source", async () => {
    world.state.hc.records.get(DEVICE_ID)?.push({
      id: "bp-3",
      type: "BloodPressure",
      origin: CUFF,
      lastModified: 1,
      time: at(20),
      device: { type: "UNKNOWN", manufacturer: "Example", model: "Cuff 2" },
      recordingMethod: "AUTOMATICALLY_RECORDED",
      data: { systolic: 118, diastolic: 76 },
    });
    world.state.hc.syncRows.set(
      DEVICE_ID,
      (world.state.hc.syncRows.get(DEVICE_ID) ?? []).map((row) =>
        row.recordType === "BloodPressure" ? { ...row, lastMs: at(20), recordCount: 4 } : row,
      ),
    );

    const answer = await call("hc_coverage", { types: ["BloodPressure"] });

    expect(answer.items).toStrictEqual([
      {
        kind: "type_coverage",
        healthSystem: "Test phone",
        healthSystemId: SOURCE,
        resourceType: "hc:BloodPressure",
        type: "BloodPressure",
        availability: "ok",
        status: "ok",
        recordCount: 4,
        firstAt: `${TODAY}T09:00:00+00:00`,
        lastAt: `${TODAY}T20:00:00+00:00`,
        meanIntervalS: 13_200,
        lastSyncAt: zoned(NOW_MS - 600_000),
        staleHours: null,
        origins: [CUFF, PHONE],
        lastRecordFrom: {
          origin: CUFF,
          device: { type: "UNKNOWN", manufacturer: "Example", model: "Cuff 2" },
          recordingMethod: "AUTOMATICALLY_RECORDED",
        },
      },
    ]);
  });

  it("opens no stored record with origins off", async () => {
    world.state.hc.calls.length = 0;
    const answer = await call("hc_coverage", { origins: false });

    expect(readers()).toStrictEqual([]);
    expect(Object.hasOwn(answer.items[0] ?? {}, "origins")).toBe(false);
  });

  it("reports the pipeline: last upload, backlog, backfill, the phone's own flags, failures", async () => {
    const answer = await call("hc_sync_status");
    const [phone] = answer.items;

    expect(phone).toMatchObject({
      kind: "device",
      healthSystem: "Test phone",
      status: "active",
      lastUploadAt: zoned(NOW_MS - 600_000),
      hoursSinceUpload: 0,
      appVersion: "0.1.1",
      backgroundRead: true,
      historyRead: true,
      batteryOptimisationExempt: true,
      backfillComplete: false,
      androidSdk: 37,
      lastPhoneError: null,
      phoneBacklog: 0,
      queuedBatches: 0,
      rollupsPending: 0,
      recentBatches: 2,
      recentFailures: [{ receivedAt: zoned(NOW_MS - 4_000_000), errorCode: "apply_failed" }],
    });
    expect(answer.items.find((item) => item.type === "Steps")).toMatchObject({
      kind: "type_sync",
      resourceType: "hc:Steps",
      availability: "ok",
      recordCount: 20,
      tokenAgeS: 120,
      backfillComplete: true,
    });
  });

  it("reports uploads that could not be applied, and warns that their data is missing", async () => {
    world.state.hc.backlog.set(DEVICE_ID, {
      queuedBatches: 0,
      parkedBatches: 2,
      dirty: 0,
      rezonePending: false,
    });

    const status = await call("hc_sync_status");
    const steps = await call("hc_aggregate", { type: "Steps", ...RANGE });

    expect(status.items[0]).toMatchObject({ kind: "device", parkedBatches: 2, queuedBatches: 0 });
    expect(status.warnings).toContain(`hc_batches_parked:${SOURCE}:2`);
    expect(steps.warnings).toContain(`hc_batches_parked:${SOURCE}:2`);
  });

  it("does not answer from day rollups while a change of zone is still being rebuilt", async () => {
    world.state.hc.backlog.set(DEVICE_ID, {
      queuedBatches: 0,
      parkedBatches: 0,
      dirty: 0,
      rezonePending: true,
    });
    world.state.hc.calls.length = 0;

    const steps = await call("hc_aggregate", { type: "Steps", ...RANGE });

    expect(steps.warnings).toContain(`hc_store_pending:${SOURCE}`);
    expect(readers()).not.toContain("dayRollups");
  });

  it("does not count a denied type's records in the phone's totals, or list it", async () => {
    const before = await call("hc_sync_status");
    world.state.rules = buildRules([{ rule_type: "resource", target: "hc:Steps" }]);
    const after = await call("hc_sync_status", { max_bytes: 10_000_000 });

    expect(Number(before.items[0]?.records) - Number(after.items[0]?.records)).toBe(20);
    expect(after.items.some((item) => String(item.type).includes("Steps"))).toBe(false);
    expect(after.coverage?.some((entry) => String(entry.resourceType).includes("Steps"))).toBe(
      false,
    );
  });
});

/** The summary's phone items, picked out with `jq`. */
async function phoneItems(): Promise<Record<string, unknown>[]> {
  const answer = await call("get_health_summary", { jq: '.[] | select(.kind == "phone")' });
  return answer.items;
}

describe("get_health_summary's phone lines", () => {
  it("adds the last upload, the newest reading and last night's sleep, apart from the FHIR sections", async () => {
    expect(await phoneItems()).toStrictEqual([
      {
        kind: "phone",
        section: "sync",
        healthSystem: "Test phone",
        healthSystemId: SOURCE,
        status: "active",
        lastUploadAt: zoned(NOW_MS - 600_000),
        hoursSinceUpload: 0,
      },
      {
        kind: "phone",
        section: "latest_blood_pressure",
        healthSystem: "Test phone",
        resourceType: "hc:BloodPressure",
        healthSystemId: SOURCE,
        time: `${TODAY}T09:02:00+00:00`,
        systolic: 117,
        diastolic: 77,
        origin: CUFF,
      },
      {
        kind: "phone",
        section: "last_night_sleep",
        healthSystem: "Test phone",
        resourceType: "hc:SleepSession",
        healthSystemId: SOURCE,
        date: TODAY,
        start: `${YESTERDAY}T23:00:00+00:00`,
        end: `${TODAY}T07:00:00+00:00`,
        inBedMin: 480,
        asleepMin: 460,
        origin: WEARABLE,
      },
    ]);
  });

  it("leaves get_vitals to the health systems: no phone reading appears there", async () => {
    const vitals = await call("get_vitals");

    expect(vitals.text).not.toContain("device:");
    expect(vitals.text).not.toContain("hc:");
  });

  it("drops a line whose type the policy denies, and its coverage with it", async () => {
    world.state.rules = buildRules([{ rule_type: "resource", target: "hc:BloodPressure" }]);

    const summary = await call("get_health_summary");
    const sections = summary.items
      .filter((item) => item.kind === "phone")
      .map((item) => item.section);

    expect(sections).toStrictEqual(["sync", "last_night_sleep"]);
    expect(summary.coverage?.some((entry) => entry.resourceType === "hc:BloodPressure")).toBe(
      false,
    );
  });

  it("adds nothing when no phone is paired", async () => {
    world.state = fakeState();
    world.client = await connectTools(fakeDeps(world.state));

    expect(await phoneItems()).toStrictEqual([]);
  });
});
