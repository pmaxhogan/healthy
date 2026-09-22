// Google OAuth 2.0 (authorization code, offline) for the owner's calendar.
//
// Pure module: no D1, no Env, no globals beyond the injected fetch. The caller
// passes the client credentials in and stores the tokens; this file only knows
// how to talk to Google's endpoints and how to name the failures.
//
// Three mechanics are load-bearing and easy to get wrong:
//
//   - `access_type=offline` is what makes Google issue a refresh token at all.
//   - `prompt=consent` is what makes it issue one *again* on a re-authorisation.
//     Without it only the very first consent returns `refresh_token`, so losing
//     the stored token would leave no way back in short of the owner manually
//     revoking the grant from their Google account page.
//   - `include_granted_scopes=true` makes the new grant a superset of any scopes
//     already granted, instead of silently narrowing them.
//
// The default scope set is calendar-only and deliberately excludes
// `openid email`: this app never needs the owner's address. The admin UI shows
// *which* Google account is connected using `primaryCalendarSummary()` instead,
// which the calendar scopes already cover. `userinfo()` exists for deployments
// that do grant the identity scopes, and `scopes` is configurable so they can.

import { AppError } from "../lib/errors.ts";
import { noopLogger } from "../lib/log.ts";
import { parseRetryAfter } from "../lib/retry.ts";

import type { GoogleRefreshedTokens, GoogleTokens } from "./types.ts";
import type { ErrorCode } from "../lib/errors.ts";
import type { Logger } from "../lib/log.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const PRIMARY_CALENDAR_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary";

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/**
 * The only two scopes the sync needs.
 *
 * `calendar.events.owned` writes events this app created and nothing else -- it
 * cannot read or modify events created by the owner or by another app, which is
 * a far better fit for the "touch only our own events" invariant than the broad
 * `calendar` scope. `calendar.calendarlist.readonly` is needed to offer the
 * calendar picker and to resolve `primary`.
 */
export const GOOGLE_CALENDAR_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

/** Opt-in identity scopes. Required by `userinfo()`, not requested by default. */
export const GOOGLE_USERINFO_SCOPES: readonly string[] = ["openid", "email"];

export interface GoogleOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Scopes requested by `buildAuthUrl` when the call does not name its own. */
  scopes?: readonly string[];
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Injected clock (unix ms) so `expiresAt` is deterministic in tests. */
  now?: () => number;
}

export interface GoogleOAuth {
  /** The URL to redirect the owner to. `state` is the caller's CSRF nonce. */
  buildAuthUrl(opts: { state: string; scopes?: readonly string[] }): string;
  exchangeCode(code: string): Promise<GoogleTokens>;
  refresh(refreshToken: string): Promise<GoogleRefreshedTokens>;
  /** Best effort: never throws, resolves true when Google accepted it. */
  revoke(token: string): Promise<boolean>;
  /** Requires the `openid email` scopes; see the module comment. */
  userinfo(accessToken: string): Promise<{ email: string }>;
  /** Names the connected account for display without an identity scope. */
  primaryCalendarSummary(accessToken: string): Promise<{ id: string; summary: string } | null>;
}

/** The subset of Google's token response this module reads. */
interface TokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

interface OAuthErrorBody {
  error?: unknown;
  error_description?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Google's OAuth errors are `{ error, error_description }`; anything else is opaque. */
function parseOAuthError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as OAuthErrorBody;
    return asString(parsed.error);
  } catch {
    return null;
  }
}

/**
 * Map a failed token-endpoint response onto the app's error taxonomy.
 *
 * `invalid_grant` on a 400 means "the grant you presented is no good", and what
 * that implies depends entirely on which grant it was -- which is why the caller
 * names the code rather than this function guessing:
 *
 *   - on a **refresh**, the refresh token has been revoked or has expired. That
 *     is `needs_reauth`: the caller marks the connection and opens a reconnect
 *     alert instead of retrying forever.
 *   - on a **code exchange**, the authorization code expired or was already
 *     redeemed. That is `bad_request` on a connection that may never have had a
 *     token at all, and mapping it to `needs_reauth` would make a first-time
 *     connect attempt open a spurious reconnect alert.
 */
function tokenFailure(
  response: Response,
  body: string,
  operation: string,
  invalidGrantCode: ErrorCode,
): AppError {
  const reason = parseOAuthError(body);
  const status = response.status;
  if (status === 400 && reason === "invalid_grant") {
    const detail =
      invalidGrantCode === "needs_reauth"
        ? "refresh token rejected (invalid_grant)"
        : "authorization code expired or already redeemed (invalid_grant) -- restart the connect flow";
    return new AppError(invalidGrantCode, `google ${operation}: ${detail}`, { status });
  }
  if (status === 429 || status >= 500) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after")) ?? undefined;
    return new AppError(
      "upstream_unavailable",
      `google ${operation}: HTTP ${String(status)}`,
      { status },
      retryAfterMs === undefined ? undefined : { retryAfterMs },
    );
  }
  return new AppError("upstream_error", `google ${operation}: HTTP ${String(status)}`, {
    status,
    ...(reason !== null && { reason }),
  });
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** Shared tail of both grant types: read, check the status, parse. */
async function readTokenBody(
  response: Response,
  operation: string,
  invalidGrantCode: ErrorCode,
): Promise<TokenResponseBody> {
  const body = await readBody(response);
  if (!response.ok) throw tokenFailure(response, body, operation, invalidGrantCode);
  try {
    return JSON.parse(body) as TokenResponseBody;
  } catch {
    throw new AppError("upstream_error", `google ${operation}: response was not JSON`);
  }
}

/** Read `email` out of a userinfo body without letting a bad body throw. */
function emailFrom(body: string): string | null {
  try {
    return asString((JSON.parse(body) as { email?: unknown }).email);
  } catch {
    return null;
  }
}

export function createGoogleOAuth(options: GoogleOAuthOptions): GoogleOAuth {
  const { clientId, clientSecret, redirectUri } = options;
  const defaultScopes = options.scopes ?? GOOGLE_CALENDAR_SCOPES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.logger ?? noopLogger;
  const now = options.now ?? Date.now;

  const postForm = async (url: string, form: URLSearchParams): Promise<Response> =>
    fetchImpl(url, {
      method: "POST",
      headers: { "content-type": FORM_CONTENT_TYPE },
      body: form.toString(),
    });

  const expiresAtFrom = (expiresIn: unknown): number => {
    // Google always sends expires_in, but a missing or absurd value must not
    // become an access token that looks valid forever.
    const seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 0;
    return now() + seconds * 1000;
  };

  const authorizedGet = async (
    url: string,
    accessToken: string,
    operation: string,
  ): Promise<Response> => {
    try {
      return await fetchImpl(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      });
    } catch (error) {
      throw new AppError("upstream_unavailable", `google ${operation}: request failed`, undefined, {
        cause: error,
      });
    }
  };

  return {
    buildAuthUrl({ state, scopes }) {
      if (state.length === 0)
        throw new AppError("bad_request", "google authorize: state is required");
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: (scopes ?? defaultScopes).join(" "),
        // See the module comment: all three of these are required for a
        // refresh token to be issued on every consent, not just the first.
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
      });
      return `${AUTH_URL}?${params.toString()}`;
    },

    async exchangeCode(code) {
      const response = await postForm(
        TOKEN_URL,
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code,
        }),
      );
      const data = await readTokenBody(response, "code exchange", "bad_request");
      const accessToken = asString(data.access_token);
      if (accessToken === null) {
        throw new AppError("upstream_error", "google code exchange: no access_token in response");
      }
      const refreshToken = asString(data.refresh_token);
      if (refreshToken === null) {
        // Not an upstream fault: it means the authorization URL was built
        // without access_type=offline + prompt=consent, or the code was
        // already redeemed. Without a refresh token the connection would work
        // for an hour and then be unrecoverable, so refuse it outright.
        throw new AppError(
          "bad_request",
          "google code exchange: no refresh_token in response -- the authorization URL must set access_type=offline and prompt=consent",
        );
      }
      log.info("google.oauth.exchange_ok", {
        scopeCount: (asString(data.scope) ?? "").split(" ").length,
      });
      return {
        accessToken,
        expiresAt: expiresAtFrom(data.expires_in),
        refreshToken,
        scope: asString(data.scope) ?? "",
      };
    },

    async refresh(refreshToken) {
      const response = await postForm(
        TOKEN_URL,
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      );
      const data = await readTokenBody(response, "refresh", "needs_reauth");
      const accessToken = asString(data.access_token);
      if (accessToken === null) {
        throw new AppError("upstream_error", "google refresh: no access_token in response");
      }
      log.debug("google.oauth.refresh_ok");
      return {
        accessToken,
        expiresAt: expiresAtFrom(data.expires_in),
        // A refresh response omits `scope` when nothing changed.
        scope: asString(data.scope) ?? "",
      };
    },

    async revoke(token) {
      // Best effort by design: this runs while disconnecting, and a failure
      // here must not stop the local tokens from being deleted.
      try {
        const response = await postForm(REVOKE_URL, new URLSearchParams({ token }));
        if (!response.ok) log.warn("google.oauth.revoke_failed", { status: response.status });
        return response.ok;
      } catch {
        log.warn("google.oauth.revoke_failed", { status: 0 });
        return false;
      }
    },

    async userinfo(accessToken) {
      const response = await authorizedGet(USERINFO_URL, accessToken, "userinfo");
      const body = await readBody(response);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new AppError(
            "upstream_auth",
            "google userinfo: rejected -- is the `openid email` scope granted?",
            {
              status: response.status,
            },
          );
        }
        throw tokenFailure(response, body, "userinfo", "bad_request");
      }
      const email = emailFrom(body);
      if (email === null)
        throw new AppError("upstream_error", "google userinfo: no email in response");
      // Deliberately not logged: the logger redacts addresses anyway, but the
      // owner's identity has no business in a log line at all.
      return { email };
    },

    async primaryCalendarSummary(accessToken) {
      const response = await authorizedGet(PRIMARY_CALENDAR_URL, accessToken, "primary calendar");
      const body = await readBody(response);
      if (!response.ok) {
        // Display-only: a failure here must not fail a connection that is
        // otherwise fine, so the caller gets null rather than an error.
        log.warn("google.oauth.primary_calendar_failed", { status: response.status });
        return null;
      }
      try {
        const parsed = JSON.parse(body) as { id?: unknown; summary?: unknown };
        const id = asString(parsed.id);
        return id === null ? null : { id, summary: asString(parsed.summary) ?? id };
      } catch {
        return null;
      }
    },
  };
}
