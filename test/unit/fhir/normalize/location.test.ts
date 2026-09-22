import { describe, expect, it } from "vitest";

import { normalizeLocation } from "../../../../worker/fhir/normalize/location.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeLocation", () => {
  it("maps name, address, phone, and status", () => {
    const resource: fhir4.Location = {
      resourceType: "Location",
      id: "loc-9",
      name: "Example Clinic",
      status: "active",
      address: { line: ["100 Example St"], city: "Example City", state: "EX", postalCode: "00000" },
      telecom: [{ system: "phone", value: "555-010-0199", use: "work" }],
    };

    const result = normalizeLocation(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "Location",
      id: "loc-9",
      name: "Example Clinic",
      status: "active",
      phone: "555-010-0199",
    });
    expect(result.address).toEqual({
      lines: ["100 Example St"],
      city: "Example City",
      state: "EX",
      postalCode: "00000",
    });
  });

  it("omits address and phone when there is nothing to report", () => {
    const resource: fhir4.Location = { resourceType: "Location", id: "loc-10" };
    const result = normalizeLocation(resource, testCtx());
    expect(Object.hasOwn(result, "address")).toBe(false);
    expect(Object.hasOwn(result, "phone")).toBe(false);
  });
});
