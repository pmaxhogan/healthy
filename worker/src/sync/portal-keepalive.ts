/**
 * Portal session keepalive: touch every live portal session between hourly runs.
 *
 * ### Why this exists
 *
 * A patient portal's chart session has an *idle* timeout, and it is shorter
 * than an hour. The evidence is the hourly run itself: a session established a
 * few minutes before one run was still alive at that run, and every session
 * left alone for a whole hour was dead at the next -- on both portal flavours.
 * A portal's own web page keeps its session alive by pinging the server every
 * few minutes while the tab is open; a scheduled scrape that only calls once an
 * hour looks, to the portal, like a tab that was closed. So every run found the
 * session dead and signed in again, and a portal that wants an emailed code for
 * that sent the owner an email every hour.
 *
 * So this runs on its own, more frequent schedule and does what the open tab
 * does: one authenticated page load per live session, which resets the idle
 * clock, and the jar saved back so any cookie the portal refreshed is kept.
 *
 * ### What it deliberately does not do
 *
 * **It never signs in.** A dead session is left for the hourly run, which has
 * the attempt budget, the unattended-code limits and the reconnect card. A
 * keepalive that could sign in would be a second, six-times-an-hour driver of
 * exactly the thing this exists to prevent.
 *
 * **It saves the jar only when the session is alive.** A dead probe has
 * nothing worth keeping, and a sign-in running concurrently (the owner's
 * button, or the hourly run waiting for its code) may be about to write a
 * better jar -- overwriting it with a dead one would undo that sign-in.
 *
 * **It writes no `run_log` row.** Six rows an hour of "the session is still
 * alive" would bury the Runs page; the log line is the record.
 *
 * Log lines carry the health system id and whether the session was alive. Never a
 * cookie, a URL or a byte of portal markup.
 */

import { makeRepos } from "../db/index.ts";
import { errorFields } from "../lib/log.ts";

import { openPortalSession, portalDeps } from "./portal-signin.ts";

import type { SyncDeps } from "./deps.ts";
import type { Ctx } from "../db/client.ts";

/** What one sweep found. For the log line and for tests. */
export interface PortalKeepaliveSummary {
  /** Active accounts looked at. */
  accounts: number;
  /** Of those, how many were still signed in (and so were kept alive). */
  alive: number;
}

/**
 * Touch every active portal session once. Never throws, never signs in.
 *
 * Per-account isolation, like every other sweep: one portal that errors must
 * not stop the others being kept alive.
 */
export async function runPortalKeepalive(
  ctx: Ctx,
  deps: SyncDeps = {},
): Promise<PortalKeepaliveSummary> {
  const summary: PortalKeepaliveSummary = { accounts: 0, alive: 0 };
  let accounts;
  try {
    accounts = await makeRepos(ctx).portalAccounts.listActive();
  } catch (error) {
    ctx.log.warn("portal.keepalive_failed", errorFields(error));
    return summary;
  }
  const resolved = portalDeps(deps);
  for (const account of accounts) {
    const healthSystemId = account.health_system_id;
    summary.accounts += 1;
    try {
      const { session } = await openPortalSession(ctx, healthSystemId, resolved);
      // `isSessionAlive` is an authenticated page load, which is the keepalive:
      // the portal resets its idle clock on any signed-in request.
      const alive = await session.client.isSessionAlive();
      if (alive) {
        summary.alive += 1;
        await session.persistJar();
      }
      ctx.log.info("portal.keepalive", { healthSystemId, alive });
    } catch (error) {
      ctx.log.warn("portal.keepalive_failed", { healthSystemId, ...errorFields(error) });
    }
  }
  return summary;
}
