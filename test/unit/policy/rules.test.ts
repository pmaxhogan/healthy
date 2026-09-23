// Parsing the deny-list. Every shape the admin UI can store, and every shape it
// should not: a rule that cannot be enforced must be reported as unparsed rather
// than dropped, because a rule the owner believes in and that does nothing is the
// worst outcome available.

import { describe, expect, it } from "vitest";

import {
  ALLOW_PREFIX,
  ARRAY_SEGMENT,
  EMPTY_RULES,
  buildRules,
  fieldRuleResolves,
  fieldRulesFor,
  isHealthSystemDenied,
  isSensitiveAllowed,
  isToolDenied,
  parseFieldTarget,
} from "../../../worker/policy/rules.ts";

import type { PolicyRuleInput } from "../../../worker/policy/rules.ts";

const rows = (...input: PolicyRuleInput[]): PolicyRuleInput[] => input;

describe("EMPTY_RULES", () => {
  it("denies nothing, which is the posture on a fresh database", () => {
    expect(isToolDenied(EMPTY_RULES, "get_allergies")).toBe(false);
    expect(isHealthSystemDenied(EMPTY_RULES, "prov_a")).toBe(false);
    expect(fieldRulesFor(EMPTY_RULES, "Patient")).toStrictEqual([]);
    expect(EMPTY_RULES.unparsed).toStrictEqual([]);
  });
});

describe("parseFieldTarget", () => {
  it("splits a dotted path below a resource type", () => {
    expect(parseFieldTarget("Patient.address.city")).toStrictEqual({
      resourceType: "Patient",
      path: ["address", "city"],
      target: "Patient.address.city",
    });
  });

  it("accepts a wildcard resource type", () => {
    expect(parseFieldTarget("*.lastUpdated")?.resourceType).toBe("*");
  });

  it("treats `a[].b` and `a.[].b` as the same path", () => {
    const suffixed = parseFieldTarget("Observation.components[].value");
    const explicit = parseFieldTarget("Observation.components.[].value");

    expect(suffixed?.path).toStrictEqual(["components", ARRAY_SEGMENT, "value"]);
    expect(explicit?.path).toStrictEqual(suffixed?.path);
  });

  it("handles an array of arrays", () => {
    expect(parseFieldTarget("X.a[][].b")?.path).toStrictEqual([
      "a",
      ARRAY_SEGMENT,
      ARRAY_SEGMENT,
      "b",
    ]);
  });

  it("rejects what cannot name a field", () => {
    // A bare resource type is a `resource` rule; an empty or marker-only path
    // would delete the whole item, which is not what a field rule may do.
    for (const target of ["", " ".repeat(3), "Patient", "Patient.", "Patient.[]", ".field"]) {
      expect(parseFieldTarget(target), target).toBeNull();
    }
  });
});

describe("buildRules", () => {
  it("sorts each rule kind into its own bucket", () => {
    const rules = buildRules(
      rows(
        { rule_type: "tool", target: "get_documents" },
        { rule_type: "resource", target: "Coverage" },
        { rule_type: "health_system", target: "prov_b" },
        { rule_type: "field", target: "Patient.address.city" },
      ),
    );

    expect(isToolDenied(rules, "get_documents")).toBe(true);
    expect(isToolDenied(rules, "get_allergies")).toBe(false);
    expect(rules.resources.has("Coverage")).toBe(true);
    expect(isHealthSystemDenied(rules, "prov_b")).toBe(true);
    expect(rules.fields).toHaveLength(1);
    expect(rules.unparsed).toStrictEqual([]);
  });

  it("trims surrounding whitespace on every target", () => {
    const rules = buildRules(rows({ rule_type: "tool", target: "  get_vitals \n" }));

    expect(isToolDenied(rules, "get_vitals")).toBe(true);
  });

  it("reads an `allow:` field rule as re-enabling a sensitive field", () => {
    const rules = buildRules(
      rows({ rule_type: "field", target: `${ALLOW_PREFIX}Patient.birthDate` }),
    );

    expect(isSensitiveAllowed(rules, "Patient", "birthDate")).toBe(true);
    expect(isSensitiveAllowed(rules, "Coverage", "birthDate")).toBe(false);
    // And it is not also a deny rule.
    expect(rules.fields).toStrictEqual([]);
  });

  it("supports a wildcard allow", () => {
    const rules = buildRules(rows({ rule_type: "field", target: `${ALLOW_PREFIX}*.birthDate` }));

    expect(isSensitiveAllowed(rules, "Patient", "birthDate")).toBe(true);
  });

  it("reports targets it could not parse instead of ignoring them", () => {
    const rules = buildRules(
      rows(
        { rule_type: "field", target: "Patient" },
        { rule_type: "field", target: `${ALLOW_PREFIX}Patient.address.city` },
        { rule_type: "tool", target: "  " },
      ),
    );

    expect(rules.unparsed).toStrictEqual(["Patient", `${ALLOW_PREFIX}Patient.address.city`, "  "]);
    expect(rules.fields).toStrictEqual([]);
    expect(rules.allowedSensitive.size).toBe(0);
  });
});

describe("fieldRuleResolves", () => {
  it("accepts a path that only exists in the normalized vocabulary", () => {
    expect(fieldRuleResolves(parseFieldTarget("Patient.address.city")!)).toBe(true);
  });

  it("accepts a path that only exists in the raw vocabulary", () => {
    // Patient.telecom has no normalized counterpart (dropped, never projected)
    // -- it must still resolve, since the raw resource really has it.
    expect(fieldRuleResolves(parseFieldTarget("Patient.telecom")!)).toBe(true);
  });

  it("accepts a raw-vocabulary path via its alias into the normalized shape", () => {
    expect(
      fieldRuleResolves(parseFieldTarget("Observation.component[].valueQuantity.value")!),
    ).toBe(true);
  });

  it("accepts a normalized-vocabulary path via its alias into the raw shape", () => {
    expect(fieldRuleResolves(parseFieldTarget("Observation.value")!)).toBe(true);
  });

  it("rejects a path that names nothing in either vocabulary", () => {
    expect(fieldRuleResolves(parseFieldTarget("Observation.nonesuch.deeper")!)).toBe(false);
  });

  it("accepts a wildcard that resolves for at least one resource type", () => {
    // lastUpdated -> meta.lastUpdated is common to every type.
    expect(fieldRuleResolves(parseFieldTarget("*.lastUpdated")!)).toBe(true);
  });

  it("rejects a wildcard that resolves for no resource type", () => {
    expect(fieldRuleResolves(parseFieldTarget("*.nonesuch")!)).toBe(false);
  });

  it("accepts the appointment view's own field names under Encounter", () => {
    // `get_appointments` serves Encounter-tagged items in the flat view shape,
    // portal visits included, so these are keys the owner actually sees.
    for (const field of ["practitioner", "org", "csn", "encounterId", "specialty", "source"]) {
      expect(fieldRuleResolves(parseFieldTarget(`Encounter.${field}`)!), field).toBe(true);
    }
  });

  it("cannot disprove a resource type it has no vocabulary for, so it accepts", () => {
    expect(fieldRuleResolves(parseFieldTarget("Binary.data")!)).toBe(true);
  });
});

describe("fieldRulesFor", () => {
  it("returns the type's own rules and the wildcards, and nothing else", () => {
    const rules = buildRules(
      rows(
        { rule_type: "field", target: "Patient.address.city" },
        { rule_type: "field", target: "*.lastUpdated" },
        { rule_type: "field", target: "Coverage.subscriberId" },
      ),
    );

    expect(fieldRulesFor(rules, "Patient").map((rule) => rule.target)).toStrictEqual([
      "Patient.address.city",
      "*.lastUpdated",
    ]);
  });
});
