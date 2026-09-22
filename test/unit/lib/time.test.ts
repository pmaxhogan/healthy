import { describe, expect, it } from "vitest";

import { AppError } from "../../../worker/lib/errors.ts";
import {
  DAY_SECONDS,
  addDays,
  addMinutes,
  dateInZone,
  formatInZone,
  fromIso,
  isIso,
  nowSeconds,
  startOfDayInZone,
  toIso,
  toIsoInZone,
} from "../../../worker/lib/time.ts";

// Fixtures are deliberately not the owner's zone: UTC plus one European zone,
// chosen because its DST transitions fall on dates the tests can name.
const PARIS = "Europe/Paris";
const HHMM: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };

describe("unix second <-> ISO conversion", () => {
  it("round-trips through both directions", () => {
    expect(toIso(1_767_225_600)).toBe("2026-01-01T00:00:00.000Z");
    expect(fromIso("2026-01-01T00:00:00.000Z")).toBe(1_767_225_600);
  });

  it("truncates sub-second precision towards the past", () => {
    expect(fromIso("2026-01-01T00:00:00.999Z")).toBe(1_767_225_600);
  });

  it("accepts an offset instant, not just Z", () => {
    expect(fromIso("2026-01-01T01:00:00+01:00")).toBe(fromIso("2026-01-01T00:00:00Z"));
  });

  it("throws rather than yielding NaN for an unparseable instant", () => {
    expect(() => fromIso("last tuesday")).toThrow(AppError);
    expect(() => fromIso("")).toThrow(/unparseable/);
  });

  it("throws for a non-finite unix second", () => {
    expect(() => toIso(NaN)).toThrow(AppError);
    expect(() => toIso(Infinity)).toThrow(/finite/);
  });

  it("recognises what it can parse", () => {
    expect(isIso("2026-01-01T00:00:00Z")).toBe(true);
    expect(isIso("not a date")).toBe(false);
  });
});

describe("nowSeconds", () => {
  it("takes an injected clock and floors it to a whole second", () => {
    expect(nowSeconds(() => 1_767_225_600_999)).toBe(1_767_225_600);
  });
});

describe("addMinutes / addDays", () => {
  it("shifts forwards and backwards", () => {
    expect(addMinutes("2026-01-01T00:00:00Z", 90)).toBe("2026-01-01T01:30:00.000Z");
    // The arrive-early offset is applied as a negative shift.
    expect(addMinutes("2026-01-01T11:30:00Z", -15)).toBe("2026-01-01T11:15:00.000Z");
    expect(addDays("2026-01-01T00:00:00Z", -90)).toBe("2025-10-03T00:00:00.000Z");
  });

  it("measures a day as DAY_SECONDS of real time, not a calendar day", () => {
    // Deliberate: the sync window is a rolling 90 * 86400 seconds, so it does
    // not lurch by an hour when a DST transition falls inside it.
    expect(fromIso(addDays("2026-03-28T12:00:00Z", 1)) - fromIso("2026-03-28T12:00:00Z")).toBe(
      DAY_SECONDS,
    );
  });
});

describe("startOfDayInZone", () => {
  it("is plain midnight in UTC", () => {
    expect(startOfDayInZone("2026-05-05T13:45:00Z", "UTC")).toBe("2026-05-05T00:00:00.000Z");
  });

  it("is the local midnight, not the UTC one", () => {
    // 23:30Z on the 28th is already 00:30 on the 29th in Paris.
    expect(startOfDayInZone("2026-03-28T23:30:00Z", PARIS)).toBe("2026-03-28T23:00:00.000Z");
  });

  it("is right on the day the offset springs forward", () => {
    // 2026-03-29 in Paris begins at +01:00 and ends at +02:00. Converting local
    // midnight with the offset in force at noon would answer 22:00Z, an hour early.
    expect(startOfDayInZone("2026-03-29T10:00:00Z", PARIS)).toBe("2026-03-28T23:00:00.000Z");
  });

  it("is right on the day the offset falls back", () => {
    // The mirror image: 2026-10-25 begins at +02:00 and ends at +01:00.
    expect(startOfDayInZone("2026-10-25T11:00:00Z", PARIS)).toBe("2026-10-24T22:00:00.000Z");
  });

  it("rejects a zone Intl does not know", () => {
    expect(() => startOfDayInZone("2026-05-05T00:00:00Z", "Mars/Olympus")).toThrow(AppError);
  });
});

describe("dateInZone", () => {
  it("gives the local calendar date, which is what a FHIR date parameter wants", () => {
    expect(dateInZone("2026-03-28T23:30:00Z", PARIS)).toBe("2026-03-29");
    expect(dateInZone("2026-03-28T23:30:00Z", "UTC")).toBe("2026-03-28");
  });

  it("zero-pads month and day", () => {
    expect(dateInZone("2026-01-02T00:00:00Z", "UTC")).toBe("2026-01-02");
  });
});

describe("formatInZone", () => {
  it("renders the same instant differently per zone", () => {
    expect(formatInZone("2026-01-02T03:04:00Z", "UTC", HHMM)).toBe("03:04");
    expect(formatInZone("2026-01-02T03:04:00Z", PARIS, HHMM)).toBe("04:04");
  });

  it("defaults to a medium date and short time", () => {
    const formatted = formatInZone("2026-01-02T03:04:00Z", "UTC");

    expect(formatted).toContain("2026");
    expect(formatted).toMatch(/3:04/);
  });

  it("rejects a zone Intl does not know", () => {
    expect(() => formatInZone("2026-01-02T03:04:00Z", "Nowhere/Nothing")).toThrow(AppError);
  });
});

describe("toIsoInZone", () => {
  it("keeps the local wall clock and states the offset", () => {
    // 2026-07-01T10:00:00Z is noon in Paris, which is +02:00 in July.
    expect(toIsoInZone(fromIso("2026-07-01T10:00:00Z"), PARIS)).toBe("2026-07-01T12:00:00+02:00");
  });

  it("uses the offset in force at that instant, not today's", () => {
    // Either side of the European autumn transition on 2026-10-25.
    expect(toIsoInZone(fromIso("2026-10-24T10:00:00Z"), PARIS)).toBe("2026-10-24T12:00:00+02:00");
    expect(toIsoInZone(fromIso("2026-10-26T10:00:00Z"), PARIS)).toBe("2026-10-26T11:00:00+01:00");
  });

  it("writes a zero offset as +00:00 rather than Z", () => {
    expect(toIsoInZone(fromIso("2026-01-02T03:04:05Z"), "UTC")).toBe("2026-01-02T03:04:05+00:00");
  });

  it("handles a zone west of UTC and one with a half-hour offset", () => {
    expect(toIsoInZone(fromIso("2026-01-02T03:04:05Z"), "America/New_York")).toBe(
      "2026-01-01T22:04:05-05:00",
    );
    expect(toIsoInZone(fromIso("2026-01-02T03:04:05Z"), "Asia/Kolkata")).toBe(
      "2026-01-02T08:34:05+05:30",
    );
  });

  it("rejects a zone Intl does not know, and a non-finite instant", () => {
    expect(() => toIsoInZone(0, "Nowhere/Nothing")).toThrow(AppError);
    expect(() => toIsoInZone(NaN, "UTC")).toThrow(AppError);
  });
});
