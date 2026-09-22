import { describe, expect, it } from "vitest";

import { normalizeImmunization } from "../../../../worker/fhir/normalize/immunization.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeImmunization", () => {
  it("maps vaccine, occurrence, lot, site, route, and dose number", () => {
    const resource: fhir4.Immunization = {
      resourceType: "Immunization",
      id: "imm-1",
      status: "completed",
      vaccineCode: { text: "Influenza, seasonal, injectable" },
      patient: { reference: "Patient/pat-1" },
      occurrenceDateTime: "2026-10-01",
      lotNumber: "LOT-EXAMPLE-1",
      site: { text: "Left deltoid" },
      route: { text: "Intramuscular" },
      protocolApplied: [{ doseNumberPositiveInt: 1 }],
    };

    const result = normalizeImmunization(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "Immunization",
      id: "imm-1",
      vaccine: "Influenza, seasonal, injectable",
      occurrence: "2026-10-01",
      status: "completed",
      lot: "LOT-EXAMPLE-1",
      site: "Left deltoid",
      route: "Intramuscular",
      doseNumber: "1",
    });
  });

  it("reads a string dose number when no integer is given", () => {
    const resource: fhir4.Immunization = {
      resourceType: "Immunization",
      id: "imm-2",
      status: "completed",
      vaccineCode: { text: "Booster" },
      patient: { reference: "Patient/pat-1" },
      protocolApplied: [{ doseNumberString: "booster" }],
    };

    expect(normalizeImmunization(resource, testCtx()).doseNumber).toBe("booster");
  });
});
