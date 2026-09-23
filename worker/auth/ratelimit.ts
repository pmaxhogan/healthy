// Login rate limiting: 10 attempts per client per 15 minutes.
//
// The password is a 24-character base58 secret, so this is not what stops an
// offline attack -- PBKDF2 at 600k iterations is. What it stops is a *sustained*
// online one: without a limiter, an attacker behind Cloudflare Access (or
// hitting the origin during a misconfiguration) could spend the Worker's CPU
// budget guessing, and each guess costs the Worker far more than it costs them.
//
// The client key is a keyed HMAC of `cf-connecting-ip` (see
// `worker/db/blind.ts`), never the address itself: the table is a persistent
// record of who tried to log in, and an IP is personal data. A plain sha256 would
// not do -- all 2^32 IPv4 addresses hash in seconds, so an unkeyed digest is the
// address with extra steps. Keyed, the counter still works and the row is
// useless to anyone reading the database without `DATA_KEY`.
//
// The counter is one atomic UPSERT ... RETURNING, so two concurrent attempts
// cannot both read "9" and both be allowed.

import { blinderFor } from "../db/blind.ts";

import type { KeySource } from "../db/crypto.ts";

/** Attempts allowed inside one window before the limiter closes. */
export const LOGIN_MAX_ATTEMPTS = 10;

/** Window length, in seconds. */
export const LOGIN_WINDOW_SECONDS = 15 * 60;

/** One `login_attempts` row. */
export interface LoginAttemptWindow {
  count: number;
  windowStart: number;
}

/**
 * The persistence this module needs, as an interface rather than a `D1Database`.
 *
 * Two reasons. It keeps the module importable from the plain-Node unit project,
 * which has no Workers globals; and it makes the limiter's decision logic
 * testable without standing up a database, leaving the SQL itself to the
 * integration suite where it runs against real D1.
 */
export interface LoginAttemptStore {
  /** Increment the client's counter, resetting it first if its window rolled over. */
  bump(ipHash: string, nowSeconds: number): Promise<LoginAttemptWindow>;
  /** Forget the client's counter. Called on a successful login. */
  clear(ipHash: string): Promise<void>;
}

/** The minimum of D1 this module touches, so it needs no Workers global types. */
export interface LoginAttemptsDatabase {
  prepare(query: string): LoginAttemptsStatement;
}
interface LoginAttemptsStatement {
  bind(...values: unknown[]): LoginAttemptsStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}

/**
 * Written against the `login_attempts(ip_hash PK, count, window_start)` columns
 * from migrations/0001_init.sql directly, rather than through the repository
 * layer: the limiter has to run before anything else on the login path, so it
 * should not depend on a module that may itself want a database.
 *
 * `window_start <= cutoff` is "the window has expired", where `cutoff = now -
 * LOGIN_WINDOW_SECONDS`. `excluded.window_start` is the `now` from VALUES, so a
 * rolled-over window restarts at this attempt. Times are unix seconds, matching
 * the `unixepoch()` default the rest of the schema uses.
 */
const BUMP_SQL = `
INSERT INTO login_attempts (ip_hash, count, window_start) VALUES (?, 1, ?)
ON CONFLICT(ip_hash) DO UPDATE SET
  count        = iif(login_attempts.window_start <= ?, 1, login_attempts.count + 1),
  window_start = iif(login_attempts.window_start <= ?, excluded.window_start, login_attempts.window_start)
RETURNING count, window_start
`;

export function d1LoginAttemptStore(db: LoginAttemptsDatabase): LoginAttemptStore {
  return {
    async bump(ipHash, nowSeconds) {
      const cutoff = nowSeconds - LOGIN_WINDOW_SECONDS;
      const row = await db
        .prepare(BUMP_SQL)
        .bind(ipHash, nowSeconds, cutoff, cutoff)
        .first<{ count: number; window_start: number }>();
      // RETURNING always yields the row it just wrote; treat a null as the
      // first attempt rather than as permission to skip the limit.
      return { count: row?.count ?? 1, windowStart: row?.window_start ?? nowSeconds };
    },
    async clear(ipHash) {
      await db.prepare("DELETE FROM login_attempts WHERE ip_hash = ?").bind(ipHash).run();
    },
  };
}

/** Stable, keyed, non-reversible key for one client. */
export async function hashClientIp(request: Request, keySource: KeySource): Promise<string> {
  // A request that reaches the Worker without the header is either a test or a
  // direct origin hit; bucketing them all together is the conservative choice.
  return blinderFor(keySource).digest(
    "login_attempts.ip_hash",
    request.headers.get("cf-connecting-ip") ?? "unknown",
  );
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Attempts recorded in the current window, including this one. */
  count: number;
  /** Seconds until the window rolls over. At least 1, so `Retry-After` is never 0. */
  retryAfterSeconds: number;
}

/** Turns a counter row into an allow/deny plus the `Retry-After` the client gets. */
export function decide(window: LoginAttemptWindow, nowSeconds: number): RateLimitDecision {
  const resetsAt = window.windowStart + LOGIN_WINDOW_SECONDS;
  return {
    allowed: window.count <= LOGIN_MAX_ATTEMPTS,
    count: window.count,
    retryAfterSeconds: Math.max(1, resetsAt - nowSeconds),
  };
}

/**
 * Records one login attempt and says whether it may proceed.
 *
 * Every attempt is counted, successful ones included, and a success then clears
 * the counter (see {@link forgetLoginAttempts}). Counting only failures would let
 * an attacker with one known-good password keep a window open indefinitely.
 */
export async function recordLoginAttempt(
  store: LoginAttemptStore,
  ipHash: string,
  nowSeconds: number,
): Promise<RateLimitDecision> {
  return decide(await store.bump(ipHash, nowSeconds), nowSeconds);
}

/** Clears a client's counter after a successful login. */
export async function forgetLoginAttempts(store: LoginAttemptStore, ipHash: string): Promise<void> {
  await store.clear(ipHash);
}
