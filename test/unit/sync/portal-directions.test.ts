// The health system's boilerplate is stripped from directions only when the
// evidence says it is boilerplate. Everything here is invented.

import { describe, expect, it } from "vitest";

import { boilerplateOf, cleanDirections } from "../../../worker/sync/portal-directions.ts";

import type { PortalVisit } from "../../../worker/ehr/mychart/visits.ts";

const CHECK_IN = "Check in online before you arrive.";
const PAYMENT = "Payment is due at the visit.";

function visit(overrides: Partial<PortalVisit> & { csn: string }): PortalVisit {
  return {
    start: "2026-10-01T15:00:00+00:00",
    timeZone: "UTC",
    visitType: "Office Visit",
    isVideo: false,
    status: "scheduled",
    ...overrides,
  };
}

const MANY = [
  visit({
    csn: "1",
    departmentId: "d1",
    practitionerId: "p1",
    directions: `${CHECK_IN}\n\nTower A, suite 1.\n\n${PAYMENT}`,
  }),
  // No check-in paragraph: this visit offers none. Still stripped elsewhere.
  visit({
    csn: "2",
    departmentId: "d2",
    practitionerId: "p2",
    directions: `Tower B.\n\n${PAYMENT}`,
  }),
  visit({
    csn: "3",
    departmentId: "d2",
    practitionerId: "p2",
    directions: `${CHECK_IN}\n\nTower B.\n\n${PAYMENT}`,
  }),
];

describe("boilerplateOf", () => {
  it("finds the paragraphs two departments share, whatever their spacing or case", () => {
    const visits = [
      ...MANY,
      visit({
        csn: "4",
        departmentId: "d3",
        practitionerId: "p3",
        directions: "PAYMENT  is due at the visit.",
      }),
    ];
    const boilerplate = boilerplateOf(visits);

    expect(cleanDirections(visits[0]?.directions, boilerplate)).toBe("Tower A, suite 1.");
    // Repeated, but only ever under one department: kept.
    expect(cleanDirections(visits[2]?.directions, boilerplate)).toBe("Tower B.");
  });

  it("strips nothing with fewer than three visits", () => {
    expect(boilerplateOf(MANY.slice(0, 2)).size).toBe(0);
  });

  it("strips nothing with one practitioner, or one department", () => {
    const onePractitioner = MANY.map((entry) => ({ ...entry, practitionerId: "p1" }));
    const oneDepartment = MANY.map((entry) => ({ ...entry, departmentId: "d1" }));

    expect(boilerplateOf(onePractitioner).size).toBe(0);
    expect(boilerplateOf(oneDepartment).size).toBe(0);
  });

  it("counts places by name when the portal gave no id", () => {
    const named = MANY.map(({ departmentId: _id, ...rest }, index) => ({
      ...rest,
      department: index === 0 ? "Clinic One" : "Clinic Two",
    }));

    expect(boilerplateOf(named).has(PAYMENT.toLowerCase())).toBe(true);
  });
});

describe("cleanDirections", () => {
  it("returns nothing when every paragraph was boilerplate", () => {
    const boilerplate = new Set([PAYMENT.toLowerCase()]);
    expect(cleanDirections(PAYMENT, boilerplate)).toBeUndefined();
    expect(cleanDirections(undefined, new Set())).toBeUndefined();
  });
});
