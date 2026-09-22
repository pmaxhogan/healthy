/**
 * One portal account per provider: the credentials, the cookie jar, the state
 * machine and the daily attempt budget.
 *
 * Four things here are load-bearing.
 *
 * **The AAD needs no insert dance.** Unlike `connections`, the row id *is* the
 * provider id, so a value can be sealed against
 * `portal_accounts.<column>.<providerId>` before the row exists. What still has
 * to happen first is the row itself -- an `INSERT ... ON CONFLICT DO NOTHING`
 * -- because every write here is an UPDATE.
 *
 * **`markActive` checks the endpoint before the database does.** The migration's
 * CHECK refuses an active session with no `base_url`/`mount_path`, and a raw
 * constraint violation from D1 is an opaque 500. So the repo refuses it first,
 * with a code, and the CHECK stays as the backstop it is meant to be.
 *
 * **The attempt counter resets by comparing days, not by sweeping.** The plan
 * caps sign-in attempts per day, and a cron that clears counters at midnight is
 * one more thing that can fail silently. Storing the UTC day alongside the count
 * means a stale counter reads as zero on its own, with no scheduled work.
 *
 * **The cookie jar is as sensitive as the password.** It carries the session
 * cookie and the trust-this-device cookie, either of which is a sign-in. It is
 * sealed, it is never returned except through `getSecrets`, and `hasSession` on
 * the DTO is the whole of what the admin UI learns about it.
 */

import { AppError } from "../../lib/errors.ts";
import { DAY_SECONDS, toIso } from "../../lib/time.ts";
import { all, one, run } from "../client.ts";
import { aadFor, openOrNull, seal } from "../crypto.ts";

import type { Ctx } from "../client.ts";
import type { PortalAccountRow } from "../rows.ts";
import type {
  PortalAccountDto,
  PortalSessionState,
  SetPortalCredentialsRequest,
} from "@shared/types.ts";

/** What a sign-in needs and nothing else in the Worker may hold. */
export interface PortalAccountSecrets {
  username: string | null;
  password: string | null;
  /** The serialised cookie jar, for `CookieJar.deserialise`. */
  cookieJar: string | null;
}

export interface PortalEndpointPatch {
  /** Origin only. The repo does not validate it; discovery produces it. */
  baseUrl: string;
  mountPath: string;
}

const SELECT = "SELECT * FROM portal_accounts";

const aad = (column: string, providerId: string): string =>
  aadFor("portal_accounts", column, providerId);

/** A nullable unix-second column as a nullable ISO instant. */
const iso = (value: number | null): string | null => (value === null ? null : toIso(value));

/** Whole UTC days since the epoch. What the attempt counter is keyed on. */
export function utcDay(unixSeconds: number): number {
  return Math.floor(unixSeconds / DAY_SECONDS);
}

/**
 * A row as the admin UI sees it: no ciphertext, no cookie values, no username.
 *
 * Lives here rather than in `worker/api/dto.ts` on purpose -- the projection's
 * whole job is to drop the sealed columns, and this is the module that knows
 * which ones those are.
 */
function toPortalAccountDto(row: PortalAccountRow, now: number): PortalAccountDto {
  return {
    providerId: row.provider_id,
    baseUrl: row.base_url,
    mountPath: row.mount_path,
    hasCredentials: row.username_enc !== null && row.password_enc !== null,
    hasSession: row.cookie_jar_enc !== null,
    state: row.session_state,
    lastLoginAt: iso(row.last_login_at),
    lastOkAt: iso(row.last_ok_at),
    lastErrorCode: row.last_error_code,
    needsReauthSince: iso(row.needs_reauth_since),
    // A counter from an earlier day has already expired, so it reads as zero
    // here exactly as it does in `countLoginAttemptsToday`.
    loginAttemptsToday: row.login_attempts_day === utcDay(now) ? row.login_attempts_today : 0,
    updatedAt: iso(row.updated_at),
  };
}

export function makePortalAccountsRepo(ctx: Ctx) {
  const byProvider = async (providerId: string): Promise<PortalAccountRow | null> =>
    one<PortalAccountRow>(ctx.db.prepare(`${SELECT} WHERE provider_id = ?`).bind(providerId));

  /** The row, created in state 'none' if the provider has never had one. */
  const ensure = async (providerId: string): Promise<PortalAccountRow> => {
    const existing = await byProvider(providerId);
    if (existing !== null) return existing;
    await run(
      ctx.db
        .prepare(
          `INSERT INTO portal_accounts (provider_id, session_state, updated_at)
           VALUES (?, 'none', ?)
           ON CONFLICT (provider_id) DO NOTHING`,
        )
        .bind(providerId, ctx.now()),
    );
    const created = await byProvider(providerId);
    if (created === null) {
      // Unreachable short of the provider row vanishing mid-call, in which case
      // the foreign key above would have thrown instead.
      throw new Error("portal account row disappeared after insert");
    }
    return created;
  };

  const require_ = async (providerId: string): Promise<PortalAccountRow> => {
    const row = await byProvider(providerId);
    if (row === null) throw new AppError("not_found", "no portal account for this provider");
    return row;
  };

  /** One UPDATE of whichever columns the caller named. */
  const patch = async (providerId: string, columns: Record<string, unknown>): Promise<void> => {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of Object.entries(columns)) {
      sets.push(`${column} = ?`);
      values.push(value);
    }
    sets.push("updated_at = ?");
    values.push(ctx.now());
    await run(
      ctx.db
        .prepare(`UPDATE portal_accounts SET ${sets.join(", ")} WHERE provider_id = ?`)
        .bind(...values, providerId),
    );
  };

  return {
    get: byProvider,
    ensure,

    async list(): Promise<PortalAccountRow[]> {
      return all<PortalAccountRow>(ctx.db.prepare(`${SELECT} ORDER BY provider_id`));
    },

    /** Accounts the scheduled sync should try: active, on a live provider. */
    async listActive(): Promise<PortalAccountRow[]> {
      return all<PortalAccountRow>(
        ctx.db.prepare(
          `SELECT a.* FROM portal_accounts a
             JOIN providers p ON p.id = a.provider_id
            WHERE a.session_state = 'active' AND p.deleted_at IS NULL
            ORDER BY a.provider_id`,
        ),
      );
    },

    /** Record where discovery found the portal. Required before `markActive`. */
    async setEndpoint(providerId: string, endpoint: PortalEndpointPatch): Promise<void> {
      await ensure(providerId);
      await patch(providerId, { base_url: endpoint.baseUrl, mount_path: endpoint.mountPath });
    },

    /**
     * Store the owner's portal login, sealed.
     *
     * Storing credentials resets the session state to 'none' and drops the
     * cookie jar: a new password invalidates whatever the old jar held, and a
     * jar kept across a credential change is a session nobody can account for.
     */
    async setCredentials(
      providerId: string,
      input: SetPortalCredentialsRequest,
    ): Promise<PortalAccountRow> {
      await ensure(providerId);
      const columns: Record<string, unknown> = {
        username_enc: await seal(ctx.env, input.username, aad("username_enc", providerId)),
        password_enc: await seal(ctx.env, input.password, aad("password_enc", providerId)),
        cookie_jar_enc: null,
        session_state: "none" satisfies PortalSessionState,
        last_error_code: null,
        needs_reauth_since: null,
      };
      if (input.baseUrl !== undefined) columns.base_url = input.baseUrl;
      if (input.mountPath !== undefined) columns.mount_path = input.mountPath;
      await patch(providerId, columns);
      ctx.log.info("portal_accounts.credentials_set", { providerId });
      return require_(providerId);
    },

    /** Decrypt the three sealed columns. The only way out of the db layer. */
    async getSecrets(providerId: string): Promise<PortalAccountSecrets | null> {
      const row = await byProvider(providerId);
      if (row === null) return null;
      return {
        username: await openOrNull(ctx.env, row.username_enc, aad("username_enc", providerId)),
        password: await openOrNull(ctx.env, row.password_enc, aad("password_enc", providerId)),
        cookieJar: await openOrNull(ctx.env, row.cookie_jar_enc, aad("cookie_jar_enc", providerId)),
      };
    },

    /**
     * Persist the cookie jar after any call, successful or not.
     *
     * `null` forgets the session -- what the admin UI's "Forget session" button
     * does, and what a credential change does implicitly.
     */
    async saveCookieJar(providerId: string, serialised: string | null): Promise<void> {
      await ensure(providerId);
      const sealed =
        serialised === null
          ? null
          : await seal(ctx.env, serialised, aad("cookie_jar_enc", providerId));
      await patch(providerId, { cookie_jar_enc: sealed });
    },

    /**
     * A sign-in worked, or an authenticated call did: the session is live.
     *
     * Refuses when the endpoint is unknown, which the migration's CHECK would
     * otherwise turn into an opaque constraint violation.
     */
    async markActive(providerId: string): Promise<void> {
      const row = await require_(providerId);
      if (row.base_url === null || row.mount_path === null) {
        throw new AppError("conflict", "the portal endpoint is not known yet", { providerId });
      }
      await patch(providerId, {
        session_state: "active" satisfies PortalSessionState,
        last_ok_at: ctx.now(),
        last_error_code: null,
        needs_reauth_since: null,
      });
      ctx.log.info("portal_accounts.active", { providerId });
    },

    /**
     * The portal will not let us in without the owner. Records the stable code
     * and stamps the clock the reconnect card is opened from.
     *
     * `needs_reauth_since` is only set on the *first* failure, so the card's age
     * reflects how long the owner has been ignoring it rather than resetting on
     * every hourly retry.
     */
    async markNeedsReauth(providerId: string, errorCode: string): Promise<void> {
      const row = await require_(providerId);
      await patch(providerId, {
        session_state: "needs_reauth" satisfies PortalSessionState,
        last_error_code: errorCode,
        needs_reauth_since: row.needs_reauth_since ?? ctx.now(),
      });
      ctx.log.warn("portal_accounts.needs_reauth", { providerId, errorCode });
    },

    /**
     * Sign-in attempts used today.
     *
     * Zero once the stored day is not today's: see the module comment on why the
     * reset is a comparison rather than a sweep.
     */
    async countLoginAttemptsToday(providerId: string): Promise<number> {
      const row = await byProvider(providerId);
      if (row === null) return 0;
      return row.login_attempts_day === utcDay(ctx.now()) ? row.login_attempts_today : 0;
    },

    /**
     * Count one attempt and return the new total for today.
     *
     * The increment and the day comparison are one statement, so two runs that
     * overlap cannot both read 2 and both write 3. `last_login_at` moves with it
     * because the hourly limit is read off that column.
     */
    async recordLoginAttempt(providerId: string): Promise<number> {
      await ensure(providerId);
      const today = utcDay(ctx.now());
      await run(
        ctx.db
          .prepare(
            `UPDATE portal_accounts
                SET login_attempts_today =
                      CASE WHEN login_attempts_day = ? THEN login_attempts_today + 1 ELSE 1 END,
                    login_attempts_day = ?, last_login_at = ?, updated_at = ?
              WHERE provider_id = ?`,
          )
          .bind(today, today, ctx.now(), ctx.now(), providerId),
      );
      const row = await require_(providerId);
      return row.login_attempts_today;
    },

    /** The row as the admin UI sees it. Never a sealed column. */
    async dto(providerId: string): Promise<PortalAccountDto | null> {
      const row = await byProvider(providerId);
      return row === null ? null : toPortalAccountDto(row, ctx.now());
    },
  };
}
