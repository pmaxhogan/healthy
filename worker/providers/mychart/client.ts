/**
 * The authenticated portal client: sign in, answer the emailed code, read the
 * upcoming visits.
 *
 * Shape of the thing: every call is "fetch a page, take its antiforgery token,
 * post to the action next to it, then look at where you landed". There is no
 * status field to read -- the portal answers a wrong password, a pending code
 * and a dead session all with an HTTP 200 and a different page -- so *where the
 * redirect chain stopped* is the primary signal, and a body marker is only the
 * tie-breaker. `http.ts` is what makes that signal available at all, by
 * following redirects by hand.
 *
 * What this module is careful about:
 *
 *  - **A fresh token per POST.** The token is per-page and short-lived; reusing
 *    the login page's token for the code POST is one of the ways this silently
 *    starts failing. `validate()` therefore re-fetches the challenge page even
 *    though `sendCode()` has just been there.
 *  - **`LoadUpcoming` gets no body at all**, and so no `Content-Type`. The token
 *    rides in a header instead, because there is nowhere else to put it.
 *  - **Session-expired detection is opt-in per call.** The sign-in flow lands on
 *    login pages legitimately, so only the calls that are supposed to be
 *    authenticated treat a login page as `portal_session_expired`.
 *  - **It holds no state but the jar.** No provider id, no D1, no env: the
 *    caller owns the account row, loads the jar into this client and seals
 *    whatever the jar looks like afterwards. That is also why nothing here can
 *    log a provider id -- the caller's child logger carries it.
 *  - **Nothing from the portal is logged.** Not a URL, not a host, not a mount,
 *    not a body, not a name. Stable endpoint labels, HTTP statuses and counts.
 */

import { AppError } from "../../lib/errors.ts";

import { bodyMentions, findAntiforgeryField, inputFields } from "./html.ts";
import { mountedUrl, portalFetch } from "./http.ts";
import { parseUpcoming } from "./visits.ts";
import {
  ANTIFORGERY_FIELD_NAMES,
  ANTIFORGERY_HEADER,
  FIELDS,
  LOAD_UPCOMING_QUERY,
  MARKERS,
  NO_CACHE_PARAM,
  PATHS,
  REMEMBER_ME_VALUE,
  SEND_CODE_VARIANTS,
  XHR_HEADER,
} from "./wire.ts";

import type { CookieJar } from "./cookie-jar.ts";
import type { PortalEndpoint } from "./discovery.ts";
import type { PortalHttpDeps, PortalResponse } from "./http.ts";
import type { PortalVisit } from "./visits.ts";
import type { UsernameField } from "./wire.ts";
import type { Logger } from "../../lib/log.ts";
import type { PortalSignInStatus } from "@shared/types.ts";

export interface PortalCredentials {
  username: string;
  password: string;
}

export interface PortalClientDeps {
  /** Where the instance is and how its login form is shaped. From `discovery.ts`. */
  endpoint: PortalEndpoint;
  /** Loaded from the sealed column, and re-sealed by the caller afterwards. */
  jar: CookieJar;
  fetchImpl: typeof fetch;
  logger: Logger;
  /** Unix seconds. Injected so nothing here reads the wall clock directly. */
  now: () => number;
  /** The cache-buster's randomness. Injected so a test can pin the URL. */
  random?: (() => number) | undefined;
  maxRedirects?: number | undefined;
}

/** The two-step challenge, as two calls because a human sits between them. */
export interface SecondaryValidation {
  /**
   * Ask the portal to send a code.
   *
   * Only `"email"` is implemented: it is the channel the design settled on, and
   * an SMS code has nowhere to arrive. The parameter exists so adding one later
   * does not change the shape of this interface.
   */
  sendCode(channel: "email"): Promise<void>;
  /**
   * Submit a code. `rememberMe` asks the portal to trust this device, which is
   * what puts the cookie in the jar that lets a later run skip the code
   * entirely -- so it defaults to true.
   */
  validate(code: string, rememberMe?: boolean): Promise<void>;
}

export interface PortalClient {
  login(credentials: PortalCredentials): Promise<PortalSignInStatus>;
  readonly secondaryValidation: SecondaryValidation;
  /**
   * The upcoming visits, in the clinic's own zone.
   *
   * `timeZone` is what the portal is asked to render in and the fallback for a
   * row that does not name its own; the owner's zone from `settings` is what to
   * pass.
   */
  loadUpcoming(timeZone: string): Promise<PortalVisit[]>;
  /** A cheap authenticated GET. False means the session is gone, not that it failed. */
  isSessionAlive(): Promise<boolean>;
  /** The live jar, for the caller to seal after any call. */
  readonly jar: CookieJar;
}

/** Where a redirect chain stopped, which is the only reliable sign-in signal. */
type Landing = "signed_in" | "awaiting_code" | "login";

/** The lower-cased path of a URL, or "" when it is not one. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function landingOf(response: PortalResponse): Landing {
  const path = pathOf(response.url);
  const onValidation =
    path.includes(PATHS.secondaryValidation.toLowerCase()) ||
    bodyMentions(response.body, MARKERS.secondaryValidation);
  if (onValidation) return "awaiting_code";
  // `Authentication/Login` is a prefix of `Authentication/Login/DoLogin`, so the
  // POST's own URL has to be excluded or every DoLogin would read as a bounce.
  const onLoginPage =
    path.includes(PATHS.login.toLowerCase()) && !path.includes(PATHS.doLogin.toLowerCase());
  return onLoginPage || bodyMentions(response.body, MARKERS.loginForm) ? "login" : "signed_in";
}

/** A login page reached from an authenticated call means the session died. */
function assertSession(response: PortalResponse, endpoint: string): void {
  const landing = landingOf(response);
  if (landing === "login") {
    throw new AppError("portal_session_expired", "the portal bounced to the login page", {
      endpoint,
      status: response.status,
    });
  }
  if (landing === "awaiting_code") {
    throw new AppError("portal_2fa_required", "the portal is waiting for a verification code", {
      endpoint,
      status: response.status,
    });
  }
}

/** A locked account and a wrong password both land on the login page. */
function loginFailure(response: PortalResponse, endpoint: string): AppError {
  const details = { endpoint, status: response.status };
  return bodyMentions(response.body, MARKERS.locked)
    ? new AppError("portal_locked", "the portal locked the account", details)
    : new AppError("portal_login_failed", "the portal rejected the credentials", details);
}

/**
 * The hidden fields to echo back with a form POST.
 *
 * Everything the page already filled in, which is how a browser behaves: these
 * forms carry per-request state beyond the antiforgery token, and dropping it
 * fails in a way indistinguishable from a wrong password. Empty inputs are the
 * boxes the user types into and are supplied by the caller instead.
 */
function echoedFields(html: string, exclude: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of inputFields(html)) {
    if (value === "" || exclude.includes(name)) continue;
    out[name] = value;
  }
  return out;
}

/** The username field this page actually renders, or the discovered fallback. */
function usernameFieldOn(html: string, fallback: UsernameField): UsernameField {
  const fields = inputFields(html);
  if (fields.has("LoginIdentifier")) return "LoginIdentifier";
  return fields.has("Username") ? "Username" : fallback;
}

/**
 * True when a `SendCode` attempt looks like it worked.
 *
 * Deliberately generous: the parameter names are a guess, so "did this one work"
 * has to be decided from a response that might be JSON, might be a fragment of
 * HTML, and might be an empty 200. Anything that is not an explicit refusal
 * counts, and the caller only moves on to the next variant when it is.
 */
function sendCodeAccepted(response: PortalResponse): boolean {
  if (response.status >= 400 || bodyMentions(response.body, MARKERS.badCredentials)) return false;
  const trimmed = response.body.trim();
  if (!trimmed.startsWith("{")) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return true;
  }
  if (typeof parsed !== "object" || parsed === null) return true;
  const flags = new Map(Object.entries(parsed));
  return flags.get("success") !== false && flags.get("Success") !== false;
}

export function createMyChartClient(deps: PortalClientDeps): PortalClient {
  const { endpoint, jar, logger } = deps;
  const http: PortalHttpDeps = {
    fetchImpl: deps.fetchImpl,
    logger,
    jar,
    maxRedirects: deps.maxRedirects,
  };
  // eslint-disable-next-line sonarjs/pseudo-random -- this randomness is a cache-buster in a query string, never a secret; the endpoints are documented as taking one.
  const random = deps.random ?? ((): number => Math.random());
  const noCache = (): string => String(Math.floor(random() * 1_000_000_000_000_000));
  const url = (path: string, query: Record<string, string> = {}): string =>
    mountedUrl(endpoint.baseUrl, endpoint.mountPath, path, query);

  /** GET a page and take its antiforgery token. The first half of every POST. */
  const tokenPage = async (
    path: string,
    label: string,
    query: Record<string, string> = {},
  ): Promise<{ response: PortalResponse; name: string; value: string }> => {
    const response = await portalFetch(http, {
      url: url(path, query),
      endpoint: label,
      accept: "html",
      followBodyRedirects: true,
    });
    if (response.status !== 200) {
      throw new AppError("portal_parse_failed", "the portal did not return the page", {
        endpoint: label,
        status: response.status,
      });
    }
    const field = findAntiforgeryField(response.body, [
      endpoint.antiforgeryFieldName,
      ...ANTIFORGERY_FIELD_NAMES,
    ]);
    if (field === null) {
      throw new AppError("portal_parse_failed", "the page carried no antiforgery token", {
        endpoint: label,
        status: response.status,
      });
    }
    return { response, name: field.name, value: field.value };
  };

  const login = async (credentials: PortalCredentials): Promise<PortalSignInStatus> => {
    const page = await tokenPage(PATHS.login, "Login");
    // Trust the page over the stored discovery result: a release can rename the
    // field between the probe and the first sign-in.
    const usernameField = usernameFieldOn(page.response.body, endpoint.usernameField);

    const response = await portalFetch(http, {
      url: url(PATHS.doLogin),
      method: "POST",
      endpoint: "DoLogin",
      accept: "html",
      followBodyRedirects: true,
      form: {
        ...echoedFields(page.response.body, [usernameField, FIELDS.password]),
        [page.name]: page.value,
        [usernameField]: credentials.username,
        [FIELDS.password]: credentials.password,
      },
    });

    const landing = landingOf(response);
    if (landing === "login") throw loginFailure(response, "DoLogin");
    const status: PortalSignInStatus = landing === "awaiting_code" ? "awaiting_code" : "signed_in";
    logger.info("portal.login", { signInStatus: status, status: response.status });
    return status;
  };

  const sendCode = async (_channel: "email"): Promise<void> => {
    let attempted = 0;
    for (const variant of SEND_CODE_VARIANTS) {
      const page = await tokenPage(PATHS.secondaryValidation, "SecondaryValidation");
      attempted++;
      const response = await portalFetch(http, {
        url: url(PATHS.sendCode),
        method: "POST",
        endpoint: "SendCode",
        accept: "json",
        headers: { ...XHR_HEADER },
        form: { ...variant, [page.name]: page.value },
      });
      if (sendCodeAccepted(response)) {
        logger.info("portal.code_requested", { attempts: attempted, status: response.status });
        return;
      }
    }
    // Every documented parameter shape was refused. This is reported as a login
    // failure rather than a 2FA failure: no code was ever sent, so there is
    // nothing for the owner to wait for and the sign-in simply did not start.
    logger.warn("portal.code_request_failed", { attempts: attempted });
    throw new AppError("portal_login_failed", "the portal would not send a verification code", {
      endpoint: "SendCode",
      attempts: attempted,
    });
  };

  const validate = async (code: string, rememberMe = true): Promise<void> => {
    // A fresh token, deliberately: the one `sendCode` used is spent.
    const page = await tokenPage(PATHS.secondaryValidation, "SecondaryValidation");
    const response = await portalFetch(http, {
      url: url(PATHS.validate),
      method: "POST",
      endpoint: "Validate",
      accept: "html",
      followBodyRedirects: true,
      form: {
        ...echoedFields(page.response.body, [FIELDS.twoFactorCode, FIELDS.rememberMe]),
        [page.name]: page.value,
        [FIELDS.twoFactorCode]: code,
        ...(rememberMe && { [FIELDS.rememberMe]: REMEMBER_ME_VALUE }),
      },
    });

    const landing = landingOf(response);
    if (landing === "signed_in") {
      logger.info("portal.validated", { status: response.status, rememberMe });
      return;
    }
    if (landing === "login") throw loginFailure(response, "Validate");
    // Still on the challenge page: the code was wrong, stale or already used.
    throw new AppError("portal_2fa_rejected", "the portal rejected the verification code", {
      endpoint: "Validate",
      status: response.status,
    });
  };

  const loadUpcoming = async (timeZone: string): Promise<PortalVisit[]> => {
    const page = await tokenPage(PATHS.visitsList, "VisitsList", { [NO_CACHE_PARAM]: noCache() });
    assertSession(page.response, "VisitsList");

    const response = await portalFetch(http, {
      url: url(PATHS.loadUpcoming, {
        timeZone,
        ...LOAD_UPCOMING_QUERY,
        [NO_CACHE_PARAM]: noCache(),
      }),
      method: "POST",
      endpoint: "LoadUpcoming",
      accept: "json",
      headers: { ...XHR_HEADER, [ANTIFORGERY_HEADER]: page.value },
      // No `form`, so no body and no Content-Type. See the module comment.
    });
    assertSession(response, "LoadUpcoming");
    if (response.status !== 200) {
      throw new AppError("portal_parse_failed", "the upcoming-visits call failed", {
        endpoint: "LoadUpcoming",
        status: response.status,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch (error) {
      throw new AppError(
        "portal_parse_failed",
        "the upcoming-visits body was not JSON",
        { endpoint: "LoadUpcoming", status: response.status },
        { cause: error },
      );
    }
    const parsed = parseUpcoming(payload, timeZone);
    logger.info("portal.upcoming", { visits: parsed.visits.length, unparsed: parsed.unparsed });
    return parsed.visits;
  };

  const isSessionAlive = async (): Promise<boolean> => {
    // Deliberately not `assertSession`: the answer to this question is a
    // boolean, and a transport failure or a bot block is a different thing again
    // and is allowed to propagate.
    const response = await portalFetch(http, {
      url: url(PATHS.home, { [NO_CACHE_PARAM]: noCache() }),
      endpoint: "Home",
      accept: "html",
      followBodyRedirects: true,
    });
    const alive = response.status === 200 && landingOf(response) === "signed_in";
    logger.debug("portal.session_check", { alive, status: response.status });
    return alive;
  };

  return {
    login,
    secondaryValidation: { sendCode, validate },
    loadUpcoming,
    isSessionAlive,
    jar,
  };
}
