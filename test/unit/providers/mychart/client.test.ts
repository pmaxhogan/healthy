// The client's whole job is to tell four indistinguishable HTTP 200s apart --
// signed in, needs a code, wrong password, session died -- so most of these tests
// are about *where the redirect chain stopped* rather than about a status code.
//
// Two of them are about request shape rather than behaviour, and they are the
// ones most likely to be broken by an innocent refactor: `LoadUpcoming` must
// carry no body and no `Content-Type` (a WAF in front of these endpoints rejects
// the `text/plain` a runtime adds to an empty string body), and a cookie picked
// up on an intermediate 302 must be sent on the next hop.

import { describe, expect, it } from "vitest";

import { noopLogger } from "../../../../worker/lib/log.ts";
import { createMyChartClient } from "../../../../worker/providers/mychart/client.ts";
import { CookieJar } from "../../../../worker/providers/mychart/cookie-jar.ts";

import {
  CHALLENGE_PAGE,
  CLINIC_ZONE,
  HOME_PAGE,
  HOST,
  html,
  json,
  HOME_PAGE_WITH_INNOCENT_MARKERS,
  LOGIN_LOCKED_PAGE,
  LOGIN_PAGE_CAPTCHA_REQUIRED,
  LOGIN_PAGE_ENCODED_TOKEN,
  LOGIN_PAGE_WITH_INNOCENT_MARKERS,
  LOGIN_REJECTED_PAGE,
  LOGIN_REJECTED_WITH_INNOCENT_MARKERS,
  loginPageNew,
  loginPageOld,
  loginPageWithLoginField,
  MOUNT,
  OPENID_STUB_PAGE,
  pastPayload,
  redirect,
  routed,
  stubPortal,
  TOKEN,
  TOKEN_2,
  twoFactorPage,
  upcomingPayload,
  visitsListPage,
} from "./fixtures.ts";

import type { PortalCall, PortalFetchStub } from "./fixtures.ts";
import type { AppError } from "../../../../worker/lib/errors.ts";
import type { PortalClient } from "../../../../worker/providers/mychart/client.ts";
import type { PortalEndpoint } from "../../../../worker/providers/mychart/discovery.ts";

const T0 = 1_767_225_600;
const CREDENTIALS = { username: "owner-login", password: "owner-password" };
const OWNER_ZONE = "UTC";

const ENDPOINT: PortalEndpoint = {
  baseUrl: HOST,
  mountPath: MOUNT,
  usernameField: "LoginIdentifier",
  antiforgeryFieldName: "__RequestVerificationToken",
};

function client(stub: PortalFetchStub, jar = new CookieJar({ now: () => T0 })): PortalClient {
  return createMyChartClient({
    endpoint: ENDPOINT,
    jar,
    fetchImpl: stub.fetchImpl,
    logger: noopLogger,
    now: () => T0,
    // Pinned so a URL a test asserts on is deterministic.
    random: () => 0.5,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as AppError).code;
  }
  throw new Error("expected the promise to reject");
}

function bodyOf(call: PortalCall | undefined): URLSearchParams {
  return new URLSearchParams(call?.body ?? "");
}

function find(stub: PortalFetchStub, method: string, suffix: string): PortalCall | undefined {
  return stub.calls.find(
    (call) => call.method === method && new URL(call.url).pathname.endsWith(suffix),
  );
}

/** A portal that signs in straight through, then serves the visits list. */
function signedInPortal(payload: unknown = upcomingPayload()): PortalFetchStub {
  return routed({
    "GET /MyChart/Authentication/Login": () => html(loginPageNew()),
    "POST /MyChart/Authentication/Login/DoLogin": () => redirect(`${HOST}/MyChart/Home/Index`),
    "GET /MyChart/Home/Index": () => html(HOME_PAGE),
    "GET /MyChart/Home": () => html(HOME_PAGE),
    "GET /MyChart/Visits/VisitsList": () => html(visitsListPage()),
    "POST /MyChart/Visits/VisitsList/LoadUpcoming": () => json(payload),
  });
}

describe("login", () => {
  it("takes the token off the login page and posts it with the credentials", async () => {
    const stub = signedInPortal();

    await expect(client(stub).login(CREDENTIALS)).resolves.toBe("signed_in");

    const post = find(stub, "POST", "/DoLogin");
    const form = bodyOf(post);
    expect(form.get("__RequestVerificationToken")).toBe(TOKEN);
    expect(form.get("LoginIdentifier")).toBe(CREDENTIALS.username);
    expect(form.get("Password")).toBe(CREDENTIALS.password);
    // A hidden field the page pre-filled is echoed back, as a browser would.
    expect(form.get("Redirect")).toBe("/MyChart/Home");
    expect(post?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("uses the field name the page actually has, not the one discovery recorded", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/Login": () => html(loginPageOld()),
      "POST /MyChart/Authentication/Login/DoLogin": () => redirect(`${HOST}/MyChart/Home/Index`),
      "GET /MyChart/Home/Index": () => html(HOME_PAGE),
    });

    await client(stub).login(CREDENTIALS);

    const form = bodyOf(find(stub, "POST", "/DoLogin"));
    expect(form.get("Username")).toBe(CREDENTIALS.username);
    expect(form.get("LoginIdentifier")).toBeNull();
  });

  it("recognises the third username field, Login, and posts it as Login=", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/Login": () => html(loginPageWithLoginField()),
      "POST /MyChart/Authentication/Login/DoLogin": () => redirect(`${HOST}/MyChart/Home/Index`),
      "GET /MyChart/Home/Index": () => html(HOME_PAGE),
    });

    await client(stub).login(CREDENTIALS);

    const form = bodyOf(find(stub, "POST", "/DoLogin"));
    expect(form.get("Login")).toBe(CREDENTIALS.username);
    expect(form.get("LoginIdentifier")).toBeNull();
    expect(form.get("Username")).toBeNull();
  });

  it("sends jsenabled as a JS-enabled browser would, not the page's own default", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/Login": () => html(loginPageWithLoginField()),
      "POST /MyChart/Authentication/Login/DoLogin": () => redirect(`${HOST}/MyChart/Home/Index`),
      "GET /MyChart/Home/Index": () => html(HOME_PAGE),
    });

    await client(stub).login(CREDENTIALS);

    // The fixture's own value is "0"; a JS-enabled browser would have flipped it.
    expect(bodyOf(find(stub, "POST", "/DoLogin")).get("jsenabled")).toBe("1");
  });

  it("does not invent a jsenabled field on a page that never rendered one", async () => {
    const stub = signedInPortal();

    await client(stub).login(CREDENTIALS);

    expect(bodyOf(find(stub, "POST", "/DoLogin")).get("jsenabled")).toBeNull();
  });

  it("reports portal_captcha_required, not portal_login_failed, when the portal asks for a captcha", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/Login": () => html(loginPageWithLoginField()),
      "POST /MyChart/Authentication/Login/DoLogin": () => html(LOGIN_PAGE_CAPTCHA_REQUIRED),
    });

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_captcha_required");
  });

  it("decodes an entity-escaped token before echoing it back", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/Login": () => html(LOGIN_PAGE_ENCODED_TOKEN),
      "POST /MyChart/Authentication/Login/DoLogin": () => redirect(`${HOST}/MyChart/Home/Index`),
      "GET /MyChart/Home/Index": () => html(HOME_PAGE),
    });

    await client(stub).login(CREDENTIALS);

    expect(bodyOf(find(stub, "POST", "/DoLogin")).get("__RequestVerificationToken")).toBe(
      "aa+bb&cc",
    );
  });

  it("signs in even though the login page carries a frame-busting clickjacking guard", async () => {
    // The classic client's own page fetches (`tokenPage`) must not treat the
    // guard's `top.location` assignment as a redirect either -- the same bug
    // as discovery's, reached from the authenticated client instead.
    const guardedLogin = `<!doctype html><html><head><script>
      if (self === top) {
        // not framed; nothing to do
      } else {
        top.location = "/MyChart/Home/LogOut";
      }
    </script></head><body>
      <form action="/MyChart/Authentication/Login/DoLogin" method="post">
        <input type="hidden" name="__RequestVerificationToken" value="${TOKEN}" />
        <input type="text" name="LoginIdentifier" value="" />
        <input type="password" name="Password" value="" />
      </form>
    </body></html>`;
    const stub = routed({
      "GET /MyChart/Authentication/Login": () => html(guardedLogin),
      "POST /MyChart/Authentication/Login/DoLogin": () => redirect(`${HOST}/MyChart/Home/Index`),
      "GET /MyChart/Home/Index": () => html(HOME_PAGE),
    });

    await expect(client(stub).login(CREDENTIALS)).resolves.toBe("signed_in");
  });

  it("reports awaiting_code when the portal redirects to the challenge page", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/Login": () => html(loginPageNew()),
      "POST /MyChart/Authentication/Login/DoLogin": () =>
        redirect(`${HOST}/MyChart/Authentication/SecondaryValidation`),
      "GET /MyChart/Authentication/SecondaryValidation": () => html(twoFactorPage()),
    });

    await expect(client(stub).login(CREDENTIALS)).resolves.toBe("awaiting_code");
  });

  it("reports portal_login_failed when the login form comes back with an error", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/Login": () => html(loginPageNew()),
      "POST /MyChart/Authentication/Login/DoLogin": () => html(LOGIN_REJECTED_PAGE),
    });

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_login_failed");
  });

  it("reports portal_locked rather than a plain failure when the account is locked", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/Login": () => html(loginPageNew()),
      "POST /MyChart/Authentication/Login/DoLogin": () => html(LOGIN_LOCKED_PAGE),
    });

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_locked");
  });

  it("calls a wrong password a wrong password, even on a form full of innocent markers", async () => {
    // `disabled` on the submit button and a reCAPTCHA tag in the head are both
    // ordinary. Reading either as "locked" would stop the retry loop for the day
    // over a typo.
    const stub = routed({
      "GET /MyChart/Authentication/Login": () => html(LOGIN_PAGE_WITH_INNOCENT_MARKERS),
      "POST /MyChart/Authentication/Login/DoLogin": () =>
        html(LOGIN_REJECTED_WITH_INNOCENT_MARKERS),
    });

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_login_failed");
  });

  it("reports portal_bot_blocked for a 429, carrying its Retry-After", async () => {
    const stub = stubPortal(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
    );

    // The Retry-After is carried on the error so a whole run can back off,
    // rather than this one call retrying into the same wall.
    await expect(client(stub).login(CREDENTIALS)).rejects.toMatchObject({
      code: "portal_bot_blocked",
      retryAfterMs: 120_000,
    });
  });

  it("reports portal_bot_blocked for a challenge page served as a 200", async () => {
    const stub = stubPortal(() => html(CHALLENGE_PAGE));

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_bot_blocked");
  });

  it("reports portal_parse_failed when the login page carries no token", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/Login": () =>
        html(`<form><input name="LoginIdentifier"/><input name="Password"/></form>`),
    });

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_parse_failed");
  });

  it("reports portal_unreachable for a 500 and for a transport failure", async () => {
    const serverError = stubPortal(() => new Response("boom", { status: 500 }));
    const refused = stubPortal(() => {
      throw new TypeError("connection refused");
    });

    await expect(codeOf(client(serverError).login(CREDENTIALS))).resolves.toBe(
      "portal_unreachable",
    );
    await expect(codeOf(client(refused).login(CREDENTIALS))).resolves.toBe("portal_unreachable");
  });

  it("never re-sends the credentials to another origin on a 307", async () => {
    const elsewhere = "https://elsewhere.example-portal.test";
    const stub = stubPortal((call) => {
      const { origin, pathname } = new URL(call.url);
      if (pathname === "/MyChart/Authentication/Login" && origin === HOST) {
        return html(loginPageNew());
      }
      return pathname === "/MyChart/Authentication/Login/DoLogin"
        ? redirect(`${elsewhere}/collect`, [], 307)
        : html(HOME_PAGE);
    });

    await client(stub).login(CREDENTIALS);

    const offsite = stub.calls.filter((call) => new URL(call.url).origin === elsewhere);
    expect(offsite).toHaveLength(1);
    expect(offsite[0]?.method).toBe("GET");
    expect(offsite[0]?.body).toBeUndefined();
  });
});

describe("cookies", () => {
  it("keeps a cookie set on an intermediate redirect and sends it on the next hop", async () => {
    const stub = stubPortal((call) => {
      const { pathname } = new URL(call.url);
      if (pathname === "/MyChart/Authentication/Login") return html(loginPageNew());
      if (pathname === "/MyChart/Authentication/Login/DoLogin") {
        return redirect(`${HOST}/MyChart/Home/Index`, [
          "MCSession=session-1; Path=/; Secure; HttpOnly",
          "trust=device-1; Path=/; Max-Age=7776000",
        ]);
      }
      return html(HOME_PAGE);
    });
    const jar = new CookieJar({ now: () => T0 });

    await client(stub, jar).login(CREDENTIALS);

    // The hop after the 302 is where the cookies first become visible; the jar
    // exists precisely because a runtime-followed redirect would have eaten them.
    const home = find(stub, "GET", "/Home/Index");
    expect(home?.headers.cookie).toBe("MCSession=session-1; trust=device-1");
    expect(jar.has(`${HOST}/MyChart/`, "trust")).toBe(true);
  });

  it("exposes the jar so the caller can seal it after a failed sign-in too", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/Login": () =>
        html(loginPageNew(), { headers: { "set-cookie": "MCSession=partial; Path=/" } }),
      "POST /MyChart/Authentication/Login/DoLogin": () => html(LOGIN_REJECTED_PAGE),
    });
    const jar = new CookieJar({ now: () => T0 });
    const portal = client(stub, jar);

    await expect(codeOf(portal.login(CREDENTIALS))).resolves.toBe("portal_login_failed");
    expect(portal.jar).toBe(jar);
    expect(JSON.parse(jar.serialise())).toMatchObject({ v: 1 });
    expect(jar.size).toBe(1);
  });
});

describe("secondaryValidation.sendCode", () => {
  it("posts the first parameter variant and stops when it is accepted", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/SecondaryValidation": () => html(twoFactorPage()),
      "POST /MyChart/Authentication/SecondaryValidation/SendCode": () => json({ success: true }),
    });

    await client(stub).secondaryValidation.sendCode("email");

    const posts = stub.calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    const form = bodyOf(posts[0]);
    expect(form.get("Mode")).toBe("Email");
    expect(form.get("__RequestVerificationToken")).toBe(TOKEN_2);
    expect(posts[0]?.headers["x-requested-with"]).toBe("XMLHttpRequest");
  });

  it("tries the next variant when the portal answers success:false", async () => {
    let attempt = 0;
    const stub = stubPortal((call) => {
      const { pathname } = new URL(call.url);
      if (pathname.endsWith("/SendCode")) {
        attempt++;
        return json({ success: attempt === 1 ? false : true });
      }
      return html(twoFactorPage());
    });

    await client(stub).secondaryValidation.sendCode("email");

    const posts = stub.calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(2);
    expect(bodyOf(posts[1]).get("DeliveryMethod")).toBe("Email");
  });

  it("fetches a fresh token for every variant, because each POST spends one", async () => {
    let attempt = 0;
    const stub = stubPortal((call) => {
      const { pathname } = new URL(call.url);
      if (pathname.endsWith("/SendCode")) {
        attempt++;
        return attempt === 1 ? new Response("no", { status: 400 }) : json({ success: true });
      }
      return html(twoFactorPage(attempt === 0 ? TOKEN : TOKEN_2));
    });

    await client(stub).secondaryValidation.sendCode("email");

    const gets = stub.calls.filter((call) => call.method === "GET");
    expect(gets).toHaveLength(2);
  });

  it("reports portal_login_failed when every variant is refused", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/SecondaryValidation": () => html(twoFactorPage()),
      "POST /MyChart/Authentication/SecondaryValidation/SendCode": () =>
        new Response("no", { status: 400 }),
    });

    await expect(codeOf(client(stub).secondaryValidation.sendCode("email"))).resolves.toBe(
      "portal_login_failed",
    );
  });
});

describe("secondaryValidation.validate", () => {
  it("re-fetches the challenge page for a fresh token and asks to be remembered", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/SecondaryValidation": () => html(twoFactorPage()),
      "POST /MyChart/Authentication/SecondaryValidation/Validate": () =>
        redirect(`${HOST}/MyChart/Home/Index`, ["trust=device-1; Path=/; Max-Age=7776000"]),
      "GET /MyChart/Home/Index": () => html(HOME_PAGE),
    });
    const jar = new CookieJar({ now: () => T0 });

    await client(stub, jar).secondaryValidation.validate("123456");

    const form = bodyOf(find(stub, "POST", "/Validate"));
    expect(form.get("TwoFactorCode")).toBe("123456");
    expect(form.get("RememberMe")).toBe("checked");
    expect(form.get("__RequestVerificationToken")).toBe(TOKEN_2);
    // The trust-this-device cookie is the whole point of RememberMe.
    expect(jar.has(`${HOST}/MyChart/`, "trust")).toBe(true);
  });

  it("omits RememberMe when the caller says not to trust the device", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/SecondaryValidation": () => html(twoFactorPage()),
      "POST /MyChart/Authentication/SecondaryValidation/Validate": () =>
        redirect(`${HOST}/MyChart/Home/Index`),
      "GET /MyChart/Home/Index": () => html(HOME_PAGE),
    });

    await client(stub).secondaryValidation.validate("123456", false);

    expect(bodyOf(find(stub, "POST", "/Validate")).get("RememberMe")).toBeNull();
  });

  it("reports portal_2fa_rejected when the challenge page comes back again", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/SecondaryValidation": () => html(twoFactorPage()),
      "POST /MyChart/Authentication/SecondaryValidation/Validate": () =>
        html(twoFactorPage(), { status: 200 }),
    });

    await expect(codeOf(client(stub).secondaryValidation.validate("000000"))).resolves.toBe(
      "portal_2fa_rejected",
    );
  });

  it("reports portal_login_failed when it is bounced all the way back to login", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/SecondaryValidation": () => html(twoFactorPage()),
      "POST /MyChart/Authentication/SecondaryValidation/Validate": () =>
        redirect(`${HOST}/MyChart/Authentication/Login`),
      "GET /MyChart/Authentication/Login": () => html(loginPageNew()),
    });

    await expect(codeOf(client(stub).secondaryValidation.validate("000000"))).resolves.toBe(
      "portal_login_failed",
    );
  });
});

describe("loadUpcoming", () => {
  it("sends the documented query and NO body and NO Content-Type", async () => {
    const stub = signedInPortal();

    await client(stub).loadUpcoming(OWNER_ZONE);

    const post = find(stub, "POST", "/LoadUpcoming");
    const query = new URL(post?.url ?? "").searchParams;
    expect(query.get("timeZone")).toBe(OWNER_ZONE);
    expect(query.get("ComponentNumber")).toBe("5");
    expect(query.get("noCache")).toBe("500000000000000");
    // The two assertions this whole file exists for.
    expect(post?.body).toBeUndefined();
    expect(post?.headers["content-type"]).toBeUndefined();
    // With no body there is nowhere to put the token but a header.
    expect(post?.headers.__requestverificationtoken).toBe(TOKEN_2);
    expect(post?.headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(post?.headers.accept).toContain("application/json");
  });

  it("puts a cache-buster on the token page too", async () => {
    const stub = signedInPortal();

    await client(stub).loadUpcoming(OWNER_ZONE);

    const get = find(stub, "GET", "/Visits/VisitsList");
    expect(new URL(get?.url ?? "").searchParams.get("noCache")).toBe("500000000000000");
  });

  it("parses all three buckets, with the clinic's zone on each visit", async () => {
    const stub = signedInPortal();

    const visits = await client(stub).loadUpcoming(OWNER_ZONE);

    expect(visits).toHaveLength(4);
    expect(visits[0]?.timeZone).toBe(CLINIC_ZONE);
    expect(visits.map((visit) => visit.status)).toStrictEqual([
      "in_progress",
      "confirmed",
      "canceled",
      "no_show",
    ]);
  });

  it("reports portal_session_expired when the token page bounces to login", async () => {
    const stub = routed({
      "GET /MyChart/Visits/VisitsList": () => redirect(`${HOST}/MyChart/Authentication/Login`),
      "GET /MyChart/Authentication/Login": () => html(loginPageNew()),
    });

    await expect(codeOf(client(stub).loadUpcoming(OWNER_ZONE))).resolves.toBe(
      "portal_session_expired",
    );
  });

  it("reports portal_session_expired when the JSON call itself bounces to login", async () => {
    const stub = routed({
      "GET /MyChart/Visits/VisitsList": () => html(visitsListPage()),
      "POST /MyChart/Visits/VisitsList/LoadUpcoming": () =>
        redirect(`${HOST}/MyChart/Authentication/Login`),
      "GET /MyChart/Authentication/Login": () => html(loginPageNew()),
    });

    await expect(codeOf(client(stub).loadUpcoming(OWNER_ZONE))).resolves.toBe(
      "portal_session_expired",
    );
  });

  it("reports portal_2fa_required when an authenticated call lands on the challenge page", async () => {
    const stub = routed({
      "GET /MyChart/Visits/VisitsList": () =>
        redirect(`${HOST}/MyChart/Authentication/SecondaryValidation`),
      "GET /MyChart/Authentication/SecondaryValidation": () => html(twoFactorPage()),
    });

    await expect(codeOf(client(stub).loadUpcoming(OWNER_ZONE))).resolves.toBe(
      "portal_2fa_required",
    );
  });

  it("reports portal_parse_failed when the body is not JSON", async () => {
    const stub = routed({
      "GET /MyChart/Visits/VisitsList": () => html(visitsListPage()),
      "POST /MyChart/Visits/VisitsList/LoadUpcoming": () => new Response("<html>nope</html>"),
    });

    await expect(codeOf(client(stub).loadUpcoming(OWNER_ZONE))).resolves.toBe(
      "portal_parse_failed",
    );
  });

  it("is an empty list when the portal has nothing upcoming", async () => {
    const stub = signedInPortal({
      InProgressVisits: [],
      NextNDaysVisits: [],
      LaterVisitsList: [],
    });

    await expect(client(stub).loadUpcoming(OWNER_ZONE)).resolves.toStrictEqual([]);
  });
});

describe("isSessionAlive", () => {
  it("is true when an authenticated page answers", async () => {
    const stub = signedInPortal();

    await expect(client(stub).isSessionAlive()).resolves.toBe(true);
  });

  it("is true on a signed-in page that links to two-step settings and can change a password", async () => {
    // A `SecondaryValidation` link and a password input are both things a real
    // chart page carries. Either one read as a marker would make every
    // authenticated call report a pending code or a dead session.
    const stub = routed({ "GET /MyChart/Home": () => html(HOME_PAGE_WITH_INNOCENT_MARKERS) });

    await expect(client(stub).isSessionAlive()).resolves.toBe(true);
  });

  it("is false when the portal bounces to the login page", async () => {
    const stub = routed({
      "GET /MyChart/Home": () => redirect(`${HOST}/MyChart/Authentication/Login`),
      "GET /MyChart/Authentication/Login": () => html(loginPageNew()),
    });

    await expect(client(stub).isSessionAlive()).resolves.toBe(false);
  });

  it("is false when the portal answers the login HTML with a 200 and no redirect", async () => {
    const stub = routed({ "GET /MyChart/Home": () => html(loginPageNew()) });

    await expect(client(stub).isSessionAlive()).resolves.toBe(false);
  });

  it("is false when the challenge page is still pending", async () => {
    const stub = routed({ "GET /MyChart/Home": () => html(twoFactorPage()) });

    await expect(client(stub).isSessionAlive()).resolves.toBe(false);
  });

  it("lets a bot block propagate rather than reporting a dead session", async () => {
    const stub = stubPortal(() => new Response("no", { status: 403 }));

    await expect(codeOf(client(stub).isSessionAlive())).resolves.toBe("portal_bot_blocked");
  });
});

describe("request shape", () => {
  it("follows redirects by hand on every call", async () => {
    const stub = signedInPortal();

    await client(stub).login(CREDENTIALS);

    for (const call of stub.calls) expect(call.redirect).toBe("manual");
  });

  it("sends a browser-shaped User-Agent and never a text/plain content type", async () => {
    const stub = signedInPortal();
    const portal = client(stub);

    await portal.login(CREDENTIALS);
    await portal.loadUpcoming(OWNER_ZONE);

    for (const call of stub.calls) {
      expect(call.headers["user-agent"]).toContain("Mozilla/5.0");
      expect(call.headers["content-type"]).not.toBe("text/plain");
    }
    // Every GET, and the bodyless POST, must carry no content type at all.
    const bodyless = stub.calls.filter((call) => call.body === undefined);
    expect(bodyless.length).toBeGreaterThan(0);
    for (const call of bodyless) expect(call.headers["content-type"]).toBeUndefined();
  });

  it("gives up on a redirect loop with portal_parse_failed", async () => {
    const stub = stubPortal((call) => redirect(`${call.url}/on`));

    await expect(codeOf(client(stub).isSessionAlive())).resolves.toBe("portal_parse_failed");
    expect(stub.calls.length).toBeLessThanOrEqual(12);
  });
});

/** A portal whose visits page serves the token and whose LoadPast answers JSON. */
function pastPortal(payload: unknown = pastPayload()): PortalFetchStub {
  return routed({
    "GET /MyChart/Visits/VisitsList": () => html(visitsListPage()),
    "POST /MyChart/Visits/VisitsList/LoadPast": () => json(payload),
  });
}

describe("loadPast", () => {
  it("sends the documented query, no body and the token in a header", async () => {
    const stub = pastPortal();

    await client(stub).loadPast(OWNER_ZONE, "2026-01-01T00:00:00Z");

    const post = find(stub, "POST", "/LoadPast");
    const query = new URL(post?.url ?? "").searchParams;
    expect(query.get("loadpast")).toBe("1");
    expect(query.get("searchString")).toBe("");
    expect(query.get("ComponentNumber")).toBe("7");
    expect(query.get("oldestRenderedDate")).toBe("2026-01-01T00:00:00Z");
    expect(post?.body).toBeUndefined();
    expect(post?.headers["content-type"]).toBeUndefined();
    expect(post?.headers.__requestverificationtoken).toBe(TOKEN_2);
  });

  it("flattens the per-organisation buckets into one list", async () => {
    const stub = pastPortal();

    const visits = await client(stub).loadPast(OWNER_ZONE);

    expect(visits.map((visit) => visit.csn)).toStrictEqual(["csn-past-one", "csn-past-two"]);
  });

  it("asks for the first page when no boundary is given", async () => {
    const stub = pastPortal();

    await client(stub).loadPast(OWNER_ZONE);

    expect(
      new URL(find(stub, "POST", "/LoadPast")?.url ?? "").searchParams.get("oldestRenderedDate"),
    ).toBe("");
  });

  it("reports portal_session_expired when the call bounces to login", async () => {
    const stub = routed({
      "GET /MyChart/Visits/VisitsList": () => html(visitsListPage()),
      "POST /MyChart/Visits/VisitsList/LoadPast": () =>
        redirect(`${HOST}/MyChart/Authentication/Login`),
      "GET /MyChart/Authentication/Login": () => html(loginPageNew()),
    });

    await expect(codeOf(client(stub).loadPast(OWNER_ZONE))).resolves.toBe("portal_session_expired");
  });
});

describe("a 200 that is a page where JSON was expected", () => {
  // The silent-failure mode a live capture found: with a missing or misnamed
  // antiforgery header these endpoints answer 200 with an HTML page rather than a
  // 4xx. Reading that as "no appointments" would ghost the owner's calendar.
  const CHART_PAGE = "<!doctype html><html><body><h1>Your chart</h1></body></html>";

  it("is portal_parse_failed on LoadUpcoming, never an empty day", async () => {
    const stub = routed({
      "GET /MyChart/Visits/VisitsList": () => html(visitsListPage()),
      "POST /MyChart/Visits/VisitsList/LoadUpcoming": () => html(CHART_PAGE),
    });

    await expect(codeOf(client(stub).loadUpcoming(OWNER_ZONE))).resolves.toBe(
      "portal_parse_failed",
    );
  });

  it("is portal_parse_failed on LoadPast, never an empty history", async () => {
    const stub = routed({
      "GET /MyChart/Visits/VisitsList": () => html(visitsListPage()),
      "POST /MyChart/Visits/VisitsList/LoadPast": () => html(CHART_PAGE),
    });

    await expect(codeOf(client(stub).loadPast(OWNER_ZONE))).resolves.toBe("portal_parse_failed");
  });

  it("is portal_session_expired when that page is the OpenID handoff stub", async () => {
    // A `custom_oidc` deployment's bounce: a 200 whose body has no login form at
    // all, so only the handoff marker tells it apart from a signed-in page.
    const stub = routed({
      "GET /MyChart/Visits/VisitsList": () => html(visitsListPage()),
      "POST /MyChart/Visits/VisitsList/LoadUpcoming": () => html(OPENID_STUB_PAGE),
    });

    await expect(codeOf(client(stub).loadUpcoming(OWNER_ZONE))).resolves.toBe(
      "portal_session_expired",
    );
  });

  it("still reads JSON a deployment mislabels as text/html", async () => {
    const stub = routed({
      "GET /MyChart/Visits/VisitsList": () => html(visitsListPage()),
      "POST /MyChart/Visits/VisitsList/LoadUpcoming": () => html(JSON.stringify(upcomingPayload())),
    });

    await expect(client(stub).loadUpcoming(OWNER_ZONE)).resolves.toHaveLength(4);
  });
});

describe("isSessionAlive via Home/KeepAlive", () => {
  it("prefers KeepAlive and never falls back when it answers a scalar", async () => {
    const stub = routed({ "GET /MyChart/Home/KeepAlive": () => json(1) });

    await expect(client(stub).isSessionAlive()).resolves.toBe(true);
    expect(stub.calls).toHaveLength(1);
    expect(new URL(stub.calls[0]?.url ?? "").searchParams.get("cnt")).toBe("1");
  });

  it("is false without a fallback when KeepAlive itself bounces to login", async () => {
    const stub = routed({
      "GET /MyChart/Home/KeepAlive": () => redirect(`${HOST}/MyChart/Authentication/Login`),
      "GET /MyChart/Authentication/Login": () => html(loginPageNew()),
      "GET /MyChart/Home": () => html(HOME_PAGE),
    });

    await expect(client(stub).isSessionAlive()).resolves.toBe(false);
    expect(find(stub, "GET", "/MyChart/Home")).toBeUndefined();
  });

  it("falls back to Home when the deployment does not serve KeepAlive", async () => {
    const stub = routed({ "GET /MyChart/Home": () => html(HOME_PAGE) });

    await expect(client(stub).isSessionAlive()).resolves.toBe(true);
    expect(find(stub, "GET", "/MyChart/Home")).toBeDefined();
  });

  it("falls back to Home when KeepAlive answers a whole page", async () => {
    const stub = routed({
      "GET /MyChart/Home/KeepAlive": () => html(HOME_PAGE),
      "GET /MyChart/Home": () => html(HOME_PAGE),
    });

    await expect(client(stub).isSessionAlive()).resolves.toBe(true);
    expect(stub.calls).toHaveLength(2);
  });
});

describe("a deployment that signs in through OpenID Connect", () => {
  it("refuses to post a password at a login page that is a redirect stub", async () => {
    const stub = routed({ "GET /MyChart/Authentication/Login": () => html(OPENID_STUB_PAGE) });

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_parse_failed");
    // The credentials never went anywhere: the only call was the page fetch.
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.method).toBe("GET");
  });
});
