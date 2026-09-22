import { describe, expect, it } from "vitest";

import { normalizeCarePlan } from "../../../../worker/fhir/normalize/care-plan.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeCarePlan", () => {
  it("maps title, status, intent, category, period, and activities", () => {
    const resource: fhir4.CarePlan = {
      resourceType: "CarePlan",
      id: "cp-1",
      status: "active",
      intent: "plan",
      subject: { reference: "Patient/pat-1" },
      title: "Diabetes management",
      category: [{ text: "Chronic disease" }],
      period: { start: "2026-01-01" },
      activity: [{ detail: { code: { text: "Blood glucose monitoring" }, status: "in-progress" } }],
    };

    const result = normalizeCarePlan(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "CarePlan",
      id: "cp-1",
      title: "Diabetes management",
      status: "active",
      intent: "plan",
      category: ["Chronic disease"],
      period: { start: "2026-01-01" },
      activities: ["Blood glucose monitoring"],
    });
  });

  it("omits title and period when absent", () => {
    const resource: fhir4.CarePlan = {
      resourceType: "CarePlan",
      id: "cp-2",
      status: "draft",
      intent: "proposal",
      subject: { reference: "Patient/pat-1" },
    };

    const result = normalizeCarePlan(resource, testCtx());

    expect(Object.hasOwn(result, "title")).toBe(false);
    expect(Object.hasOwn(result, "period")).toBe(false);
    expect(result.activities).toEqual([]);
  });
});
