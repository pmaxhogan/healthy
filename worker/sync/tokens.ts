/**
 * Epic access tokens: caching, expiry, and the single-flight refresh.
 *
 * `withAccessToken` returns a *getter*, not a token, because `FhirClient` calls
 * it once per request and a sync run makes many: handing out a string would mean
 * a run that starts four minutes before expiry dies half way through paging.
 *
 * The four rules that make this safe, in the order they matter:
 *
 * 1. **Refresh at five minutes, not at zero.** Epic's access-token lifetime is
 *    set per organisation and has been seen as short as a few minutes. A token
 *    inside the skew is treated as already dead.
 *
 * 2. **One refresh at a time, enforced twice.** Epic invalidates a refresh token
 *    the moment it is redeemed, so two concurrent refreshes lose the connection
 *    outright and the owner has to re-authorise. The D1 lease (`acquireLease`, a
 *    single conditional UPDATE) is the cross-isolate guard; a promise latch is the
 *    within-isolate one, because a lease round trip per page would be silly.
 *
 * 3. **Persist the rotated refresh token before using the new access token.** The
 *    write happens first, in one statement, and only then does the new access
 *    token leave this module. If the order were reversed, a write that failed
 *    after a successful refresh would leave a dead refresh token in D1 and a live
 *    one in memory -- unrecoverable without a re-auth.
 *
 * 4. **`invalid_grant` is the only error that asks the owner for anything.** It
 *    means the grant is gone (expired, revoked in the portal, invalidated by a
 *    password reset), so the connection is marked `needs_reauth` and an alert is
 *    opened. Everything else marks `error` and *keeps the tokens*: a 500 from the
 *    token endpoint is not a reason to throw away a working refresh token.
 *
 * Units: `Ctx.now()` is unix **seconds** and `connections.access_expires_at` is
 * too, while `TokenSet.expiresAt` and every retry option are **milliseconds**.
 * Both conversions are spelled out at the boundary rather than inlined.
 */

import { makeRepos } from "../db/index.ts";
import { AppError, isAppError, toAppError } from "../lib/errors.ts";
import { newToken } from "../lib/ids.ts";
import { createFhirClient } from "../providers/epic/fhir-client.ts";
import { adapterFor } from "../providers/registry.ts";

import { openReconnectAlert, resolveReconnectAlert } from "./alerts.ts";
import { resolveDeps } from "./deps.ts";
import { clientIdFor, getSmartConfig } from "./discovery.ts";

import type { SyncDeps } from "./deps.ts";
import type { Ctx } from "../db/client.ts";
import type { Repos } from "../db/index.ts";
import type { ConnectionRow, HealthSystemRow } from "../db/rows.ts";
import type { SmartConfig } from "../fhir/types.ts";
import type { ProviderAdapter } from "../providers/adapter.ts";
import type { FhirClient } from "../providers/epic/fhir-client.ts";

/** Refresh once this little of the access token's life is left. Five minutes. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** How long a refresh may hold the connection lease. */
export const LEASE_TTL_MS = 60_000;
/** Polls while waiting for whoever holds the lease to finish. */
const LEASE_WAIT_ATTEMPTS = 5;
const LEASE_WAIT_MS = 400;

/** Everything a sync needs about one connection, plus the token getter. */
export interface AccessTokenHandle {
  healthSystem: HealthSystemRow;
  connection: ConnectionRow;
  /** The organisation's R4 Patient id, from the token response. */
  patientId: string;
  smart: SmartConfig;
  adapter: ProviderAdapter;
  /**
   * A usable access token. Cached; refreshes inside the skew, or when `forceRefresh`
   * says a 401 proved the cached one dead.
   */
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
}

/** The pieces of a connection this module needs decrypted. */
interface Credentials {
  clientId: string;
  clientSecret: string;
  patientId: string;
  refreshToken: string | null;
  accessToken: string | null;
  accessExpiresAtMs: number;
}

async function loadCredentials(
  ctx: Ctx,
  repos: Repos,
  healthSystem: HealthSystemRow,
  connection: ConnectionRow,
): Promise<Credentials> {
  const secrets = await repos.connections.getSecrets(connection.id);
  // A null `secrets` (the row vanished) and a null patient id are the same
  // failure: the connection cannot be searched, so it is not usable.
  const patientFhirId = secrets?.patientFhirId ?? null;
  if (patientFhirId === null) {
    throw new AppError("not_connected", "the connection has no stored patient id", {
      healthSystemId: healthSystem.id,
    });
  }
  const clientSecret = await repos.healthSystems.getClientSecret(healthSystem.id);
  if (clientSecret === null) {
    throw new AppError("not_connected", "the health system has no client secret", {
      healthSystemId: healthSystem.id,
    });
  }
  return {
    clientId: clientIdFor(ctx, healthSystem),
    clientSecret,
    patientId: patientFhirId,
    refreshToken: secrets?.refreshToken ?? null,
    accessToken: secrets?.accessToken ?? null,
    accessExpiresAtMs: (connection.access_expires_at ?? 0) * 1000,
  };
}

/** A stable error code for the `connections.last_error_code` column. */
function codeOf(error: unknown): string {
  return isAppError(error) ? error.code : "internal";
}

/**
 * Open a token session for one health system.
 *
 * Does the D1 and discovery work once, up front, and hands back a getter that a
 * whole sync (or one MCP tool call) can lean on.
 */
export async function withAccessToken(
  ctx: Ctx,
  healthSystemId: string,
  deps: SyncDeps = {},
): Promise<AccessTokenHandle> {
  const resolved = resolveDeps(deps);
  const repos = makeRepos(ctx);
  const nowMs = (): number => ctx.now() * 1000;

  const healthSystem = await repos.healthSystems.get(healthSystemId);
  if (healthSystem === null) {
    throw new AppError("not_found", "no such health system", { healthSystemId });
  }
  if (healthSystem.deleted_at !== null) {
    throw new AppError("not_found", "the health system has been removed", { healthSystemId });
  }
  const connection = await repos.connections.getForHealthSystem(healthSystemId);
  if (connection === null || connection.status === "disconnected") {
    throw new AppError("not_connected", "the health system is not connected", { healthSystemId });
  }
  if (connection.status === "needs_reauth") {
    throw new AppError("needs_reauth", "the connection needs the owner to reconnect", {
      healthSystemId,
    });
  }

  const adapter = adapterFor(healthSystem.vendor, {
    fetchImpl: resolved.fetchImpl,
    logger: ctx.log,
    now: nowMs,
  });
  const smart = await getSmartConfig(ctx, repos, healthSystem, adapter);
  const credentials = await loadCredentials(ctx, repos, healthSystem, connection);

  // Mutable, because a refresh replaces all three. Held in one object rather than
  // three `let`s so it is obvious that they move together.
  const state = {
    accessToken: credentials.accessToken,
    expiresAtMs: credentials.accessExpiresAtMs,
    refreshToken: credentials.refreshToken,
  };
  let inFlight: Promise<string> | null = null;

  /** The cached token when it is still comfortably valid, else null. */
  const freshToken = (): string | null => {
    const token = state.accessToken;
    return token !== null && state.expiresAtMs - nowMs() > REFRESH_SKEW_MS ? token : null;
  };

  /** Someone else holds the lease: wait for their result rather than racing it. */
  const awaitOtherRefresh = async (): Promise<string> => {
    for (let attempt = 0; attempt < LEASE_WAIT_ATTEMPTS; attempt++) {
      await resolved.sleep(LEASE_WAIT_MS);
      const row = await repos.connections.get(connection.id);
      if (row === null) {
        throw new AppError("not_connected", "the connection disappeared", { healthSystemId });
      }
      if (row.status === "needs_reauth") {
        throw new AppError("needs_reauth", "the connection needs the owner to reconnect", {
          healthSystemId,
        });
      }
      if ((row.access_expires_at ?? 0) * 1000 - nowMs() <= REFRESH_SKEW_MS) continue;
      const secrets = await repos.connections.getSecrets(connection.id);
      const token = secrets?.accessToken ?? null;
      // eslint-disable-next-line security/detect-possible-timing-attacks -- a null check on a freshly read column, not a secret comparison; there is nothing to compare against.
      if (token === null) continue;
      state.accessToken = token;
      state.expiresAtMs = (row.access_expires_at ?? 0) * 1000;
      state.refreshToken = secrets?.refreshToken ?? state.refreshToken;
      ctx.log.debug("sync.token.lease_followed", { healthSystemId });
      return token;
    }
    // Deliberately `upstream_unavailable`: the run records it and moves on to the
    // next health system, and the next scheduled run tries again.
    throw new AppError("upstream_unavailable", "another refresh holds the connection lease", {
      healthSystemId,
    });
  };

  const performRefresh = async (): Promise<string> => {
    if (state.refreshToken === null) {
      await repos.connections.markNeedsReauth(connection.id, "no_refresh_token");
      await openReconnectAlert(ctx, { healthSystemId }, "no_refresh_token", deps);
      throw new AppError("needs_reauth", "the connection has no refresh token", { healthSystemId });
    }
    const owner = newToken();
    if (!(await repos.connections.acquireLease(connection.id, owner, LEASE_TTL_MS))) {
      return awaitOtherRefresh();
    }
    try {
      const tokens = await adapter.refresh({
        tokenUrl: smart.tokenUrl,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        refreshToken: state.refreshToken,
        tokenAuthMethods: smart.tokenAuthMethods,
      });
      // One statement, and it happens before the new access token is returned:
      // see rule 3 in the module comment. A null `refreshToken` means Epic did
      // not rotate it, so the stored one stays -- writing null would erase it.
      // The write carries the lease: if this refresh outlasted its TTL and another
      // one has since stored *its* rotated refresh token, ours must not land on
      // top -- that is how both end up invalid and the owner has to reconnect.
      const stored = await repos.connections.upsertTokensLeased(healthSystemId, owner, {
        accessToken: tokens.accessToken,
        accessExpiresAt: Math.floor(tokens.expiresAt / 1000),
        ...(tokens.refreshToken !== null && { refreshToken: tokens.refreshToken }),
        ...(tokens.scope !== "" && { scope: tokens.scope }),
      });
      if (stored === null) {
        // Discard what we just obtained and follow whoever holds the lease now.
        // Nothing else is stamped either: marking the connection connected or
        // resolving its alert would be claiming credit for someone else's write.
        ctx.log.warn("sync.token.lease_lost", { healthSystemId });
        return await awaitOtherRefresh();
      }
      await repos.connections.markConnected(connection.id);
      state.accessToken = tokens.accessToken;
      state.expiresAtMs = tokens.expiresAt;
      state.refreshToken = tokens.refreshToken ?? state.refreshToken;
      ctx.log.info("sync.token.refreshed", { healthSystemId });
      await resolveReconnectAlert(ctx, { healthSystemId }, deps);
      return tokens.accessToken;
    } catch (error) {
      const code = codeOf(error);
      if (code === "needs_reauth") {
        await repos.connections.markNeedsReauth(connection.id, code);
        await openReconnectAlert(ctx, { healthSystemId }, code, deps);
      } else {
        // Keeps the tokens: a transient token-endpoint failure is not a reason to
        // throw away a refresh token that is probably still good.
        await repos.connections.markError(connection.id, code);
      }
      throw toAppError(error, "upstream_error");
    } finally {
      await repos.connections.releaseLease(connection.id, owner);
    }
  };

  const refresh = async (): Promise<string> => {
    inFlight ??= performRefresh();
    try {
      return await inFlight;
    } finally {
      // Cleared however it settled, so a failure does not pin the isolate to it.
      inFlight = null;
    }
  };

  return {
    healthSystem,
    connection,
    patientId: credentials.patientId,
    smart,
    adapter,
    async getAccessToken(options) {
      const cached = options?.forceRefresh === true ? null : freshToken();
      return cached ?? refresh();
    },
  };
}

/** What the MCP and the sync both need to talk FHIR to one organisation. */
export interface FhirSession extends AccessTokenHandle {
  client: FhirClient;
}

/**
 * A ready FHIR client for one health system.
 *
 * The 401 hook is `getAccessToken({ forceRefresh: true })`, which is the single
 * -flight refresh: several pages racing a mid-run expiry all wait on one refresh
 * rather than each redeeming the refresh token.
 */
export async function getFhirClientFor(
  ctx: Ctx,
  healthSystemId: string,
  deps: SyncDeps = {},
): Promise<FhirSession> {
  const resolved = resolveDeps(deps);
  const handle = await withAccessToken(ctx, healthSystemId, deps);
  const client = createFhirClient({
    baseUrl: handle.healthSystem.fhir_base_url,
    getAccessToken: () => handle.getAccessToken(),
    onUnauthorized: () => handle.getAccessToken({ forceRefresh: true }),
    fetchImpl: resolved.fetchImpl,
    logger: ctx.log,
    now: () => ctx.now() * 1000,
    retry: resolved.retry,
  });
  return { ...handle, client };
}
