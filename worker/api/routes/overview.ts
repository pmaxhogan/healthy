/**
 * `GET /api/overview` -- the dashboard, in one request.
 *
 * One round trip rather than nine, because the SPA's first screen needs all of it
 * and nine parallel fetches through Cloudflare Access is nine identity checks.
 *
 * Everything here is counts, statuses and timestamps. The two numeric panels are
 * deliberately *derived* rather than stored: `cacheCounts` is a `GROUP BY` over
 * `fhir_cache` (row counts only -- nothing is decrypted to produce them) and
 * `calendarEvents` is a `GROUP BY` over `calendar_events`, which holds no clinical
 * content at all.
 *
 * The grant count is the one thing allowed to fail quietly. Grants live in the
 * OAuth provider's KV store, not in D1, so an unreachable or unwired store would
 * otherwise take down the whole dashboard -- including the parts that would tell
 * the owner what is wrong.
 */

import { Hono } from "hono";

import { all, one } from "../../db/client.ts";
import { getAllSettings } from "../../db/settings.ts";
import { isAppError } from "../../lib/errors.ts";
import { logLine } from "../../lib/log.ts";
import { DAY_SECONDS } from "../../lib/time.ts";
import { isDiscoveryCacheType } from "../../sync/index.ts";
import { toAlertDto, toRunDto, toSettingsDto } from "../dto.ts";
import { NO_STORE, apiContext } from "../http.ts";

import { projectGoogle } from "./google.ts";
import { listProviderDtos } from "./providers.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";
import type { CalendarEventState } from "../../db/rows.ts";
import type { Env } from "../../env.ts";
import type { ApiContext } from "../http.ts";
import type { OverviewDto } from "@shared/types.ts";

/**
 * Row counts the owner would recognise as "cached records".
 *
 * `fhir_cache` also holds the sync engine's own bookkeeping -- one `_smart` row and
 * one `_capability` row per provider, which are a discovery document and an indexed
 * CapabilityStatement, not clinical resources. Counting those on the dashboard would
 * report two cached "records" for a provider that has never been synced.
 */
function clinicalCounts(
  counts: readonly { providerId: string; resourceType: string; count: number }[],
): { providerId: string; resourceType: string; count: number }[] {
  return counts.filter((entry) => !isDiscoveryCacheType(entry.resourceType));
}

/** Runs shown on the dashboard. Enough to see a pattern, few enough to scan. */
const OVERVIEW_RUNS = 10;

export const overviewRouter = new Hono<AppHonoEnv>();

/** Active and ghosted event counts, straight out of SQL. */
async function countCalendarEvents(api: ApiContext): Promise<{ active: number; ghost: number }> {
  const rows = await all<{ state: CalendarEventState; n: number }>(
    api.ctx.db.prepare("SELECT state, COUNT(*) AS n FROM calendar_events GROUP BY state"),
  );
  const counts = { active: 0, ghost: 0 };
  for (const row of rows) {
    if (row.state === "ghost") counts.ghost = row.n;
    else counts.active = row.n;
  }
  return counts;
}

/** MCP tool calls in the last 24 hours. Metadata rows; no content exists to count. */
async function countRecentAudit(api: ApiContext): Promise<number> {
  const row = await one<{ n: number }>(
    api.ctx.db
      .prepare("SELECT COUNT(*) AS n FROM mcp_audit WHERE ts >= ?")
      .bind(api.ctx.now() - DAY_SECONDS),
  );
  return row?.n ?? 0;
}

/** Grants, or zero with a logged code. See the module comment. */
async function countGrants(api: ApiContext, env: Env): Promise<number> {
  try {
    const grants = await api.ports.grants.listGrants(env);
    return grants.length;
  } catch (error) {
    logLine("warn", "api_grants_unavailable", {
      errorCode: isAppError(error) ? error.code : "unknown",
    });
    return 0;
  }
}

overviewRouter.get("/", async (c) => {
  const api = apiContext(c);

  const [providers, google, alertRows, runEntries, cacheCounts, settings] = await Promise.all([
    listProviderDtos(api),
    projectGoogle(api),
    api.repos.alerts.listOpen(),
    api.repos.runLog.listRecent({ limit: OVERVIEW_RUNS }),
    api.repos.fhirCache.countsByType(),
    getAllSettings(api.ctx),
  ]);
  const [calendarEvents, auditLast24h, grants, policyRules] = await Promise.all([
    countCalendarEvents(api),
    countRecentAudit(api),
    countGrants(api, c.env),
    api.repos.mcpPolicy.list(),
  ]);

  const overview: OverviewDto = {
    providers,
    google,
    openAlerts: alertRows.map((row) => toAlertDto(row)),
    lastRuns: runEntries.map((entry) => toRunDto(entry)),
    cacheCounts: clinicalCounts(cacheCounts),
    calendarEvents,
    mcp: {
      enabled: settings.mcp_enabled,
      grants,
      auditLast24h,
      policyRules: policyRules.length,
    },
    settings: toSettingsDto(settings),
  };
  return c.json(overview, 200, NO_STORE);
});
