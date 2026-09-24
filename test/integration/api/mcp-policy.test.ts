// `/api/mcp/policy` -- structured field rules, their validation, the field
// tree, and the two windows onto real data the rule builder uses (the key
// structure of a tool's answer, and a before/after preview of a draft rule).
//
// Every route that does work is a POST, behind the session and the CSRF guard;
// the tests pin both. The cached record below is synthetic.

import { afterEach, describe, expect, it } from "vitest";

import {
  CSRF,
  ORIGIN,
  call,
  freshOwner,
  json,
  resetPorts,
  seedHealthSystem,
  testRepos,
} from "./helpers.ts";

import type {
  ApiError,
  FieldRuleSpec,
  PolicyPreviewDto,
  PolicyRuleDto,
  PolicySchemaDto,
  PolicyStructureDto,
  PolicyToolPreviewDto,
} from "@shared/types.ts";

const owner = freshOwner();

afterEach(() => {
  resetPorts();
});

function field(paths: string[], overrides: Partial<FieldRuleSpec> = {}): FieldRuleSpec {
  return {
    effect: "hide",
    tool: null,
    resourceType: null,
    healthSystemId: null,
    paths,
    ...overrides,
  };
}

async function create(spec: FieldRuleSpec, note?: string): Promise<Response> {
  return owner().send("POST", "/api/mcp/policy", {
    ruleType: "field",
    field: spec,
    ...(note !== undefined && { note }),
  });
}

/** A health system with a synthetic care team and lab result in its cache. */
async function seedRecord(): Promise<string> {
  const id = await seedHealthSystem();
  await testRepos().fhirCache.upsertMany(
    id,
    [
      {
        resourceType: "CareTeam",
        id: "ct-1",
        status: "active",
        participant: [
          { role: [{ text: "Primary care" }], member: { display: "Dr. Alpha Example" } },
          { role: [{ text: "Dietitian" }], member: { display: "Beta Example, RD" } },
        ],
      },
      {
        resourceType: "Observation",
        id: "obs-1",
        status: "final",
        category: [{ coding: [{ code: "laboratory" }] }],
        code: { text: "Synthetic panel" },
        effectiveDateTime: "2026-05-10T00:00:00Z",
        component: [
          {
            code: { text: "Part one" },
            valueQuantity: { value: 5.4, unit: "%" },
            referenceRange: [{ low: { value: 4.1 }, high: { value: 5.6 } }],
          },
        ],
      },
    ],
    86_400_000,
  );
  return id;
}

describe("structured field rules", () => {
  it("stores a multi-path, tool- and health-system-scoped rule, canonicalized", async () => {
    const healthSystemId = await seedHealthSystem();
    const response = await create(
      field(["participants.name", "name"], { tool: "get_care_team", healthSystemId }),
      "names stay home",
    );

    expect(response.status).toBe(201);
    const rule = await json<PolicyRuleDto>(response);
    expect(rule.field).toStrictEqual({
      effect: "hide",
      tool: "get_care_team",
      resourceType: null,
      healthSystemId,
      paths: ["name", "participants[].name"],
    });
    expect(rule.enabled).toBe(true);
    expect(rule.note).toBe("names stay home");
    expect(rule.unparsed).toBe(false);
  });

  it("returns the same row for the same rule, however its paths were spelled", async () => {
    const first = await json<PolicyRuleDto>(
      await create(field(["participants[].name"], { resourceType: "CareTeam" })),
    );
    const second = await json<PolicyRuleDto>(
      await create(field(["participants.name"], { resourceType: "CareTeam" })),
    );

    expect(second.id).toBe(first.id);
    expect(await json<PolicyRuleDto[]>(await owner().get("/api/mcp/policy"))).toHaveLength(1);
  });

  it("refuses a path that matches nothing for the scope, saying where and suggesting a fix", async () => {
    const response = await create(field(["participants[].nmae"], { tool: "get_care_team" }));
    const body = await json<ApiError & { details?: { problems?: string[] } }>(response);

    expect(response.status).toBe(400);
    expect(body.message).toContain('there is no "nmae" under participants[]');
    expect(body.message).toContain('Did you mean "name"?');
    expect(body.details?.problems).toHaveLength(1);
    expect(await json<PolicyRuleDto[]>(await owner().get("/api/mcp/policy"))).toStrictEqual([]);
  });

  it("refuses an unknown tool, an unknown health system, and a tool/type pair that never meet", async () => {
    for (const spec of [
      field(["code"], { tool: "get_everything" }),
      field(["code"], { healthSystemId: "no-such-health-system" }),
      field(["code"], { tool: "get_lab_results", resourceType: "CareTeam" }),
    ]) {
      const response = await create(spec);
      expect(response.status, JSON.stringify(spec)).toBe(400);
    }
  });

  it("refuses a malformed body: no paths, or a field object on another rule kind", async () => {
    const empty = await create(field([]));
    const mixed = await owner().send("POST", "/api/mcp/policy", {
      ruleType: "tool",
      target: "get_vitals",
      field: field(["code"]),
    });

    expect(empty.status).toBe(400);
    expect(mixed.status).toBe(400);
  });
});

describe("PATCH /api/mcp/policy/:id", () => {
  it("switches a rule off and on, and edits its note and its fields", async () => {
    const rule = await json<PolicyRuleDto>(
      await create(field(["participants[].name"], { resourceType: "CareTeam" })),
    );

    const off = await json<PolicyRuleDto>(
      await owner().send("PATCH", `/api/mcp/policy/${rule.id}`, { enabled: false }),
    );
    expect(off.enabled).toBe(false);

    const edited = await json<PolicyRuleDto>(
      await owner().send("PATCH", `/api/mcp/policy/${rule.id}`, {
        enabled: true,
        note: "  roles too  ",
        field: field(["participants[].name", "participants[].role"], { resourceType: "CareTeam" }),
      }),
    );
    expect(edited.enabled).toBe(true);
    expect(edited.note).toBe("roles too");
    expect(edited.field?.paths).toStrictEqual(["participants[].name", "participants[].role"]);
    expect(edited.id).toBe(rule.id);
  });

  it("refuses an edit that would duplicate another rule, and an invalid one", async () => {
    const a = await json<PolicyRuleDto>(
      await create(field(["name"], { resourceType: "CareTeam" })),
    );
    const b = await json<PolicyRuleDto>(
      await create(field(["status"], { resourceType: "CareTeam" })),
    );

    const clash = await owner().send("PATCH", `/api/mcp/policy/${b.id}`, {
      field: field(["name"], { resourceType: "CareTeam" }),
    });
    const invalid = await owner().send("PATCH", `/api/mcp/policy/${a.id}`, {
      field: field(["nonesuch"], { resourceType: "CareTeam" }),
    });

    expect(clash.status).toBe(409);
    expect(invalid.status).toBe(400);
  });

  it("404s a rule that is not there", async () => {
    const response = await owner().send("PATCH", "/api/mcp/policy/NOPE", { enabled: false });
    expect(response.status).toBe(404);
  });

  it("a disabled rule stops applying to the tools", async () => {
    await seedRecord();
    const rule = await json<PolicyRuleDto>(
      await create(field(["participants[].name"], { tool: "get_care_team" })),
    );
    const call = async (): Promise<string> => {
      const response = await owner().send("POST", "/api/mcp/tools/get_care_team/call", {});
      return JSON.stringify(await response.json());
    };

    expect(await call()).not.toContain("Alpha Example");
    await owner().send("PATCH", `/api/mcp/policy/${rule.id}`, { enabled: false });
    expect(await call()).toContain("Alpha Example");
  });
});

describe("GET /api/mcp/policy/schema", () => {
  it("requires a session", async () => {
    const response = await call("/api/mcp/policy/schema");
    expect(response.status).toBe(401);
  });

  it("answers with the shapes every tool can put in its answer", async () => {
    const schema = await json<PolicySchemaDto>(await owner().get("/api/mcp/policy/schema"));

    expect(schema.tools.find((tool) => tool.name === "get_appointments")?.shapes).toStrictEqual([
      "view:Appointment",
      "raw:Encounter",
    ]);
    expect(schema.resourceTypes).toContain("Observation");
  });
});

describe("POST /api/mcp/policy/structure", () => {
  it("requires a session and the CSRF header", async () => {
    const body = JSON.stringify({ tool: "get_care_team" });
    const anonymous = await call("/api/mcp/policy/structure", {
      method: "POST",
      headers: { origin: ORIGIN, ...CSRF, "content-type": "application/json" },
      body,
    });
    const forged = await call("/api/mcp/policy/structure", {
      method: "POST",
      headers: { cookie: owner().cookie, origin: ORIGIN, "content-type": "application/json" },
      body,
    });

    expect(anonymous.status).toBe(401);
    expect(forged.status).toBe(403);
  });

  it("answers with key names only, arrays marked, and never a value", async () => {
    await seedRecord();

    const response = await owner().send("POST", "/api/mcp/policy/structure", {
      tool: "get_care_team",
    });
    const structure = await json<PolicyStructureDto>(response);
    const text = JSON.stringify(structure);

    expect(response.status).toBe(200);
    expect(structure.items).toBe(1);
    expect(structure.item.find((node) => node.name === "participants")).toMatchObject({
      array: true,
      children: [{ name: "name" }, { name: "role" }],
    });
    expect(structure.raw.find((node) => node.name === "participant")?.array).toBe(true);
    expect(text).not.toContain("Alpha Example");
    expect(text).not.toContain("Primary care");
  });

  it("404s a tool that does not exist", async () => {
    const response = await owner().send("POST", "/api/mcp/policy/structure", { tool: "nope" });
    expect(response.status).toBe(404);
  });
});

/** One tool's entry in a preview answer. */
function entry(preview: PolicyPreviewDto, tool: string): PolicyToolPreviewDto | undefined {
  return preview.tools.find((candidate) => candidate.tool === tool);
}

describe("POST /api/mcp/policy/preview", () => {
  it("requires a session and the CSRF header", async () => {
    const body = JSON.stringify({ field: field(["name"], { resourceType: "CareTeam" }) });
    const anonymous = await call("/api/mcp/policy/preview", {
      method: "POST",
      headers: { origin: ORIGIN, ...CSRF, "content-type": "application/json" },
      body,
    });
    const forged = await call("/api/mcp/policy/preview", {
      method: "POST",
      headers: { cookie: owner().cookie, origin: ORIGIN, "content-type": "application/json" },
      body,
    });

    expect(anonymous.status).toBe(401);
    expect(forged.status).toBe(403);
  });

  it("previews every tool the scope reaches in one request, with per-tool counts", async () => {
    await seedRecord();

    const response = await owner().send("POST", "/api/mcp/policy/preview", {
      field: field(["component[].referenceRange[].low"], { resourceType: "Observation" }),
    });
    const preview = await json<PolicyPreviewDto>(response);
    const tools = preview.tools.map((candidate) => candidate.tool);

    expect(response.status).toBe(200);
    // Every tool that can carry an Observation, and none that cannot.
    expect(tools).toContain("get_lab_results");
    expect(tools).toContain("get_vitals");
    expect(tools).toContain("get_health_summary");
    expect(tools).not.toContain("get_care_team");
    // Never the metered document tool unless it is named.
    expect(tools).not.toContain("get_document_text");
    // The path is raw-only: it changes the lab result's raw resource, and not
    // the summary, which carries normalized items and no raw at all.
    expect(entry(preview, "get_lab_results")).toMatchObject({ total: 1, affected: 1 });
    expect(entry(preview, "get_health_summary")?.affected).toBe(0);
    expect(entry(preview, "get_vitals")).toMatchObject({ total: 0, affected: 0 });
  });

  it("shows the first real item the draft changes, before and after, raw included", async () => {
    await seedRecord();

    const response = await owner().send("POST", "/api/mcp/policy/preview", {
      tool: "get_lab_results",
      field: field(["component[].referenceRange[].low"], { resourceType: "Observation" }),
    });
    const preview = await json<PolicyPreviewDto>(response);
    const lab = entry(preview, "get_lab_results");

    expect(preview.tools).toHaveLength(1);
    expect(lab).toMatchObject({ total: 1, affected: 1, synthetic: false });
    expect(JSON.stringify(lab?.sample?.rawBefore)).toContain('"low":{"value":4.1}');
    expect(JSON.stringify(lab?.sample?.rawAfter)).not.toContain('"low"');
    expect(JSON.stringify(lab?.sample?.rawAfter)).toContain('"high":{"value":5.6}');
    expect(lab?.warnings).toStrictEqual([
      "policy_field_removed:Observation.component[].referenceRange[].low",
    ]);
  });

  it("reports zero changes, not an error, for a field no cached item has", async () => {
    await seedRecord();

    const preview = await json<PolicyPreviewDto>(
      await owner().send("POST", "/api/mcp/policy/preview", {
        field: field(["participants[].name"], { tool: "get_care_team" }),
      }),
    );

    expect(preview.tools).toHaveLength(1);
    expect(entry(preview, "get_care_team")?.affected).toBe(1);

    const none = await json<PolicyPreviewDto>(
      await owner().send("POST", "/api/mcp/policy/preview", {
        field: field(["identifiers.csn"], { resourceType: "Encounter" }),
      }),
    );
    expect(none.tools.every((candidate) => candidate.affected === 0)).toBe(true);
  });

  it("does not write an audit row, and is not affected by a stored field rule", async () => {
    await seedRecord();
    await create(field(["participants[].role"], { resourceType: "CareTeam" }));

    const preview = await json<PolicyPreviewDto>(
      await owner().send("POST", "/api/mcp/policy/preview", {
        tool: "get_care_team",
        field: field(["participants[].name"], { resourceType: "CareTeam" }),
      }),
    );
    const team = entry(preview, "get_care_team");

    // The stored role rule is not in the baseline: the diff is the draft's alone.
    expect(JSON.stringify(team?.sample?.before)).toContain("Primary care");
    expect(JSON.stringify(team?.sample?.before)).toContain("Alpha Example");
    expect(JSON.stringify(team?.sample?.after)).not.toContain("Alpha Example");
    expect(await testRepos().mcpAudit.listRecent(10)).toStrictEqual([]);
  });

  it("uses a made-up sample for get_document_text rather than spend a metered request", async () => {
    const preview = await json<PolicyPreviewDto>(
      await owner().send("POST", "/api/mcp/policy/preview", {
        field: field(["text"], { tool: "get_document_text" }),
      }),
    );
    const text = entry(preview, "get_document_text");

    expect(text?.synthetic).toBe(true);
    expect(text?.affected).toBe(1);
    expect(JSON.stringify(text?.sample?.after)).not.toContain("Example note text");
  });

  it("refuses a draft that would be refused on save, with the same sentence", async () => {
    const response = await owner().send("POST", "/api/mcp/policy/preview", {
      field: field(["participants[].nmae"], { tool: "get_care_team" }),
    });

    expect(response.status).toBe(400);
    const body = await json<ApiError>(response);
    expect(body.message).toContain('Did you mean "name"?');
  });
});
