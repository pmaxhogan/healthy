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
 *   [confirmed]  a live capture of a real deployment carried this exact string
 *   [documented] the research describes this exact string
 *   [convention] not in the research; it is the framework's own convention and
 *                the request almost certainly needs it
 *   [guess]      plausible shape, unverified -- live QA must confirm
 */

/** Which name the login form gives the username field. Varies by release. */
export type UsernameField = "LoginIdentifier" | "Username" | "Login";

/**
 * [confirmed] Order to prefer when a login page's markup could match more than
 * one name.
 *
 * `LoginIdentifier` is the newest shape and `Username` the classic MVC one;
 * both were already recognised. `Login` is a third, plainer name a live,
 * unauthenticated fetch of a real deployment's login page carried -- it is
 * tried last because a bare word like this is the one most likely to collide
 * with something unrelated on a page this list has not seen yet.
 */
export const USERNAME_FIELD_NAMES: readonly UsernameField[] = [
  "LoginIdentifier",
  "Username",
  "Login",
];

/**
 * Which login application a deployment puts in front of the classic pages.
 *
 * `classic` is the server-rendered form this file's `PATHS.doLogin` cycle drives.
 * `custom_oidc` is a deployment whose `Authentication/Login` is a redirect stub
 * into an OpenID Connect handoff: the credentials go to a separate single-page
 * shell's JSON API and the classic session arrives by way of the OIDC bridge.
 * `worker/providers/mychart/custom-oidc/**` is that second strategy; everything
 * past sign-in (the visits endpoints) is identical, which is the whole reason the
 * flavour is a field rather than a second adapter.
 */
export type PortalFlavor = "classic" | "custom_oidc";

/** Paths, relative to the instance's mount (no leading slash). */
export const PATHS = {
  /**
   * [confirmed] The login form, and the page an expired session bounces to.
   *
   * On a `custom_oidc` deployment this path exists but renders no form: it 302s
   * to `openId` below, which is exactly how the flavour is detected.
   */
  login: "Authentication/Login",
  /**
   * [confirmed] The OpenID Connect handoff stub a `custom_oidc` deployment's
   * `login` redirects to. Its query carries an opaque per-attempt operation id.
   */
  openId: "OpenId",
  /** [documented] The credential POST. */
  doLogin: "Authentication/Login/DoLogin",
  /** [documented] The challenge page; also where a fresh Validate token comes from. */
  secondaryValidation: "Authentication/SecondaryValidation",
  /**
   * [confirmed from capture] Asks the portal to send a code. An XHR, not a form
   * navigation: see `SEND_CODE_FORM`.
   */
  sendCode: "Authentication/SecondaryValidation/SendCode",
  /**
   * [confirmed from capture] Submits the code. An XHR answering JSON, not a
   * redirect: see `VALIDATE_FORM` and `VALIDATE_RESPONSE_KEYS`.
   */
  validate: "Authentication/SecondaryValidation/Validate",
  /**
   * [confirmed from capture] Where the page's own script navigates after a
   * successful `Validate`. It 302s through an intermediate hop to `Home`, and
   * each hop sets a cookie, so the chain is walked rather than skipped.
   */
  insideAsp: "inside.asp",
  /**
   * [confirmed from capture] Called by every signed-in page's own script to
   * reconcile the remembered-device id. See `RECONCILE_FORM`.
   */
  reconcileWebDevice: "Authentication/RememberDevices/ReconcileWebDevice",
  /** [confirmed] The upcoming-visits page, whose HTML carries the token. */
  visitsList: "Visits/VisitsList",
  /** [confirmed] The JSON endpoint. Takes NO body. */
  loadUpcoming: "Visits/VisitsList/LoadUpcoming",
  /**
   * [confirmed] Past visits, same auth mechanism and same "no body" rule as
   * `loadUpcoming`. Its JSON groups the rows by an opaque organisation token
   * because the account can be linked to several; see `parsePast`.
   */
  loadPast: "Visits/VisitsList/LoadPast",
  /**
   * [confirmed] The landing page, and the liveness check: a signed-in session is
   * served it without a redirect. `Home/KeepAlive` is deliberately not used for
   * that -- it keeps a session alive without saying whether anyone is signed in
   * to it, so an anonymous session can answer it too. See `isSessionAlive`.
   */
  home: "Home",
} as const;

/** Form field names. */
export const FIELDS = {
  /** [documented] */
  password: "Password",
  /** [confirmed from capture] */
  twoFactorCode: "TwoFactorCode",
  /**
   * [confirmed from capture] Always sent: `REMEMBER_ME_VALUE` when trusting the
   * device, `""` when not -- the page's script never omits it.
   */
  rememberMe: "RememberMe",
  /**
   * [confirmed] A hidden field a live login page carries, presumably flipped
   * by the page's own script before a real browser submits it. See
   * `JS_ENABLED_VALUE` for what it is set to.
   */
  jsEnabled: "jsenabled",
  /**
   * [confirmed from capture] The remembered-device id, on both `DoLogin` and
   * `Validate`. Empty until a `Validate` has issued one. See
   * `DEVICE_ID_EXTRA_KEY` for where this client keeps its copy.
   */
  deviceId: "DeviceId",
  /**
   * [confirmed] Echoed from the login page's own query string. Sent as `""`
   * when the page's URL carried none.
   */
  forMobile: "forMobile",
  /** [confirmed] Same rule as `forMobile`. */
  postLoginUrl: "postLoginUrl",
  /** [confirmed] Carries the base64'd credentials; see `LOGIN_INFO`. */
  loginInfo: "LoginInfo",
} as const;

/**
 * [confirmed] Where a live capture of a classic deployment's loginpagecontroller
 * script builds `LoginInfo` and appends it, plus `DeviceId` / `forMobile` /
 * `postLoginUrl`, onto the *other* form on the page before submitting it.
 *
 * The login page renders two forms: `#loginForm` (action `"#"`, holding
 * `jsenabled`, the username input and `Password`) is never submitted -- the
 * script only reads its fields. What actually gets posted is `#actualLogin`
 * (action ending in `DoLogin`), which in the captured markup carries nothing
 * but the antiforgery token; the script appends everything else at submit
 * time. `client.ts` calls this shape the "envelope": a `DoLogin`-actioned form
 * with no username or password field of its own.
 *
 * `LoginInfo` is `JSON.stringify`'d and sent as a single form value:
 * `{"Type":"StandardLogin","Credentials":{"LoginIdentifier":b64(username),
 * "Password":b64(password)}}`, where `b64` is base64 of the UTF-8 bytes (not
 * `btoa`, which mishandles anything outside Latin-1 -- see `base64Utf8` in
 * `worker/providers/adapter.ts`). The two credential keys are fixed regardless
 * of what the page's own (never-submitted) username field happens to be named.
 */
export const LOGIN_INFO = {
  typeKey: "Type",
  type: "StandardLogin",
  credentialsKey: "Credentials",
  identifierKey: "LoginIdentifier",
  passwordKey: "Password",
} as const;

/**
 * Where this client persists the remembered-device id between logins, in
 * `CookieJar.extras`.
 *
 * [confirmed from capture] The id is **issued by the portal**, not minted by
 * the browser: a first sign-in sends `DeviceId=""` on both `DoLogin` and
 * `Validate`, and `Validate`'s success JSON carries it back as
 * `RememberDeviceId`. The page's script keeps it in `localStorage` and sends it
 * on every later `DoLogin`, `Validate` and `ReconcileWebDevice`; `extras` is
 * this client's equivalent.
 *
 * Renamed from an earlier `classic.deviceId`, which held a random UUID this
 * client used to mint itself. The portal never issued that value, so it is
 * deliberately left unread rather than sent as though it had.
 */
export const DEVICE_ID_EXTRA_KEY = "classic.rememberDeviceId";

/** [confirmed from capture] What `RememberMe` is set to, as the page's script sends it. */
export const REMEMBER_ME_VALUE = "checked";

/**
 * [confirmed from capture] The query the challenge page is fetched with.
 *
 * The first GET of `SecondaryValidation` renders only a device-check stub whose
 * script navigates to itself with this query; the code-entry page -- the one
 * `SendCode` and `Validate` are posted from -- is the second. Fetching that one
 * directly is where a browser ends up.
 */
export const RAN_DEVICE_CHECK_QUERY = { ranDeviceCheck: "1" } as const;

/**
 * [assumption] What a JS-enabled browser sets `jsenabled` to before submitting
 * `DoLogin`.
 *
 * The field's presence is confirmed (a live, unauthenticated fetch carried it
 * as a hidden input); what a real browser's script writes into it before
 * submit is not -- that would need a captured submit body, not just a GET of
 * the form. `"1"` is the ordinary convention for this kind of boolean hidden
 * field. Live QA against a captured `DoLogin` request should confirm the exact
 * value and delete this note.
 */
export const JS_ENABLED_VALUE = "1";

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
 * [convention; confirmed from capture on `SendCode`, `Validate` and
 * `ReconcileWebDevice`] The header the token is repeated in on an AJAX POST.
 *
 * The JSON endpoints are called by the portal's own scripts, which send the
 * token as a header rather than a form field -- and they must, because
 * `LoadUpcoming` takes no body at all, so there is nowhere else to put it.
 */
export const ANTIFORGERY_HEADER = "__RequestVerificationToken";

/**
 * [confirmed] Query parameters `LoadUpcoming` is called with.
 *
 * `ComponentNumber=5` is opaque and is sent exactly as observed. `timeZone` and
 * `noCache` are filled in per call.
 */
export const LOAD_UPCOMING_QUERY = { ComponentNumber: "5" } as const;

/**
 * [confirmed] Query parameters `LoadPast` is called with.
 *
 * Query-string only, no body, exactly like `LoadUpcoming`. `oldestRenderedDate`
 * is filled in per call and is the paging boundary the page's own script sends.
 */
export const LOAD_PAST_QUERY = {
  loadpast: "1",
  searchString: "",
  ComponentNumber: "7",
} as const;

/** [confirmed] `LoadPast`'s paging boundary: an ISO date-time string. */
export const OLDEST_RENDERED_DATE_PARAM = "oldestRenderedDate";

/** [confirmed] The cache-buster every one of these endpoints carries. */
export const NO_CACHE_PARAM = "noCache";

/**
 * [confirmed from capture] The `SendCode` body, exactly as the page's own
 * script posts it when the owner picks "email".
 *
 * An XHR: form-urlencoded, the antiforgery token in `ANTIFORGERY_HEADER` (not
 * the body), `NO_CACHE_PARAM` on the URL, and a `{"Success":true}` JSON answer.
 * The delivery-method choice is client-side -- a button that picks which of
 * `deliveryMethodEmail` / `deliveryMethodSMS` is sent as `true` -- which is why
 * the earlier guessed variants (`Mode`, `DeliveryMethod`, ...) never matched.
 * Note the lower-case `workflow` here against `Validate`'s `Workflow`.
 */
export const SEND_CODE_FORM: Readonly<Record<string, string>> = {
  deliveryMethodEmail: "true",
  resendCode: "false",
  workflow: "1",
};

/**
 * [confirmed from capture] `Validate`'s body, less `TwoFactorCode`,
 * `RememberMe` and `DeviceId`, which are filled in per call.
 *
 * Same XHR shape as `SEND_CODE_FORM`. `Workflow` is the page's own context value
 * (`1` for sign-in, the same value `SendCode` sends); the three flags are what
 * the captured page's context resolved to for a sign-in with an emailed code.
 */
export const VALIDATE_FORM: Readonly<Record<string, string>> = {
  IsPostLogin2FA: "false",
  EnrollDeviceTrackingOnRemember: "false",
  Workflow: "1",
  isTOTP: "false",
};

/**
 * Keys in `Validate`'s JSON answer.
 *
 * [confirmed from capture] `Success` and `RememberDeviceId` on a success. The
 * two failure keys are what the page's own script reads on a refusal; a
 * refusal itself was not captured.
 */
export const VALIDATE_RESPONSE_KEYS = {
  success: "Success",
  rememberDeviceId: "RememberDeviceId",
  invalidCode: "InvalidTwoFactorCode",
  mustLogout: "MustLogout",
} as const;

/**
 * [confirmed from capture] `ReconcileWebDevice`'s body.
 *
 * Sent with the stored id and `skipSessionCheck=false`, same XHR shape as
 * `SEND_CODE_FORM`; answered with `{deviceId, forceUpdate}` (see
 * `RECONCILE_RESPONSE_KEYS`). The page's script replaces its stored id with the
 * answer's when `forceUpdate` is set or when it had none.
 */
export const RECONCILE_FORM = {
  deviceIdKey: "deviceId",
  skipSessionCheckKey: "skipSessionCheck",
  skipSessionCheck: "false",
} as const;

/** [confirmed from capture] See `RECONCILE_FORM`. */
export const RECONCILE_RESPONSE_KEYS = {
  deviceId: "deviceId",
  forceUpdate: "forceUpdate",
} as const;

/**
 * Keys carrying the visit's fields in the `LoadUpcoming` JSON.
 *
 * Every list is tried in order and the first present, non-empty value wins, so
 * an unexpected name degrades to a missing optional field rather than a parse
 * failure. The first entry of each list is the name a live capture confirmed;
 * the rest are the earlier [guess] candidates, kept as fallbacks because the
 * same vendor's deployments differ and a second organisation may still use one.
 *
 * `department` / `locationName` / `address` / `phone` are the exception and are
 * the correction the capture forced: on a real payload none of them is a flat
 * key at all. They live nested under `PrimaryDepartment`, so the flat lists
 * below are now only the fallback and `DEPARTMENT_OBJECT_KEYS` is the real path.
 */
export const VISIT_KEYS = {
  /** [confirmed] `Csn`. */
  csn: ["Csn", "CSN", "ContactSerialNumber", "EncounterCsn", "VisitCsn"],
  /** [confirmed] The `/Date(ms)/` instant. */
  instant: ["Instant", "DateTimeInstant", "AppointmentInstant", "StartInstant"],
  /** [confirmed] Clinic-local wall clock, used only when there is no instant. */
  primaryDate: ["PrimaryDate", "DisplayDate", "Date"],
  /** [confirmed] Top-level, and the visit's own zone rather than the owner's. */
  timeZone: ["TimeZone", "TimeZoneId", "DepartmentTimeZone"],
  /** [confirmed] Minutes, when the payload says how long the visit is. */
  durationMinutes: ["DurationInMinutes", "Duration", "LengthInMinutes", "AppointmentDuration"],
  /** [confirmed] `VisitTypeName`. */
  visitType: ["VisitTypeName", "VisitType", "AppointmentType", "Type", "Title"],
  /** [confirmed] `PrimaryProviderName`, nullable. */
  practitioner: ["PrimaryProviderName", "ProviderName", "Provider", "ProviderDisplayName"],
  /** [confirmed] A list of providers, when the payload has several. */
  practitioners: ["Providers", "ProviderList"],
  /** [guess] Flat fallback only -- see `DEPARTMENT_OBJECT_KEYS`. */
  department: ["DepartmentName", "Department", "ClinicName"],
  /** [guess] Flat fallback only. */
  locationName: ["LocationName", "Location", "FacilityName", "SiteName"],
  /** [guess] Flat fallback only. */
  address: ["Address", "DepartmentAddress", "LocationAddress", "FullAddress"],
  /** [guess] Flat fallback only. */
  phone: ["Phone", "PhoneNumber", "DepartmentPhone", "LocationPhone"],
} as const;

/**
 * [confirmed] Keys whose value is the visit's department as a nested object.
 *
 * `PrimaryDepartment` is where the department name, the address and the phone
 * number really live. `Department` appears in both this list and
 * `VISIT_KEYS.department`: a string value is read by the flat reader and an
 * object value by the nested one, so listing it twice is safe and costs nothing.
 */
export const DEPARTMENT_OBJECT_KEYS: readonly string[] = [
  "PrimaryDepartment",
  "Department",
  "DepartmentInfo",
];

/** Keys inside a department object. First entry of each list [confirmed]. */
export const DEPARTMENT_KEYS = {
  name: ["Name", "DepartmentName", "DisplayName"],
  /** Itself an object (or an array of lines) -- never a string. See `ADDRESS_KEYS`. */
  address: ["Address", "DiscreteAddress", "DepartmentAddress"],
  phone: ["PhoneNumber", "Phone", "DepartmentPhone"],
} as const;

/**
 * [guess] Keys inside a structured address.
 *
 * The capture proves the address is an object but not which of these it uses, so
 * this is deliberately tolerant: any subset may be present, an absent part is
 * simply left out of the joined line, and a plain string or an array of lines is
 * accepted as-is. The one nearby shape that *was* captured (an organisation's
 * `DiscreteAddress`) had `StreetAddress` / `City` / `State` / `StateName` / `Zip`,
 * which is why those lead.
 */
export const ADDRESS_KEYS = {
  /** A nested object holding the parts, preferred over the flat parts beside it. */
  discrete: ["DiscreteAddress", "StructuredAddress"],
  lines: [
    "StreetAddress",
    "Street",
    "Line1",
    "AddressLine",
    "Address",
    "Lines",
    "StreetAddressLines",
  ],
  city: ["City", "CityName"],
  state: ["State", "StateName", "StateAbbreviation"],
  postalCode: ["Zip", "ZipCode", "PostalCode"],
} as const;

/**
 * [guess] Keys whose truthiness means "this is a video visit".
 *
 * None of these was present on the captured payload, so on their own they are no
 * longer enough -- see `TELEMEDICINE_OBJECT_KEYS` and `TELEHEALTH_MODE_KEYS` for
 * what a real payload actually carries. Kept because a deployment that renders
 * one of them is cheap to keep supporting.
 */
export const VIDEO_KEYS: readonly string[] = [
  "IsVideoVisit",
  "IsTelemedicine",
  "IsVirtualVisit",
  "HasVideoVisit",
];

/**
 * [confirmed] Keys whose value is a telemedicine *object* when the visit is
 * video, and `null` when it is not. Presence, not truthiness, is the signal.
 */
export const TELEMEDICINE_OBJECT_KEYS: readonly string[] = ["Telemedicine"];

/**
 * [confirmed] Keys holding an enum-like number; anything above zero is video.
 *
 * `CanShowTelemedicine` sits next to these in the payload and is deliberately
 * *not* listed anywhere: it says the page may render a telemedicine section, not
 * that this visit is one, and reading it would mark every visit as a video call.
 */
export const TELEHEALTH_MODE_KEYS: readonly string[] = ["TelehealthMode"];

/** [confirmed] The three buckets `LoadUpcoming` answers with. */
export const VISIT_BUCKETS: readonly string[] = [
  "InProgressVisits",
  "NextNDaysVisits",
  "LaterVisitsList",
];

/**
 * [confirmed] `LoadPast` groups its rows one level deeper than `LoadUpcoming`.
 *
 * The outer key holds an object keyed by an opaque per-organisation token, and
 * each of those has its own array under the inner key. The tokens are not
 * written down anywhere: they are read from whatever the response happens to
 * carry, because they identify the organisations the account is linked to.
 */
export const PAST_BUCKET = { outer: "List", inner: "List" } as const;

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
 * [documented order, names confirmed where marked] Status, highest priority first.
 *
 * The *order* is documented and load-bearing: the research says the booleans
 * are set in combinations that contradict each other (and that `IsPastVisit` is
 * simply always wrong), so a visit is whatever its highest-priority true flag
 * says and nothing else. A name that is absent is read as false rather than as a
 * parse failure, which is why every list keeps its earlier guesses -- both
 * British and American spellings of "cancelled" among them.
 *
 * Two of the guessed names were simply wrong and the capture supplied the real
 * ones: `LeftWithoutSeen` (not `IsLeftWithoutBeingSeen`) and `IsCancelRequestSent`
 * (not `IsCancelRequested`). Both now lead their list.
 *
 * `completed` has no confirmed name: the captured payload had no top-level
 * completion flag at all. The nested `ECheckIn.IsComplete` is a different concept
 * -- whether the check-in questionnaire was finished -- and is deliberately not
 * matched, which is why only top-level keys are read.
 */
export const STATUS_PRIORITY: readonly { status: PortalVisitStatus; keys: readonly string[] }[] = [
  /** [confirmed] `IsCanceled`. */
  { status: "canceled", keys: ["IsCanceled", "IsCancelled", "Canceled", "Cancelled"] },
  /** [confirmed] `IsNoShow`. */
  { status: "no_show", keys: ["IsNoShow", "NoShow"] },
  /** [confirmed] `LeftWithoutSeen`. */
  {
    status: "left_without_being_seen",
    keys: ["LeftWithoutSeen", "IsLeftWithoutBeingSeen", "LeftWithoutBeingSeen", "IsLwbs"],
  },
  /** [confirmed] `InProgress`. */
  { status: "in_progress", keys: ["InProgress", "IsInProgress"] },
  /** [confirmed] `IsArrived`. */
  { status: "arrived", keys: ["IsArrived", "Arrived", "HasArrived"] },
  /** [guess] No confirmed name; see the note above. */
  { status: "completed", keys: ["IsCompleted", "Completed"] },
  /** [confirmed] `IsCancelRequestSent`. */
  {
    status: "cancel_requested",
    keys: [
      "IsCancelRequestSent",
      "IsCancelRequested",
      "CancelRequested",
      "IsCancellationRequested",
    ],
  },
  /** [confirmed] `IsConfirmed`. */
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
    'name="login"',
    "name='login'",
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
   * [confirmed] The page is the OpenID Connect handoff stub, not a login form.
   *
   * A `custom_oidc` deployment's `Authentication/Login` renders no form and none
   * of `loginForm`'s markers, so without this a bounced authenticated call would
   * read as *signed in* and the run would report an empty day. The strings are
   * the stub's own controller script and the two `sessionStorage` keys it writes;
   * `oidcform` is the form the same script auto-submits.
   */
  openIdHandoff: [
    "openidrequestcontroller",
    "oidccodeverifier",
    "oidcnonce",
    'id="oidcform"',
    "id='oidcform'",
  ],
  /**
   * The page asking the owner to choose a delivery channel (email or
   * phone/text) before any code has been sent -- a landing `landingOf` has to
   * recognise as `awaiting_code` exactly as it does the code-entry page,
   * because it is not under `PATHS.secondaryValidation` on every deployment
   * and carries none of `MARKERS.secondaryValidation`'s markers either.
   *
   * [guess] No captured markup for this page: on the captured deployment the
   * choice is script-built on the challenge page itself (see `SEND_CODE_FORM`),
   * which is recognised by its path. Kept for a deployment that renders the
   * choice server-side.
   */
  deliveryMethodChoice: [
    'name="deliverymethod"',
    "name='deliverymethod'",
    'name="selecteddeliverymethod"',
    "name='selecteddeliverymethod'",
    "how would you like to receive",
    "choose how to receive your code",
  ],
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
   * The portal is asking for a captcha before it will accept another attempt.
   *
   * [guess] A live, unauthenticated fetch of a real deployment's login page
   * carried a conditionally-rendered captcha container and a `captchaRequired`
   * flag alongside the ordinary form fields, but not a capture of either one
   * actually toggled on -- so what a *triggered* response looks like is
   * unconfirmed. Matched as distinctive attribute/key pairs, never the bare
   * word "captcha", for the same reason `MARKERS.challenge` avoids it: a login
   * page can load a captcha script and render nothing live (see
   * `LOGIN_PAGE_WITH_INNOCENT_MARKERS`) without ever being a real challenge.
   * Live QA against a captured challenge should replace these with the exact
   * shape and delete this note.
   */
  captchaRequired: [
    'id="captchacontainer"',
    "id='captchacontainer'",
    '"captcharequired":true',
    "captcharequired: true",
  ],
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
