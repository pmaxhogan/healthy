import { describe, expect, it } from "vitest";

import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatTime,
  humanizeCode,
  isPast,
  maskAccount,
  maskCalendarId,
  parseIso,
  relativeTime,
} from "../../src/lib/format.ts";

import { NOW } from "./helpers.ts";

/** Minutes either side of the fixed NOW, as an ISO string. */
function at(offsetMinutes: number): string {
  return new Date(NOW + offsetMinutes * 60_000).toISOString();
}

describe("parseIso", () => {
  it("returns null for absent or unparseable input", () => {
    expect(parseIso(null)).toBeNull();
    expect(parseIso(undefined)).toBeNull();
    expect(parseIso("")).toBeNull();
    expect(parseIso("not a date")).toBeNull();
  });

  it("parses an ISO instant", () => {
    expect(parseIso("2026-09-21T12:00:00.000Z")?.getTime()).toBe(NOW);
  });
});

describe("relativeTime", () => {
  it("says never when there is no timestamp", () => {
    expect(relativeTime(null, NOW)).toBe("never");
    expect(relativeTime(undefined, NOW)).toBe("never");
  });

  it("collapses the last few seconds to just now", () => {
    expect(relativeTime(at(0), NOW)).toBe("just now");
    expect(relativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe("just now");
  });

  it.each([
    [-12, "12 min ago"],
    [-59, "59 min ago"],
    [-180, "3 h ago"],
    [-60 * 24 * 5, "5 d ago"],
    [12, "in 12 min"],
    [45, "in 45 min"],
    [180, "in 3 h"],
  ])("renders %i minutes from now as %s", (offset, expected) => {
    expect(relativeTime(at(offset), NOW)).toBe(expected);
  });

  it("switches to months past sixty days", () => {
    expect(relativeTime(at(-60 * 24 * 90), NOW)).toBe("3 mo ago");
  });
});

describe("isPast", () => {
  it("is true only for an instant already gone", () => {
    expect(isPast(at(-1), NOW)).toBe(true);
    expect(isPast(at(1), NOW)).toBe(false);
    expect(isPast(null, NOW)).toBe(false);
  });
});

describe("absolute formatting", () => {
  it("renders in the timezone it is given", () => {
    const iso = "2026-09-21T23:30:00.000Z";
    // Two zones far enough apart that the calendar day differs, so a dropped
    // timeZone option could not pass by coincidence.
    expect(formatTime(iso, "UTC")).not.toBe(formatTime(iso, "Asia/Tokyo"));
    expect(formatDate(iso, "UTC")).not.toBe(formatDate(iso, "Asia/Tokyo"));
    expect(formatDateTime(iso, "UTC")).toContain("2026");
  });

  it("renders an em dash for a missing instant", () => {
    expect(formatDateTime(null, "UTC")).toBe("—");
    expect(formatDate(undefined, "UTC")).toBe("—");
    expect(formatTime("", "UTC")).toBe("—");
  });

  it("falls back to the browser zone when none is set", () => {
    expect(formatDateTime("2026-09-21T12:00:00.000Z", null)).toContain("2026");
  });
});

describe("formatDuration", () => {
  it("uses milliseconds below a second and seconds above", () => {
    expect(formatDuration(412)).toBe("412 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1800)).toBe("1.8 s");
  });
});

describe("maskAccount", () => {
  it("keeps the first and last character of the local part", () => {
    expect(maskAccount("owner@example.test")).toBe("o…r@example.test");
  });

  it("leaves a very short local part alone and handles odd input", () => {
    expect(maskAccount("ab@example.test")).toBe("ab@example.test");
    expect(maskAccount(null)).toBe("—");
    expect(maskAccount("primary")).toBe("p…");
  });
});

describe("maskCalendarId", () => {
  it("masks a calendar id that is an email address, same as an account label", () => {
    expect(maskCalendarId("owner@example.test")).toBe("o…r@example.test");
  });

  it("leaves a non-address calendar id alone", () => {
    // These would be mangled by `maskAccount` itself -- the guard is the point.
    expect(maskCalendarId("primary")).toBe("primary");
    expect(maskCalendarId("family-appointments")).toBe("family-appointments");
  });
});

describe("humanizeCode", () => {
  it("turns a snake_case code into words", () => {
    expect(humanizeCode("invalid_grant")).toBe("invalid grant");
    expect(humanizeCode(null)).toBe("—");
  });
});
