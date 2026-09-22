import { describe, expect, it } from "vitest";

import { AppError } from "../../../worker/lib/errors.ts";
import { noopLogger } from "../../../worker/lib/log.ts";
import {
  base64Utf8,
  basicAuthHeader,
  chooseTokenAuthMethod,
  SMART_BASE_SCOPES,
} from "../../../worker/providers/adapter.ts";
import {
  createEpicAdapter,
  indexCapabilities,
  parseSmartConfiguration,
  toTokenSet,
} from "../../../worker/providers/epic/index.ts";

import {
  decodeBasic,
  EPIC_SANDBOX_BASE,
  jsonResponse,
  loadFixture,
  stubFetch,
} from "./fixtures.ts";

import type { CapabilityStatement, TokenSet } from "../../../worker/fhir/types.ts";
import type { TokenAuthMethod } from "../../../worker/providers/adapter.ts";

const smartConfig: unknown = loadFixture("smart-configuration.json");
const metadata = loadFixture<CapabilityStatement>("metadata-small.json");
const tokenResponse: unknown = loadFixture("token-response.json");

const NOW = 1_700_000_000_000;
const CLIENT_ID = "synthetic client id";
/** Deliberately full of characters that must be percent-encoded before base64. */
const CLIENT_SECRET = "s3cr&t/=:+ x";

function adapter(fetchImpl: typeof fetch): ReturnType<typeof createEpicAdapter> {
  return createEpicAdapter({ fetchImpl, logger: noopLogger, now: () => NOW });
}

/** The `AppError` a synchronous call threw, as the async helper below does. */
function appErrorFrom(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected the call to throw");
}

async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected the promise to reject");
}

describe("discover", () => {
  it("resolves the well-known path against the base and parses the document", async () => {
    const stub = stubFetch(() => jsonResponse(smartConfig));

    const config = await adapter(stub.fetchImpl).discover(EPIC_SANDBOX_BASE);

    expect(stub.calls[0]?.url).toBe(`${EPIC_SANDBOX_BASE}/.well-known/smart-configuration`);
    expect(stub.calls[0]?.headers.accept).toBe("application/json");
    expect(config.authorizeUrl).toContain("/oauth2/authorize");
    expect(config.tokenUrl).toContain("/oauth2/token");
    expect(config.pkceMethods).toStrictEqual(["S256"]);
    expect(config.tokenAuthMethods).toContain("client_secret_basic");
    expect(config.capabilities).toContain("launch-standalone");
  });

  it("tolerates a base URL with a trailing slash", async () => {
    const stub = stubFetch(() => jsonResponse(smartConfig));

    await adapter(stub.fetchImpl).discover(`${EPIC_SANDBOX_BASE}/`);

    expect(stub.calls[0]?.url).toBe(`${EPIC_SANDBOX_BASE}/.well-known/smart-configuration`);
  });

  it("fails loudly when the document has no OAuth endpoints", async () => {
    const stub = stubFetch(() => jsonResponse({ issuer: "https://example.test" }));

    const error = await expectAppError(adapter(stub.fetchImpl).discover(EPIC_SANDBOX_BASE));

    expect(error.code).toBe("upstream_error");
    expect(error.details).toMatchObject({ hasAuthorize: false, hasToken: false });
  });

  it("reports a 404 as an upstream error rather than retrying it", async () => {
    const stub = stubFetch(() => new Response("nope", { status: 404 }));

    const error = await expectAppError(adapter(stub.fetchImpl).discover(EPIC_SANDBOX_BASE));

    expect(error.code).toBe("upstream_error");
    expect(stub.calls).toHaveLength(1);
  });
});

describe("parseSmartConfiguration", () => {
  it("defaults the optional lists to empty rather than throwing", () => {
    const config = parseSmartConfiguration({
      authorization_endpoint: "https://example.test/authorize",
      token_endpoint: "https://example.test/token",
    });

    expect(config).toStrictEqual({
      authorizeUrl: "https://example.test/authorize",
      tokenUrl: "https://example.test/token",
      capabilities: [],
      pkceMethods: [],
      tokenAuthMethods: [],
    });
  });

  it("rejects a body that is not an object", () => {
    expect(() => parseSmartConfiguration("not json")).toThrow(AppError);
  });

  it("refuses an endpoint that is not https, and says which one", () => {
    // The token endpoint receives the client secret, the code and the PKCE
    // verifier. A discovery document is the organisation's to write, so its word
    // on where to send them is not enough on its own.
    const error = appErrorFrom(() =>
      parseSmartConfiguration({
        authorization_endpoint: "https://example.test/authorize",
        // eslint-disable-next-line unicorn/prefer-https -- a non-https endpoint is the input under test; the assertion is that it is refused.
        token_endpoint: "http://example.test/token",
      }),
    );

    expect(error.details).toMatchObject({ authorizeIsHttps: true, tokenIsHttps: false });
    // Never the URL itself: a FHIR endpoint names the health system.
    expect(JSON.stringify(error.details)).not.toContain("example.test");
  });

  it("refuses an endpoint that is not an absolute URL at all", () => {
    expect(() =>
      parseSmartConfiguration({
        authorization_endpoint: "/authorize",
        token_endpoint: "https://example.test/token",
      }),
    ).toThrow(AppError);
  });
});

describe("getCapabilities", () => {
  it("indexes interactions and search parameters per resource type", async () => {
    const stub = stubFetch(() => jsonResponse(metadata));

    const index = await adapter(stub.fetchImpl).getCapabilities(EPIC_SANDBOX_BASE, "token-1");

    expect(stub.calls[0]?.url).toBe(`${EPIC_SANDBOX_BASE}/metadata`);
    expect(stub.calls[0]?.headers.accept).toBe("application/fhir+json");
    expect(stub.calls[0]?.headers.authorization).toBe("Bearer token-1");
    expect(index.fhirVersion).toBe("4.0.1");
    expect(Object.keys(index.resources)).toStrictEqual([
      "Patient",
      "Encounter",
      "Observation",
      "Location",
      "Practitioner",
    ]);
    expect(index.resources.Encounter?.interactions).toStrictEqual(["read", "search-type"]);
    expect(index.resources.Encounter?.searchParams).toStrictEqual([
      "_id",
      "patient",
      "date",
      "class",
      "identifier",
    ]);
    expect(index.resources.Location?.interactions).toStrictEqual(["read"]);
  });

  it("maps a 401 to upstream_auth", async () => {
    const stub = stubFetch(() => new Response("", { status: 401 }));

    const error = await expectAppError(
      adapter(stub.fetchImpl).getCapabilities(EPIC_SANDBOX_BASE, "stale"),
    );

    expect(error.code).toBe("upstream_auth");
  });
});

describe("indexCapabilities", () => {
  it("survives a statement with no rest block at all", () => {
    expect(indexCapabilities({ resourceType: "CapabilityStatement" })).toStrictEqual({
      fhirVersion: null,
      resources: {},
    });
    expect(indexCapabilities(null).resources).toStrictEqual({});
  });

  it("merges two rest blocks that both describe a resource type", () => {
    const index = indexCapabilities({
      rest: [
        { resource: [{ type: "Encounter", interaction: [{ code: "read" }] }] },
        { resource: [{ type: "Encounter", interaction: [{ code: "search-type" }] }] },
      ],
    });

    expect(index.resources.Encounter?.interactions).toStrictEqual(["read", "search-type"]);
  });
});

describe("buildAuthorizeUrl", () => {
  const url = new URL(
    adapter(stubFetch(() => new Response()).fetchImpl).buildAuthorizeUrl({
      authorizeUrl: "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize",
      clientId: "client-1",
      redirectUri: "https://healthy.example.test/oauth/callback",
      scopes: ["openid", "fhirUser", "offline_access", "patient/Encounter.rs"],
      state: "state-1",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      aud: `${EPIC_SANDBOX_BASE}/`,
    }),
  );

  it("carries every parameter Epic requires", () => {
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://healthy.example.test/oauth/callback",
    );
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(
      "openid fhirUser offline_access patient/Encounter.rs",
    );
  });

  it("passes aud through byte for byte, trailing slash included", () => {
    // Epic compares this as a string against the registered value; normalising
    // the trailing slash here would fail the launch silently.
    expect(url.searchParams.get("aud")).toBe(`${EPIC_SANDBOX_BASE}/`);
  });
});

describe("scopesFor", () => {
  it("asks for SMART v2 read+search on each type, plus the base scopes", () => {
    const scopes = adapter(stubFetch(() => new Response()).fetchImpl).scopesFor([
      "Patient",
      "Encounter",
      "Encounter",
    ]);

    expect(scopes.slice(0, 3)).toStrictEqual([...SMART_BASE_SCOPES]);
    expect(scopes).toStrictEqual([
      "openid",
      "fhirUser",
      "offline_access",
      "patient/Patient.rs",
      "patient/Encounter.rs",
    ]);
  });
});

describe("client authentication", () => {
  it("percent-encodes both halves before base64, per RFC 6749", () => {
    expect(decodeBasic(basicAuthHeader(CLIENT_ID, CLIENT_SECRET))).toBe(
      "synthetic%20client%20id:s3cr%26t%2F%3D%3A%2B%20x",
    );
    expect(base64Utf8("fo")).toBe("Zm8=");
    expect(base64Utf8("f")).toBe("Zg==");
  });

  it("prefers Basic, falls back to post only when discovery omits Basic", () => {
    const method: TokenAuthMethod = chooseTokenAuthMethod(["client_secret_basic"]);

    expect(method).toBe("client_secret_basic");
    expect(chooseTokenAuthMethod(["client_secret_post"])).toBe("client_secret_post");
    expect(chooseTokenAuthMethod(["private_key_jwt"])).toBe("client_secret_basic");
    expect(chooseTokenAuthMethod([])).toBe("client_secret_basic");
    expect(chooseTokenAuthMethod(undefined)).toBe("client_secret_basic");
  });
});

describe("exchangeCode", () => {
  it("posts the code with a url-encoded Basic header and returns a TokenSet", async () => {
    const stub = stubFetch(() =>
      jsonResponse(tokenResponse, { headers: { "content-type": "application/json" } }),
    );

    const tokens: TokenSet = await adapter(stub.fetchImpl).exchangeCode({
      tokenUrl: "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code: "code-1",
      redirectUri: "https://healthy.example.test/oauth/callback",
      codeVerifier: "verifier-1",
      tokenAuthMethods: ["client_secret_basic", "client_secret_post"],
    });

    const call = stub.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(decodeBasic(call?.headers.authorization ?? "")).toBe(
      "synthetic%20client%20id:s3cr%26t%2F%3D%3A%2B%20x",
    );

    const form = new URLSearchParams(call?.body ?? "");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-1");
    expect(form.get("redirect_uri")).toBe("https://healthy.example.test/oauth/callback");
    expect(form.get("code_verifier")).toBe("verifier-1");
    expect(form.get("client_secret")).toBeNull();

    expect(tokens.patientId).toBe("synthetic-patient-1");
    expect(tokens.expiresAt).toBe(NOW + 3_240_000);
    expect(tokens.refreshToken).not.toBeNull();
    expect(tokens.idToken).toBe("synthetic.id.value");
    expect(tokens.scope).toContain("patient/Encounter.rs");
  });

  it("falls back to client_secret_post when discovery does not offer Basic", async () => {
    const stub = stubFetch(() => jsonResponse(tokenResponse));

    await adapter(stub.fetchImpl).exchangeCode({
      tokenUrl: "https://example.test/token",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code: "code-1",
      redirectUri: "https://healthy.example.test/oauth/callback",
      codeVerifier: "verifier-1",
      tokenAuthMethods: ["client_secret_post"],
    });

    const form = new URLSearchParams(stub.calls[0]?.body ?? "");
    expect(stub.calls[0]?.headers.authorization).toBeUndefined();
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
  });

  it("does not report invalid_grant on a code exchange as needs_reauth", async () => {
    const stub = stubFetch(() => jsonResponse({ error: "invalid_grant" }, { status: 400 }));

    const error = await expectAppError(
      adapter(stub.fetchImpl).exchangeCode({
        tokenUrl: "https://example.test/token",
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        code: "stale",
        redirectUri: "https://healthy.example.test/oauth/callback",
        codeVerifier: "verifier-1",
      }),
    );

    // A single-use code that has already been spent is a flow bug, not a reason
    // to open a reconnect card.
    expect(error.code).toBe("upstream_error");
    expect(stub.calls).toHaveLength(1);
  });
});

describe("toTokenSet", () => {
  it("fails loudly when the patient id is missing", () => {
    let captured: unknown;
    try {
      toTokenSet({ access_token: "a", expires_in: 60 }, NOW);
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(AppError);
    expect((captured as AppError).details).toStrictEqual({ missing: "patient" });
  });

  it("fails loudly when there is no access token", () => {
    expect(() => toTokenSet({ patient: "p" }, NOW)).toThrow(AppError);
    expect(() => toTokenSet("nope", NOW)).toThrow(AppError);
  });

  it("defaults a missing expires_in to an hour and nulls the optional fields", () => {
    expect(toTokenSet({ access_token: "a", patient: "p" }, NOW)).toStrictEqual({
      accessToken: "a",
      expiresAt: NOW + 3_600_000,
      refreshToken: null,
      scope: "",
      patientId: "p",
      idToken: null,
    });
  });
});

function refreshWith(response: () => Response): Promise<TokenSet> {
  return adapter(stubFetch(response).fetchImpl).refresh({
    tokenUrl: "https://example.test/token",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    refreshToken: "renewal-1",
  });
}

describe("refresh", () => {
  it("sends grant_type=refresh_token with Basic client auth", async () => {
    const stub = stubFetch(() => jsonResponse(tokenResponse));

    await adapter(stub.fetchImpl).refresh({
      tokenUrl: "https://example.test/token",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: "renewal-1",
    });

    const form = new URLSearchParams(stub.calls[0]?.body ?? "");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("renewal-1");
    expect(stub.calls[0]?.headers.authorization).toMatch(/^Basic /u);
  });

  it("maps 400 invalid_grant to needs_reauth", async () => {
    const error = await expectAppError(
      refreshWith(() =>
        jsonResponse({ error: "invalid_grant", error_description: "expired" }, { status: 400 }),
      ),
    );

    expect(error.code).toBe("needs_reauth");
    expect(error.details).toMatchObject({ status: 400, oauthError: "invalid_grant" });
  });

  it("maps 401 to needs_reauth only when the body says invalid_grant", async () => {
    const reauth = await expectAppError(
      refreshWith(() => jsonResponse({ error: "invalid_grant" }, { status: 401 })),
    );
    const notReauth = await expectAppError(
      refreshWith(() => jsonResponse({ error: "invalid_client" }, { status: 401 })),
    );
    const bare = await expectAppError(refreshWith(() => new Response("", { status: 401 })));

    expect(reauth.code).toBe("needs_reauth");
    // A bad client secret is configuration: reconnecting cannot fix it.
    expect(notReauth.code).toBe("upstream_auth");
    expect(bare.code).toBe("upstream_auth");
  });

  it("maps a 500 to upstream_unavailable and carries Retry-After", async () => {
    const error = await expectAppError(
      refreshWith(() => new Response("", { status: 500, headers: { "retry-after": "120" } })),
    );

    expect(error.code).toBe("upstream_unavailable");
    expect(error.retryAfterMs).toBe(120_000);
  });

  it("maps a 429 to upstream_unavailable", async () => {
    const error = await expectAppError(refreshWith(() => new Response("", { status: 429 })));

    expect(error.code).toBe("upstream_unavailable");
    expect(error.retryAfterMs).toBeUndefined();
  });

  it("maps any other 4xx to upstream_error", async () => {
    const error = await expectAppError(refreshWith(() => new Response("", { status: 404 })));

    expect(error.code).toBe("upstream_error");
  });

  it("maps a network failure to upstream_unavailable", async () => {
    const error = await expectAppError(
      refreshWith(() => {
        throw new TypeError("fetch failed");
      }),
    );

    expect(error.code).toBe("upstream_unavailable");
  });

  it("does not retry the token endpoint", async () => {
    const stub = stubFetch(() => new Response("", { status: 500 }));

    await expectAppError(
      adapter(stub.fetchImpl).refresh({
        tokenUrl: "https://example.test/token",
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: "renewal-1",
      }),
    );

    // An authorization code is single-use and a refresh is re-driven by the next
    // scheduled run, so replaying either here buys nothing.
    expect(stub.calls).toHaveLength(1);
  });
});
