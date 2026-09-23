/**
 * `list_health_systems` and `get_sync_status`: the two tools that describe the server
 * rather than the record.
 *
 * Both still go through `respond`, and so through the policy filter. That is not
 * ceremony. `list_health_systems` is exactly where a `health_system` deny rule has to bite
 * -- a denied health system that still appears in a directory listing has been
 * announced, which is most of what the rule was meant to prevent -- and
 * `get_sync_status` names resource types, so a `resource` deny rule has to reach
 * it too or the deny-list would leak the shape of what it is hiding.
 */

import { toIso } from "../../lib/time.ts";
import { sharedOnlyArgs } from "../args.ts";
import { effectiveLimit, selectHealthSystems } from "../collect.ts";
import { respond } from "../respond.ts";

import { readTool } from "./register.ts";

import type { HealthSystemInfo, ToolDeps } from "../deps.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** A unix-second column as an ISO instant, or null when it never happened. */
function iso(seconds: number | null): string | null {
  return seconds === null ? null : toIso(seconds);
}

function healthSystemItem(healthSystem: HealthSystemInfo): Record<string, unknown> {
  return {
    kind: "health_system",
    healthSystem: healthSystem.displayName,
    healthSystemId: healthSystem.id,
    environment: healthSystem.environment,
    enabled: healthSystem.enabled,
    status: healthSystem.status,
    portalUrl: healthSystem.portalUrl,
    lastSyncAt: iso(healthSystem.lastSyncAt),
    lastFullRefreshAt: iso(healthSystem.lastFullRefreshAt),
    lastErrorCode: healthSystem.lastErrorCode,
    needsReauthSince: iso(healthSystem.needsReauthSince),
  };
}

export function registerHealthSystemTools(server: McpServer, deps: ToolDeps): void {
  readTool(
    server,
    deps,
    {
      name: "list_health_systems",
      description:
        "The health systems this server holds a record from, with the id and " +
        "display name every other tool's `health_systems` argument accepts, and whether " +
        "each connection is healthy.",
      schema: sharedOnlyArgs(),
    },
    async (args, run) => {
      const healthSystems = selectHealthSystems(
        await deps.healthSystems(),
        run.rules,
        args.healthSystems,
      );
      return respond({
        tool: "list_health_systems",
        rules: run.rules,
        items: healthSystems.map((healthSystem) => healthSystemItem(healthSystem)),
        limit: effectiveLimit(args.limit),
        healthSystemIds: healthSystems.map((healthSystem) => healthSystem.id),
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
      const healthSystems = selectHealthSystems(
        await deps.healthSystems(),
        run.rules,
        args.healthSystems,
      );
      const names = new Map(
        healthSystems.map((healthSystem) => [healthSystem.id, healthSystem.displayName]),
      );
      const status = await deps.syncStatus();

      const items: Record<string, unknown>[] = healthSystems.map((healthSystem) =>
        healthSystemItem(healthSystem),
      );
      for (const entry of status) {
        const name = names.get(entry.healthSystemId);
        // A row for a health system this call is not about (or that the deny-list
        // removed) is skipped here rather than filtered later: without a display
        // name there is nothing to tag it with.
        if (name === undefined) continue;
        items.push({
          kind: "resource_sync",
          healthSystem: name,
          healthSystemId: entry.healthSystemId,
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
        healthSystemIds: healthSystems.map((healthSystem) => healthSystem.id),
        now: run.now,
      });
    },
  );
}
