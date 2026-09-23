// The choke point.
//
// Nearly every assertion here is made against `JSON.stringify` of the result, not
// against the object. That is the point of the file: the property that matters is
// "the denied value does not appear in the bytes that leave this Worker", and an
// object assertion can pass while a value survives on a nested key nobody thought
// to look at.

import { describe, expect, it } from "vitest";

import { normalizeObservation } from "../../../worker/fhir/normalize/observation.ts";
import { applyPolicy } from "../../../worker/policy/filter.ts";
import { EMPTY_RULES, buildRules } from "../../../worker/policy/rules.ts";
import { testCtx } from "../fhir/normalize/fixtures.ts";

import type { ApplyPolicyInput, RawEntry } from "../../../worker/policy/filter.ts";
import type { PolicyRuleInput, PolicyRules } from "../../../worker/policy/rules.ts";
import type * as fhir4 from "fhir/r4";

const rules = (...input: PolicyRuleInput[]): PolicyRules => buildRules(input);

/** The serialised answer, which is what a client would actually receive. */
function serialise(input: ApplyPolicyInput): string {
  const result = applyPolicy(input);
  return JSON.stringify({ items: result.items, raw: result.rawItems, warnings: result.warnings });
}

const patient = {
  resourceType: "Patient",
  id: "p1",
  provider: "Example Health",
  providerId: "prov_a",
  name: "Test Person",
  birthDate: "1970-07-07",
  address: { city: "Testville", state: "TS" },
  sensitive: ["birthDate"],
};

const observation = {
  resourceType: "Observation",
  id: "o1",
  provider: "Example Health",
  providerId: "prov_a",
  code: "Blood pressure",
  category: ["vital-signs"],
  components: [
    { code: "Systolic", value: { value: 118, unit: "mm[Hg]" } },
    { code: "Diastolic", value: { value: 74, unit: "mm[Hg]" } },
  ],
};

const rawPatient: RawEntry = {
  provider: "Example Health",
  providerId: "prov_a",
  resource: {
    resourceType: "Patient",
    id: "p1",
    birthDate: "1970-07-07",
    telecom: [{ system: "phone", value: "555-0100" }],
  },
};

describe("tool rules", () => {
  it("denies the tool outright and returns nothing", () => {
    const result = applyPolicy({
      tool: "get_documents",
      items: [patient],
      rules: rules({ rule_type: "tool", target: "get_documents" }),
    });

    expect(result.denied).toBe(true);
    expect(result.items).toStrictEqual([]);
    expect(result.rawItems).toStrictEqual([]);
    expect(result.warnings).toStrictEqual(["policy_tool_denied:get_documents"]);
  });

  it("leaves a different tool alone", () => {
    const result = applyPolicy({
      tool: "get_patient_profile",
      items: [patient],
      rules: rules({ rule_type: "tool", target: "get_documents" }),
    });

    expect(result.denied).toBe(false);
    expect(result.items).toHaveLength(1);
  });
});

describe("resource rules", () => {
  it("removes every item of the type, from the items and from the raw projection", () => {
    const serialised = serialise({
      tool: "get_patient_profile",
      items: [patient, observation],
      rawItems: [rawPatient],
      rules: rules({ rule_type: "resource", target: "Patient" }),
    });

    expect(serialised).not.toContain("Test Person");
    expect(serialised).not.toContain("1970-07-07");
    expect(serialised).not.toContain("555-0100");
    // The Observation is untouched.
    expect(serialised).toContain("Blood pressure");
    expect(serialised).toContain("policy_resource_denied:Patient");
  });
});

describe("provider rules", () => {
  it("removes items and raw resources from that provider, and does not name it", () => {
    const fromB = { ...observation, providerId: "prov_b", provider: "Other Health", id: "o2" };
    const serialised = serialise({
      tool: "get_vitals",
      items: [observation, fromB],
      rawItems: [
        {
          provider: "Other Health",
          providerId: "prov_b",
          resource: { resourceType: "Observation", id: "o2" },
        },
      ],
      rules: rules({ rule_type: "provider", target: "prov_b" }),
    });

    expect(serialised).not.toContain("prov_b");
    expect(serialised).not.toContain("Other Health");
    expect(serialised).toContain("prov_a");
    expect(serialised).toContain("policy_provider_denied");
  });
});

describe("field rules", () => {
  it("deep-deletes a nested field from the item and the raw resource", () => {
    const serialised = serialise({
      tool: "get_patient_profile",
      items: [patient],
      rawItems: [rawPatient],
      rules: rules({ rule_type: "field", target: "Patient.address.city" }),
    });

    expect(serialised).not.toContain("Testville");
    // The sibling survives: the rule names one field, not the object above it.
    expect(serialised).toContain('"state":"TS"');
    expect(serialised).toContain("policy_field_removed:Patient.address.city");
  });

  it("walks into every element of an array", () => {
    const serialised = serialise({
      tool: "get_vitals",
      items: [observation],
      rules: rules({ rule_type: "field", target: "Observation.components[].value" }),
    });

    expect(serialised).not.toContain("118");
    expect(serialised).not.toContain("74");
    expect(serialised).toContain("Systolic");
    expect(serialised).toContain("Diastolic");
  });

  it("empties an array when the path ends at the marker", () => {
    const result = applyPolicy({
      tool: "get_vitals",
      items: [observation],
      rules: rules({ rule_type: "field", target: "Observation.components[]" }),
    });

    expect(JSON.stringify(result.items)).toContain('"components":[]');
    expect(JSON.stringify(result.items)).not.toContain("Systolic");
  });

  it("applies a `*.field` wildcard to every resource type", () => {
    const serialised = serialise({
      tool: "get_health_summary",
      items: [
        { ...patient, lastUpdated: "2026-01-01T00:00:00Z" },
        { ...observation, lastUpdated: "2026-02-02T00:00:00Z" },
      ],
      rules: rules({ rule_type: "field", target: "*.lastUpdated" }),
    });

    expect(serialised).not.toContain("2026-01-01");
    expect(serialised).not.toContain("2026-02-02");
  });

  it("is inert when the path matches nothing, and says nothing either", () => {
    const result = applyPolicy({
      tool: "get_vitals",
      items: [observation],
      rules: rules({ rule_type: "field", target: "Observation.nonesuch.deeper" }),
    });

    expect(result.items).toStrictEqual([observation]);
    // No warning: a rule that removed nothing did not remove anything.
    expect(result.warnings).toStrictEqual([]);
  });

  it("does not mutate the item it was given", () => {
    const item = structuredClone(patient);
    applyPolicy({
      tool: "get_patient_profile",
      items: [item],
      rules: rules({ rule_type: "field", target: "Patient.address.city" }),
    });

    expect(item.address.city).toBe("Testville");
  });
});

describe("field rules across the normalized/raw vocabulary divide", () => {
  // Vuln 1 in .local/reviews/sec-entrypoints-egress.md: a `field` rule's path is
  // one flat string applied verbatim to both shapes, so a rule written in one
  // shape's vocabulary silently did nothing to the other. These fixtures are
  // built by the real `normalizeObservation`, not hand-typed, so a regression in
  // either the normalizer or the alias table would show up here.

  const rawBloodPressure: fhir4.Observation = {
    resourceType: "Observation",
    id: "obs-bp",
    status: "final",
    code: { text: "Blood Pressure" },
    component: [
      { code: { text: "Systolic" }, valueQuantity: { value: 120, unit: "mmHg" } },
      { code: { text: "Diastolic" }, valueQuantity: { value: 80, unit: "mmHg" } },
    ],
  };

  const rawTemperature: fhir4.Observation = {
    resourceType: "Observation",
    id: "obs-temp",
    status: "final",
    code: { text: "Body Temperature" },
    valueQuantity: { value: 98.6, unit: "degF" },
  };

  it("the documented example strips the value from both the normalized item and the raw resource", () => {
    const item = { ...normalizeObservation(rawBloodPressure, testCtx()), providerId: "prov_a" };
    const result = applyPolicy({
      tool: "get_vitals",
      items: [item],
      rawItems: [{ provider: "Example Health", providerId: "prov_a", resource: rawBloodPressure }],
      rules: rules({ rule_type: "field", target: "Observation.component[].valueQuantity.value" }),
    });

    const serialised = JSON.stringify({ items: result.items, raw: result.rawItems });
    expect(serialised).not.toContain("120");
    expect(serialised).not.toContain("80");
    // The rule names the value, not the component: the labels survive in both.
    expect(serialised).toContain("Systolic");
    expect(serialised).toContain("Diastolic");
    expect(result.warnings).toContain(
      "policy_field_removed:Observation.component[].valueQuantity.value",
    );
  });

  it("a rule written in the normalized vocabulary strips the raw value[x] behind it", () => {
    const item = { ...normalizeObservation(rawTemperature, testCtx()), providerId: "prov_a" };
    const result = applyPolicy({
      tool: "get_vitals",
      items: [item],
      rawItems: [{ provider: "Example Health", providerId: "prov_a", resource: rawTemperature }],
      rules: rules({ rule_type: "field", target: "Observation.value" }),
    });

    const serialised = JSON.stringify({ items: result.items, raw: result.rawItems });
    expect(serialised).not.toContain("98.6");
    expect(result.warnings).toContain("policy_field_removed:Observation.value");
  });

  it("a rule in either vocabulary is inert -- and silent -- against a shape with nothing to remove", () => {
    // No `component[]` on this Observation, so the raw-vocabulary rule has
    // nothing to strip there; it must not report a removal it did not make.
    const item = { ...normalizeObservation(rawTemperature, testCtx()), providerId: "prov_a" };
    const result = applyPolicy({
      tool: "get_vitals",
      items: [item],
      rules: rules({ rule_type: "field", target: "Observation.component[].valueQuantity.value" }),
    });

    expect(result.items).toStrictEqual([item]);
    expect(result.warnings).toStrictEqual([]);
  });
});

describe("field rules against the appointment view", () => {
  // `get_appointments` serves Encounters -- and the patient portal's upcoming
  // visits -- in a flat shape whose names differ from the normalized Encounter's
  // (`practitioner` for `practitioners`, `org` for `organization`). A rule written
  // in any of the three vocabularies has to reach it.
  const appointment = {
    resourceType: "Encounter",
    provider: "Example Health",
    providerId: "prov_a",
    source: "portal",
    status: "scheduled",
    start: "2026-07-01T09:00:00+00:00",
    practitioner: "P. Example, MD",
    org: "Example Org",
    csn: "csn-1",
    telehealth: false,
  };
  const encounterItem = {
    resourceType: "Encounter",
    id: "enc-1",
    provider: "Example Health",
    providerId: "prov_a",
    practitioners: [{ name: "Q. Example, DO" }],
  };

  for (const target of [
    "Encounter.practitioner",
    "Encounter.practitioners",
    "Encounter.participant",
  ]) {
    it(`strips the practitioner from both shapes for ${target}`, () => {
      const serialised = serialise({
        tool: "get_appointments",
        items: [appointment, encounterItem],
        rules: rules({ rule_type: "field", target }),
      });

      expect(serialised).not.toContain("P. Example, MD");
      expect(serialised).not.toContain("Q. Example, DO");
      expect(serialised).toContain("csn-1");
    });
  }

  it("strips the org for a rule on the normalized or raw organisation", () => {
    for (const target of ["Encounter.organization", "Encounter.serviceProvider"]) {
      const serialised = serialise({
        tool: "get_appointments",
        items: [appointment],
        rules: rules({ rule_type: "field", target }),
      });
      expect(serialised, target).not.toContain("Example Org");
    }
  });

  it("strips the CSN for a rule on identifiers", () => {
    const serialised = serialise({
      tool: "get_appointments",
      items: [appointment],
      rules: rules({ rule_type: "field", target: "Encounter.identifiers" }),
    });

    expect(JSON.parse(serialised).items[0]).not.toHaveProperty("csn");
  });
});

describe("the sensitive default", () => {
  it("withholds a declared sensitive field with no rule at all", () => {
    const serialised = serialise({
      tool: "get_patient_profile",
      items: [patient],
      rules: EMPTY_RULES,
    });

    expect(serialised).not.toContain("1970-07-07");
    expect(serialised).toContain('"withheld":["birthDate"]');
    expect(serialised).toContain("sensitive_withheld:Patient.birthDate");
    // The marker itself never reaches the wire.
    expect(serialised).not.toContain('"sensitive"');
  });

  it("withholds it from the raw resource too, so `raw: true` is not a way round", () => {
    const serialised = serialise({
      tool: "get_patient_profile",
      items: [patient],
      rawItems: [rawPatient],
      rules: EMPTY_RULES,
    });

    expect(serialised).not.toContain("1970-07-07");
  });

  it("puts it back when the owner added an `allow:` rule", () => {
    const serialised = serialise({
      tool: "get_patient_profile",
      items: [patient],
      rawItems: [rawPatient],
      rules: rules({ rule_type: "field", target: "allow:Patient.birthDate" }),
    });

    expect(serialised).toContain("1970-07-07");
    expect(serialised).not.toContain("withheld");
  });

  it("an `allow:` rule does not widen anything else", () => {
    // Coverage's subscriberId is still withheld: the allow named Patient only.
    const coverage = {
      resourceType: "Coverage",
      id: "c1",
      provider: "Example Health",
      providerId: "prov_a",
      payor: ["Example Insurer"],
      status: "active",
      subscriberId: "SUB-12345",
      sensitive: ["subscriberId"],
    };
    const serialised = serialise({
      tool: "get_coverage",
      items: [coverage],
      rules: rules({ rule_type: "field", target: "allow:Patient.birthDate" }),
    });

    expect(serialised).not.toContain("SUB-12345");
  });

  it("leaves an item with no sensitive marker exactly as it was", () => {
    const result = applyPolicy({ tool: "get_vitals", items: [observation], rules: EMPTY_RULES });

    expect(result.items[0]).toStrictEqual(observation);
  });
});

describe("things that are not items", () => {
  it("drops a value it cannot filter rather than passing it through", () => {
    // No tool produces one, and that is the point: the choke point's contract is
    // that nothing leaves unfiltered, so a value with no `resourceType` to judge,
    // no `providerId` to check and no `sensitive` list to honour is dropped.
    const result = applyPolicy({
      tool: "get_conditions",
      items: ["a bare string", 42, null, patient],
      rules: EMPTY_RULES,
    });

    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result.items)).not.toContain("a bare string");
    expect(result.warnings).toContain("policy_unfilterable_item_dropped");
  });
});

describe("combinations", () => {
  it("applies a field rule and the sensitive default together", () => {
    const serialised = serialise({
      tool: "get_patient_profile",
      items: [patient],
      rules: rules(
        { rule_type: "field", target: "Patient.address.city" },
        { rule_type: "field", target: "Patient.name" },
      ),
    });

    expect(serialised).not.toContain("Testville");
    expect(serialised).not.toContain("Test Person");
    expect(serialised).not.toContain("1970-07-07");
    expect(serialised).toContain('"state":"TS"');
  });

  it("keeps items and raw entries aligned when a rule drops one", () => {
    const result = applyPolicy({
      tool: "get_health_summary",
      items: [patient, observation],
      rawItems: [
        rawPatient,
        {
          provider: "Example Health",
          providerId: "prov_a",
          resource: { resourceType: "Observation", id: "o1" },
        },
      ],
      rules: rules({ rule_type: "resource", target: "Patient" }),
    });

    expect(result.items).toHaveLength(1);
    expect(result.rawItems).toHaveLength(1);
    expect((result.items[0] as { resourceType: string }).resourceType).toBe("Observation");
    expect((result.rawItems[0]?.resource as { resourceType: string }).resourceType).toBe(
      "Observation",
    );
  });
});
