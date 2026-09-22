import { describe, expect, it } from "vitest";

import { normalizeAllergy } from "../../../../worker/fhir/normalize/allergy.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeAllergy", () => {
  it("maps substance, reactions, and criticality", () => {
    const resource: fhir4.AllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      id: "allergy-1",
      patient: { reference: "Patient/pat-1" },
      code: { text: "Penicillin" },
      clinicalStatus: { coding: [{ code: "active", display: "Active" }] },
      criticality: "high",
      onsetDateTime: "2015-06-01",
      reaction: [
        {
          manifestation: [{ text: "Hives" }, { text: "Shortness of breath" }],
          severity: "severe",
        },
      ],
    };

    const result = normalizeAllergy(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "AllergyIntolerance",
      id: "allergy-1",
      substance: "Penicillin",
      clinicalStatus: "Active",
      criticality: "high",
      onset: "2015-06-01",
    });
    expect(result.reactions).toEqual([
      { manifestation: ["Hives", "Shortness of breath"], severity: "severe" },
    ]);
  });

  it("has an empty reactions array and omits substance when there is nothing to report", () => {
    const resource: fhir4.AllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      id: "allergy-2",
      patient: { reference: "Patient/pat-1" },
    };

    const result = normalizeAllergy(resource, testCtx());

    expect(result.reactions).toEqual([]);
    expect(Object.hasOwn(result, "substance")).toBe(false);
  });
});
