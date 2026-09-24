// Field rules below the top level: nested objects, arrays of objects at any
// depth, FHIR choice types, and the scopes a rule can be limited to.
//
// Like `filter.test.ts`, the assertions that matter are made on the serialised
// string: "the value is not in the bytes that leave" is the property, and an
// object assertion can pass while the value survives somewhere nobody looked.
// Every resource below is synthetic.

import { describe, expect, it } from "vitest";

import { normalizeCareTeam } from "../../../worker/fhir/normalize/care-team.ts";
import { normalizeCondition } from "../../../worker/fhir/normalize/condition.ts";
import { normalizeEncounter } from "../../../worker/fhir/normalize/encounter.ts";
import { appointmentViewFromEncounter } from "../../../worker/fhir/normalize/index.ts";
import { normalizeObservation } from "../../../worker/fhir/normalize/observation.ts";
import { applyPolicy } from "../../../worker/policy/filter.ts";
import { buildRules } from "../../../worker/policy/rules.ts";
import { EXAMPLE_PRACTITIONER, testCtx } from "../fhir/normalize/fixtures.ts";

import type { ApplyPolicyResult, RawEntry } from "../../../worker/policy/filter.ts";
import type { PolicyRuleInput, PolicyRules } from "../../../worker/policy/rules.ts";
import type * as fhir4 from "fhir/r4";

const HS = "prov_a";
const tag = { healthSystem: "Example Health", healthSystemId: HS };

/** A 0012-shaped field rule. */
function hide(
  paths: string[],
  scope: { tool?: string; resourceType?: string; healthSystemId?: string } = {},
): PolicyRuleInput {
  return {
    rule_type: "field",
    target: JSON.stringify(paths),
    effect: "hide",
    scope_tool: scope.tool ?? null,
    scope_resource: scope.resourceType ?? null,
    scope_health_system: scope.healthSystemId ?? null,
    paths_json: JSON.stringify(paths),
  };
}

const rules = (...input: PolicyRuleInput[]): PolicyRules => buildRules(input);

function run(
  tool: string,
  items: unknown[],
  raw: fhir4.Resource[],
  policy: PolicyRules,
): { text: string; result: ApplyPolicyResult } {
  const rawItems: RawEntry[] = raw.map((resource) => ({ ...tag, resource }));
  const result = applyPolicy({ tool, items, rawItems, rules: policy });
  return {
    text: JSON.stringify({ items: result.items, raw: result.rawItems }),
    result,
  };
}

const careTeam: fhir4.CareTeam = {
  resourceType: "CareTeam",
  id: "ct-1",
  status: "active",
  participant: [
    { role: [{ text: "Primary care" }], member: { display: "Dr. Alpha Example" } },
    { role: [{ text: "Dietitian" }], member: { display: "Beta Example, RD" } },
  ],
};

const lab: fhir4.Observation = {
  resourceType: "Observation",
  id: "obs-1",
  status: "final",
  code: {
    coding: [{ system: "https://loinc.org", code: "55284-4", display: "Blood pressure panel" }],
  },
  component: [
    {
      code: { text: "Systolic" },
      valueQuantity: { value: 118, unit: "mm[Hg]" },
      referenceRange: [
        { low: { value: 90, unit: "mm[Hg]" }, high: { value: 120, unit: "mm[Hg]" } },
      ],
    },
    {
      code: { text: "Diastolic" },
      valueQuantity: { value: 74, unit: "mm[Hg]" },
      referenceRange: [{ low: { value: 61, unit: "mm[Hg]" }, high: { value: 80, unit: "mm[Hg]" } }],
    },
  ],
  referenceRange: [{ low: { value: 3.5 }, high: { value: 5.5 } }],
  valueString: "see components",
};

const condition: fhir4.Condition = {
  resourceType: "Condition",
  id: "cond-1",
  subject: { reference: "Patient/pat-1" },
  code: {
    coding: [{ system: "https://snomed.info/sct", code: "12345", display: "Synthetic Condition" }],
  },
};

const encounter: fhir4.Encounter = {
  resourceType: "Encounter",
  id: "enc-1",
  status: "finished",
  class: { code: "AMB" },
  type: [{ text: "Follow-up" }],
  period: { start: "2026-03-02T10:00:00Z" },
  participant: [
    {
      individual: { reference: "Practitioner/prac-1", display: "Dr. Ada Example" },
    },
  ],
};

describe("arrays of objects", () => {
  it("removes one key from every element and leaves its siblings", () => {
    const item = { ...normalizeCareTeam(careTeam, testCtx()), ...tag };
    const { text } = run("get_care_team", [item], [careTeam], rules(hide(["participants[].name"])));

    expect(text).not.toContain("Alpha Example");
    expect(text).not.toContain("Beta Example");
    // The role survives in both shapes: only the name was asked for.
    expect(text).toContain("Primary care");
    expect(text).toContain("Dietitian");
  });

  it("steps into an array without the brackets, because `participants.name` means the same", () => {
    const item = { ...normalizeCareTeam(careTeam, testCtx()), ...tag };
    const bracketed = run(
      "get_care_team",
      [item],
      [careTeam],
      rules(hide(["participants[].name"])),
    );
    const bare = run("get_care_team", [item], [careTeam], rules(hide(["participants.name"])));

    expect(bare.text).toBe(bracketed.text);
  });

  it("reaches an array inside an array element", () => {
    const { text } = run(
      "get_vitals",
      [],
      [lab],
      rules(hide(["component[].referenceRange[].low"], { resourceType: "Observation" })),
    );

    // Each component's own range loses its low bound; the high bound stays.
    expect(text).not.toContain('"value":90');
    expect(text).not.toContain('"value":61');
    expect(text).toContain('"value":120');
    expect(text).toContain('"value":80');
    // The top-level range is a different path, and is untouched.
    expect(text).toContain('"value":3.5');
  });

  it("walks an array of arrays", () => {
    const item = {
      resourceType: "X",
      ...tag,
      grid: [[{ a: 1, b: "keep" }], [{ a: 2, b: "keep" }]],
    };
    const { result } = run("t", [item], [], rules(hide(["grid[][].a"])));

    expect(result.items).toStrictEqual([
      { resourceType: "X", ...tag, grid: [[{ b: "keep" }], [{ b: "keep" }]] },
    ]);
  });

  it("empties an array when the path ends at the marker", () => {
    const item = { ...normalizeCareTeam(careTeam, testCtx()), ...tag };
    const { result } = run("get_care_team", [item], [], rules(hide(["participants[]"])));

    expect(result.items).toStrictEqual([expect.objectContaining({ participants: [] })]);
  });
});

describe("nested objects", () => {
  it("removes one key three levels down and leaves the rest of the object", () => {
    const view = {
      ...tag,
      resourceType: "Encounter",
      encounterId: "enc-1",
      location: {
        name: "Example Clinic",
        address: { lines: ["100 Example St", "Suite 4"], city: "Example City" },
      },
    };
    const { text } = run("get_appointments", [view], [], rules(hide(["location.address.lines"])));

    expect(text).not.toContain("100 Example St");
    expect(text).not.toContain("Suite 4");
    expect(text).toContain("Example City");
    expect(text).toContain("Example Clinic");
  });
});

describe("the raw FHIR vocabulary, and codings", () => {
  it("removes a coding's display from the raw resource and the normalized text made from it", () => {
    const item = { ...normalizeCondition(condition, testCtx()), ...tag };
    // Normalization rendered the display into `code.text`.
    expect(JSON.stringify(item)).toContain("Synthetic Condition");

    const { text } = run(
      "get_conditions",
      [item],
      [condition],
      rules(hide(["code.coding[].display"], { resourceType: "Condition" })),
    );

    expect(text).not.toContain("Synthetic Condition");
    // The code itself was not asked for, and stays in the raw resource.
    expect(text).toContain('"code":"12345"');
  });

  it("removes a normalized code's text from the raw codings too", () => {
    const item = { ...normalizeObservation(lab, testCtx()), ...tag };
    const { text } = run(
      "get_vitals",
      [item],
      [lab],
      rules(hide(["code"], { resourceType: "Observation" })),
    );

    expect(text).not.toContain("Blood pressure panel");
  });

  it("removes a normalized reference range when a raw rule removes part of it", () => {
    const item = { ...normalizeObservation(lab, testCtx()), ...tag };
    expect(item.referenceRange).toBe("3.5-5.5");

    const { result } = run(
      "get_lab_results",
      [item],
      [lab],
      rules(hide(["referenceRange[].low"], { resourceType: "Observation" })),
    );

    expect(JSON.stringify(result.items)).not.toContain("3.5-5.5");
  });
});

describe("FHIR choice types", () => {
  it("`value[x]` removes every variant of the raw value and the normalized value", () => {
    const item = { ...normalizeObservation(lab, testCtx()), ...tag };
    const { text } = run(
      "get_lab_results",
      [item],
      [lab],
      rules(hide(["value[x]"], { resourceType: "Observation" })),
    );

    expect(text).not.toContain("see components");
    expect(text).not.toContain("valueString");
    // Only the top-level value: the components keep theirs.
    expect(text).toContain("valueQuantity");
  });

  it("`component[].value[x]` removes each component's value in both shapes", () => {
    const item = { ...normalizeObservation(lab, testCtx()), ...tag };
    const { text } = run(
      "get_vitals",
      [item],
      [lab],
      rules(hide(["component[].value[x]"], { resourceType: "Observation" })),
    );

    expect(text).not.toContain('"value":118');
    expect(text).not.toContain('"value":74');
    expect(text).toContain("Systolic");
  });

  it("does not treat a plain key as a variant of itself or of a longer name", () => {
    const item = {
      resourceType: "X",
      ...tag,
      value: "kept",
      values: "kept too",
      valueCode: "gone",
    };
    const { result } = run("t", [item], [], rules(hide(["value[x]"])));

    expect(result.items).toStrictEqual([
      { resourceType: "X", ...tag, value: "kept", values: "kept too" },
    ]);
  });
});

describe("one rule, every shape of the same field", () => {
  it("a normalized clinician-name rule strips the raw display and the appointment view's copy", () => {
    const ctx = testCtx([EXAMPLE_PRACTITIONER]);
    const normalized = normalizeEncounter(encounter, ctx);
    const view = {
      ...appointmentViewFromEncounter(normalized, ctx),
      resourceType: "Encounter",
      ...tag,
    };
    const items = [{ ...normalized, ...tag }, view];
    const { text } = run(
      "get_encounters",
      items,
      [encounter, encounter],
      rules(hide(["practitioners[].name"], { resourceType: "Encounter" })),
    );

    expect(text).not.toContain("Ada");
    // The reference itself was not asked for.
    expect(text).toContain("Practitioner/prac-1");
  });
});

describe("scopes", () => {
  it("a tool-scoped rule leaves every other tool's answer alone", () => {
    const item = { ...normalizeCareTeam(careTeam, testCtx()), ...tag };
    const policy = rules(hide(["participants[].name"], { tool: "get_care_team" }));

    expect(run("get_care_team", [item], [], policy).text).not.toContain("Alpha Example");
    expect(run("get_health_summary", [item], [], policy).text).toContain("Alpha Example");
  });

  it("a health-system-scoped rule reaches only that health system's items, and never names it", () => {
    const fromA = { ...normalizeCareTeam(careTeam, testCtx()), ...tag };
    const fromB = { ...fromA, healthSystemId: "prov_b", id: "ct-2" };
    const { result } = run(
      "get_care_team",
      [fromA, fromB],
      [],
      rules(hide(["participants[].name"], { healthSystemId: HS })),
    );

    expect(JSON.stringify(result.items[0])).not.toContain("Alpha Example");
    expect(JSON.stringify(result.items[1])).toContain("Alpha Example");
    expect(result.warnings).toStrictEqual(["policy_field_removed:*.participants[].name"]);
    expect(result.warnings.join(" ")).not.toContain(HS);
  });

  it("a resource-type-scoped rule leaves the same key on another type alone", () => {
    const team = { ...normalizeCareTeam(careTeam, testCtx()), ...tag };
    const other = { resourceType: "Goal", ...tag, id: "g", participants: [{ name: "Kept Name" }] };
    const { text, result } = run(
      "t",
      [team, other],
      [],
      rules(hide(["participants[].name"], { resourceType: "CareTeam" })),
    );

    expect(text).not.toContain("Alpha Example");
    expect(text).toContain("Kept Name");
    expect(result.warnings).toStrictEqual(["policy_field_removed:CareTeam.participants[].name"]);
  });
});
