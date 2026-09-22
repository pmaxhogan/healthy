/**
 * Which providers a run should touch.
 *
 * Deliberately *not* `connections.listActive()`, which returns only
 * `status = 'connected'`. A provider that failed transiently is marked `error` by
 * the token manager, and if the cron only ever looked at `connected` rows a single
 * 500 from a token endpoint would take that organisation off the schedule until
 * somebody noticed by hand. `error` is therefore retried every run, and a
 * successful refresh clears it back to `connected`.
 *
 * `needs_reauth` is the one status that is skipped, because retrying it cannot
 * work: the grant is gone and only the owner can bring it back. The alert opened
 * when it was marked is what asks them to.
 */

import { parseJsonColumn, providerConfigSchema } from "../db/schemas.ts";

import type { Repos } from "../db/index.ts";
import type { ConnectionRow, ProviderRow } from "../db/rows.ts";
import type { ProviderConfig } from "../db/schemas.ts";

/** Statuses a scheduled run will attempt. See the module comment. */
const RETRYABLE: ReadonlySet<string> = new Set(["connected", "error"]);

export interface SyncTarget {
  provider: ProviderRow;
  connection: ConnectionRow;
  /** `providers.config_json`, parsed. */
  config: ProviderConfig;
}

/**
 * The providers to sync, in display-name order.
 *
 * `providerIds`, when given, narrows the list -- that is the admin UI's "sync this
 * one now" button -- but never widens it: a provider that is soft-deleted, not
 * connected, or switched off in its own config is skipped however it was asked
 * for.
 */
export async function syncTargets(
  repos: Repos,
  providerIds?: readonly string[],
): Promise<SyncTarget[]> {
  const wanted = providerIds === undefined ? null : new Set(providerIds);
  const providers = await repos.providers.list();
  const targets: SyncTarget[] = [];
  for (const provider of providers) {
    if (wanted !== null && !wanted.has(provider.id)) continue;
    const connection = await repos.connections.getForProvider(provider.id);
    if (connection === null || !RETRYABLE.has(connection.status)) continue;
    const config = parseJsonColumn(
      providerConfigSchema,
      provider.config_json,
      `providers.config_json.${provider.id}`,
    );
    if (!config.enabled) continue;
    targets.push({ provider, connection, config });
  }
  return targets;
}
