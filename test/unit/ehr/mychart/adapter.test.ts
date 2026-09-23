// The public surface of worker/ehr/mychart/, exercised through the one
// module a caller is meant to import.
//
// This file is also how the boundary is pinned: a later wave's sync code, and a
// second portal vendor, both see exactly the types named in the imports below.
// If one of them stops existing, this stops compiling -- which is the point.

import { describe, expect, it } from "vitest";

import {
  CookieJar,
  createMyChartAdapter,
  isPortalVendor,
  portalAdapterFor,
} from "../../../../worker/ehr/mychart/index.ts";
import { noopLogger } from "../../../../worker/lib/log.ts";

import { HOME_PAGE, HOST, MOUNT, html, loginPageNew, redirect, routed } from "./fixtures.ts";

import type { PortalFetchStub } from "./fixtures.ts";
import type {
  PortalAdapter,
  PortalAdapterDeps,
  PortalClient,
  PortalCredentials,
  PortalCustomSettings,
  PortalDiscoveryInput,
  PortalEndpoint,
  PortalFlavor,
  PortalVisit,
  PortalVisitStatus,
  SecondaryValidation,
  UsernameField,
} from "../../../../worker/ehr/mychart/index.ts";
import type { AppError } from "../../../../worker/lib/errors.ts";

const T0 = 1_767_225_600;
const CREDENTIALS: PortalCredentials = { username: "owner-login", password: "owner-password" };

function deps(stub: PortalFetchStub): PortalAdapterDeps {
  return {
    fetchImpl: stub.fetchImpl,
    logger: noopLogger,
    now: () => T0,
    random: () => 0.5,
  };
}

describe("portalAdapterFor", () => {
  it("resolves the one portal vendor there is", () => {
    const adapter: PortalAdapter = portalAdapterFor("mychart");

    expect(adapter.portal).toBe("mychart");
    expect(isPortalVendor("mychart")).toBe(true);
  });

  it("refuses an unknown vendor with bad_request rather than undefined", () => {
    expect(isPortalVendor("something-else")).toBe(false);
    expect(() => portalAdapterFor("something-else")).toThrow(
      expect.objectContaining({ code: "bad_request" }) as AppError,
    );
  });

  it("builds a fresh adapter each time, because they hold no state", () => {
    expect(portalAdapterFor("mychart")).not.toBe(portalAdapterFor("mychart"));
  });
});

describe("the adapter's two jobs", () => {
  it("discovers an endpoint, then drives a sign-in with the caller's jar", async () => {
    const stub = routed({
      "GET /MyChart/Authentication/Login": () =>
        html(loginPageNew(), { headers: { "set-cookie": "MCSession=session-1; Path=/" } }),
      "POST /MyChart/Authentication/Login/DoLogin": () => redirect(`${HOST}/MyChart/Home/Index`),
      "GET /MyChart/Home/Index": () => html(HOME_PAGE),
    });
    const adapter = createMyChartAdapter();

    const input: PortalDiscoveryInput = { baseUrl: HOST };
    const endpoint: PortalEndpoint = await adapter.discover(input, deps(stub));
    const usernameField: UsernameField = endpoint.usernameField;
    expect(usernameField).toBe("LoginIdentifier");
    expect(endpoint.mountPath).toBe(MOUNT);

    // The jar is the caller's: it is loaded from the sealed column, handed in,
    // and sealed again afterwards.
    const jar = new CookieJar({ now: () => T0 });
    const client: PortalClient = adapter.client(endpoint, jar, deps(stub));
    const validation: SecondaryValidation = client.secondaryValidation;
    expect(typeof validation.sendCode).toBe("function");

    await expect(client.login(CREDENTIALS)).resolves.toBe("signed_in");
    expect(client.jar).toBe(jar);
    expect(jar.has(`${HOST}/MyChart/`, "MCSession")).toBe(true);
  });

  it("reads the upcoming visits through the same client", async () => {
    const stub = routed({
      "GET /MyChart/Visits/VisitsList": () =>
        html(`<input type="hidden" name="__RequestVerificationToken" value="t" />`),
      "POST /MyChart/Visits/VisitsList/LoadUpcoming": () =>
        Response.json({
          NextNDaysVisits: [
            {
              CSN: "csn-1",
              Instant: "/Date(1790000000000)/",
              TimeZone: "UTC",
              VisitType: "Follow-up",
              IsConfirmed: true,
            },
          ],
        }),
    });
    const endpoint: PortalEndpoint = {
      baseUrl: HOST,
      mountPath: MOUNT,
      usernameField: "LoginIdentifier",
      antiforgeryFieldName: "__RequestVerificationToken",
    };

    const client = createMyChartAdapter().client(
      endpoint,
      new CookieJar({ now: () => T0 }),
      deps(stub),
    );
    const visits: PortalVisit[] = await client.loadUpcoming("UTC");

    const status: PortalVisitStatus = visits[0]?.status ?? "scheduled";
    expect(status).toBe("confirmed");
    expect(visits[0]?.start).toBe("2026-09-21T14:13:20+00:00");
  });
});

describe("the login flavour decides which client the adapter builds", () => {
  it("drives the classic form when the endpoint says classic, or says nothing", async () => {
    for (const flavor of [undefined, "classic" as PortalFlavor]) {
      const stub = routed({
        "GET /MyChart/Authentication/Login": () => html(loginPageNew()),
        "POST /MyChart/Authentication/Login/DoLogin": () => redirect(`${HOST}/MyChart/Home`),
        "GET /MyChart/Home": () => html(HOME_PAGE),
      });
      const endpoint: PortalEndpoint = {
        baseUrl: HOST,
        mountPath: MOUNT,
        usernameField: "LoginIdentifier",
        antiforgeryFieldName: "__RequestVerificationToken",
        ...(flavor !== undefined && { flavor }),
      };

      const client = createMyChartAdapter().client(
        endpoint,
        new CookieJar({ now: () => T0 }),
        deps(stub),
      );
      await expect(client.login(CREDENTIALS)).resolves.toBe("signed_in");
      expect(stub.calls.some((call) => call.url.includes("/DoLogin"))).toBe(true);
    }
  });

  it("drives the shell's JSON API when the endpoint says custom_oidc", async () => {
    const stub = routed({
      "POST /shellwebapi/login": () => Response.json({ mfaRequired: true, userId: "OWNER" }),
    });
    const endpoint: PortalEndpoint = {
      baseUrl: HOST,
      mountPath: MOUNT,
      usernameField: "Username",
      antiforgeryFieldName: "__RequestVerificationToken",
      flavor: "custom_oidc",
      authBaseUrl: HOST,
      apiBasePath: "/shellwebapi",
    };

    const client = createMyChartAdapter().client(
      endpoint,
      new CookieJar({ now: () => T0 }),
      deps(stub),
    );

    await expect(client.login(CREDENTIALS)).resolves.toBe("awaiting_code");
    expect(stub.calls.map((call) => new URL(call.url).pathname)).toStrictEqual([
      "/shellwebapi/login",
    ]);
  });

  it("passes the caller's custom settings through to that client", async () => {
    const stub = routed({
      "POST /shellwebapi/login": () => Response.json({ mfaRequired: true, userId: "OWNER" }),
      "POST /shellwebapi/verification/code/generate": () => Response.json({ success: true }),
    });
    const endpoint: PortalEndpoint = {
      baseUrl: HOST,
      mountPath: MOUNT,
      usernameField: "Username",
      antiforgeryFieldName: "__RequestVerificationToken",
      flavor: "custom_oidc",
      authBaseUrl: HOST,
    };
    // Neither value is discoverable, so this is the path the owner configures.
    const custom: PortalCustomSettings = {
      apiBasePath: "/shellwebapi",
      mfaContact: "codes@example.test",
    };

    const client = createMyChartAdapter().client(endpoint, new CookieJar({ now: () => T0 }), {
      ...deps(stub),
      custom,
    });
    await client.login(CREDENTIALS);
    await client.secondaryValidation.sendCode("email");

    const generate = stub.calls.find((call) => call.url.includes("/code/generate"));
    expect(JSON.parse(generate?.body ?? "{}")).toMatchObject({ email: custom.mfaContact });
  });
});
