// Reference displays: a name copied into a resource that points at another
// one. The exposure policy withholds them by the referenced resource's type --
// denied types, the patient when their name is hidden, clinicians when theirs
// is -- anywhere in the resource, in `raw: true` AND in the normalized strings
// rendered from them. Narratives go whenever the policy withholds anything.
//
// As in the other policy suites, what matters is asserted on the serialised
// string that would leave. Every name and id below is synthetic.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { normalizeResource } from "../../../worker/fhir/normalize/index.ts";
import { mapResolver } from "../../../worker/fhir/normalize/refs.ts";
import { previewDraft } from "../../../worker/mcp/policy-sample.ts";
import { respond } from "../../../worker/mcp/respond.ts";
import { applyPolicy } from "../../../worker/policy/filter.ts";
import { REFERENCE_FIELDS } from "../../../worker/policy/references.ts";
import { buildRules } from "../../../worker/policy/rules.ts";
import { HEALTH_SYSTEM_A, callTool, connectTools, fakeDeps, fakeState } from "../mcp/helpers.ts";

import type { McpPolicyRow } from "../../../worker/db/rows.ts";
import type { RawEntry } from "../../../worker/policy/filter.ts";
import type { PolicyRuleInput, PolicyRules } from "../../../worker/policy/rules.ts";
import type * as fhir4 from "fhir/r4";

const HS = "prov_a";
const tag = { healthSystem: "Example Health", healthSystemId: HS };

const PATIENT_NAME = "Pat Synthetic-Patient";
const INTERPRETER = "Dr. Iris Synthetic-Interpreter";
const PERFORMER = "Dr. Perry Synthetic-Performer";
const CONTAINED_DOC = "Dr. Cora Synthetic-Contained";
const URL_DOC = "Dr. Ulla Synthetic-Absolute";
const TYPED_DOC = "Dr. Tess Synthetic-TypeOnly";
const UNTYPED = "Someone Synthetic-Untyped";
const NPI = "npi-synthetic-0001";
const LAB_NAME = "Synthetic hemoglobin panel";
const NARRATIVE = "narrative-synthetic-marker";

function hide(paths: string[], resourceType?: string): PolicyRuleInput {
  return {
    rule_type: "field",
    target: JSON.stringify(paths),
    effect: "hide",
    scope_tool: null,
    scope_resource: resourceType ?? null,
    scope_health_system: null,
    paths_json: JSON.stringify(paths),
  };
}
const deny = (target: string): PolicyRuleInput => ({ rule_type: "resource", target });
const rules = (...input: PolicyRuleInput[]): PolicyRules => buildRules(input);

/** The owner's reported configuration: Practitioner denied, the patient's name hidden. */
const OWNER = rules(deny("Practitioner"), hide(["name"], "Patient"));

const ctx = { healthSystem: tag.healthSystem, refs: mapResolver([]) };

function run(
  tool: string,
  resources: fhir4.Resource[],
  policy: PolicyRules,
  options: { withRaw?: boolean; withSources?: boolean } = {},
) {
  const items = resources.map((resource) => ({
    ...(normalizeResource(resource as fhir4.FhirResource, ctx) as unknown as Record<
      string,
      unknown
    >),
    ...tag,
  }));
  const entries: RawEntry[] = resources.map((resource) => ({ ...tag, resource }));
  const result = applyPolicy({
    tool,
    items,
    ...(options.withRaw !== false && { rawItems: entries }),
    ...(options.withSources === true && { sources: entries }),
    rules: policy,
  });
  return { result, text: JSON.stringify({ items: result.items, raw: result.rawItems }) };
}

const CONTAINED_PRACTITIONER: fhir4.Practitioner = {
  resourceType: "Practitioner",
  id: "c1",
  name: [{ text: CONTAINED_DOC }],
};

const report: fhir4.DiagnosticReport = {
  resourceType: "DiagnosticReport",
  id: "dr-1",
  status: "final",
  code: { coding: [{ system: "https://loinc.org", code: "0000-0", display: LAB_NAME }] },
  subject: { reference: "Patient/pat-1", display: PATIENT_NAME },
  performer: [{ reference: "Practitioner/prac-1", display: PERFORMER }],
  resultsInterpreter: [
    {
      reference: "Practitioner/prac-2",
      display: INTERPRETER,
      identifier: { system: "urn:synthetic:npi", value: NPI },
    },
  ],
  text: { status: "generated", div: `<div>${NARRATIVE} ${PATIENT_NAME}</div>` },
  contained: [CONTAINED_PRACTITIONER],
  extension: [
    {
      url: "https://example.org/synthetic-extension",
      valueReference: { reference: "#c1", display: CONTAINED_DOC },
    },
  ],
};

describe("raw reference displays", () => {
  it("the owner's scenario: subject, resultsInterpreter and performer displays are all gone", () => {
    const { text, result } = run("get_diagnostic_reports", [report], OWNER);
    const raw = result.rawItems[0]?.resource as Record<string, unknown>;
    expect(raw.subject).toEqual({ reference: "Patient/pat-1" });
    expect(raw.resultsInterpreter).toEqual([{ reference: "Practitioner/prac-2" }]);
    expect(raw.performer).toEqual([{ reference: "Practitioner/prac-1" }]);
    for (const secret of [PATIENT_NAME, INTERPRETER, PERFORMER, NPI, CONTAINED_DOC, NARRATIVE]) {
      expect(text).not.toContain(secret);
    }
    // A coding's display is a code's text, not a name: it survives.
    expect(text).toContain(LAB_NAME);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "policy_reference_display_removed:Patient",
        "policy_reference_display_removed:Practitioner",
        "policy_resource_denied:Practitioner",
        "policy_field_removed:DiagnosticReport.text",
      ]),
    );
  });

  it("drops a denied contained resource and a `#id` reference to it", () => {
    const { result } = run("get_diagnostic_reports", [report], OWNER);
    const raw = result.rawItems[0]?.resource as Record<string, unknown>;
    expect(raw.contained).toEqual([]);
    expect(raw.extension).toEqual([
      {
        url: "https://example.org/synthetic-extension",
        valueReference: { reference: "#c1" },
      },
    ]);
  });

  it("applies field rules to a contained resource in its own type's scope", () => {
    const policy = rules(hide(["name"], "Practitioner"));
    const { text, result } = run("get_diagnostic_reports", [report], policy);
    const raw = result.rawItems[0]?.resource as { contained: Record<string, unknown>[] };
    expect(raw.contained).toEqual([{ resourceType: "Practitioner", id: "c1" }]);
    expect(text).not.toContain(CONTAINED_DOC);
    expect(text).not.toContain(PERFORMER);
    // Patient names are not restricted by a Practitioner rule.
    expect(text).toContain(PATIENT_NAME.split(" ", 1)[0]);
  });

  it("reads the type from an absolute URL, a `type`-only reference and `_history`", () => {
    const observation: fhir4.Observation = {
      resourceType: "Observation",
      id: "obs-1",
      status: "final",
      code: { text: "Synthetic measurement" },
      performer: [
        {
          reference: "https://fhir.example.invalid/api/FHIR/R4/Practitioner/abc/_history/2",
          display: URL_DOC,
        },
        { type: "Practitioner", identifier: { value: NPI }, display: TYPED_DOC },
        { reference: "Organization/org-1", display: "Synthetic Lab Org" },
      ],
    };
    const { text } = run("get_lab_results", [observation], OWNER);
    expect(text).not.toContain(URL_DOC);
    expect(text).not.toContain(TYPED_DOC);
    expect(text).not.toContain(NPI);
    // An Organization is not a person and is not denied: its display stays.
    expect(text).toContain("Synthetic Lab Org");
  });

  it("fails closed on a reference whose type cannot be read, with a warning", () => {
    const observation: fhir4.Observation = {
      resourceType: "Observation",
      id: "obs-2",
      status: "final",
      code: { text: "Synthetic measurement" },
      performer: [{ display: UNTYPED }, { reference: "urn:uuid:0000", display: UNTYPED }],
      note: [{ authorString: UNTYPED, text: "Synthetic note" }],
    };
    const restricted = run("get_lab_results", [observation], rules(hide(["name"], "Patient")));
    expect(restricted.text).not.toContain(UNTYPED);
    expect(restricted.result.warnings).toContain("policy_reference_display_removed:unknown");

    // With no person type restricted, an untyped display is left alone.
    const open = run("get_lab_results", [observation], rules(deny("Coverage")));
    expect(open.text).toContain(UNTYPED);
  });

  it("strips Encounter participants, DocumentReference author and authenticator, MedicationRequest requester", () => {
    const encounter: fhir4.Encounter = {
      resourceType: "Encounter",
      id: "enc-1",
      status: "finished",
      class: { code: "AMB" },
      participant: [{ individual: { reference: "Practitioner/p1", display: PERFORMER } }],
    };
    const document: fhir4.DocumentReference = {
      resourceType: "DocumentReference",
      id: "doc-1",
      status: "current",
      content: [{ attachment: { url: "Binary/b1" } }],
      author: [{ reference: "Practitioner/p1", display: PERFORMER }],
      authenticator: { reference: "PractitionerRole/r1", display: INTERPRETER },
    };
    const request: fhir4.MedicationRequest = {
      resourceType: "MedicationRequest",
      id: "mr-1",
      status: "active",
      intent: "order",
      subject: { reference: "Patient/pat-1", display: PATIENT_NAME },
      medicationCodeableConcept: { text: "Synthetic medication" },
      requester: { reference: "Practitioner/p1", display: PERFORMER },
    };
    for (const [tool, resource] of [
      ["get_encounters", encounter],
      ["get_documents", document],
      ["get_medications", request],
    ] as const) {
      const { text } = run(tool, [resource], OWNER);
      expect(text).not.toContain(PERFORMER);
      expect(text).not.toContain(INTERPRETER);
      expect(text).not.toContain(PATIENT_NAME);
    }
    // The medication itself is not a reference and survives.
    expect(run("get_medications", [request], OWNER).text).toContain("Synthetic medication");
  });

  it("a Patient.name rule scoped to get_patient_profile still reaches other tools", () => {
    const scoped: PolicyRuleInput = {
      ...hide(["name"], "Patient"),
      scope_tool: "get_patient_profile",
    };
    const { text } = run("get_diagnostic_reports", [report], rules(scoped));
    expect(text).not.toContain(PATIENT_NAME);
    expect(text).toContain(INTERPRETER);
  });

  it("a health-system-scoped rule restricts only that health system", () => {
    const elsewhere: PolicyRuleInput = {
      ...hide(["name"], "Patient"),
      scope_health_system: "prov_b",
    };
    const { text } = run("get_diagnostic_reports", [report], rules(elsewhere));
    expect(text).toContain(PATIENT_NAME);
  });

  it("keeps displays and the narrative when nothing is restricted", () => {
    const { text, result } = run("get_diagnostic_reports", [report], rules());
    expect(text).toContain(INTERPRETER);
    expect(text).toContain(NARRATIVE);
    expect(result.warnings).toEqual([]);
  });

  it("drops the narrative whenever a field rule reaches the resource", () => {
    const { text, result } = run(
      "get_diagnostic_reports",
      [report],
      rules(hide(["conclusion"], "DiagnosticReport")),
    );
    expect(text).not.toContain(NARRATIVE);
    expect(result.warnings).toContain("policy_field_removed:DiagnosticReport.text");
    // A field rule elsewhere does not restrict names.
    expect(text).toContain(INTERPRETER);
  });

  it("a rule on a normalized practitioner field restricts clinician names everywhere", () => {
    const { text } = run(
      "get_diagnostic_reports",
      [report],
      rules(hide(["practitioners[].name"], "Encounter")),
    );
    expect(text).not.toContain(INTERPRETER);
    expect(text).not.toContain(PERFORMER);
    expect(text).toContain(PATIENT_NAME.split(" ", 1)[0]);
  });
});

describe("normalized strings rendered from references", () => {
  const encounter: fhir4.Encounter = {
    resourceType: "Encounter",
    id: "enc-2",
    status: "finished",
    class: { code: "AMB" },
    participant: [{ individual: { reference: "Practitioner/p1", display: PERFORMER } }],
    serviceProvider: { reference: "Organization/o1", display: "Synthetic Org" },
  };
  const coverage: fhir4.Coverage = {
    resourceType: "Coverage",
    id: "cov-1",
    status: "active",
    beneficiary: { reference: "Patient/pat-1", display: PATIENT_NAME },
    payor: [{ reference: "Organization/ins-1", display: "Synthetic Insurer" }],
  };
  const procedure: fhir4.Procedure = {
    resourceType: "Procedure",
    id: "proc-1",
    status: "completed",
    subject: { reference: "Patient/pat-1" },
    performer: [{ actor: { reference: "Practitioner/p1", display: PERFORMER } }],
  };

  it("removes a clinician's name from the normalized item, raw or not", () => {
    for (const withRaw of [true, false]) {
      const { text, result } = run("get_encounters", [encounter, procedure], OWNER, { withRaw });
      expect(text).not.toContain(PERFORMER);
      expect(text).toContain("Synthetic Org");
      expect(result.warnings).toContain("policy_reference_display_removed:Practitioner");
    }
  });

  it("with the source in hand, keeps a reference that points somewhere unrestricted", () => {
    const { text } = run("get_coverage", [coverage], OWNER, { withRaw: false, withSources: true });
    expect(text).toContain("Synthetic Insurer");
    expect(text).not.toContain(PATIENT_NAME);
  });

  it("without the source, fails closed on every type the field may point at", () => {
    const { text } = run("get_coverage", [coverage], OWNER, { withRaw: false });
    expect(text).not.toContain("Synthetic Insurer");
  });

  it("removes the appointment view's portal-sourced practitioner with no source at all", () => {
    const portal = {
      resourceType: "Encounter",
      source: "portal",
      practitioner: PERFORMER,
      ...tag,
    };
    const result = applyPolicy({
      tool: "get_appointments",
      items: [portal],
      sources: [undefined],
      rules: OWNER,
    });
    expect(JSON.stringify(result.items)).not.toContain(PERFORMER);
  });
});

describe("normalized values read from a denied referenced resource", () => {
  const pooled = {
    healthSystem: tag.healthSystem,
    refs: mapResolver([
      {
        resourceType: "Practitioner",
        id: "p9",
        name: [{ text: PERFORMER }],
        qualification: [{ code: { text: "Synthetic Specialty" } }],
      } as fhir4.Practitioner,
      {
        resourceType: "Location",
        id: "l9",
        name: "Synthetic Clinic",
        address: { line: ["1 Synthetic Way"] },
      } as fhir4.Location,
    ]),
  };
  const encounter: fhir4.Encounter = {
    resourceType: "Encounter",
    id: "enc-9",
    status: "finished",
    class: { code: "AMB" },
    participant: [{ individual: { reference: "Practitioner/p9" } }],
    location: [{ location: { reference: "Location/l9" } }],
  };

  it("drops what the resolver read from a denied Practitioner or Location", () => {
    const item = { ...(normalizeResource(encounter, pooled) as object), ...tag };
    const before = JSON.stringify(item);
    expect(before).toContain("Synthetic Specialty");
    expect(before).toContain("1 Synthetic Way");
    const result = applyPolicy({
      tool: "get_encounters",
      items: [item],
      sources: [{ ...tag, resource: encounter }],
      rules: rules(deny("Practitioner"), deny("Location")),
    });
    const text = JSON.stringify(result.items);
    for (const secret of [
      PERFORMER,
      "Synthetic Specialty",
      "Synthetic Clinic",
      "1 Synthetic Way",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("jq after the policy", () => {
  it("cannot reach a removed display", async () => {
    const entries: RawEntry[] = [{ ...tag, resource: report }];
    const items = [{ ...(normalizeResource(report, ctx) as object), ...tag }];
    const outcome = await respond({
      tool: "get_diagnostic_reports",
      rules: OWNER,
      items,
      rawItems: entries,
      jq: '[.[] | .raw.resource | .. | objects | select(has("display")) | .display]',
      healthSystemIds: [HS],
      now: 1_780_272_000,
    });
    const text = outcome.result.content[0]?.type === "text" ? outcome.result.content[0].text : "";
    const parsed = JSON.parse(text) as { items: string[][] };
    expect(parsed.items).toEqual([[LAB_NAME]]);
    for (const secret of [PATIENT_NAME, INTERPRETER, PERFORMER, CONTAINED_DOC]) {
      expect(text).not.toContain(secret);
    }
  });
});

function world() {
  return fakeState({
    rules: OWNER,
    pools: new Map([[HEALTH_SYSTEM_A, { DiagnosticReport: [report] }]]),
  });
}

describe("end to end through the real tools", () => {
  it("get_diagnostic_reports with raw: true, with and without jq", async () => {
    const client = await connectTools(fakeDeps(world()));
    const plain = await callTool(client, "get_diagnostic_reports", { raw: true });
    const viaJq = await callTool(client, "get_diagnostic_reports", {
      raw: true,
      jq: '[.[] | .raw.resource | [paths(type == "object" and has("display"))] | length]',
    });
    expect(viaJq.items).toEqual([[1]]);
    for (const text of [plain.text, viaJq.text]) {
      for (const secret of [PATIENT_NAME, INTERPRETER, PERFORMER, CONTAINED_DOC, NPI, NARRATIVE]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("the policy preview shows the same result as the tool", async () => {
    const state = world();
    const stored: McpPolicyRow[] = [
      {
        id: "r1",
        rule_type: "resource",
        target: "Practitioner",
        note: null,
        created_at: 0,
        enabled: 1,
        effect: "hide",
        scope_tool: null,
        scope_resource: null,
        scope_health_system: null,
        paths_json: null,
      },
    ];
    const preview = await previewDraft(fakeDeps(state), stored, {
      tool: "get_diagnostic_reports",
      field: {
        effect: "hide",
        tool: null,
        resourceType: "Patient",
        healthSystemId: null,
        paths: ["name"],
      },
    });
    const text = JSON.stringify(preview);
    for (const secret of [INTERPRETER, PERFORMER, CONTAINED_DOC, NPI]) {
      expect(text).not.toContain(secret);
    }
    const sample = preview.tools[0]?.sample;
    expect(JSON.stringify(sample?.rawAfter)).not.toContain(PATIENT_NAME);
    expect(JSON.stringify(sample?.rawBefore)).toContain(PATIENT_NAME);
  });
});

describe("REFERENCE_FIELDS", () => {
  // Every normalizer that renders a reference to text (`refs.display`) must
  // have its fields listed, or a hidden name would survive in the normalized item.
  const renderers = new Map([
    ["care-team.ts", "CareTeam"],
    ["coverage.ts", "Coverage"],
    ["document-reference.ts", "DocumentReference"],
    ["encounter.ts", "Encounter"],
    ["medication-dispense.ts", "MedicationDispense"],
    ["medication-request.ts", "MedicationRequest"],
    ["procedure.ts", "Procedure"],
    ["service-request.ts", "ServiceRequest"],
  ]);

  it("lists every normalizer that calls refs.display", () => {
    const directory = new URL("../../../worker/fhir/normalize/", import.meta.url);
    for (const file of [
      "allergy.ts",
      "care-plan.ts",
      "condition.ts",
      "device.ts",
      "diagnostic-report.ts",
      "goal.ts",
      "immunization.ts",
      "location.ts",
      "observation.ts",
      "organization.ts",
      "patient.ts",
      "practitioner.ts",
      "specimen.ts",
      ...renderers.keys(),
    ]) {
      const source = readFileSync(new URL(file, directory), "utf8");
      const renders = source.includes("refs.display(");
      expect({ file, renders }).toEqual({ file, renders: renderers.has(file) });
    }
    for (const type of renderers.values()) expect(REFERENCE_FIELDS.has(type)).toBe(true);
  });
});
