// One visit seen by several organisations: what counts as the same visit, and
// which sighting speaks for it. Every name below is invented.

import { describe, expect, it } from "vitest";

import { isExternalVisit } from "../../../worker/ehr/mychart/external.ts";
import { parseUpcoming } from "../../../worker/ehr/mychart/visits.ts";
import {
  RANK_FHIR,
  STALE_SECONDS,
  matchAcrossHealthSystems,
  normalizeLabel,
  outranks,
  portalRank,
  sameVisitAcrossHealthSystems,
  sameVisitWithinHealthSystem,
} from "../../../worker/sync/portal-dedupe.ts";

import type { Sighting } from "../../../worker/sync/portal-dedupe.ts";

const START = 1_790_000_000;
const NOW = START - 86_400;

function row(csn: string, external: boolean): Record<string, unknown> {
  return {
    Csn: csn,
    Instant: `/Date(${String(START * 1000)})/`,
    VisitTypeName: "Office Visit",
    ...(external && { IsExternal: true }),
  };
}

function sighting(overrides: Partial<Sighting> = {}): Sighting {
  return {
    healthSystemId: "prov_a",
    start: START,
    practitioner: "A. Example, MD",
    department: "Example Cardiology",
    rank: 1,
    ...overrides,
  };
}

describe("normalizeLabel", () => {
  it("ignores case, punctuation, credentials and word order", () => {
    expect(normalizeLabel("Rivers, Ada MD")).toBe(normalizeLabel("Dr. Ada Rivers"));
    expect(normalizeLabel("EXAMPLE  Cardiology")).toBe(normalizeLabel("example-cardiology"));
  });

  it("is empty for nothing at all", () => {
    expect(normalizeLabel(undefined)).toBe("");
    expect(normalizeLabel(" , MD ")).toBe("");
  });
});

describe("matchAcrossHealthSystems", () => {
  // Security review L3: the calendar deletes only on an `identity` match.
  it("calls a shared CSN or practitioner an identity match", () => {
    const b = sighting({ healthSystemId: "prov_b", practitioner: "Dr A Example" });
    const csn = sighting({ healthSystemId: "prov_b", csn: "csn-1", practitioner: "Q. Other" });

    expect(matchAcrossHealthSystems(sighting(), b)).toBe("identity");
    expect(matchAcrossHealthSystems(sighting({ csn: "csn-1" }), csn)).toBe("identity");
  });

  it("calls a department or location shared with no practitioner to compare a place match", () => {
    const a = sighting({ practitioner: undefined });
    const b = sighting({ healthSystemId: "prov_b" });
    const byLocation = sighting({
      healthSystemId: "prov_b",
      department: undefined,
      location: "Example Tower",
    });

    expect(matchAcrossHealthSystems(a, b)).toBe("place");
    expect(
      matchAcrossHealthSystems(
        sighting({ practitioner: undefined, department: undefined, location: "Example Tower" }),
        byLocation,
      ),
    ).toBe("place");
  });

  it("calls two clinicians, or no shared label, no match", () => {
    expect(
      matchAcrossHealthSystems(
        sighting(),
        sighting({ healthSystemId: "prov_b", practitioner: "Q. Other" }),
      ),
    ).toBe("none");
    expect(
      matchAcrossHealthSystems(
        sighting({ practitioner: undefined, department: undefined }),
        sighting({ healthSystemId: "prov_b", practitioner: undefined, department: undefined }),
      ),
    ).toBe("none");
  });
});

describe("sameVisitWithinHealthSystem", () => {
  it("lets the CSN decide when both carry one, whatever the clock says", () => {
    expect(
      sameVisitWithinHealthSystem({ start: START, csn: "c1" }, { start: START + 3600, csn: "c1" }),
    ).toBe(true);
    expect(
      sameVisitWithinHealthSystem(
        { start: START, csn: "c1", practitioner: "Ada Rivers" },
        { start: START, csn: "c2", practitioner: "Ada Rivers" },
      ),
    ).toBe(false);
  });

  it("matches on the same practitioner within the window when a CSN is missing", () => {
    expect(
      sameVisitWithinHealthSystem(
        { start: START, csn: "c1", practitioner: "Rivers, Ada MD" },
        { start: START + 120, practitioner: "Dr Ada Rivers" },
      ),
    ).toBe(true);
    expect(
      sameVisitWithinHealthSystem(
        { start: START, practitioner: "Ada Rivers" },
        { start: START + 3600, practitioner: "Ada Rivers" },
      ),
    ).toBe(false);
  });

  it("never matches on a start time alone", () => {
    expect(sameVisitWithinHealthSystem({ start: START, csn: "c1" }, { start: START })).toBe(false);
    expect(
      sameVisitWithinHealthSystem(
        { start: START, practitioner: "Ada Rivers" },
        { start: START, practitioner: "Ben Stone" },
      ),
    ).toBe(false);
    expect(
      sameVisitWithinHealthSystem({ start: START, practitioner: "Ada Rivers" }, { start: START }),
    ).toBe(false);
  });
});

describe("sameVisitAcrossHealthSystems", () => {
  it("matches one visit listed by two health systems within the tolerance", () => {
    const b = sighting({
      healthSystemId: "prov_b",
      start: START + 120,
      practitioner: "Dr A Example",
    });

    expect(sameVisitAcrossHealthSystems(sighting(), b)).toBe(true);
  });

  it("never matches within one health system: that is the same-health system rule's job", () => {
    expect(sameVisitAcrossHealthSystems(sighting(), sighting())).toBe(false);
  });

  it("keeps two different visits at the same time apart", () => {
    const other = sighting({
      healthSystemId: "prov_b",
      practitioner: "Q. Other, DO",
      department: "Example Dermatology",
    });

    expect(sameVisitAcrossHealthSystems(sighting(), other)).toBe(false);
  });

  it("keeps two clinicians at one clinic at one time apart", () => {
    const other = sighting({ healthSystemId: "prov_b", practitioner: "Q. Other, DO" });

    expect(sameVisitAcrossHealthSystems(sighting(), other)).toBe(false);
  });

  it("matches on the department when neither names a practitioner", () => {
    const a = sighting({ practitioner: undefined });
    const b = sighting({ healthSystemId: "prov_b", practitioner: undefined });

    expect(sameVisitAcrossHealthSystems(a, b)).toBe(true);
  });

  it("does not match on time alone", () => {
    const a = sighting({ practitioner: undefined, department: undefined });
    const b = sighting({
      healthSystemId: "prov_b",
      practitioner: undefined,
      department: undefined,
    });

    expect(sameVisitAcrossHealthSystems(a, b)).toBe(false);
  });

  it("matches on a shared CSN, but never across more than the tolerance", () => {
    const a = sighting({ csn: "csn-1", practitioner: undefined, department: undefined });
    const near = { ...a, healthSystemId: "prov_b", start: START + 60 };
    const far = { ...a, healthSystemId: "prov_b", start: START + 3600 };

    expect(sameVisitAcrossHealthSystems(a, near)).toBe(true);
    expect(sameVisitAcrossHealthSystems(a, far)).toBe(false);
  });
});

describe("precedence", () => {
  it("puts FHIR over a portal copy, and a first-hand copy over a second-hand one", () => {
    const fhir = sighting({ healthSystemId: "prov_z", rank: RANK_FHIR });
    const firstHand = sighting({ healthSystemId: "prov_y", rank: portalRank(false, NOW, NOW) });
    const secondHand = sighting({ healthSystemId: "prov_a", rank: portalRank(true, NOW, NOW) });

    expect(outranks(fhir, firstHand)).toBe(true);
    expect(outranks(firstHand, secondHand)).toBe(true);
    expect(outranks(secondHand, firstHand)).toBe(false);
  });

  it("lets a fresh second-hand copy beat a stale first-hand one", () => {
    const stale = sighting({ rank: portalRank(false, NOW - STALE_SECONDS - 1, NOW) });
    const fresh = sighting({ healthSystemId: "prov_b", rank: portalRank(true, NOW, NOW) });

    expect(outranks(fresh, stale)).toBe(true);
  });

  it("breaks a tie the same way from either side", () => {
    const lower = sighting();
    const higher = sighting({ healthSystemId: "prov_b" });

    expect(outranks(lower, higher)).toBe(true);
    expect(outranks(higher, lower)).toBe(false);
  });
});

describe("the external flag on a visit", () => {
  it("reads a top-level flag or one on a nested organisation object", () => {
    expect(isExternalVisit(new Map([["IsExternal", true]]))).toBe(true);
    expect(isExternalVisit(new Map([["Organization", { IsExternal: "true" }]]))).toBe(true);
    expect(isExternalVisit(new Map([["Organization", { IsExternal: false }]]))).toBe(false);
    expect(isExternalVisit(new Map())).toBe(false);
  });

  it("marks only the visits that say so when a payload is parsed", () => {
    const { visits } = parseUpcoming(
      { NextNDaysVisits: [row("csn-own", false), row("csn-shared", true)] },
      "UTC",
    );

    expect(visits.find((visit) => visit.csn === "csn-own")).not.toHaveProperty("external");
    expect(visits.find((visit) => visit.csn === "csn-shared")?.external).toBe(true);
  });
});
