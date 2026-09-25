// The field tree the rule builder draws, and the write-time check that walks it.
//
// The check's job is to refuse a rule that can never remove anything -- and to
// say why in a sentence -- while accepting every path that names something real
// in either vocabulary, at any depth.

import { describe, expect, it } from "vitest";

import { normalizeCoverage } from "../../../worker/fhir/normalize/coverage.ts";
import { normalizePatient } from "../../../worker/fhir/normalize/patient.ts";
import { TOOL_NAMES } from "../../../worker/mcp/tools/index.ts";
import {
  SENSITIVE_FIELDS,
  policySchema,
  resolveInShape,
  shapesForScope,
} from "../../../worker/policy/tree.ts";
import { checkFieldSpec, fieldSignature } from "../../../worker/policy/validate.ts";
import { testCtx } from "../fhir/normalize/fixtures.ts";

import type { FieldRuleSpec } from "@shared/types.ts";

const HEALTH_SYSTEMS = new Set(["prov_a"]);

function spec(paths: string[], overrides: Partial<FieldRuleSpec> = {}): FieldRuleSpec {
  return {
    effect: "hide",
    tool: null,
    resourceType: null,
    healthSystemId: null,
    paths,
    ...overrides,
  };
}

function accepted(input: FieldRuleSpec): string[] {
  const result = checkFieldSpec(input, HEALTH_SYSTEMS);
  if (!result.ok) throw new Error(result.issues.join("\n"));
  return result.spec.paths;
}

function refused(input: FieldRuleSpec): string {
  const result = checkFieldSpec(input, HEALTH_SYSTEMS);
  if (result.ok) throw new Error(`accepted ${JSON.stringify(result.spec)}`);
  return result.issues.join("\n");
}

describe("the schema", () => {
  const schema = policySchema();

  it("lists every tool, each with at least one shape that exists", () => {
    const shapeIds = new Set(schema.shapes.map((shape) => shape.id));
    expect(schema.tools.map((tool) => tool.name)).toStrictEqual([...TOOL_NAMES]);
    for (const tool of schema.tools) {
      expect(tool.shapes.length, tool.name).toBeGreaterThan(0);
      for (const shape of tool.shapes) expect(shapeIds.has(shape), shape).toBe(true);
    }
  });

  it("marks arrays, types nested objects by datatype, and describes what it can", () => {
    const raw = schema.shapes.find((shape) => shape.id === "raw:Observation");
    const component = raw?.fields.find((field) => field.name === "component");
    expect(component).toMatchObject({ array: true, type: "Observation.component" });
    expect(component?.description).toBeTruthy();

    const datatype = schema.datatypes.find((entry) => entry.name === "Observation.component");
    expect(datatype?.fields.find((field) => field.name === "referenceRange")).toMatchObject({
      array: true,
      type: "Observation.referenceRange",
    });
  });

  it("groups a FHIR choice type under a `stem[x]` node", () => {
    const raw = schema.shapes.find((shape) => shape.id === "raw:Observation");
    const choice = raw?.fields.find((field) => field.name === "value[x]");
    expect(choice?.choice).toContain("valueQuantity");
    expect(choice?.choice).toContain("valueString");
  });

  it("marks the fields withheld by default, matching what the normalizers declare", () => {
    const ctx = testCtx();
    const declared = new Map([
      ["Patient", normalizePatient({ resourceType: "Patient" }, ctx).sensitive],
      [
        "Coverage",
        normalizeCoverage(
          { resourceType: "Coverage", status: "active", beneficiary: {}, payor: [] },
          ctx,
        ).sensitive,
      ],
    ]);
    expect(new Map(SENSITIVE_FIELDS)).toStrictEqual(declared);

    const patient = schema.shapes.find((shape) => shape.id === "normalized:Patient");
    expect(patient?.fields.find((field) => field.name === "birthDate")?.sensitive).toBe(true);
  });
});

describe("resolveInShape", () => {
  it("walks nested objects and arrays, writing in the `[]` it steps through", () => {
    expect(resolveInShape("raw:Observation", ["component", "referenceRange", "low"])).toStrictEqual(
      { ok: true, canonical: ["component", "[]", "referenceRange", "[]", "low"] },
    );
    expect(resolveInShape("view:Appointment", ["location", "address", "lines"])).toStrictEqual({
      ok: true,
      canonical: ["location", "address", "lines"],
    });
  });

  it("accepts anything below an open node", () => {
    expect(resolveInShape("raw:Patient", ["extension", "[]", "url"]).ok).toBe(true);
  });

  it("says where it stopped and what it would have accepted", () => {
    const result = resolveInShape("normalized:CareTeam", ["participants", "[]", "nmae"]);
    expect(result).toMatchObject({
      ok: false,
      matched: ["participants", "[]"],
      failed: "nmae",
      options: ["name", "role"],
    });
  });

  it("refuses `[]` after something that is not an array", () => {
    expect(resolveInShape("normalized:Patient", ["name", "[]"]).ok).toBe(false);
  });
});

describe("checkFieldSpec", () => {
  it("accepts the four examples the builder exists for", () => {
    expect(accepted(spec(["participants[].name"], { tool: "get_care_team" }))).toStrictEqual([
      "participants[].name",
    ]);
    expect(accepted(spec(["location.address.lines"], { tool: "get_appointments" }))).toStrictEqual([
      "location.address.lines",
    ]);
    expect(accepted(spec(["code.coding[].display"], { resourceType: "Condition" }))).toStrictEqual([
      "code.coding[].display",
    ]);
    expect(
      accepted(spec(["component[].referenceRange[].low"], { tool: "get_lab_results" })),
    ).toStrictEqual(["component[].referenceRange[].low"]);
  });

  it("canonicalizes: brackets written in, duplicates dropped, sorted", () => {
    expect(
      accepted(
        spec(["participants.name", "participants[].name", "name"], { resourceType: "CareTeam" }),
      ),
    ).toStrictEqual(["name", "participants[].name"]);
  });

  it("accepts a path in the other vocabulary through its alias", () => {
    // `components[].value` is normalized; the raw shape spells it value[x].
    expect(accepted(spec(["components[].value"], { resourceType: "Observation" }))).toStrictEqual([
      "components[].value",
    ]);
    expect(accepted(spec(["value[x]"], { resourceType: "Observation" }))).toStrictEqual([
      "value[x]",
    ]);
  });

  it("refuses a typo with a suggestion and the fields that were there", () => {
    const message = refused(spec(["participants[].nmae"], { resourceType: "CareTeam" }));
    expect(message).toContain('there is no "nmae" under participants[]');
    expect(message).toContain("(there: name, role)");
    expect(message).toContain('Did you mean "name"?');
  });

  it("refuses a field the tool's answers never carry", () => {
    const message = refused(spec(["participants[].name"], { tool: "get_lab_results" }));
    expect(message).toContain("matches nothing in get_lab_results's answers");
  });

  it("refuses a tool and resource type that never meet, and unknown tools and health systems", () => {
    expect(refused(spec(["code"], { tool: "get_lab_results", resourceType: "Encounter" }))).toBe(
      "get_lab_results never returns Encounter items",
    );
    expect(refused(spec(["code"], { tool: "get_everything" }))).toContain(
      'there is no tool called "get_everything"',
    );
    expect(refused(spec(["code"], { healthSystemId: "prov_zz" }))).toContain(
      "that health system does not exist",
    );
  });

  it("refuses a path that does not parse, saying why", () => {
    expect(refused(spec(["a..b"]))).toContain("empty segment");
    expect(refused(spec(["[]"]))).toContain("not only array markers");
  });

  it("cannot disprove a resource type it has no model for, so it accepts", () => {
    expect(accepted(spec(["data"], { resourceType: "Binary" }))).toStrictEqual(["data"]);
  });

  it("only allows a field that is withheld by default", () => {
    expect(
      accepted(spec(["birthDate"], { effect: "allow", resourceType: "Patient" })),
    ).toStrictEqual(["birthDate"]);
    expect(refused(spec(["name"], { effect: "allow", resourceType: "Patient" }))).toContain(
      "not withheld by default",
    );
  });
});

describe("fieldSignature", () => {
  it("is the same for the same rule and different for any other", () => {
    const a = spec(["x"], { tool: "get_vitals" });
    expect(fieldSignature(a)).toBe(fieldSignature({ ...a }));
    expect(fieldSignature(a)).not.toBe(fieldSignature({ ...a, healthSystemId: "prov_a" }));
    expect(fieldSignature(a)).not.toBe(fieldSignature({ ...a, effect: "allow" }));
  });
});

describe("shapesForScope", () => {
  it("keeps a typed scope's own shapes and the summary rows that name a type", () => {
    expect(shapesForScope({ tool: "get_health_summary", resourceType: "Condition" })).toStrictEqual(
      ["summary:count", "summary:recent", "view:ConditionGroup"],
    );
  });
});
