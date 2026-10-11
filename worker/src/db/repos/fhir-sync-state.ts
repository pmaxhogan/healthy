/**
 * Per (health system, resource type) health of the daily full refresh.
 *
 * Kept separate from `run_log` because the useful question is not "how did last
 * night go" but "which resource types has this org never returned anything for" --
 * that is what tells the owner a scope is missing or an org does not support a
 * type, and it has to survive every subsequent successful run.
 *
 * `warnings_json` holds OperationOutcome codes with counts, never their text: the
 * text can quote the request, and the request carries a patient id.
 */

import { all, one, run } from "../client.ts";
import { parseJsonColumn, syncWarningsSchema } from "../schemas.ts";

import type { Ctx } from "../client.ts";
import type { FhirSyncStateRow } from "../rows.ts";
import type { SyncWarning } from "../schemas.ts";

export interface SyncState {
  healthSystemId: string;
  resourceType: string;
  lastFullAt: number | null;
  lastOk: boolean;
  lastErrorCode: string | null;
  warnings: SyncWarning[];
}

interface RecordInput {
  ok: boolean;
  errorCode?: string | null;
  warnings?: readonly SyncWarning[];
}

function decode(row: FhirSyncStateRow): SyncState {
  return {
    healthSystemId: row.health_system_id,
    resourceType: row.resource_type,
    lastFullAt: row.last_full_at,
    lastOk: row.last_ok === 1,
    lastErrorCode: row.last_error_code,
    warnings: parseJsonColumn(
      syncWarningsSchema,
      row.warnings_json,
      `fhir_sync_state.warnings_json.${row.health_system_id}:${row.resource_type}`,
    ),
  };
}

export function makeFhirSyncStateRepo(ctx: Ctx) {
  return {
    /** Record the outcome of one (health system, resource type) pass. */
    async record(healthSystemId: string, resourceType: string, input: RecordInput): Promise<void> {
      await run(
        ctx.db
          .prepare(
            `INSERT INTO fhir_sync_state
               (health_system_id, resource_type, last_full_at, last_ok, last_error_code, warnings_json)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (health_system_id, resource_type) DO UPDATE SET
               last_full_at = excluded.last_full_at,
               last_ok = excluded.last_ok,
               last_error_code = excluded.last_error_code,
               warnings_json = excluded.warnings_json`,
          )
          .bind(
            healthSystemId,
            resourceType,
            ctx.now(),
            input.ok ? 1 : 0,
            input.errorCode ?? null,
            JSON.stringify(input.warnings ?? []),
          ),
      );
    },

    async get(healthSystemId: string, resourceType: string): Promise<SyncState | null> {
      const row = await one<FhirSyncStateRow>(
        ctx.db
          .prepare("SELECT * FROM fhir_sync_state WHERE health_system_id = ? AND resource_type = ?")
          .bind(healthSystemId, resourceType),
      );
      return row === null ? null : decode(row);
    },

    async listByHealthSystem(healthSystemId: string): Promise<SyncState[]> {
      const rows = await all<FhirSyncStateRow>(
        ctx.db
          .prepare(
            "SELECT * FROM fhir_sync_state WHERE health_system_id = ? ORDER BY resource_type",
          )
          .bind(healthSystemId),
      );
      return rows.map((row) => decode(row));
    },

    /** Everything, for the admin overview. */
    async list(): Promise<SyncState[]> {
      const rows = await all<FhirSyncStateRow>(
        ctx.db.prepare("SELECT * FROM fhir_sync_state ORDER BY health_system_id, resource_type"),
      );
      return rows.map((row) => decode(row));
    },
  };
}
