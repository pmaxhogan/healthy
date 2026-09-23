// The custom flavour has to make three unrelated HTTP conversations look like the
// same three calls the classic pages expose, and it has to leave a live classic
// session behind. So these tests are about two things above all:
//
//  - the *sequence*: which endpoint is called, with which body, in which order,
//    and that the OpenID bridge actually walks from the handoff stub to a page
//    behind the login wall;
//  - what survives between Worker invocations. The emailed code is submitted by a
//    brand-new client in a later invocation, so the correlation id and the user id
//    have to come back out of the sealed jar or the whole two-step is dead.
//
// Every response here was written by hand. No host, no mount, no API base, no
// organisation and no identifier came from a real deployment.

import { describe, expect, it } from "vitest";

import { noopLogger } from "../../../../worker/lib/log.ts";
import { CookieJar } from "../../../../worker/providers/mychart/cookie-jar.ts";
import { createCustomOidcClient } from "../../../../worker/providers/mychart/custom-oidc/client.ts";

import {
  HOME_PAGE,
  HOST,
  html,
  json,
  openIdRequestPage,
  openIdResponsePage,
  redirect,
  RESULT_TOKEN,
  routed,
  stubPortal,
} from "./fixtures.ts";

import type { PortalCall, PortalFetchStub } from "./fixtures.ts";
import type { AppError } from "../../../../worker/lib/errors.ts";
import type { PortalClient } from "../../../../worker/providers/mychart/client.ts";
import type { PortalCustomSettings } from "../../../../worker/providers/mychart/custom-oidc/client.ts";
import type { PortalEndpoint } from "../../../../worker/providers/mychart/discovery.ts";

const T0 = 1_767_225_600;
/** The correlation id `sendCode` mints from the injected clock. */
const CLIENT_ID = T0 * 1000;
const MOUNT = "/prd/";
/** An invented API base. A real one names the organisation and is never in source. */
const API_BASE = "/shellwebapi";
const CREDENTIALS = { username: "owner-login", password: "owner-password" };
const OWNER_ZONE = "UTC";
/** The shell's lower-cased user id, which every MFA call is keyed on. */
const USER_ID = "owner-login";
const CONTACT = "codes@example.test";

const ENDPOINT: PortalEndpoint = {
  baseUrl: HOST,
  mountPath: MOUNT,
  usernameField: "Username",
  antiforgeryFieldName: "__RequestVerificationToken",
  flavor: "custom_oidc",
  authBaseUrl: HOST,
  apiBasePath: API_BASE,
};

/** The same endpoint as discovery leaves it when the stub named no API base. */
const ENDPOINT_WITHOUT_API_BASE: PortalEndpoint = {
  baseUrl: HOST,
  mountPath: MOUNT,
  usernameField: "Username",
  antiforgeryFieldName: "__RequestVerificationToken",
  flavor: "custom_oidc",
  authBaseUrl: HOST,
};

function client(
  stub: PortalFetchStub,
  jar = new CookieJar({ now: () => T0 }),
  overrides: { endpoint?: PortalEndpoint; custom?: PortalCustomSettings } = {},
): PortalClient {
  return createCustomOidcClient({
    endpoint: overrides.endpoint ?? ENDPOINT,
    jar,
    fetchImpl: stub.fetchImpl,
    logger: noopLogger,
    now: () => T0,
    random: () => 0.5,
    ...(overrides.custom !== undefined && { custom: overrides.custom }),
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

async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return (error as AppError).details?.reason;
  }
  throw new Error("expected the promise to reject");
}

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected the promise to reject");
}

function find(stub: PortalFetchStub, method: string, suffix: string): PortalCall | undefined {
  return stub.calls.find(
    (call) => call.method === method && new URL(call.url).pathname.endsWith(suffix),
  );
}

function paths(stub: PortalFetchStub): string[] {
  return stub.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);
}

/** The session cookie the synthetic classic side sets on finalize. */
const SESSION_COOKIE = "SyntheticChartSession";
/** The synthetic SSO token the shell answers with. */
const YUM = "synthetic-yum";
const AUTH_CODE = "synthetic-auth-code";
const STATE = "synthetic-state";
const RESULT_PATH = "/prd/OpenId/AuthorizeResult";

/**
 * A synthetic authorization URL with the captured structure: the shell's own
 * authorize route, and the ten query parameters the capture's had, in order.
 */
function authorizeUrl(overrides: Record<string, string | null> = {}): string {
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: "synthetic-client",
    redirect_uri: `${HOST}${RESULT_PATH}`,
    state: STATE,
    scope: "openid",
    code_challenge: "synthetic-challenge",
    code_challenge_method: "S256",
    response_mode: "query",
    nonce: "synthetic-nonce",
    ui_locales: "en-US",
    ...overrides,
  };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== null) query.set(key, value);
  return `${HOST}/app/oauth2/authorize?${query.toString()}`;
}

type Route = (call: PortalCall) => Response;

/**
 * The whole captured hand-off, route by route, with enough state to fail the
 * way a real portal would if a step were skipped: the stub only renders once
 * the `yum` cookie is present, and `Home` is only signed in once finalize's
 * session cookie comes back.
 */
function handoffRoutes(): Record<string, Route> {
  return {
    "POST /shellwebapi/sso/token": () => json({ yum: YUM, mychartRegionUrl: "/prd/" }),
    "GET /prd/Authentication/Login": (call) =>
      (call.headers.cookie ?? "").includes(`yum=${YUM}`)
        ? redirect(`${HOST}/prd/OpenId?forceAuthn=true&op=synthetic-op`)
        : html("<!doctype html><html><body>no sso token</body></html>"),
    "GET /prd/OpenId": () => html(openIdRequestPage(authorizeUrl())),
    "POST /shellwebapi/api/mychartAuth/getAuthCode": () => json({ authCode: AUTH_CODE }),
    "GET /prd/OpenId/AuthorizeResult": () => html(openIdResponsePage(AUTH_CODE, STATE)),
    "POST /prd/OpenId/FinalizeAuthResponse": () => {
      const headers = new Headers();
      headers.append("set-cookie", `${SESSION_COOKIE}=synthetic-session; Path=/prd/; Secure`);
      return json({ redirectUri: "/prd/Home" }, { headers });
    },
    "GET /prd/Home": (call) =>
      (call.headers.cookie ?? "").includes(`${SESSION_COOKIE}=`)
        ? html(HOME_PAGE)
        : redirect(`${HOST}/prd/Authentication/Login`),
  };
}

/** Answer a route table whose handlers can see the request. */
function portal(routes: Record<string, Route>): PortalFetchStub {
  return stubPortal((call) => {
    const route = routes[`${call.method} ${new URL(call.url).pathname}`];
    return route === undefined ? new Response("not found", { status: 404 }) : route(call);
  });
}

/** The captured login response's shape, with invented values. */
function loginResponse(mfa: boolean, extra: Record<string, unknown> = {}): Response {
  return json({
    isMfaReminderOff: false,
    isSkipChallengeQuestions: true,
    isAccountMerged: false,
    encryptedUserId: "synthetic-encrypted-user",
    userId: "OWNER-LOGIN",
    externalSsoMyChartQuery: "",
    isMfaEnabled: mfa,
    isTemporaryPassword: false,
    isPortalMfaEnabled: mfa,
    ...extra,
  });
}

/** A deployment whose password alone is enough: no code, straight to the bridge. */
function noCodePortal(overrides: Record<string, Route> = {}): PortalFetchStub {
  return portal({
    ...handoffRoutes(),
    "POST /shellwebapi/login": () => loginResponse(false),
    ...overrides,
  });
}

/** A deployment that wants an emailed code, and answers every MFA call. */
function twoStepPortal(login: Record<string, unknown> = {}): PortalFetchStub {
  return portal({
    ...handoffRoutes(),
    "POST /shellwebapi/login": () => loginResponse(true, { email: CONTACT, ...login }),
    "POST /shellwebapi/verification/code/generate": () => json({ success: true }),
    "POST /shellwebapi/verification/code/validate": () => json({ success: true }),
    "POST /shellwebapi/api/mfa/saveTrustThisDeviceToken": () => json({ success: true }),
    "POST /shellwebapi/api/mfa/validateTrustThisDeviceToken": () =>
      json({ temporaryPassword: false }),
  });
}

/** Every request the full hand-off makes, in the captured order. */
const HANDOFF_SEQUENCE = [
  "POST /shellwebapi/sso/token",
  "GET /prd/Authentication/Login",
  "GET /prd/OpenId",
  "POST /shellwebapi/api/mychartAuth/getAuthCode",
  "GET /prd/OpenId/AuthorizeResult",
  "POST /prd/OpenId/FinalizeAuthResponse",
  "GET /prd/Home",
];

describe("login", () => {
  it("posts lower-case username and password, form-urlencoded", async () => {
    const stub = twoStepPortal();

    await expect(client(stub).login(CREDENTIALS)).resolves.toBe("awaiting_code");

    const post = find(stub, "POST", "/shellwebapi/login");
    expect(post?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(post?.body ?? "");
    expect(form.get("username")).toBe(CREDENTIALS.username);
    expect(form.get("password")).toBe(CREDENTIALS.password);
    // None of the classic PascalCase names, and no antiforgery token anywhere.
    expect(form.get("LoginIdentifier")).toBeNull();
    expect(form.get("__RequestVerificationToken")).toBeNull();
  });

  it("stops at awaiting_code without touching the classic pages", async () => {
    const stub = twoStepPortal();

    await client(stub).login(CREDENTIALS);

    expect(paths(stub)).toStrictEqual(["POST /shellwebapi/login"]);
  });

  it("runs the OpenID bridge when the password alone was enough", async () => {
    const stub = noCodePortal();

    await expect(client(stub).login(CREDENTIALS)).resolves.toBe("signed_in");

    expect(paths(stub)).toStrictEqual(["POST /shellwebapi/login", ...HANDOFF_SEQUENCE]);
  });

  it("remembers the user id the shell answered with, lower-cased", async () => {
    const jar = new CookieJar({ now: () => T0 });

    await client(twoStepPortal(), jar).login(CREDENTIALS);

    expect(jar.getExtra("oidc.userId")).toBe(USER_ID);
  });

  it("reports portal_login_failed when the shell refuses the credentials", async () => {
    const stub = routed({
      "POST /shellwebapi/login": () => json({ success: false }, { status: 401 }),
    });

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_login_failed");
  });

  it("reports portal_login_failed on a 200 that says it signed nobody in", async () => {
    // The shell answers most refusals with a 4xx, but not all of them, and a
    // rejected password must not go on to the bridge and be blamed on the handoff.
    const stub = routed({
      "POST /shellwebapi/login": () => json({ authenticated: false }),
    });

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_login_failed");
  });

  it("reports portal_locked when the shell says the account is locked out", async () => {
    const stub = routed({
      "POST /shellwebapi/login": () =>
        json(
          {
            message:
              "Your account has been temporarily locked because you have exceeded the number of allowed attempts.",
          },
          { status: 401 },
        ),
    });

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_locked");
  });

  it("refuses to start at all when the shell API base is not known", async () => {
    const stub = twoStepPortal();

    const failing = client(stub, new CookieJar({ now: () => T0 }), {
      endpoint: ENDPOINT_WITHOUT_API_BASE,
    });
    await expect(codeOf(failing.login(CREDENTIALS))).resolves.toBe("portal_discovery_failed");
    // Nothing was sent: the password never left the Worker.
    expect(stub.calls).toStrictEqual([]);
  });

  it("takes the API base from the caller when discovery found none", async () => {
    const stub = twoStepPortal();

    const configured = client(stub, new CookieJar({ now: () => T0 }), {
      endpoint: ENDPOINT_WITHOUT_API_BASE,
      custom: { apiBasePath: API_BASE },
    });
    await expect(configured.login(CREDENTIALS)).resolves.toBe("awaiting_code");
  });
});

describe("secondaryValidation.sendCode", () => {
  it("posts the channel as the body key, with the correlation id and the host", async () => {
    const stub = twoStepPortal();
    const portal = client(stub);

    await portal.login(CREDENTIALS);
    await portal.secondaryValidation.sendCode("email");

    const post = find(stub, "POST", "/verification/code/generate");
    expect(post?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(post?.body ?? "{}")).toStrictEqual({
      email: CONTACT,
      userId: USER_ID,
      clientId: CLIENT_ID,
      portalHost: new URL(HOST).hostname,
      source: "OTHER",
    });
  });

  it("uses the owner's configured contact when the shell volunteered none", async () => {
    const stub = twoStepPortal({ email: null });
    const portal = client(stub, new CookieJar({ now: () => T0 }), {
      custom: { mfaContact: CONTACT },
    });

    await portal.login(CREDENTIALS);
    await portal.secondaryValidation.sendCode("email");

    expect(
      JSON.parse(find(stub, "POST", "/verification/code/generate")?.body ?? "{}"),
    ).toMatchObject({ email: CONTACT });
  });

  it("asks the shell for a contact as the last resort", async () => {
    const stub = routed({
      "POST /shellwebapi/login": () => json({ mfaRequired: true, userId: "OWNER-LOGIN" }),
      "GET /shellwebapi/api/mfa/contact/plain": () => json({ email: CONTACT }),
      "POST /shellwebapi/verification/code/generate": () => json({ success: true }),
    });
    const portal = client(stub);

    await portal.login(CREDENTIALS);
    await portal.secondaryValidation.sendCode("email");

    expect(find(stub, "GET", "/api/mfa/contact/plain")).toBeDefined();
    expect(
      JSON.parse(find(stub, "POST", "/verification/code/generate")?.body ?? "{}"),
    ).toMatchObject({ email: CONTACT });
  });

  it("reports mfa_contact_unknown rather than sending a code nowhere", async () => {
    const stub = routed({
      "POST /shellwebapi/login": () => json({ mfaRequired: true, userId: "OWNER-LOGIN" }),
    });
    const portal = client(stub);

    await portal.login(CREDENTIALS);
    const sending = portal.secondaryValidation.sendCode("email");
    await expect(reasonOf(sending)).resolves.toBe("mfa_contact_unknown");
  });

  it("reports user_id_unknown when the login response named nobody", async () => {
    const stub = routed({ "POST /shellwebapi/login": () => json({ mfaRequired: true }) });
    const portal = client(stub);

    await portal.login(CREDENTIALS);
    await expect(reasonOf(portal.secondaryValidation.sendCode("email"))).resolves.toBe(
      "user_id_unknown",
    );
  });

  it("reports portal_login_failed when the shell will not send a code", async () => {
    const stub = routed({
      "POST /shellwebapi/login": () =>
        json({ mfaRequired: true, userId: "OWNER-LOGIN", email: CONTACT }),
      "POST /shellwebapi/verification/code/generate": () =>
        json({ success: false }, { status: 400 }),
    });
    const portal = client(stub);

    await portal.login(CREDENTIALS);
    await expect(codeOf(portal.secondaryValidation.sendCode("email"))).resolves.toBe(
      "portal_login_failed",
    );
  });
});

/**
 * Sign in as far as the code, then hand the *sealed* jar to a fresh client.
 *
 * This is what the runner really does: the login and the code happen in two
 * Worker invocations, and everything the second one knows came out of D1.
 */
async function awaitingCode(stub: PortalFetchStub): Promise<PortalClient> {
  const first = client(stub);
  await first.login(CREDENTIALS);
  await first.secondaryValidation.sendCode("email");
  return client(stub, CookieJar.deserialise(first.jar.serialise(), { now: () => T0 }));
}

describe("secondaryValidation.validate", () => {
  it("submits the code with the same correlation id a later invocation inherits", async () => {
    const stub = twoStepPortal();
    const portal = await awaitingCode(stub);

    await portal.secondaryValidation.validate("123456");

    expect(
      JSON.parse(find(stub, "POST", "/verification/code/validate")?.body ?? "{}"),
    ).toStrictEqual({ token: "123456", clientId: CLIENT_ID });
  });

  it("mints its own trust-this-device token and posts it, rather than reading one back", async () => {
    const stub = twoStepPortal();
    const jar = new CookieJar({ now: () => T0 });
    const first = client(stub, jar);
    await first.login(CREDENTIALS);
    await first.secondaryValidation.sendCode("email");

    await first.secondaryValidation.validate("123456", true);

    // A cookie, not a posted field: nothing in the response chain sets it.
    expect(jar.has(HOST, `${USER_ID}-rememberMeToken`)).toBe(true);
    const save = find(stub, "POST", "/api/mfa/saveTrustThisDeviceToken");
    const body: unknown = JSON.parse(save?.body ?? "{}");
    expect(body).toStrictEqual({ userId: USER_ID, rememberMeToken: expect.any(String) });
    // The same value that was posted is the one the cookie carries -- this
    // client mints it, the shell never hands one back.
    const posted = (body as { rememberMeToken: string }).rememberMeToken;
    expect(jar.getCookieHeader(HOST)).toContain(`${USER_ID}-rememberMeToken=${posted}`);
  });

  it("does not ask to be trusted when rememberMe is off", async () => {
    const stub = twoStepPortal();
    const portal = await awaitingCode(stub);

    await portal.secondaryValidation.validate("123456", false);

    expect(find(stub, "POST", "/api/mfa/saveTrustThisDeviceToken")).toBeUndefined();
  });

  it("bridges into the classic session once the code is accepted", async () => {
    const stub = twoStepPortal();
    const portal = await awaitingCode(stub);

    await portal.secondaryValidation.validate("123456");

    expect(find(stub, "GET", "/prd/Home")).toBeDefined();
  });

  it("reports portal_2fa_rejected when the code is wrong", async () => {
    const stub = routed({
      "POST /shellwebapi/login": () =>
        json({ mfaRequired: true, userId: "OWNER-LOGIN", email: CONTACT }),
      "POST /shellwebapi/verification/code/generate": () => json({ success: true }),
      "POST /shellwebapi/verification/code/validate": () =>
        json({ success: false }, { status: 400 }),
    });
    const portal = await awaitingCode(stub);

    await expect(codeOf(portal.secondaryValidation.validate("000000"))).resolves.toBe(
      "portal_2fa_rejected",
    );
  });

  it("reports mfa_state_missing when the correlation id did not survive", async () => {
    const stub = twoStepPortal();
    const jar = new CookieJar({ now: () => T0 });
    // A login, then the code, with no `sendCode` in between: the correlation id
    // the shell expects was never minted.
    await client(stub, jar).login(CREDENTIALS);

    const portal = client(stub, jar);
    await expect(reasonOf(portal.secondaryValidation.validate("123456"))).resolves.toBe(
      "mfa_state_missing",
    );
  });
});

describe("the OpenID hand-off", () => {
  it("makes the captured sequence of requests and ends signed in on Home", async () => {
    const stub = noCodePortal();

    await expect(client(stub).login(CREDENTIALS)).resolves.toBe("signed_in");

    expect(paths(stub)).toStrictEqual(["POST /shellwebapi/login", ...HANDOFF_SEQUENCE]);
    // Never the shell's authorize page itself: it is an app, not an endpoint.
    expect(paths(stub)).not.toContain("GET /app/oauth2/authorize");
  });

  it("1. posts the literal string {} as text/plain for the SSO token", async () => {
    const stub = noCodePortal();

    await client(stub).login(CREDENTIALS);

    const post = find(stub, "POST", "/shellwebapi/sso/token");
    expect(post?.body).toBe("{}");
    expect(post?.headers["content-type"]).toBe("text/plain");
  });

  it("1. writes the SSO token as the yum cookie every classic hop then carries", async () => {
    const stub = noCodePortal();

    await client(stub).login(CREDENTIALS);

    for (const step of HANDOFF_SEQUENCE.slice(1)) {
      const [method = "", path = ""] = step.split(" ", 2);
      expect(find(stub, method, path)?.headers.cookie, step).toContain(`yum=${YUM}`);
    }
  });

  it("2. reaches the stub through the login path, and loads nothing from the shell's authorize route", async () => {
    const stub = noCodePortal();

    await client(stub).login(CREDENTIALS);

    const start = stub.calls.findIndex((call) => call.url.endsWith("/prd/Authentication/Login"));
    expect(stub.calls[start + 1]?.url).toBe(`${HOST}/prd/OpenId?forceAuthn=true&op=synthetic-op`);
  });

  it("3. trades the authorization request for a code with fields read off the stub's URL", async () => {
    const stub = noCodePortal();

    await client(stub).login(CREDENTIALS);

    const post = find(stub, "POST", "/api/mychartAuth/getAuthCode");
    expect(post?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(post?.body ?? "{}")).toStrictEqual({
      clientId: "synthetic-client",
      scope: "openid",
      responseType: "code",
      // Not a fresh id: the PKCE challenge, verbatim.
      guid: "synthetic-challenge",
      nonce: "synthetic-nonce",
    });
  });

  it("4. goes to the stub's redirect_uri with the code and the stub's state", async () => {
    const stub = noCodePortal();

    await client(stub).login(CREDENTIALS);

    const result = new URL(find(stub, "GET", RESULT_PATH)?.url ?? "");
    expect(`${result.origin}${result.pathname}`).toBe(`${HOST}${RESULT_PATH}`);
    expect(Object.fromEntries(result.searchParams)).toStrictEqual({
      code: AUTH_CODE,
      state: STATE,
    });
  });

  it("5. finalizes with the echoed values, the stub's encrypted ones and the result page's token", async () => {
    const stub = noCodePortal();

    await client(stub).login(CREDENTIALS);

    const post = find(stub, "POST", "/prd/OpenId/FinalizeAuthResponse");
    expect(post?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(post?.headers["x-requested-with"]).toBe("XMLHttpRequest");
    // The AuthorizeResult page's token, not the stub's.
    expect(post?.headers.__requestverificationtoken).toBe(RESULT_TOKEN);
    expect(new URL(post?.url ?? "").searchParams.get("noCache")).toBe("0.5");
    expect([...new URLSearchParams(post?.body ?? "")]).toStrictEqual([
      ["AuthCode", AUTH_CODE],
      ["StateFromOP", STATE],
      ["EncryptedNonce", "synthetic-enc-nonce"],
      ["EncryptedState", "synthetic-enc-state"],
      ["EncryptedCodeVerifier", "synthetic-enc-verifier"],
      ["Error", ""],
      ["ResponseMode", "query"],
      ["Issuer", ""],
    ]);
  });

  it("6. follows finalize's redirectUri to Home carrying the session it set", async () => {
    const stub = noCodePortal();

    await client(stub).login(CREDENTIALS);

    expect(find(stub, "GET", "/prd/Home")?.headers.cookie).toContain(`${SESSION_COOKIE}=`);
  });

  it("does not follow an off-site redirectUri, and asks Home instead", async () => {
    const stub = noCodePortal({
      "POST /prd/OpenId/FinalizeAuthResponse": () => {
        const headers = new Headers();
        headers.append("set-cookie", `${SESSION_COOKIE}=synthetic-session; Path=/prd/; Secure`);
        return json({ redirectUri: "https://elsewhere.example/prd/Home" }, { headers });
      },
    });

    await expect(client(stub).login(CREDENTIALS)).resolves.toBe("signed_in");
    expect(stub.calls.some((call) => call.url.startsWith("https://elsewhere.example"))).toBe(false);
  });

  const failures: [string, Record<string, Route>][] = [
    ["sso_token_refused", { "POST /shellwebapi/sso/token": () => json({}, { status: 401 }) }],
    ["sso_token_unreadable", { "POST /shellwebapi/sso/token": () => json({ other: "x" }) }],
    [
      "stub_unrecognized",
      { "GET /prd/OpenId": () => html("<!doctype html><html><body>oidcnonce</body></html>") },
    ],
    [
      "stub_submits_form",
      { "GET /prd/OpenId": () => html(openIdRequestPage(authorizeUrl(), true)) },
    ],
    [
      "authorize_url_unreadable",
      {
        "GET /prd/OpenId": () => html(openIdRequestPage(authorizeUrl({ code_challenge: null }))),
      },
    ],
    [
      "redirect_uri_offsite",
      {
        "GET /prd/OpenId": () =>
          html(
            openIdRequestPage(
              authorizeUrl({ redirect_uri: `https://elsewhere.example${RESULT_PATH}` }),
            ),
          ),
      },
    ],
    [
      "auth_code_refused",
      {
        "POST /shellwebapi/api/mychartAuth/getAuthCode": () =>
          json({ message: "invalid" }, { status: 400 }),
      },
    ],
    ["auth_code_unreadable", { "POST /shellwebapi/api/mychartAuth/getAuthCode": () => json({}) }],
    [
      "authorize_result_unrecognized",
      {
        "GET /prd/OpenId/AuthorizeResult": () =>
          html(`<input name="__RequestVerificationToken" type="hidden" value="${RESULT_TOKEN}" />`),
      },
    ],
    [
      "authorize_result_no_token",
      {
        "GET /prd/OpenId/AuthorizeResult": () =>
          html(openIdResponsePage(AUTH_CODE, STATE).replace(/<input[^>]*>/u, "")),
      },
    ],
    [
      "finalize_refused",
      { "POST /prd/OpenId/FinalizeAuthResponse": () => json({}, { status: 400 }) },
    ],
    ["finalize_unreadable", { "POST /prd/OpenId/FinalizeAuthResponse": () => json({}) }],
    [
      "not_signed_in",
      // Finalize answers, but sets no session: Home bounces to the login path.
      {
        "POST /prd/OpenId/FinalizeAuthResponse": () => json({ redirectUri: "/prd/Home" }),
      },
    ],
  ];

  it.each(failures)(
    "reports portal_handoff_failed with reason %s when that step fails",
    async (reason, overrides) => {
      const error = await failureOf(client(noCodePortal(overrides)).login(CREDENTIALS));

      expect(error.code).toBe("portal_handoff_failed");
      expect(error.details?.reason).toBe(reason);
    },
  );

  it("stops at the first failing step without making the later ones", async () => {
    const stub = noCodePortal({
      "POST /shellwebapi/api/mychartAuth/getAuthCode": () => json({}, { status: 400 }),
    });

    await codeOf(client(stub).login(CREDENTIALS));

    expect(find(stub, "GET", RESULT_PATH)).toBeUndefined();
    expect(find(stub, "POST", "/prd/OpenId/FinalizeAuthResponse")).toBeUndefined();
  });

  it("runs the same hand-off after an accepted emailed code", async () => {
    const stub = twoStepPortal();
    const portal = await awaitingCode(stub);

    await portal.secondaryValidation.validate("123456");

    const after = paths(stub).slice(
      paths(stub).indexOf("POST /shellwebapi/verification/code/validate"),
    );
    expect(after.filter((step) => HANDOFF_SEQUENCE.includes(step))).toStrictEqual(HANDOFF_SEQUENCE);
  });
});

/** A jar that already holds the trust cookie a previous sign-in minted. */
function trustedJar(): CookieJar {
  const jar = new CookieJar({ now: () => T0 });
  jar.setCookie(HOST, `${USER_ID}-rememberMeToken=synthetic-trust-token; Path=/; Secure`);
  return jar;
}

describe("a device the shell trusted before", () => {
  it("posts the trust token back and signs in without a code", async () => {
    const stub = twoStepPortal();

    await expect(client(stub, trustedJar()).login(CREDENTIALS)).resolves.toBe("signed_in");

    const check = find(stub, "POST", "/api/mfa/validateTrustThisDeviceToken");
    expect(check?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(check?.body ?? "{}")).toStrictEqual({
      userId: USER_ID,
      rememberMeToken: "synthetic-trust-token",
    });
    expect(paths(stub)).toStrictEqual([
      "POST /shellwebapi/login",
      "POST /shellwebapi/api/mfa/validateTrustThisDeviceToken",
      ...HANDOFF_SEQUENCE,
    ]);
    expect(find(stub, "POST", "/verification/code/generate")).toBeUndefined();
  });

  it("forgets the token and asks for a code when the shell answers 410", async () => {
    const stub = portal({
      ...handoffRoutes(),
      "POST /shellwebapi/login": () => loginResponse(true),
      "POST /shellwebapi/api/mfa/validateTrustThisDeviceToken": () => json({}, { status: 410 }),
    });
    const jar = trustedJar();

    await expect(client(stub, jar).login(CREDENTIALS)).resolves.toBe("awaiting_code");
    expect(jar.has(HOST, `${USER_ID}-rememberMeToken`)).toBe(false);
    expect(find(stub, "POST", "/shellwebapi/sso/token")).toBeUndefined();
  });

  it("keeps the token but asks for a code on any other refusal", async () => {
    const stub = portal({
      ...handoffRoutes(),
      "POST /shellwebapi/login": () => loginResponse(true),
      "POST /shellwebapi/api/mfa/validateTrustThisDeviceToken": () => json({}, { status: 400 }),
    });
    const jar = trustedJar();

    await expect(client(stub, jar).login(CREDENTIALS)).resolves.toBe("awaiting_code");
    expect(jar.has(HOST, `${USER_ID}-rememberMeToken`)).toBe(true);
  });

  it("asks for a code without calling the check when there is no trust cookie", async () => {
    const stub = twoStepPortal();

    await expect(client(stub).login(CREDENTIALS)).resolves.toBe("awaiting_code");
    expect(find(stub, "POST", "/api/mfa/validateTrustThisDeviceToken")).toBeUndefined();
  });

  it("wants a code only when both of the login response's MFA flags are set", async () => {
    const stub = noCodePortal({
      "POST /shellwebapi/login": () =>
        loginResponse(false, { isMfaEnabled: true, isPortalMfaEnabled: false }),
    });

    await expect(client(stub).login(CREDENTIALS)).resolves.toBe("signed_in");
  });
});

/** A shell that wants a code but whose login answer never says so. */
function silentMfaPortal(): PortalFetchStub {
  return portal({
    ...handoffRoutes(),
    // Still waiting for its code, so the shell will not mint an SSO token.
    "POST /shellwebapi/sso/token": () => json({}, { status: 401 }),
    "POST /shellwebapi/login": () => json({ userId: "OWNER-LOGIN" }),
    "POST /shellwebapi/verification/code/generate": () => json({ success: true }),
  });
}

describe("a login response that says nothing about a code", () => {
  it("asks for the code when the handoff then stops short of the classic session", async () => {
    const stub = silentMfaPortal();
    const jar = new CookieJar({ now: () => T0 });

    await expect(client(stub, jar).login(CREDENTIALS)).resolves.toBe("awaiting_code");
    // And the code can actually be requested: the user id survived.
    await client(stub, jar, { custom: { mfaContact: CONTACT } }).secondaryValidation.sendCode(
      "email",
    );
    expect(find(stub, "POST", "/shellwebapi/verification/code/generate")).toBeDefined();
  });

  it("still fails outright when the shell said the password signed us in", async () => {
    const stub = portal({
      ...handoffRoutes(),
      "POST /shellwebapi/sso/token": () => json({}, { status: 401 }),
      "POST /shellwebapi/login": () => json({ authenticated: true, userId: "OWNER-LOGIN" }),
    });

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_handoff_failed");
  });
});

describe("everything after sign-in", () => {
  it("reads the visits through the classic endpoints, unchanged", async () => {
    const stub = routed({
      "GET /prd/Visits/VisitsList": () =>
        html('<input name="__RequestVerificationToken" value="tok-1" />'),
      "POST /prd/Visits/VisitsList/LoadUpcoming": () =>
        json({ InProgressVisits: [], NextNDaysVisits: [], LaterVisitsList: [] }),
      "GET /prd/Home": () => html(HOME_PAGE),
    });
    const portal = client(stub);

    await expect(portal.loadUpcoming(OWNER_ZONE)).resolves.toStrictEqual([]);
    await expect(portal.isSessionAlive()).resolves.toBe(true);
    expect(find(stub, "POST", "/LoadUpcoming")?.headers.__requestverificationtoken).toBe("tok-1");
  });
});
