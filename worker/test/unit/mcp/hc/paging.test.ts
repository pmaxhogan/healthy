// Paging a Health Connect answer: the byte budget as it is actually sent, a
// cursor that survives nothing it should not, and -- for `hc_records`, whose
// continuation resumes by time instead of re-reading -- a paged read that is
// row for row the single read.
//
// The last is where the subtle bugs live, so it is checked as an equivalence
// over the awkward cases at once: records that spill into the range from
// before it, two phones with records at the same instant, a descending read,
// and page sizes small enough that every boundary lands somewhere different.
//
// Everything is synthetic.

import { beforeEach, describe, expect, it } from "vitest";

import { buildRules } from "../../../../src/policy/rules.ts";
import {
  DEVICE_ID,
  HOUR_MS,
  MINUTE_MS,
  PHONE,
  addDevice,
  device,
  emptyHc,
  hcWorld,
  interval,
} from "../hc-fake.ts";
import { NOW, callTool, connectTools, fakeDeps, fakeState } from "../helpers.ts";

import type { HcRecord } from "../../../../src/hc/wire.ts";
import type { FakeState, ToolAnswer } from "../helpers.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const NOW_MS = NOW * 1000;
const DAY = NOW_MS - 24 * HOUR_MS;
const at = (hour: number, minute = 0): number => DAY + hour * HOUR_MS + minute * MINUTE_MS;
const instant = (ms: number): string => new Date(ms).toISOString();
const date = (ms: number): string => instant(ms).slice(0, 10);

const world: { state: FakeState; client: Client } = {
  state: undefined as unknown as FakeState,
  client: undefined as unknown as Client,
};

async function start(state: FakeState): Promise<void> {
  world.state = state;
  world.client = await connectTools(fakeDeps(state));
}

const call = (name: string, args: Record<string, unknown>): Promise<ToolAnswer> =>
  callTool(world.client, name, args);

const envelope = (answer: ToolAnswer): Record<string, unknown> =>
  JSON.parse(answer.text) as Record<string, unknown>;

/** Every page of a call, following the cursor to the end. */
async function pages(name: string, args: Record<string, unknown>): Promise<ToolAnswer[]> {
  const out: ToolAnswer[] = [];
  let cursor: unknown;
  for (let guard = 0; guard < 2000; guard += 1) {
    const page = await call(name, { ...args, ...(cursor !== undefined && { cursor }) });
    expect(page.isError, page.text).toBe(false);
    out.push(page);
    cursor = envelope(page).cursor;
    if (cursor === undefined) return out;
  }
  throw new Error("the cursor never ran out");
}

// --- hc_records: paged is the same as single --------------------------------

const SECOND_PHONE = "dev_second_phone";

/**
 * Sleep-like records around a six-hour range starting at 06:00: two that began
 * before it and reach into it, one that ended before it (and must never
 * appear), runs of records at the same instant on two phones, and one that
 * starts in the range and runs past its end.
 */
function spillingRecords(): { first: HcRecord[]; second: HcRecord[] } {
  const session = (id: string, startMs: number, endMs: number, origin?: string): HcRecord =>
    interval(
      id,
      "SleepSession",
      startMs,
      endMs,
      { title: id },
      origin === undefined ? {} : { origin },
    );
  const first: HcRecord[] = [
    session("ended-before", at(1), at(2)),
    session("spill-early", at(3), at(7)),
    session("spill-late", at(5, 30), at(6, 1)),
    session("runs-past-end", at(11, 59), at(15)),
  ];
  const second: HcRecord[] = [session("other-spill", at(3), at(6, 30), PHONE)];
  for (let hour = 6; hour < 12; hour += 1) {
    // Three records at each hour's start on one phone, two on the other: ties
    // within a phone and across phones.
    for (const copy of ["a", "b", "c"]) {
      first.push(session(`h${String(hour)}-${copy}`, at(hour), at(hour, 20)));
    }
    second.push(
      session(`h${String(hour)}-x`, at(hour), at(hour, 10), PHONE),
      session(`h${String(hour)}-y`, at(hour), at(hour, 5), PHONE),
      session(`m${String(hour)}`, at(hour, 30), at(hour, 45), PHONE),
    );
  }
  return { first, second };
}

const RANGE = { type: "SleepSession", start: instant(at(6)), end: instant(at(12)) };

describe("hc_records, paged against single", () => {
  beforeEach(async () => {
    const hc = emptyHc();
    const { first, second } = spillingRecords();
    addDevice(hc, device(DEVICE_ID, "Test phone", NOW - 600), first);
    addDevice(hc, device(SECOND_PHONE, "Second phone", NOW - 600), second);
    await start(fakeState({ hc }));
  });

  it("returns what overlaps the range, spill-ins included, in a total order", async () => {
    const whole = await call("hc_records", { ...RANGE, max_bytes: 10_000_000 });
    const ids = whole.items.map((item) => item.id);

    expect(whole.items).toHaveLength(40);
    expect(ids.slice(0, 3)).toStrictEqual(["other-spill", "spill-early", "spill-late"]);
    expect(ids).not.toContain("ended-before");
    expect(ids.at(-1)).toBe("runs-past-end");
    expect(whole.truncated).toBe(false);
  });

  it.each([
    ["asc", 1],
    ["asc", 2],
    ["asc", 3],
    ["asc", 7],
    ["desc", 1],
    ["desc", 2],
    ["desc", 5],
    ["desc", 11],
  ])("gives the same rows %s in pages of %i", async (order, limit) => {
    const args = { ...RANGE, order };
    const whole = await call("hc_records", { ...args, max_bytes: 10_000_000 });
    const paged = await pages("hc_records", { ...args, limit });

    expect(paged.flatMap((page) => page.items)).toStrictEqual(whole.items);
    expect(paged).toHaveLength(Math.ceil(40 / limit));
    // `total` and `matched` are the whole answer's on every page.
    for (const page of paged) {
      expect(page.total).toBe(40);
      expect(envelope(page).matched).toBe(40);
    }
  });

  it("gives the same rows when the byte budget cuts the pages", async () => {
    const whole = await call("hc_records", { ...RANGE, max_bytes: 10_000_000 });
    const paged = await pages("hc_records", { ...RANGE, max_bytes: 700 });

    expect(paged.length).toBeGreaterThan(5);
    expect(paged.flatMap((page) => page.items)).toStrictEqual(whole.items);
  });

  it("never reads beyond the original range on a continuation", async () => {
    const first = await call("hc_records", { ...RANGE, limit: 1 });
    world.state.hc.calls.length = 0;
    await call("hc_records", { ...RANGE, limit: 1, cursor: envelope(first).cursor });

    // The anchor is a record that began at 03:00; the read still starts at 06:00.
    expect(world.state.hc.calls.every((entry) => entry.startMs === at(6))).toBe(true);
  });

  it("resumes from the cursor's time once it is inside the range", async () => {
    const first = await call("hc_records", { ...RANGE, limit: 20 });
    world.state.hc.calls.length = 0;
    await call("hc_records", { ...RANGE, cursor: envelope(first).cursor });

    expect(new Set(world.state.hc.calls.map((entry) => entry.startMs))).toStrictEqual(
      new Set([at(8, 30)]),
    );
  });

  it("falls back to a plain offset when a rule hides the times the cursor anchors on", async () => {
    world.state.rules = buildRules([
      {
        rule_type: "field",
        target: "hide-times",
        effect: "hide",
        scope_tool: "hc_records",
        scope_resource: null,
        scope_health_system: null,
        paths_json: JSON.stringify(["start", "end"]),
      },
    ]);
    const whole = await call("hc_records", { ...RANGE, max_bytes: 10_000_000 });
    const paged = await pages("hc_records", { ...RANGE, limit: 7 });

    expect(whole.items[0]).not.toHaveProperty("start");
    expect(paged.flatMap((page) => page.items)).toStrictEqual(whole.items);
    expect(paged.every((page) => page.total === 40)).toBe(true);
  });

  it("pages a projected answer by offset, and counts the rows `jq` emitted", async () => {
    const args = { ...RANGE, jq: ".[] | .id" };
    const whole = await call("hc_records", { ...args, max_bytes: 10_000_000 });
    const paged = await pages("hc_records", { ...args, limit: 9 });

    expect(paged.flatMap((page) => page.items)).toStrictEqual(whole.items);
    expect(paged.every((page) => envelope(page).matched === 40)).toBe(true);
  });
});

// --- the cursor and the store ------------------------------------------------

const TWO_DAYS = { start: date(DAY - 1), end: date(DAY) };

describe("a cursor over a store that has changed", () => {
  beforeEach(async () => {
    await start(fakeState({ hc: hcWorld(NOW) }));
  });

  it.each([
    ["hc_records", { type: "Steps", ...TWO_DAYS }],
    ["hc_aggregate", { type: "Steps", ...TWO_DAYS, bucket: "hour" }],
    ["hc_coverage", {}],
    ["hc_sync_status", {}],
  ])("%s answers cursor_expired after an upload, and a fresh call works", async (tool, args) => {
    const first = await call(tool, { ...args, limit: 2 });
    const { cursor } = envelope(first);
    const sameStore = await call(tool, { ...args, limit: 2, cursor });
    // An upload arrives between the two pages.
    const [phone] = world.state.hc.devices;
    if (phone === undefined) throw new Error("one phone");
    phone.lastUploadAt = NOW - 1;

    const stale = await call(tool, { ...args, limit: 2, cursor });
    const fresh = await call(tool, { ...args, limit: 2 });

    expect(first.truncated).toBe(true);
    expect(sameStore.isError).toBe(false);
    expect(stale).toMatchObject({ isError: true, error: "cursor_expired" });
    expect(stale.text).toContain("without `cursor`");
    expect(fresh.isError).toBe(false);
    expect(world.state.audits.at(-2)).toMatchObject({ ok: false, errorCode: "cursor_expired" });
  });

  it("expires when a queued batch is applied or a rollup rebuilt, too", async () => {
    const args = { type: "Steps", ...TWO_DAYS, limit: 2 };
    const first = await call("hc_records", args);
    world.state.hc.backlog.set(DEVICE_ID, {
      queuedBatches: 0,
      parkedBatches: 0,
      dirty: 1,
      rezonePending: false,
    });

    const stale = await call("hc_records", { ...args, cursor: envelope(first).cursor });

    expect(stale).toMatchObject({ isError: true, error: "cursor_expired" });
  });

  it("still calls another question's cursor invalid, not expired", async () => {
    const first = await call("hc_records", { type: "Steps", ...TWO_DAYS, limit: 2 });

    const other = await call("hc_records", {
      type: "Distance",
      ...TWO_DAYS,
      cursor: envelope(first).cursor,
    });

    expect(other).toMatchObject({ isError: true, error: "invalid_cursor" });
  });
});

// --- the bytes actually sent ---------------------------------------------------

describe("the byte budget", () => {
  beforeEach(async () => {
    await start(fakeState({ hc: hcWorld(NOW) }));
  });

  it("sends a paged answer as compact JSON, and counts those bytes", async () => {
    const answer = await call("hc_records", { type: "Steps", ...TWO_DAYS, max_bytes: 1500 });
    const sent = answer.text.slice(answer.text.indexOf("[") + 1, answer.text.indexOf('],"total"'));

    expect(answer.text).not.toContain("\n");
    expect(answer.truncated).toBe(true);
    expect(new TextEncoder().encode(sent).length).toBeLessThanOrEqual(1500);
    // And it is the rows themselves that were measured.
    expect(sent).toBe(JSON.stringify(answer.items).slice(1, -1));
  });

  it("leaves every other tool's answer indented, as it was", async () => {
    const answer = await call("get_health_summary", {});

    expect(answer.text).toContain('\n  "items": [');
  });
});

// --- inputs ----------------------------------------------------------------------

describe("what the two typed tools accept", () => {
  beforeEach(async () => {
    await start(fakeState({ hc: hcWorld(NOW) }));
  });

  it("refuses a range that runs backwards, by name", async () => {
    const reversed = { type: "Steps", start: date(DAY), end: date(DAY - 2 * 24 * HOUR_MS) };

    const raw = await call("hc_records", reversed);
    const summed = await call("hc_aggregate", reversed);

    expect(raw).toMatchObject({ isError: true, error: "invalid_range" });
    expect(summed).toMatchObject({ isError: true, error: "invalid_range" });
    expect(raw.text).toContain("`end` is before `start`");
  });

  it("refuses a minute bucket wider than a day instead of treating it as one", async () => {
    const wide = await call("hc_aggregate", { type: "Steps", ...TWO_DAYS, bucket: "99999min" });
    const day = await call("hc_aggregate", { type: "Steps", ...TWO_DAYS, bucket: "1440min" });
    const none = await call("hc_aggregate", { type: "Steps", ...TWO_DAYS, bucket: "0min" });

    expect(wide.text).toContain("Invalid arguments");
    expect(none.text).toContain("Invalid arguments");
    expect(day.isError).toBe(false);
  });

  it("refuses a type the wire could not carry", async () => {
    for (const type of ["", "9Lives", "Heart Rate", "x".repeat(65)]) {
      const answer = await call("hc_records", { type, ...TWO_DAYS });
      expect(answer.text, type).toContain("Invalid arguments");
    }
  });

  it("calls an aggregate it has no source type for unknown, not denied", async () => {
    const answer = await call("hc_records", { type: "Agg.SomethingNew", ...TWO_DAYS });

    expect(answer.items).toStrictEqual([]);
    expect(answer.warnings).toContain("unknown_type:hc:Agg.SomethingNew");
    expect(answer.text).not.toContain("policy_resource_denied");
  });
});
