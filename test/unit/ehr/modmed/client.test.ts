// The ModMed client against a synthetic portal and identity provider.

import { describe, expect, it } from "vitest";

import { createModMedClient } from "../../../../worker/ehr/modmed/client.ts";
import { createModMedAdapter } from "../../../../worker/ehr/modmed/index.ts";
import { TOKEN_EXTRAS } from "../../../../worker/ehr/modmed/wire.ts";
import { CookieJar, createPortalAdapter } from "../../../../worker/ehr/mychart/index.ts";
import { noopLogger } from "../../../../worker/lib/log.ts";

import {
  BAD_PASSWORD_PAGE,
  CLIENT_ID,
  CODE_PAGE,
  ENDPOINT,
  IDENTITY_PAGE,
  LOCKED_PAGE,
  OIDC,
  PORTAL,
  REDIRECT_URI,
  SSO,
  USERNAME_PAGE,
  appointmentRow,
  authData,
  found,
  html,
  json,
  pastRow,
  router,
  tokenResponse,
} from "./fixtures.ts";

import type { AppError } from "../../../../worker/lib/errors.ts";

const T0 = 1_790_000_000;
const now = (): number => T0;
const CREDENTIALS = { username: "owner-login", password: "owner-password" };
const AUTH_DATA_URL = `${PORTAL}/ema/ws/v3/auth/data/patient`;
const UPCOMING_URL = `${PORTAL}/ema/ws/v3/patientPortal/appointments/upcoming`;
const PAST_URL = `${PORTAL}/ema/ws/v3/patientPortal/appointments/past`;
const ACTION = `${SSO}/realms/ExampleRealm/login-actions/authenticate`;

interface Options {
  /** What the credential POST answers. Default: the hand-back with a code. */
  afterCredentials?: (state: string) => Response;
  /** Skip the login page: a live SSO cookie hands the code straight back. */
  ssoAlive?: boolean;
  authDataBody?: unknown;
  tokenStatus?: number;
  tokenBody?: Record<string, unknown>;
}

/** A complete synthetic sign-in: authorize, identity page, username page, hand-back, token. */
function signInRoutes(options: Options = {}) {
  let state = "";
  const handBack = () =>
    found(`${REDIRECT_URI}#state=${state}&session_state=x&code=synthetic-code`);
  return [
    {
      method: "GET",
      match: AUTH_DATA_URL,
      respond: () => json(options.authDataBody ?? authData()),
    },
    {
      method: "GET",
      match: `${OIDC}/auth`,
      respond: ({ url }: { url: URL }) => {
        state = url.searchParams.get("state") ?? "";
        return options.ssoAlive === true
          ? handBack()
          : html(IDENTITY_PAGE, {
              "set-cookie": "AUTH_SESSION_ID=synthetic; Path=/auth/realms/ExampleRealm/; Secure",
            });
      },
    },
    {
      method: "POST",
      match: ACTION,
      respond: ({ url }: { url: URL }) => {
        return url.searchParams.get("session_code") === "s1"
          ? html(USERNAME_PAGE)
          : (options.afterCredentials?.(state) ?? handBack());
      },
    },
    {
      method: "POST",
      match: `${OIDC}/token`,
      respond: () => json(options.tokenBody ?? tokenResponse(), {}, options.tokenStatus ?? 200),
    },
  ];
}

function client(fetchImpl: typeof fetch, clock = now, jar = new CookieJar({ now: clock })) {
  return createModMedClient({ endpoint: ENDPOINT, jar, fetchImpl, logger: noopLogger, now: clock });
}

function formOf(init: RequestInit): URLSearchParams {
  return new URLSearchParams(typeof init.body === "string" ? init.body : "");
}

describe("discovery through the routing adapter", () => {
  it("recognises a ModMed practice from its patient sign-in document", async () => {
    const stub = router([{ method: "GET", match: AUTH_DATA_URL, respond: () => json(authData()) }]);
    const endpoint = await createPortalAdapter().discover(
      { baseUrl: PORTAL },
      { fetchImpl: stub.fetchImpl, logger: noopLogger, now: () => T0 },
    );
    expect(endpoint).toEqual(ENDPOINT);
  });

  it("falls back to MyChart discovery when the document is not there", async () => {
    const stub = router([
      { method: "GET", match: AUTH_DATA_URL, respond: () => new Response("nope", { status: 404 }) },
    ]);
    await expect(
      createPortalAdapter().discover(
        { baseUrl: PORTAL },
        { fetchImpl: stub.fetchImpl, logger: noopLogger, now: () => T0 },
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^portal_/u) as string });
    // MyChart's probes ran after ModMed's answered "not here".
    expect(stub.calls.length).toBeGreaterThan(1);
    expect(
      stub.calls.slice(1).some((call) => call.url.pathname !== "/ema/ws/v3/auth/data/patient"),
    ).toBe(true);
  });

  it("refuses a deployment whose identity provider is not https", async () => {
    const body = authData();
    (body as { keycloakConfig: { authServerUrl: string } }).keycloakConfig.authServerUrl =
      SSO.replace("https://", "http://");
    const stub = router([{ method: "GET", match: AUTH_DATA_URL, respond: () => json(body) }]);
    const modmedOnly = createModMedAdapter();
    await expect(
      modmedOnly.discover(
        { baseUrl: PORTAL },
        { fetchImpl: stub.fetchImpl, logger: noopLogger, now: () => T0 },
      ),
    ).rejects.toMatchObject({ code: "portal_parse_failed" });
  });
});

describe("login", () => {
  it("switches to the username form, signs in and keeps the token pair", async () => {
    const stub = router(signInRoutes());
    const portal = client(stub.fetchImpl);

    await expect(portal.login(CREDENTIALS)).resolves.toBe("signed_in");

    const authorize = stub.calls.find((call) => call.url.pathname.endsWith("/auth"));
    expect(authorize?.url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(authorize?.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize?.url.searchParams.get("client_id")).toBe(CLIENT_ID);

    const posts = stub.calls.filter(
      (call) => call.method === "POST" && call.url.pathname.includes("login-actions"),
    );
    expect(formOf(posts[0]!.init).get("submitAction")).toBe("loginWithUsername");
    expect(formOf(posts[0]!.init).has("password")).toBe(false);
    const credentialPost = formOf(posts[1]!.init);
    expect(credentialPost.get("username")).toBe("owner-login");
    expect(credentialPost.get("password")).toBe("owner-password");
    expect(credentialPost.get("firm")).toBe("example-practice.modmedapp.com");
    // The password went to the identity provider and nowhere else.
    expect(
      stub.calls.filter((call) => formOf(call.init).has("password")).map((call) => call.url.origin),
    ).toStrictEqual([new URL(SSO).origin]);

    const token = stub.calls.find((call) => call.url.pathname.endsWith("/token"));
    const tokenForm = formOf(token!.init);
    expect(tokenForm.get("grant_type")).toBe("authorization_code");
    expect(tokenForm.get("code")).toBe("synthetic-code");
    expect(tokenForm.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(tokenForm.get("code_verifier")?.length).toBeGreaterThan(40);

    expect(portal.jar.getExtra(TOKEN_EXTRAS.accessToken)).toBe("synthetic-access-1");
    expect(portal.jar.getExtra(TOKEN_EXTRAS.accessExpiresAt)).toBe(String(T0 + 900));
    expect(portal.jar.getExtra(TOKEN_EXTRAS.refreshExpiresAt)).toBe(String(T0 + 7200));
    // Keycloak's own cookie is kept for the next sign-in.
    expect(portal.jar.serialise()).toContain("AUTH_SESSION_ID");
  });

  it("takes the code straight back when the identity provider's session is still alive", async () => {
    const stub = router(signInRoutes({ ssoAlive: true }));
    await expect(client(stub.fetchImpl).login(CREDENTIALS)).resolves.toBe("signed_in");
    expect(stub.calls.some((call) => formOf(call.init).has("password"))).toBe(false);
  });

  it.each([
    ["a one-time-code challenge", CODE_PAGE, "portal_code_challenge"],
    ["a rejected password", BAD_PASSWORD_PAGE, "portal_login_failed"],
    ["a locked account", LOCKED_PAGE, "portal_locked"],
    ["a page it cannot read", "<html><body>Something else</body></html>", "portal_parse_failed"],
  ])("classifies %s", async (_label, page, code) => {
    const stub = router(signInRoutes({ afterCredentials: () => html(page) }));
    await expect(client(stub.fetchImpl).login(CREDENTIALS)).rejects.toMatchObject({ code });
  });

  it("refuses to send the password when the practice now names another identity provider", async () => {
    const moved = authData();
    (moved as { keycloakConfig: { authServerUrl: string } }).keycloakConfig.authServerUrl =
      "https://elsewhere.example.test/auth";
    const stub = router(signInRoutes({ authDataBody: moved }));
    await expect(client(stub.fetchImpl).login(CREDENTIALS)).rejects.toMatchObject({
      code: "portal_origin_unconfirmed",
    });
    expect(stub.calls.some((call) => formOf(call.init).has("password"))).toBe(false);
  });

  it("refuses a hand-back whose state does not match", async () => {
    const stub = router(
      signInRoutes({
        afterCredentials: () => found(`${REDIRECT_URI}#state=forged&code=synthetic-code`),
      }),
    );
    await expect(client(stub.fetchImpl).login(CREDENTIALS)).rejects.toMatchObject({
      code: "portal_parse_failed",
    });
  });

  it("refuses a hand-back to anywhere but the portal's own app", async () => {
    const stub = router(
      signInRoutes({
        afterCredentials: (state) => found(`https://evil.example.test/#state=${state}&code=c`),
      }),
    );
    await expect(client(stub.fetchImpl).login(CREDENTIALS)).rejects.toMatchObject({
      code: "portal_redirected_offsite",
    });
  });

  it("never answers a code itself", async () => {
    const stub = router([]);
    await expect(
      client(stub.fetchImpl).secondaryValidation.sendCode("email"),
    ).rejects.toMatchObject({
      code: "portal_code_challenge",
    } satisfies Partial<AppError>);
  });
});

/** A jar already holding a live token pair. */
function signedInJar(clock: () => number, accessLeft = 600, refreshLeft = 3600): CookieJar {
  const jar = new CookieJar({ now: clock });
  jar.setExtra(TOKEN_EXTRAS.accessToken, "synthetic-access-0");
  jar.setExtra(TOKEN_EXTRAS.accessExpiresAt, String(T0 + accessLeft));
  jar.setExtra(TOKEN_EXTRAS.refreshToken, "synthetic-refresh-0");
  jar.setExtra(TOKEN_EXTRAS.refreshExpiresAt, String(T0 + refreshLeft));
  return jar;
}

describe("reading appointments", () => {
  it("reads every page, with the bearer token, until the reported count", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => appointmentRow({ id: 1000 + index }));
    const stub = router([
      {
        method: "GET",
        match: UPCOMING_URL,
        respond: ({ url }) => {
          const page = Number(url.searchParams.get("paging.pageNumber"));
          const size = Number(url.searchParams.get("paging.pageSize"));
          const slice = rows.slice((page - 1) * size, page * size);
          return json(slice, { count: "60", pagenumber: String(page), pagesize: String(size) });
        },
      },
    ]);
    const visits = await client(stub.fetchImpl, now, signedInJar(now)).loadUpcoming(
      "Europe/Lisbon",
    );

    expect(visits).toHaveLength(60);
    expect(stub.calls).toHaveLength(2);
    for (const call of stub.calls) {
      expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer synthetic-access-0");
      expect(call.url.searchParams.get("selector")).toContain("physician(fullNameComplete)");
      expect(call.url.searchParams.get("from")).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u);
    }
  });

  it("stops on an empty page even when the count header lies", async () => {
    const stub = router([
      {
        method: "GET",
        match: UPCOMING_URL,
        respond: ({ url }) =>
          json(
            url.searchParams.get("paging.pageNumber") === "1"
              ? Array.from({ length: 50 }, (_, i) => appointmentRow({ id: i }))
              : [],
            {
              count: "500",
            },
          ),
      },
    ]);
    const visits = await client(stub.fetchImpl, now, signedInJar(now)).loadUpcoming(
      "Europe/Lisbon",
    );
    expect(visits).toHaveLength(50);
    expect(stub.calls).toHaveLength(2);
  });

  it("reads the past list as completed visits, without its clinical text", async () => {
    const stub = router([
      { method: "GET", match: PAST_URL, respond: () => json([pastRow()], { count: "1" }) },
    ]);
    const [visit] = await client(stub.fetchImpl, now, signedInJar(now)).loadPast("Europe/Lisbon");
    expect(visit).toMatchObject({
      csn: "70001",
      status: "completed",
      practitioner: "Pat Example, MD",
    });
    expect(JSON.stringify(visit)).not.toContain("clinical");
  });

  it("refreshes an access token that is about to lapse, and keeps the rotated pair", async () => {
    const stub = router([
      {
        method: "POST",
        match: `${OIDC}/token`,
        respond: () =>
          json(
            tokenResponse({
              access_token: "synthetic-access-2",
              refresh_token: "synthetic-refresh-2",
            }),
          ),
      },
      { method: "GET", match: UPCOMING_URL, respond: () => json([], { count: "0" }) },
    ]);
    const portal = client(stub.fetchImpl, now, signedInJar(now, 30));
    await portal.loadUpcoming("Europe/Lisbon");

    const refresh = stub.calls.find((call) => call.method === "POST");
    expect(formOf(refresh!.init).get("grant_type")).toBe("refresh_token");
    expect(formOf(refresh!.init).get("refresh_token")).toBe("synthetic-refresh-0");
    expect(portal.jar.getExtra(TOKEN_EXTRAS.refreshToken)).toBe("synthetic-refresh-2");
    const get = stub.calls.find((call) => call.method === "GET");
    expect(new Headers(get!.init.headers).get("authorization")).toBe("Bearer synthetic-access-2");
  });

  it("reports a refused refresh as an expired session, and a dead session as not alive", async () => {
    const stub = router([
      {
        method: "POST",
        match: `${OIDC}/token`,
        respond: () => json({ error: "invalid_grant" }, {}, 400),
      },
    ]);
    await expect(
      client(stub.fetchImpl, now, signedInJar(now, 0)).loadUpcoming("Europe/Lisbon"),
    ).rejects.toMatchObject({ code: "portal_session_expired" });
    await expect(client(stub.fetchImpl, now, signedInJar(now, 0)).isSessionAlive()).resolves.toBe(
      false,
    );
  });

  it("treats a lapsed refresh token as expired without asking the identity provider", async () => {
    const stub = router([]);
    await expect(
      client(stub.fetchImpl, now, signedInJar(now, 0, -1)).isSessionAlive(),
    ).resolves.toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it("retries a 500 once on a refreshed token, which is how the API answers a bad one", async () => {
    let gets = 0;
    const stub = router([
      {
        method: "POST",
        match: `${OIDC}/token`,
        respond: () => json(tokenResponse({ access_token: "synthetic-access-3" })),
      },
      {
        method: "GET",
        match: UPCOMING_URL,
        respond: () => {
          gets += 1;
          return gets === 1
            ? json({ statusCode: 500 }, {}, 500)
            : json([appointmentRow()], { count: "1" });
        },
      },
    ]);
    const visits = await client(stub.fetchImpl, now, signedInJar(now)).loadUpcoming(
      "Europe/Lisbon",
    );
    expect(visits).toHaveLength(1);
    expect(gets).toBe(2);
  });

  it("calls a session alive only when an authenticated list call works", async () => {
    const stub = router([
      { method: "GET", match: UPCOMING_URL, respond: () => json([], { count: "0" }) },
    ]);
    await expect(client(stub.fetchImpl, now, signedInJar(now)).isSessionAlive()).resolves.toBe(
      true,
    );
    expect(stub.calls[0]?.url.searchParams.get("paging.pageSize")).toBe("1");
    // The list answers a 500 without `from`, so the probe always sends one.
    expect(stub.calls[0]?.url.searchParams.get("from")).toMatch(/T00:00:00\.000Z$/u);
  });

  it("retries a 403 on a refreshed token, and keeps the code when the retry is refused too", async () => {
    let gets = 0;
    const stub = router([
      { method: "POST", match: `${OIDC}/token`, respond: () => json(tokenResponse()) },
      {
        method: "GET",
        match: UPCOMING_URL,
        respond: () => {
          gets += 1;
          return new Response("<html>denied</html>", { status: 403 });
        },
      },
    ]);
    await expect(
      client(stub.fetchImpl, now, signedInJar(now)).isSessionAlive(),
    ).rejects.toMatchObject({ code: "portal_bot_blocked" });
    expect(gets).toBe(2);
    expect(stub.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("reads a 403 whose refresh is refused as a dead session", async () => {
    const stub = router([
      {
        method: "POST",
        match: `${OIDC}/token`,
        respond: () => json({ error: "invalid_grant" }, {}, 400),
      },
      {
        method: "GET",
        match: UPCOMING_URL,
        respond: () => new Response("<html>denied</html>", { status: 403 }),
      },
    ]);
    await expect(client(stub.fetchImpl, now, signedInJar(now)).isSessionAlive()).resolves.toBe(
      false,
    );
  });
});
