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
 *   - keys naming a patient or FHIR identifier (`/(patient|fhir)…id/`) are replaced
 *     with "[redacted]". A 24-character Epic patient id is well under the opaque
 *     threshold, so shape alone would never catch it. The rule over-matches
 *     (`fhirCacheRowId` goes too) and that is the direction to err in.
 *   - keys naming a host, a domain or an origin are replaced too. A sending domain
 *     or a portal hostname names a health system, which is the category this
 *     project is strictest about, and it is far under the opaque threshold, so
 *     nothing else would catch it. `domain`, `hostname` and `origin` match as
 *     substrings; `host` matches only as an exact key, because "ghosted" contains
 *     it and the sync's ghost counters are legitimate fields.
 *   - string values containing "Bearer <x>" or "Basic <x>" lose the credential
 *   - the value of a credential-bearing query parameter (`?code=`, `&access_token=`,
 *     `token=`, `state=`…) is replaced, wherever it appears inside a longer string
 *   - any whitespace-delimited token containing an "@" becomes "[email]"
 *   - a long opaque string becomes "[opaque:<len>]", both as a whole value and
 *     embedded in a longer one: >= 32 characters of base64url (the shape of a
 *     token, a hex digest or an org identifier), or a dotted run of them, which is
 *     what a JWT (`a.b.c`, Epic's access and id tokens) and a `ya29.`-prefixed
 *     Google token look like. `/` and `:` terminate a run, so a request path and a
 *     URL survive intact while the credential inside one does not.
 *   - nesting deeper than MAX_DEPTH becomes "[deep]", which both caps the cost of a
 *     mistakenly-logged resource and makes a self-referential object safe to pass
 *
 * What this is NOT is an allowlist: an unrecognised key with an innocuous-looking
 * value is passed through. The guarantee is two-part -- these rules, plus the
 * caller convention that only counts, ids of our own rows, durations, statuses and
 * stable error codes are ever passed. Clinical content, names, addresses and
 * organisation identities have no rule that would catch them, so they must not be
 * handed to the logger in the first place. `test/unit/lib/log.test.ts` pins the
 * rules; SECURITY.md describes the convention.
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
  /token|secret|password|passwd|authorization|cookie|refresh|verifier|api[_-]?key|private|email|domain|hostname|origin/i;
/**
 * Keys naming a patient or FHIR identifier.
 *
 * Epic's patient and resource ids are 24 characters, which no shape rule would
 * flag, and they are the join key back to a person. Any key whose name contains
 * "patient" or "fhir" followed by "id" is therefore dropped -- `patientId`,
 * `patient_fhir_id`, `fhirResourceId`. It over-matches by design.
 */
const IDENTIFIER_KEY = /(patient|fhir)[a-z0-9_-]*id/i;
// Exact matches, compared after stripping separators and case: see the header.
//
// `host` is here rather than in `SENSITIVE_KEY` on purpose: "ghosted" contains
// "host", and `eventsGhosted` / `ghost_color_id` are fields this project logs
// deliberately. An exact match catches the one shape that matters -- a caller
// passing `{ host }` -- while `hostname` and `domain` are unambiguous enough to
// match anywhere.
const SENSITIVE_EXACT = new Set(["code", "state", "authcode", "codeverifier", "nonce", "host"]);
const WHITESPACE_RUN = /(\s+)/;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
/**
 * A whole value that is nothing but token characters.
 *
 * `.` is in the class so a JWT (`header.payload.signature`) and a `ya29.`-style
 * Google token match as a whole. `:` and `/` are not, so a URL -- which always has
 * "://" -- can never match this; the run rule below is what handles a URL.
 */
const OPAQUE = /^[A-Za-z0-9._=-]{32,}$/;
/**
 * The value of a credential-bearing query parameter, anywhere in a string.
 *
 * `\b` before the name is what keeps `errorCode=` and `error_code=` out of it: in
 * both, the character before "code" is a word character, so there is no boundary.
 */
const CREDENTIAL_PARAM =
  /\b(access_token|refresh_token|id_token|token|code|code_verifier|client_secret|client_assertion|assertion|state|password)=[^&\s"'#]+/gi;
/**
 * Every maximal run of token characters in a string, long or short.
 *
 * One flat character class with no alternation and no nested quantifier, because
 * the shape this replaces -- `run(?:\.run)+|run` -- backtracks super-linearly on a
 * long line of dotted text, and a redactor is on the path of every log call. The
 * length test that decides whether a run is a credential lives in the replacer
 * instead, where it costs one comparison.
 *
 * `.` is in the class, so a JWT (`a.b.c`) and a `ya29.`-prefixed Google token are
 * each one run and collapse whole. `/`, `:` and `?` are not, so a URL breaks into
 * its host and path segments: each is short and survives, which is what keeps a
 * 500 debuggable. A host long enough to pass the threshold on its own does get
 * collapsed -- an over-match in the safe direction, since a long host here names
 * a health system.
 */
const TOKEN_RUN = /[A-Za-z0-9._=-]+/g;
/** Characters of base64url at which a run stops being plausibly readable text. */
const OPAQUE_MIN = 32;

function isSensitiveKey(key: string): boolean {
  return (
    SENSITIVE_KEY.test(key) ||
    IDENTIFIER_KEY.test(key) ||
    SENSITIVE_EXACT.has(key.toLowerCase().replaceAll(/[^a-z0-9]/g, ""))
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
  // A value that is nothing but a token reports its length and stops there: the
  // run pass below would say the same thing more slowly.
  if (OPAQUE.test(value)) return `[opaque:${String(value.length)}]`;
  const withoutCredentials = value
    .replaceAll(BEARER, "$1 [redacted]")
    // Inline arrows rather than named helpers, here and below:
    // `unicorn/no-unsafe-string-replacement` accepts a string literal or a
    // function *expression*, and reads an identifier naming one as dynamic.
    .replaceAll(CREDENTIAL_PARAM, (_match, name: string) => `${name}=[redacted]`);
  // Addresses before runs, so a long local part reads as "[email]" rather than as
  // an opaque token followed by a domain.
  return redactEmails(withoutCredentials).replaceAll(TOKEN_RUN, (run) =>
    run.length >= OPAQUE_MIN ? `[opaque:${String(run.length)}]` : run,
  );
}

export function redactFields(fields: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // security/detect-object-injection warns on `out[key]`: false positive. The keys
  // come from `Object.entries` of the same object, and `out` is a fresh literal.
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

/**
 * Emit one redacted JSON line without a `Logger`.
 *
 * For the error handlers that run where no request-scoped logger is reachable --
 * `app.onError`, the `/api` handler, the OAuth handler. Before this existed they
 * each called `console.error("event", { … })` directly, which produced neither the
 * one-JSON-object-per-line shape nor any redaction: a non-`AppError` message can
 * quote an upstream body, a URL or a time-zone name.
 */
export function logLine(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  defaultSink(
    level,
    safeStringify({
      level,
      event,
      t: new Date().toISOString(),
      ...redactFields(fields),
    }),
  );
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
    // `LEVEL_ORDER[level]`: a closed union index into a const map, not a sink.
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
