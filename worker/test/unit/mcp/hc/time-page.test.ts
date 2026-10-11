// The small pure pieces under the Health Connect tools: times in and out, and
// the byte budget's cursor.
//
// Zones are test parameters, never the owner's: a fixed offset, a half-hour
// offset, and one with daylight saving in the southern hemisphere.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_BYTES,
  cursorDigest,
  readCursor,
  writeCursor,
} from "../../../../src/mcp/hc/page.ts";
import {
  isCalendarDate,
  isDateOrOffsetInstant,
  isTimeZone,
  parseRange,
  zoneClock,
} from "../../../../src/mcp/hc/time.ts";
import { unitsFor } from "../../../../src/mcp/hc/units.ts";

const FIXED_WEST = "Etc/GMT+5";
const HALF_HOUR = "Asia/Kolkata";
const DST = "Pacific/Auckland";

const HOUR = 3_600_000;

describe("what start and end accept", () => {
  it("takes a calendar date, or an instant that says its offset", () => {
    expect(isDateOrOffsetInstant("2026-01-31")).toBe(true);
    expect(isDateOrOffsetInstant("2026-01-31T09:00:00Z")).toBe(true);
    expect(isDateOrOffsetInstant("2026-01-31T09:00-05:00")).toBe(true);
    expect(isDateOrOffsetInstant("2026-01-31T09:00:00.250+05:30")).toBe(true);
  });

  it("refuses a date-time with no offset rather than guess at one", () => {
    expect(isDateOrOffsetInstant("2026-01-31T09:00:00")).toBe(false);
    expect(isDateOrOffsetInstant("2026-01")).toBe(false);
    expect(isDateOrOffsetInstant("yesterday")).toBe(false);
  });

  it("refuses a date the calendar does not have", () => {
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2028-02-29")).toBe(true);
  });

  it("knows a zone from a typo", () => {
    expect(isTimeZone(FIXED_WEST)).toBe(true);
    expect(isTimeZone("Not/AZone")).toBe(false);
  });
});

describe("parseRange", () => {
  it.each([
    [FIXED_WEST, Date.UTC(2026, 0, 31, 5), Date.UTC(2026, 1, 1, 5)],
    [HALF_HOUR, Date.UTC(2026, 0, 30, 18, 30), Date.UTC(2026, 0, 31, 18, 30)],
  ])("reads a date as that whole local day in %s", (timeZone, startMs, endMs) => {
    const range = parseRange({ start: "2026-01-31", end: "2026-01-31", timeZone, nowMs: 0 });

    expect(range).toStrictEqual({ startMs, endMs });
  });

  it("makes a day that changes its clocks 23 or 25 hours long", () => {
    // Clocks go back on 2026-04-05 and forward on 2026-09-27 in this zone.
    const long = parseRange({ start: "2026-04-05", end: "2026-04-05", timeZone: DST, nowMs: 0 });
    const short = parseRange({ start: "2026-09-27", end: "2026-09-27", timeZone: DST, nowMs: 0 });

    expect((long.endMs - long.startMs) / HOUR).toBe(25);
    expect((short.endMs - short.startMs) / HOUR).toBe(23);
  });

  it("takes an instant exactly, whatever the zone, and ends at now when no end is given", () => {
    const nowMs = Date.UTC(2026, 0, 31, 12);
    const range = parseRange({ start: "2026-01-31T09:00:00-05:00", timeZone: HALF_HOUR, nowMs });

    expect(range).toStrictEqual({ startMs: Date.UTC(2026, 0, 31, 14), endMs: nowMs });
  });
});

describe("zoneClock", () => {
  it("writes an instant with the zone's offset, and milliseconds only when there are any", () => {
    const at = Date.UTC(2026, 0, 31, 14, 30);

    expect(zoneClock(FIXED_WEST).iso(at)).toBe("2026-01-31T09:30:00-05:00");
    expect(zoneClock(HALF_HOUR).iso(at)).toBe("2026-01-31T20:00:00+05:30");
    expect(zoneClock(FIXED_WEST).iso(at + 250)).toBe("2026-01-31T09:30:00.250-05:00");
  });

  it("carries the offset in force at that instant across a clock change", () => {
    const clock = zoneClock(DST);
    // 13:59:59Z is still summer time (+13); 14:00:00Z is 02:00 standard (+12).
    const before = Date.UTC(2026, 3, 4, 13, 59, 59);

    expect(clock.iso(before)).toBe("2026-04-05T02:59:59+13:00");
    expect(clock.iso(before + 1000)).toBe("2026-04-05T02:00:00+12:00");
  });

  it("round-trips: every string it writes parses back to the instant", () => {
    for (const timeZone of [FIXED_WEST, HALF_HOUR, DST]) {
      const clock = zoneClock(timeZone);
      for (let step = 0; step < 400; step += 1) {
        const at = Date.UTC(2026, 3, 4) + step * 7 * 60_000 + 123;
        expect(Date.parse(clock.iso(at)), timeZone).toBe(at);
      }
    }
  });

  it("names the local day, and passes null through", () => {
    const clock = zoneClock(FIXED_WEST);

    expect(clock.day(Date.UTC(2026, 0, 31, 4, 59))).toBe("2026-01-30");
    expect(clock.isoOrNull(null)).toBeNull();
    expect(clock.isoOrNull(undefined)).toBeNull();
  });
});

describe("the cursor", () => {
  it("defaults the budget to 25 kB", () => {
    expect(DEFAULT_MAX_BYTES).toBe(25_000);
  });

  it("round-trips an offset, with and without an anchor", async () => {
    const digest = await cursorDigest("hc_records", { type: "Steps", start: "2026-01-01" });

    const anchored = writeCursor(digest, { offset: 2, anchorMs: 1_790_000_000_000, before: 31 });

    expect(readCursor(writeCursor(digest, 40), digest)).toStrictEqual({
      offset: 40,
      anchorMs: null,
      before: 0,
    });
    expect(readCursor(anchored, digest)).toStrictEqual({
      offset: 2,
      anchorMs: 1_790_000_000_000,
      before: 31,
    });
    expect(readCursor(undefined, digest)).toStrictEqual({ offset: 0, anchorMs: null, before: 0 });
  });

  it("is bound to the question, not to how much of it one call carries", async () => {
    const question = { type: "Steps", start: "2026-01-01", jq: ".[]" };
    const digest = await cursorDigest("hc_records", question);

    expect(
      await cursorDigest("hc_records", { ...question, limit: 5, max_bytes: 9, cursor: "x" }),
    ).toBe(digest);
    expect(
      await cursorDigest("hc_records", { start: "2026-01-01", jq: ".[]", type: "Steps" }),
    ).toBe(digest);
    expect(await cursorDigest("hc_records", { ...question, type: "Distance" })).not.toBe(digest);
    expect(await cursorDigest("hc_records", { ...question, jq: ".[] | .id" })).not.toBe(digest);
    expect(await cursorDigest("hc_aggregate", question)).not.toBe(digest);
  });

  it("refuses a cursor for another question, and anything that is not a cursor", async () => {
    const digest = await cursorDigest("hc_records", { type: "Steps" });
    const other = await cursorDigest("hc_records", { type: "Distance" });

    expect(readCursor(writeCursor(other, 3), digest)).toBeNull();
    expect(readCursor("not base64 at all!", digest)).toBeNull();
    expect(readCursor(btoa("[1,2]"), digest)).toBeNull();
    const negative = btoa(JSON.stringify({ v: 1, q: digest, o: -1 }));
    const newer = btoa(JSON.stringify({ v: 2, q: digest, o: 1 }));
    expect(readCursor(negative, digest)).toBeNull();
    expect(readCursor(newer, digest)).toBeNull();
  });
});

describe("units", () => {
  it("declares a unit per field of a type, once", () => {
    expect(unitsFor("BloodPressure")).toStrictEqual({ systolic: "mmHg", diastolic: "mmHg" });
    expect(unitsFor("Distance")).toStrictEqual({ distance: "m" });
    expect(unitsFor("Agg.Steps")).toStrictEqual({ value: "steps" });
  });

  it("guesses nothing for a type it has no table for", () => {
    expect(unitsFor("SomethingNewer")).toStrictEqual({});
    expect(unitsFor("Agg.SomethingNewer")).toStrictEqual({});
  });
});
