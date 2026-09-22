/**
 * Token keepalive: `refreshConnectionToken`, and the every-connection sweep the
 * hourly cron runs.
 *
 * Why a keepalive exists at all. Epic's refresh tokens expire on a rolling window
 * measured from last use, so a connection that is never *refreshed* eventually
 * dies even though nothing is wrong with it -- and a provider whose appointments
 * are all in the past makes no upstream request at all. Touching every connection
 * once an hour keeps the grant alive, and it surfaces a revoked one within the hour
 * rather than whenever the owner next happens to have an appointment.
 *
 * "Touching" means asking for an access token, not forcing a refresh: the getter
 * refreshes only inside the five-minute skew, so a connection with fifty minutes
 * left costs one D1 read. `force` is for the admin button, which has to be able to
 * prove that a refresh works.
 *
 * Google is included in the sweep. It is the one account that *always* has work to
 * do -- every calendar write goes through it -- but its own grant expires the same
 * way, and a run that discovers Google is broken is far more useful at the top of
 * the hour than half way through writing events.
 */

import { makeRepos } from "../db/index.ts";
import { AppError } from "../lib/errors.ts";
import { errorFields } from "../lib/log.ts";
import { toIso } from "../lib/time.ts";

import { withGoogleAccessToken } from "./google-tokens.ts";
import { record } from "./run.ts";
import { syncTargets } from "./targets.ts";
import { withAccessToken } from "./tokens.ts";

import type { SyncDeps } from "./deps.ts";
import type { Ctx } from "../db/client.ts";
import type { ConnectionStatus, RunKind } from "@shared/types.ts";

export interface RefreshTokenOptions {
  /** Refresh even when the stored access token is still comfortably valid. */
  force?: boolean;
  trigger?: RunKind;
  deps?: SyncDeps;
}

export interface RefreshTokenResult {
  status: ConnectionStatus;
  /** ISO instant the (possibly new) access token expires, or null. */
  accessExpiresAt: string | null;
}

/**
 * Make sure one connection has a usable access token, and report where it stands.
 *
 * Writes a `run_log` row of kind "refresh". Unlike the two sync entry points this
 * one **throws** on failure: it is driven by an admin button that needs to show
 * the owner what went wrong, and the run row records the outcome either way.
 */
export async function refreshConnectionToken(
  ctx: Ctx,
  providerId: string,
  options: RefreshTokenOptions = {},
): Promise<RefreshTokenResult> {
  const repos = makeRepos(ctx);
  const runId = await repos.runLog.start(options.trigger ?? "refresh");
  try {
    const handle = await withAccessToken(ctx, providerId, options.deps ?? {});
    await handle.getAccessToken(options.force === true ? { forceRefresh: true } : undefined);
    const connection = await repos.connections.getForProvider(providerId);
    if (connection === null) {
      throw new AppError("not_connected", "the provider is not connected", { providerId });
    }
    await repos.runLog.finish(runId, { ok: true, summary: { providers: 1 } });
    return {
      status: connection.status,
      accessExpiresAt:
        connection.access_expires_at === null ? null : toIso(connection.access_expires_at),
    };
  } catch (error) {
    await repos.runLog.finish(runId, {
      ok: false,
      summary: { providers: 1, errors: [codeOf(error)] },
    });
    ctx.log.warn("sync.refresh_failed", { providerId, ...errorFields(error) });
    throw error;
  }
}

/**
 * Touch every connection, Google included, so no grant dies of disuse.
 *
 * Isolated per connection and never throws: this runs alongside the hourly sync,
 * and a single broken provider must not stop the others being kept alive. The
 * failures it finds have already marked their connection and opened their alert
 * inside the token managers.
 */
export async function runTokenKeepalive(ctx: Ctx, deps: SyncDeps = {}): Promise<RunSummaryish> {
  const repos = makeRepos(ctx);
  return record(ctx, "refresh", async (state) => {
    const targets = await syncTargets(repos);
    state.summary.providers = targets.length;
    for (const target of targets) {
      try {
        const handle = await withAccessToken(ctx, target.provider.id, deps);
        await handle.getAccessToken();
      } catch (error) {
        state.summary.errors.push({ providerId: target.provider.id, code: codeOf(error) });
        ctx.log.warn("sync.keepalive_failed", {
          providerId: target.provider.id,
          ...errorFields(error),
        });
      }
    }
    try {
      const getGoogleToken = await withGoogleAccessToken(ctx, deps);
      await getGoogleToken();
    } catch (error) {
      state.summary.errors.push({ providerId: "google", code: codeOf(error) });
      ctx.log.warn("sync.keepalive_failed", { providerId: "google", ...errorFields(error) });
    }
  });
}

/** The keepalive's summary is the ordinary run summary; named for readability. */
type RunSummaryish = Awaited<ReturnType<typeof record>>;

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "internal";
}
