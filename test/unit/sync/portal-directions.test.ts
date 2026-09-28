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

  it("counts a department by its name before its id, so a changed id cannot split it", () => {
    // One department whose id differed between sessions: its real directions
    // must survive, since only one place ever carried them.
    const own = "Tower A, suite 1.";
    const visits = [
      visit({
        csn: "1",
        department: "Clinic One",
        departmentId: "x1",
        practitioner: "Pat One",
        directions: `${own}\n\n${PAYMENT}`,
      }),
      visit({
        csn: "2",
        department: "Clinic One",
        departmentId: "x2",
        practitioner: "Pat One",
        directions: `${own}\n\n${PAYMENT}`,
      }),
      visit({ csn: "3", department: "Clinic Two", practitioner: "Sam Two", directions: PAYMENT }),
    ];
    const boilerplate = boilerplateOf(visits);

    expect(boilerplate.has(PAYMENT.toLowerCase())).toBe(true);
    expect(cleanDirections(visits[0]?.directions, boilerplate)).toBe(own);
  });
});

describe("line by line", () => {
  it("strips a boilerplate line that a single break separates from real text", () => {
    const visits = MANY.map((entry) => ({
      ...entry,
      directions: (entry.directions ?? "").replaceAll("\n\n", "\n"),
    }));
    const boilerplate = boilerplateOf(visits);

    expect(cleanDirections(visits[0]?.directions, boilerplate)).toBe("Tower A, suite 1.");
  });
});

describe("cleanDirections", () => {
  it("returns nothing when every paragraph was boilerplate", () => {
    const boilerplate = new Set([PAYMENT.toLowerCase()]);
    expect(cleanDirections(PAYMENT, boilerplate)).toBeUndefined();
    expect(cleanDirections(undefined, new Set())).toBeUndefined();
  });
});
