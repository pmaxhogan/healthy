/**
 * Every wire-level string the portal scrape depends on, in one file.
 *
 * This exists so that "what we guessed" and "what we verified" are one edit
 * apart. The portal is not an API: there is no contract, no version header and
 * no schema, and the same vendor's deployments differ from each other. The
 * research these names came from is documentation of endpoints recovered by
 * testing against other deployments, not a specification -- so every constant
 * below is a hypothesis until a live sign-in proves it, and each one is
 * annotated with how confident we are.
 *
 * Rules for this file:
 *  - no host, no organisation, no mount that names one. Mounts are generic
 *    prefixes only; a vanity mount is discovered at runtime.
 *  - strings only. No logic, so a live-QA fix never has to read code.
 *  - where a name varies per deployment, list the variants in the order to try.
 *
 * CONFIDENCE KEY
 *   [documented] the research describes this exact string
 *   [convention] not in the research; it is the framework's own convention and
 *                the request almost certainly needs it
 *   [guess]      plausible shape, unverified -- live QA must confirm
 */

/** Which name the login form gives the username field. Varies by release. */
export type UsernameField = "LoginIdentifier" | "Username";

/** Paths, relative to the instance's mount (no leading slash). */
export const PATHS = {
  /** [documented] The login form, and the page an expired session bounces to. */
  login: "Authentication/Login",
  /** [documented] The credential POST. */
  doLogin: "Authentication/Login/DoLogin",
  /** [documented] The challenge page; also where a fresh Validate token comes from. */
  secondaryValidation: "Authentication/SecondaryValidation",
  /** [documented] Asks the portal to send a code. */
  sendCode: "Authentication/SecondaryValidation/SendCode",
  /** [documented] Submits the code. */
  validate: "Authentication/SecondaryValidation/Validate",
  /** [documented] The upcoming-visits page, whose HTML carries the token. */
  visitsList: "Visits/VisitsList",
  /** [documented] The JSON endpoint. Takes NO body. */
  loadUpcoming: "Visits/VisitsList/LoadUpcoming",
  /**
   * [guess] The cheapest authenticated page, used only to ask "is the session
   * still alive". Anything behind the login wall would do; this is the landing
   * page every deployment in the research has.
   */
  home: "Home",
} as const;

/** Form field names. */
export const FIELDS = {
  /** [documented] */
  password: "Password",
  /** [documented] */
  twoFactorCode: "TwoFactorCode",
  /** [documented] Sent as the literal string below, not "true". */
  rememberMe: "RememberMe",
} as const;

/** [documented] What `RememberMe` is set to, as an HTML checkbox would send it. */
export const REMEMBER_ME_VALUE = "checked";

/**
 * [convention] Hidden-input names that hold the antiforgery token.
 *
 * The real name is read out of the login page's own HTML; this list is only the
 * fallback used when the page does not look like either shape, and the order is
 * the order to prefer. `__RequestVerificationToken` is the framework default.
 */
export const ANTIFORGERY_FIELD_NAMES: readonly string[] = [
  "__RequestVerificationToken",
  "__AntiForgeryToken",
];

/**
 * [convention] The header the token is repeated in on an AJAX POST.
 *
 * The JSON endpoints are called by the portal's own scripts, which send the
 * token as a header rather than a form field -- and they must, because
 * `LoadUpcoming` takes no body at all, so there is nowhere else to put it.
 */
export const ANTIFORGERY_HEADER = "__RequestVerificationToken";

/**
 * [documented] Query parameters `LoadUpcoming` is called with.
 *
 * `ComponentNumber=5` is opaque and is sent exactly as observed. `timeZone` and
 * `noCache` are filled in per call.
 */
export const LOAD_UPCOMING_QUERY = { ComponentNumber: "5" } as const;

/** [documented] The cache-buster every one of these endpoints carries. */
export const NO_CACHE_PARAM = "noCache";

/**
 * [documented, names guessed] `SendCode` parameter variants, tried in order.
 *
 * The research says the parameter names vary per deployment and that a scraper
 * has to try them in sequence; it does not say what they are. These are the
 * shapes an ASP.NET MVC action of this kind takes. **The whole list is a guess**
 * -- the one thing live QA should capture from a real browser session is the
 * body this POST actually carries, and then this array becomes one entry.
 */
export const SEND_CODE_VARIANTS: readonly Record<string, string>[] = [
  { Mode: "Email" },
  { DeliveryMethod: "Email" },
  { Method: "Email" },
  { SendMode: "Email" },
  {},
];

/**
 * [guess] Keys carrying the visit's fields in the `LoadUpcoming` JSON.
 *
 * The research names the *contents* (CSN, a `/Date(ms)/` instant, `PrimaryDate`
 * plus `TimeZone`, visit type, provider, department) but not the keys, except
 * `IsPastVisit`. Every list below is tried in order and the first present,
 * non-empty value wins, so an unexpected name degrades to a missing optional
 * field rather than a parse failure.
 */
export const VISIT_KEYS = {
  csn: ["CSN", "Csn", "ContactSerialNumber", "EncounterCsn", "VisitCsn"],
  /** The `/Date(ms)/` instant. */
  instant: ["Instant", "DateTimeInstant", "AppointmentInstant", "StartInstant"],
  /** Clinic-local wall clock, used only when there is no instant. */
  primaryDate: ["PrimaryDate", "DisplayDate", "Date"],
  timeZone: ["TimeZone", "TimeZoneId", "DepartmentTimeZone"],
  /** Minutes, when the payload says how long the visit is. */
  durationMinutes: ["DurationInMinutes", "Duration", "LengthInMinutes", "AppointmentDuration"],
  visitType: ["VisitType", "AppointmentType", "VisitTypeName", "Type", "Title"],
  practitioner: ["ProviderName", "Provider", "PrimaryProviderName", "ProviderDisplayName"],
  /** A list of providers, when the payload has several. */
  practitioners: ["Providers", "ProviderList"],
  department: ["DepartmentName", "Department", "ClinicName"],
  locationName: ["LocationName", "Location", "FacilityName", "SiteName"],
  address: ["Address", "DepartmentAddress", "LocationAddress", "FullAddress"],
  phone: ["Phone", "PhoneNumber", "DepartmentPhone", "LocationPhone"],
} as const;

/** [guess] Keys whose truthiness means "this is a video visit". */
export const VIDEO_KEYS: readonly string[] = [
  "IsVideoVisit",
  "IsTelemedicine",
  "IsVirtualVisit",
  "HasVideoVisit",
];

/** [documented] The three buckets `LoadUpcoming` answers with. */
export const VISIT_BUCKETS: readonly string[] = [
  "InProgressVisits",
  "NextNDaysVisits",
  "LaterVisitsList",
];

/** A visit's derived status. `scheduled` is the floor: something is always true. */
export type PortalVisitStatus =
  | "canceled"
  | "no_show"
  | "left_without_being_seen"
  | "in_progress"
  | "arrived"
  | "completed"
  | "cancel_requested"
  | "confirmed"
  | "scheduled";

/**
 * [documented order, guessed names] Status, highest priority first.
 *
 * The *order* is documented and load-bearing: the research says the booleans
 * are set in combinations that contradict each other (and that `IsPastVisit` is
 * simply always wrong), so a visit is whatever its highest-priority true flag
 * says and nothing else. The *names* are guesses -- both British and American
 * spellings of "cancelled" are listed because the payload could use either, and
 * a name that is absent is read as false rather than as a parse failure.
 */
export const STATUS_PRIORITY: readonly { status: PortalVisitStatus; keys: readonly string[] }[] = [
  { status: "canceled", keys: ["IsCanceled", "IsCancelled", "Canceled", "Cancelled"] },
  { status: "no_show", keys: ["IsNoShow", "NoShow"] },
  {
    status: "left_without_being_seen",
    keys: ["IsLeftWithoutBeingSeen", "LeftWithoutBeingSeen", "IsLwbs"],
  },
  { status: "in_progress", keys: ["IsInProgress", "InProgress"] },
  { status: "arrived", keys: ["IsArrived", "Arrived", "HasArrived"] },
  { status: "completed", keys: ["IsCompleted", "Completed", "IsComplete"] },
  {
    status: "cancel_requested",
    keys: ["IsCancelRequested", "CancelRequested", "IsCancellationRequested"],
  },
  { status: "confirmed", keys: ["IsConfirmed", "Confirmed"] },
];

/**
 * Lower-cased markers matched against a response body.
 *
 * All [guess]. They are read-only decisions about *which* stable error code to
 * report; no marker ever reaches a log line or an error message, and the body
 * they were matched against is dropped immediately.
 */
export const MARKERS = {
  /**
   * The page is the login form, so an authenticated call was bounced to it.
   *
   * The form's own action and its two possible username fields -- not a bare
   * password input. A signed-in chart page can carry a change-password form, and
   * matching `name="password"` would make every authenticated call read as an
   * expired session.
   */
  loginForm: [
    "authentication/login/dologin",
    'name="loginidentifier"',
    "name='loginidentifier'",
    'name="username"',
    "name='username'",
  ],
  /**
   * The page is the two-step challenge: signed in as far as the password goes.
   *
   * The challenge form's action rather than the bare word, because a signed-in
   * page with a link to the two-step *settings* would otherwise make every
   * authenticated call look like a pending code.
   */
  secondaryValidation: ["secondaryvalidation/validate", "twofactorcode"],
  /**
   * The request was refused, used only to decide whether a `SendCode` variant
   * was accepted. `"try again"` is deliberately absent: a *successful* response
   * that says "didn't get it? try again in 60 seconds" would otherwise be read
   * as a refusal and send the owner five emails.
   */
  badCredentials: ["incorrect", "not recognized", "not recognised", "invalid username"],
  /**
   * The account is locked or deactivated: stop trying.
   *
   * Phrases, never bare words. `"locked"` is inside `"unlocked"`, and
   * `"disabled"` is an HTML attribute on nearly every re-rendered form -- either
   * one as a substring would turn an ordinary wrong password into
   * `portal_locked`, which by design stops the retry loop for the day.
   */
  locked: [
    "account has been locked",
    "account is locked",
    "temporarily locked",
    "has been disabled",
    "has been deactivated",
    "too many",
  ],
  /** The emailed code was wrong or stale. */
  badCode: ["code you entered", "invalid code", "incorrect code", "expired"],
  /**
   * A WAF or bot wall answered instead of the application.
   *
   * Distinctive phrases only. `"captcha"` is absent on purpose: a login page can
   * carry a reCAPTCHA script tag while showing no challenge at all, and matching
   * it would abandon discovery before a single mount had been tried.
   */
  challenge: ["are you a human", "unusual traffic", "request blocked", "cf-browser-verification"],
} as const;

/**
 * Request headers every portal call carries.
 *
 * [convention] A plausible browser User-Agent is deliberate: the research
 * found the bot protection on these endpoints to be request-shape fingerprinting
 * rather than a JS challenge, and an HTTP client's default UA is the most
 * obvious shape there is. The version is pinned rather than generated so the
 * fingerprint does not change between deployments of this Worker.
 */
export const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  "upgrade-insecure-requests": "1",
};

/** [convention] `Accept` for a page fetch. */
export const ACCEPT_HTML =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

/** [convention] `Accept` for the JSON endpoints, as jQuery's ajax() sends it. */
export const ACCEPT_JSON = "application/json, text/javascript, */*; q=0.01";

/** [convention] What marks a request as the page's own XHR rather than a navigation. */
export const XHR_HEADER = { "x-requested-with": "XMLHttpRequest" } as const;

/**
 * Mount prefixes to probe, in order, when the owner gives no hint.
 *
 * Deployments mount the application under a vanity prefix, under a generic one,
 * or at the root. Only generic prefixes are listed: a prefix that names an
 * organisation is personal data and is discovered from a redirect at runtime
 * instead of being written down here.
 */
export const CANDIDATE_MOUNTS: readonly string[] = ["/MyChart/", "/", "/prd/"];

/** How many redirects (header, script or meta) one request will follow. */
export const MAX_REDIRECTS = 10;
