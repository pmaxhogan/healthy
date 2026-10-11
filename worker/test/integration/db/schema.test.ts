// The schema after 0010, as D1 actually has it: the renamed table, the foreign
// keys that followed it, and the rebuilt rule-type constraint.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const CHILDREN = [
  "connections",
  "oauth_states",
  "fhir_cache",
  "fhir_sync_state",
  "calendar_events",
  "portal_accounts",
  "portal_visits",
];

describe("the health_systems rename (0010)", () => {
  it("leaves no table, column or index named after a provider", async () => {
    const objects = await env.DB.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
    ).all<{ type: string; name: string; sql: string | null }>();

    for (const object of objects.results) {
      expect(object.name, object.name).not.toMatch(/provider/iu);
      expect(object.sql ?? "", object.name).not.toMatch(/provider/iu);
    }
  });

  it("points every child table's foreign key at health_systems", async () => {
    for (const table of CHILDREN) {
      const keys = await env.DB.prepare(
        `SELECT "table" AS target, "from" AS source FROM pragma_foreign_key_list(?)`,
      )
        .bind(table)
        .all<{ target: string; source: string }>();

      expect(keys.results, table).toContainEqual({
        target: "health_systems",
        source: "health_system_id",
      });
    }
  });

  it("accepts the health_system rule type and refuses the old name", async () => {
    await env.DB.prepare(
      "INSERT INTO mcp_policy (id, rule_type, target, created_at) VALUES ('r1', 'health_system', 'x', 0)",
    ).run();

    await expect(
      env.DB.prepare(
        "INSERT INTO mcp_policy (id, rule_type, target, created_at) VALUES ('r2', 'provider', 'x', 0)",
      ).run(),
    ).rejects.toThrow();
    await env.DB.prepare("DELETE FROM mcp_policy").run();
  });
});
