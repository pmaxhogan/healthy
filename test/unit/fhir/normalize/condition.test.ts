import { describe, expect, it } from "vitest";

import { normalizeCondition } from "../../../../worker/fhir/normalize/condition.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeCondition", () => {
  it("maps a problem-list-item condition, Epic-shaped", () => {
    const resource: fhir4.Condition = {
      resourceType: "Condition",
      id: "cond-1",
      subject: { reference: "Patient/pat-1" },
      code: {
        text: "Essential hypertension",
        coding: [{ system: "https://snomed.info/sct", code: "59621000", display: "Hypertension" }],
      },
      category: [
        {
          coding: [
            {
              system: "https://terminology.hl7.org/CodeSystem/condition-category",
              code: "problem-list-item",
              display: "Problem List Item",
            },
          ],
        },
      ],
      clinicalStatus: { coding: [{ code: "active", display: "Active" }] },
      verificationStatus: { coding: [{ code: "confirmed", display: "Confirmed" }] },
      onsetDateTime: "2020-05-01",
      recordedDate: "2020-05-02",
    };

    const result = normalizeCondition(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "Condition",
      id: "cond-1",
      provider: "example-provider",
      code: {
        text: "Essential hypertension",
        system: "https://snomed.info/sct",
        code: "59621000",
      },
      category: ["Problem List Item"],
      clinicalStatus: "Active",
      verificationStatus: "Confirmed",
      onset: "2020-05-01",
      recorded: "2020-05-02",
    });
    expect(Object.hasOwn(result, "abatement")).toBe(false);
  });

  it("omits code entirely when there is nothing to report", () => {
    const resource: fhir4.Condition = {
      resourceType: "Condition",
      id: "cond-2",
      subject: { reference: "Patient/pat-1" },
    };

    const result = normalizeCondition(resource, testCtx());

    expect(Object.hasOwn(result, "code")).toBe(false);
    expect(result.category).toEqual([]);
  });
});
