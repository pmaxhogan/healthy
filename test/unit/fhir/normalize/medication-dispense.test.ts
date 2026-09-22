import { describe, expect, it } from "vitest";

import { normalizeMedicationDispense } from "../../../../worker/fhir/normalize/medication-dispense.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeMedicationDispense", () => {
  it("maps quantity, days supply, and when handed over", () => {
    const resource: fhir4.MedicationDispense = {
      resourceType: "MedicationDispense",
      id: "md-1",
      status: "completed",
      medicationCodeableConcept: { text: "Lisinopril 10 MG Oral Tablet" },
      quantity: { value: 30, unit: "tablet" },
      daysSupply: { value: 30, unit: "day" },
      whenHandedOver: "2026-01-16",
      dosageInstruction: [{ text: "Take 1 tablet by mouth daily" }],
    };

    const result = normalizeMedicationDispense(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "MedicationDispense",
      id: "md-1",
      medication: "Lisinopril 10 MG Oral Tablet",
      status: "completed",
      quantity: { value: 30, unit: "tablet" },
      daysSupply: { value: 30, unit: "day" },
      whenHandedOver: "2026-01-16",
      dosageText: ["Take 1 tablet by mouth daily"],
    });
  });

  it("omits optional fields when absent", () => {
    const resource: fhir4.MedicationDispense = {
      resourceType: "MedicationDispense",
      id: "md-2",
      status: "in-progress",
    };

    const result = normalizeMedicationDispense(resource, testCtx());

    expect(Object.hasOwn(result, "medication")).toBe(false);
    expect(Object.hasOwn(result, "quantity")).toBe(false);
    expect(result.dosageText).toEqual([]);
  });
});
