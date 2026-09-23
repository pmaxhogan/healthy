/**
 * Application error taxonomy. Codes are stable strings that end up in run logs,
 * audit rows and API error bodies; messages never contain clinical content.
 */

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "upstream_auth" // upstream returned 401/403: token invalid or scope missing
  | "upstream_unavailable" // transient upstream failure after retries
  | "upstream_error" // permanent upstream 4xx
  | "needs_reauth" // refresh token rejected (invalid_grant)
  | "not_connected"
  | "policy_denied"
  | "crypto"
  | "internal"
  // Patient-portal scrape (worker/providers/mychart/**). These are deliberately
  // fine-grained: the sync's recovery is different for each one -- an expired
  // session is re-authenticated in place, a rejected code asks the owner for a
  // fresh one, a locked account or a bot block must stop trying.
  | "portal_login_failed" // username/password rejected
  | "portal_handoff_failed" // signed in, but the OpenID handoff to the classic session did not complete
  | "portal_2fa_required" // the portal wants an emailed code before it will answer
  | "portal_2fa_rejected" // the code was wrong, stale, or already used
  | "portal_locked" // the portal locked or disabled the account
  | "portal_captcha_required" // the portal wants a captcha solved before another attempt
  | "portal_bot_blocked" // 403/429 or a challenge page: a WAF, not a credential problem
  | "portal_session_expired" // an authenticated call bounced to the login page
  | "portal_parse_failed" // the response was not the shape this client can read
  | "portal_unreachable" // network failure, timeout, or 5xx after retries
  // The two the admin API raises about a portal account rather than about the
  // portal itself, so unlike the codes above they really are 4xx: the owner gave
  // a URL that hosts no login page, or asked for one sign-in too many today.
  | "portal_discovery_failed"
  | "portal_attempts_exhausted"
  // The scheduled sync has used what it may of the day's sign-ins and emailed
  // codes on its own; the rest are kept for the owner's "Sign in now".
  | "portal_signin_needs_owner"
  // Three more the admin API raises about where a portal *is*, rather than about
  // what it answered. All 4xx for the same reason as the two above: each one is
  // about a URL the owner gave, or a redirect chain from it.
  | "portal_redirected_offsite" // the chain left the site the owner pasted
  | "portal_insecure_redirect" // the chain left https, or never was https
  | "portal_origin_unconfirmed"; // credentials offered against an unconfirmed origin

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  upstream_auth: 502,
  upstream_unavailable: 503,
  upstream_error: 502,
  needs_reauth: 409,
  not_connected: 409,
  policy_denied: 403,
  crypto: 500,
  internal: 500,
  // A portal failure is never the API caller's fault, so none of these is a 4xx
  // on our own surface. `portal_2fa_required` is the one the admin UI acts on
  // (it asks the owner to wait for the emailed code), which is why it is a 409
  // rather than a 502: there is something the owner can do about it.
  portal_login_failed: 502,
  // Same rationale as portal_login_failed: the credentials were fine, but the
  // handoff to the classic session never landed, which is just as much "not
  // our caller's fault" as a rejected password.
  portal_handoff_failed: 502,
  portal_2fa_required: 409,
  portal_2fa_rejected: 409,
  portal_locked: 409,
  // Same rationale as portal_locked: a script cannot solve it, only the owner
  // signing in once themselves can.
  portal_captcha_required: 409,
  portal_bot_blocked: 503,
  portal_session_expired: 409,
  portal_parse_failed: 502,
  portal_unreachable: 503,
  // These two are the caller's: a URL that hosts no portal is a bad request, and
  // the daily sign-in budget is this app's own rate limit.
  portal_discovery_failed: 400,
  portal_attempts_exhausted: 429,
  // Not raised to an API caller today, but typed like its neighbour: the app's
  // own limit on unattended sign-ins, which only the owner's button gets past.
  portal_signin_needs_owner: 409,
  portal_redirected_offsite: 400,
  portal_insecure_redirect: 400,
  portal_origin_unconfirmed: 400,
};

export interface AppErrorBody {
  error: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  /** HTTP status this code maps to, for the API error handler. */
  readonly status: number;
  /** Set when the cause carried a Retry-After, so a caller can honour it. */
  readonly retryAfterMs: number | undefined;

  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message ?? code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    // `STATUS[code]`: `code` is the `ErrorCode` union, so this is a total lookup.
    this.status = STATUS[code];
    this.retryAfterMs = options?.retryAfterMs;
  }

  toBody(): AppErrorBody {
    const body: AppErrorBody = { error: this.code, message: this.message };
    if (this.details) body.details = this.details;
    return body;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Wrap any thrown value as an AppError without losing the original. */
export function toAppError(error: unknown, fallback: ErrorCode = "internal"): AppError {
  if (isAppError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError(fallback, message, undefined, { cause: error });
}
