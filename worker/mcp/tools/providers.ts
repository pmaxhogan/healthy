/**
 * `list_providers` and `get_sync_status`: the two tools that describe the server
 * rather than the record.
 *
 * Both still go through `respond`, and so through the policy filter. That is not
 * ceremony. `list_providers` is exactly where a `provider` deny rule has to bite
 * -- a denied health system that still appears in a directory listing has been
 * announced, which is most of what the rule was meant to prevent -- and
 * `get_sync_status` names resource types, so a `resource` deny rule has to reach
 * it too or the deny-list would leak the shape of what it is hiding.
 */

import { toIso } from "../../lib/time.ts";
import { sharedOnlyArgs } from "../args.ts";
import { effectiveLimit, selectProviders } from "../collect.ts";
import { respond } from "../respond.ts";

import { readTool } from "./register.ts";

import type { ProviderInfo, ToolDeps } from "../deps.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** A unix-second column as an ISO instant, or null when it never happened. */
function iso(seconds: number | null): string | null {
  return seconds === null ? null : toIso(seconds);
}

function providerItem(provider: ProviderInfo): Record<string, unknown> {
  return {
    kind: "provider",
    provider: provider.displayName,
    providerId: provider.id,
    environment: provider.environment,
    enabled: provider.enabled,
    status: provider.status,
    portalUrl: provider.portalUrl,
    lastSyncAt: iso(provider.lastSyncAt),
    lastFullRefreshAt: iso(provider.lastFullRefreshAt),
    lastErrorCode: provider.lastErrorCode,
    needsReauthSince: iso(provider.needsReauthSince),
  };
}

export function registerProviderTools(server: McpServer, deps: ToolDeps): void {
  readTool(
    server,
    deps,
    {
      name: "list_providers",
      description:
        "The health systems this server holds a record from, with the id and " +
        "display name every other tool's `providers` argument accepts, and whether " +
        "each connection is healthy.",
      schema: sharedOnlyArgs(),
    },
    async (args, run) => {
      const providers = selectProviders(await deps.providers(), run.rules, args.providers);
      return respond({
        tool: "list_providers",
        rules: run.rules,
        items: providers.map((provider) => providerItem(provider)),
        limit: effectiveLimit(args.limit),
        providerIds: providers.map((provider) => provider.id),
        now: run.now,
      });
    },
  );

  readTool(
    server,
    deps,
    {
      name: "get_sync_status",
      description:
        "How fresh the cached record is: when each resource type was last " +
        "refreshed per health system, whether it worked, and any warnings the " +
        "organisation returned. Read this before trusting an empty result.",
      schema: sharedOnlyArgs(),
    },
    async (args, run) => {
      const providers = selectProviders(await deps.providers(), run.rules, args.providers);
      const names = new Map(providers.map((provider) => [provider.id, provider.displayName]));
      const status = await deps.syncStatus();

      const items: Record<string, unknown>[] = providers.map((provider) => providerItem(provider));
      for (const entry of status) {
        const name = names.get(entry.providerId);
        // A row for a provider this call is not about (or that the deny-list
        // removed) is skipped here rather than filtered later: without a display
        // name there is nothing to tag it with.
        if (name === undefined) continue;
        items.push({
          kind: "resource_sync",
          provider: name,
          providerId: entry.providerId,
          resourceType: entry.resourceType,
          lastFullAt: iso(entry.lastFullAt),
          lastOk: entry.lastOk,
          lastErrorCode: entry.lastErrorCode,
          warnings: entry.warnings,
        });
      }

      return respond({
        tool: "get_sync_status",
        rules: run.rules,
        items,
        limit: effectiveLimit(args.limit),
        providerIds: providers.map((provider) => provider.id),
        now: run.now,
      });
    },
  );
}
