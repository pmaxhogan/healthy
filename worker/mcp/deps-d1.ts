/**
 * The real {@link ToolDeps}: D1, the FHIR read cache, and one door to the sync
 * engine for document bodies.
 *
 * Everything is memoised for the length of one tool call and dropped at the start
 * of the next (`beginCall`). That is what makes a twenty-four-row summary one
 * query per resource type rather than one per item, while still letting the owner
 * switch the MCP off and have it take effect on the very next call rather than
 * whenever the client happens to reconnect.
 *
 * Note what this file does NOT expose upward: no `Env`, no `Repos`, no `fetch`, no
 * token, no write path except the audit row. The `ToolDeps` interface is the
 * whole of what a tool can do, and this is the only place that decides what that
 * means.
 */

import { reposFor } from "../db/index.ts";
import { parseJsonColumn, providerConfigSchema } from "../db/schemas.ts";
import { getSetting } from "../db/settings.ts";
import { makeLogger } from "../lib/log.ts";
import { nowSeconds } from "../lib/time.ts";
import { buildRules } from "../policy/rules.ts";

import { documentText } from "./binary.ts";
import { REFERENCE_TYPES } from "./collect.ts";
import { CACHE_SCAN_LIMIT } from "./deps.ts";

import type {
  AuditRecord,
  CacheCount,
  CachedRow,
  CallerIdentity,
  DocumentTextRequest,
  DocumentTextResult,
  ProviderInfo,
  SyncStatusEntry,
  ToolDeps,
} from "./deps.ts";
import type { Repos } from "../db/index.ts";
import type { ConnectionRow, ProviderRow } from "../db/rows.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../lib/log.ts";
import type { PolicyRules } from "../policy/rules.ts";

export interface ToolDepsOptions {
  env: Env;
  /** Taken from the OAuth grant's props. Recorded on every audit row. */
  caller: CallerIdentity;
  log?: Logger;
  /** Unix seconds. Overridden by tests. */
  now?: () => number;
}

/** Everything memoised for one tool call. Replaced wholesale by `beginCall`. */
interface CallCache {
  enabled: Promise<boolean> | null;
  rules: Promise<PolicyRules> | null;
  providers: Promise<ProviderInfo[]> | null;
  counts: Promise<CacheCount[]> | null;
  syncStatus: Promise<SyncStatusEntry[]> | null;
  pools: Map<string, Promise<unknown[]>>;
  resources: Map<string, Promise<CachedRow[]>>;
}

function emptyCache(): CallCache {
  return {
    enabled: null,
    rules: null,
    providers: null,
    counts: null,
    syncStatus: null,
    pools: new Map(),
    resources: new Map(),
  };
}

function providerInfo(row: ProviderRow, connection: ConnectionRow | undefined): ProviderInfo {
  const config = parseJsonColumn(
    providerConfigSchema,
    row.config_json,
    `providers.config_json.${row.id}`,
  );
  return {
    id: row.id,
    displayName: row.display_name,
    environment: row.environment,
    portalUrl: row.portal_url,
    enabled: config.enabled,
    status: connection?.status ?? "not_connected",
    lastSyncAt: connection?.last_sync_at ?? null,
    lastFullRefreshAt: connection?.last_full_refresh_at ?? null,
    lastErrorCode: connection?.last_error_code ?? null,
    needsReauthSince: connection?.needs_reauth_since ?? null,
  };
}

async function loadRules(repos: Repos): Promise<PolicyRules> {
  return buildRules(await repos.mcpPolicy.list());
}

/** One resource type for one provider, projected to what the tools read. */
async function loadRows(
  repos: Repos,
  providerId: string,
  resourceType: string,
): Promise<CachedRow[]> {
  const rows = await repos.fhirCache.listByType(providerId, resourceType, {
    limit: CACHE_SCAN_LIMIT,
  });
  return rows.map((row) => ({
    resource: row.resource,
    lastUpdated: row.lastUpdated,
    fetchedAt: row.fetchedAt,
  }));
}

/** Everything one provider's references can resolve against, in one pool. */
async function loadReferencePool(repos: Repos, providerId: string): Promise<unknown[]> {
  const groups = await Promise.all(
    REFERENCE_TYPES.map((resourceType) =>
      repos.fhirCache.listByType(providerId, resourceType, { limit: CACHE_SCAN_LIMIT }),
    ),
  );
  return groups.flat().map((row) => row.resource);
}

async function loadProviders(repos: Repos): Promise<ProviderInfo[]> {
  const [rows, connections] = await Promise.all([repos.providers.list(), repos.connections.list()]);
  const byProvider = new Map(connections.map((row) => [row.provider_id, row]));
  return rows.map((row) => providerInfo(row, byProvider.get(row.id)));
}

export function makeToolDeps(options: ToolDepsOptions): ToolDeps {
  const log = options.log ?? makeLogger({ src: "mcp" });
  const now = options.now ?? ((): number => nowSeconds());
  const repos = reposFor(options.env.DB, options.env, { log, now });
  let cache = emptyCache();

  return {
    log,
    caller: options.caller,

    beginCall(): void {
      cache = emptyCache();
    },

    now,

    mcpEnabled(): Promise<boolean> {
      cache.enabled ??= getSetting(repos.ctx, "mcp_enabled");
      return cache.enabled;
    },

    rules(): Promise<PolicyRules> {
      cache.rules ??= loadRules(repos);
      return cache.rules;
    },

    providers(): Promise<ProviderInfo[]> {
      cache.providers ??= loadProviders(repos);
      return cache.providers;
    },

    resources(providerId: string, resourceType: string): Promise<CachedRow[]> {
      const key = `${providerId}:${resourceType}`;
      let pending = cache.resources.get(key);
      if (pending === undefined) {
        pending = loadRows(repos, providerId, resourceType);
        cache.resources.set(key, pending);
      }
      return pending;
    },

    referencePool(providerId: string): Promise<unknown[]> {
      let pending = cache.pools.get(providerId);
      if (pending === undefined) {
        pending = loadReferencePool(repos, providerId);
        cache.pools.set(providerId, pending);
      }
      return pending;
    },

    counts(): Promise<CacheCount[]> {
      cache.counts ??= repos.fhirCache.countsByType();
      return cache.counts;
    },

    syncStatus(): Promise<SyncStatusEntry[]> {
      cache.syncStatus ??= repos.fhirSyncState.list();
      return cache.syncStatus;
    },

    documentText(input: DocumentTextRequest): Promise<DocumentTextResult> {
      return documentText({ repos, log }, input.providerId, input.documentId);
    },

    async recordAudit(entry: AuditRecord): Promise<void> {
      await repos.mcpAudit.insert({
        tool: entry.tool,
        clientId: entry.clientId,
        grantId: entry.grantId,
        providers: entry.providerIds,
        resultCount: entry.resultCount,
        ok: entry.ok,
        errorCode: entry.errorCode,
        durationMs: entry.durationMs,
      });
    },

    async pruneAudit(): Promise<void> {
      await repos.mcpAudit.prune();
    },
  };
}
