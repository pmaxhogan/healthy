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
  | "internal";

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
