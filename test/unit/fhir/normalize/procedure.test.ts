import { describe, expect, it } from "vitest";

import { normalizeProcedure } from "../../../../worker/fhir/normalize/procedure.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeProcedure", () => {
  it("maps code, performed period, performers, and reasons", () => {
    const resource: fhir4.Procedure = {
      resourceType: "Procedure",
      id: "proc-1",
      status: "completed",
      code: { text: "Colonoscopy" },
      subject: { reference: "Patient/pat-1" },
      performedPeriod: { start: "2026-05-01T09:00:00Z", end: "2026-05-01T09:45:00Z" },
      performer: [
        { actor: { reference: "Practitioner/prac-1" }, function: { text: "Primary surgeon" } },
      ],
      reasonCode: [{ text: "Colorectal cancer screening" }],
    };

    const result = normalizeProcedure(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "Procedure",
      id: "proc-1",
      code: "Colonoscopy",
      performed: "2026-05-01T09:00:00Z",
      status: "completed",
      reasons: ["Colorectal cancer screening"],
    });
    expect(result.performers).toEqual([{ name: "Dr. Ada Example", function: "Primary surgeon" }]);
  });

  it("has empty arrays and omits performed when there is nothing to report", () => {
    const resource: fhir4.Procedure = {
      resourceType: "Procedure",
      id: "proc-2",
      status: "in-progress",
      subject: { reference: "Patient/pat-1" },
    };

    const result = normalizeProcedure(resource, testCtx());

    expect(result.performers).toEqual([]);
    expect(result.reasons).toEqual([]);
    expect(Object.hasOwn(result, "performed")).toBe(false);
  });
});
