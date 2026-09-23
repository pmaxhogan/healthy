/**
 * Which health systems a run should touch.
 *
 * Deliberately *not* `connections.listActive()`, which returns only
 * `status = 'connected'`. A health system that failed transiently is marked `error` by
 * the token manager, and if the cron only ever looked at `connected` rows a single
 * 500 from a token endpoint would take that organisation off the schedule until
 * somebody noticed by hand. `error` is therefore retried every run, and a
 * successful refresh clears it back to `connected`.
 *
 * `needs_reauth` is the one status that is skipped, because retrying it cannot
 * work: the grant is gone and only the owner can bring it back. The alert opened
 * when it was marked is what asks them to.
 */

import { parseJsonColumn, healthSystemConfigSchema } from "../db/schemas.ts";

import type { Repos } from "../db/index.ts";
import type { ConnectionRow, HealthSystemRow } from "../db/rows.ts";
import type { HealthSystemConfig } from "../db/schemas.ts";

/** Statuses a scheduled run will attempt. See the module comment. */
const RETRYABLE: ReadonlySet<string> = new Set(["connected", "error"]);

export interface SyncTarget {
  healthSystem: HealthSystemRow;
  connection: ConnectionRow;
  /** `health_systems.config_json`, parsed. */
  config: HealthSystemConfig;
}

/**
 * The health systems to sync, in display-name order.
 *
 * `healthSystemIds`, when given, narrows the list -- that is the admin UI's "sync this
 * one now" button -- but never widens it: a health system that is soft-deleted, not
 * connected, or switched off in its own config is skipped however it was asked
 * for.
 */
export async function syncTargets(
  repos: Repos,
  healthSystemIds?: readonly string[],
): Promise<SyncTarget[]> {
  const wanted = healthSystemIds === undefined ? null : new Set(healthSystemIds);
  const healthSystems = await repos.healthSystems.list();
  const targets: SyncTarget[] = [];
  for (const healthSystem of healthSystems) {
    if (wanted !== null && !wanted.has(healthSystem.id)) continue;
    const connection = await repos.connections.getForHealthSystem(healthSystem.id);
    if (connection === null || !RETRYABLE.has(connection.status)) continue;
    const config = parseJsonColumn(
      healthSystemConfigSchema,
      healthSystem.config_json,
      `health_systems.config_json.${healthSystem.id}`,
    );
    if (!config.enabled) continue;
    targets.push({ healthSystem, connection, config });
  }
  return targets;
}
