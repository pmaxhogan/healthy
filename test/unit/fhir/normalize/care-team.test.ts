import { describe, expect, it } from "vitest";

import { normalizeCareTeam } from "../../../../worker/fhir/normalize/care-team.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeCareTeam", () => {
  it("maps name, status, and participants with resolved names", () => {
    const resource: fhir4.CareTeam = {
      resourceType: "CareTeam",
      id: "ct-1",
      status: "active",
      name: "Primary care team",
      subject: { reference: "Patient/pat-1" },
      participant: [
        {
          member: { reference: "Practitioner/prac-1" },
          role: [{ text: "Primary care physician" }],
        },
      ],
    };

    const result = normalizeCareTeam(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "CareTeam",
      id: "ct-1",
      name: "Primary care team",
      status: "active",
    });
    expect(result.participants).toEqual([
      { name: "Dr. Ada Example", role: "Primary care physician" },
    ]);
  });

  it("has an empty participants array when there are none", () => {
    const resource: fhir4.CareTeam = { resourceType: "CareTeam", id: "ct-2" };
    expect(normalizeCareTeam(resource, testCtx()).participants).toEqual([]);
  });
});
