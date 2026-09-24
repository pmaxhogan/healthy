// The optional `jq` argument, end to end over the in-memory transport, plus the
// engine on its own.
//
// Every tool gets the argument from the shared args layer and every answer goes
// through `respond()`, so these tests drive the real schemas, the real policy
// filter and the real (metered) jq wasm -- the same module the Worker ships.
// All data is the synthetic two-health-system world from ./helpers.ts.

import { beforeEach, describe, expect, it } from "vitest";

import { fuelFor, runJq } from "../../../worker/mcp/jq/engine.ts";
import { TOOL_NAMES } from "../../../worker/mcp/tools/index.ts";
import { buildRules } from "../../../worker/policy/rules.ts";
import { sha256Hex } from "../../../worker/sync/hash.ts";

import { callTool, connectTools, fakeDeps, fakeState } from "./helpers.ts";

import type { FakeState } from "./helpers.ts";
import type { PolicyRuleInput } from "../../../worker/policy/rules.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const rules = (...input: PolicyRuleInput[]) => buildRules(input);
const byName = (a: string, b: string) => a.localeCompare(b);

const world: { state: FakeState; client: Client } = {
  state: fakeState(),
  client: undefined as unknown as Client,
};

beforeEach(async () => {
  world.state = fakeState();
  world.client = await connectTools(fakeDeps(world.state));
});

interface Envelope {
  items: unknown;
  total: number;
  matched: number;
  warnings: string[];
  truncated: boolean;
  raw?: unknown;
  error?: string;
  detail?: string;
}

async function jqCall(
  tool: string,
  jq: string,
  args: Record<string, unknown> = {},
): Promise<{ envelope: Envelope; isError: boolean; text: string }> {
  const answer = await callTool(world.client, tool, { ...args, jq });
  return {
    envelope: JSON.parse(answer.text) as Envelope,
    isError: answer.isError,
    text: answer.text,
  };
}

describe("the jq engine", () => {
  it("runs real jq and collects every output", async () => {
    const run = await runJq(".[] | . * 2", "[1,2,3]");

    expect(run).toStrictEqual({ ok: true, outputs: [2, 4, 6] });
  });

  it("treats a program that begins with a dash as a program, not an option", async () => {
    const run = await runJq("-.[0]", "[5]");

    expect(run).toStrictEqual({ ok: true, outputs: [-5] });
  });

  it("reports a compile error with jq's own message", async () => {
    const run = await runJq(".[] | select(", "[]");

    expect(run.ok).toBe(false);
    expect(run).toMatchObject({ code: "jq_error" });
    expect(run.ok ? "" : run.message).toContain("syntax error");
  });

  it("reports a runtime error without jq's meaningless input location", async () => {
    const run = await runJq('.[] | error("stop here")', "[1]");

    expect(run).toStrictEqual({ ok: false, code: "jq_error", message: "jq: error: stop here" });
  });

  it.each([
    ["an unbounded repeat", "last(repeat(1))"],
    ["infinite recursion", "def f: f; f"],
    ["a huge range", "last(range(1e12))"],
    ["an unbounded until", "0 | until(false; . + 1)"],
  ])("stops %s on its step budget", async (_label, program) => {
    const run = await runJq(program, "null");

    expect(run).toMatchObject({ ok: false, code: "jq_budget_exceeded" });
  });

  it("stops a program that allocates past the memory ceiling", async () => {
    const run = await runJq('"x" * 200000000 | length', "null");

    expect(run).toMatchObject({ ok: false, code: "jq_out_of_memory" });
  });

  it("stops a runaway that also collects, on whichever bound it meets first", async () => {
    const run = await runJq("[repeat(1)]", "null");

    expect(run.ok).toBe(false);
    expect(run.ok ? null : run.code).toMatch(/^jq_(budget_exceeded|out_of_memory)$/u);
  });

  it("is usable again straight after a program was stopped", async () => {
    await runJq("[repeat(1)]", "null");

    await expect(runJq("add", "[1,2]")).resolves.toStrictEqual({ ok: true, outputs: [3] });
  });

  it("gives larger inputs proportionally more fuel, up to i32 max", () => {
    expect(fuelFor(0)).toBe(100_000_000);
    expect(fuelFor(1_000_000)).toBe(200_000_000);
    expect(fuelFor(1e12)).toBe(0x7f_ff_ff_ff);
  });
});

describe("the jq argument", () => {
  it("is in every tool's input schema", async () => {
    const { tools } = await world.client.listTools();

    expect(tools.map((tool) => tool.name).toSorted(byName)).toStrictEqual(
      [...TOOL_NAMES].toSorted(byName),
    );
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).toContain("jq");
    }
  });

  it("is shown by example in the biggest tools' descriptions", async () => {
    const { tools } = await world.client.listTools();

    for (const name of ["get_lab_results", "get_vitals", "get_documents", "get_appointments"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.description, name).toMatch(/pass `jq`, e\.g\. `\.\[\] \| select\(/u);
    }
  });

  it("filters ISO date strings by plain comparison", async () => {
    const { envelope } = await jqCall(
      "get_conditions",
      '[.[] | select(.recorded >= "2026-01-01") | .id] | sort | .[]',
    );

    expect(envelope.items).toStrictEqual(["cond-1", "cond-b"]);
    expect(envelope.total).toBe(3);
    expect(envelope.matched).toBe(2);
    expect(envelope.truncated).toBe(false);
  });

  it("selects and projects with select and map", async () => {
    const { envelope } = await jqCall(
      "get_lab_results",
      '.[] | select(.effective >= "2026-05-01") | {id, effective}',
    );

    expect(envelope.items).toStrictEqual([{ id: "obs-lab", effective: "2026-05-10T00:00:00Z" }]);
  });

  it("groups and deduplicates with group_by and unique", async () => {
    const grouped = await jqCall(
      "get_conditions",
      "group_by(.healthSystemId) | map({healthSystemId: .[0].healthSystemId, n: length}) | .[]",
    );
    const unique = await jqCall("get_conditions", "[.[].healthSystemId] | unique | .[]");

    expect(grouped.envelope.items).toStrictEqual([
      { healthSystemId: "prov_a", n: 2 },
      { healthSystemId: "prov_b", n: 1 },
    ]);
    expect(unique.envelope.items).toStrictEqual(["prov_a", "prov_b"]);
  });

  it("collects a stream of outputs into an array", async () => {
    const { envelope } = await jqCall("get_conditions", ".[] | .id");

    expect(envelope.items).toStrictEqual(expect.arrayContaining(["cond-1", "cond-2", "cond-b"]));
    expect(envelope.items).toHaveLength(3);
    expect(envelope.matched).toBe(3);
  });

  it("wraps even a single, non-array output as items' one element", async () => {
    const { envelope } = await jqCall("get_conditions", "length");

    expect(envelope.items).toStrictEqual([3]);
    expect(envelope.matched).toBe(1);
    expect(envelope.total).toBe(3);
  });

  it("wraps a program that builds its own array as one items element, not the flat list", async () => {
    const { envelope } = await jqCall("get_conditions", "[.[] | .id] | sort");

    expect(envelope.items).toStrictEqual([["cond-1", "cond-2", "cond-b"]]);
    expect(envelope.matched).toBe(1);
  });

  it("applies limit to jq's output array, not to its input", async () => {
    const { envelope } = await jqCall("get_conditions", "[.[] | .id] | sort | .[]", { limit: 2 });

    expect(envelope.items).toStrictEqual(["cond-1", "cond-2"]);
    expect(envelope.total).toBe(3);
    expect(envelope.matched).toBe(3);
    expect(envelope.truncated).toBe(true);
  });

  it("gives each item its raw resource under `raw` when raw is requested", async () => {
    const { envelope } = await jqCall(
      "get_conditions",
      "[.[] | {id, rawId: .raw.resource.id, rawType: .raw.resource.resourceType}] | sort_by(.id) | .[]",
      { raw: true },
    );

    expect(envelope.raw).toBeUndefined();
    expect(envelope.items).toStrictEqual([
      { id: "cond-1", rawId: "cond-1", rawType: "Condition" },
      { id: "cond-2", rawId: "cond-2", rawType: "Condition" },
      { id: "cond-b", rawId: "cond-b", rawType: "Condition" },
    ]);
  });

  it("works on get_document_text, whose only shared argument it is", async () => {
    const { envelope } = await jqCall("get_document_text", ".[0].text | length", {
      healthSystem: "prov_a",
      id: "doc-1",
    });

    expect(envelope.items).toStrictEqual(["Patient reports seasonal symptoms.".length]);
  });

  it("rejects a program longer than 4096 characters at the schema", async () => {
    const answer = await callTool(world.client, "get_conditions", { jq: `.${" ".repeat(4096)}` });

    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/4096|too_big|too big/iu);
  });
});

describe("jq sees only what the policy released", () => {
  it("cannot reach a denied field: it reads as null, with the empty-result warning", async () => {
    world.state.rules = rules({ rule_type: "field", target: "Condition.recorded" });

    const { envelope, text } = await jqCall("get_conditions", ".[].recorded");
    const viaRaw = await jqCall("get_conditions", ".[].raw.resource.recordedDate", {
      raw: true,
    });

    expect(envelope.items).toStrictEqual([null, null, null]);
    expect(envelope.warnings).toContain("jq_result_empty");
    expect(text).not.toContain("2026-04-04");
    expect(viaRaw.envelope.items).toStrictEqual([null, null, null]);
    expect(viaRaw.text).not.toContain("2026-04-04");
  });

  it("cannot see a denied health system's items at all", async () => {
    world.state.rules = rules({ rule_type: "health_system", target: "prov_b" });

    const { envelope, text } = await jqCall(
      "get_conditions",
      "[.[].healthSystemId] | unique | .[]",
    );

    expect(envelope.items).toStrictEqual(["prov_a"]);
    expect(text).not.toContain("Migraine");
  });

  it("is never run for a denied tool", async () => {
    world.state.rules = rules({ rule_type: "tool", target: "get_conditions" });

    const { envelope, isError } = await jqCall("get_conditions", "length");

    expect(isError).toBe(true);
    expect(envelope.error).toBe("policy_denied");
  });
});

describe("jq failures are surfaced, never empty data", () => {
  it("answers jq_error with jq's message for a compile error", async () => {
    const { envelope, isError } = await jqCall("get_conditions", "[.[] | select(.recorded >=]");

    expect(isError).toBe(true);
    expect(envelope.error).toBe("jq_error");
    expect(envelope.detail).toContain("syntax error");
    expect(envelope.items).toBeUndefined();
  });

  it("answers jq_error with jq's message for a runtime error", async () => {
    const { envelope, isError } = await jqCall("get_conditions", ".[] | .id | tonumber");

    expect(isError).toBe(true);
    expect(envelope.error).toBe("jq_error");
    expect(envelope.detail).toContain("cannot be parsed as a number");
  });

  it("answers jq_budget_exceeded for a filter that never terminates", async () => {
    const { envelope, isError } = await jqCall("get_conditions", "last(repeat(.))");

    expect(isError).toBe(true);
    expect(envelope.error).toBe("jq_budget_exceeded");
  });

  it("warns jq_result_empty when a non-empty input filters to nothing", async () => {
    const empty = await jqCall("get_conditions", '.[] | select(.recorded >= "2099-01-01")');
    const none = await jqCall("get_conditions", ".[] | select(false)");
    const nothing = await jqCall("get_conditions", ".nope");

    for (const { envelope } of [empty, none]) {
      expect(envelope.items).toStrictEqual([]);
      expect(envelope.warnings).toContain("jq_result_empty");
    }
    expect(nothing.isError).toBe(true);
  });

  it("does not warn when the input was already empty", async () => {
    const { envelope } = await jqCall("get_conditions", ".[]", { healthSystems: ["prov_b"] });
    const emptyInput = await jqCall("get_devices", ".[]");

    expect(envelope.warnings).not.toContain("jq_result_empty");
    expect(emptyInput.envelope.items).toStrictEqual([]);
    expect(emptyInput.envelope.warnings).not.toContain("jq_result_empty");
  });
});

describe("the audit row for a jq call", () => {
  it("records the program's hash and length and the counts, never its text", async () => {
    const program = '[.[] | select(tostring | test("rhinitis"; "i"))]';
    await jqCall("get_conditions", program);

    const row = world.state.audits.at(-1);
    expect(row?.jq).toStrictEqual({
      sha256: await sha256Hex(program),
      length: program.length,
      inputCount: 3,
      outputCount: 1,
    });
    expect(JSON.stringify(world.state.audits)).not.toContain("rhinitis");
  });

  it("records a failed program with no output count", async () => {
    await jqCall("get_conditions", "last(repeat(.))");

    expect(world.state.audits.at(-1)).toMatchObject({
      ok: false,
      errorCode: "jq_budget_exceeded",
      jq: { inputCount: 3, outputCount: null },
    });
  });

  it("records null for a call without jq", async () => {
    await callTool(world.client, "get_conditions");

    expect(world.state.audits.at(-1)?.jq).toBeNull();
  });
});
