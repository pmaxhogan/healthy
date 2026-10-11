// The hour rollup and its merge. Every value below is invented.

import { describe, expect, it } from "vitest";

import {
  AGG_ROLLUP_FIELDS,
  ROLLUP_FIELD_TABLE,
  mergeRollups,
  rollupBucket,
  rollupFieldsFor,
} from "../../../../src/hc/rollup/hour.ts";

import type { BucketRollup } from "../../../../src/hc/rollup/types.ts";
import type { HcRecord } from "../../../../src/hc/wire.ts";

const T0 = 1_790_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
/** The UTC hour `T0` is in, thirteen minutes past its start. */
const H0 = Math.floor(T0 / HOUR);

// Ids only have to be distinct; the rollup never reads them.
const ids = { next: 0 };

function nextId(): string {
  ids.next += 1;
  return `rec-${String(ids.next)}`;
}

function instant(type: string, time: number, data: Record<string, unknown>): HcRecord {
  return { id: nextId(), type, origin: "com.example.wearable", lastModified: time, time, data };
}

function interval(
  type: string,
  start: number,
  end: number,
  data: Record<string, unknown>,
): HcRecord {
  return {
    id: nextId(),
    type,
    origin: "com.example.wearable",
    lastModified: end,
    start,
    end,
    data,
  };
}

function steps(start: number, count: number, minutes = 1): HcRecord {
  return interval("Steps", start, start + minutes * MIN, { count });
}

const byName = (left: string, right: string): number => left.localeCompare(right);

describe("the field table", () => {
  it("lists each type once", () => {
    const types = ROLLUP_FIELD_TABLE.map((spec) => spec.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("names each field once per type and spells series paths as list[].key", () => {
    const fields = ROLLUP_FIELD_TABLE.flatMap((spec) => spec.fields);
    for (const spec of ROLLUP_FIELD_TABLE) {
      const names = spec.fields.map((field) => field.name);
      expect(new Set(names).size).toBe(names.length);
    }
    const seriesFields = fields.filter((candidate) => candidate.kind === "series");
    const scalarFields = fields.filter((candidate) => candidate.kind === "scalar");
    for (const field of seriesFields) {
      expect(field.path).toMatch(/^[a-z]+\[\]\.[A-Za-z]+$/u);
      expect(field.path.endsWith(`.${field.name}`)).toBe(true);
    }
    for (const field of scalarFields) {
      expect(field.path).toBe(field.name);
    }
    expect(seriesFields.length).toBeGreaterThan(0);
  });

  it("answers an unknown type, and an inherited object key, with no fields", () => {
    expect(rollupFieldsFor("SomethingNewer")).toEqual([]);
    expect(rollupFieldsFor("constructor")).toEqual([]);
    expect(rollupFieldsFor("toString")).toEqual([]);
  });

  it("gives every Agg.<Metric> the one value field", () => {
    expect(rollupFieldsFor("Agg.Steps")).toBe(AGG_ROLLUP_FIELDS);
    expect(rollupFieldsFor("Agg.SomethingNewer")).toEqual([
      { name: "value", path: "value", kind: "scalar" },
    ]);
  });

  // One synthetic record pair per type: every field in the table is fed 3 then
  // 5, so each must come out as n 2, sum 8, min 3, max 5, mean 4.
  it.each(ROLLUP_FIELD_TABLE.map((spec) => [spec.type, spec] as const))(
    "summarises every listed field of %s",
    (type, spec) => {
      const build = (value: number, at: number): HcRecord => {
        const data: Record<string, unknown> = {};
        for (const field of spec.fields) {
          if (field.kind === "scalar") data[field.path] = value;
          else {
            const [list = "", key = ""] = field.path.split("[].", 2);
            data[list] = [{ t: at, [key]: value }];
          }
        }
        return interval(type, at, at + MIN, data);
      };
      const rollup = rollupBucket(type, [build(3, T0), build(5, T0 + 2 * MIN)]);

      expect(rollup.records).toBe(2);
      expect(rollup.durationMs).toBe(2 * MIN);
      expect(Object.keys(rollup.fields).toSorted(byName)).toEqual(
        spec.fields.map((field) => field.name).toSorted(byName),
      );
      for (const field of spec.fields) {
        expect(rollup.fields[field.name]).toEqual({
          n: 2,
          sum: 8,
          min: 3,
          max: 5,
          mean: 4,
          first: 3,
          firstMs: T0,
          last: 5,
          lastMs: T0 + 2 * MIN,
        });
      }
    },
  );
});

describe("rollupBucket", () => {
  it("sums a count type and totals its intervals", () => {
    const rollup = rollupBucket("Steps", [
      interval("Steps", T0, T0 + MIN, { count: 40 }),
      interval("Steps", T0 + 5 * MIN, T0 + 8 * MIN, { count: 250 }),
      interval("Steps", T0 + 2 * MIN, T0 + 3 * MIN, { count: 10 }),
    ]);
    expect(rollup).toEqual({
      records: 3,
      durationMs: 5 * MIN,
      hours: [H0],
      fields: {
        count: {
          n: 3,
          sum: 300,
          min: 10,
          max: 250,
          mean: 100,
          first: 40,
          firstMs: T0,
          last: 250,
          lastMs: T0 + 5 * MIN,
        },
      },
    });
  });

  it("has no durationMs for an instantaneous type", () => {
    const rollup = rollupBucket("Weight", [
      instant("Weight", T0, { weight: 70.5 }),
      instant("Weight", T0 + MIN, { weight: 70.1 }),
    ]);
    expect(rollup.records).toBe(2);
    expect("durationMs" in rollup).toBe(false);
    expect(rollup.fields.weight?.n).toBe(2);
    expect(rollup.fields.weight?.mean).toBeCloseTo(70.3, 10);
    expect(rollup.fields.weight?.last).toBeCloseTo(70.1, 10);
  });

  it("keeps both fields of a two-field type apart", () => {
    const rollup = rollupBucket("BloodPressure", [
      instant("BloodPressure", T0, { systolic: 120, diastolic: 80, bodyPosition: "SITTING_DOWN" }),
      instant("BloodPressure", T0 + MIN, { systolic: 130, diastolic: 70 }),
    ]);
    expect(rollup.fields.systolic).toMatchObject({ n: 2, sum: 250, min: 120, max: 130 });
    expect(rollup.fields.diastolic).toMatchObject({ n: 2, sum: 150, min: 70, max: 80 });
    expect(Object.keys(rollup.fields)).toHaveLength(2);
  });

  it("counts samples, not records, for a series type, timed by the sample", () => {
    const rollup = rollupBucket("HeartRate", [
      interval("HeartRate", T0 + MIN, T0 + 2 * MIN, {
        samples: [
          { t: T0 + MIN, bpm: 70 },
          { t: T0 + MIN + 30_000, bpm: 74 },
        ],
      }),
      // Listed second, but its sample is the earliest.
      interval("HeartRate", T0, T0 + MIN, { samples: [{ t: T0 + 5000, bpm: 60 }] }),
    ]);
    expect(rollup.records).toBe(2);
    expect(rollup.fields.bpm).toEqual({
      n: 3,
      sum: 204,
      min: 60,
      max: 74,
      mean: 68,
      first: 60,
      firstMs: T0 + 5000,
      last: 74,
      lastMs: T0 + MIN + 30_000,
    });
  });

  it("summarises a type with a series and a scalar side by side", () => {
    const rollup = rollupBucket("SkinTemperature", [
      interval("SkinTemperature", T0, T0 + 10 * MIN, {
        baseline: 33.5,
        measurementLocation: "WRIST",
        deltas: [
          { t: T0, delta: -0.5 },
          { t: T0 + 5 * MIN, delta: 0.5 },
          { t: T0 + 9 * MIN, delta: 1.5 },
        ],
      }),
    ]);
    expect(rollup.fields.delta).toMatchObject({ n: 3, sum: 1.5, min: -0.5, max: 1.5, mean: 0.5 });
    expect(rollup.fields.baseline).toMatchObject({ n: 1, sum: 33.5, firstMs: T0 });
  });

  it("sums the synthetic platform aggregates", () => {
    const hour = 3_600_000;
    const rollup = rollupBucket("Agg.Steps", [
      interval("Agg.Steps", T0, T0 + hour, { value: 1200, unit: "count", origins: [] }),
    ]);
    expect(rollup.fields.value?.sum).toBe(1200);
    expect(rollup.durationMs).toBe(hour);
  });

  it("gives sessions a count and a duration but no fields", () => {
    const rollup = rollupBucket("SleepSession", [
      interval("SleepSession", T0, T0 + 480 * MIN, { stages: [], title: "night" }),
    ]);
    expect(rollup).toEqual({ records: 1, fields: {}, durationMs: 480 * MIN, hours: [H0] });
  });

  it("counts an unknown type without failing", () => {
    expect(
      rollupBucket("SomethingNewer", [
        interval("SomethingNewer", T0, T0 + MIN, { reading: 5 }),
        interval("SomethingNewer", T0 + MIN, T0 + 3 * MIN, { reading: 6 }),
      ]),
    ).toEqual({ records: 2, fields: {}, durationMs: 3 * MIN, hours: [H0] });
    expect(rollupBucket("SomethingNewer", [instant("SomethingNewer", T0, { reading: 5 })])).toEqual(
      { records: 1, fields: {}, hours: [H0] },
    );
  });

  it("is empty for no records", () => {
    expect(rollupBucket("Steps", [])).toEqual({ records: 0, fields: {}, hours: [] });
  });

  it("skips a value that is missing, not a number, or not finite", () => {
    const rollup = rollupBucket("Steps", [
      interval("Steps", T0, T0 + MIN, { count: 10 }),
      interval("Steps", T0 + MIN, T0 + 2 * MIN, {}),
      interval("Steps", T0 + 2 * MIN, T0 + 3 * MIN, { count: "12" }),
      interval("Steps", T0 + 3 * MIN, T0 + 4 * MIN, { count: NaN }),
      interval("Steps", T0 + 4 * MIN, T0 + 5 * MIN, { count: null }),
    ]);
    expect(rollup.records).toBe(5);
    expect(rollup.fields.count).toMatchObject({ n: 1, sum: 10, mean: 10 });
  });

  it("leaves a field out when no record carried it", () => {
    const rollup = rollupBucket("BloodPressure", [instant("BloodPressure", T0, { systolic: 118 })]);
    expect(Object.keys(rollup.fields)).toEqual(["systolic"]);
  });

  it("tolerates a malformed series", () => {
    const rollup = rollupBucket("HeartRate", [
      interval("HeartRate", T0, T0 + MIN, { samples: "none" }),
      interval("HeartRate", T0, T0 + MIN, {}),
      interval("HeartRate", T0 + MIN, T0 + 2 * MIN, {
        samples: [null, 7, { t: T0 + MIN }, { bpm: 66 }, { t: T0 + MIN + 1, bpm: 68 }],
      }),
    ]);
    // The sample with no time of its own is filed at its record's start.
    expect(rollup.fields.bpm).toMatchObject({
      n: 2,
      sum: 134,
      first: 66,
      firstMs: T0 + MIN,
      last: 68,
      lastMs: T0 + MIN + 1,
    });
  });

  it("gives a tie on the instant to encounter order", () => {
    const rollup = rollupBucket("Weight", [
      instant("Weight", T0, { weight: 1 }),
      instant("Weight", T0, { weight: 2 }),
      instant("Weight", T0, { weight: 3 }),
    ]);
    expect(rollup.fields.weight).toMatchObject({ first: 1, last: 3 });
  });
});

describe("mergeRollups", () => {
  it("is empty for no parts", () => {
    expect(mergeRollups([])).toEqual({ records: 0, fields: {}, hours: [] });
  });

  it("returns a single part unchanged, as a copy", () => {
    const part = rollupBucket("Steps", [steps(T0, 5), steps(T0 + MIN, 9)]);
    const merged = mergeRollups([part]);
    expect(merged).toEqual(part);
    expect(merged.fields.count).not.toBe(part.fields.count);
  });

  it("equals the rollup of all the records, however they are split", () => {
    const records = [
      steps(T0, 12),
      steps(T0 + 3 * MIN, 7, 2),
      steps(T0 + 10 * MIN, 31),
      steps(T0 + 61 * MIN, 4, 5),
      steps(T0 + 70 * MIN, 250),
      steps(T0 + 125 * MIN, 1),
      steps(T0 + 126 * MIN, 99, 3),
    ];
    const whole = rollupBucket("Steps", records);
    for (const cuts of [[3, 5], [1, 2], [0, 7], [6]]) {
      const parts: BucketRollup[] = [];
      let from = 0;
      for (const cut of [...cuts, records.length]) {
        parts.push(rollupBucket("Steps", records.slice(from, cut)));
        from = cut;
      }
      expect(mergeRollups(parts)).toEqual(whole);
    }
  });

  it("recomputes the mean from sum and n rather than averaging means", () => {
    const light = rollupBucket("Steps", [steps(T0, 10)]);
    const heavy = rollupBucket("Steps", [steps(T0 + MIN, 20), steps(T0 + 2 * MIN, 30)]);
    // Means are 10 and 25; their average would be 17.5. The truth is 60 / 3.
    expect(mergeRollups([light, heavy]).fields.count?.mean).toBe(20);
  });

  it("goes by time, not by array order, for first and last", () => {
    const early = rollupBucket("Weight", [instant("Weight", T0, { weight: 70 })]);
    const late = rollupBucket("Weight", [instant("Weight", T0 + MIN, { weight: 72 })]);
    expect(mergeRollups([late, early]).fields.weight).toMatchObject({
      first: 70,
      firstMs: T0,
      last: 72,
      lastMs: T0 + MIN,
    });
  });

  it("breaks a tie on the instant the way rollupBucket does", () => {
    const a = instant("Weight", T0, { weight: 1 });
    const b = instant("Weight", T0, { weight: 2 });
    const merged = mergeRollups([rollupBucket("Weight", [a]), rollupBucket("Weight", [b])]);
    expect(merged).toEqual(rollupBucket("Weight", [a, b]));
  });

  it("merges a field over the parts that carry it", () => {
    const both = rollupBucket("BloodPressure", [
      instant("BloodPressure", T0, { systolic: 120, diastolic: 80 }),
    ]);
    const one = rollupBucket("BloodPressure", [
      instant("BloodPressure", T0 + MIN, { systolic: 130 }),
    ]);
    const merged = mergeRollups([both, one, rollupBucket("BloodPressure", [])]);
    expect(merged.records).toBe(2);
    expect(merged.fields.systolic).toMatchObject({ n: 2, sum: 250, mean: 125 });
    expect(merged.fields.diastolic).toMatchObject({ n: 1, sum: 80, mean: 80 });
  });

  it("keeps durationMs absent when no part has one, and sums it otherwise", () => {
    const weights = rollupBucket("Weight", [instant("Weight", T0, { weight: 70 })]);
    expect("durationMs" in mergeRollups([weights, weights])).toBe(false);
    const a = rollupBucket("Steps", [steps(T0, 1, 4)]);
    const b = rollupBucket("Steps", [steps(T0 + 60 * MIN, 1, 6)]);
    expect(mergeRollups([a, rollupBucket("Steps", []), b]).durationMs).toBe(10 * MIN);
  });

  it("merges series rollups exactly", () => {
    const hr = (start: number, bpms: number[]): HcRecord =>
      interval("HeartRate", start, start + MIN, {
        samples: bpms.map((bpm, index) => ({ t: start + index * 1000, bpm })),
      });
    const records = [hr(T0, [60, 62, 61]), hr(T0 + MIN, [90]), hr(T0 + 2 * MIN, [55, 140])];
    const merged = mergeRollups(records.map((record) => rollupBucket("HeartRate", [record])));
    expect(merged).toEqual(rollupBucket("HeartRate", records));
    expect(merged.fields.bpm).toMatchObject({ n: 6, sum: 468, min: 55, max: 140, mean: 78 });
  });

  it("does not change its inputs", () => {
    const a = rollupBucket("Steps", [steps(T0, 5)]);
    const b = rollupBucket("Steps", [steps(T0 + MIN, 7)]);
    const before = structuredClone([a, b]);
    mergeRollups([a, b]);
    expect([a, b]).toEqual(before);
  });
});

describe("what a rollup says beyond its statistics", () => {
  it("lists the UTC hours its records start in, and merges them", () => {
    const first = rollupBucket("Steps", [steps(T0, 5), steps(T0 + MIN, 9)]);
    const later = rollupBucket("Steps", [steps(T0 + 3 * HOUR, 7)]);

    expect(first.hours).toEqual([H0]);
    expect(mergeRollups([later, first]).hours).toEqual([H0, H0 + 3]);
  });

  it("does not claim to know the hours when a part with records does not say", () => {
    const old: BucketRollup = { records: 2, fields: {} };
    const merged = mergeRollups([rollupBucket("Steps", [steps(T0, 5)]), old]);

    expect(merged.records).toBe(3);
    expect(merged.hours).toBeUndefined();
    // A part with nothing in it has no hours to be silent about.
    const empty: BucketRollup = { records: 0, fields: {} };
    const withEmpty = mergeRollups([rollupBucket("Steps", [steps(T0, 5)]), empty]);
    expect(withEmpty.hours).toEqual([H0]);
  });

  it("lists a running count's records that run past the hour they start in", () => {
    const within = steps(T0, 40, 10);
    // Starts thirteen minutes into the hour and runs for ninety.
    const past = steps(T0 + 20 * MIN, 900, 90);
    const rollup = rollupBucket("Steps", [within, past]);

    // Both are counted whole where they start.
    expect(rollup.fields.count?.sum).toBe(940);
    expect(rollup.crossing).toEqual([{ s: T0 + 20 * MIN, e: T0 + 110 * MIN, v: { count: 900 } }]);
    expect(rollupBucket("Steps", [within]).crossing).toBeUndefined();
  });

  it("does not list a record that ends exactly on the hour, or one of another kind", () => {
    const hourStart = H0 * HOUR;
    const exact = interval("TotalCaloriesBurned", hourStart, hourStart + HOUR, { energy: 70 });
    const night = interval("SleepSession", T0, T0 + 480 * MIN, {});
    const drink = interval("Hydration", T0, T0 + 120 * MIN, { volume: 0.5 });

    expect(rollupBucket("TotalCaloriesBurned", [exact]).crossing).toBeUndefined();
    expect(rollupBucket("SleepSession", [night]).crossing).toBeUndefined();
    expect(rollupBucket("Hydration", [drink]).crossing).toBeUndefined();
  });

  it("keeps the lists of the parts it merges", () => {
    const early = rollupBucket("Steps", [steps(T0, 600, 120)]);
    const late = rollupBucket("Steps", [steps(T0 + 5 * HOUR, 30, 70)]);

    expect(mergeRollups([early, late]).crossing).toEqual([
      { s: T0, e: T0 + 120 * MIN, v: { count: 600 } },
      { s: T0 + 5 * HOUR, e: T0 + 5 * HOUR + 70 * MIN, v: { count: 30 } },
    ]);
  });
});

describe("the mean stays inside the extremes", () => {
  // 0.1 + 0.1 + 0.1 is 0.30000000000000004 in floating point, and a third of
  // that is a hair above 0.1: unclamped, the mean would exceed the maximum.
  const tenths = [T0, T0 + MIN, T0 + 2 * MIN].map((at) => instant("Weight", at, { weight: 0.1 }));

  it("when a bucket is rolled up", () => {
    const stats = rollupBucket("Weight", tenths).fields.weight;
    expect(stats?.mean).toBeLessThanOrEqual(stats?.max ?? -Infinity);
    expect(stats?.mean).toBeGreaterThanOrEqual(stats?.min ?? Infinity);
  });

  it("when rollups are merged", () => {
    const stats = mergeRollups(tenths.map((record) => rollupBucket("Weight", [record]))).fields
      .weight;
    expect(stats?.n).toBe(3);
    expect(stats?.mean).toBeLessThanOrEqual(stats?.max ?? -Infinity);
    expect(stats?.mean).toBeGreaterThanOrEqual(stats?.min ?? Infinity);
  });
});
