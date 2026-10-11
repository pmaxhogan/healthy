/**
 * In-flight authorization requests: the CSRF `state` and the PKCE verifier.
 *
 * `consume` is the security-relevant operation. It is a single
 * `DELETE ... RETURNING`, so a state can be redeemed exactly once however many
 * times the callback URL is replayed -- the second call finds nothing. Checking
 * expiry after the delete rather than in the predicate is deliberate: an expired
 * state should be removed as well as refused.
 *
 * The verifier is sealed, because it is the second half of the PKCE proof and a
 * D1 dump containing both it and a leaked authorization code would be enough to
 * complete someone else's flow.
 */

import { newToken } from "../../lib/ids.ts";
import { one, run, ttlSeconds } from "../client.ts";
import { aadFor, open, seal } from "../crypto.ts";

import type { Ctx } from "../client.ts";
import type { OAuthStateKind, OAuthStateRow } from "../rows.ts";

interface PutState {
  kind: OAuthStateKind;
  /** Required for `epic`, forbidden for `google` (a CHECK enforces it). */
  healthSystemId?: string | null;
  codeVerifier: string;
  /** Where to send the browser once the callback has finished. */
  redirectAfter?: string | null;
  ttlMs: number;
}

const aad = (state: string): string => aadFor("oauth_states", "code_verifier_enc", state);

export interface ConsumedState {
  state: string;
  kind: OAuthStateKind;
  healthSystemId: string | null;
  codeVerifier: string;
  redirectAfter: string | null;
}

export function makeOAuthStatesRepo(ctx: Ctx) {
  return {
    /** Store a new state and hand back the opaque value to put in the URL. */
    async put(input: PutState): Promise<string> {
      const state = newToken();
      const at = ctx.now();
      const verifierEnc = await seal(ctx.env, input.codeVerifier, aad(state));
      await run(
        ctx.db
          .prepare(
            `INSERT INTO oauth_states
               (state, kind, health_system_id, code_verifier_enc, redirect_after, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            state,
            input.kind,
            input.healthSystemId ?? null,
            verifierEnc,
            input.redirectAfter ?? null,
            at,
            at + ttlSeconds(input.ttlMs),
          ),
      );
      return state;
    },

    /**
     * Redeem a state exactly once. Returns null for an unknown, already-redeemed
     * or expired state -- the caller cannot tell which, which is the point.
     */
    async consume(state: string): Promise<ConsumedState | null> {
      const row = await one<OAuthStateRow>(
        ctx.db.prepare("DELETE FROM oauth_states WHERE state = ? RETURNING *").bind(state),
      );
      if (row === null) return null;
      if (row.expires_at <= ctx.now()) {
        ctx.log.warn("oauth_states.expired", { kind: row.kind });
        return null;
      }
      return {
        state: row.state,
        kind: row.kind,
        healthSystemId: row.health_system_id,
        codeVerifier: await open(ctx.env, row.code_verifier_enc, aad(row.state)),
        redirectAfter: row.redirect_after,
      };
    },

    /** Drop everything past its expiry. Called from the scheduled handler. */
    async purgeExpired(): Promise<number> {
      const { changes } = await run(
        ctx.db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(ctx.now()),
      );
      return changes;
    },

    /** How many states are currently in flight. For the overview panel. */
    async count(): Promise<number> {
      const row = await one<{ n: number }>(
        ctx.db.prepare("SELECT COUNT(*) AS n FROM oauth_states"),
      );
      return row?.n ?? 0;
    },
  };
}
