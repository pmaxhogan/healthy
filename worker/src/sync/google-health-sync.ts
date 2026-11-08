/**
The Google Health sync: the owner's wearable metrics into the sealed store.

Runs from the hourly cron, after the calendar sync, and from the admin UI's
"Sync now". It rides on the calendar's Google grant: the same account row and
the same refresh token (a reconnect card when the grant dies), but an access
token of its own, narrowed to the Google Health scopes, because the Google
Health API refuses one that also carries the calendar's. It reads only the
metrics whose scope the owner has granted (`grantedTypes`). A grant without
any Google Health scope is not an error: the sync is skipped and says so.

Each metric is read on its own and fails on its own. The first read of a
metric (or every read, when the owner asks for a full sync) takes its whole
history: a daily summary type in one paged `list` with no lower bound, an
interval type in 90-day `dailyRollUp` windows from the oldest day any daily
type has back to today. Every later read takes the last `RECENT_DAYS` days,
so a value Google revises a few days on is picked up. Dates are UTC calendar
dates plus two days of headroom on the end, so no zone is needed and none is
disclosed.

Never throws: what failed is recorded per metric (`google_health_sync`) as a
stable code, and the summary says what happened.
*/

import { makeRepos } from "../db/index.ts";
import {
  GH_DAILY_TYPES,
  GH_ROLLUP_TYPES,
  addDays,
  createGoogleHealthClient,
  googleHealthErrorCode,
  grantedHealthScopes,
  grantedTypes,
} from "../google/health.ts";
import { toIso } from "../lib/time.ts";

import { resolveDeps } from "./deps.ts";
import { withGoogleHealthAccessToken } from "./google-tokens.ts";

import type { SyncDeps } from "./deps.ts";
import type { Ctx } from "../db/client.ts";
import type { GhDay, GhType, GoogleHealthClient } from "../google/health.ts";

/** How many days back an ordinary read starts. */
export const RECENT_DAYS = 14;
/** Days past today (UTC) a read runs to, so a zone ahead of UTC still has its today. */
const END_HEADROOM_DAYS = 2;

export interface GoogleHealthSyncSummary {
  /** Why nothing was read, when nothing was. */
  skipped: "not_connected" | "needs_reauth" | "scope_not_granted" | null;
  /** The metrics read without error. */
  synced: string[];
  /** Days written and days removed, across every metric. */
  written: number;
  removed: number;
  errors: { type: string; code: string }[];
}

interface Plan {
  client: GoogleHealthClient;
  endExclusive: string;
  recentStart: string;
}

/** Read one metric, store it, record the outcome. */
async function syncOne(
  ctx: Ctx,
  plan: Plan,
  spec: GhType,
  backfill: boolean,
  summary: GoogleHealthSyncSummary,
): Promise<void> {
  const repos = makeRepos(ctx);
  try {
    let days: GhDay[];
    let start: string | null;
    if (spec.kind === "daily") {
      start = backfill ? null : plan.recentStart;
      days = await plan.client.listDaily(spec, { start, endExclusive: plan.endExclusive });
    } else {
      // An interval type cannot be asked for "everything": walk back to the oldest
      // day a daily summary has, which is when the tracker started.
      const oldest = backfill ? await repos.googleHealth.oldestDay() : null;
      start = oldest !== null && oldest < plan.recentStart ? oldest : plan.recentStart;
      days = await plan.client.rollUpDaily(spec, start, plan.endExclusive);
    }
    const stored = await repos.googleHealth.replaceWindow(spec.type, days, {
      start,
      endExclusive: plan.endExclusive,
    });
    await repos.googleHealth.recordAttempt(spec.type, { ok: true, backfilled: backfill });
    summary.synced.push(spec.type);
    summary.written += stored.written;
    summary.removed += stored.removed;
  } catch (error) {
    const code = googleHealthErrorCode(error);
    summary.errors.push({ type: spec.type, code });
    ctx.log.warn("sync.google_health.type_failed", { type: spec.type, errorCode: code });
    try {
      await repos.googleHealth.recordAttempt(spec.type, { ok: false, code });
    } catch {
      ctx.log.warn("sync.google_health.record_failed", { type: spec.type });
    }
  }
}

/**
Read every granted metric. `full: true` reads each one's whole history again
(the admin UI's full sync); otherwise only a metric that has never had its
history read does.
*/
export async function runGoogleHealthSync(
  ctx: Ctx,
  deps: SyncDeps = {},
  options: { full?: boolean } = {},
): Promise<GoogleHealthSyncSummary> {
  const summary: GoogleHealthSyncSummary = {
    skipped: null,
    synced: [],
    written: 0,
    removed: 0,
    errors: [],
  };
  try {
    const repos = makeRepos(ctx);
    const account = await repos.google.get();
    if (account.status !== "connected") {
      summary.skipped = account.status === "needs_reauth" ? "needs_reauth" : "not_connected";
      return summary;
    }
    const types = grantedTypes(account.scope);
    if (types.length === 0) {
      summary.skipped = "scope_not_granted";
      return summary;
    }
    const resolved = resolveDeps(deps);
    // Its own token, narrowed to the Google Health scopes: the API refuses one
    // that also carries the calendar's (`withGoogleHealthAccessToken`).
    const getAccessToken = await withGoogleHealthAccessToken(
      ctx,
      grantedHealthScopes(account.scope),
      deps,
    );
    const today = toIso(ctx.now()).slice(0, 10);
    const plan: Plan = {
      client: createGoogleHealthClient({
        getAccessToken,
        fetchImpl: resolved.fetchImpl,
        logger: ctx.log,
        sleep: resolved.sleep,
      }),
      endExclusive: addDays(today, END_HEADROOM_DAYS),
      recentStart: addDays(today, -RECENT_DAYS),
    };
    const rows = await repos.googleHealth.syncRows();
    const state = new Map(rows.map((row) => [row.data_type, row]));
    const backfillOf = (type: string): boolean =>
      options.full === true || (state.get(type)?.backfilled_at ?? null) === null;

    // Daily summaries first: an interval type's history starts where theirs does.
    const ordered = [...GH_DAILY_TYPES, ...GH_ROLLUP_TYPES].filter((spec) => types.includes(spec));
    for (const spec of ordered) {
      await syncOne(ctx, plan, spec, backfillOf(spec.type), summary);
      // A dead grant fails every metric the same way: stop asking.
      if (summary.errors.some((entry) => entry.code === "needs_reauth")) break;
    }
  } catch (error) {
    const code = googleHealthErrorCode(error);
    summary.errors.push({ type: "*", code });
    ctx.log.warn("sync.google_health.failed", { errorCode: code });
  }
  ctx.log.info("sync.google_health.done", {
    skipped: summary.skipped ?? "",
    synced: summary.synced.length,
    written: summary.written,
    removed: summary.removed,
    errors: summary.errors.length,
  });
  return summary;
}
