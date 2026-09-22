/**
 * Rate limiting for the admin password gate.
 *
 * Keyed by a hash of the client IP -- `sha256`, not salted or keyed, so an
 * attacker with a copy of this table can confirm a guessed address. The rows are
 * counters inside a 15-minute window and nothing joins to them, so what leaks is
 * "somebody at this address tried to log in recently"; `hashClientIp` in
 * `worker/auth/ratelimit.ts` is the one place to change if that stops being
 * acceptable. The caller hashes, so this table never sees an address. A fixed window rather than a sliding one -- one row, one
 * counter, and a lockout that is easy to explain and easy to wait out.
 *
 * `increment` is a single statement so two simultaneous guesses cannot both read
 * a stale count. The window roll happens inside the `ON CONFLICT` expression:
 * when the stored window has expired, the count resets to 1 instead of growing.
 */

import { all, one, run } from "../client.ts";

import type { Ctx } from "../client.ts";
import type { LoginAttemptRow } from "../rows.ts";

/** Failures inside one window before the gate refuses to try the password. */
export const LOGIN_MAX_ATTEMPTS = 10;
/** Length of the window, in seconds. */
export const LOGIN_WINDOW_SECONDS = 900;

interface Limits {
  limit?: number;
  windowSeconds?: number;
}

export function makeLoginAttemptsRepo(ctx: Ctx) {
  const read = async (ipHash: string): Promise<LoginAttemptRow | null> =>
    one<LoginAttemptRow>(
      ctx.db.prepare("SELECT * FROM login_attempts WHERE ip_hash = ?").bind(ipHash),
    );

  return {
    /**
     * Count one failed attempt and return the count inside the current window.
     *
     * A count that comes back above the limit is the signal to lock out; the
     * caller does not have to re-read.
     */
    async increment(ipHash: string, options: Limits = {}): Promise<number> {
      const windowSeconds = options.windowSeconds ?? LOGIN_WINDOW_SECONDS;
      const at = ctx.now();
      const row = await one<Pick<LoginAttemptRow, "count">>(
        ctx.db
          .prepare(
            `INSERT INTO login_attempts (ip_hash, count, window_start) VALUES (?, 1, ?)
             ON CONFLICT (ip_hash) DO UPDATE SET
               count = CASE WHEN login_attempts.window_start + ? <= ? THEN 1 ELSE login_attempts.count + 1 END,
               window_start = CASE WHEN login_attempts.window_start + ? <= ? THEN ? ELSE login_attempts.window_start END
             RETURNING count`,
          )
          .bind(ipHash, at, windowSeconds, at, windowSeconds, at, at),
      );
      return row?.count ?? 1;
    },

    /** Clear the counter. Called on a successful login. */
    async reset(ipHash: string): Promise<void> {
      await run(ctx.db.prepare("DELETE FROM login_attempts WHERE ip_hash = ?").bind(ipHash));
    },

    /**
     * True when this client has used up its attempts and the window has not yet
     * rolled. An expired window is not blocked, whatever the stored count says.
     */
    async isBlocked(ipHash: string, options: Limits = {}): Promise<boolean> {
      const limit = options.limit ?? LOGIN_MAX_ATTEMPTS;
      const windowSeconds = options.windowSeconds ?? LOGIN_WINDOW_SECONDS;
      const row = await read(ipHash);
      if (row === null) return false;
      const rolled = row.window_start + windowSeconds <= ctx.now();
      return !rolled && row.count >= limit;
    },

    get: read,

    /** Drop rows whose window has rolled. Called from the scheduled handler. */
    async purgeExpired(windowSeconds = LOGIN_WINDOW_SECONDS): Promise<number> {
      const { changes } = await run(
        ctx.db
          .prepare("DELETE FROM login_attempts WHERE window_start + ? <= ?")
          .bind(windowSeconds, ctx.now()),
      );
      return changes;
    },

    /** Everything currently counted. For the admin UI's security panel. */
    async list(): Promise<LoginAttemptRow[]> {
      return all<LoginAttemptRow>(
        ctx.db.prepare("SELECT * FROM login_attempts ORDER BY window_start DESC"),
      );
    },
  };
}
