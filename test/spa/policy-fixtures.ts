// A small, synthetic policy schema for the rule builder's tests: two tools, a
// normalized and a raw shape each, a datatype with an array in it. The real one
// comes from `GET /api/mcp/policy/schema`; this is shaped exactly like it.

import type { PolicyRuleDto, PolicySchemaDto } from "@shared/types.ts";

export function testSchema(): PolicySchemaDto {
  return {
    datatypes: [
      {
        name: "Reference",
        fields: [
          { name: "reference", description: "Link to another record" },
          { name: "display", description: "The referenced record's name, as text" },
        ],
      },
      {
        name: "CareTeam.participant",
        fields: [
          { name: "role", array: true },
          { name: "member", type: "Reference", description: "The team member" },
        ],
      },
      {
        name: "N.CareTeamParticipant",
        fields: [
          { name: "name", description: "The team member's name" },
          { name: "role", description: "Their role on the team" },
        ],
      },
    ],
    shapes: [
      {
        id: "normalized:CareTeam",
        label: "CareTeam item",
        resourceType: "CareTeam",
        vocabulary: "normalized",
        fields: [
          { name: "id" },
          { name: "name" },
          {
            name: "participants",
            array: true,
            type: "N.CareTeamParticipant",
            description: "The team members",
          },
        ],
      },
      {
        id: "raw:CareTeam",
        label: "Raw FHIR CareTeam (raw: true)",
        resourceType: "CareTeam",
        vocabulary: "raw",
        fields: [
          { name: "id" },
          { name: "participant", array: true, type: "CareTeam.participant" },
          { name: "extension", array: true, open: true },
        ],
      },
      {
        id: "normalized:Patient",
        label: "Patient item",
        resourceType: "Patient",
        vocabulary: "normalized",
        fields: [{ name: "name" }, { name: "birthDate", sensitive: true }],
      },
    ],
    resourceTypes: ["CareTeam", "Patient"],
    tools: [
      { name: "get_care_team", shapes: ["normalized:CareTeam", "raw:CareTeam"] },
      { name: "get_patient_profile", shapes: ["normalized:Patient"] },
    ],
  };
}

export function policyRule(overrides: Partial<PolicyRuleDto> = {}): PolicyRuleDto {
  return {
    id: "rule-1",
    ruleType: "field",
    target: "sig",
    field: {
      effect: "hide",
      tool: "get_care_team",
      resourceType: null,
      healthSystemId: null,
      paths: ["participants[].name"],
    },
    enabled: true,
    note: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    unparsed: false,
    ...overrides,
  };
}
