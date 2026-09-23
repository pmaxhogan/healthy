/**
 * The MCP audit trail: who called which tool, when, and how much came back.
 *
 * Metadata only, by design -- the table has no column a result could be written
 * into, so no future change can quietly start logging content. Retention is one
 * year and `prune` is called from the daily cron.
 *
 * Ids are sortable, so `ORDER BY id DESC` and `ORDER BY ts DESC` agree and the
 * recent-first listing needs no tiebreaker.
 */

import { newId } from "../../lib/ids.ts";
import { DAY_SECONDS } from "../../lib/time.ts";
import { all, one, run } from "../client.ts";
import { parseJsonColumn, healthSystemIdsSchema } from "../schemas.ts";

import type { Ctx } from "../client.ts";
import type { McpAuditRow } from "../rows.ts";

interface AuditInput {
  tool: string;
  clientId?: string | null;
  grantId?: string | null;
  /** Which health systems the call touched. Ids, never names. */
  healthSystems?: readonly string[];
  resultCount?: number;
  ok?: boolean;
  errorCode?: string | null;
  durationMs?: number | null;
}

export interface AuditEntry {
  id: string;
  ts: number;
  clientId: string | null;
  grantId: string | null;
  tool: string;
  healthSystems: string[];
  resultCount: number;
  ok: boolean;
  errorCode: string | null;
  durationMs: number | null;
}

/** How long an audit row lives. Stated in the privacy page. */
export const AUDIT_RETENTION_DAYS = 365;

function decode(row: McpAuditRow): AuditEntry {
  return {
    id: row.id,
    ts: row.ts,
    clientId: row.client_id,
    grantId: row.grant_id,
    tool: row.tool,
    healthSystems: parseJsonColumn(
      healthSystemIdsSchema,
      row.health_systems_json,
      `mcp_audit.health_systems_json.${row.id}`,
    ),
    resultCount: row.result_count,
    ok: row.ok === 1,
    errorCode: row.error_code,
    durationMs: row.duration_ms,
  };
}

export function makeMcpAuditRepo(ctx: Ctx) {
  return {
    /** Record one tool call. Returns the row id. */
    async insert(input: AuditInput): Promise<string> {
      const id = newId();
      await run(
        ctx.db
          .prepare(
            `INSERT INTO mcp_audit
               (id, ts, client_id, grant_id, tool, health_systems_json, result_count, ok, error_code, duration_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            ctx.now(),
            input.clientId ?? null,
            input.grantId ?? null,
            input.tool,
            JSON.stringify(input.healthSystems ?? []),
            Math.max(0, input.resultCount ?? 0),
            (input.ok ?? true) ? 1 : 0,
            input.errorCode ?? null,
            input.durationMs ?? null,
          ),
      );
      return id;
    },

    async listRecent(limit = 100): Promise<AuditEntry[]> {
      const rows = await all<McpAuditRow>(
        ctx.db.prepare("SELECT * FROM mcp_audit ORDER BY ts DESC, id DESC LIMIT ?").bind(limit),
      );
      return rows.map((row) => decode(row));
    },

    async get(id: string): Promise<AuditEntry | null> {
      const row = await one<McpAuditRow>(
        ctx.db.prepare("SELECT * FROM mcp_audit WHERE id = ?").bind(id),
      );
      return row === null ? null : decode(row);
    },

    /** Drop rows older than the retention window. Returns how many went. */
    async prune(retentionDays = AUDIT_RETENTION_DAYS): Promise<number> {
      const cutoff = ctx.now() - retentionDays * DAY_SECONDS;
      const { changes } = await run(
        ctx.db.prepare("DELETE FROM mcp_audit WHERE ts < ?").bind(cutoff),
      );
      if (changes > 0) ctx.log.info("mcp_audit.pruned", { rows: changes, retentionDays });
      return changes;
    },

    /** Call counts per tool, newest window first. For the admin UI. */
    async countsByTool(since = 0): Promise<{ tool: string; calls: number; failures: number }[]> {
      const rows = await all<{ tool: string; calls: number; failures: number }>(
        ctx.db
          .prepare(
            `SELECT tool, COUNT(*) AS calls, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
               FROM mcp_audit WHERE ts >= ?
              GROUP BY tool ORDER BY calls DESC`,
          )
          .bind(since),
      );
      return rows;
    },
  };
}
