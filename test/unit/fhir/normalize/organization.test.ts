import { describe, expect, it } from "vitest";

import { normalizeOrganization } from "../../../../worker/fhir/normalize/organization.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeOrganization", () => {
  it("maps name, type, address, and phone", () => {
    const resource: fhir4.Organization = {
      resourceType: "Organization",
      id: "org-9",
      name: "Example Health System",
      type: [{ text: "Healthcare Health system" }],
      address: [{ city: "Example City", state: "EX" }],
      telecom: [{ system: "phone", value: "555-010-0100", use: "work" }],
    };

    const result = normalizeOrganization(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "Organization",
      id: "org-9",
      name: "Example Health System",
      type: "Healthcare Health system",
      phone: "555-010-0100",
    });
    expect(result.address).toEqual({ city: "Example City", state: "EX" });
  });

  it("omits type/address/phone when there is nothing to report", () => {
    const resource: fhir4.Organization = { resourceType: "Organization", id: "org-10" };
    const result = normalizeOrganization(resource, testCtx());
    expect(Object.hasOwn(result, "type")).toBe(false);
    expect(Object.hasOwn(result, "address")).toBe(false);
    expect(Object.hasOwn(result, "phone")).toBe(false);
  });
});
