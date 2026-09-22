/**
 * Rate-limit detection and the whole-sync backoff.
 *
 * The rule from the spec: any 429 anywhere backs *every* provider off until
 * `now + max(Retry-After, 2h)`. Two hours rather than the header's own value
 * because a patient-facing Epic endpoint that starts rate-limiting is throttling
 * the app, not one request -- retrying in the 60 seconds it asked for just burns
 * the next quota window too. The longer of the two is taken so an organisation
 * asking for a day gets a day.
 *
 * Detection has to cope with three shapes, because three different layers report
 * the same upstream condition:
 *
 *   - `retriedFetch` exhausted its own retries on a 429 and the FHIR client
 *     rewrapped it as `upstream_unavailable` carrying `retryAfterMs`
 *   - the Google client turned a quota-exhausted **403** into
 *     `upstream_unavailable` (Google uses 403, not 429, for most quota)
 *   - something reported `details.status === 429` directly
 *
 * The seconds/milliseconds boundary lives here too: `Ctx.now()` and
 * `settings.sync_backoff_until` are unix seconds, while `retryAfterMs` and every
 * `RetryOpts` value are milliseconds.
 */

import { isAppError } from "../lib/errors.ts";

/** The floor on a rate-limit backoff. Two hours, in milliseconds. */
export const MIN_BACKOFF_MS = 2 * 60 * 60 * 1000;

/** What a detected rate limit tells us. */
export interface RateLimit {
  /** The server's Retry-After, when it sent one. */
  retryAfterMs: number | undefined;
  /** Where it came from, for the log line. Never a URL. */
  status: number | null;
}

/**
 * Whether this error means "you are going too fast".
 *
 * Returns null for everything else, including `upstream_auth` and
 * `needs_reauth`: those are per-connection problems and must not stop the other
 * providers' runs.
 */
export function rateLimitOf(error: unknown): RateLimit | null {
  if (!isAppError(error)) return null;
  const rawStatus = error.details?.status;
  const status = typeof rawStatus === "number" ? rawStatus : null;
  const isRateLimited =
    error.code === "rate_limited" ||
    status === 429 ||
    (error.code === "upstream_unavailable" && error.retryAfterMs !== undefined);
  return isRateLimited ? { retryAfterMs: error.retryAfterMs, status } : null;
}

/**
 * The unix second every sync should stay away until.
 *
 * `Math.ceil` rather than floor: rounding a backoff down would let the next
 * hourly run start inside the window the organisation asked for.
 */
export function backoffUntilSeconds(nowSeconds: number, retryAfterMs?: number): number {
  const windowMs = Math.max(retryAfterMs ?? 0, MIN_BACKOFF_MS);
  return nowSeconds + Math.ceil(windowMs / 1000);
}
