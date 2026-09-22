/**
 * Structured JSON-lines logger with redaction.
 *
 * One JSON object per line so `wrangler tail --format json` output greps cleanly.
 *
 * Redaction is defensive and applied to every field on every line:
 *   - keys that look like credentials (token, secret, password, authorization, cookie,
 *     refresh, verifier, api key, private) are replaced with "[redacted]"
 *   - the keys `code` and `state` are redacted on an *exact* match only. They name the
 *     OAuth authorization code and CSRF state, which must never be logged -- but
 *     `errorCode`, `error_code` and `statusCode` are the stable codes this project logs
 *     deliberately, and a substring match would eat them. The corollary: a field whose
 *     value is a row state (`active`/`ghost`) has to be called something else --
 *     `eventState`, not `state`.
 *   - string values containing "Bearer <x>" or "Basic <x>" lose the credential
 *   - any whitespace-delimited token containing an "@" becomes "[email]"
 *   - long opaque strings (>= 40 chars of base64url/hex, the shape of tokens and ids)
 *     become "[opaque:<len>]"
 *   - nesting deeper than MAX_DEPTH becomes "[deep]", which both caps the cost of a
 *     mistakenly-logged resource and makes a self-referential object safe to pass
 *
 * Callers must still never pass clinical content (resource bodies, names, notes) to the
 * logger. Log counts, ids of our own rows, durations and error codes only.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** Time an async operation; logs `<event>.ok` or `<event>.fail` with `ms`. */
  time<T>(
    event: string,
    fn: () => Promise<T>,
    onSuccess?: (value: T) => Record<string, unknown>,
  ): Promise<T>;
  child(extra: Record<string, unknown>): Logger;
}

const SENSITIVE_KEY =
  /token|secret|password|passwd|authorization|cookie|refresh|verifier|api[_-]?key|private/i;
// Exact matches, compared after stripping separators and case: see the header.
const SENSITIVE_EXACT = new Set(["code", "state", "authcode", "codeverifier", "nonce"]);
const WHITESPACE_RUN = /(\s+)/;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const OPAQUE = /^[A-Za-z0-9_=-]{40,}$/;

function isSensitiveKey(key: string): boolean {
  return (
    SENSITIVE_KEY.test(key) || SENSITIVE_EXACT.has(key.toLowerCase().replaceAll(/[^a-z0-9]/g, ""))
  );
}

/**
 * How far into a nested field the walk goes before it gives up.
 *
 * A log line is a shallow bag of scalars by design, so anything deeper than this
 * is a mistake -- most likely a whole resource being handed to the logger. The
 * cap is also what makes a self-referential object safe to pass: without it the
 * walk would recurse until the stack ran out, before `safeStringify` ever saw it.
 */
const MAX_DEPTH = 6;

export function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (isSensitiveKey(key)) return "[redacted]";
  if (typeof value === "string") return redactString(value);
  if (depth >= MAX_DEPTH) return "[deep]";
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item, depth + 1));
  return value && typeof value === "object" && !(value instanceof Date)
    ? redactFields(value as Record<string, unknown>, depth + 1)
    : value;
}

/**
 * Replace every whitespace-delimited token containing an `@` with "[email]".
 *
 * Token splitting rather than an address-shaped regex on purpose. Any pattern of
 * the form `<chars>@<chars>` backtracks across the whole remaining string for
 * every candidate start that has no `@` after it, which is quadratic on a long
 * line; splitting on runs of whitespace is linear. It also over-matches, which
 * is the right direction: a token that merely looks like an address is redacted.
 */
function redactEmails(value: string): string {
  return value.includes("@")
    ? value
        .split(WHITESPACE_RUN)
        .map((token) => (token.includes("@") ? "[email]" : token))
        .join("")
    : value;
}

export function redactString(value: string): string {
  return OPAQUE.test(value)
    ? `[opaque:${String(value.length)}]`
    : redactEmails(value.replaceAll(BEARER, "$1 [redacted]"));
}

export function redactFields(fields: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = redactValue(key, value, depth);
  return out;
}

export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const fields: Record<string, unknown> = {
      errorName: error.name,
      errorMessage: redactString(error.message),
    };
    const { status, code } = error as { status?: unknown; code?: unknown };
    if (typeof status === "number") fields.status = status;
    if (typeof code === "string") fields.errorCode = code;
    return fields;
  }
  return { error: redactString(String(error)) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ level: "error", event: "log.serialization_failed" });
  }
}

export interface LoggerOptions {
  /** Minimum level to emit. Default "info". */
  minLevel?: LogLevel;
  /** Injected sink (tests). Default: console. */
  sink?: (level: LogLevel, line: string) => void;
  /** Injected clock (tests). */
  now?: () => Date;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function defaultSink(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function makeLogger(
  base: Record<string, unknown> = {},
  options: LoggerOptions = {},
): Logger {
  const minLevel = LEVEL_ORDER[options.minLevel ?? "info"];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? ((): Date => new Date());
  const safeBase = redactFields(base);

  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < minLevel) return;
    const line = {
      level,
      event,
      t: now().toISOString(),
      ...safeBase,
      ...(fields && redactFields(fields)),
    };
    sink(level, safeStringify(line));
  };

  const logger: Logger = {
    debug: (event, fields) => {
      emit("debug", event, fields);
    },
    info: (event, fields) => {
      emit("info", event, fields);
    },
    warn: (event, fields) => {
      emit("warn", event, fields);
    },
    error: (event, fields) => {
      emit("error", event, fields);
    },
    async time(event, fn, onSuccess) {
      const start = Date.now();
      try {
        const value = await fn();
        emit("info", `${event}.ok`, { ms: Date.now() - start, ...onSuccess?.(value) });
        return value;
      } catch (error) {
        emit("error", `${event}.fail`, { ms: Date.now() - start, ...errorFields(error) });
        throw error;
      }
    },
    child: (extra) => makeLogger({ ...base, ...extra }, options),
  };
  return logger;
}

function discard(): void {
  // Intentionally empty: the noop logger's whole job is to drop the line.
}

/** A logger that drops everything; handy default for library code. */
export const noopLogger: Logger = makeLogger({}, { sink: discard });
