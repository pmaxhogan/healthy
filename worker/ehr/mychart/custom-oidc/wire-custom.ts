/**
 * Every wire-level string the `custom_oidc` login strategy depends on.
 *
 * `../wire.ts` is the same idea for the classic pages; this is its counterpart
 * for the deployment style where `Authentication/Login` renders no form at all
 * and is a redirect stub into an OpenID Connect handoff. The credentials go to a
 * separate single-page shell's JSON API; the classic session arrives afterwards,
 * by way of the OAuth2 code flow the stub starts.
 *
 * The same rules apply as in `../wire.ts`: no host, no organisation, no mount or
 * API base that names one -- the shell's API base is *discovered or configured*,
 * never written down here, because the real value names the organisation.
 * Strings only, no logic.
 *
 * CONFIDENCE KEY
 *   [confirmed from capture]
 *                observed in the owner's own browser capture of a *successful*
 *                sign-in, request by request, and cross-checked against the
 *                public scripts that made each request. The strongest level
 *                here: both what is sent and where every value comes from.
 *   [confirmed]  read out of the deployment's own public bundle: this is the
 *                route path, field name or cookie name the shell actually uses
 *   [assumption] the request or response *shape* around a confirmed route, which
 *                the capture did not include. **Every one of these is a thing
 *                live QA has to verify**, and each is annotated with what would
 *                be observed if it were wrong.
 */

/**
 * Paths under the shell's API base. No leading slash: the base supplies it.
 *
 * The base itself is `PortalEndpoint.apiBasePath`, which is discovered or
 * configured per deployment and is deliberately absent from this file.
 */
export const API_PATHS = {
  /** [confirmed] The credential POST. Form-urlencoded, not JSON. */
  login: "login",
  /** [confirmed] Asks the shell to send a verification code. */
  generateCode: "verification/code/generate",
  /** [confirmed] Submits the code. */
  validateCode: "verification/code/validate",
  /**
   * [confirmed] name, verb and request shape, read out of the shell's own
   * client code: a POST of `{ userId, rememberMeToken }`, where the token is
   * minted by the *browser*, not the server. An earlier version of this file
   * assumed the opposite -- that this call handed a token back -- which is why
   * it went unanswered and cost an extra emailed code on every single sign-in.
   */
  saveTrustToken: "api/mfa/saveTrustThisDeviceToken",
  /**
   * [confirmed] name, [assumption] verb and response.
   *
   * Assumed to be a GET, with the user id as a `userId` query parameter, that
   * answers with the contact a code can be sent to. Only consulted when the login
   * response volunteered none and the owner configured none; every part of that
   * guess -- verb, parameter name, response key -- surfaces the same way, as
   * `portal_login_failed` with `reason: "mfa_contact_unknown"`.
   */
  mfaContact: "api/mfa/contact/plain",
  /**
   * [confirmed from capture] Asks a device that was trusted before to skip the
   * code: a JSON POST of `{ userId, rememberMeToken }` -- the token read back
   * out of the trust cookie the browser minted when it was saved. The shell's
   * login screen makes this call itself whenever the login response wants a
   * code and the cookie exists; the server does not act on the cookie alone.
   * [confirmed] from the bundle, not observed: a 410 means the token is no
   * longer trusted, and the screen then forgets it and asks for a code.
   */
  validateTrustToken: "api/mfa/validateTrustThisDeviceToken",
  /**
   * [confirmed from capture] The first step of the hand-off, made once the
   * shell considers the owner signed in (after the password, the code or the
   * trusted device). A POST whose body is the literal string `{}`, sent as
   * `text/plain`. Answers `{ yum, ... }`; see `SSO_TOKEN_COOKIE`.
   */
  ssoToken: "sso/token",
  /**
   * [confirmed from capture] What the shell's own authorize page does instead
   * of being an authorization server: a JSON POST (`AUTH_CODE_FIELDS`) that
   * answers `{ authCode }`. The browser then navigates to the stub's
   * `redirect_uri` with that code and the stub's `state`.
   */
  getAuthCode: "api/mychartAuth/getAuthCode",
} as const;

/**
 * [confirmed from capture] The name of the cookie the shell's script writes
 * with the SSO token's `yum` value, at path `/`, on its own host.
 *
 * No `Set-Cookie` ever carries it -- the script sets it -- which is why the
 * bridge has to put it in the jar by hand. Every classic-page request from the
 * hand-off onwards carried it in the capture, beginning with
 * `Authentication/Login` itself.
 */
export const SSO_TOKEN_COOKIE = "yum";

/** [confirmed from capture] The SSO token response's key for that value. */
export const SSO_TOKEN_KEY = "yum";

/**
 * [confirmed from capture] The get-auth-code body, and where each field comes
 * from: the authorization URL the stub's controller call carries, read the way
 * the shell's authorize page reads its own query string. `guid` is not a fresh
 * id: it is the PKCE `code_challenge`, verbatim.
 */
export const AUTH_CODE_FIELDS = {
  clientId: "client_id",
  scope: "scope",
  responseType: "response_type",
  guid: "code_challenge",
  nonce: "nonce",
} as const;

/** [confirmed from capture] The get-auth-code response's one key. */
export const AUTH_CODE_KEY = "authCode";

/**
 * [confirmed from capture] The authorization URL's other two parameters the
 * browser uses: where to go with the code, and the `state` to go with it.
 */
export const AUTHORIZE_PARAMS = { redirectUri: "redirect_uri", state: "state" } as const;

/** [confirmed from capture] The query the browser sends the code back with. */
export const AUTHORIZE_RESULT_PARAMS = { code: "code", state: "state" } as const;

/**
 * [confirmed from capture] The classic side's finalize call, mount-relative. A
 * form-urlencoded XHR POST with a `noCache` query parameter and the
 * `AuthorizeResult` page's own antiforgery token as a header. It answers
 * `{ redirectUri }` and sets the classic session cookies.
 */
export const FINALIZE_PATH = "OpenId/FinalizeAuthResponse";

/**
 * [confirmed from capture] The finalize form, verbatim from the classic side's
 * response-controller script, which builds it from two places:
 *
 *  - the `AuthorizeResult` page's controller call, `(code, state, error,
 *    responseMode, issuer)` -- `AuthCode`, `StateFromOP`, `Error`,
 *    `ResponseMode`, `Issuer`, in that order;
 *  - the stub's controller call, `(nonce, state, codeVerifier, ...)`, which the
 *    request-controller script parked in `sessionStorage` -- `EncryptedNonce`,
 *    `EncryptedState`, `EncryptedCodeVerifier`.
 *
 * `Error` and `Issuer` were empty strings in the capture and are sent as such.
 */
export const FINALIZE_FIELDS = {
  authCode: "AuthCode",
  stateFromOp: "StateFromOP",
  encryptedNonce: "EncryptedNonce",
  encryptedState: "EncryptedState",
  encryptedCodeVerifier: "EncryptedCodeVerifier",
  error: "Error",
  responseMode: "ResponseMode",
  issuer: "Issuer",
} as const;

/** [confirmed from capture] The finalize response's one key. */
export const FINALIZE_REDIRECT_KEY = "redirectUri";

/**
 * A correction, recorded so it is not made a third time. An earlier version of
 * this file concluded that `api/mychartAuth/getAuthCode` belonged to an
 * unrelated mobile-app feature, and that navigating to the stub's own
 * authorization URL was the whole hand-off. The owner's capture of a successful
 * sign-in shows otherwise: that URL is the *shell's* authorize route, a page of
 * its single-page app rather than an authorization server, and loading it only
 * returns the app, whose component for that route calls `getAuthCode` and then
 * navigates to the `redirect_uri`. The bridge now makes that call itself; see
 * `bridge.ts`.
 */

/** [confirmed] The credential POST's fields. Lower-case, unlike the classic form. */
export const LOGIN_FIELDS = { username: "username", password: "password" } as const;

/**
 * [confirmed] The send-code body's channel key *is* the channel.
 *
 * Not a `Mode`/`DeliveryMethod` value: the key itself changes, so an email code
 * is `{ email: <contact> }` and an SMS code `{ phone: <contact> }`. None of the
 * classic `SEND_CODE_VARIANTS` guesses would ever have matched this.
 */
export const CHANNEL_KEYS = { email: "email", phone: "phone" } as const;

/** [confirmed] The remaining send-code fields. */
export const GENERATE_FIELDS = {
  userId: "userId",
  clientId: "clientId",
  portalHost: "portalHost",
  source: "source",
} as const;

/** [confirmed] What `source` is when the caller does not pick one. */
export const CODE_SOURCE = "OTHER";

/** [confirmed] The verify-code body: the code, and the same correlation id. */
export const VALIDATE_FIELDS = { token: "token", clientId: "clientId" } as const;

/**
 * [confirmed] The trust-this-device token is a **cookie**, named for the user.
 *
 * `<user id, lower-cased>` followed by this suffix. Written by the shell's own
 * script rather than by a `Set-Cookie`, so this client mints the token, saves it
 * with the shell, and puts it in the jar by hand. On the next sign-in it is
 * read back out of the jar and posted to `API_PATHS.validateTrustToken`.
 */
export const REMEMBER_ME_COOKIE_SUFFIX = "-rememberMeToken";

/**
 * Keys the login response carries.
 *
 * [confirmed from capture] `userId`, `isMfaEnabled` and `isPortalMfaEnabled`
 * are in the response, and the shell's login screen wants a code exactly when
 * **both** flags are true -- `mfaEnabled` and `portalMfaEnabled` below, ANDed,
 * as the bundle's own login component does. The response volunteers no contact.
 *
 * [assumption] everything else: `mfaRequiredFallback`, `signedIn` and
 * `contact` are older guesses, kept only so that a response which differs from
 * the captured one still degrades rather than throws. A login whose response
 * matches nothing is treated as "signed in" -- the bridge that runs next fails
 * loudly if that was wrong, where guessing "awaiting code" would leave the
 * owner waiting for an email nobody sent.
 */
export const LOGIN_RESPONSE_KEYS = {
  mfaEnabled: "isMfaEnabled",
  portalMfaEnabled: "isPortalMfaEnabled",
  mfaRequiredFallback: ["mfaRequired", "requiresMfa", "requireMfa", "twoFactorRequired"],
  signedIn: ["authenticated", "isAuthenticated", "success", "loggedIn"],
  userId: ["userId", "userID", "userid", "loginId", "id"],
  /** Where the code can be sent, when the response volunteers it. */
  contact: ["email", "emailAddress", "maskedEmail", "contact"],
} as const;

/**
 * [confirmed] The save-trust-token body's second field, read out of the
 * shell's own client code. `userId` (from `GENERATE_FIELDS`) is the other one.
 */
export const SAVE_TRUST_TOKEN_FIELDS = { rememberMeToken: "rememberMeToken" } as const;

/** [assumption] Keys the contact lookup may answer with. */
export const CONTACT_KEYS: readonly string[] = ["email", "emailAddress", "contact", "value"];

/**
 * [confirmed] Refusal wording, as the shortest fragment that still distinguishes.
 *
 * The shell's compiled bundle carries the full sentences; only the distinguishing
 * fragment is written down here, both because a deployment can reword the rest
 * and because a tracked file should carry no more of another application's text
 * than it needs. Lower-cased, and phrases rather than bare words, for the reasons
 * `../wire.ts` gives -- `"locked"` is inside `"unlocked"`.
 *
 * Which failure renders which of these was never observed on screen, so both
 * lists are matched against every refusal and the first hit wins.
 */
export const CUSTOM_MARKERS = {
  locked: ["temporarily locked", "allowed attempts"],
  badCredentials: ["not be successfully verified", "password is incorrect"],
} as const;

/**
 * Names the jar's `extras` carries the in-flight MFA attempt under.
 *
 * Not wire strings: these are this client's own keys, deliberately generic. They
 * exist because the emailed code is submitted in a *different Worker invocation*
 * by a brand-new client, and `clientId` has to be the same number on the generate
 * call and the validate call -- so the sealed jar is the only place it can live.
 */
export const JAR_EXTRAS = {
  userId: "oidc.userId",
  clientId: "oidc.clientId",
  contact: "oidc.contact",
} as const;
