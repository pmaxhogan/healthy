/**
 * Cron dispatch.
 *
 * Three expressions, all UTC (a comment translating any into local time would
 * disclose where the owner lives, which this repository must not do):
 *
 *   - `7 * * * *`  — hourly. Token keepalive for every connection including
 *     Google, then the Encounter-only calendar sync. The keepalive runs first on
 *     purpose: if a grant has died, the sync's own token calls would each discover
 *     it separately, and the alert is more useful before the sync than during it.
 *     Last, the alert sweep (`sweepReconnectAlerts`): anything left waiting for
 *     the owner that has no alert yet gets one.
 *   - `23 2,6,10,14,18,22 * * *` — every four hours. The full-scope refresh of
 *     the MCP's read cache, then a calendar sync, because the refresh has just
 *     filled the cache the sync's reference resolution reads from and will
 *     therefore make almost no upstream requests. Expired cache rows and stale OAuth states are pruned at the end.
 *   - `CRON_PORTAL_KEEPALIVE` -- every ten minutes. The portal session keepalive: one
 *     signed-in page load per live portal session, so the portal's idle timeout
 *     (shorter than an hour) never sees an hour of silence. It never signs in;
 *     see `portal-keepalive.ts`. Its minutes never coincide with the hourly
 *     run's. The same tick wakes the Health Connect ingest runner of every
 *     paired device (`worker/src/hc/store/poke.ts`): a safety net under the
 *     wake the ingest route does itself, and what notices a changed zone.
 *
 * An unrecognised cron string is logged and ignored rather than guessed at: a
 * schedule added to `wrangler.jsonc` without a branch here is then a visible
 * no-op instead of a silent one, or worse, an accidental full refresh every
 * minute.
 *
 * `handleScheduled` never throws. A cron handler that rejects gets retried by the
 * platform, and re-running a whole sync because the *log write* at the end failed
 * would be worse than losing the log line. Both entry points already record their
 * own `run_log` row.
 */

import { makeCtx } from "../db/client.ts";
import { makeRepos } from "../db/index.ts";
import { pokeIngestRunners } from "../hc/store/poke.ts";
import { errorFields, makeLogger } from "../lib/log.ts";

import { sweepReconnectAlerts } from "./alerts.ts";
import { runCalendarSync } from "./calendar-sync.ts";
import { runFullRefresh } from "./full-refresh.ts";
import { runTokenKeepalive } from "./keepalive.ts";
import { runPortalKeepalive } from "./portal-keepalive.ts";

import type { SyncDeps } from "./deps.ts";
import type { Ctx } from "../db/client.ts";
import type { Env } from "../env.ts";

/** The hourly appointment sync and token keepalive. */
export const CRON_HOURLY = "7 * * * *";
/** The four-hourly full-scope refresh of the MCP read cache. */
export const CRON_FULL_REFRESH = "23 2,6,10,14,18,22 * * *";
/** The portal session keepalive. See `portal-keepalive.ts`. */
export const CRON_PORTAL_KEEPALIVE = "*/10 * * * *";

/** How long `mcp_audit` rows are kept. The repo's own default; stated for clarity. */
const AUDIT_RETENTION_DAYS = 365;

/**
 * Dispatch one scheduled invocation.
 *
 * `deps` is the test seam; production passes three arguments and nothing else.
 */
export async function handleScheduled(
  env: Env,
  cron: string,
  ectx: ExecutionContext,
  deps: SyncDeps = {},
): Promise<void> {
  const log = makeLogger({ src: "cron" });
  const ctx = makeCtx(env.DB, env, { log });
  log.info("cron.received", { cron });
  try {
    switch (cron) {
      case CRON_HOURLY: {
        await runTokenKeepalive(ctx, deps);
        await runCalendarSync(ctx, { trigger: "calendar", deps });
        // After the work, so that whatever this hour parked is carded this hour.
        await sweepReconnectAlerts(ctx, deps);
        return;
      }
      case CRON_FULL_REFRESH: {
        await runFullRefresh(ctx, { trigger: "full", deps });
        await runCalendarSync(ctx, { trigger: "calendar", deps });
        await sweepReconnectAlerts(ctx, deps);
        // Last, and after the work: pruning is housekeeping, and a failure here
        // must not look like a failed sync.
        ectx.waitUntil(prune(ctx));
        return;
      }
      case CRON_PORTAL_KEEPALIVE: {
        // First, and it never throws: a portal that is slow to answer must not
        // delay a phone's queued batches.
        await pokeIngestRunners(ctx);
        await runPortalKeepalive(ctx, deps);
        return;
      }
      default: {
        // See the module comment: never guessed at.
        log.warn("cron.unknown", { cron });
        return;
      }
    }
  } catch (error) {
    log.error("cron.failed", { cron, ...errorFields(error) });
  }
}

/**
 * Retention: expired cache rows, expired OAuth states, year-old audit rows,
 * expired inbound mail, and portal visits a year past their date.
 *
 * `mail_inbox` is pruned here as well as from the email handler, because the
 * handler only runs when mail arrives: a mailbox that goes quiet would otherwise
 * keep whatever the last message left in it indefinitely.
 */
async function prune(ctx: Ctx): Promise<void> {
  const repos = makeRepos(ctx);
  try {
    const cache = await repos.fhirCache.purgeExpired();
    const states = await repos.oauthStates.purgeExpired();
    const audit = await repos.mcpAudit.prune(AUDIT_RETENTION_DAYS);
    const mail = await repos.mailInbox.purgeExpired(ctx.now());
    const visits = await repos.portalVisits.purgeExpired();
    ctx.log.info("cron.pruned", { cache, states, audit, mail, visits });
  } catch (error) {
    ctx.log.warn("cron.prune_failed", errorFields(error));
  }
}
