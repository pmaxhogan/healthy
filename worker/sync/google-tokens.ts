/**
 * Google access tokens, and the calendar client built on them.
 *
 * The same shape as `tokens.ts` -- refresh inside a five-minute skew, single
 * flight behind the `google_account` lease -- with three Google-specific
 * differences that are each easy to get wrong:
 *
 *   - **A refresh returns no new refresh token.** Google keeps the original
 *     valid, so `GoogleRefreshedTokens` has no such field and nothing is rotated.
 *     The failure mode this avoids is a well-meaning `refreshToken: ""` write that
 *     erases the only way back in.
 *   - **A refresh omits `scope` when nothing changed**, and `oauth.ts` normalises
 *     that to `""`. Writing the empty string would blank the stored scope, which
 *     the admin UI reads to show what the grant covers, so an empty scope means
 *     "keep what is there".
 *   - **There is exactly one account.** Its subject is the literal `"google"`, and
 *     it is resolved once per run *before* the provider loop: if the calendar is
 *     unreachable there is no point asking four organisations for appointments
 *     nobody can write down.
 */

import { makeRepos } from "../db/index.ts";
import { createCalendarClient } from "../google/calendar.ts";
import { createGoogleOAuth } from "../google/oauth.ts";
import { AppError, isAppError, toAppError } from "../lib/errors.ts";
import { newToken } from "../lib/ids.ts";

import { openReconnectAlert, resolveReconnectAlert } from "./alerts.ts";
import { DEFAULT_PUBLIC_ORIGIN, resolveDeps } from "./deps.ts";
import { LEASE_TTL_MS, REFRESH_SKEW_MS } from "./tokens.ts";

import type { SyncDeps } from "./deps.ts";
import type { Ctx } from "../db/client.ts";
import type { CalendarClient } from "../google/calendar.ts";

const LEASE_WAIT_ATTEMPTS = 5;
const LEASE_WAIT_MS = 400;

/** Resolves a Google access token, refreshing under the account lease. */
export type GoogleTokenGetter = (options?: { forceRefresh?: boolean }) => Promise<string>;

/**
 * Build the token getter for the single Google account.
 *
 * Throws `not_connected` when the owner has never connected Google and
 * `needs_reauth` when the grant is gone -- both of which the caller reports on the
 * run rather than retrying.
 */
export async function withGoogleAccessToken(
  ctx: Ctx,
  deps: SyncDeps = {},
): Promise<GoogleTokenGetter> {
  const resolved = resolveDeps(deps);
  const repos = makeRepos(ctx);
  const nowMs = (): number => ctx.now() * 1000;

  const row = await repos.google.get();
  if (row.status === "disconnected") {
    throw new AppError("not_connected", "Google Calendar is not connected");
  }
  if (row.status === "needs_reauth") {
    throw new AppError("needs_reauth", "Google Calendar needs the owner to reconnect");
  }
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = ctx.env;
  if (GOOGLE_CLIENT_ID === undefined || GOOGLE_CLIENT_SECRET === undefined) {
    throw new AppError("internal", "the Google OAuth client secrets are not set");
  }
  const secrets = await repos.google.getSecrets();
  if (secrets.refreshToken === null) {
    throw new AppError("needs_reauth", "Google Calendar has no refresh token");
  }

  const origin = resolved.origin ?? DEFAULT_PUBLIC_ORIGIN;
  const oauth = createGoogleOAuth({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    // Unused by the refresh grant, but the client requires one and it must be a
    // registered URI for any other call this object could make.
    redirectUri: `${origin}/oauth/google/callback`,
    fetchImpl: resolved.fetchImpl,
    logger: ctx.log,
    now: nowMs,
  });

  const state = {
    accessToken: secrets.accessToken,
    expiresAtMs: (row.access_expires_at ?? 0) * 1000,
    refreshToken: secrets.refreshToken,
  };
  let inFlight: Promise<string> | null = null;

  /** The cached token when it is still comfortably valid, else null. */
  const freshToken = (): string | null => {
    const token = state.accessToken;
    return token !== null && state.expiresAtMs - nowMs() > REFRESH_SKEW_MS ? token : null;
  };

  const awaitOtherRefresh = async (): Promise<string> => {
    for (let attempt = 0; attempt < LEASE_WAIT_ATTEMPTS; attempt++) {
      await resolved.sleep(LEASE_WAIT_MS);
      const latest = await repos.google.get();
      if (latest.status === "needs_reauth") {
        throw new AppError("needs_reauth", "Google Calendar needs the owner to reconnect");
      }
      if ((latest.access_expires_at ?? 0) * 1000 - nowMs() <= REFRESH_SKEW_MS) continue;
      const latestSecrets = await repos.google.getSecrets();
      if (latestSecrets.accessToken === null) continue;
      state.accessToken = latestSecrets.accessToken;
      state.expiresAtMs = (latest.access_expires_at ?? 0) * 1000;
      ctx.log.debug("sync.google_token.lease_followed");
      return latestSecrets.accessToken;
    }
    throw new AppError("upstream_unavailable", "another refresh holds the Google account lease");
  };

  const performRefresh = async (): Promise<string> => {
    const owner = newToken();
    if (!(await repos.google.acquireLease(owner, LEASE_TTL_MS))) return awaitOtherRefresh();
    try {
      const tokens = await oauth.refresh(state.refreshToken);
      await repos.google.upsertTokens({
        accessToken: tokens.accessToken,
        accessExpiresAt: Math.floor(tokens.expiresAt / 1000),
        // An empty scope means "unchanged"; see the module comment.
        ...(tokens.scope !== "" && { scope: tokens.scope }),
      });
      await repos.google.markConnected();
      state.accessToken = tokens.accessToken;
      state.expiresAtMs = tokens.expiresAt;
      ctx.log.info("sync.google_token.refreshed");
      await resolveReconnectAlert(ctx, "google", deps);
      return tokens.accessToken;
    } catch (error) {
      if (isAppError(error) && error.code === "needs_reauth") {
        await repos.google.markNeedsReauth();
        await openReconnectAlert(ctx, "google", error.code, deps);
      }
      throw toAppError(error, "upstream_error");
    } finally {
      await repos.google.releaseLease(owner);
    }
  };

  const refresh = async (): Promise<string> => {
    inFlight ??= performRefresh();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };

  return async (options) => {
    const cached = options?.forceRefresh === true ? null : freshToken();
    return cached ?? refresh();
  };
}

/**
 * The calendar client the sync writes through.
 *
 * `getAccessToken` is forwarded straight to the getter above, including its
 * `forceRefresh` flag: the calendar client retries a 401 exactly once after
 * asking for a forced refresh, and that is the path this wires up.
 */
export async function getGoogleCalendarFor(ctx: Ctx, deps: SyncDeps = {}): Promise<CalendarClient> {
  const resolved = resolveDeps(deps);
  const getAccessToken = await withGoogleAccessToken(ctx, deps);
  return createCalendarClient({
    getAccessToken,
    fetchImpl: resolved.fetchImpl,
    logger: ctx.log,
    retry: resolved.retry,
  });
}
