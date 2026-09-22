import { describe, expect, it } from "vitest";

import { normalizeSpecimen } from "../../../../worker/fhir/normalize/specimen.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeSpecimen", () => {
  it("maps type, status, and collected date", () => {
    const resource: fhir4.Specimen = {
      resourceType: "Specimen",
      id: "spec-1",
      status: "available",
      type: { text: "Venous blood" },
      collection: { collectedDateTime: "2026-08-01T07:30:00Z" },
    };

    expect(normalizeSpecimen(resource, testCtx())).toMatchObject({
      resourceType: "Specimen",
      id: "spec-1",
      type: "Venous blood",
      status: "available",
      collected: "2026-08-01T07:30:00Z",
    });
  });

  it("omits collected when there is no collection detail", () => {
    const resource: fhir4.Specimen = { resourceType: "Specimen", id: "spec-2" };
    const result = normalizeSpecimen(resource, testCtx());
    expect(Object.hasOwn(result, "collected")).toBe(false);
  });
});
