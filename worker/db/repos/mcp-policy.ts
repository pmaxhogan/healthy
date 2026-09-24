/**
 * The MCP exposure deny-list.
 *
 * Allow-all with a deny-list: absent a matching rule, data is exposed. The rules
 * are read by the single server-side filter in `worker/policy/` and applied
 * before serialisation, which is the only place they can be enforced completely.
 *
 * Adding the same rule twice is a no-op that returns the existing row rather
 * than an error -- the admin UI can be fire and forget. For a `tool`,
 * `resource` or `health_system` rule "the same" is `(rule_type, target)`, which
 * a partial unique index enforces; for a `field` rule it is the signature the
 * caller computes (`fieldSignature` in `worker/policy/validate.ts`) and passes
 * as `target`, checked here.
 */

import { newId } from "../../lib/ids.ts";
import { all, one, run } from "../client.ts";

import type { Ctx } from "../client.ts";
import type { McpPolicyRow, PolicyRuleType } from "../rows.ts";

/** A `field` rule's columns, already validated and canonicalized by the caller. */
export interface FieldRuleColumns {
  /** The signature `target` is stored under. */
  target: string;
  effect: "hide" | "allow";
  tool: string | null;
  resourceType: string | null;
  healthSystemId: string | null;
  paths: readonly string[];
}

/** What `update` may change. Absent keys are left alone. */
export interface PolicyRulePatch {
  enabled?: boolean | undefined;
  note?: string | null | undefined;
  target?: string | undefined;
  field?: FieldRuleColumns | undefined;
}

/** A value bound into a D1 statement. */
type SqlValue = string | number | null;

/** The SET clause and its values for one patch, in a fixed column order. */
function patchColumns(patch: PolicyRulePatch): { sets: string[]; values: SqlValue[] } {
  const sets: string[] = [];
  const values: SqlValue[] = [];
  const set = (column: string, value: SqlValue): void => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);
  if (patch.note !== undefined) set("note", patch.note);
  if (patch.field !== undefined) {
    set("target", patch.field.target);
    set("effect", patch.field.effect);
    set("scope_tool", patch.field.tool);
    set("scope_resource", patch.field.resourceType);
    set("scope_health_system", patch.field.healthSystemId);
    set("paths_json", JSON.stringify(patch.field.paths));
  } else if (patch.target !== undefined) {
    set("target", patch.target);
  }
  return { sets, values };
}

export function makeMcpPolicyRepo(ctx: Ctx) {
  const find = async (ruleType: PolicyRuleType, target: string): Promise<McpPolicyRow | null> =>
    one<McpPolicyRow>(
      ctx.db
        .prepare(
          "SELECT * FROM mcp_policy WHERE rule_type = ? AND target = ? ORDER BY created_at LIMIT 1",
        )
        .bind(ruleType, target),
    );

  const byId = async (id: string): Promise<McpPolicyRow | null> =>
    one<McpPolicyRow>(ctx.db.prepare("SELECT * FROM mcp_policy WHERE id = ?").bind(id));

  return {
    /**
     * Add a `tool`, `resource` or `health_system` rule, or return the one already
     * there.
     *
     * A `field` target here is stored the pre-0012 way, as one
     * `ResourceType.path` string with no structured columns. The API never
     * writes one (it uses {@link addField}); the tests do, to pin that such a
     * row is still enforced.
     */
    async add(
      ruleType: PolicyRuleType,
      target: string,
      note?: string,
      enabled = true,
    ): Promise<McpPolicyRow> {
      const existing = ruleType === "field" ? await find(ruleType, target) : null;
      if (existing !== null) return existing;
      await run(
        ctx.db
          .prepare(
            `INSERT INTO mcp_policy (id, rule_type, target, note, created_at, enabled)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (rule_type, target) WHERE rule_type != 'field' DO NOTHING`,
          )
          .bind(newId(), ruleType, target, note ?? null, ctx.now(), enabled ? 1 : 0),
      );
      const row = await find(ruleType, target);
      if (row === null) throw new Error("mcp_policy row disappeared after insert");
      ctx.log.info("mcp_policy.added", { ruleType, target });
      return row;
    },

    /** Add a `field` rule, or return the one already stored under the same signature. */
    async addField(field: FieldRuleColumns, note?: string, enabled = true): Promise<McpPolicyRow> {
      const existing = await find("field", field.target);
      if (existing !== null) return existing;
      const id = newId();
      await run(
        ctx.db
          .prepare(
            `INSERT INTO mcp_policy (id, rule_type, target, note, created_at, enabled, effect,
                                     scope_tool, scope_resource, scope_health_system, paths_json)
             VALUES (?, 'field', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            field.target,
            note ?? null,
            ctx.now(),
            enabled ? 1 : 0,
            field.effect,
            field.tool,
            field.resourceType,
            field.healthSystemId,
            JSON.stringify(field.paths),
          ),
      );
      const row = await byId(id);
      if (row === null) throw new Error("mcp_policy row disappeared after insert");
      // The scope and the paths are the owner's configuration, not record
      // content, but a health system id has no business in a log line.
      ctx.log.info("mcp_policy.added", { ruleType: "field", ruleId: id });
      return row;
    },

    /** Change a rule in place. Null when there is no such rule. */
    async update(id: string, patch: PolicyRulePatch): Promise<McpPolicyRow | null> {
      const { sets, values } = patchColumns(patch);
      if (sets.length > 0) {
        await run(
          ctx.db
            .prepare(`UPDATE mcp_policy SET ${sets.join(", ")} WHERE id = ?`)
            .bind(...values, id),
        );
      }
      const row = await byId(id);
      if (row !== null && sets.length > 0) ctx.log.info("mcp_policy.updated", { ruleId: id });
      return row;
    },

    /** Remove a rule by id. False when there was nothing to remove. */
    async remove(id: string): Promise<boolean> {
      const { changes } = await run(ctx.db.prepare("DELETE FROM mcp_policy WHERE id = ?").bind(id));
      if (changes > 0) ctx.log.info("mcp_policy.removed", { ruleId: id });
      return changes > 0;
    },

    async list(): Promise<McpPolicyRow[]> {
      return all<McpPolicyRow>(
        ctx.db.prepare("SELECT * FROM mcp_policy ORDER BY rule_type, created_at, target"),
      );
    },

    /** Just the enabled targets of one rule kind. */
    async targetsOf(ruleType: PolicyRuleType): Promise<string[]> {
      const rows = await all<Pick<McpPolicyRow, "target">>(
        ctx.db
          .prepare(
            "SELECT target FROM mcp_policy WHERE rule_type = ? AND enabled = 1 ORDER BY target",
          )
          .bind(ruleType),
      );
      return rows.map((row) => row.target);
    },

    get: find,
    byId,
  };
}
