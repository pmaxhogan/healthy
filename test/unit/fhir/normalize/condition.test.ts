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
      healthSystem: "example-health_system",
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

describe("normalizeCondition codings and visit", () => {
  it("keeps every coding once, in order, under code, and reads the visit id", () => {
    const resource: fhir4.Condition = {
      resourceType: "Condition",
      id: "cond-3",
      subject: { reference: "Patient/pat-1" },
      code: {
        text: "Example finding",
        coding: [
          { system: "https://snomed.info/sct", code: "1000001" },
          { system: "https://hl7.org/fhir/sid/icd-10-cm", code: "X01.1" },
          { system: "https://snomed.info/sct", code: "1000001", display: "Again" },
        ],
      },
      encounter: { reference: "https://fhir.example.test/api/FHIR/R4/Encounter/enc-9" },
    };

    const result = normalizeCondition(resource, testCtx());

    expect(result.code?.codings).toStrictEqual([
      { system: "https://snomed.info/sct", code: "1000001" },
      { system: "https://hl7.org/fhir/sid/icd-10-cm", code: "X01.1" },
    ]);
    expect(result.encounterId).toBe("enc-9");
  });

  it("reads no visit id from a reference to anything but an Encounter", () => {
    const resource: fhir4.Condition = {
      resourceType: "Condition",
      id: "cond-4",
      subject: { reference: "Patient/pat-1" },
      code: { text: "Example finding" },
      encounter: { reference: "Observation/obs-1" },
    };

    const result = normalizeCondition(resource, testCtx());

    expect(Object.hasOwn(result, "encounterId")).toBe(false);
    expect(Object.hasOwn(result.code ?? {}, "codings")).toBe(false);
  });
});
