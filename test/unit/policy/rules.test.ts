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
  fieldRulesFor,
  fieldSpecOf,
  isHealthSystemDenied,
  isSensitiveAllowed,
  isToolDenied,
  parseFieldTarget,
  ruleReaches,
} from "../../../worker/policy/rules.ts";

import type { ItemScope, PolicyRuleInput } from "../../../worker/policy/rules.ts";

const rows = (...input: PolicyRuleInput[]): PolicyRuleInput[] => input;

const scope = (overrides: Partial<ItemScope> = {}): ItemScope => ({
  tool: "get_patient_profile",
  resourceType: "Patient",
  healthSystemId: "prov_a",
  ...overrides,
});

/** A 0012-shaped field row. */
function fieldRow(paths: string[], columns: Partial<PolicyRuleInput> = {}): PolicyRuleInput {
  return {
    rule_type: "field",
    target: "sig",
    effect: "hide",
    scope_tool: null,
    scope_resource: null,
    scope_health_system: null,
    paths_json: JSON.stringify(paths),
    enabled: 1,
    ...columns,
  };
}

describe("EMPTY_RULES", () => {
  it("denies nothing, which is the posture on a fresh database", () => {
    expect(isToolDenied(EMPTY_RULES, "get_allergies")).toBe(false);
    expect(isHealthSystemDenied(EMPTY_RULES, "prov_a")).toBe(false);
    expect(fieldRulesFor(EMPTY_RULES, scope())).toStrictEqual([]);
    expect(EMPTY_RULES.unparsed).toStrictEqual([]);
  });
});

describe("parseFieldTarget (the pre-0012 single-string form)", () => {
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

  it("skips a disabled rule of every kind", () => {
    const rules = buildRules(
      rows(
        { rule_type: "tool", target: "get_documents", enabled: 0 },
        { rule_type: "resource", target: "Coverage", enabled: 0 },
        fieldRow(["name"], { enabled: 0 }),
      ),
    );

    expect(isToolDenied(rules, "get_documents")).toBe(false);
    expect(rules.resources.size).toBe(0);
    expect(rules.fields).toStrictEqual([]);
  });

  it("reads a legacy `allow:` field rule as re-enabling a sensitive field", () => {
    const rules = buildRules(
      rows({ rule_type: "field", target: `${ALLOW_PREFIX}Patient.birthDate` }),
    );

    expect(isSensitiveAllowed(rules, scope(), "birthDate")).toBe(true);
    expect(isSensitiveAllowed(rules, scope({ resourceType: "Coverage" }), "birthDate")).toBe(false);
    // And it is not also a deny rule.
    expect(rules.fields).toStrictEqual([]);
  });

  it("supports a legacy wildcard allow", () => {
    const rules = buildRules(rows({ rule_type: "field", target: `${ALLOW_PREFIX}*.birthDate` }));

    expect(isSensitiveAllowed(rules, scope(), "birthDate")).toBe(true);
  });

  it("reports targets it could not parse instead of ignoring them", () => {
    const rules = buildRules(
      rows(
        { rule_type: "field", target: "Patient" },
        { rule_type: "field", target: `${ALLOW_PREFIX}Patient.address.city` },
        { rule_type: "tool", target: "  " },
        fieldRow([], { target: "empty-paths" }),
        fieldRow(["a..b"], { target: "bad-path" }),
        fieldRow(["address.city"], { target: "deep-allow", effect: "allow" }),
        { ...fieldRow([]), paths_json: "not json", target: "bad-json" },
      ),
    );

    expect(rules.unparsed).toStrictEqual([
      "Patient",
      `${ALLOW_PREFIX}Patient.address.city`,
      "  ",
      "empty-paths",
      "bad-path",
      "deep-allow",
      "bad-json",
    ]);
    expect(rules.fields).toStrictEqual([]);
    expect(rules.allows).toStrictEqual([]);
  });

  it("expands a multi-path rule into one field rule per path, each with the rule's scope", () => {
    const rules = buildRules(
      rows(
        fieldRow(["participants[].name", "location.address.lines"], {
          scope_tool: "get_care_team",
          scope_health_system: "prov_a",
        }),
      ),
    );

    expect(rules.fields).toStrictEqual([
      {
        tool: "get_care_team",
        resourceType: null,
        healthSystemId: "prov_a",
        path: ["participants", ARRAY_SEGMENT, "name"],
        display: "participants[].name",
      },
      {
        tool: "get_care_team",
        resourceType: null,
        healthSystemId: "prov_a",
        path: ["location", "address", "lines"],
        display: "location.address.lines",
      },
    ]);
  });
});

describe("scope", () => {
  const base = {
    tool: null,
    resourceType: null,
    healthSystemId: null,
    path: ["name"],
    display: "name",
  };

  it("reaches everything with no scope at all", () => {
    expect(ruleReaches(base, scope())).toBe(true);
  });

  it("narrows by tool, by resource type and by health system, each independently", () => {
    expect(ruleReaches({ ...base, tool: "get_patient_profile" }, scope())).toBe(true);
    expect(ruleReaches({ ...base, tool: "get_care_team" }, scope())).toBe(false);
    expect(ruleReaches({ ...base, resourceType: "Patient" }, scope())).toBe(true);
    expect(ruleReaches({ ...base, resourceType: "CareTeam" }, scope())).toBe(false);
    expect(ruleReaches({ ...base, healthSystemId: "prov_a" }, scope())).toBe(true);
    expect(ruleReaches({ ...base, healthSystemId: "prov_b" }, scope())).toBe(false);
  });

  it("scopes an allow rule to its health system", () => {
    const rules = buildRules(
      rows(
        fieldRow(["birthDate"], {
          effect: "allow",
          scope_resource: "Patient",
          scope_health_system: "prov_a",
        }),
      ),
    );

    expect(isSensitiveAllowed(rules, scope(), "birthDate")).toBe(true);
    expect(isSensitiveAllowed(rules, scope({ healthSystemId: "prov_b" }), "birthDate")).toBe(false);
  });

  it("returns the type's own legacy rules and the wildcards, and nothing else", () => {
    const rules = buildRules(
      rows(
        { rule_type: "field", target: "Patient.address.city" },
        { rule_type: "field", target: "*.lastUpdated" },
        { rule_type: "field", target: "Coverage.subscriberId" },
      ),
    );

    expect(fieldRulesFor(rules, scope()).map((rule) => rule.display)).toStrictEqual([
      "address.city",
      "lastUpdated",
    ]);
  });
});

describe("fieldSpecOf", () => {
  it("reads the 0012 columns", () => {
    expect(
      fieldSpecOf(
        fieldRow(["b", "a"], { scope_tool: "get_vitals", scope_resource: "Observation" }),
      ),
    ).toStrictEqual({
      effect: "hide",
      tool: "get_vitals",
      resourceType: "Observation",
      healthSystemId: null,
      paths: ["b", "a"],
    });
  });

  it("reads a legacy target as a resource-type-scoped rule with one path", () => {
    expect(fieldSpecOf({ rule_type: "field", target: "allow:*.birthDate" })).toStrictEqual({
      effect: "allow",
      tool: null,
      resourceType: null,
      healthSystemId: null,
      paths: ["birthDate"],
    });
    expect(
      fieldSpecOf({ rule_type: "field", target: "Observation.components.[].value" })?.paths,
    ).toStrictEqual(["components[].value"]);
  });

  it("is null for the other kinds and for a legacy target that does not parse", () => {
    expect(fieldSpecOf({ rule_type: "tool", target: "get_vitals" })).toBeNull();
    expect(fieldSpecOf({ rule_type: "field", target: "Patient" })).toBeNull();
  });
});
