/**
 * The bridge: turn a signed-in shell session into a classic chart session.
 *
 * On a `custom_oidc` deployment the two halves of the portal are two
 * applications. The shell holds the password and the emailed code; the classic
 * pages hold the visits. What joins them is an OpenID hand-off, and every step
 * below is **[confirmed from capture]**: the owner's own browser capture of a
 * successful sign-in, cross-checked against the public scripts that made each
 * request, so both the request and the source of every value in it are known.
 *
 *  1. `POST <api>/sso/token` (body `{}`, `text/plain`) answers `{ yum }`, and
 *     the shell's script writes it as a cookie named `yum` at path `/`. Every
 *     classic-page request from here on carries it.
 *  2. `GET <mount>Authentication/Login` 302s to the `<mount>OpenId?...` stub,
 *     whose controller call carries six server-minted arguments: encrypted
 *     nonce, state and code verifier, the authorization URL, a workflow label,
 *     and a submit-a-form flag.
 *  3. The authorization URL points at the *shell's* authorize route -- a page of
 *     its single-page app, not an authorization server. That page's component
 *     posts `<api>/api/mychartAuth/getAuthCode` with `clientId`, `scope`,
 *     `responseType`, `guid` (= `code_challenge`) and `nonce`, all read off the
 *     URL's own query, and gets `{ authCode }` back. The bridge makes that call
 *     directly instead of loading the page.
 *  4. `GET <redirect_uri>?code=<authCode>&state=<state>` -- the URL's
 *     `redirect_uri` and `state` -- which is `<mount>OpenId/AuthorizeResult`. Its
 *     controller call echoes `(code, state, error, responseMode, issuer)`, and
 *     the page carries the antiforgery token the next POST needs.
 *  5. `POST <mount>OpenId/FinalizeAuthResponse?noCache=...`, form-urlencoded,
 *     as an XHR with that antiforgery token as a header: the five echoed values
 *     plus the stub's three encrypted ones. It answers `{ redirectUri }` and
 *     sets the classic session cookies.
 *  6. `GET <redirectUri>`, which is `<mount>Home`, signed in.
 *
 * Rules the code keeps:
 *
 *  - **No PKCE, nonce or state is generated here.** The classic side minted all
 *    of them and encrypted what it needs to see again; the bridge only carries
 *    values from where the capture shows they come from to where they go.
 *  - **Every hop goes through the jar.** The shell cookies authorise steps 1 and
 *    3; the `yum` cookie and the classic cookies carry the rest.
 *  - **Every failure is `portal_handoff_failed` with a stable `reason`** naming
 *    the step. The shell already accepted the password, so none of these is a
 *    credential problem, and the admin UI has its own sentence for this code.
 *  - **Nothing is logged but a step reason and a status.** Not a URL: these
 *    carry the mount, the host, an authorization code and a state value.
 */

import { AppError } from "../../../lib/errors.ts";
import { sessionLandingOf } from "../client.ts";
import { findAntiforgeryField, parseOpenIdRequest, parseOpenIdResponse } from "../html.ts";
import { mountedUrl, portalFetch } from "../http.ts";
import { sameRegistrableSite } from "../site.ts";
import {
  ANTIFORGERY_FIELD_NAMES,
  ANTIFORGERY_HEADER,
  NO_CACHE_PARAM,
  PATHS,
  XHR_HEADER,
} from "../wire.ts";

import { HandoffStepError, postGetAuthCode, postSsoToken } from "./api.ts";
import {
  AUTH_CODE_FIELDS,
  AUTHORIZE_PARAMS,
  AUTHORIZE_RESULT_PARAMS,
  FINALIZE_FIELDS,
  FINALIZE_PATH,
  FINALIZE_REDIRECT_KEY,
  SSO_TOKEN_COOKIE,
} from "./wire-custom.ts";

import type { ShellApi } from "./api.ts";
import type { Logger } from "../../../lib/log.ts";
import type { OpenIdRequest, OpenIdResponse } from "../html.ts";
import type { PortalResponse } from "../http.ts";

export interface BridgeDeps {
  api: ShellApi;
  logger: Logger;
  /** Origin of the classic pages. */
  baseUrl: string;
  /** Their mount, with both slashes. */
  mountPath: string;
  /** The deployment's antiforgery field name, when discovery recorded one. */
  antiforgeryFieldName?: string | undefined;
  /** The `noCache` value for the finalize call; injected so a test can pin it. */
  noCache: () => string;
  /**
   * The liveness check to confirm a landing with. Injected rather than
   * reimplemented: the classic client already knows how to ask, and it only
   * says yes for a request that ends on the classic `Home` page.
   */
  isSessionAlive: () => Promise<boolean>;
}

/** Throw a step failure. `HandoffStepError` is turned into an `AppError` once, below. */
function stepFailed(reason: string, response: Pick<PortalResponse, "status">): never {
  throw new HandoffStepError(reason, response.status);
}

/** The authorization URL's query, as the shell's authorize page would read it. */
interface AuthorizeRequest {
  clientId: string;
  scope: string;
  responseType: string;
  guid: string;
  nonce: string;
  redirectUri: string;
  state: string;
}

function authorizeRequestOf(stub: OpenIdRequest, stubUrl: string): AuthorizeRequest | null {
  let query: URLSearchParams;
  try {
    query = new URL(stub.url, stubUrl).searchParams;
  } catch {
    return null;
  }
  const read = (name: string): string => query.get(name) ?? "";
  const request: AuthorizeRequest = {
    clientId: read(AUTH_CODE_FIELDS.clientId),
    scope: read(AUTH_CODE_FIELDS.scope),
    responseType: read(AUTH_CODE_FIELDS.responseType),
    guid: read(AUTH_CODE_FIELDS.guid),
    nonce: read(AUTH_CODE_FIELDS.nonce),
    redirectUri: read(AUTHORIZE_PARAMS.redirectUri),
    state: read(AUTHORIZE_PARAMS.state),
  };
  return Object.values(request).every((value) => value !== "") ? request : null;
}

/** The finalize response's `redirectUri`, or null. */
function finalizeRedirectOf(response: PortalResponse): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value: unknown = Object.entries(parsed).find(([key]) => key === FINALIZE_REDIRECT_KEY)?.[1];
  return typeof value === "string" && value !== "" ? value : null;
}

/** A URL on the classic side's own https site, or null -- where a code may go. */
function sameSiteUrl(raw: string, base: string, siteOf: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  return url.protocol === "https:" && sameRegistrableSite(siteOf, url.href) ? url : null;
}

/** Step 2: the stub, reached the way a browser reaches it -- through the login path. */
async function readStub(
  deps: BridgeDeps,
): Promise<{ stub: OpenIdRequest; authorize: AuthorizeRequest; resultUrl: URL }> {
  const stubPage = await portalFetch(deps.api.http, {
    url: mountedUrl(deps.baseUrl, deps.mountPath, PATHS.login),
    endpoint: "OidcStart",
    accept: "html",
  });
  if (stubPage.status >= 400) stepFailed("stub_unavailable", stubPage);
  const stub = parseOpenIdRequest(stubPage.body);
  if (stub === null) stepFailed("stub_unrecognized", stubPage);
  // The form-submitting branch of the controller was never observed, so it is
  // refused rather than guessed at.
  if (stub.submitForm) stepFailed("stub_submits_form", stubPage);
  const authorize = authorizeRequestOf(stub, stubPage.url);
  if (authorize === null) stepFailed("authorize_url_unreadable", stubPage);
  // The code goes to `redirect_uri`, so that has to be the classic side's own
  // site -- the same rule `portalFetch` applies to every redirect it follows.
  const resultUrl = sameSiteUrl(authorize.redirectUri, stubPage.url, deps.baseUrl);
  if (resultUrl === null) stepFailed("redirect_uri_offsite", stubPage);
  return { stub, authorize, resultUrl };
}

/** Step 4: back to the classic side with the code, as the authorize page navigates. */
async function readAuthorizeResult(
  deps: BridgeDeps,
  resultUrl: URL,
): Promise<{ result: OpenIdResponse; token: string }> {
  const resultPage = await portalFetch(deps.api.http, {
    url: resultUrl.href,
    endpoint: "OidcAuthorizeResult",
    accept: "html",
  });
  if (resultPage.status >= 400) stepFailed("authorize_result_unavailable", resultPage);
  const result = parseOpenIdResponse(resultPage.body);
  if (result === null) stepFailed("authorize_result_unrecognized", resultPage);
  // This page's own token -- not the stub's, which the capture shows differs.
  const antiforgery = findAntiforgeryField(resultPage.body, [
    ...(deps.antiforgeryFieldName === undefined ? [] : [deps.antiforgeryFieldName]),
    ...ANTIFORGERY_FIELD_NAMES,
  ]);
  if (antiforgery === null) stepFailed("authorize_result_no_token", resultPage);
  return { result, token: antiforgery.value };
}

/** Step 5: finalize with the echoed values plus the stub's encrypted ones. */
async function finalizeHandoff(
  deps: BridgeDeps,
  stub: OpenIdRequest,
  result: OpenIdResponse,
  token: string,
): Promise<string> {
  const finalize = await portalFetch(deps.api.http, {
    url: mountedUrl(deps.baseUrl, deps.mountPath, FINALIZE_PATH, {
      [NO_CACHE_PARAM]: deps.noCache(),
    }),
    method: "POST",
    endpoint: "OidcFinalize",
    accept: "json",
    headers: { ...XHR_HEADER, [ANTIFORGERY_HEADER]: token },
    // Field order as the response controller builds it.
    form: {
      [FINALIZE_FIELDS.authCode]: result.code,
      [FINALIZE_FIELDS.stateFromOp]: result.state,
      [FINALIZE_FIELDS.encryptedNonce]: stub.encryptedNonce,
      [FINALIZE_FIELDS.encryptedState]: stub.encryptedState,
      [FINALIZE_FIELDS.encryptedCodeVerifier]: stub.encryptedCodeVerifier,
      [FINALIZE_FIELDS.error]: result.error,
      [FINALIZE_FIELDS.responseMode]: result.responseMode,
      [FINALIZE_FIELDS.issuer]: result.issuer,
    },
  });
  if (finalize.status >= 400) stepFailed("finalize_refused", finalize);
  const redirectUri = finalizeRedirectOf(finalize);
  if (redirectUri === null) stepFailed("finalize_unreadable", finalize);
  return redirectUri;
}

/** The six steps, in order. Throws `HandoffStepError` on the first that fails. */
async function runHandoff(deps: BridgeDeps): Promise<void> {
  const { api } = deps;

  // 1. The SSO token, written as the cookie the shell's own script writes.
  const yum = await postSsoToken(api);
  api.http.jar?.setCookie(
    api.authBaseUrl,
    `${SSO_TOKEN_COOKIE}=${encodeURIComponent(yum)}; Path=/`,
  );

  // 2. The stub and the authorization request it carries.
  const { stub, authorize, resultUrl } = await readStub(deps);

  // 3. What the shell's authorize page would have done.
  const authCode = await postGetAuthCode(api, authorize);

  // 4. The code, back where `redirect_uri` says.
  resultUrl.searchParams.set(AUTHORIZE_RESULT_PARAMS.code, authCode);
  resultUrl.searchParams.set(AUTHORIZE_RESULT_PARAMS.state, authorize.state);
  const { result, token } = await readAuthorizeResult(deps, resultUrl);

  // 5. Finalize.
  const redirectUri = await finalizeHandoff(deps, stub, result, token);

  // 6. Where finalize sends us, which must be the classic landing page. An
  // off-site answer is not followed; `Home` itself is asked instead.
  const home = mountedUrl(deps.baseUrl, deps.mountPath, PATHS.home);
  const landingUrl = sameSiteUrl(redirectUri, deps.baseUrl, deps.baseUrl)?.href ?? home;
  const landing = await portalFetch(api.http, {
    url: landingUrl,
    endpoint: "OidcLanding",
    accept: "html",
  });
  if (landing.status === 200 && sessionLandingOf(landing, deps.mountPath) === "home") return;
  // Finalize may have sent us somewhere this code does not recognise with the
  // session nonetheless set, so ask `Home` directly -- positive evidence only.
  if (await deps.isSessionAlive()) return;
  stepFailed("not_signed_in", landing);
}

/**
 * Carry the shell session across to the classic pages.
 *
 * Throws `portal_handoff_failed`, with the failing step as `details.reason`,
 * when any step of the hand-off does not do what the capture shows it doing.
 */
export async function bridgeToClassicSession(deps: BridgeDeps): Promise<void> {
  try {
    await runHandoff(deps);
  } catch (error) {
    if (!(error instanceof HandoffStepError)) throw error;
    // Logged here because `errorFields` never carries `details`: without this
    // line a failed hand-off is one bare code with no way to tell the steps
    // apart. A reason and a status only -- never a URL or a value.
    deps.logger.warn("portal.oidc_bridge_failed", { reason: error.reason, status: error.status });
    throw new AppError("portal_handoff_failed", "the OpenID hand-off did not sign us in", {
      endpoint: "OidcBridge",
      reason: error.reason,
      status: error.status,
    });
  }
  deps.logger.info("portal.oidc_bridged", {});
}
