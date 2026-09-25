// get_conditions' category filter, status filter and collapse, and the
// summary's conditions section, end to end over the in-memory transport.
//
// The record below is synthetic and shaped like an Epic one: a problem-list
// entry sends ICD-10 first, each visit's copy of the same diagnosis sends SNOMED
// first and carries both the FHIR `encounter-diagnosis` category and Epic's own
// `visit-diagnosis`, and the visit copies have no clinical status. Codes and
// names are invented; none is from a real record.

import { beforeEach, describe, expect, it } from "vitest";

import { buildRules } from "../../../worker/policy/rules.ts";

import {
  HEALTH_SYSTEM_A,
  HEALTH_SYSTEM_B,
  callTool,
  connectTools,
  fakeDeps,
  fakeState,
} from "./helpers.ts";

import type { FakeState } from "./helpers.ts";
import type { PolicyRuleInput } from "../../../worker/policy/rules.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const rules = (...input: PolicyRuleInput[]) => buildRules(input);

const ICD10 = "https://hl7.org/fhir/sid/icd-10-cm";
const SNOMED = "https://snomed.info/sct";
const ICD9 = "https://hl7.org/fhir/sid/icd-9-cm";

const PROBLEM_LIST = {
  text: "Problem List Item",
  coding: [
    {
      system: "https://terminology.hl7.org/CodeSystem/condition-category",
      code: "problem-list-item",
      display: "Problem List Item",
    },
  ],
};

const VISIT_DIAGNOSIS = [
  {
    text: "Encounter Diagnosis",
    coding: [
      {
        system: "https://terminology.hl7.org/CodeSystem/condition-category",
        code: "encounter-diagnosis",
        display: "Encounter Diagnosis",
      },
    ],
  },
  {
    text: "Visit Diagnosis",
    coding: [
      {
        system: "https://example.test/condition-category",
        code: "visit-diagnosis",
        display: "Visit Diagnosis",
      },
    ],
  },
];

const HEALTH_CONCERN = { coding: [{ code: "health-concern", display: "Health Concern" }] };

/** The "alpha" condition, coded ICD-10 X01.1 and SNOMED 1000001. */
function alphaCode(icdFirst: boolean) {
  const icd = { system: ICD10, code: "X01.1", display: "Alpha" };
  const snomed = { system: SNOMED, code: "1000001", display: "Alpha" };
  const icd9 = { system: ICD9, code: "999.1" };
  return { text: "Alpha condition", coding: icdFirst ? [icd, snomed] : [snomed, icd9, icd] };
}

function visitRow(id: string, recorded: string, encounter: string, code: unknown) {
  return {
    resourceType: "Condition",
    id,
    category: VISIT_DIAGNOSIS,
    code,
    encounter: { reference: `Encounter/${encounter}` },
    recordedDate: recorded,
  };
}

function conditionPools() {
  return new Map<string, Record<string, unknown[]>>([
    [
      HEALTH_SYSTEM_A,
      {
        Condition: [
          {
            resourceType: "Condition",
            id: "pl-alpha",
            category: [PROBLEM_LIST],
            clinicalStatus: { coding: [{ code: "active", display: "Active" }] },
            code: alphaCode(true),
            onsetDateTime: "2024-01-15",
            recordedDate: "2024-02-01",
          },
          visitRow("v-alpha-1", "2025-03-01", "enc-1", alphaCode(false)),
          visitRow("v-alpha-2", "2026-01-10", "enc-2", alphaCode(false)),
          // The same visit coding alpha twice: one visit, listed once.
          visitRow("v-alpha-3", "2026-01-10", "enc-2", alphaCode(false)),
          visitRow("v-text-1", "2025-06-01", "enc-3", { text: "Beta  finding" }),
          visitRow("v-text-2", "2026-02-02", "enc-4", { text: "beta finding" }),
          visitRow("v-gamma", "2026-03-03", "enc-5", {
            text: "Gamma condition",
            coding: [{ system: SNOMED, code: "2000002" }],
          }),
          {
            resourceType: "Condition",
            id: "hc-delta",
            category: [HEALTH_CONCERN],
            clinicalStatus: { coding: [{ code: "resolved", display: "Resolved" }] },
            code: { text: "Delta concern" },
            recordedDate: "2023-05-05",
          },
        ],
      },
    ],
    [
      HEALTH_SYSTEM_B,
      {
        // Alpha at the other health system: never merged with health system A's.
        Condition: [visitRow("b-alpha", "2025-09-09", "enc-b", alphaCode(false))],
      },
    ],
  ]);
}

const ROWS = 9;

const world: { state: FakeState; client: Client } = {
  state: fakeState(),
  client: undefined as unknown as Client,
};

beforeEach(async () => {
  world.state = fakeState({ pools: conditionPools() });
  world.client = await connectTools(fakeDeps(world.state));
});

/** The whole envelope, for the fields `callTool` does not pick out. */
function envelope(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function ids(items: readonly Record<string, unknown>[]): string[] {
  return items.map((item) => String(item.id));
}

function group(items: readonly Record<string, unknown>[], text: string): Record<string, unknown> {
  const found = items.find(
    (item) =>
      item.healthSystemId === HEALTH_SYSTEM_A &&
      (item.code as { text?: string } | undefined)?.text?.toLowerCase().replaceAll(/\s+/gu, " ") ===
        text,
  );
  if (found === undefined) throw new Error(`no group for ${text}`);
  return found;
}

describe("get_conditions defaults", () => {
  it("returns every row, one per resource, with no groups field", async () => {
    const answer = await callTool(world.client, "get_conditions");
    const parsed = envelope(answer.text);

    expect(answer.items).toHaveLength(ROWS);
    expect(parsed.total).toBe(ROWS);
    expect(parsed.matched).toBe(ROWS);
    expect(Object.hasOwn(parsed, "groups")).toBe(false);
    expect(answer.warnings.some((warning) => warning.startsWith("status_filter"))).toBe(false);
  });

  it("carries every coding and the visit id on a row", async () => {
    const answer = await callTool(world.client, "get_conditions");
    const row = answer.items.find((item) => item.id === "v-alpha-1");

    expect(row?.encounterId).toBe("enc-1");
    expect(row?.code).toStrictEqual({
      text: "Alpha condition",
      system: SNOMED,
      code: "1000001",
      codings: [
        { system: SNOMED, code: "1000001" },
        { system: ICD9, code: "999.1" },
        { system: ICD10, code: "X01.1" },
      ],
    });
  });
});

describe("get_conditions category", () => {
  it("keeps only problem-list entries", async () => {
    const answer = await callTool(world.client, "get_conditions", {
      category: ["problem-list-item"],
    });

    expect(ids(answer.items)).toStrictEqual(["pl-alpha"]);
    expect(answer.total).toBe(1);
  });

  it("maps Epic's display strings onto the category codes", async () => {
    const byCode = await callTool(world.client, "get_conditions", {
      category: ["encounter-diagnosis"],
    });
    for (const spelling of ["Visit Diagnosis", "Encounter Diagnosis", "visit diagnosis"]) {
      const answer = await callTool(world.client, "get_conditions", { category: [spelling] });
      expect(ids(answer.items), spelling).toStrictEqual(ids(byCode.items));
    }
    expect(byCode.items).toHaveLength(7);
    const problemList = await callTool(world.client, "get_conditions", {
      category: ["Problem List Item"],
    });
    expect(ids(problemList.items)).toStrictEqual(["pl-alpha"]);
  });

  it("keeps rows in any of several categories", async () => {
    const answer = await callTool(world.client, "get_conditions", {
      category: ["problem-list-item", "Health Concern"],
    });

    expect(new Set(ids(answer.items))).toStrictEqual(new Set(["pl-alpha", "hc-delta"]));
  });

  it("refuses a category that is none of the three, and an empty list", async () => {
    for (const category of [["chronic"], []]) {
      const answer = await callTool(world.client, "get_conditions", { category });
      expect(answer.isError, JSON.stringify(category)).toBe(true);
      expect(answer.text).toContain("Invalid arguments");
    }
  });
});

describe("get_conditions status", () => {
  it("says how many status-less rows a status filter left out", async () => {
    const answer = await callTool(world.client, "get_conditions", { status: "active" });

    expect(ids(answer.items)).toStrictEqual(["pl-alpha"]);
    expect(answer.total).toBe(1);
    // Seven visit rows have no status; `hc-delta` is resolved, so not counted.
    expect(answer.warnings).toContain("status_filter_excluded_unknown:7");
  });

  it("keeps exactly the status-less rows for `unknown`, with no warning", async () => {
    const answer = await callTool(world.client, "get_conditions", { status: "unknown" });

    expect(answer.items).toHaveLength(7);
    expect(answer.items.every((item) => item.clinicalStatus === undefined)).toBe(true);
    expect(answer.warnings.some((warning) => warning.startsWith("status_filter"))).toBe(false);
  });

  it("adds no warning when no status-less row was left out", async () => {
    const answer = await callTool(world.client, "get_conditions", {
      status: "Resolved",
      category: ["health-concern"],
    });

    expect(ids(answer.items)).toStrictEqual(["hc-delta"]);
    expect(answer.warnings.some((warning) => warning.startsWith("status_filter"))).toBe(false);
  });
});

describe("get_conditions collapse", () => {
  it("groups by code across categories, by text, and never across health systems", async () => {
    const answer = await callTool(world.client, "get_conditions", { collapse: true });
    const parsed = envelope(answer.text);

    // A: alpha, beta (text), gamma (SNOMED), delta (text); B: alpha.
    expect(parsed.groups).toBe(5);
    expect(parsed.total).toBe(ROWS);
    expect(parsed.matched).toBe(5);
    expect(answer.items).toHaveLength(5);
    expect(answer.items.every((item) => item.kind === "condition_group")).toBe(true);

    const alpha = group(answer.items, "alpha condition");
    expect(alpha).toMatchObject({
      onProblemList: true,
      categories: ["encounter-diagnosis", "problem-list-item"],
      occurrences: 4,
      firstSeen: "2024-01-15",
      lastSeen: "2026-01-10",
      encounterIds: ["enc-2", "enc-1"],
      // The problem-list entry's status, though the latest rows have none.
      clinicalStatus: "Active",
    });
    expect(new Set(alpha.ids as string[])).toStrictEqual(
      new Set(["pl-alpha", "v-alpha-1", "v-alpha-2", "v-alpha-3"]),
    );
    // The problem-list entry's code is the one shown.
    expect((alpha.code as { code?: string }).code).toBe("X01.1");

    const beta = group(answer.items, "beta finding");
    expect(beta).toMatchObject({
      onProblemList: false,
      categories: ["encounter-diagnosis"],
      occurrences: 2,
      firstSeen: "2025-06-01",
      lastSeen: "2026-02-02",
      encounterIds: ["enc-4", "enc-3"],
    });
    expect(Object.hasOwn(beta, "clinicalStatus")).toBe(false);

    const other = answer.items.find((item) => item.healthSystemId === HEALTH_SYSTEM_B);
    expect(other).toMatchObject({ occurrences: 1, ids: ["b-alpha"] });
  });

  it("orders groups by when they were last seen, newest first", async () => {
    const answer = await callTool(world.client, "get_conditions", { collapse: true });

    expect(answer.items.map((item) => item.lastSeen)).toStrictEqual([
      "2026-03-03",
      "2026-02-02",
      "2026-01-10",
      "2025-09-09",
      "2023-05-05",
    ]);
  });

  it("collapses after the category and status filters, and counts rows in `total`", async () => {
    const answer = await callTool(world.client, "get_conditions", {
      collapse: true,
      category: ["encounter-diagnosis"],
      healthSystems: [HEALTH_SYSTEM_A],
    });
    const parsed = envelope(answer.text);

    expect(parsed.total).toBe(6);
    expect(parsed.groups).toBe(3);
    const alpha = group(answer.items, "alpha condition");
    expect(alpha).toMatchObject({ onProblemList: false, occurrences: 3 });

    const active = await callTool(world.client, "get_conditions", {
      collapse: true,
      status: "active",
    });
    expect(envelope(active.text).groups).toBe(1);
    expect(active.warnings).toContain("status_filter_excluded_unknown:7");
  });

  it("applies `limit` and `jq` to the groups", async () => {
    const limited = await callTool(world.client, "get_conditions", { collapse: true, limit: 2 });
    expect(limited.items).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    expect(envelope(limited.text)).toMatchObject({ total: ROWS, groups: 5, matched: 5 });

    const projected = await callTool(world.client, "get_conditions", {
      collapse: true,
      jq: ".[] | select(.occurrences > 1) | {occurrences, onProblemList}",
    });
    expect(projected.items).toStrictEqual([
      { occurrences: 2, onProblemList: false },
      { occurrences: 4, onProblemList: true },
    ]);
    expect(envelope(projected.text)).toMatchObject({ total: ROWS, groups: 5, matched: 2 });
  });

  it("gives each group the raw resources of its rows", async () => {
    const answer = await callTool(world.client, "get_conditions", { collapse: true, raw: true });
    const raw = envelope(answer.text).raw as { resource: { id: string } }[][];

    expect(raw).toHaveLength(answer.items.length);
    for (const [index, item] of answer.items.entries()) {
      expect(raw[index]?.map((entry) => entry.resource.id)).toStrictEqual(item.ids);
    }
  });

  it("groups only what the policy let through", async () => {
    world.state.rules = rules(
      { rule_type: "field", target: "Condition.encounterId" },
      { rule_type: "field", target: "Condition.onset" },
    );

    const answer = await callTool(world.client, "get_conditions", { collapse: true });
    const alpha = group(answer.items, "alpha condition");

    expect(alpha.encounterIds).toStrictEqual([]);
    // Without the onset, the earliest date left is the problem-list row's recorded date.
    expect(alpha.firstSeen).toBe("2024-02-01");
    expect(answer.text).not.toContain("enc-1");
    expect(answer.text).not.toContain("2024-01-15");
  });

  it("does not collapse on a code the policy withheld", async () => {
    world.state.rules = rules({ rule_type: "field", target: "Condition.code" });

    const answer = await callTool(world.client, "get_conditions", { collapse: true });

    // No code left to group by: every row is its own group.
    expect(envelope(answer.text).groups).toBe(ROWS);
    expect(answer.text).not.toContain("X01.1");
  });

  it("hides every coding when a rule reaches the first one's code or system", async () => {
    // In both vocabularies: the ICD-10 code is never the first coding on a
    // visit row, so it survives only if `code.codings` escapes the rule.
    for (const target of [
      "Condition.code.code",
      "Condition.code.coding[].code",
      "Condition.code.coding",
    ]) {
      world.state.rules = rules({ rule_type: "field", target });
      for (const args of [{}, { collapse: true }, { raw: true }]) {
        const answer = await callTool(world.client, "get_conditions", args);
        expect(answer.text, `${target} ${JSON.stringify(args)}`).not.toContain("X01.1");
      }
    }
    for (const target of ["Condition.code.system", "Condition.code.coding[].system"]) {
      world.state.rules = rules({ rule_type: "field", target });
      const answer = await callTool(world.client, "get_conditions", { collapse: true });
      expect(answer.text, target).not.toContain("icd-10-cm");
    }
  });

  it("applies a rule on a collapsed-only field to the groups", async () => {
    world.state.rules = rules({ rule_type: "field", target: "Condition.firstSeen" });

    const answer = await callTool(world.client, "get_conditions", { collapse: true });

    expect(answer.items.some((item) => Object.hasOwn(item, "firstSeen"))).toBe(false);
    expect(answer.items.every((item) => typeof item.lastSeen === "string")).toBe(true);
    expect(answer.warnings).toContain("policy_field_removed:Condition.firstSeen");
  });

  it("drops a visit id when the Encounter type is denied", async () => {
    world.state.rules = rules({ rule_type: "resource", target: "Encounter" });

    const answer = await callTool(world.client, "get_conditions");

    expect(answer.items.some((item) => Object.hasOwn(item, "encounterId"))).toBe(false);
  });

  it("counts nothing and warns nothing when the Condition type is denied", async () => {
    world.state.rules = rules({ rule_type: "resource", target: "Condition" });

    const answer = await callTool(world.client, "get_conditions", {
      collapse: true,
      status: "active",
    });

    expect(answer.items).toStrictEqual([]);
    expect(answer.warnings.some((warning) => warning.startsWith("status_filter"))).toBe(false);
    expect(envelope(answer.text).groups).toBe(0);
  });
});

describe("get_health_summary conditions", () => {
  it("puts the problem list first, then the latest encounter diagnoses, and says which", async () => {
    const answer = await callTool(world.client, "get_health_summary");
    const conditions = answer.items.filter((item) => item.section === "conditions");

    expect(conditions.map((item) => item.source)).toStrictEqual([
      "problem_list",
      "encounter_diagnosis",
      "encounter_diagnosis",
      "encounter_diagnosis",
      "other",
    ]);
    expect(conditions[0]).toMatchObject({ onProblemList: true, occurrences: 4 });
    expect(conditions.slice(1, 4).map((item) => item.lastSeen)).toStrictEqual([
      "2026-03-03",
      "2026-02-02",
      "2025-09-09",
    ]);
  });

  it("collapses only what the policy let through, and keeps its warnings", async () => {
    world.state.rules = rules({ rule_type: "field", target: "Condition.encounterId" });

    const answer = await callTool(world.client, "get_health_summary");
    const conditions = answer.items.filter((item) => item.section === "conditions");

    expect(conditions.every((item) => (item.encounterIds as unknown[]).length === 0)).toBe(true);
    expect(answer.text).not.toContain("enc-1");
    expect(answer.warnings.some((warning) => warning.includes("encounterId"))).toBe(true);
  });
});
