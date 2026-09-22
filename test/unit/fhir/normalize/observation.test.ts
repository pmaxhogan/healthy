import { describe, expect, it } from "vitest";

import { normalizeObservation } from "../../../../worker/fhir/normalize/observation.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeObservation", () => {
  it("maps a simple vital-sign observation with a quantity value", () => {
    const resource: fhir4.Observation = {
      resourceType: "Observation",
      id: "obs-1",
      status: "final",
      category: [{ coding: [{ code: "vital-signs", display: "Vital Signs" }] }],
      code: { text: "Body Temperature" },
      valueQuantity: { value: 98.6, unit: "degF" },
      interpretation: [{ coding: [{ code: "N", display: "Normal" }] }],
      referenceRange: [{ text: "97-99 degF" }],
      effectiveDateTime: "2026-09-01T10:00:00Z",
      issued: "2026-09-01T10:05:00Z",
    };

    const result = normalizeObservation(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "Observation",
      id: "obs-1",
      code: "Body Temperature",
      category: ["Vital Signs"],
      value: { value: 98.6, unit: "degF" },
      interpretation: "Normal",
      referenceRange: "97-99 degF",
      effective: "2026-09-01T10:00:00Z",
      issued: "2026-09-01T10:05:00Z",
      status: "final",
    });
    expect(result.components).toEqual([]);
  });

  it("maps an Epic-shaped blood pressure panel into components", () => {
    const resource: fhir4.Observation = {
      resourceType: "Observation",
      id: "obs-bp",
      status: "final",
      code: { text: "Blood Pressure" },
      component: [
        {
          code: { text: "Systolic" },
          valueQuantity: { value: 120, unit: "mmHg" },
        },
        {
          code: { text: "Diastolic" },
          valueQuantity: { value: 80, unit: "mmHg" },
        },
      ],
    };

    const result = normalizeObservation(resource, testCtx());

    expect(result.components).toEqual([
      { code: "Systolic", value: { value: 120, unit: "mmHg" } },
      { code: "Diastolic", value: { value: 80, unit: "mmHg" } },
    ]);
    expect(Object.hasOwn(result, "value")).toBe(false);
  });

  it("builds a reference range from low/high quantities when .text is absent", () => {
    const resource: fhir4.Observation = {
      resourceType: "Observation",
      id: "obs-2",
      status: "final",
      code: { text: "Potassium" },
      referenceRange: [
        { low: { value: 3.5, unit: "mmol/L" }, high: { value: 5.1, unit: "mmol/L" } },
      ],
    };

    expect(normalizeObservation(resource, testCtx()).referenceRange).toBe("3.5-5.1 mmol/L");
  });

  it("falls back to a coded or string value when there is no quantity", () => {
    const coded: fhir4.Observation = {
      resourceType: "Observation",
      id: "obs-3",
      status: "final",
      code: { text: "COVID-19 result" },
      valueCodeableConcept: { text: "Negative" },
    };
    expect(normalizeObservation(coded, testCtx()).value).toEqual({ value: "Negative" });

    const stringValued: fhir4.Observation = {
      resourceType: "Observation",
      id: "obs-4",
      status: "final",
      code: { text: "Comment" },
      valueString: "Sample hemolyzed",
    };
    expect(normalizeObservation(stringValued, testCtx()).value).toEqual({
      value: "Sample hemolyzed",
    });
  });
});
