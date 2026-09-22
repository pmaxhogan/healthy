import { describe, expect, it } from "vitest";

import { normalizePractitioner } from "../../../../worker/fhir/normalize/practitioner.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizePractitioner", () => {
  it("maps name, gender, and qualifications", () => {
    const resource: fhir4.Practitioner = {
      resourceType: "Practitioner",
      id: "prac-9",
      name: [{ use: "official", prefix: ["Dr."], given: ["Ada"], family: "Example" }],
      gender: "female",
      qualification: [{ code: { text: "Family Medicine" } }, { code: { text: "MD" } }],
    };

    const result = normalizePractitioner(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "Practitioner",
      id: "prac-9",
      name: "Dr. Ada Example",
      gender: "female",
    });
    expect(result.qualifications).toEqual(["Family Medicine", "MD"]);
  });

  it("has an empty qualifications array and omits name when there is nothing to report", () => {
    const resource: fhir4.Practitioner = { resourceType: "Practitioner", id: "prac-10" };
    const result = normalizePractitioner(resource, testCtx());
    expect(Object.hasOwn(result, "name")).toBe(false);
    expect(result.qualifications).toEqual([]);
  });
});
