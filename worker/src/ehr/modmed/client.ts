/**
 * The authenticated ModMed client: sign in, keep the token fresh, read the visits.
 *
 * ### Sign-in
 *
 * Keycloak's authorization-code flow, driven by plain HTTP the way the portal's
 * own app drives it in a browser:
 *
 *  1. Re-read the practice's `auth/data/patient` and refuse unless it still
 *     names the identity provider the owner confirmed (`discovery.ts`).
 *  2. GET the authorize URL. A live Keycloak SSO cookie in the jar answers with
 *     the code straight away; otherwise it renders the login page.
 *  3. The default page asks for name and date of birth; one POST of its
 *     "Login with Username" button swaps it for the username/password form.
 *  4. POST the username and password. Success is a redirect off the identity
 *     provider to the portal, with `#code=...` in the fragment. That redirect is
 *     read, never followed.
 *  5. Exchange the code at the token endpoint (public client, PKCE S256).
 *
 * Anything else the credential POST lands on is classified, never guessed at:
 * a one-time-code field is `portal_code_challenge` (this client does not answer
 * one -- the owner's login does not ask for it, so seeing one means the owner
 * has to look), a lockout is `portal_locked`, the form again is
 * `portal_login_failed`.
 *
 * ### The session
 *
 * The API is stateless: every call carries `Authorization: Bearer`. The token
 * pair and both expiries live in the jar's extras, which the caller seals into
 * D1 with the cookies. `ensureAccessToken` refreshes ahead of expiry; a refresh
 * the identity provider refuses is `portal_session_expired`, which the sync
 * answers by signing in again (no code is involved, so that is cheap).
 *
 * Nothing from the portal is logged: no URL, host, token, body or name.
 */

import { AppError } from "../../lib/errors.ts";
import { dateInZone, startOfDayInZone, toIso } from "../../lib/time.ts";
import { createPkce, randomState } from "../pkce.ts";

import { fetchAuthData } from "./discovery.ts";
import { apiGet, apiGetFile, signInRequest, tokenRequest } from "./http.ts";
import { messagesOf } from "./messages.ts";
import { parseAppointments, parsePastVisits } from "./visits.ts";
import {
  INBOX_PATH,
  INBOX_SELECTOR,
  KEYCLOAK_MARKERS,
  LOGIN,
  PAGE_SIZE,
  PAGING,
  PAST_PATH,
  PAST_SELECTOR,
  REDIRECT_QUERY,
  SENT_PATH,
  SENT_SELECTOR,
  TOKEN_EXTRAS,
  TOKEN_REFRESH_MARGIN_SECONDS,
  attachmentPath,
  UPCOMING_PATH,
  UPCOMING_SELECTOR,
} from "./wire.ts";

import type { ModMedEndpoint } from "./discovery.ts";
import type { Logger } from "../../lib/log.ts";
import type { PortalClient, PortalCredentials } from "../mychart/client.ts";
import type { CookieJar } from "../mychart/cookie-jar.ts";
import type { PortalVisit } from "../mychart/visits.ts";
import type { PortalSignInStatus } from "@shared/types.ts";

export interface ModMedClientDeps {
  endpoint: ModMedEndpoint;
  jar: CookieJar;
  fetchImpl: typeof fetch;
  logger: Logger;
  /** Unix seconds. */
  now: () => number;
}

/** The app's redirect URI: the app page plus its `initialLogin` marker. */
function redirectUriOf(endpoint: ModMedEndpoint): string {
  return `${endpoint.baseUrl}${endpoint.mountPath}?${REDIRECT_QUERY}`;
}

function oidcBase(endpoint: Pick<ModMedEndpoint, "authServerUrl" | "realm">): string {
  return `${endpoint.authServerUrl}/realms/${encodeURIComponent(endpoint.realm)}/protocol/openid-connect`;
}

/** The first `<form>`'s action, entity-decoded, or null. */
function formAction(html: string): string | null {
  const match = /<form\b[^>]*\baction="([^"]+)"/iu.exec(html);
  return match?.[1] === undefined ? null : match[1].replaceAll("&amp;", "&");
}

/** The value of a named input on the page, or null. */
function inputValue(html: string, name: string): string | null {
  for (const tag of html.matchAll(/<input\b[^>]*>/giu)) {
    const text = tag[0];
    const named = new RegExp(String.raw`\bname="${name}"`, "u").test(text);
    if (!named) continue;
    return /\bvalue="([^"]*)"/u.exec(text)?.[1] ?? "";
  }
  return null;
}

function hasInput(html: string, name: string): boolean {
  return inputValue(html, name) !== null;
}

function matchesAny(html: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(html));
}

/** The `code` and `state` out of Keycloak's hand-back URL (fragment or query). */
function codeFromRedirect(target: string): { code: string; state: string | null } | null {
  const url = new URL(target);
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const fromQuery = url.searchParams;
  const code = params.get("code") ?? fromQuery.get("code");
  return code === null || code === ""
    ? null
    : { code, state: params.get("state") ?? fromQuery.get("state") };
}

/** Where the redirect landed is the portal, and it carries an error instead of a code. */
function redirectError(target: string): string | null {
  const url = new URL(target);
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  return params.get("error") ?? url.searchParams.get("error");
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** A non-negative integer response header, or null when absent or not one. */
function headerCount(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Classify a Keycloak page the credential POST stopped on. Always throws. */
function failFromLoginPage(html: string): never {
  if (matchesAny(html, KEYCLOAK_MARKERS.codeChallenge)) {
    throw new AppError("portal_code_challenge", "the portal asked for a one-time code", {
      endpoint: "credentials",
    });
  }
  if (matchesAny(html, KEYCLOAK_MARKERS.locked)) {
    throw new AppError("portal_locked", "the portal account is locked or disabled", {
      endpoint: "credentials",
    });
  }
  if (hasInput(html, LOGIN.passwordField) || matchesAny(html, KEYCLOAK_MARKERS.badCredentials)) {
    throw new AppError("portal_login_failed", "the portal rejected the username or password", {
      endpoint: "credentials",
    });
  }
  throw new AppError("portal_parse_failed", "the sign-in stopped on an unrecognised page", {
    endpoint: "credentials",
  });
}

export function createModMedClient(deps: ModMedClientDeps): PortalClient {
  const { endpoint, jar, logger } = deps;
  const http = { fetchImpl: deps.fetchImpl, jar };
  /** Every sign-in request, the password POST above all, must stay on this origin. */
  const idpOrigin = new URL(endpoint.authServerUrl).origin;

  function storeTokens(response: Record<string, unknown>): void {
    const access = stringField(response, "access_token");
    const expiresIn = numberField(response, "expires_in");
    if (access === null || expiresIn === null) {
      throw new AppError("portal_parse_failed", "the token response carried no access token", {
        endpoint: "token",
      });
    }
    const now = deps.now();
    jar.setExtra(TOKEN_EXTRAS.accessToken, access);
    jar.setExtra(TOKEN_EXTRAS.accessExpiresAt, String(now + expiresIn));
    const refresh = stringField(response, "refresh_token");
    const refreshIn = numberField(response, "refresh_expires_in");
    // Keycloak's `refresh_expires_in: 0` means "no idle limit of its own" (an
    // offline token); store no expiry then, and let the server say no.
    jar.setExtra(TOKEN_EXTRAS.refreshToken, refresh ?? "");
    jar.setExtra(
      TOKEN_EXTRAS.refreshExpiresAt,
      refresh !== null && refreshIn !== null && refreshIn > 0 ? String(now + refreshIn) : "",
    );
  }

  function clearTokens(): void {
    for (const key of Object.values(TOKEN_EXTRAS)) jar.setExtra(key, "");
  }

  function expiry(key: string): number | null {
    const raw = jar.getExtra(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  /** A usable access token, refreshing it when it is about to lapse. */
  async function ensureAccessToken(): Promise<string> {
    const access = jar.getExtra(TOKEN_EXTRAS.accessToken);
    const accessExpires = expiry(TOKEN_EXTRAS.accessExpiresAt);
    const now = deps.now();
    if (
      access !== null &&
      accessExpires !== null &&
      accessExpires - now > TOKEN_REFRESH_MARGIN_SECONDS
    ) {
      return access;
    }
    const refresh = jar.getExtra(TOKEN_EXTRAS.refreshToken);
    const refreshExpires = expiry(TOKEN_EXTRAS.refreshExpiresAt);
    if (refresh === null || (refreshExpires !== null && refreshExpires <= now)) {
      clearTokens();
      throw new AppError("portal_session_expired", "the portal session has lapsed", {
        endpoint: "token",
      });
    }
    try {
      const response = await tokenRequest(
        http,
        `${oidcBase(endpoint)}/token`,
        { grant_type: "refresh_token", client_id: endpoint.clientId, refresh_token: refresh },
        "token-refresh",
      );
      storeTokens(response);
    } catch (error) {
      // Only a grant the identity provider refused is gone for good. A network
      // blip or a 5xx keeps the pair, so the next try can still refresh it.
      if (error instanceof AppError && error.code === "portal_session_expired") clearTokens();
      throw error;
    }
    logger.info("portal.modmed.token_refreshed", {});
    const fresh = jar.getExtra(TOKEN_EXTRAS.accessToken);
    if (fresh === null) {
      throw new AppError("portal_parse_failed", "the refresh left no access token", {
        endpoint: "token-refresh",
      });
    }
    return fresh;
  }

  /**
   * Run an authenticated call, once more on a refreshed token if the first try
   * is refused. The API never answers a rejected token with a 401: one it cannot
   * parse is a 500 and one whose signature fails is a 403, both as an HTML error
   * page. A refresh the identity provider refuses becomes
   * `portal_session_expired` (sign in again); the same answer on a good token
   * keeps its own code.
   */
  async function withFreshToken<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    try {
      return await call(await ensureAccessToken());
    } catch (error) {
      const status = error instanceof AppError ? error.details?.status : undefined;
      if (status !== 500 && status !== 403) throw error;
      jar.setExtra(TOKEN_EXTRAS.accessExpiresAt, "0");
      return call(await ensureAccessToken());
    }
  }

  async function get(path: string, params: Record<string, string>, label: string) {
    const url = new URL(path, endpoint.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return withFreshToken((accessToken) =>
      apiGet(http, { url: url.href, accessToken, endpoint: label }),
    );
  }

  /** Every page of a list endpoint, to the end. No cap. */
  async function readAll(
    path: string,
    params: Record<string, string>,
    label: string,
  ): Promise<unknown[]> {
    const { rows } = await readPages(path, params, label);
    return rows;
  }

  /** `readAll`, plus how many pages it took. */
  async function readPages(
    path: string,
    params: Record<string, string>,
    label: string,
  ): Promise<{ rows: unknown[]; pages: number; short: boolean }> {
    const rows: unknown[] = [];
    let pages = 0;
    let total: number | null = null;
    for (let page = 1; ; page += 1) {
      pages += 1;
      const response = await get(
        path,
        {
          ...params,
          [PAGING.pageSizeParam]: String(PAGE_SIZE),
          [PAGING.pageNumberParam]: String(page),
        },
        label,
      );
      if (!Array.isArray(response.json)) {
        throw new AppError("portal_parse_failed", "the list was not an array", {
          endpoint: label,
        });
      }
      rows.push(...(response.json as unknown[]));
      // An empty page always ends the read, so a server that over-reports its
      // total cannot spin the loop.
      if (response.json.length === 0) break;
      total = headerCount(response.headers, PAGING.countHeader);
      if (total !== null) {
        // The total is the authority: a short page only means the server pages
        // smaller than asked, so keep going until the rows add up.
        if (rows.length >= total) break;
        continue;
      }
      // No total: a page shorter than the size the server says it used is the last.
      const size = headerCount(response.headers, PAGING.pageSizeHeader) ?? PAGE_SIZE;
      if (response.json.length < size) break;
    }
    const short = total !== null && rows.length < total;
    if (short) {
      logger.warn("portal.modmed.list_short", { endpoint: label, rows: rows.length, total });
    }
    logger.info("portal.modmed.list", { endpoint: label, rows: rows.length, pages });
    return { rows, pages, short };
  }

  /**
   * The `from` bound for the upcoming list: the start of today in `timeZone`.
   *
   * The app writes the local date with a `Z` (`2026-10-03T00:00:00.000Z`),
   * which is only the instant of local midnight in UTC itself. How the server
   * reads it is not known, so this sends whichever is *earlier* of that string
   * and the true instant of local midnight: east of UTC the true instant is the
   * earlier one, and the app's form would drop this morning's visits; west of
   * UTC the app's form is earlier and costs at most a few hours of yesterday,
   * which the calendar already holds. Never later than local midnight, so no
   * visit today is ever cut off.
   */
  function startOfToday(timeZone: string): string {
    const nowIso = toIso(deps.now());
    const appForm = `${dateInZone(nowIso, timeZone)}T00:00:00.000Z`;
    const trueMidnight = startOfDayInZone(nowIso, timeZone);
    return Date.parse(trueMidnight) < Date.parse(appForm)
      ? new Date(Date.parse(trueMidnight)).toISOString()
      : appForm;
  }

  /**
   * From the authorize URL to Keycloak's hand-back: the URL it redirected to.
   * Presses "Login with Username" when the default identity form comes up, then
   * posts the credentials. Throws a classified code for any page it stops on.
   */
  async function submitCredentials(
    authorizeUrl: string,
    credentials: PortalCredentials,
  ): Promise<string> {
    let landed = await signInRequest(http, {
      url: authorizeUrl,
      endpoint: "authorize",
      home: idpOrigin,
    });
    if (landed.leftTo !== null) return landed.leftTo;
    if (!hasInput(landed.body, LOGIN.passwordField)) {
      const action = formAction(landed.body);
      if (action === null) failFromLoginPage(landed.body);
      landed = await signInRequest(http, {
        url: new URL(action, landed.url).href,
        form: {
          [LOGIN.firmField]: inputValue(landed.body, LOGIN.firmField) ?? "",
          [LOGIN.switchToUsernameField]: LOGIN.switchToUsernameValue,
        },
        endpoint: "username-form",
        home: idpOrigin,
      });
      if (landed.leftTo !== null) return landed.leftTo;
    }
    const action = formAction(landed.body);
    if (action === null || !hasInput(landed.body, LOGIN.passwordField)) {
      failFromLoginPage(landed.body);
    }
    const posted = await signInRequest(http, {
      url: new URL(action, landed.url).href,
      form: {
        [LOGIN.firmField]: inputValue(landed.body, LOGIN.firmField) ?? "",
        [LOGIN.usernameField]: credentials.username,
        [LOGIN.passwordField]: credentials.password,
      },
      endpoint: "credentials",
      home: idpOrigin,
    });
    if (posted.leftTo === null) failFromLoginPage(posted.body);
    return posted.leftTo;
  }

  async function login(credentials: PortalCredentials): Promise<PortalSignInStatus> {
    const data = await fetchAuthData(endpoint.baseUrl, deps);
    if (
      data.authServerUrl !== endpoint.authServerUrl ||
      data.realm !== endpoint.realm ||
      data.clientId !== endpoint.clientId
    ) {
      throw new AppError(
        "portal_origin_unconfirmed",
        "the portal now signs in somewhere else; review it and save again",
      );
    }
    const pkce = await createPkce();
    const state = randomState();
    const authorize = new URL(`${oidcBase(endpoint)}/auth`);
    authorize.searchParams.set("client_id", endpoint.clientId);
    authorize.searchParams.set("redirect_uri", redirectUriOf(endpoint));
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("response_mode", "fragment");
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "openid");
    authorize.searchParams.set("nonce", randomState());
    authorize.searchParams.set("code_challenge", pkce.challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    if (data.loginHint !== null) {
      authorize.searchParams.set("login_hint", data.loginHint);
      authorize.searchParams.set("sso_hint", data.loginHint);
    }

    const leftTo = await submitCredentials(authorize.href, credentials);
    const target = new URL(leftTo);
    const expected = new URL(redirectUriOf(endpoint));
    if (target.origin !== expected.origin || target.pathname !== expected.pathname) {
      throw new AppError(
        "portal_redirected_offsite",
        "the sign-in redirected somewhere unexpected",
        {
          endpoint: "credentials",
        },
      );
    }
    if (redirectError(leftTo) !== null) {
      throw new AppError("portal_login_failed", "the identity provider refused the sign-in", {
        endpoint: "credentials",
      });
    }
    const handBack = codeFromRedirect(leftTo);
    if (handBack?.state !== state) {
      throw new AppError("portal_parse_failed", "the sign-in returned no usable code", {
        endpoint: "credentials",
      });
    }
    const tokens = await tokenRequest(
      http,
      `${oidcBase(endpoint)}/token`,
      {
        grant_type: "authorization_code",
        client_id: endpoint.clientId,
        code: handBack.code,
        redirect_uri: redirectUriOf(endpoint),
        code_verifier: pkce.verifier,
      },
      "token",
    );
    storeTokens(tokens);
    logger.info("portal.modmed.signed_in", {});
    return "signed_in";
  }

  return {
    login,
    secondaryValidation: {
      sendCode() {
        return Promise.reject(
          new AppError("portal_code_challenge", "this portal's one-time codes are not supported"),
        );
      },
      validate() {
        return Promise.reject(
          new AppError("portal_code_challenge", "this portal's one-time codes are not supported"),
        );
      },
    },
    async loadUpcoming(timeZone: string): Promise<PortalVisit[]> {
      const rows = await readAll(
        UPCOMING_PATH,
        { selector: UPCOMING_SELECTOR, where: "", from: startOfToday(timeZone) },
        "upcoming",
      );
      return parseAppointments(rows, timeZone, logger);
    },
    async loadPast(timeZone: string): Promise<PortalVisit[]> {
      const rows = await readAll(
        PAST_PATH,
        {
          selector: PAST_SELECTOR,
          where: "",
          "sorting.sortBy": "visitDate",
          "sorting.sortOrder": "desc",
        },
        "past",
      );
      return parsePastVisits(rows, timeZone, logger);
    },
    loadVisitDetails() {
      // The portal has no per-visit details page for an upcoming visit: what the
      // list carries is all there is. An empty answer, not an error, so the sync
      // keeps nothing it had and fetches nothing it cannot.
      return Promise.resolve({ waitlist: null });
    },
    async loadMessages() {
      // Both folders, every page. Read-only: see `messages.ts`.
      const inbox = await readPages(INBOX_PATH, { selector: INBOX_SELECTOR }, "inbox");
      const sent = await readPages(SENT_PATH, { selector: SENT_SELECTOR }, "sent");
      const parsed = messagesOf(inbox.rows, sent.rows);
      if (parsed.undated > 0) {
        logger.warn("portal.modmed.messages_undated", { undated: parsed.undated });
      }
      return {
        threads: parsed.threads,
        // Incomplete when a row could not be read or a list came up short of its
        // own count: the caller must not read an absence as a deletion then.
        complete: parsed.undated === 0 && !inbox.short && !sent.short,
        pages: inbox.pages + sent.pages,
      };
    },
    async loadMessageAttachment(handle) {
      const url = new URL(attachmentPath(handle.dcsId), endpoint.baseUrl).href;
      return withFreshToken((accessToken) =>
        apiGetFile(http, { url, accessToken, endpoint: "attachment" }),
      );
    },
    async isSessionAlive(): Promise<boolean> {
      // The app's own `auth/check/logged-in` answers `true` to any bearer at all,
      // a forged one included, so it proves nothing. One row of the upcoming list
      // is the cheapest call that actually needs the token. Refreshing the token
      // on the way (`ensureAccessToken`) is what keeps the refresh grant's idle
      // window from lapsing between hourly runs.
      try {
        await get(
          UPCOMING_PATH,
          {
            selector: "reason",
            where: "",
            // Required: the list answers a 500 without it.
            from: startOfToday("UTC"),
            [PAGING.pageSizeParam]: "1",
            [PAGING.pageNumberParam]: "1",
          },
          "session-check",
        );
        return true;
      } catch (error) {
        if (error instanceof AppError && error.code === "portal_session_expired") return false;
        throw error;
      }
    },
    get jar() {
      return jar;
    },
  };
}
