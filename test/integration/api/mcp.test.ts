// `/api/mcp` -- the exposure deny-list, the grants, the audit trail and the tool
// catalogue.
//
// The policy routes are the sharp end: `mcp_policy` is what withholds a category or
// a field from an assistant, so a rule the API accepts and the filter never reads
// would be a rule the owner believes is protecting them. These tests pin the round
// trip through real D1, including the idempotent add that the UI relies on.

import { afterEach, describe, expect, it } from "vitest";

import { TOOL_CATALOG } from "../../../worker/api/tool-catalog.ts";
import { AppError } from "../../../worker/lib/errors.ts";

import { freshOwner, json, resetPorts, testRepos, usePorts } from "./helpers.ts";

import type {
  ApiError,
  McpAuditDto,
  McpGrantDto,
  McpToolInfoDto,
  PolicyRuleDto,
} from "@shared/types.ts";

const owner = freshOwner();

afterEach(() => {
  resetPorts();
});

describe("the policy CRUD", () => {
  it("starts empty", async () => {
    expect(await json<PolicyRuleDto[]>(await owner().get("/api/mcp/policy"))).toStrictEqual([]);
  });

  it("adds a rule, lists it, and deletes it", async () => {
    const created = await owner().send("POST", "/api/mcp/policy", {
      ruleType: "resource",
      target: "DocumentReference",
      note: "notes stay out of the assistant",
    });

    expect(created.status).toBe(201);
    const rule = await json<PolicyRuleDto>(created);
    expect(rule.ruleType).toBe("resource");
    expect(rule.target).toBe("DocumentReference");
    expect(rule.note).toBe("notes stay out of the assistant");
    expect(rule.unparsed).toBe(false);
    expect(Number.isNaN(Date.parse(rule.createdAt))).toBe(false);

    const listed = await json<PolicyRuleDto[]>(await owner().get("/api/mcp/policy"));
    expect(listed.map((entry) => entry.id)).toStrictEqual([rule.id]);

    const deleted = await owner().send("DELETE", `/api/mcp/policy/${rule.id}`);
    expect(deleted.status).toBe(200);
    expect(await json<PolicyRuleDto[]>(await owner().get("/api/mcp/policy"))).toStrictEqual([]);
  });

  it("reports a field rule the engine cannot read, so a typo is not a silent no-op", async () => {
    // "Patient" alone is a resource, not a field path, and the engine makes
    // nothing of it as a `field` target. Stored, listed, denying nothing: the one
    // way this surface could mislead the owner, so it is reported.
    const typo = await json<PolicyRuleDto>(
      await owner().send("POST", "/api/mcp/policy", { ruleType: "field", target: "Patient" }),
    );
    const good = await json<PolicyRuleDto>(
      await owner().send("POST", "/api/mcp/policy", {
        ruleType: "field",
        target: "Patient.telecom",
      }),
    );

    expect(typo.unparsed).toBe(true);
    expect(good.unparsed).toBe(false);
    const listed = await json<PolicyRuleDto[]>(await owner().get("/api/mcp/policy"));
    expect(listed.filter((entry) => entry.unparsed).map((entry) => entry.target)).toStrictEqual([
      "Patient",
    ]);
  });

  it("adding the same rule twice returns the same row, so the UI can be fire and forget", async () => {
    const body = { ruleType: "tool", target: "get_documents" };

    const first = await json<PolicyRuleDto>(await owner().send("POST", "/api/mcp/policy", body));
    const second = await json<PolicyRuleDto>(await owner().send("POST", "/api/mcp/policy", body));

    expect(second.id).toBe(first.id);
    expect(await json<PolicyRuleDto[]>(await owner().get("/api/mcp/policy"))).toHaveLength(1);
  });

  it("accepts all four rule types and refuses a fifth", async () => {
    for (const ruleType of ["tool", "resource", "field", "provider"]) {
      const response = await owner().send("POST", "/api/mcp/policy", { ruleType, target: "x" });
      expect(response.status, ruleType).toBe(201);
    }

    const bad = await owner().send("POST", "/api/mcp/policy", {
      ruleType: "everything",
      target: "x",
    });
    expect(bad.status).toBe(400);
  });

  it("refuses an empty target", async () => {
    const response = await owner().send("POST", "/api/mcp/policy", {
      ruleType: "field",
      target: "",
    });

    expect(response.status).toBe(400);
  });

  it("refuses a field path that names nothing in either the normalized or the raw vocabulary", async () => {
    // Vuln 1 in .local/reviews/sec-entrypoints-egress.md: a `field` rule that
    // parses fine but matches nothing anywhere used to be stored -- and
    // `unparsed: false`, so the owner had no signal it would never fire. It
    // parses (a real dotted path below a real resource type), so this is a
    // different rejection than the structural-parse-failure case above.
    const response = await owner().send("POST", "/api/mcp/policy", {
      ruleType: "field",
      target: "Observation.nonesuch.deeper",
    });
    const body = await json<ApiError>(response);

    expect(response.status).toBe(400);
    expect(body.error).toBe("bad_request");
    expect(await json<PolicyRuleDto[]>(await owner().get("/api/mcp/policy"))).toStrictEqual([]);
  });

  it("still accepts a raw-vocabulary field with no normalized counterpart", async () => {
    // Patient.telecom is dropped by normalization entirely (never projected),
    // so it only ever resolves against the raw vocabulary -- it must keep
    // working, since it is exactly what `raw: true` field rules are for.
    const response = await owner().send("POST", "/api/mcp/policy", {
      ruleType: "field",
      target: "Patient.telecom",
    });

    expect(response.status).toBe(201);
    const rule = await json<PolicyRuleDto>(response);
    expect(rule.unparsed).toBe(false);
  });

  it("still accepts the documented example, written in the raw vocabulary", async () => {
    const response = await owner().send("POST", "/api/mcp/policy", {
      ruleType: "field",
      target: "Observation.component[].valueQuantity.value",
    });

    expect(response.status).toBe(201);
    const rule = await json<PolicyRuleDto>(response);
    expect(rule.unparsed).toBe(false);
  });

  it("404s deleting a rule that is not there", async () => {
    const response = await owner().send("DELETE", "/api/mcp/policy/NOPE");

    const body = await json<ApiError>(response);
    expect(response.status).toBe(404);
    expect(body.error).toBe("not_found");
  });
});

describe("GET /api/mcp/grants", () => {
  it("projects the grant store's records, tolerating missing fields", async () => {
    usePorts({
      grants: {
        listGrants: () =>
          Promise.resolve([
            {
              id: "grant-1",
              clientId: "client-1",
              clientName: "Claude",
              scope: ["health:read"],
              createdAt: "2026-01-01T00:00:00.000Z",
              lastUsedAt: "2026-01-01T01:00:00.000Z",
            },
            // Only `id`: the shape belongs to a dependency that has changed it
            // between releases, so the projection has to fill the gaps.
            { id: "grant-2" },
          ]),
        revokeGrant: () => Promise.resolve(true),
      },
    });

    const grants = await json<McpGrantDto[]>(await owner().get("/api/mcp/grants"));

    expect(grants[0]).toStrictEqual({
      id: "grant-1",
      clientId: "client-1",
      clientName: "Claude",
      scope: ["health:read"],
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T01:00:00.000Z",
    });
    expect(grants[1]?.clientId).toBe("unknown");
    expect(grants[1]?.clientName).toBeNull();
    expect(grants[1]?.lastUsedAt).toBeNull();
    expect(grants[1]?.scope).toStrictEqual([]);
    expect(grants[1]?.createdAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("revokes a grant, and 404s one the store does not have", async () => {
    const revoked: string[] = [];
    usePorts({
      grants: {
        listGrants: () => Promise.resolve([]),
        revokeGrant: (_env, id) => {
          revoked.push(id);
          return Promise.resolve(id === "grant-1");
        },
      },
    });

    const known = await owner().send("DELETE", "/api/mcp/grants/grant-1");
    const unknown = await owner().send("DELETE", "/api/mcp/grants/grant-2");

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(404);
    expect(revoked).toStrictEqual(["grant-1", "grant-2"]);
  });

  it("reports an unreachable grant store as a 500 with a code and no detail", async () => {
    usePorts({
      grants: {
        listGrants: () => Promise.reject(new AppError("internal", "OAUTH_KV is unreachable")),
        revokeGrant: () => Promise.resolve(false),
      },
    });

    const response = await owner().get("/api/mcp/grants");
    const body = await json<ApiError>(response);

    expect(response.status).toBe(500);
    expect(body.error).toBe("internal");
    // A 5xx message can quote an upstream response, so it never travels.
    expect(body.message).toBeUndefined();
  });
});

describe("GET /api/mcp/audit", () => {
  it("lists rows newest first, with the metadata and nothing else", async () => {
    const repos = testRepos();
    await repos.mcpAudit.insert({
      tool: "get_appointments",
      clientId: "client-1",
      providers: ["PROV1"],
      resultCount: 3,
      durationMs: 42,
    });
    await repos.mcpAudit.insert({ tool: "get_vitals", ok: false, errorCode: "policy_denied" });

    const rows = await json<McpAuditDto[]>(await owner().get("/api/mcp/audit"));

    expect(rows).toHaveLength(2);
    expect(rows[0]?.tool).toBe("get_vitals");
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.errorCode).toBe("policy_denied");
    expect(rows[1]?.resultCount).toBe(3);
    expect(rows[1]?.durationMs).toBe(42);
  });

  it("honours ?limit=", async () => {
    const repos = testRepos();
    for (const tool of ["a", "b", "c"]) await repos.mcpAudit.insert({ tool });

    expect(await json<McpAuditDto[]>(await owner().get("/api/mcp/audit?limit=2"))).toHaveLength(2);
  });

  it("refuses a limit that is not a positive integer", async () => {
    const zero = await owner().get("/api/mcp/audit?limit=0");
    const words = await owner().get("/api/mcp/audit?limit=abc");

    expect(zero.status).toBe(400);
    expect(words.status).toBe(400);
  });
});

describe("GET /api/mcp/tools", () => {
  it("answers with the static catalogue", async () => {
    const tools = await json<McpToolInfoDto[]>(await owner().get("/api/mcp/tools"));

    expect(tools).toHaveLength(TOOL_CATALOG.length);
    expect(tools.map((tool) => tool.name)).toContain("get_appointments");
  });
});
