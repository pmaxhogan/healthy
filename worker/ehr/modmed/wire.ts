/**
 * The ModMed patient portal's wire contract, in one place.
 *
 * Everything here was read out of the portal's own public JavaScript and the
 * pages it serves before anyone signs in, then confirmed against a signed-in
 * session. None of it names a practice: a practice is a hostname, and that is
 * configuration (`portal_accounts.base_url`), never source.
 *
 * Shape of the deployment, for orientation:
 *
 *  - Each practice is one host. `/patient-portal/` is an Angular app; its data
 *    comes from a JSON API under `/ema/ws/v3/`.
 *  - Sign-in is Keycloak (OpenID Connect, authorization-code flow, public
 *    client). Where Keycloak lives, which realm and which client are all read at
 *    runtime from the practice's own unauthenticated `auth/data/patient`
 *    document -- see `discovery.ts`.
 *  - That document also says `stateless: true`: the API wants
 *    `Authorization: Bearer <access token>` on every call and keeps no server
 *    session of its own. So "the session" is the token pair, which the client
 *    keeps in the cookie jar's sealed extras, plus Keycloak's own SSO cookies.
 */

/** The practice's unauthenticated sign-in configuration for patients. */
export const AUTH_DATA_PATH = "/ema/ws/v3/auth/data/patient";

/** Where the patient app is mounted. The OIDC redirect URI hangs off it. */
export const PORTAL_APP_PATH = "/patient-portal/";

/**
 * The redirect URI the portal's own app registers with Keycloak, byte for byte:
 * the app page plus its `initialLogin` marker. Keycloak validates it against the
 * client's registered list, so it has to be exactly what the app sends.
 */
export const REDIRECT_QUERY = "initialLogin";

/** Upcoming appointments. JSON array body; paging in the response headers. */
export const UPCOMING_PATH = "/ema/ws/v3/patientPortal/appointments/upcoming";

/** Past appointments, same contract as upcoming. */
export const PAST_PATH = "/ema/ws/v3/patientPortal/appointments/past";

/**
 * The `selector` the app sends with the upcoming list: which nested objects the
 * API should expand. Without it `facility` and `physician` come back as bare
 * references. Whitespace-free, exactly as the app sends it.
 */
export const UPCOMING_SELECTOR =
  "facility(name,timeZone,address(id,street1,street2,city,state,countryDisplayValue,zipcode,fullStreetAddress),mainPhone,workPhoneNumber,facilityPhoneNumbers),reason,physician(fullNameComplete)";

/** The past list's selector. The rows are visits, not appointments: see `visits.ts`. */
export const PAST_SELECTOR =
  "facility(name,timeZone,address(street1,street2,city,state,zipcode,fullStreetAddress),mainPhone)";

/**
 * Page size for the list calls. The app asks for 10 at a time; a larger page
 * is the same data in fewer requests, and the loop reads to the end either way.
 */
export const PAGE_SIZE = 50;

/** Request parameter names for paging (`paging.*`) and the response headers that answer. */
export const PAGING = {
  pageSizeParam: "paging.pageSize",
  pageNumberParam: "paging.pageNumber",
  countHeader: "count",
  pageSizeHeader: "pagesize",
  pageNumberHeader: "pagenumber",
} as const;

/**
 * Keycloak's login page, as this deployment themes it.
 *
 * The default form asks for name and date of birth and then emails a code; the
 * "Login with Username" button (a submit with this `submitAction`) swaps it for
 * a username/password form. Only the latter is driven: it is the one the owner
 * uses, and it asks for no code.
 */
export const LOGIN = {
  switchToUsernameField: "submitAction",
  switchToUsernameValue: "loginWithUsername",
  firmField: "firm",
  usernameField: "username",
  passwordField: "password",
} as const;

/**
 * Markers on a Keycloak page that mean "the credentials were not enough".
 *
 * A code field is a one-time-code challenge; this client never answers one
 * (the owner's login does not ask for it) and surfaces it as needing the owner.
 */
export const KEYCLOAK_MARKERS = {
  codeChallenge: [/name="code"/iu, /name="otp"/iu, /name="totp"/iu, /id="otpCode"/iu],
  locked: [/account is (?:temporarily )?(?:locked|disabled)/iu, /account.{0,40}disabled/iu],
  badCredentials: [/invalid (?:username|user name|credentials)/iu, /invalid.{0,30}password/iu],
} as const;

/** Refresh the access token when it has less than this many seconds to live. */
export const TOKEN_REFRESH_MARGIN_SECONDS = 60;

/** Jar extras: the token pair and when each half expires (unix seconds). */
export const TOKEN_EXTRAS = {
  accessToken: "modmed.access_token",
  accessExpiresAt: "modmed.access_expires_at",
  refreshToken: "modmed.refresh_token",
  refreshExpiresAt: "modmed.refresh_expires_at",
} as const;

/** Browser-shaped headers: the API is fronted by the same load balancer as the app. */
export const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
};

/** Redirects followed inside the sign-in. Keycloak's own chains are one or two hops. */
export const MAX_REDIRECTS = 8;
