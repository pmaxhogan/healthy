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
import { explainSyncCode, explainSyncWarnings } from "../../sync/sync-state-codes.ts";
import { sharedOnlyArgs } from "../args.ts";
import { effectiveLimit, selectHealthSystems } from "../collect.ts";
import { syncStatusOf } from "../coverage.ts";
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
    // The FHIR connection above and the patient portal are separate: a
    // portal-only health system is `not_connected` on FHIR while its portal syncs.
    portalState: healthSystem.portal?.state ?? "no_portal",
    portalLastOkAt: iso(healthSystem.portal?.lastOkAt ?? null),
    portalLastErrorCode: healthSystem.portal?.lastErrorCode ?? null,
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
      schema: sharedOnlyArgs("list_health_systems"),
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
        jq: args.jq,
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
        "How fresh the cached record is -- the detail behind every other tool's " +
        "`coverage`. Many rows: first one `kind: health_system` row per health " +
        "system (as list_health_systems gives), then one `kind: resource_sync` row " +
        "per resource type per health system, typically two dozen each. A " +
        "resource_sync row has `healthSystem`, `healthSystemId`, `resourceType`, " +
        "`status` (coverage's vocabulary: ok, partial, stale, failed, unsupported, " +
        "never), `lastFullAt` (last successful refresh), `lastOk`, `lastErrorCode` " +
        "and `lastError` ({code, meaning, severity}, or null), and `warnings`: " +
        "what the health system reported on the last refresh, as " +
        "{code, count, meaning, severity}. Severity `info` (e.g. 4101 no " +
        "results, 4119 a patient's view may not be the complete record, 59204 " +
        "records from payers or other organisations not included) means the " +
        "search worked and nothing needs doing; `warning`, `error` and `unknown` " +
        "are the ones worth reading. `unsupported` means the health system does " +
        "not offer that type to patient apps (commonly Specimen) and is " +
        "harmless. Filter with `jq` rather than reading every row.",
      schema: sharedOnlyArgs("get_sync_status"),
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
          status: syncStatusOf(entry, run.now),
          lastFullAt: iso(entry.lastFullAt),
          lastOk: entry.lastOk,
          lastErrorCode: entry.lastErrorCode,
          lastError:
            entry.lastErrorCode === null
              ? null
              : { code: entry.lastErrorCode, ...explainSyncCode(entry.lastErrorCode) },
          warnings: explainSyncWarnings(entry.warnings),
        });
      }

      return respond({
        tool: "get_sync_status",
        rules: run.rules,
        items,
        limit: effectiveLimit(args.limit),
        jq: args.jq,
        healthSystemIds: healthSystems.map((healthSystem) => healthSystem.id),
        now: run.now,
      });
    },
  );
}
