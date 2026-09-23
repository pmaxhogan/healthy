// Mount discovery decides where every later request goes, and it is the one part
// of the scrape that runs before the owner has been asked for anything. So the
// tests pin both halves of that: that it finds the right shape of login page
// across the variants that exist, and that it never sends a credential or
// carries a cookie while doing it.

import { describe, expect, it } from "vitest";

import {
  candidateMounts,
  discoverPortal,
  mountFromLandedUrl,
} from "../../../../worker/ehr/mychart/discovery.ts";
import { noopLogger } from "../../../../worker/lib/log.ts";

import {
  ALIAS,
  CHALLENGE_PAGE,
  LOGIN_PAGE_WITH_INNOCENT_MARKERS,
  HOST,
  loginPageNew,
  loginPageOld,
  loginPageWithLoginField,
  metaRedirectPage,
  NOT_A_LOGIN_PAGE,
  openIdStubWithBodyRedirect,
  openIdStubWithNoscriptFallback,
  OPENID_STUB_PAGE,
  redirect,
  routed,
  scriptRedirectPage,
  html,
  stubPortal,
  TOKEN,
} from "./fixtures.ts";

import type { PortalFetchStub } from "./fixtures.ts";
import type { AppError } from "../../../../worker/lib/errors.ts";

/**
 * `HOST` over plain http.
 *
 * Derived rather than written out: a literal `http://` URL in this repository is
 * rewritten to `https://` by an eslint fixer, which would quietly turn the two
 * downgrade tests below into tests of nothing.
 */
const INSECURE_HOST = HOST.replace("https://", "http://");

function deps(stub: PortalFetchStub, mountHint?: string) {
  return {
    fetchImpl: stub.fetchImpl,
    logger: noopLogger,
    ...(mountHint !== undefined && { mountHint }),
  };
}

/** Kick off a discovery against the stub, so an assertion stays shallow. */
function probeFor(stub: PortalFetchStub): Promise<unknown> {
  return discoverPortal(HOST, deps(stub));
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await appErrorOf(promise);
  return error.code;
}

/** The `AppError` a promise rejected with, so `details` can be asserted too. */
async function appErrorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected the promise to reject");
}

describe("candidateMounts", () => {
  it("puts the owner's hint first and normalises it", () => {
    expect(candidateMounts("prd")).toStrictEqual(["/prd/", "/MyChart/", "/"]);
  });

  it("does not probe the same mount twice for a differently spelled hint", () => {
    expect(candidateMounts("/MyChart")).toStrictEqual(["/MyChart/", "/", "/prd/"]);
  });

  it("falls back to the generic list when there is no hint", () => {
    expect(candidateMounts()).toStrictEqual(["/MyChart/", "/", "/prd/"]);
    expect(candidateMounts(" ".repeat(3))).toStrictEqual(["/MyChart/", "/", "/prd/"]);
  });
});

describe("mountFromLandedUrl", () => {
  it("reads the mount out of the URL the login page answered on", () => {
    expect(mountFromLandedUrl(`${HOST}/prd/Authentication/Login`, "/")).toBe("/prd/");
    expect(mountFromLandedUrl(`${HOST}/Authentication/Login`, "/MyChart/")).toBe("/");
  });

  it("falls back to the candidate when the URL is not a login page", () => {
    expect(mountFromLandedUrl(`${HOST}/somewhere/else`, "MyChart")).toBe("/MyChart/");
    expect(mountFromLandedUrl("not a url", "MyChart")).toBe("/MyChart/");
  });
});

describe("discoverPortal", () => {
  it("finds an old-style form, whose username field is Username", async () => {
    const stub = routed({
      [`GET /MyChart/Authentication/Login`]: () => html(loginPageOld()),
    });

    await expect(discoverPortal(HOST, deps(stub))).resolves.toStrictEqual({
      baseUrl: HOST,
      mountPath: "/MyChart/",
      usernameField: "Username",
      antiforgeryFieldName: "__RequestVerificationToken",
      flavor: "classic",
    });
  });

  it("finds a new-style form, whose username field is LoginIdentifier", async () => {
    const stub = routed({
      [`GET /MyChart/Authentication/Login`]: () => html(loginPageNew()),
    });

    await expect(discoverPortal(HOST, deps(stub))).resolves.toMatchObject({
      usernameField: "LoginIdentifier",
    });
  });

  it("finds a third-style form, whose username field is the plain Login", async () => {
    const stub = routed({
      [`GET /MyChart/Authentication/Login`]: () => html(loginPageWithLoginField()),
    });

    await expect(discoverPortal(HOST, deps(stub))).resolves.toMatchObject({
      mountPath: "/MyChart/",
      usernameField: "Login",
      antiforgeryFieldName: "__RequestVerificationToken",
      flavor: "classic",
    });
  });

  it("moves on to the next mount when the first answers 404", async () => {
    const stub = routed({
      [`GET /Authentication/Login`]: () => html(loginPageNew()),
    });

    await expect(discoverPortal(HOST, deps(stub))).resolves.toMatchObject({ mountPath: "/" });
    expect(stub.calls.map((call) => new URL(call.url).pathname)).toStrictEqual([
      "/MyChart/Authentication/Login",
      "/Authentication/Login",
    ]);
  });

  it("follows a same-origin script redirect and takes the mount from where it landed", async () => {
    const stub = stubPortal((call) => {
      const { pathname } = new URL(call.url);
      if (pathname === "/MyChart/Authentication/Login") {
        return html(scriptRedirectPage(`${HOST}/prd/Authentication/Login`));
      }
      return pathname === "/prd/Authentication/Login"
        ? html(loginPageNew())
        : new Response("not found", { status: 404 });
    });

    await expect(discoverPortal(HOST, deps(stub))).resolves.toStrictEqual({
      baseUrl: HOST,
      mountPath: "/prd/",
      usernameField: "LoginIdentifier",
      antiforgeryFieldName: "__RequestVerificationToken",
      flavor: "classic",
    });
  });

  it("follows a same-origin meta-refresh redirect the same way", async () => {
    const stub = stubPortal((call) => {
      const { pathname } = new URL(call.url);
      if (pathname === "/MyChart/Authentication/Login") {
        return html(metaRedirectPage(`${HOST}/prd/Authentication/Login`));
      }
      return pathname === "/prd/Authentication/Login"
        ? html(loginPageNew())
        : new Response("not found", { status: 404 });
    });

    await expect(discoverPortal(HOST, deps(stub))).resolves.toMatchObject({
      baseUrl: HOST,
      mountPath: "/prd/",
    });
  });

  it.each([
    ["a script redirect", scriptRedirectPage],
    ["a meta refresh", metaRedirectPage],
  ])("never follows %s across an origin, even to the same site", async (_label, page) => {
    // A body-level redirect is content the page chose, and it is the cheapest
    // thing for a compromised page to inject: a `window.location` in a plain 200
    // used to relocate discovery -- and therefore where the owner's password gets
    // POSTed -- to any origin at all. Not followed, so the alias simply looks
    // like a host with no login page on it.
    const stub = stubPortal((call) => {
      const { origin, pathname } = new URL(call.url);
      if (origin === ALIAS) return html(page(`${HOST}/prd/Authentication/Login`));
      return pathname === "/prd/Authentication/Login"
        ? html(loginPageNew())
        : new Response("not found", { status: 404 });
    });

    const code = await codeOf(discoverPortal(ALIAS, deps(stub)));

    expect(code).toBe("portal_parse_failed");
    // The real login page was never reached, so nothing about it was learned.
    const origins = stub.calls.map((call) => new URL(call.url).origin);
    expect([...new Set(origins)]).toStrictEqual([ALIAS]);
  });

  it("refuses a Location header that leaves the site, naming where it went", async () => {
    const stub = stubPortal(() => redirect("https://attacker.example/MyChart/Login"));

    const error = await appErrorOf(discoverPortal(HOST, deps(stub)));
    // Wrapped by the API route into `portal_discovery_failed`; the adapter itself
    // reports the specific code and the origin the chain tried to reach, which is
    // the one host this surface ever names.
    expect(error.code).toBe("portal_redirected_offsite");
    expect(error.details?.landedOrigin).toBe("https://attacker.example");
  });

  it("refuses a Location header that downgrades to http, on the same host", async () => {
    const stub = stubPortal(() => redirect(`${INSECURE_HOST}/MyChart/Authentication/Login`));

    const error = await appErrorOf(discoverPortal(HOST, deps(stub)));
    expect(error.code).toBe("portal_insecure_redirect");
    // A scheme, never a host: this detail does reach the logs.
    expect(error.details).toStrictEqual({ endpoint: "Login", scheme: "http:" });
  });

  it("refuses to probe a non-https URL at all", async () => {
    const stub = stubPortal(() => html(loginPageNew()));

    const code = await codeOf(discoverPortal(INSECURE_HOST, deps(stub)));

    expect(code).toBe("portal_insecure_redirect");
    expect(stub.calls).toStrictEqual([]);
  });

  it("follows a Location header and keeps the mount it landed on", async () => {
    const stub = stubPortal((call) => {
      const { pathname } = new URL(call.url);
      if (pathname === "/MyChart/Authentication/Login") {
        return redirect(`${HOST}/prd/Authentication/Login`);
      }
      return pathname === "/prd/Authentication/Login"
        ? html(loginPageNew())
        : new Response("not found", { status: 404 });
    });

    await expect(discoverPortal(HOST, deps(stub))).resolves.toMatchObject({ mountPath: "/prd/" });
  });

  it("treats a 301 that lands on a 404 as 'not here' and moves to the next candidate", async () => {
    // A vanity mount that exists but answers with a trailing-slash redirect to a
    // path that turns out not to be the login page after all -- the redirect is
    // followed (by `portalFetch`), and the resulting 404 is just another reason
    // to try the next candidate, not a discovery failure.
    const stub = routed({
      "GET /MyChart/Authentication/Login": () =>
        redirect(`${HOST}/MyChart/Authentication/Login/`, [], 301),
      "GET /MyChart/Authentication/Login/": () => new Response("not found", { status: 404 }),
      "GET /Authentication/Login": () => html(loginPageNew()),
    });

    await expect(discoverPortal(HOST, deps(stub))).resolves.toMatchObject({ mountPath: "/" });
    expect(stub.calls.map((call) => new URL(call.url).pathname)).toStrictEqual([
      "/MyChart/Authentication/Login",
      "/MyChart/Authentication/Login/",
      "/Authentication/Login",
    ]);
  });

  it("is not fooled by a login page that merely carries a reCAPTCHA tag", async () => {
    // The commonest false positive there is: plenty of login pages load the
    // script and never show a challenge. Reading that as a bot block would
    // abandon discovery before a single mount had been tried.
    const stub = routed({
      "GET /MyChart/Authentication/Login": () => html(LOGIN_PAGE_WITH_INNOCENT_MARKERS),
    });

    await expect(discoverPortal(HOST, deps(stub))).resolves.toMatchObject({
      mountPath: "/MyChart/",
      usernameField: "LoginIdentifier",
    });
  });

  it("reports portal_bot_blocked for a 403 and stops probing", async () => {
    const stub = stubPortal(() => new Response("no", { status: 403 }));

    await expect(codeOf(probeFor(stub))).resolves.toBe("portal_bot_blocked");
    expect(stub.calls).toHaveLength(1);
  });

  it("reports portal_bot_blocked for a challenge page served with a 200", async () => {
    const stub = stubPortal(() => html(CHALLENGE_PAGE));

    await expect(codeOf(probeFor(stub))).resolves.toBe("portal_bot_blocked");
  });

  it("reports portal_unreachable when nothing answers", async () => {
    const stub = stubPortal(() => {
      throw new TypeError("connection refused");
    });

    await expect(codeOf(probeFor(stub))).resolves.toBe("portal_unreachable");
  });

  it("reports portal_parse_failed when every mount answers something that is not a login page", async () => {
    const stub = stubPortal(() => html(NOT_A_LOGIN_PAGE));

    await expect(codeOf(probeFor(stub))).resolves.toBe("portal_parse_failed");
    expect(stub.calls).toHaveLength(3);
  });

  it("refuses a login page it cannot drive: a password box but no known username field", async () => {
    const stub = stubPortal(() =>
      html(`<form><input name="Password" type="password"/><input name="Email"/></form>`),
    );

    await expect(codeOf(probeFor(stub))).resolves.toBe("portal_parse_failed");
  });

  it("refuses a login page with no antiforgery token", async () => {
    const stub = routed({
      [`GET /MyChart/Authentication/Login`]: () =>
        html(`<form><input name="LoginIdentifier"/><input name="Password"/></form>`),
      [`GET /Authentication/Login`]: () => new Response("not found", { status: 404 }),
      [`GET /prd/Authentication/Login`]: () => new Response("not found", { status: 404 }),
    });

    await expect(codeOf(probeFor(stub))).resolves.toBe("portal_parse_failed");
  });

  it("rejects a base URL that is not a URL", async () => {
    const stub = stubPortal(() => html(loginPageNew()));

    const attempt = discoverPortal("nonsense", deps(stub));

    await expect(codeOf(attempt)).resolves.toBe("bad_request");
    expect(stub.calls).toHaveLength(0);
  });

  it("never sends a credential and never carries a cookie", async () => {
    const stub = stubPortal((call) => {
      const { pathname } = new URL(call.url);
      if (pathname === "/MyChart/Authentication/Login") {
        return redirect(`${HOST}/prd/Authentication/Login`, ["MCSession=planted; Path=/; Secure"]);
      }
      return pathname === "/prd/Authentication/Login"
        ? html(loginPageNew())
        : new Response("not found", { status: 404 });
    });

    await discoverPortal(HOST, deps(stub));

    for (const call of stub.calls) {
      expect(call.method).toBe("GET");
      expect(call.body).toBeUndefined();
      // No jar in discovery, so a cookie planted by a probe cannot travel.
      expect(call.headers.cookie).toBeUndefined();
    }
  });

  it("discovers a classic login page whose own clickjacking guard would otherwise look like a redirect", async () => {
    // `top.location = ...` in this guard's `else` branch fires only when
    // framed, and `bodyRedirectTarget` never reads it as a redirect at all
    // (see `SCRIPT_ASSIGN`) -- but the login-form recognition is the belt on
    // top of that braces: only the login route is stubbed, so following the
    // guard at all, by any means, would 404 the whole discovery.
    const stub = routed({
      "GET /MyChart/Authentication/Login": () =>
        html(`<!doctype html><html><head><script>
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
        </body></html>`),
    });

    await expect(discoverPortal(HOST, deps(stub))).resolves.toStrictEqual({
      baseUrl: HOST,
      mountPath: "/MyChart/",
      usernameField: "LoginIdentifier",
      antiforgeryFieldName: "__RequestVerificationToken",
      flavor: "classic",
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("recognises the login page before following an unrelated same-origin location.replace on it", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/Login": () =>
        html(`<!doctype html><html><head><script>
          if (window.someUnrelatedFlag) location.replace("/MyChart/somewhere-else");
        </script></head><body>
          <form action="/MyChart/Authentication/Login/DoLogin" method="post">
            <input type="hidden" name="__RequestVerificationToken" value="${TOKEN}" />
            <input type="text" name="LoginIdentifier" value="" />
            <input type="password" name="Password" value="" />
          </form>
        </body></html>`),
    });

    await expect(discoverPortal(HOST, deps(stub))).resolves.toMatchObject({
      mountPath: "/MyChart/",
      usernameField: "LoginIdentifier",
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("probes only the login page, with a browser-shaped request", async () => {
    const stub = routed({
      [`GET /MyChart/Authentication/Login`]: () => html(loginPageNew(TOKEN)),
    });

    await discoverPortal(HOST, deps(stub, "MyChart"));

    const [call] = stub.calls;
    expect(call?.redirect).toBe("manual");
    expect(call?.headers["user-agent"]).toContain("Mozilla/5.0");
    expect(call?.headers.accept).toContain("text/html");
    // No body means no Content-Type: a GET must not look like a form post.
    expect(call?.headers["content-type"]).toBeUndefined();
  });
});

describe("discoverPortal: the custom OpenID flavour", () => {
  it("reports custom_oidc when the login page 302s to the OpenID stub", async () => {
    const stub = routed({
      "GET /prd/Authentication/Login": () =>
        redirect(`${HOST}/prd/OpenId?op=synthetic-op&forceAuthn=False`),
      "GET /prd/OpenId": () => html(OPENID_STUB_PAGE),
    });

    await expect(discoverPortal(HOST, deps(stub, "prd"))).resolves.toStrictEqual({
      baseUrl: HOST,
      mountPath: "/prd/",
      usernameField: "Username",
      antiforgeryFieldName: "__RequestVerificationToken",
      flavor: "custom_oidc",
      authBaseUrl: HOST,
    });
  });

  it("finds the OpenID handoff at the owner's hint, without ever probing the generic mounts", async () => {
    // An org-specific mount that only the owner could have named: none of the
    // generic candidates answer anything but 404 there, so a hint that is
    // probed first (and returns immediately on a match) is the only way this
    // deployment is ever found.
    const stub = routed({
      "GET /orgseg/Authentication/Login": () => redirect(`${HOST}/orgseg/OpenId?op=synthetic-op`),
      "GET /orgseg/OpenId": () => html(OPENID_STUB_PAGE),
    });

    await expect(discoverPortal(HOST, deps(stub, "orgseg"))).resolves.toMatchObject({
      mountPath: "/orgseg/",
      flavor: "custom_oidc",
    });
    expect(stub.calls.map((call) => new URL(call.url).pathname)).toStrictEqual([
      "/orgseg/Authentication/Login",
      "/orgseg/OpenId",
    ]);
  });

  it("takes the mount from the OpenID URL, where the login path no longer is", async () => {
    const stub = routed({
      "GET /Authentication/Login": () => redirect(`${HOST}/prd/OpenId?op=synthetic-op`),
      "GET /prd/OpenId": () => html(OPENID_STUB_PAGE),
    });

    await expect(discoverPortal(HOST, deps(stub, "/"))).resolves.toMatchObject({
      mountPath: "/prd/",
      flavor: "custom_oidc",
    });
  });

  it("reports custom_oidc from the body marker when the stub is served in place", async () => {
    // No redirect to read: the stub *is* the login page. Only the controller
    // script tells it apart from a page that is simply not a login form.
    const stub = routed({ "GET /MyChart/Authentication/Login": () => html(OPENID_STUB_PAGE) });

    await expect(discoverPortal(HOST, deps(stub))).resolves.toMatchObject({
      mountPath: "/MyChart/",
      flavor: "custom_oidc",
    });
  });

  it("records the shell API base when the stub happens to name one, and omits it otherwise", async () => {
    const withHint = OPENID_STUB_PAGE.replace(
      "<body>",
      `<body><script>var apiBase = "/shellwebapi/";</script>`,
    );
    const hinted = routed({ "GET /MyChart/Authentication/Login": () => html(withHint) });
    const bare = routed({ "GET /MyChart/Authentication/Login": () => html(OPENID_STUB_PAGE) });

    await expect(discoverPortal(HOST, deps(hinted))).resolves.toMatchObject({
      apiBasePath: "/shellwebapi",
    });
    // Not guessed, and never defaulted: the real value names the organisation.
    const withoutHint = await discoverPortal(HOST, deps(bare));
    expect(Object.hasOwn(withoutHint, "apiBasePath")).toBe(false);
  });

  it("marks a classic login form as the classic flavour", async () => {
    const stub = routed({ "GET /MyChart/Authentication/Login": () => html(loginPageNew()) });

    await expect(discoverPortal(HOST, deps(stub))).resolves.toMatchObject({ flavor: "classic" });
  });

  it("recognises the stub even though it carries a noscript fallback for browsers without JS", async () => {
    // The chain a live custom_oidc deployment was found to answer with:
    // Login -> 302 -> OpenId, whose 200 body is the handoff stub *and* a
    // <noscript><meta refresh> to a no-JS page. A browser with JavaScript
    // enabled -- which this client impersonates -- never follows that refresh,
    // so neither may this scrape.
    const stub = routed({
      "GET /prd/Authentication/Login": () =>
        redirect(`${HOST}/prd/OpenId?op=synthetic-op&forceAuthn=False`),
      "GET /prd/OpenId": () => html(openIdStubWithNoscriptFallback(`${HOST}/prd/nojs.asp`)),
      "GET /prd/nojs.asp": () => html(NOT_A_LOGIN_PAGE),
    });

    await expect(discoverPortal(HOST, deps(stub, "prd"))).resolves.toMatchObject({
      flavor: "custom_oidc",
      mountPath: "/prd/",
    });
    // The no-JS fallback is never reached.
    expect(stub.calls.map((call) => new URL(call.url).pathname)).toStrictEqual([
      "/prd/Authentication/Login",
      "/prd/OpenId",
    ]);
  });

  it("recognises the stub before following a body redirect that is not inside noscript at all", async () => {
    // Belt and braces beyond the noscript fix: the stub's own markers are
    // checked before any body-level hop is considered, so an unrelated body
    // redirect elsewhere on the stub page cannot walk discovery past it either.
    const stub = routed({
      "GET /prd/Authentication/Login": () => redirect(`${HOST}/prd/OpenId?op=synthetic-op`),
      "GET /prd/OpenId": () => html(openIdStubWithBodyRedirect(`${HOST}/prd/somewhere-else`)),
      "GET /prd/somewhere-else": () => html(NOT_A_LOGIN_PAGE),
    });

    await expect(discoverPortal(HOST, deps(stub, "prd"))).resolves.toMatchObject({
      flavor: "custom_oidc",
      mountPath: "/prd/",
    });
    expect(stub.calls.map((call) => new URL(call.url).pathname)).toStrictEqual([
      "/prd/Authentication/Login",
      "/prd/OpenId",
    ]);
  });
});
