// ModMed appointment rows -> the shared portal visit model.

import { describe, expect, it } from "vitest";

import {
  canonicalZone,
  parseAppointment,
  parseAppointmentDate,
  parseAppointments,
} from "../../../../worker/ehr/modmed/visits.ts";
import { noopLogger } from "../../../../worker/lib/log.ts";

import { appointmentRow } from "./fixtures.ts";

describe("parseAppointmentDate", () => {
  it.each([
    ["2027-03-10T15:30:00.000+0000", 1_804_692_600],
    ["2027-03-10T15:30:00.000+00:00", 1_804_692_600],
    ["2027-03-10T15:30:00Z", 1_804_692_600],
    ["2027-03-10T10:30:00.000-0500", 1_804_692_600],
  ])("reads %s as an instant", (value, seconds) => {
    expect(parseAppointmentDate(value)).toBe(seconds);
  });

  it.each([["2027-03-10T15:30:00"], ["10/03/2027"], [""], [null], [42]])(
    "refuses %s, which has no explicit offset",
    (value) => {
      expect(parseAppointmentDate(value)).toBeNull();
    },
  );
});

describe("parseAppointment", () => {
  it("maps a row into the clinic's own zone, keyed by the appointment id", () => {
    expect(parseAppointment(appointmentRow(), "Europe/Lisbon")).toEqual({
      csn: "90001",
      // 15:30 UTC in March, before US DST starts on the 14th: MST, -07:00.
      start: "2027-03-10T08:30:00-07:00",
      // The row says `US/Mountain`; the visit carries the canonical name.
      timeZone: "America/Denver",
      visitType: "Skin check",
      practitioner: "Pat Example, MD",
      department: "Example Clinic North",
      locationName: "Example Clinic North",
      address: "1 Example Plaza, Exampletown, ZZ 00000-0000",
      phone: "(555) 010-0000",
      isVideo: false,
      status: "scheduled",
      departmentId: "11",
      practitionerId: "501",
    });
  });

  it("prefers the facility's zone over the practice's, then the row's, then the fallback", () => {
    const row = appointmentRow();
    (row.facility as Record<string, unknown>).timeZone = undefined;
    expect(parseAppointment(row, "Europe/Lisbon")?.timeZone).toBe("America/Los_Angeles");
    row.timeZone = "Not/AZone";
    expect(parseAppointment(row, "Europe/Lisbon")?.timeZone).toBe("Europe/Lisbon");
  });

  it("passes a zone that is already canonical through untouched", () => {
    const row = appointmentRow();
    (row.facility as Record<string, unknown>).timeZone = "Europe/Lisbon";
    expect(parseAppointment(row, "UTC")?.timeZone).toBe("Europe/Lisbon");
  });

  it.each([
    ["US/Eastern", "America/New_York"],
    ["US/Central", "America/Chicago"],
    ["US/Mountain", "America/Denver"],
    ["US/Arizona", "America/Phoenix"],
    ["US/Pacific", "America/Los_Angeles"],
    ["US/Hawaii", "Pacific/Honolulu"],
  ])("normalises the legacy %s link to %s", (alias, canonical) => {
    expect(canonicalZone(alias)).toBe(canonical);
    // The canonical name and the link agree on the instant's local reading.
    const at = Date.UTC(2027, 6, 1, 12);
    const local = (zone: string) =>
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeStyle: "short" }).format(at);
    expect(local(canonical)).toBe(local(alias));
  });

  it("calls a checked-in appointment arrived", () => {
    const row = appointmentRow({ visit: { id: 5, visitType: "OFFICE_VISIT" } });
    expect(parseAppointment(row, "Europe/Lisbon")?.status).toBe("arrived");
  });

  it("falls back to the full street address when the parts are missing", () => {
    const row = appointmentRow();
    (row.facility as Record<string, unknown>).address = { fullStreetAddress: "1 Example Plaza" };
    expect(parseAppointment(row, "Europe/Lisbon")?.address).toBe("1 Example Plaza");
  });

  it("skips a row with no id or no instant, and counts it", () => {
    const visits = parseAppointments(
      [
        appointmentRow(),
        appointmentRow({ id: undefined }),
        appointmentRow({ appointmentDate: "soon" }),
        "junk",
      ],
      "Europe/Lisbon",
      noopLogger,
    );
    expect(visits.map((visit) => visit.csn)).toEqual(["90001"]);
  });
});
