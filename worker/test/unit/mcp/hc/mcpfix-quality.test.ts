// `data_quality`: which types a gap is reported for, the night whose session
// did not arrive, and a long range assessed a window at a time.
//
//   - a gap is a finding for what a device records unasked (steps, heart
//     rate, sleep), never for what a person does now and then (a workout, a
//     blood-pressure reading);
//   - a date with the wearable's overnight figures and no sleep session to
//     account for them is `session_missing`;
//   - `dataQualityPage` walks a range in half-year windows, stops when a page
//     is full, and loses nothing where it cuts: a gap, a change of source, a
//     precision change and an overlapping pair that straddle a cut are each
//     found exactly once, and a silence longer than the lookback is still
//     measured from where it began.
//
// Everything is synthetic: invented values, RFC 2606 style package names, and
// no zone but UTC.

import { beforeEach, describe, expect, it } from "vitest";

import { openStampedPage } from "../../../../src/mcp/hc/page.ts";
import {
  QUALITY_LOOKBACK_DAYS,
  QUALITY_MAX_WINDOWS_PER_CALL,
  QUALITY_WINDOW_DAYS,
  dataQuality,
  dataQualityInOneRead,
  dataQualityPage,
  isGapType,
} from "../../../../src/mcp/hc/quality.ts";
import { beginHcCall, hcRespond } from "../../../../src/mcp/hc/sources.ts";
import { zoneClock } from "../../../../src/mcp/hc/time.ts";
import { EMPTY_RULES } from "../../../../src/policy/rules.ts";
import {
  HOUR_MS,
  MINUTE_MS,
  PHONE,
  WEARABLE,
  addDevice,
  device,
  emptyHc,
  fakeHcReads,
  instant,
  interval,
} from "../hc-fake.ts";
import { NOW, callTool, connectTools, fakeDeps, fakeState } from "../helpers.ts";

import type { HcRecord } from "../../../../src/hc/wire.ts";
import type { Finding, QualityRequest } from "../../../../src/mcp/hc/quality.ts";
import type { FakeHc } from "../hc-fake.ts";
import type { ToolAnswer } from "../helpers.ts";

const DEVICE = "dev_quality";
const DAY_MS = 24 * HOUR_MS;
const NOW_MS = NOW * 1000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function phoneWith(records: readonly HcRecord[]): FakeHc {
  const hc = emptyHc();
  addDevice(hc, device(DEVICE, "Quality phone", NOW - 600), records);
  return hc;
}

async function ask(hc: FakeHc, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const client = await connectTools(fakeDeps(fakeState({ hc })));
  return callTool(client, name, { max_bytes: 1_000_000, ...args });
}

/** A sorted copy, in code-unit order. */
function inOrder(texts: readonly string[]): string[] {
  const out = [...texts];
  out.sort((left, right) => left.localeCompare(right));
  return out;
}

const sortedKeys = (findings: readonly Finding[]): string[] =>
  inOrder(findings.map((finding) => JSON.stringify(finding)));

const missing = (answer: ToolAnswer): Record<string, unknown>[] =>
  answer.items.filter((item) => item.kind === "session_missing");

/** One page of the tool's answer, as a client reads it. */
interface Page {
  items: Record<string, unknown>[];
  truncated: boolean;
  cursor?: string;
  total: number;
}

const rowsOf = (pages: readonly Page[]): string[] =>
  pages.flatMap((page) => page.items.map((item) => JSON.stringify(item)));

describe("a gap", () => {
  /** Twenty days ending at the fake clock. */
  const start = NOW_MS - 20 * DAY_MS;
  const day = (index: number): number => start + index * DAY_MS;
  const RANGE = { start: iso(start), end: iso(NOW_MS - 1) };

  it("is a finding for a type a device records by itself", () => {
    const passive = ["Steps", "HeartRate", "SleepSession", "RestingHeartRate"];

    expect(passive.filter((type) => !isGapType(type))).toStrictEqual([]);
  });

  it("is not one for a type a person writes when they do something", () => {
    const events = ["ExerciseSession", "BloodPressure", "Weight", "Nutrition", "Hydration"];

    expect(events.filter((type) => isGapType(type))).toStrictEqual([]);
  });

  it("is reported for missing steps and not for the same days without a workout", async () => {
    const records: HcRecord[] = [];
    for (let index = 0; index < 20; index += 1) {
      // Both types are there most days, and both miss days 8, 9 and 10.
      if (index >= 8 && index <= 10) continue;
      const from = day(index) + 9 * HOUR_MS;
      records.push(
        interval(`steps-${String(index)}`, "Steps", from, from + MINUTE_MS, { count: 4000 }),
        interval(`run-${String(index)}`, "ExerciseSession", from, from + 30 * MINUTE_MS, {
          exerciseType: "RUNNING",
        }),
      );
    }

    const answer = await ask(phoneWith(records), "data_quality", RANGE);
    const gaps = answer.items.filter((item) => item.kind === "gap");
    const [from, resumed] = [iso(day(8)), iso(day(11))];

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ resourceType: "hc:Steps", from, days: 3, resumed });
  });

  it("is still reported for nights of sleep that are missing", async () => {
    const records: HcRecord[] = [];
    for (let index = 0; index < 20; index += 1) {
      if (index === 12) continue;
      // 23:00 to 07:00, ending on day `index`.
      records.push(
        interval(
          `night-${String(index)}`,
          "SleepSession",
          day(index) - HOUR_MS,
          day(index) + 7 * HOUR_MS,
          {},
        ),
      );
    }

    const answer = await ask(phoneWith(records), "data_quality", RANGE);
    const gaps = answer.items.filter((item) => item.kind === "gap");
    const from = iso(day(12));

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ resourceType: "hc:SleepSession", from, days: 1 });
  });
});

describe("a night whose session is missing", () => {
  /** Three mornings ending at the fake clock: nights end at 07:00 on each. */
  const start = NOW_MS - 3 * DAY_MS;
  const morning = (index: number): number => start + index * DAY_MS + 7 * HOUR_MS;
  const RANGE = { start: iso(start), end: iso(NOW_MS - 1) };

  /** What the wearable writes for the night that ends on morning `index`. */
  function vitals(index: number): HcRecord[] {
    const wake = morning(index);
    return [
      instant(`rhr-${String(index)}`, "RestingHeartRate", wake, { bpm: 55 }),
      instant(`rr-${String(index)}`, "RespiratoryRate", wake, { rate: 14 }),
      // Heart-rate variability through the night, from the evening before on.
      instant(`hrv-a-${String(index)}`, "HeartRateVariabilityRmssd", wake - 7.5 * HOUR_MS, {
        rmssd: 40,
      }),
      instant(`hrv-b-${String(index)}`, "HeartRateVariabilityRmssd", wake - 3 * HOUR_MS, {
        rmssd: 44,
      }),
    ];
  }

  const night = (index: number): HcRecord =>
    interval(
      `night-${String(index)}`,
      "SleepSession",
      morning(index) - 8 * HOUR_MS,
      morning(index),
      {},
    );

  it("is found by the overnight figures the wearable wrote for it", async () => {
    const records = [night(0), ...vitals(0), ...vitals(1), night(2), ...vitals(2)];

    const answer = await ask(phoneWith(records), "data_quality", RANGE);

    expect(missing(answer)).toStrictEqual([
      {
        resourceType: "hc:SleepSession",
        healthSystemId: `device:${DEVICE}`,
        kind: "session_missing",
        date: iso(morning(1)),
        vitals: ["HeartRateVariabilityRmssd", "RespiratoryRate", "RestingHeartRate"],
      },
    ]);
  });

  it("is not reported when every night's figures have their session", async () => {
    const records = [0, 1, 2].flatMap((index) => [night(index), ...vitals(index)]);

    const answer = await ask(phoneWith(records), "data_quality", RANGE);

    expect(missing(answer)).toStrictEqual([]);
  });

  it("is not reported for the evening half of a night that is there", async () => {
    // Nobody wore the watch on the night that ended on morning 1. The next
    // night's evening readings fall on the same date and belong to its session.
    const records = [night(0), ...vitals(0), night(2), ...vitals(2)];

    const answer = await ask(phoneWith(records), "data_quality", RANGE);

    expect(missing(answer)).toStrictEqual([]);
  });

  it("needs two different overnight types: a lone daily figure is not a night", async () => {
    const records = [
      night(0),
      ...vitals(0),
      instant("rhr-alone", "RestingHeartRate", morning(1), { bpm: 58 }, { origin: PHONE }),
      night(2),
      ...vitals(2),
    ];

    const answer = await ask(phoneWith(records), "data_quality", RANGE);

    expect(missing(answer)).toStrictEqual([]);
  });

  it("is a finding about sleep: not reported when sleep was not asked about", async () => {
    const records = [night(0), ...vitals(0), ...vitals(1)];

    const answer = await ask(phoneWith(records), "data_quality", {
      ...RANGE,
      types: ["RestingHeartRate"],
    });

    expect(missing(answer)).toStrictEqual([]);
  });
});

describe("a long range, a window at a time", () => {
  /** Eight hundred days ending at the fake clock, which is a UTC midnight. */
  const DAYS = 800;
  const start = NOW_MS - DAYS * DAY_MS;
  const day = (index: number): number => start + index * DAY_MS;
  const range = { startMs: start, endMs: NOW_MS };
  /** Where the windows are cut, in days from the start of the range. */
  const cuts = [1, 2, 3, 4].map((window) => window * QUALITY_WINDOW_DAYS);
  const [firstCut = 0, secondCut = 0] = cuts;

  function history(): HcRecord[] {
    const records: HcRecord[] = [];
    for (let index = 0; index < DAYS; index += 1) {
      const noon = day(index) + 12 * HOUR_MS;
      // Steps every day but three that straddle the second cut; the wearable
      // until day 600, the phone after.
      const stepGap = index >= secondCut - 1 && index <= secondCut + 1;
      if (!stepGap) {
        records.push(
          interval(
            `steps-${String(index)}`,
            "Steps",
            noon,
            noon + MINUTE_MS,
            { count: 5000 },
            { origin: index < 600 ? WEARABLE : PHONE },
          ),
        );
      }
      // Distance for a hundred days, silent for four hundred, then back.
      if (index < 100 || index >= 500) {
        records.push(
          interval(`dist-${String(index)}`, "Distance", noon, noon + MINUTE_MS, { distance: 3000 }),
        );
      }
    }
    records.push(
      // A second app counting the same steps on one day.
      interval(
        "steps-extra",
        "Steps",
        day(300) + HOUR_MS,
        day(300) + 2 * HOUR_MS,
        { count: 10 },
        {
          origin: PHONE,
        },
      ),
      // A weight that goes from typed to converted across the first cut.
      instant("weight-a", "Weight", day(firstCut - 3) + 8 * HOUR_MS, { weight: 70.5 }),
      instant("weight-b", "Weight", day(firstCut + 2) + 8 * HOUR_MS, { weight: 70.1234 }),
      // The same walk from two apps, one ending just before the second cut and one after.
      interval(
        "walk-a",
        "ExerciseSession",
        day(secondCut) - HOUR_MS,
        day(secondCut) - 10 * MINUTE_MS,
        {
          exerciseType: "WALKING",
        },
      ),
      interval(
        "walk-b",
        "ExerciseSession",
        day(secondCut) - 30 * MINUTE_MS,
        day(secondCut) + 30 * MINUTE_MS,
        { exerciseType: "WALKING" },
        { origin: PHONE },
      ),
      // A workout a long way from any other: never a gap.
      interval("ride", "ExerciseSession", day(40), day(40) + HOUR_MS, { exerciseType: "BIKING" }),
    );
    return records;
  }

  const TYPES = ["Steps", "Distance", "Weight", "ExerciseSession"];

  const world: { hc: FakeHc } = { hc: undefined as unknown as FakeHc };

  beforeEach(() => {
    world.hc = phoneWith(history());
  });

  function request(): QualityRequest {
    return {
      deviceId: DEVICE,
      range,
      clock: zoneClock("UTC"),
      nowMs: NOW_MS,
      dayRollupsUsable: () => Promise.resolve(true),
      types: TYPES,
      allowed: () => true,
    };
  }

  /** Every page of the range, following `untilMs`. */
  async function everyPage(maxBytes: number) {
    const reads = fakeHcReads(world.hc);
    const pages = [];
    let fromMs: number | null = null;
    for (;;) {
      const page = await dataQualityPage(reads, request(), { fromMs, maxBytes });
      pages.push(page);
      if (page.done) return pages;
      fromMs = page.untilMs;
    }
  }

  it("stops after two windows however little it found, and says where", async () => {
    const pages = await everyPage(10_000_000);

    expect(QUALITY_MAX_WINDOWS_PER_CALL).toBe(2);
    expect(pages.map((page) => [page.fromMs, page.untilMs, page.done])).toStrictEqual([
      [start, day(cuts[1] ?? 0), false],
      [day(cuts[1] ?? 0), day(cuts[3] ?? 0), false],
      [day(cuts[3] ?? 0), NOW_MS, true],
    ]);
  });

  it("stops at the end of the window that filled the page", async () => {
    // The first window finds nothing, so it fills no page; the second does.
    const quiet = await dataQualityPage(fakeHcReads(world.hc), request(), { maxBytes: 1 });
    const busy = await dataQualityPage(fakeHcReads(world.hc), request(), {
      fromMs: day(secondCut),
      maxBytes: 1,
    });

    expect([quiet.fromMs, quiet.untilMs]).toStrictEqual([start, day(secondCut)]);
    expect([busy.fromMs, busy.untilMs]).toStrictEqual([day(secondCut), day(cuts[2] ?? 0)]);
    expect(busy.findings.length).toBeGreaterThan(0);
  });

  it("finds across its cuts exactly what one read of the whole range finds", async () => {
    const whole = await dataQualityInOneRead(fakeHcReads(world.hc), request());
    const pages = await everyPage(10_000_000);
    const paged = pages.flatMap((page) => page.findings);
    // The form the tool calls today: every page, in one call.
    const walked = await dataQuality(fakeHcReads(world.hc), request());

    expect(sortedKeys(paged)).toStrictEqual(sortedKeys(whole));
    expect(walked).toStrictEqual(paged);
    expect(inOrder(whole.map((finding) => finding.kind))).toStrictEqual([
      "gap",
      "gap",
      "overlapping_origins",
      "overlapping_sessions",
      "precision_change",
      "source_switch",
    ]);
  });

  it("finds the same whatever size its pages are", async () => {
    const coarse = await everyPage(10_000_000);
    const fine = await everyPage(1);

    expect(coarse).toHaveLength(3);
    expect(fine).toHaveLength(4);
    expect(sortedKeys(fine.flatMap((page) => page.findings))).toStrictEqual(
      sortedKeys(coarse.flatMap((page) => page.findings)),
    );
  });

  it("measures a silence longer than its lookback from where the silence began", async () => {
    const pages = await everyPage(10_000_000);
    const gaps = pages
      .flatMap((page) => page.findings)
      .filter((finding) => finding.kind === "gap")
      .map((finding) => [finding.type, finding.detail]);

    expect(400).toBeGreaterThan(QUALITY_LOOKBACK_DAYS);
    expect(gaps).toStrictEqual([
      ["Steps", { from: iso(day(secondCut - 1)), days: 3, resumed: iso(day(secondCut + 2)) }],
      ["Distance", { from: iso(day(100)), days: 400, resumed: iso(day(500)) }],
    ]);
  });

  it("reads a fixed stretch again exactly as it read it the first time", async () => {
    const reads = fakeHcReads(world.hc);
    const first = await dataQualityPage(reads, request(), { maxBytes: 1 });
    const again = await dataQualityPage(reads, request(), {
      fromMs: first.fromMs,
      untilMs: first.untilMs,
      // A budget that would have stopped it sooner or later is not consulted.
      maxBytes: 10_000_000,
    });

    expect(again).toStrictEqual(first);
  });

  it("never asks the store for more than a window and its lookback at once", async () => {
    await everyPage(10_000_000);
    const longest = Math.max(
      ...world.hc.calls.map((entry) => (entry.endMs ?? 0) - (entry.startMs ?? 0)),
    );

    // Every read the store logs with a span: records, hour rollups, nights,
    // sessions. (Day rollups are asked for by day label; the one day read that
    // is longer by design is for a type silent through a whole lookback.)
    const beyond = world.hc.calls.filter(
      (entry) =>
        (entry.endMs ?? 0) - (entry.startMs ?? 0) >
        (QUALITY_WINDOW_DAYS + QUALITY_LOOKBACK_DAYS + 5) * DAY_MS,
    );

    expect(longest).toBeGreaterThan(0);
    expect(beyond).toStrictEqual([]);
  });

  it("lets go of each window's reads before the next", async () => {
    const reads = fakeHcReads(world.hc);
    let released = 0;
    reads.releaseReads = () => {
      released += 1;
    };

    await dataQualityPage(reads, request(), { maxBytes: 10_000_000 });

    expect(released).toBe(QUALITY_MAX_WINDOWS_PER_CALL);
  });

  /**
   * One call of the tool as it is to be wired: open the cursor, read the page
   * it names, hand the rows and the stretch that was read to `hcRespond`.
   */
  async function toolPage(args: Record<string, unknown>): Promise<Page> {
    const deps = fakeDeps(fakeState({ hc: world.hc }));
    const call = await beginHcCall(deps, { rules: EMPTY_RULES, now: NOW }, args);
    const opened = await openStampedPage(deps.hc, call.devices, "data_quality", args);
    if (!opened.ok) throw new Error(opened.errorCode);
    const { page } = opened;
    const maxBytes = typeof args.max_bytes === "number" ? args.max_bytes : 25_000;
    const scanned = await dataQualityPage(deps.hc, request(), {
      fromMs: page.anchorMs,
      untilMs: page.untilMs,
      maxBytes,
    });
    const outcome = await hcRespond({
      tool: "data_quality",
      call,
      args,
      page,
      items: scanned.findings.map((finding) => ({
        resourceType: `hc:${finding.type}`,
        healthSystemId: `device:${DEVICE}`,
        kind: finding.kind,
        ...finding.detail,
      })),
      coverage: [],
      scan: scanned,
    });
    const [block] = outcome.result.content;
    if (block?.type !== "text") throw new Error("one text block");
    return JSON.parse(block.text) as Page;
  }

  /** Every page of one question, following each `cursor` to the end. */
  async function followCursors(args: Record<string, unknown>): Promise<Page[]> {
    const pages: Page[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await toolPage({ ...args, ...(cursor !== undefined && { cursor }) });
      pages.push(page);
      if (!page.truncated) return pages;
      if (page.cursor === undefined) throw new Error("a truncated page without a cursor");
      ({ cursor } = page);
      if (pages.length > 50) throw new Error("the cursors do not converge");
    }
  }

  describe("as the tool's pages", () => {
    const args = { start: iso(start), end: iso(NOW_MS - 1) };

    it("says truncated and gives a cursor for a stretch that held nothing more to send", async () => {
      const pages = await followCursors({ ...args, max_bytes: 10_000_000 });

      expect(pages.map((page) => page.truncated)).toStrictEqual([true, true, false]);
      expect(pages.at(-1)?.cursor).toBeUndefined();
      // `total` counts what has been found so far, the pages before included.
      expect(pages.map((page) => page.total)).toStrictEqual([2, 6, 6]);
    });

    it("returns every finding once, however small the budget", async () => {
      const whole = await followCursors({ ...args, max_bytes: 10_000_000 });
      const small = await followCursors({ ...args, max_bytes: 200 });

      expect(small.length).toBeGreaterThan(whole.length);
      // In order, with none repeated and none dropped.
      expect(rowsOf(small)).toStrictEqual(rowsOf(whole));
      expect(new Set(rowsOf(small)).size).toBe(6);
    });
  });
});

/** An instant as the tools write it in UTC, the zone these tests run in. */
const utcIso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "+00:00");

describe("a stale platform total", () => {
  const start = NOW_MS - 10 * DAY_MS;
  const hour = Math.floor(start / HOUR_MS) + 24;
  const at = (offset: number, minutes = 0): number =>
    (hour + offset) * HOUR_MS + minutes * MINUTE_MS;
  const RANGE = { start: iso(start), end: iso(NOW_MS - 1) };

  /** The phone's synthetic total of one hour of steps. */
  function total(offset: number, origins: readonly string[]): HcRecord {
    return interval(
      `agg:Steps:${String(at(offset))}`,
      "Agg.Steps",
      at(offset),
      at(offset + 1),
      {
        value: 100,
        unit: "count",
        origins: [...origins],
      },
      { origin: "healthconnect" },
    );
  }

  it("is a finding per run of hours whose total counts an app with no steps there", async () => {
    const records: HcRecord[] = [
      interval("w-0", "Steps", at(0, 10), at(0, 11), { count: 100 }),
      // Runs from the hour before into hour 4: the phone app is there.
      interval("p-3", "Steps", at(3, 50), at(4, 20), { count: 40 }, { origin: PHONE }),
      total(0, [WEARABLE]),
      // The wearable's records of these two hours were deleted; its totals were not.
      total(1, [WEARABLE]),
      total(2, [WEARABLE]),
      total(4, [PHONE]),
      // A total that counts an app with nothing here at all.
      total(6, [WEARABLE, PHONE]),
    ];

    const answer = await ask(phoneWith(records), "data_quality", RANGE);
    const stale = answer.items.filter((item) => item.kind === "stale_platform_total");
    const [from, to] = [utcIso(at(1)), utcIso(at(3))];

    expect(stale).toStrictEqual([
      expect.objectContaining({
        resourceType: "hc:Steps",
        reason: "no_records",
        start: from,
        end: to,
        count: 2,
        origins: [WEARABLE],
      }),
      expect.objectContaining({
        resourceType: "hc:Steps",
        reason: "no_records",
        count: 1,
        origins: [WEARABLE, PHONE],
      }),
    ]);
  });

  it("is not reported when steps are not asked about", async () => {
    const records = [
      interval("w-0", "Steps", at(0, 10), at(0, 11), { count: 100 }),
      interval("hr-0", "HeartRate", at(0, 10), at(0, 11), { samples: [] }),
      total(1, [WEARABLE]),
    ];
    const answer = await ask(phoneWith(records), "data_quality", {
      ...RANGE,
      types: ["HeartRate"],
    });
    expect(answer.items.filter((item) => item.kind === "stale_platform_total")).toStrictEqual([]);
  });
});
