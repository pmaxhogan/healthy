import { describe, expect, it } from "vitest";

import { normalizeDiagnosticReport } from "../../../../worker/fhir/normalize/diagnostic-report.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeDiagnosticReport", () => {
  it("maps code, category, conclusion, and reference lists", () => {
    const resource: fhir4.DiagnosticReport = {
      resourceType: "DiagnosticReport",
      id: "dr-1",
      status: "final",
      category: [{ text: "Laboratory" }],
      code: { text: "Basic Metabolic Panel" },
      effectiveDateTime: "2026-08-01T08:00:00Z",
      issued: "2026-08-01T09:00:00Z",
      conclusion: "Within normal limits.",
      result: [{ reference: "Observation/obs-1" }, { reference: "Observation/obs-2" }],
      presentedForm: [{ url: "Binary/report-1", contentType: "application/pdf" }],
    };

    const result = normalizeDiagnosticReport(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "DiagnosticReport",
      id: "dr-1",
      code: "Basic Metabolic Panel",
      category: ["Laboratory"],
      effective: "2026-08-01T08:00:00Z",
      issued: "2026-08-01T09:00:00Z",
      status: "final",
      conclusion: "Within normal limits.",
      resultRefs: ["Observation/obs-1", "Observation/obs-2"],
      presentedFormRefs: ["Binary/report-1"],
    });
  });

  it("has empty arrays and omits conclusion when there is nothing to report", () => {
    const resource: fhir4.DiagnosticReport = {
      resourceType: "DiagnosticReport",
      id: "dr-2",
      status: "registered",
      code: { text: "Pending panel" },
    };

    const result = normalizeDiagnosticReport(resource, testCtx());

    expect(result.resultRefs).toEqual([]);
    expect(result.presentedFormRefs).toEqual([]);
    expect(Object.hasOwn(result, "conclusion")).toBe(false);
  });
});
