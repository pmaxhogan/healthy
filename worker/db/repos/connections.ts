/**
 * One connection per provider: the tokens, the status machine, and the lease.
 *
 * Two things here are load-bearing for correctness.
 *
 * **Sealing order.** The AAD binds a token to `connections.<column>.<id>`, so the
 * row id has to exist before anything can be sealed for it. `ensure()` therefore
 * creates a bare disconnected row first and every write seals against that id --
 * an `INSERT ... ON CONFLICT` that generated an id inline would seal against an
 * id the conflict then threw away.
 *
 * **The lease.** Epic rejects a refresh token the moment it has been redeemed, so
 * two concurrent refreshes lose the connection. `acquireLease` is a single
 * conditional UPDATE, and D1 reports how many rows it changed; exactly one caller
 * can see `changes === 1`. Expiry is in the predicate rather than a sweeper, so a
 * Worker that died holding a lease blocks nothing beyond the TTL.
 *
 * **Every token write carries the lease in its own predicate.** Holding the lease
 * when the refresh starts is not enough: a slow token endpoint can outlast the TTL,
 * a second refresher can take the lease and store its own rotated refresh token,
 * and the first one's write would then land on top -- leaving D1 holding a token
 * Epic has already invalidated, which is `invalid_grant` on the next run and a
 * re-auth for the owner. So `upsertTokensLeased` writes `WHERE lease_owner = ? AND
 * lease_expires_at > now` and answers `null` when that no longer holds, while
 * `upsertTokens` (the authorization callback, which holds no lease) writes only
 * while no *live* lease exists. An expired lease does not block the callback: a
 * Worker that died holding one leaves `lease_owner` set, and the owner reconnecting
 * must not be hostage to it.
 */

import { AppError } from "../../lib/errors.ts";
import { newId } from "../../lib/ids.ts";
import { all, one, run, ttlSeconds } from "../client.ts";
import { aadFor, openOrNull, seal, sealShort } from "../crypto.ts";

import type { Ctx } from "../client.ts";
import type { ConnectionRow, ConnectionStatus } from "../rows.ts";

interface TokenPatch {
  patientFhirId?: string;
  accessToken?: string;
  /** Unix second the access token stops working. */
  accessExpiresAt?: number;
  refreshToken?: string;
  scope?: string;
  status?: ConnectionStatus;
}

/** What the sync needs and the rest of the Worker must never see sealed. */
export interface ConnectionSecrets {
  patientFhirId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
}

const SELECT = "SELECT * FROM connections";

const aad = (column: string, id: string): string => aadFor("connections", column, id);

export function makeConnectionsRepo(ctx: Ctx) {
  const byId = async (id: string): Promise<ConnectionRow | null> =>
    one<ConnectionRow>(ctx.db.prepare(`${SELECT} WHERE id = ?`).bind(id));

  const byProvider = async (providerId: string): Promise<ConnectionRow | null> =>
    one<ConnectionRow>(ctx.db.prepare(`${SELECT} WHERE provider_id = ?`).bind(providerId));

  /** The row for a provider, created disconnected if it does not exist yet. */
  const ensure = async (providerId: string): Promise<ConnectionRow> => {
    const existing = await byProvider(providerId);
    if (existing !== null) return existing;
    const at = ctx.now();
    await run(
      ctx.db
        .prepare(
          `INSERT INTO connections (id, provider_id, status, created_at, updated_at)
           VALUES (?, ?, 'disconnected', ?, ?)
           ON CONFLICT (provider_id) DO NOTHING`,
        )
        .bind(newId(), providerId, at, at),
    );
    const created = await byProvider(providerId);
    if (created === null) {
      // Unreachable short of the provider row vanishing mid-call, in which case
      // the FK would have thrown above.
      throw new Error("connection row disappeared after insert");
    }
    return created;
  };

  const setStatus = async (
    id: string,
    status: ConnectionStatus,
    extra: { errorCode?: string | null; needsReauthSince?: number | null } = {},
  ): Promise<boolean> => {
    const { changes } = await run(
      ctx.db
        .prepare(
          `UPDATE connections
              SET status = ?, last_error_code = ?, needs_reauth_since = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(status, extra.errorCode ?? null, extra.needsReauthSince ?? null, ctx.now(), id),
    );
    return changes > 0;
  };

  /** One token write, guarded by whatever predicate the caller's lease demands. */
  const writeTokens = async (
    providerId: string,
    patch: TokenPatch,
    guard: { clause: string; values: unknown[] },
  ): Promise<ConnectionRow | null> => {
    const row = await ensure(providerId);
    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.patientFhirId !== undefined) {
      put(
        "patient_fhir_id_enc",
        await sealShort(ctx.env, patch.patientFhirId, aad("patient_fhir_id_enc", row.id)),
      );
    }
    if (patch.accessToken !== undefined) {
      put(
        "access_token_enc",
        await seal(ctx.env, patch.accessToken, aad("access_token_enc", row.id)),
      );
    }
    if (patch.refreshToken !== undefined) {
      put(
        "refresh_token_enc",
        await seal(ctx.env, patch.refreshToken, aad("refresh_token_enc", row.id)),
      );
    }
    if (patch.accessExpiresAt !== undefined) put("access_expires_at", patch.accessExpiresAt);
    if (patch.scope !== undefined) put("scope", patch.scope);
    if (patch.status !== undefined) put("status", patch.status);
    // Only a write that actually moved a token counts as a refresh: the keepalive
    // reads this column to decide whether one is due, and a status-only patch must
    // not make a stale token look fresh.
    if (patch.accessToken !== undefined || patch.refreshToken !== undefined) {
      put("last_refresh_at", ctx.now());
    }
    put("updated_at", ctx.now());

    const { changes } = await run(
      ctx.db
        .prepare(`UPDATE connections SET ${sets.join(", ")} WHERE id = ? ${guard.clause}`)
        .bind(...values, row.id, ...guard.values),
    );
    if (changes === 0) return null;
    const updated = await byId(row.id);
    return updated ?? row;
  };

  return {
    get: byId,
    getForProvider: byProvider,

    async list(): Promise<ConnectionRow[]> {
      return all<ConnectionRow>(ctx.db.prepare(`${SELECT} ORDER BY created_at`));
    },

    /**
     * Connections the scheduled sync should touch: connected, and belonging to a
     * provider that has not been soft-deleted.
     */
    async listActive(): Promise<ConnectionRow[]> {
      return all<ConnectionRow>(
        ctx.db.prepare(
          `SELECT c.* FROM connections c
             JOIN providers p ON p.id = c.provider_id
            WHERE c.status = 'connected' AND p.deleted_at IS NULL
            ORDER BY c.created_at`,
        ),
      );
    },

    /**
     * Store whichever token fields the caller has, sealed, while no refresh is in
     * flight.
     *
     * For the authorization callback, which holds no lease. Throws `conflict` when a
     * live lease says a refresh is mid-flight: the alternative is overwriting a
     * refresh token that has just been rotated, and a 409 the owner can retry is
     * cheaper than a connection that needs re-authorising.
     *
     * Callers must persist a new refresh token *before* using the access token it
     * came with: if the write fails after a successful refresh, the old refresh
     * token is already dead and the connection is unrecoverable without a re-auth.
     */
    async upsertTokens(providerId: string, patch: TokenPatch): Promise<ConnectionRow> {
      const row = await writeTokens(providerId, patch, {
        clause: "AND (lease_expires_at IS NULL OR lease_expires_at <= ?)",
        values: [ctx.now()],
      });
      if (row === null) {
        ctx.log.warn("connections.token_write_blocked", { providerId });
        throw new AppError("conflict", "a token refresh holds the connection lease", {
          providerId,
        });
      }
      return row;
    },

    /**
     * Store tokens under the lease this caller holds.
     *
     * `null` means the write was rejected -- the lease expired, or somebody else
     * took it -- and the caller must discard the tokens it just obtained rather
     * than write them anyway: the winner's rotated refresh token is the one the
     * organisation will accept next time.
     */
    async upsertTokensLeased(
      providerId: string,
      owner: string,
      patch: TokenPatch,
    ): Promise<ConnectionRow | null> {
      const row = await writeTokens(providerId, patch, {
        clause: "AND lease_owner = ? AND lease_expires_at > ?",
        values: [owner, ctx.now()],
      });
      if (row === null) ctx.log.warn("connections.lease_lost", { providerId });
      return row;
    },

    /** Decrypt the three sealed columns. The only way out of the db layer. */
    async getSecrets(id: string): Promise<ConnectionSecrets | null> {
      const row = await byId(id);
      if (row === null) return null;
      return {
        patientFhirId: await openOrNull(
          ctx.env,
          row.patient_fhir_id_enc,
          aad("patient_fhir_id_enc", id),
        ),
        accessToken: await openOrNull(ctx.env, row.access_token_enc, aad("access_token_enc", id)),
        refreshToken: await openOrNull(
          ctx.env,
          row.refresh_token_enc,
          aad("refresh_token_enc", id),
        ),
      };
    },

    /** A successful authorization or refresh: clear the error and the re-auth clock. */
    async markConnected(id: string): Promise<boolean> {
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE connections
                SET status = 'connected', last_error_code = NULL, needs_reauth_since = NULL,
                    refresh_failures = 0, updated_at = ?
              WHERE id = ?`,
          )
          .bind(ctx.now(), id),
      );
      if (changes > 0) ctx.log.info("connections.connected", { connectionId: id });
      return changes > 0;
    },

    /**
     * The refresh token was rejected. Records the code, stamps the clock the
     * Trello card is opened from, and counts the failure.
     */
    async markNeedsReauth(id: string, errorCode: string): Promise<boolean> {
      const existing = await byId(id);
      const since = existing?.needs_reauth_since ?? ctx.now();
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE connections
                SET status = 'needs_reauth', last_error_code = ?, needs_reauth_since = ?,
                    refresh_failures = refresh_failures + 1, updated_at = ?
              WHERE id = ?`,
          )
          .bind(errorCode, since, ctx.now(), id),
      );
      if (changes > 0) ctx.log.warn("connections.needs_reauth", { connectionId: id, errorCode });
      return changes > 0;
    },

    /** A transient failure that is not an auth problem. */
    async markError(id: string, errorCode: string): Promise<boolean> {
      return setStatus(id, "error", { errorCode });
    },

    /**
     * Forget everything the grant gave us, keeping the row so its history survives.
     *
     * The patient identifier goes with the tokens, and the scope and the lease with
     * it. The privacy page says disconnecting revokes what is stored, and a sealed
     * identifier left behind would make that only mostly true -- it is the one
     * column here that names a person.
     */
    async disconnect(id: string): Promise<boolean> {
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE connections
                SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL,
                    patient_fhir_id_enc = NULL, scope = NULL, access_expires_at = NULL,
                    needs_reauth_since = NULL, lease_owner = NULL, lease_expires_at = NULL,
                    updated_at = ?
              WHERE id = ?`,
          )
          .bind(ctx.now(), id),
      );
      return changes > 0;
    },

    /** Stamp the clock for whichever kind of sync just finished. */
    async recordSync(id: string, kind: "calendar" | "full"): Promise<boolean> {
      const column = kind === "calendar" ? "last_sync_at" : "last_full_refresh_at";
      const { changes } = await run(
        ctx.db
          .prepare(`UPDATE connections SET ${column} = ?, updated_at = ? WHERE id = ?`)
          .bind(ctx.now(), ctx.now(), id),
      );
      return changes > 0;
    },

    /**
     * Try to become the single writer for this connection for `ttlMs`.
     *
     * Atomic: the predicate and the write are one statement, so the winner is
     * whichever UPDATE the database applied first. Returns false to a caller that
     * should wait and re-read rather than refresh.
     */
    async acquireLease(connectionId: string, owner: string, ttlMs: number): Promise<boolean> {
      const now = ctx.now();
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE connections
                SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
              WHERE id = ?
                AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
          )
          .bind(owner, now + ttlSeconds(ttlMs), now, connectionId, now),
      );
      return changes === 1;
    },

    /** Release a lease this owner holds. A lease someone else took is left alone. */
    async releaseLease(connectionId: string, owner: string): Promise<boolean> {
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE connections
                SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE id = ? AND lease_owner = ?`,
          )
          .bind(ctx.now(), connectionId, owner),
      );
      return changes === 1;
    },
  };
}
