// What a client sees of the aggregate fixes, through the real tools: sleep's
// two lengths, the day's HRV named for what it is, a long record said out
// loud, every bucket of a long answer there, and a named type that is not
// assessed answered all the same.
//
// Everything is synthetic: invented days, RFC 2606 style package names.

import { beforeEach, describe, expect, it } from "vitest";

import {
  DEVICE_ID,
  HOUR_MS,
  MINUTE_MS,
  PHONE,
  WEARABLE,
  addDevice,
  device,
  emptyHc,
  hcWorld,
  instant,
  interval,
  platformHour,
} from "../hc-fake.ts";
import { NOW, callTool, connectTools, fakeDeps, fakeState } from "../helpers.ts";

import type { HcRecord } from "../../../../src/hc/wire.ts";
import type { FakeHc } from "../hc-fake.ts";
import type { FakeState, ToolAnswer } from "../helpers.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const NOW_MS = NOW * 1000;
/** The invented day: the UTC day that ends at the fake clock. */
const DAY = NOW_MS - 24 * HOUR_MS;
const at = (hour: number, minute = 0): number => DAY + hour * HOUR_MS + minute * MINUTE_MS;
const date = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const TODAY = date(DAY);
const YESTERDAY = date(DAY - 1);
const RANGE = { start: YESTERDAY, end: TODAY };

const world: { state: FakeState; client: Client } = {
  state: undefined as unknown as FakeState,
  client: undefined as unknown as Client,
};

async function connect(hc: FakeHc): Promise<void> {
  world.state = fakeState({ hc });
  world.client = await connectTools(fakeDeps(world.state));
}

beforeEach(async () => {
  await connect(hcWorld(NOW));
});

const call = (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> =>
  callTool(world.client, name, args);
const envelope = (answer: ToolAnswer): Record<string, unknown> =>
  JSON.parse(answer.text) as Record<string, unknown>;

/** A store holding only `records`, on the phone the other tests use. */
function storeOf(records: readonly HcRecord[]): FakeHc {
  const hc = emptyHc();
  addDevice(hc, device(DEVICE_ID, "Test phone", NOW - 600), records);
  return hc;
}

describe("hc_aggregate on sleep", () => {
  it("means time asleep by `duration`, and gives the night's length as `in_bed`", async () => {
    const answer = await call("hc_aggregate", { type: "SleepSession", ...RANGE });
    const nights = await call("sleep_sessions", RANGE);
    const [, today] = answer.items;

    // The night is eight hours in bed, the first twenty minutes of it awake.
    expect(envelope(answer).metrics).toStrictEqual(["duration", "in_bed", "records"]);
    expect(today).toMatchObject({
      durationMs: 460 * MINUTE_MS,
      inBedMs: 480 * MINUTE_MS,
      records: 1,
      method: "merged_sessions",
    });
    expect(nights.items[0]).toMatchObject({ asleepMin: 460, inBedMin: 480 });
    expect(envelope(answer).units).toMatchObject({ durationMs: "ms", inBedMs: "ms" });
  });

  it("returns only what is asked for, and nothing about bed for a workout", async () => {
    const asleep = await call("hc_aggregate", {
      type: "SleepSession",
      ...RANGE,
      metrics: ["duration"],
    });
    const inBed = await call("hc_aggregate", {
      type: "SleepSession",
      ...RANGE,
      metrics: ["in_bed"],
    });
    const workouts = await call("hc_aggregate", {
      type: "ExerciseSession",
      ...RANGE,
      metrics: ["duration", "in_bed"],
    });

    expect(asleep.items[1]).toMatchObject({ durationMs: 460 * MINUTE_MS });
    expect(asleep.items[1]).not.toHaveProperty("inBedMs");
    expect(inBed.items[1]).toMatchObject({ inBedMs: 480 * MINUTE_MS });
    expect(inBed.items[1]).not.toHaveProperty("durationMs");
    expect(workouts.items.every((item) => !Object.hasOwn(item, "inBedMs"))).toBe(true);
  });

  it("gives each app's nights both lengths under all_separately", async () => {
    const answer = await call("hc_aggregate", {
      type: "SleepSession",
      ...RANGE,
      origin_mode: "all_separately",
    });

    expect(answer.items[1]).toMatchObject({
      origins: [WEARABLE],
      durationMs: 460 * MINUTE_MS,
      inBedMs: 480 * MINUTE_MS,
    });
  });
});

describe("daily_summary", () => {
  it("names the day's HRV for the statistic it is: a mean, not the night's median", async () => {
    const days = await call("daily_summary", { date: TODAY });
    const nights = await call("sleep_sessions", RANGE);
    const [day] = days.items;

    // Seven readings, 40 to 46: their mean and their median happen to agree
    // here, and the names say which is which.
    expect(day).toMatchObject({ hrvRmssdMean: 43 });
    expect(day).not.toHaveProperty("hrvRmssd");
    expect(nights.items[0]).toMatchObject({ hrv: { median: 43 } });
    expect(envelope(days).units).toMatchObject({ hrvRmssdMean: "ms" });
  });

  it("is a mean when the two differ", async () => {
    await connect(
      storeOf(
        [1, 2, 30].map((rmssd, index) =>
          instant(`hrv-${String(index)}`, "HeartRateVariabilityRmssd", at(index + 1), { rmssd }),
        ),
      ),
    );

    const days = await call("daily_summary", { date: TODAY });

    expect(days.items[0]).toMatchObject({ hrvRmssdMean: 11 });
  });

  it("flags a day whose energy includes a share of a day-long record", async () => {
    // The wearable measured every hour but three; the phone wrote one record
    // for the whole day.
    const records: HcRecord[] = [
      interval("p-day", "TotalCaloriesBurned", at(0), at(24), { energy: 1680 }, { origin: PHONE }),
    ];
    for (let hour = 0; hour < 24; hour += 1) {
      if (hour >= 3 && hour < 6) continue;
      records.push(
        interval(`w-${String(hour)}`, "TotalCaloriesBurned", at(hour), at(hour + 1), {
          energy: 100,
        }),
      );
    }
    await connect(storeOf(records));

    const days = await call("daily_summary", { date: TODAY });
    const summed = await call("hc_aggregate", {
      type: "TotalCaloriesBurned",
      start: TODAY,
      end: TODAY,
    });
    const [day] = days.items;

    expect(day?.totalKcal).toBeCloseTo(21 * 100 + 3 * 70, 6);
    expect(day?.flags).toStrictEqual(
      expect.arrayContaining(["long_record_used", "other_origins_dropped"]),
    );
    expect(summed.items[0]?.longRecordSum).toBeCloseTo(210, 6);
    expect(summed.warnings).toContain("hc_long_record_used:1");
  });

  it("does not flag the day when every hour was measured: the long record adds nothing", async () => {
    const records: HcRecord[] = [
      interval("p-day", "TotalCaloriesBurned", at(0), at(24), { energy: 1680 }, { origin: PHONE }),
    ];
    for (let hour = 0; hour < 24; hour += 1) {
      records.push(
        interval(`w-${String(hour)}`, "TotalCaloriesBurned", at(hour), at(hour + 1), {
          energy: 100,
        }),
      );
    }
    await connect(storeOf(records));

    const days = await call("daily_summary", { date: TODAY });

    // Was 2,400 + 1,680 - 100.
    expect(days.items[0]).toMatchObject({ totalKcal: 2400 });
    expect(days.items[0]?.flags).not.toContain("long_record_used");
    expect(days.items[0]?.flags).toContain("other_origins_dropped");
  });
});

describe("a long hourly answer", () => {
  /** Three days of steps from two apps and the platform, every hour. */
  function threeDays(): HcRecord[] {
    const records: HcRecord[] = [];
    for (let hour = -48; hour < 24; hour += 1) {
      records.push(
        interval(`w-${String(hour)}`, "Steps", at(hour), at(hour, 1), { count: 500 }),
        interval(
          `p-${String(hour)}`,
          "Steps",
          at(hour),
          at(hour, 1),
          { count: 300 },
          { origin: PHONE },
        ),
        platformHour("Steps", at(hour), 520),
      );
    }
    return records;
  }
  const hourly = { type: "Steps", start: date(at(-48)), end: TODAY, bucket: "hour" };

  it("has every hour, whatever became of the hours before it", async () => {
    // The platform's total is missing for one hour in the middle: that hour
    // falls back, and the platform's hours after it are still there.
    const records = threeDays().filter((record) => record.id !== `agg:Steps:${String(at(5))}`);
    await connect(storeOf(records));

    const answer = await call("hc_aggregate", { ...hourly, max_bytes: 1_000_000 });

    expect(answer.items).toHaveLength(72);
    expect(answer.items.map((item) => item.method)).toStrictEqual([
      ...Array.from({ length: 53 }, () => "platform"),
      "max_origin",
      ...Array.from({ length: 18 }, () => "platform"),
    ]);
    expect(envelope(answer)).toMatchObject({ total: 72, truncated: false });
  });
});

describe("data_quality, asked about a platform total", () => {
  it("says it does not assess one, rather than answering as if nothing were wrong", async () => {
    const answer = await call("data_quality", { ...RANGE, types: ["Agg.Steps", "Steps"] });

    expect(answer.warnings).toContain("not_assessed:hc:Agg.Steps");
    expect(answer.warnings).not.toContain("not_assessed:hc:Steps");
    expect(answer.items.every((item) => item.resourceType === "hc:Steps")).toBe(true);
  });
});
