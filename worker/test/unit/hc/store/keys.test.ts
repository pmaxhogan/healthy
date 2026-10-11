// The pure half of the chunk store: keys, grouping, ordering and merging.
// Every record is synthetic: invented ids and values, RFC 2606 style package
// names.

import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { blindHcOrigin, blindHcRecordId, blinderFor } from "../../../../src/db/blind.ts";
import { Meter } from "../../../../src/hc/store/budget.ts";
import {
  DAY_HOURS,
  HOUR_MS,
  chunkExtent,
  compareText,
  dayMarkKey,
  dayRuns,
  dedupeUpserts,
  groupUpserts,
  hourOf,
  hrMarkKey,
  keyId,
  mergeIntoChunk,
  overlapsWindow,
  parseDayMarkKey,
  parseHrMarkKey,
  removeFromChunk,
  sameKey,
  samplesInInterval,
  sortRecords,
  sortedBy,
  utcDayOf,
} from "../../../../src/hc/store/keys.ts";

import type { HcRecord } from "../../../../src/hc/wire.ts";

const T = 1_790_000_000_000 - (1_790_000_000_000 % HOUR_MS);
const H = T / HOUR_MS;

function steps(
  id: string,
  startMs: number,
  count: number,
  extra: Partial<HcRecord> = {},
): HcRecord {
  return {
    id,
    type: "Steps",
    origin: "com.example.wearable",
    lastModified: 1000,
    start: startMs,
    end: startMs + 60_000,
    data: { count },
    ...extra,
  };
}

const ids = (records: readonly HcRecord[]): string[] => records.map((record) => record.id);

describe("chunk keys", () => {
  it("files an instant under the UTC hour it falls in", () => {
    expect(hourOf(T)).toBe(H);
    expect(hourOf(T + HOUR_MS - 1)).toBe(H);
    expect(hourOf(T + HOUR_MS)).toBe(H + 1);
  });

  it("compares keys field by field", () => {
    const key = { type: "Steps", originHash: "~abc", hourUtc: H };

    expect(sameKey(key, { ...key })).toBe(true);
    expect(sameKey(key, { ...key, hourUtc: H + 1 })).toBe(false);
    expect(sameKey(key, { ...key, originHash: "~abd" })).toBe(false);
    expect(sameKey(key, { ...key, type: "Distance" })).toBe(false);
    expect(keyId(key)).toBe(`Steps:~abc:${String(H)}`);
    expect(keyId(key)).not.toBe(keyId({ ...key, hourUtc: H + 1 }));
  });
});

describe("sortRecords", () => {
  it("orders by start, then by id, whatever order the records arrived in", () => {
    const records = [steps("b", T + 10, 1), steps("z", T, 1), steps("a", T + 10, 1)];

    expect(ids(sortRecords(records))).toStrictEqual(["z", "a", "b"]);
    const backwards = sortRecords(records.toReversed());
    expect(ids(backwards)).toStrictEqual(["z", "a", "b"]);
    // The input is not reordered.
    expect(ids(records)).toStrictEqual(["b", "z", "a"]);
  });
});

describe("dedupeUpserts", () => {
  it("keeps the copy with the greater lastModified, and the later one on a tie", () => {
    const records = [
      steps("a", T, 1, { lastModified: 2000 }),
      steps("a", T, 2, { lastModified: 3000 }),
      steps("a", T, 3, { lastModified: 2500 }),
      steps("b", T, 4, { lastModified: 2000 }),
      steps("b", T, 5, { lastModified: 2000 }),
    ];

    const kept = dedupeUpserts(records);

    expect(kept.map((record) => [record.id, record.data.count])).toStrictEqual([
      ["a", 2],
      ["b", 5],
    ]);
  });
});

describe("groupUpserts", () => {
  it("groups by type, origin and start hour, in a fixed order", () => {
    const records = [
      steps("late", T + HOUR_MS + 5, 1),
      steps("phone", T, 1, { origin: "com.example.phone" }),
      steps("a", T + 5, 1),
      { ...steps("d", T, 1), type: "Distance" },
      steps("b", T + HOUR_MS - 1, 1),
    ];

    const groups = groupUpserts(records);

    expect(
      groups.map((group) => [group.type, group.origin, group.hourUtc, ids(group.records)]),
    ).toStrictEqual([
      ["Distance", "com.example.wearable", H, ["d"]],
      ["Steps", "com.example.phone", H, ["phone"]],
      ["Steps", "com.example.wearable", H, ["a", "b"]],
      ["Steps", "com.example.wearable", H + 1, ["late"]],
    ]);
    // The cursor is an index into this list, so it must not depend on arrival order.
    const again = groupUpserts(records.toReversed());
    expect(again.map((group) => [group.type, group.origin, group.hourUtc])).toStrictEqual(
      groups.map((group) => [group.type, group.origin, group.hourUtc]),
    );
  });

  it("puts a record given twice in one group only: the newer copy's", () => {
    const groups = groupUpserts([
      steps("a", T, 1, { lastModified: 2000 }),
      steps("a", T + 3 * HOUR_MS, 2, { lastModified: 3000 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.hourUtc).toBe(H + 3);
  });

  it("files an instantaneous record under its time", () => {
    const weight: HcRecord = {
      id: "w",
      type: "Weight",
      origin: "com.example.cuff",
      lastModified: 1000,
      time: T + 2 * HOUR_MS + 1,
      data: { weight: 70 },
    };

    expect(groupUpserts([weight])[0]?.hourUtc).toBe(H + 2);
  });
});

describe("mergeIntoChunk", () => {
  it("adds new records and keeps the stored order", () => {
    const merged = mergeIntoChunk(
      [steps("b", T + 20, 2)],
      [steps("a", T + 10, 1), steps("c", T + 30, 3)],
    );

    expect(ids(merged.records)).toStrictEqual(["a", "b", "c"]);
    expect(ids(merged.accepted)).toStrictEqual(["a", "c"]);
    expect(ids(merged.changed)).toStrictEqual(["a", "c"]);
    expect(merged.replaced).toStrictEqual([]);
  });

  it("replaces a stored copy with a newer one and reports the copy it displaced", () => {
    const old = steps("a", T, 1, { lastModified: 2000 });
    const next = steps("a", T, 9, { lastModified: 3000 });

    const merged = mergeIntoChunk([old], [next]);

    expect(merged.records).toStrictEqual([next]);
    expect(merged.changed).toStrictEqual([next]);
    expect(merged.replaced).toStrictEqual([old]);
  });

  it("drops an incoming copy older than the stored one", () => {
    const held = steps("a", T, 1, { lastModified: 3000 });

    const merged = mergeIntoChunk([held], [steps("a", T, 9, { lastModified: 2000 })]);

    expect(merged.records).toStrictEqual([held]);
    expect(merged.accepted).toStrictEqual([]);
    expect(merged.changed).toStrictEqual([]);
  });

  it("accepts an identical copy without calling it a change", () => {
    const held = steps("a", T, 1);

    const merged = mergeIntoChunk([held], [steps("a", T, 1)]);

    expect(ids(merged.accepted)).toStrictEqual(["a"]);
    expect(merged.changed).toStrictEqual([]);
    expect(merged.replaced).toStrictEqual([]);
  });

  it("lets the incoming copy win a tie on lastModified", () => {
    const merged = mergeIntoChunk([steps("a", T, 1)], [steps("a", T, 2)]);

    expect(merged.records[0]?.data.count).toBe(2);
    expect(ids(merged.changed)).toStrictEqual(["a"]);
  });
});

describe("removeFromChunk", () => {
  it("splits a chunk into what stays and what was taken out", () => {
    const stored = [steps("a", T, 1), steps("b", T + 1, 2), steps("c", T + 2, 3)];

    const { records, removed } = removeFromChunk(stored, new Set(["b", "missing"]));

    expect(ids(records)).toStrictEqual(["a", "c"]);
    expect(ids(removed)).toStrictEqual(["b"]);
  });
});

describe("chunkExtent", () => {
  it("is the earliest start and the latest end, however long a record runs", () => {
    const long = steps("a", T + 5, 1, { end: T + 9 * HOUR_MS });
    const instant: HcRecord = {
      id: "i",
      type: "Steps",
      origin: "com.example.wearable",
      lastModified: 1,
      time: T + 1,
      data: {},
    };

    expect(chunkExtent([long, instant])).toStrictEqual({
      minStartMs: T + 1,
      maxEndMs: T + 9 * HOUR_MS,
    });
  });
});

describe("overlapsWindow", () => {
  const record = steps("a", T, 1, { end: T + 1000 });

  it("takes a half-open window", () => {
    expect(overlapsWindow(record, T, T + 1)).toBe(true);
    expect(overlapsWindow(record, T + 999, T + 2000)).toBe(true);
    // Ends exactly where the window begins: not in it.
    expect(overlapsWindow(record, T + 1000, T + 2000)).toBe(false);
    // Starts exactly where the window ends: not in it.
    expect(overlapsWindow(record, T - 1000, T)).toBe(false);
  });

  it("puts an instant in the window its one instant is in", () => {
    const instant: HcRecord = {
      id: "i",
      type: "Weight",
      origin: "com.example.cuff",
      lastModified: 1,
      time: T,
      data: {},
    };

    expect(overlapsWindow(instant, T, T + 1)).toBe(true);
    expect(overlapsWindow(instant, T - 10, T)).toBe(false);
    expect(overlapsWindow(instant, T + 1, T + 10)).toBe(false);
  });
});

/** The mark of one type's UTC day. */
const at = (type: string, day: number): string => dayMarkKey(type, day * DAY_HOURS);

describe("dirty keys", () => {
  it("round-trip a day mark, including a type with punctuation", () => {
    // Hour 495,123 is in UTC day 20,630.
    expect(dayMarkKey("Agg.Steps", 495_123)).toBe("d020630|Agg.Steps");
    expect(parseDayMarkKey(dayMarkKey("Agg.Steps", H))).toStrictEqual({
      type: "Agg.Steps",
      utcDay: utcDayOf(H),
    });
    expect(parseDayMarkKey("Steps")).toBeNull();
    expect(parseDayMarkKey("|Steps")).toBeNull();
    expect(parseDayMarkKey("2026-01-10|Steps")).toBeNull();
    expect(parseDayMarkKey("1|a|2")).toBeNull();
    expect(parseDayMarkKey("d20630|Steps")).toBeNull();
    expect(parseDayMarkKey("d020630|")).toBeNull();
  });

  it("mark every hour of a UTC day with the one key, and the next day with another", () => {
    const midnight = 20_630 * DAY_HOURS;

    expect(dayMarkKey("Steps", midnight)).toBe(dayMarkKey("Steps", midnight + 23));
    expect(dayMarkKey("Steps", midnight + 24)).not.toBe(dayMarkKey("Steps", midnight));
    expect(dayMarkKey("Steps", midnight - 1)).toBe("d020629|Steps");
  });

  it("read nothing but a day mark as one", () => {
    // A bare number before the separator is an hour or a day of some other
    // scheme, not this one: the key says what it is with its first letter.
    expect(parseDayMarkKey("0495123|Steps")).toBeNull();
    expect(parseDayMarkKey("020630|Steps")).toBeNull();
    expect(parseDayMarkKey("d0495123|Steps")).toBeNull();
  });

  it("order day marks by time, whatever their types", () => {
    const keys = [
      dayMarkKey("Weight", 99_999),
      dayMarkKey("Steps", 100_000 + DAY_HOURS),
      dayMarkKey("Agg.Steps", 9),
    ];

    // Plain string order, which is what the primary key gives, is day order.
    expect(sortedBy(keys, compareText)).toStrictEqual([
      dayMarkKey("Agg.Steps", 9),
      dayMarkKey("Weight", 99_999),
      dayMarkKey("Steps", 100_000 + DAY_HOURS),
    ]);
  });

  it("group a page of day marks into runs of consecutive days, newest first", () => {
    const keys = [
      at("Steps", 105),
      at("Steps", 104),
      at("Steps", 103),
      at("Steps", 100),
      at("Weight", 104),
      // The same mark twice is one day, not two.
      at("Steps", 104),
      at("Steps", 99),
      "not-a-mark",
    ];

    expect(dayRuns(keys, 7)).toStrictEqual({
      runs: [
        { type: "Steps", firstDay: 103, days: 3 },
        { type: "Weight", firstDay: 104, days: 1 },
        { type: "Steps", firstDay: 99, days: 2 },
      ],
      unreadable: ["not-a-mark"],
    });
  });

  it("cut a run at the most days one may hold", () => {
    const keys = Array.from({ length: 10 }, (_, index) => dayMarkKey("Steps", index * DAY_HOURS));

    expect(dayRuns(keys, 4).runs).toStrictEqual([
      { type: "Steps", firstDay: 6, days: 4 },
      { type: "Steps", firstDay: 2, days: 4 },
      { type: "Steps", firstDay: 0, days: 2 },
    ]);
    expect(dayRuns([], 4)).toStrictEqual({ runs: [], unreadable: [] });
  });

  it("round-trip a heart-rate mark", () => {
    expect(parseHrMarkKey(hrMarkKey("~abc_-", H))).toStrictEqual({
      originHash: "~abc_-",
      hourUtc: H,
    });
    expect(parseHrMarkKey("~abc|x")).toBeNull();
    expect(parseHrMarkKey("~abc|1.5")).toBeNull();
    expect(parseHrMarkKey("|12")).toBeNull();
    expect(parseHrMarkKey("~abc|12|13")).toBeNull();
  });
});

describe("Meter", () => {
  it("always lets the first unit of a slice start, whatever it costs", () => {
    const meter = new Meter({ maxQueries: 5, maxMs: 1000 }, () => 0);

    expect(meter.mayStart(500)).toBe(true);
    expect(meter.progressed).toBe(false);
  });

  it("refuses a unit that would go past the query budget once one is done", () => {
    const meter = new Meter({ maxQueries: 20, maxMs: 1000 }, () => 0);
    meter.spend(12);
    meter.done();

    expect(meter.progressed).toBe(true);
    expect(meter.mayStart(8)).toBe(true);
    expect(meter.mayStart(9)).toBe(false);
  });

  it("says how much of its statement budget is left", () => {
    const meter = new Meter({ maxQueries: 20, maxMs: 1000 }, () => 0);

    expect(meter.unspent).toBe(1);
    meter.spend(5);
    expect(meter.unspent).toBe(0.75);
    // A unit under way may run past the budget; what is left is then nothing.
    meter.spend(30);
    expect(meter.unspent).toBe(0);
    expect(new Meter({ maxQueries: 0, maxMs: 1000 }, () => 0).unspent).toBe(0);
  });

  it("refuses a unit once the time is spent", () => {
    const now = { at: 0 };
    const meter = new Meter({ maxQueries: 1000, maxMs: 1000 }, () => now.at);
    meter.done();
    now.at = 999;
    expect(meter.mayStart(1)).toBe(true);

    now.at = 1000;

    expect(meter.mayStart(1)).toBe(false);
    expect(meter.elapsedMs).toBe(1000);
  });
});

/** A HeartRate series of one minute. */
function series(samples: unknown[], extra: Partial<HcRecord> = {}): HcRecord {
  return {
    id: "hr",
    type: "HeartRate",
    origin: "com.example.wearable",
    lastModified: 1,
    start: T,
    end: T + 60_000,
    data: { samples },
    ...extra,
  };
}

describe("samplesInInterval", () => {
  it("keeps samples timed inside the record, ends included, and counts the rest", () => {
    const record = series([
      { t: T - 1, bpm: 1 },
      { t: T, bpm: 2 },
      { t: T + 60_000, bpm: 3 },
      { t: T + 60_001, bpm: 4 },
      { t: T + 9 * HOUR_MS, bpm: 5 },
    ]);

    const { records, outOfInterval } = samplesInInterval([record]);

    expect(outOfInterval).toBe(3);
    expect(records[0]?.data.samples).toStrictEqual([
      { t: T, bpm: 2 },
      { t: T + 60_000, bpm: 3 },
    ]);
    // The record given is not changed: the store keeps every sample.
    expect(record.data.samples).toHaveLength(5);
  });

  it("returns a record with nothing outside as it is", () => {
    const inside = series([{ t: T + 5, bpm: 60 }]);
    const noSamples = series([], { data: { count: 3 } });

    const { records, outOfInterval } = samplesInInterval([inside, noSamples]);

    expect(outOfInterval).toBe(0);
    expect(records[0]).toBe(inside);
    expect(records[1]).toBe(noSamples);
  });
});

describe("the blind format the chunk keys rely on", () => {
  // A chunk part's AAD is `<device>:<type>:<originHash>:<hour>:<part>`. A type
  // may itself contain `:`, so the AAD is unambiguous only read from the right:
  // two plain integers, then a blind that has one fixed length and no `:` in
  // it. If the blind format ever changes, this is what must still hold.
  const BLIND = /^~[A-Za-z0-9_-]{22}$/u;

  it("is a fixed-length string with no separator character in it", async () => {
    const blinder = blinderFor(randomBytes(32).toString("base64"));
    const inputs = ["com.example.wearable", "a:b", "x#1", "", "com.example.".repeat(40)];

    for (const input of inputs) {
      expect(await blindHcOrigin(blinder, "device:1", input)).toMatch(BLIND);
      expect(await blindHcRecordId(blinder, "device#1", input)).toMatch(BLIND);
    }
  });

  it("gives two different chunks two different ids, whatever the type contains", async () => {
    const blinder = blinderFor(randomBytes(32).toString("base64"));
    const originHash = await blindHcOrigin(blinder, "device", "com.example.wearable");
    // A type may contain `:`; the hash that follows it cannot, and has a fixed
    // length, so the type's own colons cannot shift the fields.
    const left = keyId({ type: "A:B", originHash, hourUtc: 12 });
    const right = keyId({ type: "A", originHash, hourUtc: 12 });

    expect(left).not.toBe(right);
    expect(left.endsWith(`:${originHash}:12`)).toBe(true);
    expect(keyId({ type: "Steps", originHash, hourUtc: 1 })).not.toBe(
      keyId({ type: "Steps", originHash, hourUtc: 11 }),
    );
    expect(keyId({ type: "Steps", originHash, hourUtc: 495_000 })).toBe(
      `Steps:${originHash}:495000`,
    );
  });
});

describe("a share of the budget", () => {
  it("is a fraction of both limits, and is counted back into the whole", () => {
    const meter = new Meter({ maxQueries: 100, maxMs: 1000 }, () => 0);
    meter.spend(30);
    meter.done();

    const part = meter.share(0.2);
    part.spend(15);
    part.done();
    expect(part.mayStart(5)).toBe(true);
    expect(part.mayStart(6)).toBe(false);
    meter.absorb(part);

    expect(meter.statements).toBe(45);
    expect(meter.unitsDone).toBe(2);
    expect(meter.spent).toBeNull();
  });

  it("says which budget a slice ran out of", () => {
    const now = { at: 0 };
    const meter = new Meter({ maxQueries: 10, maxMs: 1000 }, () => now.at);
    meter.spend(10);
    expect(meter.spent).toBe("statements");

    now.at = 1000;

    expect(meter.spent).toBe("time");
  });
});
