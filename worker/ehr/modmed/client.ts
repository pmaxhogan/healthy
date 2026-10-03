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
import { createPkce, randomState } from "../pkce.ts";

import { fetchAuthData } from "./discovery.ts";
import { apiGet, signInRequest, tokenRequest } from "./http.ts";
import { parseAppointments, parsePastVisits } from "./visits.ts";
import {
  KEYCLOAK_MARKERS,
  LOGIN,
  PAGE_SIZE,
  PAGING,
  PAST_PATH,
  PAST_SELECTOR,
  REDIRECT_QUERY,
  TOKEN_EXTRAS,
  TOKEN_REFRESH_MARGIN_SECONDS,
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
      clearTokens();
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

  async function get(path: string, params: Record<string, string>, label: string) {
    const url = new URL(path, endpoint.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    try {
      return await apiGet(http, {
        url: url.href,
        accessToken: await ensureAccessToken(),
        endpoint: label,
      });
    } catch (error) {
      // The API answers a token it does not accept with a 500, not a 401. So a
      // 500 gets one retry on a freshly refreshed token: a refresh the identity
      // provider refuses turns it into `portal_session_expired` (sign in again),
      // and a second 500 on a good token really is the portal being down.
      if (!(error instanceof AppError) || error.details?.status !== 500) throw error;
      jar.setExtra(TOKEN_EXTRAS.accessExpiresAt, "0");
      return apiGet(http, {
        url: url.href,
        accessToken: await ensureAccessToken(),
        endpoint: label,
      });
    }
  }

  /** Every page of a list endpoint, to the end. No cap. */
  async function readAll(
    path: string,
    params: Record<string, string>,
    label: string,
  ): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 1; ; page += 1) {
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
      const total = Number(response.headers.get(PAGING.countHeader));
      const done = Number.isFinite(total) && total >= 0 && rows.length >= total;
      // Stop on the reported total, or -- when the header is missing -- on a
      // short or empty page. An empty page always ends the loop, so a server
      // that over-reports its total cannot spin it.
      if (done || response.json.length === 0 || response.json.length < PAGE_SIZE) break;
    }
    logger.info("portal.modmed.list", { endpoint: label, rows: rows.length });
    return rows;
  }

  /** The start of today in `timeZone`, written the way the app writes it. */
  function startOfToday(timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(deps.now() * 1000));
    return `${parts}T00:00:00.000Z`;
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
    let landed = await signInRequest(http, { url: authorizeUrl, endpoint: "authorize" });
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
    loadMessages() {
      // Not read yet. `complete: false` tells the caller its absence is not a
      // deletion, so nothing stored is pruned on the strength of it.
      return Promise.resolve({ threads: [], complete: false, pages: 0 });
    },
    loadMessageAttachment() {
      return Promise.reject(
        new AppError("portal_parse_failed", "this portal's messages are not read yet"),
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
