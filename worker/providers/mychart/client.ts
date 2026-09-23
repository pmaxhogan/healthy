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

import { isLoginPage } from "./discovery.ts";
import { bodyMentions, findAntiforgeryField, inputFields } from "./html.ts";
import { isOpenIdHandoff, mountedUrl, pathOf, portalFetch } from "./http.ts";
import { parsePast, parseUpcoming } from "./visits.ts";
import {
  ANTIFORGERY_FIELD_NAMES,
  ANTIFORGERY_HEADER,
  FIELDS,
  JS_ENABLED_VALUE,
  KEEP_ALIVE_COUNT_PARAM,
  LOAD_PAST_QUERY,
  LOAD_UPCOMING_QUERY,
  MARKERS,
  NO_CACHE_PARAM,
  OLDEST_RENDERED_DATE_PARAM,
  PATHS,
  REMEMBER_ME_VALUE,
  SEND_CODE_VARIANTS,
  USERNAME_FIELD_NAMES,
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
  /**
   * Past visits, most recent first, in the clinic's own zone.
   *
   * `oldestRenderedDate` is the paging boundary: the portal answers with the page
   * of visits older than it, and omitting it asks for the first page. The reply
   * groups its rows by organisation because a chart account can be linked to
   * several; this flattens them, because the calendar does not care.
   */
  loadPast(timeZone: string, oldestRenderedDate?: string): Promise<PortalVisit[]>;
  /** A cheap authenticated GET. False means the session is gone, not that it failed. */
  isSessionAlive(): Promise<boolean>;
  /** The live jar, for the caller to seal after any call. */
  readonly jar: CookieJar;
}

/** Where a redirect chain stopped, which is the only reliable sign-in signal. */
type Landing = "signed_in" | "awaiting_code" | "login";

/**
 * Longest body `Home/KeepAlive` may answer with and still count as alive.
 *
 * The capture measured one byte -- a single JSON scalar. A handful of characters
 * of slack covers `true` and a quoted digit; anything beyond that is a page.
 */
const SCALAR_BODY_LIMIT = 8;

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
  // A `custom_oidc` deployment bounces to a login page that renders no form, so
  // none of `MARKERS.loginForm` fires and the bounce would otherwise read as
  // "signed in" -- which is the failure mode that reports an empty day.
  const bounced =
    onLoginPage || isOpenIdHandoff(response) || bodyMentions(response.body, MARKERS.loginForm);
  return bounced ? "login" : "signed_in";
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

/**
 * A locked account, a captcha challenge and a wrong password all land back on
 * the login page. The captcha check runs first: it is the one case where
 * retrying with the same credentials cannot possibly work and the owner has to
 * do something a script cannot, same as a lockout.
 */
function loginFailure(response: PortalResponse, endpoint: string): AppError {
  const details = { endpoint, status: response.status };
  if (bodyMentions(response.body, MARKERS.captchaRequired)) {
    return new AppError("portal_captcha_required", "the portal is asking for a captcha", details);
  }
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
 *
 * A `Map`, not an object literal, for the same reason `visits.ts` uses one: the
 * keys come from the page's own `<input name=...>` attributes, and that is the one
 * place untrusted markup would otherwise reach a bare object. Harmless today (the
 * values are strings, so a `__proto__` assignment is a silent no-op) but it is not
 * a property worth depending on.
 */
function echoedFields(html: string, exclude: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of inputFields(html)) {
    if (value === "" || exclude.includes(name)) continue;
    out.set(name, value);
  }
  return out;
}

/** The username field this page actually renders, or the discovered fallback. */
function usernameFieldOn(html: string, fallback: UsernameField): UsernameField {
  const fields = inputFields(html);
  for (const name of USERNAME_FIELD_NAMES) {
    if (fields.has(name)) return name;
  }
  return fallback;
}

/**
 * True when a `SendCode` attempt looks like it worked.
 *
 * Deliberately generous: the parameter names are a guess, so "did this one work"
 * has to be decided from a response that might be JSON, might be a fragment of
 * HTML, and might be an empty 200. Anything that is not an explicit refusal
 * counts, and the caller only moves on to the next variant when it is.
 */
/**
 * True when a body could plausibly be the JSON that was asked for.
 *
 * Content type first, because these endpoints label their answers, and a leading
 * `{` or `[` second, because a deployment behind a proxy that rewrites the header
 * would otherwise be unreadable. Deliberately *not* "did JSON.parse succeed":
 * the distinction being drawn is between "JSON arrived" and "an HTML page
 * arrived with a 200 on it", and the second one has to fail loudly.
 */
function looksLikeJson(response: PortalResponse): boolean {
  if (response.contentType?.includes("json") === true) return true;
  const trimmed = response.body.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

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
      // Recognise a landed login page before following any further body
      // redirect on it, the same guard `discovery.ts` uses and needed for the
      // same reason: a classic login page's own clickjacking guard (an
      // unconditional `top.location = ...` in its `else` branch) is never
      // read as a redirect at all -- see `SCRIPT_ASSIGN` in `html.ts` -- but
      // an unrelated same-origin `location.replace` elsewhere on the page
      // must not be followed past a page already known to be the login form.
      recognizeLanding: isLoginPage,
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
    // The classic cycle cannot drive a `custom_oidc` deployment at all: there is
    // no form, so `DoLogin` does not exist and posting to it would send the
    // password at a 404. Failing here, with a reason, is what tells live QA that
    // the stored endpoint lost its `flavor` on the way to this client rather than
    // that the portal changed.
    if (isOpenIdHandoff(page.response)) {
      throw new AppError("portal_parse_failed", "this deployment signs in through OpenID Connect", {
        endpoint: "Login",
        status: page.response.status,
        reason: "custom_oidc_detected",
      });
    }
    // Trust the page over the stored discovery result: a release can rename the
    // field between the probe and the first sign-in.
    const usernameField = usernameFieldOn(page.response.body, endpoint.usernameField);
    // Whether this page has a `jsenabled` field at all -- not every deployment
    // does, and sending one it never rendered is a field a real browser never
    // would have.
    const hasJsEnabled = inputFields(page.response.body).has(FIELDS.jsEnabled);

    const response = await portalFetch(http, {
      url: url(PATHS.doLogin),
      method: "POST",
      endpoint: "DoLogin",
      accept: "html",
      followBodyRedirects: true,
      // `Object.fromEntries` at the boundary, so the page's own attribute names
      // only ever live in a Map -- see `echoedFields`. The caller's own fields are
      // spread after, and so always win. `jsEnabled` is excluded from the echo
      // and set explicitly below: the page's own default value for it is not
      // what a JS-enabled browser would submit.
      form: {
        ...Object.fromEntries(
          echoedFields(page.response.body, [usernameField, FIELDS.password, FIELDS.jsEnabled]),
        ),
        [page.name]: page.value,
        [usernameField]: credentials.username,
        [FIELDS.password]: credentials.password,
        ...(hasJsEnabled && { [FIELDS.jsEnabled]: JS_ENABLED_VALUE }),
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
        ...Object.fromEntries(
          echoedFields(page.response.body, [FIELDS.twoFactorCode, FIELDS.rememberMe]),
        ),
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

  /**
   * One of the two visit endpoints, as parsed JSON.
   *
   * The order of the three checks is the whole point. `assertSession` first,
   * because a stale session is the likeliest reason a JSON endpoint answered with
   * a page and it deserves its own code. Then the "is this JSON at all" guard,
   * because a **200 carrying HTML** is exactly what a missing or misnamed
   * antiforgery header gets from these endpoints -- silently, with no 4xx
   * anywhere -- and reading that as zero visits would ghost the owner's calendar.
   * Only then `JSON.parse`.
   */
  const visitJson = async (
    path: string,
    label: string,
    query: Record<string, string>,
  ): Promise<unknown> => {
    const page = await tokenPage(PATHS.visitsList, "VisitsList", { [NO_CACHE_PARAM]: noCache() });
    assertSession(page.response, "VisitsList");

    const response = await portalFetch(http, {
      url: url(path, { ...query, [NO_CACHE_PARAM]: noCache() }),
      method: "POST",
      endpoint: label,
      accept: "json",
      headers: { ...XHR_HEADER, [ANTIFORGERY_HEADER]: page.value },
      // No `form`, so no body and no Content-Type. See the module comment.
    });
    assertSession(response, label);
    if (response.status !== 200) {
      throw new AppError("portal_parse_failed", "the visits call failed", {
        endpoint: label,
        status: response.status,
      });
    }
    if (!looksLikeJson(response)) {
      // Not an empty day: see the doc comment above.
      throw new AppError("portal_parse_failed", "the visits endpoint answered with a page", {
        endpoint: label,
        status: response.status,
      });
    }
    try {
      return JSON.parse(response.body);
    } catch (error) {
      throw new AppError(
        "portal_parse_failed",
        "the visits body was not JSON",
        { endpoint: label, status: response.status },
        { cause: error },
      );
    }
  };

  const loadUpcoming = async (timeZone: string): Promise<PortalVisit[]> => {
    const payload = await visitJson(PATHS.loadUpcoming, "LoadUpcoming", {
      timeZone,
      ...LOAD_UPCOMING_QUERY,
    });
    const parsed = parseUpcoming(payload, timeZone);
    logger.info("portal.upcoming", {
      visits: parsed.visits.length,
      unparsed: parsed.unparsed,
      truncated: parsed.truncated,
    });
    return parsed.visits;
  };

  const loadPast = async (timeZone: string, oldestRenderedDate = ""): Promise<PortalVisit[]> => {
    const payload = await visitJson(PATHS.loadPast, "LoadPast", {
      ...LOAD_PAST_QUERY,
      [OLDEST_RENDERED_DATE_PARAM]: oldestRenderedDate,
    });
    const parsed = parsePast(payload, timeZone);
    logger.info("portal.past", { visits: parsed.visits.length, unparsed: parsed.unparsed });
    return parsed.visits;
  };

  /**
   * The portal's own liveness endpoint: one byte of JSON behind the login wall.
   *
   * Returns null for "this deployment did not answer it", which is not the same
   * as a dead session -- a deployment old enough not to serve `KeepAlive` 404s
   * here, and the `Home` fallback is what decides. A 200 that is a login page is
   * a real answer, though, and short-circuits.
   */
  const keepAlive = async (): Promise<boolean | null> => {
    const response = await portalFetch(http, {
      url: url(PATHS.keepAlive, {
        [KEEP_ALIVE_COUNT_PARAM]: "1",
        [NO_CACHE_PARAM]: noCache(),
      }),
      endpoint: "KeepAlive",
      accept: "json",
    });
    if (response.status !== 200) return null;
    if (landingOf(response) !== "signed_in") return false;
    // A scalar, per the capture. Anything longer is a page, and a page here means
    // this deployment answers the path with something else entirely -- which is
    // "do not know", not "dead", so the `Home` fallback gets to decide.
    const isScalar = response.body.trim().length <= SCALAR_BODY_LIMIT;
    return isScalar || null;
  };

  const isSessionAlive = async (): Promise<boolean> => {
    // Deliberately not `assertSession`: the answer to this question is a
    // boolean, and a transport failure or a bot block is a different thing again
    // and is allowed to propagate.
    const probed = await keepAlive();
    if (probed !== null) {
      logger.debug("portal.session_check", { alive: probed, probe: "keepalive" });
      return probed;
    }
    const response = await portalFetch(http, {
      url: url(PATHS.home, { [NO_CACHE_PARAM]: noCache() }),
      endpoint: "Home",
      accept: "html",
      followBodyRedirects: true,
      // Same reason as `tokenPage`: a dead session lands here on the login
      // page, whose own frame-busting script must not be read as a redirect.
      recognizeLanding: isLoginPage,
    });
    const alive = response.status === 200 && landingOf(response) === "signed_in";
    logger.debug("portal.session_check", { alive, status: response.status, probe: "home" });
    return alive;
  };

  return {
    login,
    secondaryValidation: { sendCode, validate },
    loadUpcoming,
    loadPast,
    isSessionAlive,
    jar,
  };
}
