import { describe, expect, it } from "vitest";

import { normalizeGoal } from "../../../../worker/fhir/normalize/goal.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeGoal", () => {
  it("maps description, lifecycle/achievement status, and targets", () => {
    const resource: fhir4.Goal = {
      resourceType: "Goal",
      id: "goal-1",
      lifecycleStatus: "active",
      achievementStatus: { coding: [{ code: "in-progress", display: "In Progress" }] },
      description: { text: "Lower A1c to below 7%" },
      subject: { reference: "Patient/pat-1" },
      startDate: "2026-01-01",
      target: [{ measure: { text: "Hemoglobin A1c" } }],
    };

    const result = normalizeGoal(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "Goal",
      id: "goal-1",
      description: "Lower A1c to below 7%",
      lifecycleStatus: "active",
      achievementStatus: "In Progress",
      startDate: "2026-01-01",
      targets: ["Hemoglobin A1c"],
    });
  });

  it("has an empty targets array when there are none", () => {
    const resource: fhir4.Goal = {
      resourceType: "Goal",
      id: "goal-2",
      lifecycleStatus: "proposed",
      description: { text: "Placeholder" },
      subject: { reference: "Patient/pat-1" },
    };

    expect(normalizeGoal(resource, testCtx()).targets).toEqual([]);
  });
});
