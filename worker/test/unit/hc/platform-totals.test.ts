// The platform's own hourly totals: which type a total is of, which hours a
// batch carries, which hours a record covers, and the rule that tells a total
// that no longer agrees with the records (worker/src/hc/platform-totals.ts).
//
// Everything is synthetic: invented values, RFC 2606 style package names.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAX_MARKED_SPAN_MS,
  PLATFORM_SOURCE_TYPES,
  addPresence,
  aggTypeOf,
  carriedPlatformHours,
  hoursOfRecord,
  isPlatformSourceType,
  parseAggId,
  sourceOfAggType,
  staleTotals,
  totalOrigins,
} from "../../../src/hc/platform-totals.ts";

import type { Presence } from "../../../src/hc/platform-totals.ts";
import type { HcRecord } from "../../../src/hc/wire.ts";

const HOUR_MS = 3_600_000;
const H = 490_000;
const WEARABLE = "com.example.wearable";
const PHONE = "com.example.phone";

function record(
  type: string,
  startMs: number,
  endMs: number,
  extra: Partial<HcRecord> = {},
): HcRecord {
  return {
    id: "r",
    type,
    origin: WEARABLE,
    lastModified: 1,
    start: startMs,
    end: endMs,
    data: {},
    ...extra,
  };
}

describe("which type a total is of", () => {
  it("maps every metric both ways, and nothing else", () => {
    expect(aggTypeOf("Steps")).toBe("Agg.Steps");
    expect(aggTypeOf("ActiveCaloriesBurned")).toBe("Agg.ActiveCalories");
    expect(sourceOfAggType("Agg.SleepDuration")).toBe("SleepSession");
    expect(sourceOfAggType("Agg.Nonsense")).toBeNull();
    expect(sourceOfAggType("Steps")).toBeNull();
    expect(aggTypeOf("HeartRate")).toBeNull();
    expect(isPlatformSourceType("TotalCaloriesBurned")).toBe(false);
    for (const type of PLATFORM_SOURCE_TYPES) {
      expect(sourceOfAggType(aggTypeOf(type) ?? "")).toBe(type);
    }
  });

  // The companion app's `AggMetric` is the other half of the list: a metric
  // one side uploads and the other cannot map would never be marked or cleared.
  it("agrees with the companion app's list of metrics", () => {
    const kotlin = readFileSync(
      new URL(
        "../../../../android/app/src/main/java/dev/maxhogan/healthy/companion/sync/HealthSource.kt",
        import.meta.url,
      ),
      "utf8",
    );
    const enumBody = kotlin.slice(
      kotlin.indexOf("enum class AggMetric"),
      kotlin.indexOf("val wireType"),
    );
    // An entry is `NAME("<metric>", "<source type>", "<unit>"),`.
    const entry = /^\s*[A-Z_]+\("(\w+)", "(\w+)",/u;
    const pairs = enumBody
      .split("\n")
      .map((line) => entry.exec(line))
      .filter((match) => match !== null)
      .map((match): [string, string] => [match[2] ?? "", match[1] ?? ""]);
    expect(pairs.length).toBeGreaterThan(0);
    const expected = PLATFORM_SOURCE_TYPES.map((type): [string, string] => [
      type,
      aggTypeOf(type)?.slice("Agg.".length) ?? "",
    ]);
    expect(new Map(pairs)).toStrictEqual(new Map(expected));
  });
});

describe("the hours a batch carries totals for", () => {
  it("are its total upserts and its total deletes, and nothing else", () => {
    const carried = carriedPlatformHours({
      upserts: [
        record("Agg.Steps", H * HOUR_MS, (H + 1) * HOUR_MS, {
          id: `agg:Steps:${String(H * HOUR_MS)}`,
        }),
        record("Steps", (H + 3) * HOUR_MS, (H + 3) * HOUR_MS + 60_000),
      ],
      deletes: [
        `agg:Distance:${String((H + 1) * HOUR_MS)}`,
        `agg:Steps:${String((H + 2) * HOUR_MS + 1)}`,
        "agg:Nonsense:0",
        "0f4a2c1e-0000-4000-8000-000000000000",
      ],
    });
    expect(new Set(carried)).toStrictEqual(
      new Set([`Distance|${String(H + 1)}`, `Steps|${String(H)}`]),
    );
  });

  it("reads an id only when it is one", () => {
    expect(parseAggId(`agg:Hydration:${String(H * HOUR_MS)}`)).toStrictEqual({
      sourceType: "Hydration",
      hourUtc: H,
    });
    expect(parseAggId("agg:Steps")).toBeNull();
    expect(parseAggId("agg:Steps:12:3")).toBeNull();
    expect(parseAggId("agg:Steps:-3600000")).toBeNull();
    expect(parseAggId("Agg:Steps:0")).toBeNull();
  });
});

describe("the hours a record covers", () => {
  it("are every hour it overlaps, end exclusive, and the start hour of an instant", () => {
    const at = H * HOUR_MS;
    expect(hoursOfRecord(record("Steps", at + 10, at + 20))).toStrictEqual([H]);
    expect(hoursOfRecord(record("Steps", at + 30 * 60_000, at + 2 * HOUR_MS))).toStrictEqual([
      H,
      H + 1,
    ]);
    expect(
      hoursOfRecord({ ...record("Hydration", 0, 0), start: undefined, end: undefined, time: at }),
    ).toStrictEqual([H]);
    expect(hoursOfRecord(record("Steps", at, at - 5))).toStrictEqual([H]);
  });

  it("stop a month in for a record that claims to run for years", () => {
    const at = H * HOUR_MS;
    const hours = hoursOfRecord(record("Steps", at, at + 400 * 24 * HOUR_MS));
    expect(hours).toHaveLength(MAX_MARKED_SPAN_MS / HOUR_MS);
    expect(hours[0]).toBe(H);
  });
});

describe("a stale total", () => {
  const window = { fromHour: H, toHour: H + 10 };

  it("names an app with no record in its hour, or has a figure where there is none", () => {
    const presence: Presence = new Map();
    addPresence(presence, WEARABLE, { startMs: H * HOUR_MS, endMs: H * HOUR_MS + 60_000 }, window);
    // A record of the hour before the window running into its second hour.
    addPresence(
      presence,
      PHONE,
      { startMs: (H - 1) * HOUR_MS, endMs: (H + 1) * HOUR_MS + 1 },
      window,
    );

    const stale = staleTotals(
      [
        { hourUtc: H, origins: [WEARABLE, PHONE] },
        { hourUtc: H + 1, origins: [PHONE] },
        { hourUtc: H + 1, origins: [WEARABLE, PHONE] },
        { hourUtc: H + 4, origins: [WEARABLE] },
        { hourUtc: H + 5, origins: [] },
      ],
      presence,
    );

    expect(stale).toStrictEqual([
      { hourUtc: H + 1, reason: "origin_without_records", missing: [WEARABLE] },
      { hourUtc: H + 4, reason: "no_records", missing: [WEARABLE] },
      { hourUtc: H + 5, reason: "no_records", missing: [] },
    ]);
    // Clipped to the window: nothing is noted before it.
    expect(presence.has(H - 1)).toBe(false);
  });

  it("reads the origins a total counted, and nothing that is not one", () => {
    expect(
      totalOrigins(record("Agg.Steps", 0, 1, { data: { origins: [WEARABLE, 7, PHONE] } })),
    ).toStrictEqual([WEARABLE, PHONE]);
    expect(totalOrigins(record("Agg.Steps", 0, 1, { data: { origins: "x" } }))).toStrictEqual([]);
  });
});
