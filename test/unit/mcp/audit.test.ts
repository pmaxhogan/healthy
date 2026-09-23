// The audit trail.
//
// The property under test is negative and it is the important one: an audit row
// records THAT a tool ran and how much came back, never WHAT came back. The table
// has no column content could go in, and this file proves the writer does not try
// to smuggle it into one that exists -- by serialising every row and looking for
// the fixture's own clinical strings in it.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../../worker/lib/errors.ts";
import { withAudit } from "../../../worker/mcp/audit.ts";
import { toolError } from "../../../worker/mcp/respond.ts";
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
import type { ToolOutcome } from "../../../worker/mcp/respond.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** The world each test starts from. A holder, so `beforeEach` assigns a property. */
const world: { state: FakeState; client: Client } = {
  state: fakeState(),
  client: undefined as unknown as Client,
};

beforeEach(async () => {
  world.state = fakeState();
  world.client = await connectTools(fakeDeps(world.state));
});

/** Clinical strings that appear in the fixtures and must never appear in a row. */
const CONTENT = [
  "Seasonal allergic rhinitis",
  "Cetirizine",
  "Hemoglobin",
  "1970-07-07",
  "SUB-12345",
  "Ada Rivers",
  "Never smoker",
];

describe("what a row contains", () => {
  it("writes exactly one row per call, with the tool, the caller and the counts", async () => {
    await callTool(world.client, "get_conditions");

    expect(world.state.audits).toHaveLength(1);
    expect(world.state.audits[0]).toStrictEqual({
      tool: "get_conditions",
      clientId: "client-under-test",
      grantId: "grant-under-test",
      healthSystemIds: [HEALTH_SYSTEM_A, HEALTH_SYSTEM_B],
      resultCount: 3,
      ok: true,
      errorCode: null,
      durationMs: expect.any(Number) as number,
    });
  });

  it("has no field carrying item content, on any tool", async () => {
    for (const name of [
      "get_conditions",
      "get_medications",
      "get_lab_results",
      "get_patient_profile",
      "get_coverage",
      "get_social_history",
      "get_appointments",
      "get_health_summary",
    ]) {
      await callTool(world.client, name, { raw: true });
    }

    const serialised = JSON.stringify(world.state.audits);
    for (const fragment of CONTENT) {
      expect(serialised, fragment).not.toContain(fragment);
    }
    // And the keys are only the ones the table has.
    for (const row of world.state.audits) {
      expect(Object.keys(row).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
        "clientId",
        "durationMs",
        "errorCode",
        "grantId",
        "healthSystemIds",
        "ok",
        "resultCount",
        "tool",
      ]);
    }
  });

  it("records health system ids, never health system display names", async () => {
    await callTool(world.client, "get_conditions");

    const serialised = JSON.stringify(world.state.audits);
    expect(serialised).toContain(HEALTH_SYSTEM_A);
    expect(serialised).not.toContain("Example Health");
    expect(serialised).not.toContain("Other Clinic");
  });

  it("records a failure with its stable code and a zero count", async () => {
    world.state.rules = buildRules([{ rule_type: "tool", target: "get_conditions" }]);

    await callTool(world.client, "get_conditions");

    expect(world.state.audits[0]?.ok).toBe(false);
    expect(world.state.audits[0]?.errorCode).toBe("policy_denied");
    expect(world.state.audits[0]?.resultCount).toBe(0);
  });

  it("records the disabled case too, so the switch being on is auditable", async () => {
    world.state.enabled = false;

    await callTool(world.client, "list_health_systems");

    expect(world.state.audits[0]).toMatchObject({
      tool: "list_health_systems",
      errorCode: "mcp_disabled",
    });
  });

  it("counts what was returned after the policy filtered, not before", async () => {
    world.state.rules = buildRules([{ rule_type: "health_system", target: HEALTH_SYSTEM_B }]);

    await callTool(world.client, "get_conditions");

    // Two of the three conditions are health system A's.
    expect(world.state.audits[0]?.resultCount).toBe(2);
  });
});

describe("per-call freshness", () => {
  it("drops the cached settings and rules before every call", async () => {
    await callTool(world.client, "get_conditions");
    await callTool(world.client, "get_conditions");

    expect(world.state.beginCalls).toBe(2);
  });

  it("picks up a rule added between two calls in the same session", async () => {
    const before = await callTool(world.client, "get_conditions");
    world.state.rules = buildRules([{ rule_type: "tool", target: "get_conditions" }]);
    const after = await callTool(world.client, "get_conditions");

    expect(before.isError).toBe(false);
    expect(after.error).toBe("policy_denied");
  });
});

/** Run one tool body through the wrapper, with dependencies of its own. */
async function runBody(body: () => never | Promise<never>): Promise<ToolOutcome["result"]> {
  const handler = withAudit(fakeDeps(fakeState()), "get_conditions", body);
  return handler({});
}

describe("error handling", () => {
  it("maps an AppError to a stable tool code and never leaks its message", async () => {
    const result = await runBody(() => {
      throw new AppError("upstream_error", "organisation said: patient 12345 is unknown");
    });

    const text = JSON.stringify(result);
    expect(text).toContain("upstream_error");
    expect(text).not.toContain("12345");
  });

  it("maps an unexpected throw to internal_error, with no stack", async () => {
    const result = await runBody(() => {
      throw new TypeError("cannot read property 'x' of undefined at line 42");
    });

    const text = JSON.stringify(result);
    expect(text).toContain("internal_error");
    expect(text).not.toContain("line 42");
    expect(text).not.toContain("TypeError");
  });

  it("still answers when the audit write itself fails", async () => {
    const broken = {
      ...fakeDeps(fakeState()),
      recordAudit: () => Promise.reject(new Error("D1 unavailable")),
    };
    const handler = withAudit(broken, "list_health_systems", () =>
      Promise.resolve(toolError("not_found")),
    );

    await expect(handler({})).resolves.toMatchObject({ isError: true });
  });
});

describe("retention", () => {
  it("prunes on a sampled fraction of calls, not on every one", async () => {
    // The sampler reads one CSPRNG byte and prunes below 3, so both branches are
    // reachable and neither is the default.
    const bytes = vi.spyOn(crypto, "getRandomValues");

    bytes.mockImplementation(((array: Uint8Array) => {
      array[0] = 0;
      return array;
    }) as typeof crypto.getRandomValues);
    await callTool(world.client, "list_health_systems");
    expect(world.state.prunes).toBe(1);

    bytes.mockImplementation(((array: Uint8Array) => {
      array[0] = 200;
      return array;
    }) as typeof crypto.getRandomValues);
    await callTool(world.client, "list_health_systems");
    expect(world.state.prunes).toBe(1);

    bytes.mockRestore();
  });
});
