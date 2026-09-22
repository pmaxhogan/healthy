/**
 * Retry-with-jitter wrapper around fetch.
 *
 * Classification:
 *   - transient: network failures, 408/425/429, 5xx  -> retried with backoff
 *   - auth: 401/403                                   -> returned to the caller as a Response
 *                                                        (callers refresh tokens and retry once)
 *   - permanent: every other 4xx                      -> thrown immediately, never retried
 *
 * Backoff is exponential (base 200 ms, cap 5 s) with +/-25% jitter. A 429 or 503 with a
 * Retry-After header raises the delay to at least that value. A wall-clock budget
 * (default 30 s) stops the loop early instead of sleeping past it.
 *
 * Every time source is injectable so the unit tests are deterministic.
 */

export interface RetryOpts {
  /** Maximum number of attempts including the first. Default 4. */
  maxAttempts?: number;
  /** Delay before the second attempt in ms. Default 200. */
  baseDelayMs?: number;
  /** Cap on a single delay in ms. Default 5000. */
  maxDelayMs?: number;
  /** Total wall-clock budget across all attempts in ms. Default 30_000. */
  maxTotalMs?: number;
  /** Per-attempt timeout in ms. Default 20_000. */
  perAttemptTimeoutMs?: number;
  /** Injected randomness for jitter. */
  random?: () => number;
  /** Injected clock. */
  now?: () => number;
  /** Injected sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected fetch (tests and mock upstreams). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface RetryOutcome<T> {
  value: T;
  /** Retries that happened (attempts - 1). */
  retries: number;
  totalMs: number;
}

/** A transient failure that exhausted its retries. */
export class TransientError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastStatus?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TransientError";
  }
}

/** A failure that must not be retried. */
export class PermanentError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PermanentError";
  }
}

export type ErrorClass = "transient" | "permanent" | "auth";

const AUTH_STATUSES = new Set([401, 403]);
// 408 request timeout, 425 too early, 429 too many requests.
const TRANSIENT_STATUSES = new Set([408, 425, 429]);

export function classifyStatus(status: number): ErrorClass {
  if (AUTH_STATUSES.has(status)) return "auth";
  if (TRANSIENT_STATUSES.has(status)) return "transient";
  return status >= 500 && status < 600 ? "transient" : "permanent";
}

const TRANSIENT_MESSAGE =
  /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|aborted|AbortError|timeout/i;

export function classifyThrown(error: unknown): ErrorClass {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_MESSAGE.test(message) ? "transient" : "permanent";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delay before retry number `retry` (0 = before the second attempt). */
export function computeDelayMs(
  retry: number,
  opts: Required<Pick<RetryOpts, "baseDelayMs" | "maxDelayMs" | "random">>,
  retryAfterMs?: number,
): number {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** retry);
  const jittered = Math.min(opts.maxDelayMs, Math.round(exp * (0.75 + opts.random() * 0.5)));
  return retryAfterMs !== undefined && retryAfterMs > jittered
    ? Math.min(opts.maxDelayMs, retryAfterMs)
    : jittered;
}

/** Parse a Retry-After header (seconds or HTTP-date) into ms, or null. */
export function parseRetryAfter(
  header: string | null,
  now: () => number = Date.now,
): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now());
}

async function fetchOnce(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("per-attempt timeout"));
  }, timeoutMs);
  try {
    const callerSignal = init.signal;
    if (callerSignal) {
      const onAbort = (): void => {
        controller.abort(callerSignal.reason);
      };
      if (callerSignal.aborted) onAbort();
      else callerSignal.addEventListener("abort", onAbort, { once: true });
    }
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Every option resolved to a value, so the attempt helpers take one argument. */
type Settings = Required<RetryOpts>;

function resolveOpts(opts: RetryOpts): Settings {
  return {
    maxAttempts: opts.maxAttempts ?? 4,
    baseDelayMs: opts.baseDelayMs ?? 200,
    maxDelayMs: opts.maxDelayMs ?? 5000,
    maxTotalMs: opts.maxTotalMs ?? 30_000,
    perAttemptTimeoutMs: opts.perAttemptTimeoutMs ?? 20_000,
    random: opts.random ?? Math.random,
    now: opts.now ?? Date.now,
    sleep: opts.sleep ?? defaultSleep,
    fetchImpl: opts.fetchImpl ?? fetch,
  };
}

/** What the most recent failure knew, carried into the TransientError. */
interface LastFailure {
  status?: number | undefined;
  retryAfterMs?: number | undefined;
}

/** The outcome of one attempt. A thrown error means "stop now". */
type Attempt =
  { kind: "done"; response: Response } | ({ kind: "retry"; reason: string } & LastFailure);

async function discardBody(response: Response): Promise<void> {
  try {
    // Drain the body so the connection can be reused.
    await response.body?.cancel();
  } catch {
    // The response is being thrown away; failing to cancel it changes nothing.
  }
}

async function runAttempt(cfg: Settings, input: string, init: RequestInit): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetchOnce(cfg.fetchImpl, input, init, cfg.perAttemptTimeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (classifyThrown(error) === "permanent") throw new PermanentError(message);
    return { kind: "retry", reason: message };
  }

  const cls = classifyStatus(response.status);
  if (cls === "auth" || response.ok) return { kind: "done", response };
  if (cls === "permanent") {
    throw new PermanentError(
      `HTTP ${String(response.status)} ${response.statusText}`,
      response.status,
    );
  }
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), cfg.now) ?? undefined;
  await discardBody(response);
  return {
    kind: "retry",
    reason: `HTTP ${String(response.status)}`,
    status: response.status,
    retryAfterMs,
  };
}

/** Sleep before retry `attempt`, or give up if the wall-clock budget cannot cover it. */
async function waitBeforeRetry(
  cfg: Settings,
  attempt: number,
  start: number,
  last: LastFailure,
): Promise<void> {
  const delay = computeDelayMs(attempt - 1, cfg, last.retryAfterMs);
  if (delay > cfg.maxTotalMs - (cfg.now() - start)) {
    throw new TransientError(
      `wall-clock budget exhausted (${String(cfg.maxTotalMs)} ms) before attempt ${String(attempt + 1)}`,
      attempt,
      last.status,
      last.retryAfterMs,
    );
  }
  await cfg.sleep(delay);
}

/**
 * Fetch with retries on transient failures.
 *
 * Resolves with the Response for 2xx/3xx and for 401/403 (auth is the caller's problem).
 * Throws PermanentError for other 4xx immediately, TransientError once retries or the
 * wall-clock budget are exhausted. The last Retry-After seen is attached to the
 * TransientError so callers can back off a whole sync run, not just one call.
 */
export async function retriedFetch(
  input: string,
  init: RequestInit = {},
  opts: RetryOpts = {},
): Promise<RetryOutcome<Response>> {
  const cfg = resolveOpts(opts);
  const start = cfg.now();
  const last: LastFailure = {};
  let reason = "retry loop fell through";

  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    if (attempt > 0) await waitBeforeRetry(cfg, attempt, start, last);

    const outcome = await runAttempt(cfg, input, init);
    if (outcome.kind === "done") {
      return { value: outcome.response, retries: attempt, totalMs: cfg.now() - start };
    }
    reason = outcome.reason;
    last.status = outcome.status;
    // A Retry-After seen on any attempt outlives the attempt that produced it.
    last.retryAfterMs = outcome.retryAfterMs ?? last.retryAfterMs;
  }

  throw new TransientError(
    `${reason} after ${String(cfg.maxAttempts)} attempts`,
    cfg.maxAttempts,
    last.status,
    last.retryAfterMs,
  );
}
