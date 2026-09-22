import { describe, expect, it } from "vitest";

import { normalizeMedicationRequest } from "../../../../worker/fhir/normalize/medication-request.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeMedicationRequest", () => {
  it("maps a coded medication with dosage text and requester", () => {
    const resource: fhir4.MedicationRequest = {
      resourceType: "MedicationRequest",
      id: "mr-1",
      status: "active",
      intent: "order",
      subject: { reference: "Patient/pat-1" },
      medicationCodeableConcept: { text: "Lisinopril 10 MG Oral Tablet" },
      authoredOn: "2026-01-15",
      dosageInstruction: [{ text: "Take 1 tablet by mouth daily" }],
      requester: { reference: "Practitioner/prac-1" },
      reasonCode: [{ text: "Hypertension" }],
    };

    const result = normalizeMedicationRequest(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "MedicationRequest",
      id: "mr-1",
      medication: "Lisinopril 10 MG Oral Tablet",
      status: "active",
      intent: "order",
      authoredOn: "2026-01-15",
      dosageText: ["Take 1 tablet by mouth daily"],
      requester: "Dr. Ada Example",
      reasons: ["Hypertension"],
    });
  });

  it("falls back to resolving medicationReference when there is no coded concept", () => {
    const resource: fhir4.MedicationRequest = {
      resourceType: "MedicationRequest",
      id: "mr-2",
      status: "active",
      intent: "order",
      subject: { reference: "Patient/pat-1" },
      medicationReference: { reference: "Medication/med-1", display: "Metformin 500 MG" },
    };

    expect(normalizeMedicationRequest(resource, testCtx()).medication).toBe("Metformin 500 MG");
  });
});
