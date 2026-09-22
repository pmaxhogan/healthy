import { describe, expect, it } from "vitest";

import {
  appointmentEncounterSearch,
  CALENDAR_ENCOUNTER_STATUSES,
  encounterStatusFilter,
  filterSupported,
  ON_DEMAND_READ_TYPES,
  SEARCH_REGISTRY,
  supportsInteraction,
  supportsSearchParam,
} from "../../../worker/fhir/search-registry.ts";
import { indexCapabilities } from "../../../worker/providers/epic/index.ts";
import { loadFixture } from "../providers/fixtures.ts";

import type {
  EncounterStatusFilter,
  PreparedSearch,
  RegistryEntry,
  RegistryMode,
} from "../../../worker/fhir/search-registry.ts";
import type { CapabilityStatement, Encounter } from "../../../worker/fhir/types.ts";

const index = indexCapabilities(loadFixture<CapabilityStatement>("metadata-small.json"));
const PATIENT = "synthetic-patient-1";

function entryFor(
  resourceType: string,
  registry: readonly RegistryEntry[] = SEARCH_REGISTRY,
): RegistryEntry {
  const entry = registry.find((candidate) => candidate.resourceType === resourceType);
  if (entry === undefined) throw new Error(`no registry entry for ${resourceType}`);
  return entry;
}

describe("SEARCH_REGISTRY", () => {
  it("covers every resource type the full refresh needs, once each", () => {
    const types = SEARCH_REGISTRY.map((entry) => entry.resourceType);

    expect(new Set(types).size).toBe(types.length);
    expect(types).toStrictEqual([
      "Patient",
      "Encounter",
      "Condition",
      "Observation",
      "MedicationRequest",
      "MedicationDispense",
      "AllergyIntolerance",
      "Immunization",
      "Procedure",
      "DiagnosticReport",
      "DocumentReference",
      "CarePlan",
      "CareTeam",
      "Goal",
      "Device",
      "Coverage",
      "ServiceRequest",
      "Specimen",
      "Practitioner",
      "PractitionerRole",
      "Location",
      "Organization",
      "Medication",
      "Binary",
    ]);
  });

  it("names an Epic Incoming API and a USCDI generation for every entry", () => {
    for (const entry of SEARCH_REGISTRY) {
      expect(entry.epicApiName, entry.resourceType).toContain(entry.resourceType);
      expect(["v1", "v3"], entry.resourceType).toContain(entry.uscdi);
    }
  });

  it("reads Patient and the reference types by id and searches nothing for them", () => {
    const modes = new Map<string, RegistryMode>(
      SEARCH_REGISTRY.map((entry) => [entry.resourceType, entry.mode]),
    );

    expect(modes.get("Patient")).toBe("read");
    expect(modes.get("Binary")).toBe("read");
    expect(modes.get("Encounter")).toBe("search");
    expect(entryFor("Patient").params(PATIENT)).toStrictEqual([]);
    expect(ON_DEMAND_READ_TYPES).toStrictEqual([
      "Practitioner",
      "PractitionerRole",
      "Location",
      "Organization",
      "Medication",
      "Binary",
    ]);
  });

  it("splits Condition, Observation, CarePlan and DocumentReference by category", () => {
    expect(
      entryFor("Condition")
        .params(PATIENT)
        .map((set) => set.category),
    ).toStrictEqual(["problem-list-item", "encounter-diagnosis", "health-concern"]);
    expect(
      entryFor("Observation")
        .params(PATIENT)
        .map((set) => set.category),
    ).toStrictEqual(["laboratory", "vital-signs", "social-history", "survey"]);
    expect(entryFor("CarePlan").params(PATIENT)).toHaveLength(2);
    expect(entryFor("DocumentReference").params(PATIENT)[0]?.category).toBe("clinical-note");
  });

  it("adds date=ge<since> only when a since is given", () => {
    expect(entryFor("Encounter").params(PATIENT, "2026-06-23")[0]).toStrictEqual({
      patient: PATIENT,
      _count: "100",
      date: "ge2026-06-23",
    });
    expect(entryFor("Encounter").params(PATIENT)[0]).toStrictEqual({
      patient: PATIENT,
      _count: "100",
    });
  });
});

describe("appointmentEncounterSearch", () => {
  it("is patient + date, with status deliberately left out", () => {
    const search: PreparedSearch = appointmentEncounterSearch(PATIENT, "2026-06-23");

    expect(search.resourceType).toBe("Encounter");
    expect(search.params).toStrictEqual({ patient: PATIENT, date: "ge2026-06-23", _count: "100" });
    expect(search.params).not.toHaveProperty("status");
  });
});

describe("capability lookups", () => {
  it("answers from the organisation's CapabilityStatement", () => {
    expect(supportsInteraction(index, "Encounter", "search-type")).toBe(true);
    expect(supportsInteraction(index, "Location", "search-type")).toBe(false);
    expect(supportsInteraction(index, "Condition", "read")).toBe(false);
    expect(supportsSearchParam(index, "Encounter", "date")).toBe(true);
    expect(supportsSearchParam(index, "Encounter", "status")).toBe(false);
    expect(supportsSearchParam(index, "Encounter", "_count")).toBe(true);
    expect(supportsSearchParam(index, "Nonexistent", "patient")).toBe(false);
  });
});

describe("filterSupported", () => {
  const filtered = filterSupported(SEARCH_REGISTRY, index);

  it("keeps only what this organisation actually exposes", () => {
    expect(filtered.map((entry) => entry.resourceType)).toStrictEqual([
      "Patient",
      "Encounter",
      "Observation",
      "Practitioner",
      "Location",
    ]);
  });

  it("drops a resource type whose required parameter the organisation lacks", () => {
    // Condition is in the registry with needsCapability "category" and is not in
    // metadata-small.json at all; Observation is, and keeps all four searches.
    expect(filtered.some((entry) => entry.resourceType === "Condition")).toBe(false);
    expect(entryFor("Observation", filtered).params(PATIENT)).toHaveLength(4);
  });

  it("keeps read-only entries that support read and drops ones that do not", () => {
    expect(entryFor("Location", filtered).mode).toBe("read");
    expect(filtered.some((entry) => entry.resourceType === "Binary")).toBe(false);
  });

  it("prunes parameters the organisation does not advertise", () => {
    const encounter = entryFor("Encounter", filtered);
    const observation = entryFor("Observation", filtered);

    expect(encounter.params(PATIENT, "2026-06-23")[0]).toStrictEqual({
      patient: PATIENT,
      date: "ge2026-06-23",
      _count: "100",
    });
    // `code` is advertised for Observation but this entry never sends it, and
    // `category` is advertised so it survives.
    expect(observation.params(PATIENT)[0]?.category).toBe("laboratory");
  });

  it("de-duplicates parameter sets that pruning collapsed together", () => {
    const custom: RegistryEntry[] = [
      {
        resourceType: "Practitioner",
        mode: "search",
        epicApiName: "Practitioner.Search",
        uscdi: "v1",
        // Two searches that differ only by a parameter this organisation does
        // not advertise, so pruning makes them identical.
        params: (patientId) => [
          { patient: patientId, category: "a" },
          { patient: patientId, category: "b" },
        ],
      },
    ];

    // Practitioner does not list `patient` in metadata-small.json, so nothing
    // survives at all -- which is itself the behaviour being asserted.
    expect(filterSupported(custom, index)).toStrictEqual([]);

    const withPatient = {
      fhirVersion: "4.0.1",
      resources: {
        Practitioner: { interactions: ["search-type"], searchParams: ["patient"] },
      },
    };

    expect(filterSupported(custom, withPatient)[0]?.params(PATIENT)).toStrictEqual([
      { patient: PATIENT },
    ]);
  });
});

describe("encounterStatusFilter", () => {
  const encounters = [
    { resourceType: "Encounter", id: "a", status: "planned" },
    { resourceType: "Encounter", id: "b", status: "cancelled" },
    { resourceType: "Encounter", id: "c", status: "entered-in-error" },
    { resourceType: "Encounter", id: "d", status: "unknown" },
  ] as unknown as Encounter[];

  it("filters client-side when status is not a native search parameter", () => {
    const filter: EncounterStatusFilter = encounterStatusFilter(index);

    expect(filter.params).toStrictEqual({});
    expect(filter.apply(encounters).map((encounter) => encounter.id)).toStrictEqual(["a", "b"]);
  });

  it("sends status natively when the organisation advertises it, and still filters", () => {
    const native = {
      fhirVersion: "4.0.1",
      resources: {
        Encounter: { interactions: ["search-type"], searchParams: ["patient", "date", "status"] },
      },
    };
    const filter = encounterStatusFilter(native);

    expect(filter.params).toStrictEqual({ status: CALENDAR_ENCOUNTER_STATUSES.join(",") });
    expect(filter.apply(encounters)).toHaveLength(2);
  });

  it("filters everything locally when no CapabilityStatement is available yet", () => {
    expect(encounterStatusFilter(null).params).toStrictEqual({});
    expect(encounterStatusFilter(null, ["planned"]).apply(encounters)).toHaveLength(1);
  });

  it("includes cancelled, because that is what ghosts a calendar event", () => {
    expect(CALENDAR_ENCOUNTER_STATUSES).toContain("cancelled");
    expect(CALENDAR_ENCOUNTER_STATUSES).not.toContain("entered-in-error");
  });
});
