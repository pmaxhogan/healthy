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
 *  - **The credential POST has two shapes.** Some deployments post the
 *    username and password as sibling form fields; a live capture found
 *    others post an "envelope" instead -- a form with no credential fields of
 *    its own, carrying a single `LoginInfo` value that is base64'd JSON. See
 *    `LOGIN_INFO` in `wire.ts` and `login()`'s own comments for the shape.
 */

import { AppError } from "../../lib/errors.ts";
import { base64Utf8 } from "../adapter.ts";

import { isLoginPage } from "./discovery.ts";
import { bodyMentions, findAntiforgeryField, formFields, inputFields } from "./html.ts";
import { isOpenIdHandoff, mountedUrl, normaliseMount, pathOf, portalFetch } from "./http.ts";
import { parsePast, parseUpcoming } from "./visits.ts";
import {
  ANTIFORGERY_FIELD_NAMES,
  ANTIFORGERY_HEADER,
  DEVICE_ID_EXTRA_KEY,
  FIELDS,
  JS_ENABLED_VALUE,
  LOAD_PAST_QUERY,
  LOAD_UPCOMING_QUERY,
  LOGIN_INFO,
  MARKERS,
  NO_CACHE_PARAM,
  OLDEST_RENDERED_DATE_PARAM,
  PATHS,
  RAN_DEVICE_CHECK_QUERY,
  RECONCILE_FORM,
  RECONCILE_RESPONSE_KEYS,
  REMEMBER_ME_VALUE,
  SEND_CODE_FORM,
  USERNAME_FIELD_NAMES,
  VALIDATE_FORM,
  VALIDATE_RESPONSE_KEYS,
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
  /**
   * Mints a device id for the `custom_oidc` strategy, which does generate its
   * own. The classic client never uses it: its `DeviceId` is issued by the
   * portal -- see `DEVICE_ID_EXTRA_KEY`. Injected so a test can pin the value;
   * defaults to `crypto.randomUUID()`.
   */
  generateDeviceId?: (() => string) | undefined;
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
   * Submit a code. `rememberMe` asks the portal to trust this device, and a
   * success issues the remembered-device id (kept in the jar's extras, see
   * `DEVICE_ID_EXTRA_KEY`) that a later sign-in presents -- so it defaults to
   * true. A success then walks the page's own navigation to `Home`.
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

function landingOf(response: Pick<PortalResponse, "url" | "body">): Landing {
  const path = pathOf(response.url);
  // The delivery-method choice a correct password can land on before any code
  // has been sent: not every deployment puts it under `secondaryValidation`'s
  // own path, and its markup carries none of `MARKERS.secondaryValidation`
  // either -- without its own check it would fall through to "signed in".
  const onValidation =
    path.includes(PATHS.secondaryValidation.toLowerCase()) ||
    bodyMentions(response.body, MARKERS.secondaryValidation) ||
    bodyMentions(response.body, MARKERS.deliveryMethodChoice);
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

/** Where a liveness probe ended up. Logged, so it is a kind and never a URL. */
export type SessionLanding = "login" | "home" | "other";

/**
 * Classify a liveness probe's landing.
 *
 * `home` only for a page at `<mount>Home` (or below it) that is not itself a
 * login page, challenge or handoff stub: that is the one answer that proves a
 * signed-in session. `login` for every flavour of "go and sign in". Anything
 * else -- a shell page, an interstitial, an error page -- is `other`, and is not
 * alive: see `isSessionAlive`.
 */
export function sessionLandingOf(
  response: Pick<PortalResponse, "url" | "body">,
  mountPath: string,
): SessionLanding {
  if (landingOf(response) !== "signed_in") return "login";
  const home = `${normaliseMount(mountPath)}${PATHS.home}`.toLowerCase();
  const path = pathOf(response.url);
  return path === home || path.startsWith(`${home}/`) ? "home" : "other";
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
function echoedFrom(
  fields: ReadonlyMap<string, string>,
  exclude: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of fields) {
    if (value === "" || exclude.includes(name)) continue;
    out.set(name, value);
  }
  return out;
}

/**
 * The portal-issued remembered-device id, or `""` before one has been issued --
 * which is exactly what the page's own script sends on a first sign-in. See
 * `DEVICE_ID_EXTRA_KEY`.
 */
function storedDeviceId(jar: CookieJar): string {
  return jar.getExtra(DEVICE_ID_EXTRA_KEY) ?? "";
}

/** A query-string parameter off an absolute URL, or `""` when it is absent. */
function queryParam(url: string, name: string): string {
  try {
    return new URL(url).searchParams.get(name) ?? "";
  } catch {
    return "";
  }
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

/**
 * A JSON object body as a `Map`, or null for anything else.
 *
 * A `Map` for the same reason `echoedFrom` returns one: the keys are the
 * portal's, not ours.
 */
function jsonObject(response: PortalResponse): Map<string, unknown> | null {
  if (!looksLikeJson(response)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? new Map(Object.entries(parsed))
    : null;
}

/** A non-empty string value off a JSON object, or null. */
function stringField(object: ReadonlyMap<string, unknown>, key: string): string | null {
  const value = object.get(key);
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * True when a `SendCode` POST looks like it worked.
 *
 * The captured answer is `{"Success":true}`, and the page's own script treats
 * anything without a truthy `Success` as a failure. This stays a little more
 * generous than that -- any object that does not explicitly say `success:
 * false`, and an empty 200, still count -- because the refusal shape was never
 * captured. **Not generous about a populated HTML body.** A 200 carrying a page
 * is what a missed antiforgery header or an unrelated shell page looks like,
 * and either one means no code was actually sent -- so a non-empty, non-JSON
 * body counts as accepted only when the page it rendered is a code-entry form,
 * i.e. it carries a `TwoFactorCode` input. Treating any old 200 as success
 * would report `awaiting_code` for a run that never got a code sent and had
 * nothing for the owner to wait for.
 */
function sendCodeAccepted(response: PortalResponse): boolean {
  if (response.status >= 400 || bodyMentions(response.body, MARKERS.badCredentials)) return false;
  const trimmed = response.body.trim();
  // An empty 200 is still treated as generously as ever: some deployments
  // answer this way and there is nothing about an empty body that looks like
  // a refusal. Only a *populated* non-JSON body -- a page -- is held to the
  // code-entry-page rule below.
  if (trimmed === "") return true;
  if (!trimmed.startsWith("{")) return inputFields(response.body).has(FIELDS.twoFactorCode);
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
      // The OpenID stub likewise: it is where a dead `custom_oidc` session
      // lands, and its own script is a hop into the shell, not a page to read.
      recognizeLanding: (landed) => isLoginPage(landed) || isOpenIdHandoff(landed),
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

    // The form the page's own script actually submits, scoped to that form
    // alone -- never the whole page. A classic login page can render a second
    // form (`#loginForm`, action `"#"`) that is never submitted; echoing its
    // fields back would be a field a real browser never would have sent. `null`
    // only for a page shaped unlike either known form, in which case the whole
    // page is the fallback this client has always used.
    const postedForm = formFields(page.response.body, { actionSuffix: PATHS.doLogin });
    const postedFields = postedForm?.fields ?? inputFields(page.response.body);
    // [confirmed] The "envelope" shape a live capture found: the posted form
    // carries no username or password field of its own at all, because the
    // script builds `LoginInfo` from the *other* form's fields instead of
    // sending them as siblings. A deployment that still renders the
    // credentials directly on the posted form is not this shape, and the flat
    // POST below is used exactly as it always was. Bound to a narrowed
    // constant, not a bare boolean, so the compiler (not just the runtime)
    // knows `envelopeForm.action` is safe to read below.
    const envelopeForm =
      postedForm !== null &&
      !postedFields.has(FIELDS.password) &&
      USERNAME_FIELD_NAMES.every((name) => !postedFields.has(name))
        ? postedForm
        : null;

    const response =
      envelopeForm === null
        ? await portalFetch(http, {
            url: url(PATHS.doLogin),
            method: "POST",
            endpoint: "DoLogin",
            accept: "html",
            followBodyRedirects: true,
            // `Object.fromEntries` at the boundary, so the page's own attribute names
            // only ever live in a Map -- see `echoedFrom`. The caller's own fields are
            // spread after, and so always win. `jsEnabled` is excluded from the echo
            // and set explicitly below: the page's own default value for it is not
            // what a JS-enabled browser would submit. The echo is scoped to the
            // posted form's own fields (`postedFields`), never the whole page.
            form: {
              ...Object.fromEntries(
                echoedFrom(postedFields, [usernameField, FIELDS.password, FIELDS.jsEnabled]),
              ),
              [page.name]: page.value,
              [usernameField]: credentials.username,
              [FIELDS.password]: credentials.password,
              ...(hasJsEnabled && { [FIELDS.jsEnabled]: JS_ENABLED_VALUE }),
            },
          })
        : await portalFetch(http, {
            url: new URL(envelopeForm.action, page.response.url).href,
            method: "POST",
            endpoint: "DoLogin",
            accept: "html",
            followBodyRedirects: true,
            // Exactly the envelope's fields and nothing else -- no whole-page
            // echo, and deliberately no `jsenabled`: the script never puts it on
            // this form. See `LOGIN_INFO` in `wire.ts` for the JSON shape.
            form: {
              [page.name]: page.value,
              [FIELDS.deviceId]: storedDeviceId(jar),
              [FIELDS.forMobile]: queryParam(page.response.url, FIELDS.forMobile),
              [FIELDS.postLoginUrl]: queryParam(page.response.url, FIELDS.postLoginUrl),
              [FIELDS.loginInfo]: JSON.stringify({
                [LOGIN_INFO.typeKey]: LOGIN_INFO.type,
                [LOGIN_INFO.credentialsKey]: {
                  [LOGIN_INFO.identifierKey]: base64Utf8(credentials.username),
                  [LOGIN_INFO.passwordKey]: base64Utf8(credentials.password),
                },
              }),
            },
          });

    const landing = landingOf(response);
    if (landing === "login") throw loginFailure(response, "DoLogin");
    const status: PortalSignInStatus = landing === "awaiting_code" ? "awaiting_code" : "signed_in";
    logger.info("portal.login", { signInStatus: status, status: response.status });
    return status;
  };

  /**
   * The challenge page's token, fetched the way a browser reaches it.
   *
   * With `RAN_DEVICE_CHECK_QUERY`: the bare path is a device-check stub, and the
   * page the portal's own script posts `SendCode` and `Validate` from is the one
   * that stub navigates to.
   */
  const challengeToken = (): ReturnType<typeof tokenPage> =>
    tokenPage(PATHS.secondaryValidation, "SecondaryValidation", RAN_DEVICE_CHECK_QUERY);

  /**
   * One of the challenge page's own XHR POSTs: form-urlencoded, the token in a
   * header rather than the body, and a cache-buster on the URL -- the shape a
   * capture of the page's script showed for `SendCode`, `Validate` and
   * `ReconcileWebDevice` alike.
   */
  const xhrPost = (
    path: string,
    label: string,
    token: string,
    form: Record<string, string>,
  ): Promise<PortalResponse> =>
    portalFetch(http, {
      url: url(path, { [NO_CACHE_PARAM]: noCache() }),
      method: "POST",
      endpoint: label,
      accept: "json",
      headers: { ...XHR_HEADER, [ANTIFORGERY_HEADER]: token },
      form,
    });

  const sendCode = async (_channel: "email"): Promise<void> => {
    const page = await challengeToken();
    const response = await xhrPost(PATHS.sendCode, "SendCode", page.value, { ...SEND_CODE_FORM });
    if (sendCodeAccepted(response)) {
      logger.info("portal.code_requested", { status: response.status });
      return;
    }
    // Reported as a login failure rather than a 2FA failure: no code was ever
    // sent, so there is nothing for the owner to wait for and the sign-in
    // simply did not start.
    logger.warn("portal.code_request_failed", { status: response.status });
    throw new AppError("portal_login_failed", "the portal would not send a verification code", {
      endpoint: "SendCode",
      status: response.status,
    });
  };

  /**
   * GET `Home` (or a hop that ends there) and classify where it landed.
   *
   * Shared by the liveness check and by the navigation after a successful
   * `Validate`, which must end on the same positive evidence.
   */
  const fetchHome = async (
    path: string,
    label: string,
    query: Record<string, string> = {},
  ): Promise<{ response: PortalResponse; landed: SessionLanding }> => {
    const response = await portalFetch(http, {
      url: url(path, query),
      endpoint: label,
      accept: "html",
      followBodyRedirects: true,
      // A dead session lands on the login page, or on the OpenID stub, and
      // neither one's own script may be read as a redirect to follow further.
      recognizeLanding: (landed) => isLoginPage(landed) || isOpenIdHandoff(landed),
    });
    return { response, landed: sessionLandingOf(response, endpoint.mountPath) };
  };

  /**
   * What a signed-in page's own script does on load: reconcile the stored
   * remembered-device id, and take the portal's answer when it says to.
   *
   * Best effort, as the browser's own call is -- fired detached, its failure
   * shown to nobody. It never fails the sign-in, and it logs only whether the
   * id changed, never the id.
   */
  const reconcileDevice = async (home: PortalResponse): Promise<void> => {
    const stored = storedDeviceId(jar);
    const field = findAntiforgeryField(home.body, [
      endpoint.antiforgeryFieldName,
      ...ANTIFORGERY_FIELD_NAMES,
    ]);
    if (field === null) {
      logger.warn("portal.device_reconcile_skipped", { reason: "no_antiforgery_token" });
      return;
    }
    try {
      const response = await xhrPost(PATHS.reconcileWebDevice, "ReconcileWebDevice", field.value, {
        [RECONCILE_FORM.deviceIdKey]: stored,
        [RECONCILE_FORM.skipSessionCheckKey]: RECONCILE_FORM.skipSessionCheck,
      });
      const answer = jsonObject(response);
      const issued = answer === null ? null : stringField(answer, RECONCILE_RESPONSE_KEYS.deviceId);
      const updated =
        issued !== null &&
        issued !== stored &&
        (stored === "" || answer?.get(RECONCILE_RESPONSE_KEYS.forceUpdate) === true);
      if (updated) jar.setExtra(DEVICE_ID_EXTRA_KEY, issued);
      logger.info("portal.device_reconciled", {
        status: response.status,
        json: answer !== null,
        updated,
      });
    } catch (error) {
      logger.warn("portal.device_reconcile_failed", {
        code: error instanceof AppError ? error.code : "unknown",
      });
    }
  };

  const validate = async (code: string, rememberMe = true): Promise<void> => {
    // A fresh token, deliberately: the one `sendCode` used is spent.
    const page = await challengeToken();
    const response = await xhrPost(PATHS.validate, "Validate", page.value, {
      [FIELDS.twoFactorCode]: code,
      // Always sent, `""` when not trusting the device: the script never omits it.
      [FIELDS.rememberMe]: rememberMe ? REMEMBER_ME_VALUE : "",
      ...VALIDATE_FORM,
      [FIELDS.deviceId]: storedDeviceId(jar),
    });

    const answer = jsonObject(response);
    if (answer === null) {
      // Not the JSON the page's script expects. A bounce to the login page is
      // the likeliest reason (a dead session answers with a page); anything
      // else is still the challenge, and so a refused code.
      if (landingOf(response) === "login") throw loginFailure(response, "Validate");
      throw new AppError("portal_2fa_rejected", "the portal rejected the verification code", {
        endpoint: "Validate",
        status: response.status,
      });
    }
    if (answer.get(VALIDATE_RESPONSE_KEYS.success) !== true) {
      const details = {
        endpoint: "Validate",
        status: response.status,
        invalidCode: answer.get(VALIDATE_RESPONSE_KEYS.invalidCode) === true,
      };
      if (answer.get(VALIDATE_RESPONSE_KEYS.mustLogout) === true) {
        throw new AppError("portal_login_failed", "the portal ended the sign-in", details);
      }
      throw new AppError(
        "portal_2fa_rejected",
        "the portal rejected the verification code",
        details,
      );
    }

    // The id that lets a later sign-in be recognised as this device. Stored
    // whenever the portal issues one: it is the portal's, never ours.
    const issued = stringField(answer, VALIDATE_RESPONSE_KEYS.rememberDeviceId);
    if (issued !== null) jar.setExtra(DEVICE_ID_EXTRA_KEY, issued);

    // Where the page's script goes next: a redirect chain ending on Home, with
    // a cookie set on every hop of it.
    const home = await fetchHome(PATHS.insideAsp, "InsideAsp");
    if (home.landed === "login") {
      if (landingOf(home.response) === "login") throw loginFailure(home.response, "InsideAsp");
      throw new AppError("portal_2fa_rejected", "the portal is still asking for a code", {
        endpoint: "InsideAsp",
        status: home.response.status,
      });
    }
    logger.info("portal.validated", {
      status: response.status,
      rememberMe,
      deviceIdIssued: issued !== null,
      landed: home.landed,
      hops: home.response.hops,
    });
    if (home.landed === "home") await reconcileDevice(home.response);
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
   * Is the session alive -- decided by a page only a signed-in session is served.
   *
   * `Home`, and only a chain that *ends* on `Home` under this mount, counts. That
   * is positive evidence, and nothing weaker is accepted any more:
   *
   *  - Not `Home/KeepAlive`. It used to be asked first, and a short 200 from it
   *    counted as alive -- but a keepalive exists to keep *a* session alive, not
   *    to say whose, and an anonymous session (the one the OpenID stub itself
   *    hands out) can be answered just as briefly. That false positive lets a
   *    `custom_oidc` bridge that never reached the classic session report
   *    `signed_in`, and the sync after it pass its liveness check only to bounce
   *    off `VisitsList` with `portal_session_expired`.
   *  - Not "any page that is not a login page". On a deployment whose login lives
   *    in a separate shell on the same host, a dead session can be redirected into
   *    that shell's own pages, which carry no login-form marker at all.
   *
   * One `portal.session_check` line per probe, with the landing *kind* -- never a
   * URL -- because "alive or not" alone cannot say which of those happened.
   *
   * Deliberately not `assertSession`: the answer to this question is a boolean,
   * and a transport failure or a bot block is a different thing again and is
   * allowed to propagate.
   */
  const isSessionAlive = async (): Promise<boolean> => {
    const { response, landed } = await fetchHome(PATHS.home, "Home", {
      [NO_CACHE_PARAM]: noCache(),
    });
    const alive = response.status === 200 && landed === "home";
    logger.info("portal.session_check", {
      endpoint: "Home",
      status: response.status,
      hops: response.hops,
      landed,
      alive,
    });
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
