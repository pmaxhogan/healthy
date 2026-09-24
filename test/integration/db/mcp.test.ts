import { beforeEach, describe, expect, it } from "vitest";

import { AUDIT_RETENTION_DAYS } from "../../../worker/db/repos/mcp-audit.ts";
import { DAY_SECONDS } from "../../../worker/lib/time.ts";

import { T0, clock, column, resetDb, seedHealthSystem, testRepos } from "./helpers.ts";

beforeEach(resetDb);

describe("mcp_audit.insert", () => {
  it("records a call with its metadata and nothing else", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);

    const id = await repos.mcpAudit.insert({
      tool: "get_appointments",
      clientId: "client-1",
      grantId: "grant-1",
      healthSystems: [healthSystemId],
      resultCount: 4,
      durationMs: 37,
    });

    expect(await repos.mcpAudit.get(id)).toStrictEqual({
      id,
      ts: T0,
      clientId: "client-1",
      grantId: "grant-1",
      tool: "get_appointments",
      healthSystems: [healthSystemId],
      resultCount: 4,
      ok: true,
      errorCode: null,
      durationMs: 37,
      jq: null,
    });
  });

  it("records a jq program's fingerprint and counts, from migration 0011's columns", async () => {
    const repos = testRepos();
    const jq = { sha256: "a".repeat(64), length: 42, inputCount: 12, outputCount: 3 };

    const ok = await repos.mcpAudit.insert({ tool: "get_vitals", jq });
    const failed = await repos.mcpAudit.insert({
      tool: "get_vitals",
      ok: false,
      errorCode: "jq_error",
      jq: { ...jq, outputCount: null },
    });

    const okRow = await repos.mcpAudit.get(ok);
    const failedRow = await repos.mcpAudit.get(failed);

    expect(okRow?.jq).toStrictEqual(jq);
    expect(failedRow?.jq).toStrictEqual({ ...jq, outputCount: null });
  });

  it("defaults to a successful call with no health systems and no results", async () => {
    const repos = testRepos();

    const id = await repos.mcpAudit.insert({ tool: "list_health_systems" });

    expect(await repos.mcpAudit.get(id)).toMatchObject({
      healthSystems: [],
      resultCount: 0,
      ok: true,
      clientId: null,
      durationMs: null,
    });
  });

  it("records a failure with its code", async () => {
    const repos = testRepos();

    const id = await repos.mcpAudit.insert({
      tool: "get_lab_results",
      ok: false,
      errorCode: "policy_denied",
    });

    expect(await repos.mcpAudit.get(id)).toMatchObject({ ok: false, errorCode: "policy_denied" });
  });

  it("returns null for an id it does not have", async () => {
    const repos = testRepos();

    expect(await repos.mcpAudit.get("NOPE")).toBeNull();
  });
});

describe("mcp_audit.listRecent and countsByTool", () => {
  it("lists newest first and honours the limit", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    await repos.mcpAudit.insert({ tool: "first" });
    time.advance(60);
    await repos.mcpAudit.insert({ tool: "second" });
    time.advance(60);
    await repos.mcpAudit.insert({ tool: "third" });

    expect(await column(repos.mcpAudit.listRecent(), "tool")).toStrictEqual([
      "third",
      "second",
      "first",
    ]);
    expect(await repos.mcpAudit.listRecent(2)).toHaveLength(2);
  });

  it("counts calls and failures per tool", async () => {
    const repos = testRepos();

    await repos.mcpAudit.insert({ tool: "get_vitals" });
    await repos.mcpAudit.insert({ tool: "get_vitals", ok: false, errorCode: "internal" });
    await repos.mcpAudit.insert({ tool: "list_health_systems" });

    expect(await repos.mcpAudit.countsByTool()).toStrictEqual([
      { tool: "get_vitals", calls: 2, failures: 1 },
      { tool: "list_health_systems", calls: 1, failures: 0 },
    ]);
  });

  it("counts only inside the window it is given", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    await repos.mcpAudit.insert({ tool: "old" });
    time.advance(3600);
    await repos.mcpAudit.insert({ tool: "new" });

    expect(await column(repos.mcpAudit.countsByTool(T0 + 1), "tool")).toStrictEqual(["new"]);
  });
});

describe("mcp_audit.prune", () => {
  it("drops rows past the one-year retention and keeps the rest", async () => {
    const time = clock(T0 + AUDIT_RETENTION_DAYS * DAY_SECONDS * 2);
    const repos = testRepos({ now: time.now });

    // Two rows a year and a half apart, seen from "now" at the later end.
    await repos.ctx.db
      .prepare("INSERT INTO mcp_audit (id, ts, tool) VALUES ('OLD', ?, 'stale')")
      .bind(T0)
      .run();
    await repos.mcpAudit.insert({ tool: "fresh" });

    expect(await repos.mcpAudit.prune()).toBe(1);
    expect(await column(repos.mcpAudit.listRecent(), "tool")).toStrictEqual(["fresh"]);
  });

  it("takes a shorter retention when asked", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    await repos.mcpAudit.insert({ tool: "yesterday" });
    time.advance(2 * DAY_SECONDS);
    await repos.mcpAudit.insert({ tool: "today" });

    expect(await repos.mcpAudit.prune(1)).toBe(1);
    expect(await repos.mcpAudit.listRecent()).toHaveLength(1);
  });

  it("does nothing when there is nothing old enough", async () => {
    const repos = testRepos();

    await repos.mcpAudit.insert({ tool: "recent" });

    expect(await repos.mcpAudit.prune()).toBe(0);
  });
});

describe("mcp_policy", () => {
  it("adds a rule and returns it", async () => {
    const repos = testRepos();

    const rule = await repos.mcpPolicy.add("field", "Observation.note", "free text");

    expect(rule.rule_type).toBe("field");
    expect(rule.target).toBe("Observation.note");
    expect(rule.note).toBe("free text");
    expect(rule.created_at).toBe(T0);
  });

  it("treats adding the same rule twice as a no-op", async () => {
    const repos = testRepos();

    const first = await repos.mcpPolicy.add("tool", "get_documents");
    const second = await repos.mcpPolicy.add("tool", "get_documents", "note is ignored");

    expect(second.id).toBe(first.id);
    expect(second.note).toBeNull();
    expect(await repos.mcpPolicy.list()).toHaveLength(1);
  });

  it("keeps the same target under a different rule type", async () => {
    // Uniqueness is on the pair: denying the tool `get_documents` and the
    // resource `DocumentReference` are different rules.
    const repos = testRepos();

    await repos.mcpPolicy.add("tool", "shared-name");
    await repos.mcpPolicy.add("resource", "shared-name");

    expect(await repos.mcpPolicy.list()).toHaveLength(2);
  });

  it("lists in a stable order and can list the targets of one type", async () => {
    const repos = testRepos();

    await repos.mcpPolicy.add("resource", "DocumentReference");
    await repos.mcpPolicy.add("tool", "get_documents");
    await repos.mcpPolicy.add("field", "Observation.note");

    expect(await column(repos.mcpPolicy.list(), "rule_type")).toStrictEqual([
      "field",
      "resource",
      "tool",
    ]);
    expect(await repos.mcpPolicy.targetsOf("resource")).toStrictEqual(["DocumentReference"]);
    expect(await repos.mcpPolicy.targetsOf("health_system")).toStrictEqual([]);
  });

  it("removes by id and reports whether anything went", async () => {
    const repos = testRepos();
    const rule = await repos.mcpPolicy.add("tool", "get_documents");

    expect(await repos.mcpPolicy.remove(rule.id)).toBe(true);
    expect(await repos.mcpPolicy.remove(rule.id)).toBe(false);
    expect(await repos.mcpPolicy.get("tool", "get_documents")).toBeNull();
  });
});
