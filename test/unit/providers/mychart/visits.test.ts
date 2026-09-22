// The payload's status booleans contradict each other, so the priority order is
// the whole correctness story here: get it wrong and a cancelled appointment
// stays on the calendar (or a live one is ghosted). Every conflicting pair in the
// documented order has a test.

import { describe, expect, it } from "vitest";

import {
  formatAddress,
  isVideoVisit,
  parsePast,
  parseUpcoming,
  parseWcfDate,
  statusOf,
} from "../../../../worker/providers/mychart/visits.ts";

import {
  CLINIC_ZONE,
  confirmedShapePayload,
  ORG_TOKEN,
  pastPayload,
  upcomingPayload,
  VISIT_INSTANT_MS,
} from "./fixtures.ts";

import type { AppError } from "../../../../worker/lib/errors.ts";
import type { PortalVisit } from "../../../../worker/providers/mychart/visits.ts";

const OWNER_ZONE = "UTC";

function fields(record: Record<string, unknown>): Map<string, unknown> {
  return new Map(Object.entries(record));
}

function byCsn(visits: readonly PortalVisit[], csn: string): PortalVisit {
  const found = visits.find((visit) => visit.csn === csn);
  if (found === undefined) throw new Error(`no visit ${csn}`);
  return found;
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as AppError).code;
  }
  throw new Error("expected a throw");
}

describe("parseWcfDate", () => {
  it("reads a plain /Date(ms)/ instant", () => {
    expect(parseWcfDate("/Date(1790000000000)/")).toBe(1_790_000_000);
  });

  it("ignores a trailing offset, because the number is already UTC", () => {
    expect(parseWcfDate("/Date(1790000000000-0600)/")).toBe(1_790_000_000);
    expect(parseWcfDate("/Date(1790000000000+0530)/")).toBe(1_790_000_000);
  });

  it("accepts a bare number of milliseconds", () => {
    expect(parseWcfDate(1_790_000_000_000)).toBe(1_790_000_000);
  });

  it("returns null for anything else", () => {
    for (const bad of ["", "2026-09-29", "/Date()/", "/Date(abc)/", null, undefined, {}]) {
      expect(parseWcfDate(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("statusOf", () => {
  it("defaults to scheduled when no flag is set", () => {
    expect(statusOf(fields({}))).toBe("scheduled");
    expect(statusOf(fields({ IsPastVisit: true }))).toBe("scheduled");
  });

  it("prefers canceled over everything below it", () => {
    const flags = {
      IsCanceled: true,
      IsNoShow: true,
      IsInProgress: true,
      IsArrived: true,
      IsCompleted: true,
      IsConfirmed: true,
    };
    expect(statusOf(fields(flags))).toBe("canceled");
  });

  it("accepts either spelling of cancelled", () => {
    expect(statusOf(fields({ IsCancelled: true }))).toBe("canceled");
  });

  it("walks the documented order for every adjacent conflicting pair", () => {
    const pairs: [Record<string, unknown>, string][] = [
      [{ IsNoShow: true, IsLeftWithoutBeingSeen: true }, "no_show"],
      [{ IsLeftWithoutBeingSeen: true, IsInProgress: true }, "left_without_being_seen"],
      [{ IsInProgress: true, IsArrived: true }, "in_progress"],
      [{ IsArrived: true, IsCompleted: true }, "arrived"],
      [{ IsCompleted: true, IsCancelRequested: true }, "completed"],
      [{ IsCancelRequested: true, IsConfirmed: true }, "cancel_requested"],
      [{ IsConfirmed: true }, "confirmed"],
    ];
    for (const [flags, expected] of pairs) {
      expect(statusOf(fields(flags)), JSON.stringify(flags)).toBe(expected);
    }
  });

  it('treats 1 and "true" as true, because the payload serialises booleans three ways', () => {
    expect(statusOf(fields({ IsCanceled: 1 }))).toBe("canceled");
    expect(statusOf(fields({ IsCanceled: "true" }))).toBe("canceled");
    expect(statusOf(fields({ IsCanceled: "false" }))).toBe("scheduled");
    expect(statusOf(fields({ IsCanceled: 0 }))).toBe("scheduled");
  });
});

describe("parseUpcoming", () => {
  it("reads all three buckets into one list", () => {
    const { visits, unparsed } = parseUpcoming(upcomingPayload(), OWNER_ZONE);

    expect(visits.map((visit) => visit.csn)).toStrictEqual([
      "csn-in-progress",
      "csn-soon",
      "csn-cancelled",
      "csn-later",
    ]);
    expect(unparsed).toBe(0);
  });

  it("renders the start in the clinic's own zone, with its offset", () => {
    const { visits } = parseUpcoming(upcomingPayload(), OWNER_ZONE);
    const visit = byCsn(visits, "csn-in-progress");

    // 1790000000000 ms is 2026-09-21T14:13:20Z; America/Denver is -06:00 then.
    expect(visit.start).toBe("2026-09-21T08:13:20-06:00");
    expect(visit.timeZone).toBe(CLINIC_ZONE);
  });

  it("derives the end from the duration, and omits it when there is none", () => {
    const { visits } = parseUpcoming(upcomingPayload(), OWNER_ZONE);

    expect(byCsn(visits, "csn-in-progress").end).toBe("2026-09-21T08:43:20-06:00");
    expect(byCsn(visits, "csn-soon").end).toBeUndefined();
  });

  it("falls back to the requested zone for a row that names none", () => {
    const { visits } = parseUpcoming(upcomingPayload(), OWNER_ZONE);

    expect(byCsn(visits, "csn-later").timeZone).toBe("UTC");
    expect(byCsn(visits, "csn-later").start).toBe("2026-10-21T14:13:20+00:00");
  });

  it("applies the status priority to the real payload's conflicting flags", () => {
    const { visits } = parseUpcoming(upcomingPayload(), OWNER_ZONE);

    expect(byCsn(visits, "csn-in-progress").status).toBe("in_progress");
    expect(byCsn(visits, "csn-soon").status).toBe("confirmed");
    expect(byCsn(visits, "csn-cancelled").status).toBe("canceled");
    expect(byCsn(visits, "csn-later").status).toBe("no_show");
  });

  it("reads a practitioner from a name or from a list", () => {
    const { visits } = parseUpcoming(upcomingPayload(), OWNER_ZONE);

    expect(byCsn(visits, "csn-in-progress").practitioner).toBe("A. Example, MD");
    expect(byCsn(visits, "csn-soon").practitioner).toBe("B. Example, DO");
  });

  it("carries the location fields through and flags a video visit", () => {
    const { visits } = parseUpcoming(upcomingPayload(), OWNER_ZONE);
    const video = byCsn(visits, "csn-soon");

    expect(video.isVideo).toBe(true);
    expect(video.locationName).toBe("Example Tower");
    expect(video.address).toBe("1 Example Way");
    expect(video.phone).toBe("555-0100");
    expect(byCsn(visits, "csn-in-progress").isVideo).toBe(false);
  });

  it("omits an optional field rather than setting it to undefined", () => {
    const { visits } = parseUpcoming(
      { NextNDaysVisits: [{ CSN: "c", Instant: `/Date(${String(VISIT_INSTANT_MS)})/` }] },
      OWNER_ZONE,
    );

    // A Set, not a sorted array: the assertion is about which keys exist, and
    // `exactOptionalPropertyTypes` means an absent one must be absent, not
    // present-and-undefined.
    expect(new Set(Object.keys(visits[0] ?? {}))).toStrictEqual(
      new Set(["csn", "isVideo", "start", "status", "timeZone", "visitType"]),
    );
  });

  it("counts a row with no CSN or no instant as unparsed", () => {
    const { visits, unparsed } = parseUpcoming(
      {
        NextNDaysVisits: [
          { CSN: "good", Instant: `/Date(${String(VISIT_INSTANT_MS)})/` },
          { Instant: `/Date(${String(VISIT_INSTANT_MS)})/` },
          { CSN: "no-instant" },
        ],
      },
      OWNER_ZONE,
    );

    expect(visits).toHaveLength(1);
    expect(unparsed).toBe(2);
  });

  it("is an empty list, not an error, when every bucket is empty", () => {
    const parsed = parseUpcoming(
      { InProgressVisits: [], NextNDaysVisits: [], LaterVisitsList: [] },
      OWNER_ZONE,
    );

    expect(parsed).toStrictEqual({ visits: [], unparsed: 0 });
  });

  it("fails rather than reporting an empty day when nothing in a full payload parses", () => {
    // What a renamed field looks like. Reporting "no appointments" here would
    // ghost every event the sync has already written.
    const renamed = { NextNDaysVisits: [{ Identifier: "x", When: "2026-09-21T14:13:20Z" }] };

    expect(codeOf(() => parseUpcoming(renamed, OWNER_ZONE))).toBe("portal_parse_failed");
  });

  it("fails when the body has none of the documented buckets", () => {
    expect(codeOf(() => parseUpcoming({ Visits: [] }, OWNER_ZONE))).toBe("portal_parse_failed");
  });

  it("fails when the body is not an object", () => {
    for (const bad of [null, 42, "text", []]) {
      expect(codeOf(() => parseUpcoming(bad, OWNER_ZONE))).toBe("portal_parse_failed");
    }
  });

  it("falls back to the requested zone when a row names a zone that does not exist", () => {
    const { visits } = parseUpcoming(
      {
        NextNDaysVisits: [
          {
            CSN: "c",
            Instant: `/Date(${String(VISIT_INSTANT_MS)})/`,
            TimeZone: "Nowhere/Invented",
          },
        ],
      },
      OWNER_ZONE,
    );

    expect(visits[0]?.start).toBe("2026-09-21T14:13:20+00:00");
  });
});

describe("the key names a live capture confirmed", () => {
  it("reads the corrected top-level names: Csn, VisitTypeName, PrimaryProviderName", () => {
    const { visits, unparsed } = parseUpcoming(confirmedShapePayload(), OWNER_ZONE);

    expect(unparsed).toBe(0);
    const visit = byCsn(visits, "csn-nested");
    expect(visit.visitType).toBe("Office Visit");
    expect(visit.practitioner).toBe("C. Example, NP");
  });

  it("reads the department, its phone and its structured address out of PrimaryDepartment", () => {
    const { visits } = parseUpcoming(confirmedShapePayload(), OWNER_ZONE);
    const visit = byCsn(visits, "csn-nested");

    expect(visit.department).toBe("Example Family Medicine");
    expect(visit.phone).toBe("555-0142");
    // Assembled from the parts, because the payload has no flat address string.
    expect(visit.address).toBe("42 Invented Road, Exampleville, ZZ 00000");
    // The department name is the best location name there is when none is flat.
    expect(visit.locationName).toBe("Example Family Medicine");
  });

  it("reads LeftWithoutSeen and IsCancelRequestSent, whose guessed names were wrong", () => {
    const { visits } = parseUpcoming(confirmedShapePayload(), OWNER_ZONE);

    expect(byCsn(visits, "csn-lwbs").status).toBe("left_without_being_seen");
    expect(byCsn(visits, "csn-cancel-sent").status).toBe("cancel_requested");
  });

  it("detects video from a Telemedicine object or a non-zero TelehealthMode", () => {
    const { visits } = parseUpcoming(confirmedShapePayload(), OWNER_ZONE);

    expect(byCsn(visits, "csn-nested").isVideo).toBe(true);
    expect(byCsn(visits, "csn-telehealth-mode").isVideo).toBe(true);
  });

  it("does not call a visit video just because the page could show telemedicine", () => {
    const { visits } = parseUpcoming(confirmedShapePayload(), OWNER_ZONE);

    expect(byCsn(visits, "csn-in-person").isVideo).toBe(false);
  });
});

describe("isVideoVisit", () => {
  it("is true for a present Telemedicine object and false for an absent one", () => {
    expect(isVideoVisit(fields({ Telemedicine: {} }))).toBe(true);
    expect(isVideoVisit(fields({ Telemedicine: null }))).toBe(false);
    expect(isVideoVisit(fields({}))).toBe(false);
  });

  it("is true above zero and false at zero for TelehealthMode", () => {
    expect(isVideoVisit(fields({ TelehealthMode: 1 }))).toBe(true);
    expect(isVideoVisit(fields({ TelehealthMode: "3" }))).toBe(true);
    expect(isVideoVisit(fields({ TelehealthMode: 0 }))).toBe(false);
    expect(isVideoVisit(fields({ TelehealthMode: -1 }))).toBe(false);
  });

  it("still honours the older boolean flags", () => {
    expect(isVideoVisit(fields({ IsVideoVisit: true }))).toBe(true);
  });

  it("ignores CanShowTelemedicine entirely", () => {
    expect(isVideoVisit(fields({ CanShowTelemedicine: true }))).toBe(false);
  });
});

describe("formatAddress", () => {
  it("passes a plain string straight through", () => {
    expect(formatAddress("1 Example Way")).toBe("1 Example Way");
  });

  it("joins an array of lines", () => {
    expect(formatAddress(["1 Example Way", "Suite 2"])).toBe("1 Example Way, Suite 2");
  });

  it("assembles whichever parts of an object are present", () => {
    expect(formatAddress({ City: "Exampleville" })).toBe("Exampleville");
    expect(formatAddress({ StreetAddress: "1 Example Way", Zip: "00000" })).toBe(
      "1 Example Way, 00000",
    );
  });

  it("prefers a nested DiscreteAddress over the display copy beside it", () => {
    const address = {
      Address: ["A pre-formatted display line"],
      DiscreteAddress: { StreetAddress: "1 Example Way", City: "Exampleville" },
    };

    // The structured copy wins: it is the one whose parts can be assembled
    // predictably, where the display copy's formatting varies by deployment.
    expect(formatAddress(address)).toBe("1 Example Way, Exampleville");
    // With no structured copy, the display line is used as-is.
    expect(formatAddress({ Address: address.Address })).toBe("A pre-formatted display line");
  });

  it("is undefined for something with no address in it at all", () => {
    for (const bad of [null, undefined, 42, {}, [], ""]) {
      expect(formatAddress(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("parsePast", () => {
  it("flattens every organisation bucket into one list", () => {
    const { visits, unparsed } = parsePast(pastPayload(), OWNER_ZONE);

    expect(visits.map((visit) => visit.csn)).toStrictEqual(["csn-past-one", "csn-past-two"]);
    expect(unparsed).toBe(0);
    expect(visits[0]?.department).toBe("Example Family Medicine");
  });

  it("is an empty list, not an error, when a bucket is empty", () => {
    expect(parsePast({ List: { [ORG_TOKEN]: { List: [] } } }, OWNER_ZONE)).toStrictEqual({
      visits: [],
      unparsed: 0,
    });
  });

  it("fails when the outer bucket is missing", () => {
    expect(codeOf(() => parsePast({ SerializedIndex: "x" }, OWNER_ZONE))).toBe(
      "portal_parse_failed",
    );
  });

  it("fails when no organisation bucket carries a list", () => {
    expect(codeOf(() => parsePast({ List: { [ORG_TOKEN]: { ListSize: 3 } } }, OWNER_ZONE))).toBe(
      "portal_parse_failed",
    );
  });

  it("fails rather than reporting no history when nothing in a full bucket parses", () => {
    const renamed = { List: { [ORG_TOKEN]: { List: [{ Identifier: "x" }] } } };

    expect(codeOf(() => parsePast(renamed, OWNER_ZONE))).toBe("portal_parse_failed");
  });

  it("fails when the body is not an object", () => {
    for (const bad of [null, 42, "text", []]) {
      expect(codeOf(() => parsePast(bad, OWNER_ZONE))).toBe("portal_parse_failed");
    }
  });
});
