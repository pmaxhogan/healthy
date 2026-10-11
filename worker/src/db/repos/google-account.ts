/**
 * The single Google account the calendar is written to.
 *
 * Exactly one row, `id = 1`, seeded by the migration and CHECK-constrained so a
 * second can never appear. Everything here is an UPDATE for that reason -- there
 * is no insert path, and the AAD row id is the constant "1".
 *
 * The lease mirrors the one on `connections`: Google's refresh tokens survive
 * re-use, but two concurrent refreshes still race to write `access_token_enc`, and
 * the loser can persist a token that has already been superseded.
 *
 * And as on `connections`, holding the lease when the refresh began is not enough:
 * `upsertTokensLeased` puts `lease_owner = ? AND lease_expires_at > now` in the
 * write's own predicate, so a refresher whose lease expired mid-flight cannot land
 * a stale access token on top of the winner's. `upsertTokens` -- the consent
 * callback, which holds no lease -- writes only while no live lease exists.
 */

import { AppError } from "../../lib/errors.ts";
import { one, run, ttlSeconds } from "../client.ts";
import { aadFor, openOrNull, seal, sealShort } from "../crypto.ts";

import type { Ctx } from "../client.ts";
import type { ConnectionStatus, GoogleAccountRow } from "../rows.ts";

const ROW_ID = 1;

const aad = (column: string): string => aadFor("google_account", column, ROW_ID);

interface GooglePatch {
  email?: string;
  accessToken?: string;
  accessExpiresAt?: number;
  refreshToken?: string;
  scope?: string;
  status?: ConnectionStatus;
}

export interface GoogleSecrets {
  email: string | null;
  accessToken: string | null;
  refreshToken: string | null;
}

export function makeGoogleAccountRepo(ctx: Ctx) {
  const read = async (): Promise<GoogleAccountRow> => {
    const row = await one<GoogleAccountRow>(
      ctx.db.prepare("SELECT * FROM google_account WHERE id = ?").bind(ROW_ID),
    );
    if (row === null) {
      // The migration seeds this row; its absence means the schema is not applied.
      throw new Error("google_account row 1 is missing -- migrations not applied?");
    }
    return row;
  };

  /** One token write, guarded by whatever predicate the caller's lease demands. */
  const writeTokens = async (
    patch: GooglePatch,
    guard: { clause: string; values: unknown[] },
  ): Promise<GoogleAccountRow | null> => {
    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.email !== undefined) {
      put("email_enc", await sealShort(ctx.env, patch.email, aad("email_enc")));
    }
    if (patch.accessToken !== undefined) {
      put("access_token_enc", await seal(ctx.env, patch.accessToken, aad("access_token_enc")));
    }
    if (patch.refreshToken !== undefined) {
      put("refresh_token_enc", await seal(ctx.env, patch.refreshToken, aad("refresh_token_enc")));
    }
    if (patch.accessExpiresAt !== undefined) put("access_expires_at", patch.accessExpiresAt);
    if (patch.scope !== undefined) put("scope", patch.scope);
    if (patch.status !== undefined) put("status", patch.status);
    put("last_refresh_at", ctx.now());
    put("updated_at", ctx.now());

    const { changes } = await run(
      ctx.db
        .prepare(`UPDATE google_account SET ${sets.join(", ")} WHERE id = ? ${guard.clause}`)
        .bind(...values, ROW_ID, ...guard.values),
    );
    return changes === 0 ? null : read();
  };

  return {
    get: read,

    /**
     * Store whichever fields the caller has, sealed, while no refresh is in flight.
     *
     * The status only moves if the caller passes one; `markConnected()` is the
     * separate step that does that. Throws `conflict` when a live lease says a
     * refresh is mid-flight -- see the module comment.
     */
    async upsertTokens(patch: GooglePatch): Promise<GoogleAccountRow> {
      const row = await writeTokens(patch, {
        clause: "AND (lease_expires_at IS NULL OR lease_expires_at <= ?)",
        values: [ctx.now()],
      });
      if (row === null) {
        ctx.log.warn("google.token_write_blocked");
        throw new AppError("conflict", "a token refresh holds the Google account lease");
      }
      return row;
    },

    /**
     * Store tokens under the lease this caller holds.
     *
     * `null` means the lease expired or somebody else took it, so the token this
     * caller obtained must be discarded rather than written over the winner's.
     */
    async upsertTokensLeased(owner: string, patch: GooglePatch): Promise<GoogleAccountRow | null> {
      const row = await writeTokens(patch, {
        clause: "AND lease_owner = ? AND lease_expires_at > ?",
        values: [owner, ctx.now()],
      });
      if (row === null) ctx.log.warn("google.lease_lost");
      return row;
    },

    async getSecrets(): Promise<GoogleSecrets> {
      const row = await read();
      return {
        email: await openOrNull(ctx.env, row.email_enc, aad("email_enc")),
        accessToken: await openOrNull(ctx.env, row.access_token_enc, aad("access_token_enc")),
        refreshToken: await openOrNull(ctx.env, row.refresh_token_enc, aad("refresh_token_enc")),
      };
    },

    async markConnected(): Promise<void> {
      const at = ctx.now();
      await run(
        ctx.db
          .prepare(
            `UPDATE google_account
                SET status = 'connected', needs_reauth_since = NULL,
                    connected_at = COALESCE(connected_at, ?), updated_at = ?
              WHERE id = ?`,
          )
          .bind(at, at, ROW_ID),
      );
    },

    /** Google rejected the refresh token: the owner has to consent again. */
    async markNeedsReauth(): Promise<void> {
      const row = await read();
      const at = ctx.now();
      await run(
        ctx.db
          .prepare(
            `UPDATE google_account
                SET status = 'needs_reauth', needs_reauth_since = ?, updated_at = ?
              WHERE id = ?`,
          )
          .bind(row.needs_reauth_since ?? at, at, ROW_ID),
      );
      ctx.log.warn("google.needs_reauth");
    },

    /** Forget the tokens. The row itself stays, because it has to. */
    async disconnect(): Promise<void> {
      await run(
        ctx.db
          .prepare(
            `UPDATE google_account
                SET status = 'disconnected', email_enc = NULL, access_token_enc = NULL,
                    refresh_token_enc = NULL, access_expires_at = NULL, scope = NULL,
                    needs_reauth_since = NULL, connected_at = NULL, updated_at = ?
              WHERE id = ?`,
          )
          .bind(ctx.now(), ROW_ID),
      );
    },

    /** Single-flight guard around a Google token refresh. See connections. */
    async acquireLease(owner: string, ttlMs: number): Promise<boolean> {
      const now = ctx.now();
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE google_account
                SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
              WHERE id = ? AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
          )
          .bind(owner, now + ttlSeconds(ttlMs), now, ROW_ID, now),
      );
      return changes === 1;
    },

    async releaseLease(owner: string): Promise<boolean> {
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE google_account
                SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE id = ? AND lease_owner = ?`,
          )
          .bind(ctx.now(), ROW_ID, owner),
      );
      return changes === 1;
    },
  };
}
