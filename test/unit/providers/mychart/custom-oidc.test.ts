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
  openIdFormPageWithNoscriptFallback,
  openIdRedirectPage,
  OPENID_FORM_PAGE,
  redirect,
  routed,
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

function find(stub: PortalFetchStub, method: string, suffix: string): PortalCall | undefined {
  return stub.calls.find(
    (call) => call.method === method && new URL(call.url).pathname.endsWith(suffix),
  );
}

function paths(stub: PortalFetchStub): string[] {
  return stub.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);
}

/** The hops that carry a shell session across to the classic pages. */
const BRIDGE_ROUTES: Record<string, () => Response> = {
  "GET /prd/Authentication/Login": () => redirect(`${HOST}/prd/OpenId?op=synthetic-op`),
  "GET /prd/OpenId": () => html(OPENID_FORM_PAGE),
  "POST /shell/api/oauth2/authorize": () =>
    redirect(`${HOST}/prd/OpenId/Callback?code=synthetic-code`),
  "GET /prd/OpenId/Callback": () =>
    redirect(`${HOST}/prd/Home`, ["EpicSession=synthetic-session; Path=/prd/; Secure"]),
  "GET /prd/Home": () => html(HOME_PAGE),
};

/** A deployment whose password alone is enough: no code, straight to the bridge. */
function noCodePortal(): PortalFetchStub {
  return routed({
    ...BRIDGE_ROUTES,
    "POST /shellwebapi/login": () => json({ authenticated: true, userId: "OWNER-LOGIN" }),
  });
}

/** A deployment that wants an emailed code, and answers every MFA call. */
function twoStepPortal(login: Record<string, unknown> = {}): PortalFetchStub {
  return routed({
    ...BRIDGE_ROUTES,
    "POST /shellwebapi/login": () =>
      json({ mfaRequired: true, userId: "OWNER-LOGIN", email: CONTACT, ...login }),
    "POST /shellwebapi/verification/code/generate": () => json({ success: true }),
    "POST /shellwebapi/verification/code/validate": () => json({ success: true }),
    "POST /shellwebapi/api/mfa/saveTrustThisDeviceToken": () => json({ success: true }),
  });
}

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

    expect(paths(stub)).toStrictEqual([
      "POST /shellwebapi/login",
      "GET /prd/Authentication/Login",
      "GET /prd/OpenId",
      "POST /shell/api/oauth2/authorize",
      "GET /prd/OpenId/Callback",
      "GET /prd/Home",
    ]);
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

describe("the OpenID bridge", () => {
  it("submits the stub's hidden authorization form rather than stopping there", async () => {
    const stub = noCodePortal();

    await client(stub).login(CREDENTIALS);

    const authorize = find(stub, "POST", "/api/oauth2/authorize");
    const form = new URLSearchParams(authorize?.body ?? "");
    // The server minted these; the bridge echoes them and mints no PKCE of its own.
    expect(form.get("code_challenge")).toBe("synthetic-challenge");
    expect(form.get("code_challenge_method")).toBe("S256");
    expect(form.get("state")).toBe("synthetic-state");
  });

  it("carries the session cookie planted on an intermediate hop", async () => {
    const stub = noCodePortal();

    await client(stub).login(CREDENTIALS);

    expect(find(stub, "GET", "/prd/Home")?.headers.cookie).toContain("EpicSession=");
  });

  it("reports portal_login_failed when a hop lands on the shell's own login screen", async () => {
    const stub = routed({
      "GET /prd/Authentication/Login": () => redirect(`${HOST}/prd/OpenId?op=synthetic-op`),
      "GET /prd/OpenId": () => redirect(`${HOST}/app/login`),
      "GET /app/login": () => html("<!doctype html><html><body>Sign in</body></html>"),
      "POST /shellwebapi/login": () => json({ authenticated: true, userId: "OWNER-LOGIN" }),
    });

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_login_failed");
    await expect(reasonOf(client(stub).login(CREDENTIALS))).resolves.toBe("shell_login");
  });

  it("reports no_further_hop when the chain stops somewhere that is not signed in", async () => {
    const stub = routed({
      "GET /prd/Authentication/Login": () => redirect(`${HOST}/prd/OpenId?op=synthetic-op`),
      // A stub with neither a form to submit nor an auth-code route to ask.
      "GET /prd/OpenId": () => html("<!doctype html><html><body>oidcnonce</body></html>"),
      "POST /shellwebapi/login": () => json({ authenticated: true, userId: "OWNER-LOGIN" }),
    });

    await expect(reasonOf(client(stub).login(CREDENTIALS))).resolves.toBe("no_further_hop");
  });

  it("navigates to the stub's own literal authorization URL when it carries no form", async () => {
    // The shape a live, unauthenticated capture of a real deployment's stub
    // actually carried: no `<form>` anywhere on the page, just the controller
    // call with the URL as one of its own arguments and its flag set to
    // navigate rather than submit.
    const stub = routed({
      "GET /prd/Authentication/Login": () => redirect(`${HOST}/prd/OpenId?op=synthetic-op`),
      "GET /prd/OpenId": () =>
        html(openIdRedirectPage(`${HOST}/prd/OpenId/AuthorizeResult?code=synthetic-code`)),
      "GET /prd/OpenId/AuthorizeResult": () =>
        redirect(`${HOST}/prd/Home`, ["EpicSession=synthetic-session; Path=/prd/; Secure"]),
      "GET /prd/Home": () => html(HOME_PAGE),
      "POST /shellwebapi/login": () => json({ authenticated: true, userId: "OWNER-LOGIN" }),
    });

    await expect(client(stub).login(CREDENTIALS)).resolves.toBe("signed_in");
    expect(paths(stub)).toStrictEqual([
      "POST /shellwebapi/login",
      "GET /prd/Authentication/Login",
      "GET /prd/OpenId",
      "GET /prd/OpenId/AuthorizeResult",
      "GET /prd/Home",
    ]);
  });

  it("does not navigate when the stub's own flag says it means to submit a form instead", async () => {
    // The controller call is present, but says `submitForm: true` -- and no
    // form exists on the page for the bridge to have found above. Following
    // the URL anyway would not be what the real script does.
    const stub = routed({
      "GET /prd/Authentication/Login": () => redirect(`${HOST}/prd/OpenId?op=synthetic-op`),
      "GET /prd/OpenId": () =>
        html(openIdRedirectPage(`${HOST}/prd/OpenId/AuthorizeResult?code=synthetic-code`, true)),
      "POST /shellwebapi/login": () => json({ authenticated: true, userId: "OWNER-LOGIN" }),
    });

    await expect(reasonOf(client(stub).login(CREDENTIALS))).resolves.toBe("no_further_hop");
  });

  it("gives up with a hop count when the handoff loops for ever", async () => {
    const stub = routed({
      "GET /prd/Authentication/Login": () => redirect(`${HOST}/prd/OpenId?op=synthetic-op`),
      "GET /prd/OpenId": () => html(OPENID_FORM_PAGE),
      // Straight back to the stub: authorised nothing, changed nothing.
      "POST /shell/api/oauth2/authorize": () => redirect(`${HOST}/prd/OpenId?op=synthetic-op`),
      "POST /shellwebapi/login": () => json({ authenticated: true, userId: "OWNER-LOGIN" }),
    });

    await expect(reasonOf(client(stub).login(CREDENTIALS))).resolves.toBe("hop_budget");
  });

  it("does not hop into a noscript fallback the handoff stub carries for browsers without JS", async () => {
    // The same noscript trap discovery has to avoid: the stub's own page can
    // carry a no-JS fallback, and the bridge goes through the same
    // `followBodyRedirects` helper discovery does. If it followed that hop it
    // would land on a page with no form to submit and no session to speak of.
    const withNoscriptFallback = openIdFormPageWithNoscriptFallback(`${HOST}/prd/nojs.asp`);
    const stub = routed({
      ...BRIDGE_ROUTES,
      "GET /prd/OpenId": () => html(withNoscriptFallback),
      "GET /prd/nojs.asp": () => html("<!doctype html><html><body>no javascript</body></html>"),
      "POST /shellwebapi/login": () => json({ authenticated: true, userId: "OWNER-LOGIN" }),
    });

    await expect(client(stub).login(CREDENTIALS)).resolves.toBe("signed_in");
    expect(paths(stub)).not.toContain("GET /prd/nojs.asp");
  });

  it("accepts a landing it does not recognise once Home itself answers", async () => {
    const stub = routed({
      "GET /prd/Authentication/Login": () => redirect(`${HOST}/prd/OpenId?op=synthetic-op`),
      "GET /prd/OpenId": () => redirect(`${HOST}/prd/Dashboard`),
      "GET /prd/Dashboard": () => html(HOME_PAGE),
      "GET /prd/Home": () => html(HOME_PAGE),
      "POST /shellwebapi/login": () => json({ authenticated: true, userId: "OWNER-LOGIN" }),
    });

    await expect(client(stub).login(CREDENTIALS)).resolves.toBe("signed_in");
    expect(find(stub, "GET", "/prd/Home")).toBeDefined();
  });

  it("does not take a keepalive's word for it when Home says the session is anonymous", async () => {
    // The regression: the chain stops short of the classic session, the keepalive
    // answers the anonymous session the stub handed out, and the bridge used to
    // report signed_in -- leaving the next sync to bounce off VisitsList.
    const stub = routed({
      "GET /prd/Authentication/Login": () => redirect(`${HOST}/prd/OpenId?op=synthetic-op`),
      "GET /prd/OpenId": () => html(OPENID_FORM_PAGE),
      "POST /shell/api/oauth2/authorize": () => redirect(`${HOST}/app/verify`),
      "GET /app/verify": () =>
        html("<!doctype html><html><body><app-root></app-root></body></html>"),
      "GET /prd/Home/KeepAlive": () => json(1),
      "GET /prd/Home": () => redirect(`${HOST}/prd/Authentication/Login`),
      "POST /shellwebapi/login": () => json({ authenticated: true, userId: "OWNER-LOGIN" }),
    });

    await expect(reasonOf(client(stub).login(CREDENTIALS))).resolves.toBe("no_further_hop");
    expect(find(stub, "GET", "/prd/Home/KeepAlive")).toBeUndefined();
  });

  it("does not count a Home that still carries the handoff stub as arrived", async () => {
    const stub = routed({
      "GET /prd/Authentication/Login": () => redirect(`${HOST}/prd/Home`),
      "GET /prd/Home": () => html("<!doctype html><html><body>oidcnonce</body></html>"),
      "POST /shellwebapi/login": () => json({ authenticated: true, userId: "OWNER-LOGIN" }),
    });

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_login_failed");
  });
});

/** A shell that wants a code but whose login answer never says so. */
function silentMfaPortal(): PortalFetchStub {
  return routed({
    "GET /prd/Authentication/Login": () => redirect(`${HOST}/prd/OpenId?op=synthetic-op`),
    "GET /prd/OpenId": () => html(OPENID_FORM_PAGE),
    // Still waiting for its code, so the shell sends the authorize hop back to
    // one of its own pages instead of answering it.
    "POST /shell/api/oauth2/authorize": () => redirect(`${HOST}/app/verify`),
    "GET /app/verify": () => html("<!doctype html><html><body><app-root></app-root></body></html>"),
    "GET /prd/Home": () => redirect(`${HOST}/prd/Authentication/Login`),
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
    const stub = routed({
      "GET /prd/Authentication/Login": () => redirect(`${HOST}/prd/OpenId?op=synthetic-op`),
      "GET /prd/OpenId": () => html(OPENID_FORM_PAGE),
      "POST /shell/api/oauth2/authorize": () => redirect(`${HOST}/app/verify`),
      "GET /app/verify": () => html("<!doctype html><html><body></body></html>"),
      "GET /prd/Home": () => redirect(`${HOST}/prd/Authentication/Login`),
      "POST /shellwebapi/login": () => json({ authenticated: true, userId: "OWNER-LOGIN" }),
    });

    await expect(codeOf(client(stub).login(CREDENTIALS))).resolves.toBe("portal_login_failed");
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
