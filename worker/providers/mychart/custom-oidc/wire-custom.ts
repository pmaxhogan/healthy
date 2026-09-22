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
   * [confirmed] name, [assumption] verb and response.
   *
   * Assumed to be a POST that answers with the trust-this-device token as JSON.
   * If it is a GET, or answers with nothing, `rememberMe` silently stops working
   * and every scheduled run asks for a fresh emailed code -- which shows up as a
   * `portal.code_requested` line on every single sign-in.
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
   * [confirmed] name, [assumption] verb and response.
   *
   * The shell's own way of asking for the authorization code that bridges its
   * session into the classic pages. Assumed to be a GET answering with JSON
   * carrying the URL to go to next (see `AUTH_CODE_URL_KEYS`). Only used when the
   * handoff stub carried no auto-submitted form, so a wrong guess shows up as
   * `portal_login_failed` with a hop count and nothing else.
   */
  authCode: "api/mychartAuth/getAuthCode",
} as const;

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
 * script rather than by a `Set-Cookie`, which is why validating a code is not
 * enough on its own: the token has to be fetched and put in the jar by hand.
 */
export const REMEMBER_ME_COOKIE_SUFFIX = "-rememberMeToken";

/**
 * [assumption] Keys the login response may carry, tried in order.
 *
 * The capture read the *request* shapes out of the shell's bundle but not the
 * responses, so this whole map is a guess. It is written to degrade rather than
 * throw: a login whose response matches none of `mfaRequired` is treated as
 * "signed in", which is the safe direction -- the OIDC bridge that runs next
 * fails loudly if that was wrong, where guessing "awaiting code" would leave the
 * owner waiting for an email nobody sent.
 *
 * If `userId` matches nothing, the emailed-code path cannot run at all and
 * surfaces as `portal_login_failed` with `reason: "user_id_unknown"`. That is the
 * single most likely thing in this file to be wrong.
 */
export const LOGIN_RESPONSE_KEYS = {
  mfaRequired: [
    "mfaRequired",
    "requiresMfa",
    "requireMfa",
    "twoFactorRequired",
    "needsMfa",
    "mfaEnabled",
  ],
  signedIn: ["authenticated", "isAuthenticated", "success", "loggedIn"],
  userId: ["userId", "userID", "userid", "loginId", "id"],
  /** Where the code can be sent, when the response volunteers it. */
  contact: ["email", "emailAddress", "maskedEmail", "contact"],
} as const;

/** [assumption] Keys the trust-token response may carry the token under. */
export const TRUST_TOKEN_KEYS: readonly string[] = ["token", "trustToken", "value", "deviceToken"];

/** [assumption] Keys the contact lookup may answer with. */
export const CONTACT_KEYS: readonly string[] = ["email", "emailAddress", "contact", "value"];

/** [assumption] Keys the auth-code response may carry the next URL under. */
export const AUTH_CODE_URL_KEYS: readonly string[] = [
  "url",
  "redirectUrl",
  "redirectUri",
  "location",
  "authorizeUrl",
];

/**
 * [confirmed] The id of the form the handoff stub's script auto-submits.
 *
 * That form *is* the authorization request: the server minted the nonce, the
 * state and the PKCE code challenge and embedded them as hidden fields, so the
 * bridge submits the form rather than generating a verifier of its own.
 * [assumption] that the challenge really is server-minted every time -- a
 * deployment that expected the client to mint one would answer the authorize hop
 * with an invalid-request page, and the bridge would report
 * `portal_login_failed`.
 */
export const OIDC_FORM_IDS: readonly string[] = ["OIDCForm"];

/**
 * [assumption] Lower-cased markers saying a bridge hop landed on the shell's own
 * login screen, which means the app-level session was not accepted after all.
 *
 * Path fragments rather than words: the shell is a single-page app, so its login
 * screen is a route, and matching a phrase like "sign in" would fire on every
 * page it serves.
 */
export const SHELL_LOGIN_MARKERS: readonly string[] = ["/login", "/signin", "/sign-in"];

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

/**
 * How many hops the OIDC bridge follows before giving up.
 *
 * A real chain is three or four -- the stub, the authorize hop, the callback, the
 * mount's return path -- and each of those may redirect once or twice more inside
 * `portalFetch`. Eight is generous and still bounded.
 */
export const BRIDGE_MAX_HOPS = 8;
