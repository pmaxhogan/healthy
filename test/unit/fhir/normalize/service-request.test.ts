import { describe, expect, it } from "vitest";

import { normalizeServiceRequest } from "../../../../worker/fhir/normalize/service-request.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeServiceRequest", () => {
  it("maps code, status, intent, occurrence, requester, and reasons", () => {
    const resource: fhir4.ServiceRequest = {
      resourceType: "ServiceRequest",
      id: "sr-1",
      status: "active",
      intent: "order",
      subject: { reference: "Patient/pat-1" },
      code: { text: "MRI Brain" },
      occurrenceDateTime: "2026-11-01",
      requester: { reference: "Practitioner/prac-1" },
      reasonCode: [{ text: "Headache" }],
    };

    const result = normalizeServiceRequest(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "ServiceRequest",
      id: "sr-1",
      code: "MRI Brain",
      status: "active",
      intent: "order",
      occurrence: "2026-11-01",
      requester: "Dr. Ada Example",
      reasons: ["Headache"],
    });
  });

  it("has an empty reasons array when there are none", () => {
    const resource: fhir4.ServiceRequest = {
      resourceType: "ServiceRequest",
      id: "sr-2",
      status: "draft",
      intent: "plan",
      subject: { reference: "Patient/pat-1" },
    };

    expect(normalizeServiceRequest(resource, testCtx()).reasons).toEqual([]);
  });
});
