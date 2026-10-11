// The phone-to-Worker batch contract. Synthetic records only.

import { describe, expect, it } from "vitest";

import { parseBatch, recordEndMs, recordStartMs } from "../../../src/hc/wire.ts";

const T = 1_790_000_000_000;

const interval = {
  id: "rec-interval",
  type: "Steps",
  origin: "com.example.wearable",
  lastModified: T,
  start: T,
  end: T + 60_000,
  startOffsetMin: -300,
  endOffsetMin: null,
  data: { count: 12 },
};

const instant = {
  id: "rec-instant",
  type: "Weight",
  origin: "com.example.phone",
  lastModified: T,
  time: T,
  offsetMin: 330,
  data: { weight: 70.5 },
};

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    appVersion: "0.1.3",
    batchId: "0b0e7c3a-9f0e-4d0c-8a51-0d7a3f6e2b11",
    phoneTime: T,
    upserts: [interval, instant],
    deletes: ["rec-gone"],
    ...overrides,
  };
}

describe("parseBatch", () => {
  it("reads interval and instantaneous records and keeps unknown fields", () => {
    const parsed = parseBatch(
      envelope({ upserts: [{ ...interval, futureField: { nested: true } }, instant] }),
    );

    expect(parsed?.upserts).toHaveLength(2);
    expect(parsed?.upserts[0]).toMatchObject({ futureField: { nested: true } });
    expect(parsed?.deletes).toStrictEqual(["rec-gone"]);
    expect(parsed?.rejected).toStrictEqual([]);
  });

  it("defaults missing upserts and deletes to empty", () => {
    const parsed = parseBatch(envelope({ upserts: undefined, deletes: undefined }));

    expect(parsed).toMatchObject({ upserts: [], deletes: [], rejected: [] });
  });

  it.each([
    ["another version", { v: 2 }],
    ["a missing device", { deviceId: "" }],
    ["a batch id with spaces", { batchId: "has spaces in it" }],
    ["a negative clock", { phoneTime: -1 }],
    ["upserts that are not a list", { upserts: {} }],
  ])("refuses the whole batch for %s", (_name, overrides) => {
    expect(parseBatch(envelope(overrides))).toBeNull();
  });

  it("refuses a body that is not an object", () => {
    for (const body of [null, [], "text", 3]) expect(parseBatch(body)).toBeNull();
  });

  it.each([
    ["both time and an interval", { ...interval, time: T }],
    ["neither", { ...instant, time: undefined }],
    ["an end before its start", { ...interval, end: T - 1 }],
    ["a type with a space", { ...interval, type: "Steps Record" }],
    ["a fractional instant", { ...instant, time: T + 0.5 }],
    ["an offset no zone has", { ...instant, offsetMin: 2000 }],
    ["data that is not an object", { ...instant, data: 5 }],
    ["no origin", { ...instant, origin: "" }],
  ])("rejects one record with %s and keeps its neighbour", (_name, bad) => {
    const parsed = parseBatch(envelope({ upserts: [bad, instant], deletes: [] }));

    expect(parsed?.upserts.map((record) => record.id)).toStrictEqual(["rec-instant"]);
    expect(parsed?.rejected).toHaveLength(1);
    expect(parsed?.rejected[0]?.errorCode).toBe("invalid_record");
  });

  it("names a rejection by position when the record has no usable id", () => {
    const parsed = parseBatch(envelope({ upserts: [{}, "x"], deletes: [5, ""] }));

    expect(parsed?.rejected).toStrictEqual([
      { id: "upserts[0]", errorCode: "invalid_record" },
      { id: "upserts[1]", errorCode: "invalid_record" },
      { id: "deletes[0]", errorCode: "invalid_id" },
      { id: "deletes[1]", errorCode: "invalid_id" },
    ]);
  });

  it("takes a record type it has never heard of", () => {
    const parsed = parseBatch(
      envelope({
        upserts: [
          { ...interval, type: "Agg.Steps" },
          { ...instant, type: "Novel" },
        ],
      }),
    );

    expect(parsed?.upserts.map((record) => record.type)).toStrictEqual(["Agg.Steps", "Novel"]);
  });

  it("reads the phone's sync report and refuses a malformed one", () => {
    const syncState = {
      types: [{ type: "Steps", permission: "denied" }],
      backfillComplete: false,
    };

    expect(parseBatch(envelope({ syncState }))?.syncState).toMatchObject(syncState);
    expect(
      parseBatch(envelope({ syncState: { types: [{ type: "Steps", permission: "maybe" }] } })),
    ).toBeNull();
  });
});

describe("record instants", () => {
  it("files a record under its start, or its single time", () => {
    const parsed = parseBatch(envelope());
    const [first, second] = parsed?.upserts ?? [];

    expect(first === undefined ? null : recordStartMs(first)).toBe(T);
    expect(first === undefined ? null : recordEndMs(first)).toBe(T + 60_000);
    expect(second === undefined ? null : recordStartMs(second)).toBe(T);
    expect(second === undefined ? null : recordEndMs(second)).toBe(T);
  });
});
