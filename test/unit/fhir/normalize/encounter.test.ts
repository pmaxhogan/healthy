import { describe, expect, it } from "vitest";

import { normalizeEncounter } from "../../../../worker/fhir/normalize/encounter.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

function baseEncounter(overrides: Partial<fhir4.Encounter> = {}): fhir4.Encounter {
  return {
    resourceType: "Encounter",
    id: "enc-1",
    status: "planned",
    class: { code: "AMB", display: "ambulatory" },
    type: [{ text: "Office Visit" }],
    period: { start: "2026-10-01T14:00:00Z", end: "2026-10-01T14:30:00Z" },
    participant: [
      {
        type: [{ coding: [{ code: "ATND", display: "attender" }] }],
        individual: { reference: "Practitioner/prac-1" },
      },
    ],
    location: [{ location: { reference: "Location/loc-1" } }],
    serviceProvider: { reference: "Organization/org-1" },
    reasonCode: [{ text: "Annual physical" }],
    identifier: [{ type: { text: "CSN" }, value: "123456789" }],
    ...overrides,
  };
}

describe("normalizeEncounter", () => {
  it("maps the Epic-shaped fields: type[0].text, participant display, location, serviceProvider", () => {
    const result = normalizeEncounter(baseEncounter(), testCtx());

    expect(result).toMatchObject({
      resourceType: "Encounter",
      id: "enc-1",
      provider: "example-provider",
      status: "planned",
      class: "ambulatory",
      visitType: "Office Visit",
      start: "2026-10-01T14:00:00Z",
      end: "2026-10-01T14:30:00Z",
      organization: "Example Health System",
      reasons: ["Annual physical"],
      identifiers: { csn: "123456789" },
    });
    expect(result.practitioners).toEqual([
      { name: "Dr. Ada Example", specialty: "Family Medicine", role: "attender" },
    ]);
    expect(result.location).toEqual({
      name: "Example Clinic",
      address: {
        lines: ["100 Example St"],
        city: "Example City",
        state: "EX",
        postalCode: "00000",
      },
      phone: "555-010-0199",
    });
  });

  it("orders the primary/attending participant (PPRF/ATND) first", () => {
    const encounter = baseEncounter({
      participant: [
        {
          type: [{ coding: [{ code: "REF", display: "referrer" }] }],
          individual: { reference: "Practitioner/prac-2", display: "Dr. Other" },
        },
        {
          type: [{ coding: [{ code: "PPRF" }] }],
          individual: { reference: "Practitioner/prac-1" },
        },
      ],
    });

    const result = normalizeEncounter(encounter, testCtx());

    expect(result.practitioners[0]?.name).toBe("Dr. Ada Example");
    expect(result.practitioners[1]?.name).toBe("Dr. Other");
  });

  it("falls back to reference.display when the Practitioner is not in the pool", () => {
    const encounter = baseEncounter({
      participant: [
        {
          individual: { reference: "Practitioner/unknown", display: "Dr. Unresolved" },
        },
      ],
    });

    const result = normalizeEncounter(encounter, testCtx());

    expect(result.practitioners[0]).toEqual({ name: "Dr. Unresolved" });
  });

  it("derives department from a location entry whose physicalType says department", () => {
    const department: fhir4.Location = {
      resourceType: "Location",
      id: "loc-dept",
      name: "Family Medicine Department",
    };
    const encounter = baseEncounter({
      location: [
        { location: { reference: "Location/loc-1" } },
        {
          location: { reference: "Location/loc-dept" },
          physicalType: { text: "Department" },
        },
      ],
    });

    const result = normalizeEncounter(encounter, testCtx([department]));

    expect(result.department).toBe("Family Medicine Department");
  });

  it("falls back to the second location entry as department when none is explicitly typed", () => {
    const second: fhir4.Location = { resourceType: "Location", id: "loc-2", name: "Building B" };
    const encounter = baseEncounter({
      location: [
        { location: { reference: "Location/loc-1" } },
        { location: { reference: "Location/loc-2" } },
      ],
    });

    const result = normalizeEncounter(encounter, testCtx([second]));

    expect(result.department).toBe("Building B");
  });

  describe("telehealth detection", () => {
    it("is true when class code is VR", () => {
      const result = normalizeEncounter(
        baseEncounter({ class: { code: "VR", display: "virtual" } }),
        testCtx(),
      );
      expect(result.telehealth).toBe(true);
    });

    it("is true when the visit type text matches video/virtual/tele", () => {
      const result = normalizeEncounter(
        baseEncounter({ type: [{ text: "Video Visit" }] }),
        testCtx(),
      );
      expect(result.telehealth).toBe(true);
    });

    it("is true when the location name matches video/virtual/tele", () => {
      const videoLocation: fhir4.Location = {
        resourceType: "Location",
        id: "loc-1",
        name: "Telehealth Virtual Room",
      };
      const result = normalizeEncounter(baseEncounter(), testCtx([videoLocation]));
      expect(result.telehealth).toBe(true);
    });

    it("is false for a plain in-person ambulatory visit", () => {
      const result = normalizeEncounter(baseEncounter(), testCtx());
      expect(result.telehealth).toBe(false);
    });
  });

  it("omits optional fields entirely rather than setting them to undefined", () => {
    const minimal: fhir4.Encounter = {
      resourceType: "Encounter",
      id: "enc-min",
      status: "planned",
      class: { code: "AMB" },
    };
    const result = normalizeEncounter(minimal, testCtx());

    expect(Object.hasOwn(result, "visitType")).toBe(false);
    expect(Object.hasOwn(result, "start")).toBe(false);
    expect(Object.hasOwn(result, "end")).toBe(false);
    expect(Object.hasOwn(result, "location")).toBe(false);
    expect(Object.hasOwn(result, "organization")).toBe(false);
    expect(Object.hasOwn(result, "department")).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.practitioners).toEqual([]);
    expect(Object.values(result).includes(undefined)).toBe(false);
  });
});
