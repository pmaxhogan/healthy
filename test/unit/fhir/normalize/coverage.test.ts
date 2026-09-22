import { describe, expect, it } from "vitest";

import { normalizeCoverage } from "../../../../worker/fhir/normalize/coverage.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeCoverage", () => {
  it("keeps subscriberId but flags it as sensitive for the policy layer", () => {
    const resource: fhir4.Coverage = {
      resourceType: "Coverage",
      id: "cov-1",
      status: "active",
      beneficiary: { reference: "Patient/pat-1" },
      payor: [{ reference: "Organization/org-1" }],
      type: { text: "Medical" },
      subscriberId: "SUBSCRIBER-EXAMPLE-1",
    };

    const result = normalizeCoverage(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "Coverage",
      id: "cov-1",
      payor: ["Example Health System"],
      type: "Medical",
      subscriberId: "SUBSCRIBER-EXAMPLE-1",
      status: "active",
    });
    expect(result.sensitive).toEqual(["subscriberId"]);
  });

  it("still flags subscriberId as sensitive even when it is absent", () => {
    const resource: fhir4.Coverage = {
      resourceType: "Coverage",
      id: "cov-2",
      status: "active",
      beneficiary: { reference: "Patient/pat-1" },
      payor: [{ reference: "Organization/org-1" }],
    };

    const result = normalizeCoverage(resource, testCtx());

    expect(Object.hasOwn(result, "subscriberId")).toBe(false);
    expect(result.sensitive).toEqual(["subscriberId"]);
  });
});
