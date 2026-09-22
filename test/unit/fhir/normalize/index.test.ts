import { describe, expect, it } from "vitest";

import { normalizeEncounter } from "../../../../worker/fhir/normalize/encounter.ts";
import {
  NORMALIZED_TYPES,
  appointmentViewFromEncounter,
  normalizeResource,
} from "../../../../worker/fhir/normalize/index.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeResource", () => {
  it("dispatches Encounter to normalizeEncounter", () => {
    const encounter: fhir4.Encounter = {
      resourceType: "Encounter",
      id: "enc-9",
      status: "planned",
      class: { code: "AMB" },
    };
    const result = normalizeResource(encounter, testCtx());
    expect(result).toMatchObject({ resourceType: "Encounter", id: "enc-9", status: "planned" });
  });

  it("dispatches Patient to normalizePatient", () => {
    const patient: fhir4.Patient = {
      resourceType: "Patient",
      id: "pat-9",
      name: [{ text: "Pat Example" }],
    };
    const result = normalizeResource(patient, testCtx());
    expect(result).toMatchObject({ resourceType: "Patient", id: "pat-9", name: "Pat Example" });
  });

  it("falls back to a generic shape for an unrecognized resource type, keeping the narrative", () => {
    const resource = {
      resourceType: "ImagingStudy",
      id: "img-1",
      text: { status: "generated", div: "<div>Chest X-ray, two views.</div>" },
    } as unknown as fhir4.FhirResource;

    const result = normalizeResource(resource, testCtx());

    expect(result).toEqual({
      resourceType: "ImagingStudy",
      id: "img-1",
      provider: "example-provider",
      text: "<div>Chest X-ray, two views.</div>",
    });
  });

  it("falls back to a generic shape with no text when there is no narrative", () => {
    const resource = { resourceType: "Media", id: "media-1" } as unknown as fhir4.FhirResource;
    const result = normalizeResource(resource, testCtx());
    expect(result).toEqual({
      resourceType: "Media",
      id: "media-1",
      provider: "example-provider",
    });
  });
});

describe("NORMALIZED_TYPES", () => {
  it("lists every resource type with a dedicated normalizer", () => {
    expect(NORMALIZED_TYPES).toContain("Encounter");
    expect(NORMALIZED_TYPES).toContain("Patient");
    expect(NORMALIZED_TYPES).toContain("Coverage");
    expect(NORMALIZED_TYPES).toHaveLength(21);
  });
});

describe("appointmentViewFromEncounter", () => {
  it("picks the primary practitioner and their specialty", () => {
    const encounter: fhir4.Encounter = {
      resourceType: "Encounter",
      id: "enc-view-1",
      status: "planned",
      class: { code: "AMB" },
      type: [{ text: "Office Visit" }],
      period: { start: "2026-10-01T14:00:00Z" },
      participant: [
        {
          type: [{ coding: [{ code: "PPRF" }] }],
          individual: { reference: "Practitioner/prac-1" },
        },
      ],
      location: [{ location: { reference: "Location/loc-1" } }],
      serviceProvider: { reference: "Organization/org-1" },
      identifier: [{ type: { text: "CSN" }, value: "999" }],
    };
    const ctx = testCtx();
    const normalized = normalizeEncounter(encounter, ctx);

    const view = appointmentViewFromEncounter(normalized, ctx);

    expect(view).toMatchObject({
      provider: "example-provider",
      encounterId: "enc-view-1",
      status: "planned",
      start: "2026-10-01T14:00:00Z",
      visitType: "Office Visit",
      practitioner: "Dr. Ada Example",
      specialty: "Family Medicine",
      org: "Example Health System",
      telehealth: false,
      csn: "999",
    });
    expect(Object.hasOwn(view, "end")).toBe(false);
  });

  it("leaves end undefined rather than defaulting it, even when the encounter has none", () => {
    const encounter: fhir4.Encounter = {
      resourceType: "Encounter",
      id: "enc-view-2",
      status: "arrived",
      class: { code: "AMB" },
      period: { start: "2026-10-01T14:00:00Z" },
    };
    const ctx = testCtx();
    const view = appointmentViewFromEncounter(normalizeEncounter(encounter, ctx), ctx);

    expect(view.start).toBe("2026-10-01T14:00:00Z");
    expect(Object.hasOwn(view, "end")).toBe(false);
    expect(Object.hasOwn(view, "practitioner")).toBe(false);
  });
});
