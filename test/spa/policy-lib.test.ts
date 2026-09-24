// The rule builder's pure logic: the field tree and its search, the owner's key
// structure laid over it, the sentence a rule reads as, and the preview diff.

import { describe, expect, it } from "vitest";

import { canonicalPath } from "@shared/policy-path.ts";

import {
  allPaths,
  buildTree,
  diffLines,
  overlayStructure,
  ruleGroup,
  ruleSentence,
  toolsAffected,
  visibleRows,
} from "../../src/lib/policy.ts";

import { policyRule, testSchema } from "./policy-fixtures.ts";

const names = (id: string): string => (id === "prov-1" ? "Example Health" : id);

describe("the field tree", () => {
  const groups = buildTree(testSchema(), { tool: "get_care_team", resourceType: null });

  it("has one group per shape the scope reaches", () => {
    expect(groups.map((group) => group.id)).toStrictEqual(["normalized:CareTeam", "raw:CareTeam"]);
  });

  it("expands datatypes into children, with array-aware paths", () => {
    const raw = groups[1]!;
    const participant = raw.nodes.find((node) => node.name === "participant")!;
    expect(participant.array).toBe(true);
    expect(participant.children.map((child) => child.path)).toStrictEqual([
      "participant[].role",
      "participant[].member",
    ]);
    const member = participant.children.find((child) => child.name === "member")!;
    expect(member.children.map((child) => child.path)).toStrictEqual([
      "participant[].member.reference",
      "participant[].member.display",
    ]);
  });

  it("shows only top-level rows until a node is opened", () => {
    const rows = visibleRows(groups[0]!, new Set(), "");
    expect(rows.map((row) => row.node.path)).toStrictEqual(["id", "name", "participants"]);

    const opened = visibleRows(groups[0]!, new Set(["normalized:CareTeam|participants"]), "");
    expect(opened.map((row) => row.node.path)).toContain("participants[].name");
  });

  it("finds a nested field by name or description and opens the way to it", () => {
    const rows = visibleRows(groups[1]!, new Set(), "display");
    expect(rows.map((row) => [row.node.path, row.depth])).toStrictEqual([
      ["participant", 0],
      ["participant[].member", 1],
      ["participant[].member.display", 2],
    ]);
    expect(
      visibleRows(groups[0]!, new Set(), "team members").map((row) => row.node.path),
    ).toStrictEqual(["participants"]);
  });

  it("lays the owner's real key names over the tree, adding the ones the model lacks", () => {
    const overlaid = overlayStructure(groups, {
      item: [
        { name: "participants", array: true, children: [{ name: "name" }, { name: "extra" }] },
      ],
      raw: [],
    });
    const participants = overlaid[0]!.nodes.find((node) => node.name === "participants")!;
    expect(participants.seen).toBe(true);
    const extra = participants.children.find((node) => node.name === "extra")!;
    expect(extra).toMatchObject({ path: "participants[].extra", observedOnly: true, seen: true });
    // The input groups are not modified.
    expect(groups[0]!.nodes.find((node) => node.name === "participants")!.seen).toBe(false);
  });

  it("offers every path, and list forms, to the raw-path autocomplete", () => {
    const paths = allPaths(groups);
    expect(paths).toContain("participants[].name");
    expect(paths).toContain("participant[]");
    expect(paths).toContain("participant[].member.display");
  });

  it("canonicalizes a typed path, or refuses it", () => {
    expect(canonicalPath("participants.[].name")).toBe("participants[].name");
    expect(canonicalPath("a..b")).toBeNull();
  });
});

describe("rule sentences", () => {
  it("reads a field rule as one sentence, arrays implied", () => {
    expect(ruleSentence(policyRule(), names)).toBe(
      "Hide participants → name in get_care_team at all health systems",
    );
  });

  it("names the resource type, the health system and every path", () => {
    const rule = policyRule({
      field: {
        effect: "hide",
        tool: null,
        resourceType: "Encounter",
        healthSystemId: "prov-1",
        paths: ["location.address.lines", "participant[].individual.display"],
      },
    });
    expect(ruleSentence(rule, names)).toBe(
      "Hide location → address → lines and participant → individual → display on Encounter items in every tool at Example Health",
    );
  });

  it("reads the other kinds and an allow rule plainly", () => {
    expect(
      ruleSentence(policyRule({ ruleType: "tool", target: "get_vitals", field: null }), names),
    ).toBe("Block the tool get_vitals");
    expect(
      ruleSentence(policyRule({ ruleType: "health_system", target: "prov-1", field: null }), names),
    ).toBe("Hide everything from Example Health");
    expect(
      ruleSentence(
        policyRule({
          field: {
            effect: "allow",
            tool: null,
            resourceType: "Patient",
            healthSystemId: null,
            paths: ["birthDate"],
          },
        }),
        names,
      ),
    ).toBe(
      "Show birthDate (withheld by default) on Patient items in every tool at all health systems",
    );
  });

  it("groups rules by what they apply to", () => {
    expect(ruleGroup(policyRule())).toBe("Fields in get_care_team");
    expect(ruleGroup(policyRule({ ruleType: "resource", target: "Coverage", field: null }))).toBe(
      "Hidden resource types",
    );
  });

  it("lists the tools a rule changes", () => {
    const schema = testSchema();
    expect(toolsAffected(policyRule(), schema)).toStrictEqual(["get_care_team"]);
    expect(
      toolsAffected(
        policyRule({
          field: {
            effect: "hide",
            tool: null,
            resourceType: "Patient",
            healthSystemId: null,
            paths: ["name"],
          },
        }),
        schema,
      ),
    ).toStrictEqual(["get_patient_profile"]);
  });
});

describe("the preview diff", () => {
  it("marks exactly the keys the rule removed, inside arrays too", () => {
    const before = {
      id: "ct-1",
      participants: [
        { name: "A", role: "x" },
        { name: "B", role: "y" },
      ],
    };
    const after = { id: "ct-1", participants: [{ role: "x" }, { role: "y" }] };

    const removed = diffLines(before, after)
      .filter((line) => line.removed)
      .map((line) => line.text.trim());

    expect(removed).toStrictEqual(['"name": "A",', '"name": "B",']);
  });

  it("marks a whole removed subtree, and nothing when nothing changed", () => {
    const before = { a: { b: [1, 2] }, c: 1 };
    expect(diffLines(before, { c: 1 }).filter((line) => line.removed)).toHaveLength(6);
    expect(diffLines(before, before).some((line) => line.removed)).toBe(false);
  });
});
