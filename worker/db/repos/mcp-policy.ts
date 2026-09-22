/**
 * The MCP exposure deny-list.
 *
 * Allow-all with a deny-list: absent a matching rule, data is exposed. The rules
 * are read by the single server-side filter in `worker/policy/` and applied
 * before serialisation, which is the only place they can be enforced completely.
 *
 * `(rule_type, target)` is unique, so adding the same rule twice is a no-op that
 * returns the existing row rather than an error -- the admin UI can be fire and
 * forget.
 */

import { newId } from "../../lib/ids.ts";
import { all, one, run } from "../client.ts";

import type { Ctx } from "../client.ts";
import type { McpPolicyRow, PolicyRuleType } from "../rows.ts";

export function makeMcpPolicyRepo(ctx: Ctx) {
  const find = async (ruleType: PolicyRuleType, target: string): Promise<McpPolicyRow | null> =>
    one<McpPolicyRow>(
      ctx.db
        .prepare("SELECT * FROM mcp_policy WHERE rule_type = ? AND target = ?")
        .bind(ruleType, target),
    );

  return {
    /** Add a rule, or return the one that is already there. */
    async add(ruleType: PolicyRuleType, target: string, note?: string): Promise<McpPolicyRow> {
      await run(
        ctx.db
          .prepare(
            `INSERT INTO mcp_policy (id, rule_type, target, note, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (rule_type, target) DO NOTHING`,
          )
          .bind(newId(), ruleType, target, note ?? null, ctx.now()),
      );
      const row = await find(ruleType, target);
      if (row === null) throw new Error("mcp_policy row disappeared after insert");
      ctx.log.info("mcp_policy.added", { ruleType, target });
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
        ctx.db.prepare("SELECT * FROM mcp_policy ORDER BY rule_type, target"),
      );
    },

    /** Just the targets of one rule kind, which is what the filter wants. */
    async targetsOf(ruleType: PolicyRuleType): Promise<string[]> {
      const rows = await all<Pick<McpPolicyRow, "target">>(
        ctx.db
          .prepare("SELECT target FROM mcp_policy WHERE rule_type = ? ORDER BY target")
          .bind(ruleType),
      );
      return rows.map((row) => row.target);
    },

    get: find,
  };
}
