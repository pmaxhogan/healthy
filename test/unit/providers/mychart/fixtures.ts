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

/** A vanity host that redirects with a script rather than a header. */
export const SCRIPT_REDIRECT_PAGE = `<!doctype html><html><head><script>
  window.location.href = "${HOST}/prd/Authentication/Login";
</script></head><body>Redirecting</body></html>`;

/** The same, as a meta refresh. */
export const META_REDIRECT_PAGE = `<!doctype html><html><head>
  <meta http-equiv="refresh" content="0;url=${HOST}/prd/Authentication/Login" />
</head><body>Redirecting</body></html>`;

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
