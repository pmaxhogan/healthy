// Mount discovery decides where every later request goes, and it is the one part
// of the scrape that runs before the owner has been asked for anything. So the
// tests pin both halves of that: that it finds the right shape of login page
// across the variants that exist, and that it never sends a credential or
// carries a cookie while doing it.

import { describe, expect, it } from "vitest";

import { noopLogger } from "../../../../worker/lib/log.ts";
import {
  candidateMounts,
  discoverPortal,
  mountFromLandedUrl,
} from "../../../../worker/providers/mychart/discovery.ts";

import {
  ALIAS,
  CHALLENGE_PAGE,
  LOGIN_PAGE_WITH_INNOCENT_MARKERS,
  HOST,
  loginPageNew,
  loginPageOld,
  META_REDIRECT_PAGE,
  NOT_A_LOGIN_PAGE,
  OPENID_STUB_PAGE,
  redirect,
  routed,
  SCRIPT_REDIRECT_PAGE,
  html,
  stubPortal,
  TOKEN,
} from "./fixtures.ts";

import type { PortalFetchStub } from "./fixtures.ts";
import type { AppError } from "../../../../worker/lib/errors.ts";

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
  try {
    await promise;
  } catch (error) {
    return (error as AppError).code;
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

  it("follows a script redirect to another host and takes the mount from where it landed", async () => {
    const stub = stubPortal((call) => {
      const { origin, pathname } = new URL(call.url);
      if (origin === ALIAS) return html(SCRIPT_REDIRECT_PAGE);
      return pathname === "/prd/Authentication/Login"
        ? html(loginPageNew())
        : new Response("not found", { status: 404 });
    });

    await expect(discoverPortal(ALIAS, deps(stub))).resolves.toStrictEqual({
      baseUrl: HOST,
      mountPath: "/prd/",
      usernameField: "LoginIdentifier",
      antiforgeryFieldName: "__RequestVerificationToken",
      flavor: "classic",
    });
  });

  it("follows a meta-refresh redirect the same way", async () => {
    const stub = stubPortal((call) => {
      const { origin, pathname } = new URL(call.url);
      if (origin === ALIAS) return html(META_REDIRECT_PAGE);
      return pathname === "/prd/Authentication/Login"
        ? html(loginPageNew())
        : new Response("not found", { status: 404 });
    });

    await expect(discoverPortal(ALIAS, deps(stub))).resolves.toMatchObject({
      baseUrl: HOST,
      mountPath: "/prd/",
    });
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
});
