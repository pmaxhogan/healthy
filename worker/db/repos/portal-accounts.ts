/**
 * One portal account per health system: the credentials, the cookie jar, the state
 * machine and the daily attempt budget.
 *
 * Four things here are load-bearing.
 *
 * **The AAD needs no insert dance.** Unlike `connections`, the row id *is* the
 * health system id, so a value can be sealed against
 * `portal_accounts.<column>.<healthSystemId>` before the row exists. What still has
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
 *
 * **Where the portal is, is sealed too (0007).** `base_url`, `mount_path` and
 * `endpoint_json` name the organisation -- its portal host, its app's mount
 * point, its login application -- so they are sealed in place, padded, against
 * `portal_accounts.<column>.<healthSystemId>`. They are read once per sign-in or
 * portal run (the row is opened when it is read, and the hops of a sign-in reuse
 * the opened values), so this is a decrypt per run, not per request. The columns
 * carry `_enc` names since 0008; the AAD keeps the name each value was first
 * sealed under (`portal_accounts.base_url.<id>`), because it is part of the tag.
 * Every short
 * credential column is sealed padded (`sealShort`), so a ciphertext no longer
 * gives away a username's or a password's exact length.
 */

import { AppError, isAppError } from "../../lib/errors.ts";
import { DAY_SECONDS, toIso } from "../../lib/time.ts";
import { all, one, run } from "../client.ts";
import { aadFor, openOrNull, seal, sealShort } from "../crypto.ts";
import { parseJsonColumn, portalEndpointSchema } from "../schemas.ts";

import type { Ctx } from "../client.ts";
import type { PortalAccountDbRow, PortalAccountRow } from "../rows.ts";
import type { StoredPortalEndpoint } from "../schemas.ts";
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
  /** Where to email a verification code, when the portal's own flow will not say. */
  mfaContact: string | null;
}

export interface PortalEndpointPatch {
  /** Origin only. The repo does not validate it; discovery produces it. */
  baseUrl: string;
  mountPath: string;
  /**
   * The adapter's whole discovery result, stored verbatim as JSON.
   *
   * Opaque here on purpose: `worker/providers/mychart/**` owns the shape and it
   * grows as deployments turn out to differ -- which login application to drive,
   * for one -- so a column (or a strict schema) per field would mean a migration
   * every time and a stored endpoint that quietly disagrees with the adapter that
   * produced it. Omitted by a caller that only knows the two fields above, which
   * is what `npm run set-portal-credentials` does.
   */
  endpoint?: Record<string, unknown>;
}

const SELECT = "SELECT * FROM portal_accounts";

const aad = (column: string, healthSystemId: string): string =>
  aadFor("portal_accounts", column, healthSystemId);

/** A nullable unix-second column as a nullable ISO instant. */
const iso = (value: number | null): string | null => (value === null ? null : toIso(value));

/** A sender domain as it is compared and stored: trimmed and lower-cased. */
function normaliseDomain(value: string): string {
  return value.trim().toLowerCase();
}

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
    healthSystemId: row.health_system_id,
    baseUrl: row.base_url,
    mountPath: row.mount_path,
    hasCredentials: row.username_enc !== null && row.password_enc !== null,
    hasSession: row.cookie_jar_enc !== null,
    hasMfaContact: row.mfa_contact_enc !== null,
    hasOtpSender: row.otp_sender_enc !== null,
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
  const openColumn = (value: string | null, column: string, healthSystemId: string) =>
    openOrNull(ctx.env, value, aad(column, healthSystemId));
  const sealColumn = (value: string | null, column: string, healthSystemId: string) =>
    value === null ? null : sealShort(ctx.env, value, aad(column, healthSystemId));

  /** The row with its location columns opened. Everything else passes through. */
  const decode = async (row: PortalAccountDbRow): Promise<PortalAccountRow> => {
    const {
      base_url_enc: baseUrl,
      mount_path_enc: mountPath,
      endpoint_enc: endpoint,
      ...plain
    } = row;
    return {
      ...plain,
      base_url: await openColumn(baseUrl, "base_url", row.health_system_id),
      mount_path: await openColumn(mountPath, "mount_path", row.health_system_id),
      endpoint_json: await openColumn(endpoint, "endpoint_json", row.health_system_id),
    };
  };

  const byHealthSystem = async (healthSystemId: string): Promise<PortalAccountRow | null> => {
    const row = await one<PortalAccountDbRow>(
      ctx.db.prepare(`${SELECT} WHERE health_system_id = ?`).bind(healthSystemId),
    );
    return row === null ? null : decode(row);
  };

  /** The row, created in state 'none' if the health system has never had one. */
  const ensure = async (healthSystemId: string): Promise<PortalAccountRow> => {
    const existing = await byHealthSystem(healthSystemId);
    if (existing !== null) return existing;
    await run(
      ctx.db
        .prepare(
          `INSERT INTO portal_accounts (health_system_id, session_state, updated_at)
           VALUES (?, 'none', ?)
           ON CONFLICT (health_system_id) DO NOTHING`,
        )
        .bind(healthSystemId, ctx.now()),
    );
    const created = await byHealthSystem(healthSystemId);
    if (created === null) {
      // Unreachable short of the health system row vanishing mid-call, in which case
      // the foreign key above would have thrown instead.
      throw new Error("portal account row disappeared after insert");
    }
    return created;
  };

  const require_ = async (healthSystemId: string): Promise<PortalAccountRow> => {
    const row = await byHealthSystem(healthSystemId);
    if (row === null) throw new AppError("not_found", "no portal account for this health system");
    return row;
  };

  /** One UPDATE of whichever columns the caller named. */
  const patch = async (healthSystemId: string, columns: Record<string, unknown>): Promise<void> => {
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
        .prepare(`UPDATE portal_accounts SET ${sets.join(", ")} WHERE health_system_id = ?`)
        .bind(...values, healthSystemId),
    );
  };

  return {
    get: byHealthSystem,
    ensure,

    async list(): Promise<PortalAccountRow[]> {
      const rows = await all<PortalAccountDbRow>(
        ctx.db.prepare(`${SELECT} ORDER BY health_system_id`),
      );
      return Promise.all(rows.map((row) => decode(row)));
    },

    /** Accounts the scheduled sync should try: active, on a live health system. */
    async listActive(): Promise<PortalAccountRow[]> {
      const rows = await all<PortalAccountDbRow>(
        ctx.db.prepare(
          `SELECT a.* FROM portal_accounts a
             JOIN health_systems p ON p.id = a.health_system_id
            WHERE a.session_state = 'active' AND p.deleted_at IS NULL
            ORDER BY a.health_system_id`,
        ),
      );
      return Promise.all(rows.map((row) => decode(row)));
    },

    /** Record where discovery found the portal. Required before `markActive`. */
    async setEndpoint(healthSystemId: string, endpoint: PortalEndpointPatch): Promise<void> {
      await ensure(healthSystemId);
      await patch(healthSystemId, {
        base_url_enc: await sealColumn(endpoint.baseUrl, "base_url", healthSystemId),
        mount_path_enc: await sealColumn(endpoint.mountPath, "mount_path", healthSystemId),
        // Null when the caller knew only the two columns: better an absent
        // endpoint the sign-in rebuilds than a stored one missing the half that
        // says how to sign in.
        endpoint_enc: await sealColumn(
          endpoint.endpoint === undefined ? null : JSON.stringify(endpoint.endpoint),
          "endpoint_json",
          healthSystemId,
        ),
      });
    },

    /**
     * The stored discovery result, or null when the column is NULL.
     *
     * **Deliberately not tolerant.** It used to swallow a validation failure and
     * answer null, which sent the sign-in to `fallbackEndpoint` -- so a stored
     * endpoint whose `baseUrl` was not an https origin was quietly replaced by
     * one built from the `base_url` column and used anyway. The schema now
     * checks both origins as https URLs, and a row that fails it has to stop the
     * sign-in rather than be worked around: the value decides where a password
     * is POSTed. Null still means "nothing was ever stored", which is the
     * pre-0003 row the fallback exists for.
     */
    async getEndpoint(healthSystemId: string): Promise<StoredPortalEndpoint | null> {
      const row = await byHealthSystem(healthSystemId);
      const json = row?.endpoint_json ?? null;
      if (json === null) return null;
      try {
        return parseJsonColumn(portalEndpointSchema, json, "portal_accounts.endpoint_json");
      } catch (error) {
        ctx.log.warn("portal_accounts.endpoint_unreadable", {
          healthSystemId,
          errorCode: isAppError(error) ? error.code : "internal",
        });
        throw new AppError(
          "portal_discovery_failed",
          "the stored portal endpoint is not usable; re-save the portal login",
          { healthSystemId },
          { cause: error },
        );
      }
    },

    /**
     * Store the owner's portal login, sealed.
     *
     * Storing credentials resets the session state to 'none' and drops the
     * cookie jar: a new password invalidates whatever the old jar held, and a
     * jar kept across a credential change is a session nobody can account for.
     */
    async setCredentials(
      healthSystemId: string,
      input: SetPortalCredentialsRequest,
    ): Promise<PortalAccountRow> {
      await ensure(healthSystemId);
      const columns: Record<string, unknown> = {
        username_enc: await sealShort(ctx.env, input.username, aad("username_enc", healthSystemId)),
        password_enc: await sealShort(ctx.env, input.password, aad("password_enc", healthSystemId)),
        cookie_jar_enc: null,
        session_state: "none" satisfies PortalSessionState,
        last_error_code: null,
        needs_reauth_since: null,
      };
      if (input.baseUrl !== undefined) {
        columns.base_url_enc = await sealColumn(input.baseUrl, "base_url", healthSystemId);
      }
      if (input.mountPath !== undefined) {
        columns.mount_path_enc = await sealColumn(input.mountPath, "mount_path", healthSystemId);
      }
      // Undefined leaves whatever is already stored alone -- most callers never
      // pass this, and a credential change is not a reason to forget it.
      if (input.mfaContact !== undefined) {
        columns.mfa_contact_enc = await sealShort(
          ctx.env,
          input.mfaContact,
          aad("mfa_contact_enc", healthSystemId),
        );
      }
      // Same rule as the contact above: undefined leaves whatever is stored
      // alone. Unlike the contact, this one is also *learned* -- see
      // `learnOtpSender` -- so overwriting it on every password change would
      // throw away the binding that makes an OTP claim safe.
      if (input.otpSenderDomain !== undefined) {
        columns.otp_sender_enc = await sealShort(
          ctx.env,
          normaliseDomain(input.otpSenderDomain),
          aad("otp_sender_enc", healthSystemId),
        );
      }
      await patch(healthSystemId, columns);
      ctx.log.info("portal_accounts.credentials_set", { healthSystemId });
      return require_(healthSystemId);
    },

    /** Decrypt the four sealed columns. The only way out of the db layer. */
    async getSecrets(healthSystemId: string): Promise<PortalAccountSecrets | null> {
      const row = await byHealthSystem(healthSystemId);
      if (row === null) return null;
      return {
        username: await openOrNull(ctx.env, row.username_enc, aad("username_enc", healthSystemId)),
        password: await openOrNull(ctx.env, row.password_enc, aad("password_enc", healthSystemId)),
        cookieJar: await openOrNull(
          ctx.env,
          row.cookie_jar_enc,
          aad("cookie_jar_enc", healthSystemId),
        ),
        mfaContact: await openOrNull(
          ctx.env,
          row.mfa_contact_enc,
          aad("mfa_contact_enc", healthSystemId),
        ),
      };
    },

    /**
     * The domain this account's verification codes are expected to come from.
     *
     * Null when nothing has set or learned one yet, which is what lets a first
     * sign-in fall back to the sender allowlist. Read on every code poll, so it
     * opens one column rather than going through `getSecrets`.
     */
    async getOtpSender(healthSystemId: string): Promise<string | null> {
      const row = await byHealthSystem(healthSystemId);
      return row === null
        ? null
        : openOrNull(ctx.env, row.otp_sender_enc, aad("otp_sender_enc", healthSystemId));
    },

    /**
     * Record the sender of a code the portal actually accepted.
     *
     * Only when there is nothing stored: an owner-set value is theirs, and a
     * learned one must not drift to whatever sent the most recent accepted code
     * -- that would undo the binding one successful sign-in at a time. Returns
     * whether it wrote.
     */
    async learnOtpSender(healthSystemId: string, senderDomain: string): Promise<boolean> {
      const domain = normaliseDomain(senderDomain);
      if (domain === "") return false;
      const row = await byHealthSystem(healthSystemId);
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- not equivalent: `row?.otp_sender_enc !== null` is `true` when `row` itself is null, which would report "already set" for an account that does not exist.
      if (row === null || row.otp_sender_enc !== null) return false;
      await patch(healthSystemId, {
        otp_sender_enc: await sealShort(ctx.env, domain, aad("otp_sender_enc", healthSystemId)),
      });
      ctx.log.info("portal_accounts.otp_sender_learned", { healthSystemId });
      return true;
    },

    /**
     * Persist the cookie jar after any call, successful or not.
     *
     * `null` forgets the session -- what the admin UI's "Forget session" button
     * does, and what a credential change does implicitly.
     */
    async saveCookieJar(healthSystemId: string, serialised: string | null): Promise<void> {
      await ensure(healthSystemId);
      const sealed =
        serialised === null
          ? null
          : await seal(ctx.env, serialised, aad("cookie_jar_enc", healthSystemId));
      await patch(healthSystemId, { cookie_jar_enc: sealed });
    },

    /**
     * A sign-in worked, or an authenticated call did: the session is live.
     *
     * Refuses when the endpoint is unknown, which the migration's CHECK would
     * otherwise turn into an opaque constraint violation.
     */
    async markActive(healthSystemId: string): Promise<void> {
      const row = await require_(healthSystemId);
      if (row.base_url === null || row.mount_path === null) {
        throw new AppError("conflict", "the portal endpoint is not known yet", { healthSystemId });
      }
      await patch(healthSystemId, {
        session_state: "active" satisfies PortalSessionState,
        last_ok_at: ctx.now(),
        last_error_code: null,
        needs_reauth_since: null,
      });
      ctx.log.info("portal_accounts.active", { healthSystemId });
    },

    /**
     * The portal will not let us in without the owner. Records the stable code
     * and stamps the clock the reconnect card is opened from.
     *
     * `needs_reauth_since` is only set on the *first* failure, so the card's age
     * reflects how long the owner has been ignoring it rather than resetting on
     * every hourly retry.
     *
     * Resolves with the code the row carried *before* this failure, or null when
     * it was not already failing, so a caller can tell a repeat of the same
     * failure from a first one without a counter column: `markActive` is what
     * clears it.
     */
    async markNeedsReauth(healthSystemId: string, errorCode: string): Promise<string | null> {
      const row = await require_(healthSystemId);
      await patch(healthSystemId, {
        session_state: "needs_reauth" satisfies PortalSessionState,
        last_error_code: errorCode,
        needs_reauth_since: row.needs_reauth_since ?? ctx.now(),
      });
      ctx.log.warn("portal_accounts.needs_reauth", { healthSystemId, errorCode });
      return row.session_state === "needs_reauth" ? row.last_error_code : null;
    },

    /**
     * Sign-in attempts used today.
     *
     * Zero once the stored day is not today's: see the module comment on why the
     * reset is a comparison rather than a sweep.
     */
    async countLoginAttemptsToday(healthSystemId: string): Promise<number> {
      const row = await byHealthSystem(healthSystemId);
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
    async recordLoginAttempt(healthSystemId: string): Promise<number> {
      await ensure(healthSystemId);
      const today = utcDay(ctx.now());
      await run(
        ctx.db
          .prepare(
            `UPDATE portal_accounts
                SET login_attempts_today =
                      CASE WHEN login_attempts_day = ? THEN login_attempts_today + 1 ELSE 1 END,
                    login_attempts_day = ?, last_login_at = ?, updated_at = ?
              WHERE health_system_id = ?`,
          )
          .bind(today, today, ctx.now(), ctx.now(), healthSystemId),
      );
      const row = await require_(healthSystemId);
      return row.login_attempts_today;
    },

    /**
     * Codes an unattended sign-in has had emailed today, and when the last was.
     *
     * The count is zero once its stored day is not today's, like
     * `countLoginAttemptsToday`; `lastAt` is kept across days, because spacing
     * codes out has nothing to do with where midnight falls.
     */
    async unattendedCodes(providerId: string): Promise<{ today: number; lastAt: number | null }> {
      const row = await byProvider(providerId);
      if (row === null) return { today: 0, lastAt: null };
      return {
        today: row.unattended_codes_day === utcDay(ctx.now()) ? row.unattended_codes_today : 0,
        lastAt: row.last_unattended_code_at,
      };
    },

    /**
     * Count one code an unattended sign-in is about to have emailed.
     *
     * Before the request, for the same reason `recordLoginAttempt` is: an
     * invocation that dies mid-send has still cost the owner an email. One
     * statement, so two overlapping runs cannot both read the same count.
     */
    async recordUnattendedCode(providerId: string): Promise<void> {
      await ensure(providerId);
      const today = utcDay(ctx.now());
      await run(
        ctx.db
          .prepare(
            `UPDATE portal_accounts
                SET unattended_codes_today =
                      CASE WHEN unattended_codes_day = ? THEN unattended_codes_today + 1 ELSE 1 END,
                    unattended_codes_day = ?, last_unattended_code_at = ?, updated_at = ?
              WHERE provider_id = ?`,
          )
          .bind(today, today, ctx.now(), ctx.now(), providerId),
      );
    },

    /**
     * Forget the stored session, keeping the credentials and the endpoint.
     *
     * What the admin UI's "Forget session" button does, and the honest way to
     * recover from a session the portal has decided it does not recognise: the
     * next run signs in from scratch rather than replaying a jar that no longer
     * works. The error and the reauth stamp go with it, because the state they
     * described is no longer the state.
     */
    async forgetSession(healthSystemId: string): Promise<void> {
      await require_(healthSystemId);
      await patch(healthSystemId, {
        cookie_jar_enc: null,
        session_state: "none" satisfies PortalSessionState,
        last_error_code: null,
        needs_reauth_since: null,
      });
      ctx.log.info("portal_accounts.session_forgotten", { healthSystemId });
    },

    /**
     * Forget the portal account entirely: credentials, jar, endpoint, counters.
     *
     * The row is deleted rather than blanked. A blanked row would keep
     * `login_attempts_today` -- so removing an account and adding it back would
     * inherit a spent budget -- and would leave `listActive` and the admin UI
     * reasoning about a row that describes nothing. The endpoint goes too: the
     * owner may be re-adding the account precisely because that was wrong.
     */
    async clear(healthSystemId: string): Promise<boolean> {
      const { changes } = await run(
        ctx.db
          .prepare("DELETE FROM portal_accounts WHERE health_system_id = ?")
          .bind(healthSystemId),
      );
      if (changes > 0) ctx.log.info("portal_accounts.cleared", { healthSystemId });
      return changes > 0;
    },

    /** The row as the admin UI sees it. Never a sealed column. */
    async dto(healthSystemId: string): Promise<PortalAccountDto | null> {
      const row = await byHealthSystem(healthSystemId);
      return row === null ? null : toPortalAccountDto(row, ctx.now());
    },
  };
}
