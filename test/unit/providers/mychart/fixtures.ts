// Synthetic portal pages and a scripted `fetch` for the portal unit tests.
//
// Everything in this file was written by hand for these tests. No markup, JSON,
// host, mount, organisation name, practitioner name or identifier here came from
// a real patient portal, and none may: the login pages are the minimum markup
// that exercises the two field-name shapes, and the visit payloads are invented
// numbers around invented places.
//
// The fetch stub is deliberately *not* `test/unit/providers/fixtures.ts`'s
// `stubFetch`: that one normalises a missing body to `""`, and the single most
// important assertion in this suite is that an empty POST really does carry
// `body: undefined` and no `Content-Type` -- a distinction `""` erases.

/** A made-up host. Never a real portal. */
export const HOST = "https://portal.example-portal.test";
/** A made-up vanity alias that redirects to `HOST`. */
export const ALIAS = "https://alias.example-portal.test";
export const MOUNT = "/MyChart/";
export const TOKEN = "synthetic-antiforgery-token-0001";
/** A second token, so a test can prove a fresh one was fetched per POST. */
export const TOKEN_2 = "synthetic-antiforgery-token-0002";
/** An IANA zone that is not the owner's. Fixed so offsets are deterministic. */
export const CLINIC_ZONE = "America/Denver";

export interface PortalCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /**
   * `init.body` exactly as it was passed. Never normalised: `undefined` (no body
   * at all) and `""` (an empty string body, which makes the runtime add
   * `Content-Type: text/plain`) are different requests and the WAF rule this
   * client works around is the reason.
   */
  body: string | undefined;
  redirect: string | undefined;
}

export interface PortalFetchStub {
  fetchImpl: typeof fetch;
  calls: PortalCall[];
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** A `fetch` that records every call verbatim and answers from `handler`. */
export function stubPortal(
  handler: (call: PortalCall, index: number) => Response | Promise<Response>,
): PortalFetchStub {
  const calls: PortalCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: PortalCall = {
      url: urlOf(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers ?? {})),
      body: typeof init?.body === "string" ? init.body : undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

/** Answer a route table keyed by "METHOD path", falling through to a 404. */
export function routed(routes: Record<string, () => Response>): PortalFetchStub {
  return stubPortal((call) => {
    const path = new URL(call.url).pathname;
    const handler = routes[`${call.method} ${path}`];
    return handler === undefined ? new Response("not found", { status: 404 }) : handler();
  });
}

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers ?? {});
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers ?? {});
  headers.set("content-type", "application/json");
  return Response.json(body, { ...init, headers });
}

/** A 302, optionally planting cookies on the hop -- which is where they arrive. */
export function redirect(
  location: string,
  cookies: readonly string[] = [],
  status = 302,
): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status, headers });
}

/** The newer login form: the username field is `LoginIdentifier`. */
export function loginPageNew(token = TOKEN): string {
  return `<!doctype html><html><body>
    <form action="/MyChart/Authentication/Login/DoLogin" method="post">
      <input type="hidden" name="__RequestVerificationToken" value="${token}" />
      <input type="hidden" name="Redirect" value="/MyChart/Home" />
      <input type="text" name="LoginIdentifier" value="" />
      <input type="password" name="Password" value="" />
      <button type="submit">Sign in</button>
    </form>
  </body></html>`;
}

/** The older login form: the username field is `Username`. */
export function loginPageOld(token = TOKEN): string {
  return `<!doctype html><html><body>
    <form action="/MyChart/Authentication/Login/DoLogin" method="post">
      <input type="hidden" name="__RequestVerificationToken" value="${token}" />
      <input type="text" name="Username" value="" />
      <input type="password" name="Password" value="" />
    </form>
  </body></html>`;
}

/**
 * A third login form shape: the username field is the plain `Login`, and the
 * page also carries the `jsenabled` hidden field a JS-enabled browser's own
 * script is presumed to flip before submit.
 *
 * `jsenabled` starts at `"0"`, the shape a script-toggled hidden field would
 * have before the toggle runs, so a test can tell "echoed as found" apart from
 * "the client set it".
 */
export function loginPageWithLoginField(token = TOKEN): string {
  return `<!doctype html><html><body>
    <form action="/MyChart/Authentication/Login/DoLogin" method="post">
      <input type="hidden" name="__RequestVerificationToken" value="${token}" />
      <input type="hidden" name="jsenabled" value="0" />
      <input type="text" name="Login" value="" />
      <input type="password" name="Password" value="" />
      <input type="submit" name="submit" value="Sign In" />
    </form>
  </body></html>`;
}

/**
 * The same page re-rendered with a captcha challenge: the container id and the
 * flag `MARKERS.captchaRequired` looks for, both synthetic.
 */
export const LOGIN_PAGE_CAPTCHA_REQUIRED = `<!doctype html><html><body>
  <div id="CaptchaContainer">"captchaRequired":true</div>
  <form action="/MyChart/Authentication/Login/DoLogin" method="post">
    <input type="hidden" name="__RequestVerificationToken" value="${TOKEN}" />
    <input type="hidden" name="jsenabled" value="0" />
    <input type="text" name="Login" value="" />
    <input type="password" name="Password" value="" />
  </form>
</body></html>`;

/**
 * A login form whose token is entity-encoded, as a template engine emits one.
 *
 * `&#x2B;` is a `+`: base64 tokens contain them, and a token echoed back still
 * escaped is rejected in a way that looks exactly like a wrong password.
 */
export const LOGIN_PAGE_ENCODED_TOKEN = `<!doctype html><html><body>
  <form action="/MyChart/Authentication/Login/DoLogin" method="post">
    <input type="hidden" name="__RequestVerificationToken" value="aa&#x2B;bb&amp;cc" />
    <input type="text" name="LoginIdentifier" value="" />
    <input type="password" name="Password" value="" />
  </form>
</body></html>`;

/**
 * A login page that carries the two things that most look like trouble and are
 * not: a reCAPTCHA script tag (present on plenty of login pages that never show
 * a challenge) and a `disabled` attribute (present on nearly every form). A
 * marker list that matched either as a substring would abandon discovery, or
 * report a locked account, on a page that is simply a login form.
 */
export const LOGIN_PAGE_WITH_INNOCENT_MARKERS = `<!doctype html><html><head>
  <script src="https://www.example-captcha.test/recaptcha/api.js"></script>
</head><body>
  <form action="/MyChart/Authentication/Login/DoLogin" method="post">
    <input type="hidden" name="__RequestVerificationToken" value="${TOKEN}" />
    <input type="text" name="LoginIdentifier" value="" />
    <input type="password" name="Password" value="" />
    <div class="g-recaptcha" data-sitekey="synthetic"></div>
    <button type="submit" disabled>Sign in</button>
  </form>
</body></html>`;

/** The same page re-rendered after a wrong password. Still not a locked account. */
export const LOGIN_REJECTED_WITH_INNOCENT_MARKERS = LOGIN_PAGE_WITH_INNOCENT_MARKERS.replace(
  "<body>",
  `<body><p class="error">The information you entered is incorrect. Please try again.</p>`,
);

/**
 * A signed-in page that mentions the two-step settings and carries a
 * change-password form -- neither of which means the session is gone.
 */
export const HOME_PAGE_WITH_INNOCENT_MARKERS = `<!doctype html><html><body>
  <h1>Your chart</h1>
  <nav><a href="/MyChart/Profile/SecondaryValidation">Two-step verification</a></nav>
  <form action="/MyChart/Profile/ChangePassword" method="post">
    <input type="password" name="Password" value="" />
    <button type="submit" disabled>Change</button>
  </form>
</body></html>`;

/**
 * A page that redirects with a script rather than a header.
 *
 * Parameterised on the target because the origin is what decides whether it is
 * followed at all: a body-level redirect is content the page chose, so
 * `portalFetch` follows it only within the same origin.
 */
export function scriptRedirectPage(target: string): string {
  return `<!doctype html><html><head><script>
  window.location.href = "${target}";
</script></head><body>Redirecting</body></html>`;
}

/** The same, as a meta refresh. */
export function metaRedirectPage(target: string): string {
  return `<!doctype html><html><head>
  <meta http-equiv="refresh" content="0;url=${target}" />
</head><body>Redirecting</body></html>`;
}

/** A page that is not a login form at all: a marketing landing page. */
export const NOT_A_LOGIN_PAGE = `<!doctype html><html><body>
  <h1>Welcome</h1><p>Please use the patient app.</p>
</body></html>`;

/** A bot wall's answer. */
export const CHALLENGE_PAGE = `<!doctype html><html><body>
  <h1>Request blocked</h1><p>Please complete the captcha.</p>
</body></html>`;

/** The two-step challenge page. */
export function twoFactorPage(token = TOKEN_2): string {
  return `<!doctype html><html><body>
    <form action="/MyChart/Authentication/SecondaryValidation/Validate" method="post">
      <input type="hidden" name="__RequestVerificationToken" value="${token}" />
      <input type="text" name="TwoFactorCode" value="" />
      <input type="checkbox" name="RememberMe" />
    </form>
  </body></html>`;
}

/**
 * The challenge page as a classic deployment really serves it: no form at all.
 *
 * Mirrors the captured structure only -- a lone antiforgery input, the page
 * context's `Workflow` value and the controller script that builds the UI. No
 * `TwoFactorCode` input and no `Validate` action anywhere: the page is recognised
 * by its path, and its XHRs carry the token in a header.
 */
export function codeEntryPage(token = TOKEN_2): string {
  return `<!doctype html><html><body>
    <input type="hidden" name="__RequestVerificationToken" value="${token}" />
    <div id="main"></div>
    <script src="/MyChart/areas/authentication/scripts/controllers/secondaryvalidationcontroller.min.js"></script>
    <script>var context = { Workflow: 1 };</script>
  </body></html>`;
}

/** The login form re-rendered with a rejection message. */
export const LOGIN_REJECTED_PAGE = `<!doctype html><html><body>
  <p class="error">The information you entered is incorrect.</p>
  <form action="/MyChart/Authentication/Login/DoLogin" method="post">
    <input type="hidden" name="__RequestVerificationToken" value="${TOKEN}" />
    <input type="text" name="LoginIdentifier" value="" />
    <input type="password" name="Password" value="" />
  </form>
</body></html>`;

/** The login form re-rendered because the account is locked. */
export const LOGIN_LOCKED_PAGE = `<!doctype html><html><body>
  <p class="error">This account has been locked.</p>
  <form action="/MyChart/Authentication/Login/DoLogin" method="post">
    <input type="hidden" name="__RequestVerificationToken" value="${TOKEN}" />
    <input type="text" name="LoginIdentifier" value="" />
    <input type="password" name="Password" value="" />
  </form>
</body></html>`;

/**
 * The classic login page's real, two-form shape: `#loginForm` (action `"#"`,
 * never submitted) holds the fields a browser's script reads, and `#actualLogin`
 * (the form actually posted) carries nothing but the antiforgery token -- the
 * script builds `LoginInfo` and appends it, `DeviceId`, `forMobile` and
 * `postLoginUrl` at submit time. See `LOGIN_INFO` in `wire.ts`.
 */
export function loginPageEnvelope(token = TOKEN): string {
  return `<!doctype html><html><body>
    <form id="loginForm" action="#">
      <input type="hidden" name="jsenabled" value="0" />
      <input type="text" name="LoginIdentifier" value="" />
      <input type="password" name="Password" value="" />
      <input type="submit" name="submit" value="Sign In" />
    </form>
    <form id="actualLogin" method="post" action="/MyChart/Authentication/Login/DoLogin">
      <input type="hidden" name="__RequestVerificationToken" value="${token}" />
    </form>
  </body></html>`;
}

/**
 * A login page carrying an unrelated second form -- a site-search box, say --
 * next to the one that is actually posted. Proves the login POST's echo is
 * scoped to the posted form's own fields: `q` belongs to the search form and
 * must never reach `DoLogin`.
 */
export function loginPageWithUnrelatedForm(token = TOKEN): string {
  return `<!doctype html><html><body>
    <form id="siteSearch" action="/MyChart/Search" method="get">
      <input type="text" name="q" value="preset-search-term" />
    </form>
    <form action="/MyChart/Authentication/Login/DoLogin" method="post">
      <input type="hidden" name="__RequestVerificationToken" value="${token}" />
      <input type="hidden" name="Redirect" value="/MyChart/Home" />
      <input type="text" name="LoginIdentifier" value="" />
      <input type="password" name="Password" value="" />
    </form>
  </body></html>`;
}

/**
 * A page asking the owner to choose a delivery channel before any code has
 * been sent -- not the code-entry page, and (on purpose) not served under a
 * path containing `secondaryvalidation`, so a client that only checked the URL
 * would misread it as "signed in".
 */
export const METHOD_CHOICE_PAGE = `<!doctype html><html><body>
  <form action="/MyChart/Authentication/VerificationMethod/SendCode" method="post">
    <input type="hidden" name="__RequestVerificationToken" value="${TOKEN_2}" />
    <input type="radio" name="SelectedDeliveryMethod" value="Email" checked />
    <label>Email me a code</label>
    <input type="radio" name="SelectedDeliveryMethod" value="Phone" />
    <label>Text me a code</label>
    <button type="submit">Continue</button>
  </form>
</body></html>`;

/**
 * A signed-in page.
 *
 * Carefully free of every marker the client looks for: no password input, no
 * mention of the challenge, and none of the words that mean "locked" or
 * "blocked" -- a fixture that tripped one of those would make a passing test
 * meaningless.
 */
export const HOME_PAGE = `<!doctype html><html><body>
  <h1>Your chart</h1><nav><a href="/MyChart/Visits/VisitsList">Visits</a></nav>
</body></html>`;

/** The upcoming-visits page, whose only job is to carry the token. */
export function visitsListPage(token = TOKEN_2): string {
  return `<!doctype html><html><body>
    <input type="hidden" name="__RequestVerificationToken" value="${token}" />
    <div id="upcoming"></div>
  </body></html>`;
}

/** A `/Date(ms)/` instant for an invented appointment time. */
export const VISIT_INSTANT_MS = 1_790_000_000_000;

/**
 * A `LoadUpcoming` body with all three buckets populated.
 *
 * The status booleans are set in combinations that contradict each other on
 * purpose: that is what the real payload does, and pinning the priority order is
 * the only way a cancelled visit reliably stops being on the calendar.
 */
export function upcomingPayload(): Record<string, unknown> {
  return {
    InProgressVisits: [
      {
        CSN: "csn-in-progress",
        Instant: `/Date(${String(VISIT_INSTANT_MS)})/`,
        TimeZone: CLINIC_ZONE,
        VisitType: "Follow-up",
        ProviderName: "A. Example, MD",
        DepartmentName: "Example Clinic",
        DurationInMinutes: 30,
        // Both true: `in_progress` outranks `arrived`.
        IsInProgress: true,
        IsArrived: true,
        IsPastVisit: false,
      },
    ],
    NextNDaysVisits: [
      {
        CSN: "csn-soon",
        Instant: `/Date(${String(VISIT_INSTANT_MS + 86_400_000)}-0600)/`,
        TimeZone: CLINIC_ZONE,
        AppointmentType: "Video visit",
        Providers: [{ ProviderName: "B. Example, DO" }],
        LocationName: "Example Tower",
        Address: "1 Example Way",
        Phone: "555-0100",
        IsVideoVisit: true,
        IsConfirmed: true,
      },
      {
        CSN: "csn-cancelled",
        Instant: `/Date(${String(VISIT_INSTANT_MS + 172_800_000)})/`,
        TimeZone: CLINIC_ZONE,
        VisitType: "Lab",
        // Everything at once: `canceled` outranks all of it.
        IsCompleted: true,
        IsConfirmed: true,
        IsArrived: true,
        IsCancelled: true,
        IsPastVisit: false,
      },
    ],
    LaterVisitsList: [
      {
        CSN: "csn-later",
        Instant: `/Date(${String(VISIT_INSTANT_MS + 2_592_000_000)})/`,
        VisitType: "Annual",
        // No TimeZone: the requested zone is the fallback.
        IsNoShow: true,
        IsCompleted: true,
      },
    ],
  };
}

/**
 * A `LoadUpcoming` body in the shape a live capture found, rather than the shape
 * the key guesses assumed.
 *
 * Every difference from `upcomingPayload()` is a correction the capture forced:
 * `Csn` not `CSN`, `VisitTypeName` not `VisitType`, `PrimaryProviderName` not
 * `ProviderName`, the whole of the place nested under `PrimaryDepartment` with a
 * structured `Address` object, no `IsVideoVisit`-shaped flag anywhere, and the
 * two status keys whose guessed names were simply wrong.
 *
 * Invented values throughout. No part of this came from a real payload.
 */
export function confirmedShapePayload(): Record<string, unknown> {
  return {
    HasPVG: false,
    HighlightDays: [],
    InProgressVisits: [],
    NextNDaysVisits: [
      {
        Csn: "csn-nested",
        Instant: `/Date(${String(VISIT_INSTANT_MS)})/`,
        PrimaryDate: "Sep 21, 2026",
        TimeZone: CLINIC_ZONE,
        DurationInMinutes: 20,
        VisitTypeName: "Office Visit",
        PrimaryProviderName: "C. Example, NP",
        Providers: [{ PrimaryProviderName: "C. Example, NP" }],
        PrimaryDepartment: {
          Name: "Example Family Medicine",
          PhoneNumber: "555-0142",
          Address: {
            StreetAddress: "42 Invented Road",
            City: "Exampleville",
            State: "ZZ",
            StateName: "Exampleshire",
            Zip: "00000",
          },
        },
        // The real video signals: an object where a boolean was guessed.
        Telemedicine: { JoinBy: "app" },
        TelehealthMode: 0,
        CanShowTelemedicine: true,
        IsConfirmed: true,
        IsPastVisit: false,
      },
      {
        Csn: "csn-telehealth-mode",
        Instant: `/Date(${String(VISIT_INSTANT_MS + 3_600_000)})/`,
        VisitTypeName: "Video Follow-up",
        TimeZone: CLINIC_ZONE,
        // The other real video signal, on its own: a non-zero enum-like number.
        Telemedicine: null,
        TelehealthMode: 2,
        CanShowTelemedicine: true,
      },
      {
        Csn: "csn-in-person",
        Instant: `/Date(${String(VISIT_INSTANT_MS + 7_200_000)})/`,
        VisitTypeName: "Lab",
        TimeZone: CLINIC_ZONE,
        // `CanShowTelemedicine` alone must NOT make this a video visit: it says
        // the page may render the section, not that this appointment is one.
        Telemedicine: null,
        TelehealthMode: 0,
        CanShowTelemedicine: true,
      },
      {
        Csn: "csn-lwbs",
        Instant: `/Date(${String(VISIT_INSTANT_MS + 10_800_000)})/`,
        VisitTypeName: "Urgent Care",
        TimeZone: CLINIC_ZONE,
        // The corrected key names, each with the guessed name absent.
        LeftWithoutSeen: true,
        InProgress: true,
      },
      {
        Csn: "csn-cancel-sent",
        Instant: `/Date(${String(VISIT_INSTANT_MS + 14_400_000)})/`,
        VisitTypeName: "Imaging",
        TimeZone: CLINIC_ZONE,
        IsCancelRequestSent: true,
        IsConfirmed: true,
      },
    ],
    LaterVisitsList: [],
  };
}

/** An opaque per-organisation key, as `LoadPast` groups its rows by. Invented. */
export const ORG_TOKEN = "org-token-aaa";
/** A second one, so a test can prove both buckets are read. */
const ORG_TOKEN_2 = "org-token-bbb";

/**
 * A `LoadPast` body: the same rows, grouped one level deeper.
 *
 * `LoadPast` buckets by an opaque organisation token because a chart account can
 * be linked to several organisations, which is the one structural difference from
 * `LoadUpcoming`.
 */
export function pastPayload(): Record<string, unknown> {
  return {
    CanSearch: true,
    List: {
      [ORG_TOKEN]: {
        HasMoreData: true,
        ListSize: 1,
        SerializedIndex: "cursor-one",
        List: [
          {
            Csn: "csn-past-one",
            Instant: `/Date(${String(VISIT_INSTANT_MS - 86_400_000)})/`,
            TimeZone: CLINIC_ZONE,
            VisitTypeName: "Follow-up",
            PrimaryDepartment: { Name: "Example Family Medicine" },
            IsPastVisit: true,
          },
        ],
      },
      [ORG_TOKEN_2]: {
        HasMoreData: false,
        ListSize: 1,
        List: [
          {
            Csn: "csn-past-two",
            Instant: `/Date(${String(VISIT_INSTANT_MS - 172_800_000)})/`,
            TimeZone: CLINIC_ZONE,
            VisitTypeName: "Lab",
          },
        ],
      },
    },
    SerializedIndex: "cursor-top",
  };
}

/**
 * The OpenID handoff stub a `custom_oidc` deployment serves at the login path.
 *
 * No form the classic client could drive, no username field, no password field:
 * one hidden antiforgery input and the controller script that hands off to the
 * OpenID flow. Written by hand; the marker strings are the only part that has to
 * match a real deployment.
 */
export const OPENID_STUB_PAGE = `<!doctype html><html><head>
  <script src="/areas/authentication/scripts/controllers/openidrequestcontroller.min.js"></script>
</head><body>
  <input type="hidden" name="__RequestVerificationToken" value="${TOKEN}" />
</body></html>`;

/** The `AuthorizeResult` page's antiforgery token, distinct from the stub's. */
export const RESULT_TOKEN = "synthetic-antiforgery-token-0003";

/**
 * The hand-off stub as a `custom_oidc` deployment serves it.
 *
 * Mirrors the *structure* of the owner's capture of a successful sign-in and
 * nothing else: one hidden antiforgery input, and the request controller
 * instantiated inside the UI framework's load callback with six literal
 * arguments -- encrypted nonce, encrypted state, encrypted code verifier, the
 * authorization URL (every `&` written as `&`, as a JS string literal in
 * the real page carries it), a workflow label, and the submit-a-form flag.
 * Every value is invented. The class name is generic MyChart framework code.
 */
export function openIdRequestPage(authorizeUrl: string, submitForm = false): string {
  const literal = authorizeUrl.replaceAll("&", "&");
  return `<!doctype html><html><body>
  <input name="__RequestVerificationToken" type="hidden" value="${TOKEN}" />
  <script>
  $$WP.Utilities.UI.OnUIFrameworkLoaded(function () {
    new $$WP.Authentication.OpenId.Controllers.OpenIdRequestController("synthetic-enc-nonce", "synthetic-enc-state","synthetic-enc-verifier", "${literal}", "1", ${String(submitForm)});
  });
  </script>
</body></html>`;
}

/**
 * The `AuthorizeResult` page, same rules: its own antiforgery input and the
 * response controller with `(code, state, error, responseMode, issuer)`, where
 * the capture had `error` and `issuer` empty.
 */
export function openIdResponsePage(code: string, state: string, responseMode = "query"): string {
  return `<!doctype html><html><body>
  <input name="__RequestVerificationToken" type="hidden" value="${RESULT_TOKEN}" />
  <script>
  $$WP.Utilities.UI.OnUIFrameworkLoaded(function () {
    new $$WP.Authentication.OpenId.Controllers.OpenIdResponseController("${code}", "${state}", "", "${responseMode}", "");
  });
  </script>
</body></html>`;
}

/**
 * The OpenID handoff stub, plus the `<noscript>` fallback a real deployment
 * ships alongside it for a browser that will not run its scripts.
 *
 * `nojsTarget` is the no-JS landing page. A browser with JavaScript enabled --
 * which this client impersonates -- never renders a `<noscript>` element's
 * content, let alone follows a refresh inside it, so a scraper that does is one
 * hop behind a real browser and lands somewhere with none of this stub's
 * markers.
 */
export function openIdStubWithNoscriptFallback(nojsTarget: string): string {
  return `<!doctype html><html><head>
  <script src="/areas/authentication/scripts/controllers/openidrequestcontroller.min.js"></script>
  <noscript><meta http-equiv="refresh" content="0;url=${nojsTarget}" /></noscript>
</head><body>
  <input type="hidden" name="__RequestVerificationToken" value="${TOKEN}" />
</body></html>`;
}

/**
 * The stub again, this time with an unrelated same-origin body redirect that
 * sits *outside* any `<noscript>` element.
 *
 * Proves the stub is recognised on its own markers before a body redirect is
 * even considered, not merely because `<noscript>` stripping happened to
 * remove the only one present: this redirect is real, and blindly following it
 * would still walk past the stub if nothing recognised the stub first.
 */
export function openIdStubWithBodyRedirect(target: string): string {
  return `<!doctype html><html><head>
  <script src="/areas/authentication/scripts/controllers/openidrequestcontroller.min.js"></script>
  <script>window.location.href = "${target}";</script>
</head><body>
  <input type="hidden" name="__RequestVerificationToken" value="${TOKEN}" />
</body></html>`;
}

/**
 * A `<meta refresh>` outside `<noscript>`, plus a decoy inside one that points
 * somewhere else. The real target must still be the one used: `<noscript>`
 * stripping must remove only the decoy, not the redirect a real browser acts on.
 */
export function metaRedirectPageWithNoscriptDecoy(target: string, decoyTarget: string): string {
  return `<!doctype html><html><head>
  <meta http-equiv="refresh" content="0;url=${target}" />
  <noscript><meta http-equiv="refresh" content="0;url=${decoyTarget}" /></noscript>
</head><body>Redirecting</body></html>`;
}

/**
 * A page whose only redirect is a `window.location` assignment inside
 * `<noscript>`. A browser with JavaScript enabled never executes it, so the
 * page is not a redirect at all as far as this client is concerned.
 */
export function noscriptOnlyScriptRedirectPage(target: string): string {
  return `<!doctype html><html><head>
  <noscript><script>window.location.href = "${target}";</script></noscript>
</head><body>ok</body></html>`;
}
