import { describe, expect, it } from "vitest";

import { normalizePatient } from "../../../../worker/fhir/normalize/patient.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizePatient", () => {
  it("keeps name/birthDate/gender/city+state, drops telecom and street lines", () => {
    const resource: fhir4.Patient = {
      resourceType: "Patient",
      id: "pat-2",
      name: [{ use: "official", family: "Example", given: ["Pat"] }],
      telecom: [{ system: "phone", value: "555-010-0111" }],
      birthDate: "1990-01-01",
      gender: "unknown",
      address: [
        { line: ["100 Example St"], city: "Example City", state: "EX", postalCode: "00000" },
      ],
    };

    const result = normalizePatient(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "Patient",
      id: "pat-2",
      name: "Pat Example",
      birthDate: "1990-01-01",
      gender: "unknown",
      address: { city: "Example City", state: "EX" },
    });
    expect(Object.hasOwn(result, "telecom")).toBe(false);
    expect(result.address).toEqual({ city: "Example City", state: "EX" });
    expect(result.sensitive).toEqual(["birthDate"]);
  });

  it("omits address when there is no city or state", () => {
    const resource: fhir4.Patient = { resourceType: "Patient", id: "pat-3" };
    const result = normalizePatient(resource, testCtx());
    expect(Object.hasOwn(result, "address")).toBe(false);
    expect(result.sensitive).toEqual(["birthDate"]);
  });
});
