// Migration 0012: legacy `field` rules become structured ones.
//
// There are no stored rules in production today, but the migration has to be
// right for the day there are: a legacy row converted wrongly is a rule the
// owner believes in that removes nothing. The real statements from
// migrations/0012 are run, in real D1, against a copy of the table in its 0010
// shape (renamed, so the live table the other tests use is untouched), and the
// converted rows are then read by the real policy engine.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { buildRules, fieldSpecOf } from "../../../worker/policy/rules.ts";

import type { McpPolicyRow } from "../../../worker/db/rows.ts";

const TABLE = "mig_policy";

/** 0012's statements, aimed at the scratch table instead of the live one. */
function migrationQueries(): string[] {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0012_"));
  if (migration === undefined) throw new Error("migration 0012 is missing");
  return migration.queries.map((query) =>
    query
      .replaceAll(/\bmcp_policy_rule\b/gu, "mig_policy_rule")
      .replaceAll(/\bmcp_policy\b/gu, "mig_policy"),
  );
}

async function createLegacyTable(rows: [string, string, string][]): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DROP TABLE IF EXISTS ${TABLE}`),
    // The 0010 shape.
    env.DB.prepare(
      `CREATE TABLE ${TABLE} (
         id TEXT PRIMARY KEY, rule_type TEXT NOT NULL, target TEXT NOT NULL, note TEXT,
         created_at INTEGER NOT NULL,
         CHECK (rule_type IN ('tool', 'resource', 'field', 'health_system')))`,
    ),
    env.DB.prepare(`CREATE UNIQUE INDEX ${TABLE}_rule ON ${TABLE} (rule_type, target)`),
    ...rows.map(([id, ruleType, target]) =>
      env.DB.prepare(
        `INSERT INTO ${TABLE} (id, rule_type, target, note, created_at) VALUES (?, ?, ?, NULL, 0)`,
      ).bind(id, ruleType, target),
    ),
  ]);
}

async function migrated(): Promise<Map<string, McpPolicyRow>> {
  for (const query of migrationQueries()) await env.DB.prepare(query).run();
  const { results } = await env.DB.prepare(`SELECT * FROM ${TABLE}`).all<McpPolicyRow>();
  return new Map(results.map((row) => [row.id, row]));
}

afterEach(async () => {
  await env.DB.prepare(`DROP TABLE IF EXISTS ${TABLE}`).run();
});

describe("migration 0012", () => {
  it("converts every legacy field rule to columns the engine reads the same way", async () => {
    await createLegacyTable([
      ["plain", "field", "Observation.component[].valueQuantity.value"],
      ["wild", "field", "*.lastUpdated"],
      ["allow", "field", "allow:Patient.birthDate"],
      ["tool", "tool", "get_documents"],
      ["broken", "field", "Patient"],
    ]);

    const rows = await migrated();

    expect(rows.get("plain")).toMatchObject({
      enabled: 1,
      effect: "hide",
      scope_resource: "Observation",
      scope_tool: null,
      scope_health_system: null,
      paths_json: '["component[].valueQuantity.value"]',
    });
    expect(rows.get("wild")).toMatchObject({ scope_resource: null, paths_json: '["lastUpdated"]' });
    expect(rows.get("allow")).toMatchObject({
      effect: "allow",
      scope_resource: "Patient",
      paths_json: '["birthDate"]',
    });
    // Other kinds are untouched but gain the switch.
    expect(rows.get("tool")).toMatchObject({
      enabled: 1,
      paths_json: null,
      target: "get_documents",
    });
    // A target that never parsed stays legacy, and is still reported.
    expect(rows.get("broken")?.paths_json).toBeNull();

    const stored = await env.DB.prepare(
      `SELECT * FROM ${TABLE} ORDER BY rowid`,
    ).all<McpPolicyRow>();
    const engine = buildRules(stored.results);
    expect(engine.unparsed).toStrictEqual(["Patient"]);
    expect(engine.fields.map((rule) => [rule.resourceType, rule.display])).toStrictEqual([
      ["Observation", "component[].valueQuantity.value"],
      [null, "lastUpdated"],
    ]);
    expect(engine.allows.map((rule) => [rule.resourceType, rule.display])).toStrictEqual([
      ["Patient", "birthDate"],
    ]);
    // Read back for the admin UI exactly as the legacy parser would have.
    expect(fieldSpecOf(rows.get("plain")!)).toStrictEqual({
      effect: "hide",
      tool: null,
      resourceType: "Observation",
      healthSystemId: null,
      paths: ["component[].valueQuantity.value"],
    });
  });

  it("keeps (rule_type, target) unique for the other kinds, but not for field rules", async () => {
    await createLegacyTable([]);
    await migrated();

    await env.DB.prepare(
      `INSERT INTO ${TABLE} (id, rule_type, target, created_at) VALUES ('a', 'tool', 'x', 0)`,
    ).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO ${TABLE} (id, rule_type, target, created_at) VALUES ('b', 'tool', 'x', 0)`,
      ).run(),
    ).rejects.toThrow();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ${TABLE} (id, rule_type, target, created_at) VALUES ('c', 'field', 'y', 0)`,
      ),
      env.DB.prepare(
        `INSERT INTO ${TABLE} (id, rule_type, target, created_at) VALUES ('d', 'field', 'y', 0)`,
      ),
    ]);
    await expect(
      env.DB.prepare(
        `INSERT INTO ${TABLE} (id, rule_type, target, created_at, effect) VALUES ('e', 'field', 'z', 0, 'maybe')`,
      ).run(),
    ).rejects.toThrow();
  });
});
