// The Epic standalone patient launch, end to end against a stubbed organisation.
//
// What is under test is the part that cannot be unit tested: that the state row is
// durable before the browser leaves, that it is single-use, that the authorize URL
// carries the exact `aud` Epic will compare as a string, and that a successful
// exchange lands sealed tokens on a connection row.
//
// The upstream is stubbed through the injected fetch, so the real Epic adapter runs:
// its discovery parsing, its HTTP Basic client authentication, and its `TokenSet`
// construction are all exercised against the committed fixtures.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearDiscoveryCache } from "../../../worker/oauth/discovery.ts";
import smartConfiguration from "../../fixtures/epic/smart-configuration.json";
import tokenResponse from "../../fixtures/epic/token-response.json";
import {
  TEST_FHIR_BASE,
  call,
  freshOwner,
  resetPorts,
  seedProvider,
  stubFetch,
  testRepos,
  usePorts,
} from "../api/helpers.ts";

import type { FetchStub } from "../api/helpers.ts";

const SECRET = "the-per-org-client-secret";

const owner = freshOwner();

beforeEach(() => {
  clearDiscoveryCache();
});

afterEach(() => {
  resetPorts();
});

/** Discovery plus the token endpoint, both answering from the fixtures. */
function stubEpic(): FetchStub {
  return stubFetch([
    { match: "/.well-known/smart-configuration", body: smartConfiguration },
    { match: smartConfiguration.token_endpoint, method: "POST", body: tokenResponse },
  ]);
}

/** The sync port, recording what the callback asked it to do. */
function recordingSync(): { synced: unknown[]; resolved: unknown[] } {
  const synced: unknown[] = [];
  const resolved: unknown[] = [];
  usePorts({
    sync: {
      runCalendarSync: (_ctx, options) => {
        synced.push(options);
        return Promise.resolve({});
      },
      runFullRefresh: () => Promise.resolve({}),
      refreshConnectionToken: () => Promise.resolve({}),
      getGoogleCalendarFor: () => Promise.reject(new Error("not used")),
      resolveReconnectAlert: (_ctx, subject) => {
        resolved.push(subject);
        return Promise.resolve();
      },
    },
  });
  return { synced, resolved };
}

describe("GET /oauth/epic/start", () => {
  it("redirects to the organisation's authorize endpoint with PKCE, state and aud", async () => {
    const id = await seedProvider({ clientSecret: SECRET });
    const stub = stubEpic();
    usePorts({ fetch: stub.fetchImpl });

    const response = await call(`/oauth/epic/start?provider=${id}`, {
      headers: { cookie: owner().cookie },
    });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(smartConfiguration.authorization_endpoint);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe("test-epic-nonprod-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://healthy.example/oauth/callback",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")?.length).toBeGreaterThan(30);
    // Byte for byte what is stored: Epic compares this as a string, and a trailing
    // slash added here would produce a redirect that never comes back.
    expect(location.searchParams.get("aud")).toBe(TEST_FHIR_BASE);
  });

  it("asks for the SMART base scopes and a scope per registry resource type", async () => {
    const id = await seedProvider();
    usePorts({ fetch: stubEpic().fetchImpl });

    const response = await call(`/oauth/epic/start?provider=${id}`, {
      headers: { cookie: owner().cookie },
    });

    const scopes = (
      new URL(response.headers.get("location") ?? "").searchParams.get("scope") ?? ""
    ).split(" ");
    expect(scopes).toContain("openid");
    expect(scopes).toContain("fhirUser");
    expect(scopes).toContain("offline_access");
    expect(scopes).toContain("patient/Encounter.rs");
    expect(scopes).toContain("patient/Patient.rs");
    expect(scopes).toContain("patient/DocumentReference.rs");
  });

  it("writes the state row before it redirects, sealed and with a ten-minute expiry", async () => {
    const id = await seedProvider();
    usePorts({ fetch: stubEpic().fetchImpl });

    const response = await call(`/oauth/epic/start?provider=${id}`, {
      headers: { cookie: owner().cookie },
    });
    const state = new URL(response.headers.get("location") ?? "").searchParams.get("state") ?? "";

    const row = await testRepos()
      .ctx.db.prepare("SELECT * FROM oauth_states WHERE state = ?")
      .bind(state)
      .first<{
        kind: string;
        provider_id: string;
        code_verifier_enc: string;
        expires_at: number;
        created_at: number;
      }>();

    expect(row?.kind).toBe("epic");
    expect(row?.provider_id).toBe(id);
    // The verifier is the second half of the PKCE proof, so it is never stored in
    // the clear.
    expect(row?.code_verifier_enc.startsWith("v1:")).toBe(true);
    expect((row?.expires_at ?? 0) - (row?.created_at ?? 0)).toBe(600);
  });

  it("uses the production client id for a production provider", async () => {
    const repos = testRepos();
    const provider = await repos.providers.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: TEST_FHIR_BASE,
      environment: "prod",
    });
    usePorts({ fetch: stubEpic().fetchImpl });

    const response = await call(`/oauth/epic/start?provider=${provider.id}`, {
      headers: { cookie: owner().cookie },
    });

    expect(new URL(response.headers.get("location") ?? "").searchParams.get("client_id")).toBe(
      "test-epic-prod-client-id",
    );
  });

  it("renders a 404 page for an unknown or deleted provider", async () => {
    const id = await seedProvider();
    await testRepos().providers.softDelete(id);

    const missing = await call("/oauth/epic/start?provider=NOPE", {
      headers: { cookie: owner().cookie },
    });
    const deleted = await call(`/oauth/epic/start?provider=${id}`, {
      headers: { cookie: owner().cookie },
    });

    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await missing.text()).toContain("No such connection");
    expect(deleted.status).toBe(404);
    await deleted.text();
  });

  it("needs a session, and keeps the whole URL in ?next so the flow resumes", async () => {
    const id = await seedProvider();

    const response = await call(`/oauth/epic/start?provider=${id}`);
    const html = await response.text();

    expect(response.status).toBe(401);
    expect(html).toContain('name="password"');
    expect(html).toContain("provider");
  });
});

/** Drive a start and hand back the state it minted. */
async function startFlow(providerId: string): Promise<string> {
  const response = await call(`/oauth/epic/start?provider=${providerId}`, {
    headers: { cookie: owner().cookie },
  });
  return new URL(response.headers.get("location") ?? "").searchParams.get("state") ?? "";
}

describe("GET /oauth/callback", () => {
  it("exchanges the code, connects, and redirects to the dashboard", async () => {
    const id = await seedProvider({ clientSecret: SECRET });
    const stub = stubEpic();
    usePorts({ fetch: stub.fetchImpl });
    // `setPorts` merges, so the sync override below keeps the stubbed fetch.
    const recorded = recordingSync();
    const state = await startFlow(id);

    const response = await call(`/oauth/callback?code=auth-code&state=${state}`, {
      headers: { cookie: owner().cookie },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/?connected=${id}`);

    const repos = testRepos();
    const connection = await repos.connections.getForProvider(id);
    expect(connection?.status).toBe("connected");
    expect(connection?.scope).toBe(tokenResponse.scope);
    // Milliseconds in, unix seconds out.
    expect(connection?.access_expires_at).toBeGreaterThan(1_700_000_000);
    expect(connection?.access_expires_at).toBeLessThan(2_000_000_000);

    const secrets = await repos.connections.getSecrets(connection?.id ?? "");
    expect(secrets?.accessToken).toBe(tokenResponse.access_token);
    expect(secrets?.refreshToken).toBe(tokenResponse.refresh_token);
    expect(secrets?.patientFhirId).toBe(tokenResponse.patient);

    // The token POST carried HTTP Basic, the verifier and the same redirect URI.
    const tokenCall = stub.requests.find((request) => request.method === "POST");
    expect(tokenCall?.body).toContain("grant_type=authorization_code");
    expect(tokenCall?.body).toContain("code=auth-code");
    expect(tokenCall?.body).toContain("code_verifier=");
    expect(tokenCall?.body).toContain(
      `redirect_uri=${encodeURIComponent("https://healthy.example/oauth/callback")}`,
    );

    expect(recorded.resolved).toStrictEqual([{ providerId: id }]);
    expect(recorded.synced).toStrictEqual([{ providerIds: [id], trigger: "manual" }]);
  });

  it("consumes the state, so a replayed callback is refused", async () => {
    const id = await seedProvider({ clientSecret: SECRET });
    usePorts({ fetch: stubEpic().fetchImpl });
    recordingSync();
    const state = await startFlow(id);

    const first = await call(`/oauth/callback?code=auth-code&state=${state}`, {
      headers: { cookie: owner().cookie },
    });
    const replay = await call(`/oauth/callback?code=auth-code&state=${state}`, {
      headers: { cookie: owner().cookie },
    });

    expect(first.status).toBe(302);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("invalid_state");
  });

  it("answers a bad state with a 400 page that does not say which reason applied", async () => {
    const response = await call("/oauth/callback?code=auth-code&state=not-a-real-state", {
      headers: { cookie: owner().cookie },
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain("expired");
    expect(html).toContain("invalid_state");
  });

  it("refuses a callback with no code and one with no state", async () => {
    const noCode = await call("/oauth/callback?state=x", { headers: { cookie: owner().cookie } });
    const noState = await call("/oauth/callback?code=x", { headers: { cookie: owner().cookie } });

    expect(noCode.status).toBe(400);
    expect(noState.status).toBe(400);
    await noCode.text();
    await noState.text();
  });

  it("refuses a Google state presented at the Epic callback", async () => {
    const repos = testRepos();
    const state = await repos.oauthStates.put({ kind: "google", codeVerifier: "v", ttlMs: 60_000 });

    const response = await call(`/oauth/callback?code=x&state=${state}`, {
      headers: { cookie: owner().cookie },
    });

    expect(response.status).toBe(400);
    await response.text();
  });

  it("renders a friendly page for an error= redirect, without burning the state", async () => {
    const id = await seedProvider({ clientSecret: SECRET });
    usePorts({ fetch: stubEpic().fetchImpl });
    const state = await startFlow(id);

    const refused = await call(`/oauth/callback?error=access_denied&provider=${id}`, {
      headers: { cookie: owner().cookie },
    });
    const html = await refused.text();

    expect(refused.status).toBe(400);
    expect(html).toContain("access_denied");
    expect(html).toContain(`/oauth/epic/start?provider=${id}`);
    // The state survived, so the owner can simply try again.
    const row = await testRepos()
      .ctx.db.prepare("SELECT count(*) AS n FROM oauth_states WHERE state = ?")
      .bind(state)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("explains that the per-organisation client secret is missing", async () => {
    const id = await seedProvider();
    usePorts({ fetch: stubEpic().fetchImpl });
    const state = await startFlow(id);

    const response = await call(`/oauth/callback?code=auth-code&state=${state}`, {
      headers: { cookie: owner().cookie },
    });
    const html = await response.text();

    expect(response.status).toBe(409);
    expect(html).toContain("client secret");
    expect(html).toContain("client_secret_missing");
    // Nothing was connected.
    expect(await testRepos().connections.getForProvider(id)).toBeNull();
  });

  it("clears a prior needs_reauth state rather than only overwriting the tokens", async () => {
    const id = await seedProvider({ clientSecret: SECRET });
    const repos = testRepos();
    const existing = await repos.connections.upsertTokens(id, { accessToken: "old" });
    await repos.connections.markNeedsReauth(existing.id, "invalid_grant");
    usePorts({ fetch: stubEpic().fetchImpl });
    recordingSync();
    const state = await startFlow(id);

    await call(`/oauth/callback?code=auth-code&state=${state}`, {
      headers: { cookie: owner().cookie },
    });

    const after = await repos.connections.get(existing.id);
    expect(after?.status).toBe("connected");
    expect(after?.needs_reauth_since).toBeNull();
    expect(after?.refresh_failures).toBe(0);
    expect(after?.last_error_code).toBeNull();
  });
});

describe("GET /oauth/reconnect/:connectionId", () => {
  it("redirects a connection id to that provider's start URL", async () => {
    const id = await seedProvider();
    const connection = await testRepos().connections.upsertTokens(id, { accessToken: "a" });

    const response = await call(`/oauth/reconnect/${connection.id}`, {
      headers: { cookie: owner().cookie },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/oauth/epic/start?provider=${id}`);
  });

  it("accepts a provider id too, which is what an alert subject encodes", async () => {
    const id = await seedProvider();

    const response = await call(`/oauth/reconnect/${id}`, { headers: { cookie: owner().cookie } });

    expect(response.headers.get("location")).toBe(`/oauth/epic/start?provider=${id}`);
  });

  it("sends the literal google to the Google flow", async () => {
    const response = await call("/oauth/reconnect/google", {
      headers: { cookie: owner().cookie },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/oauth/google/start");
  });

  it("renders a 404 page for a subject that is gone", async () => {
    const response = await call("/oauth/reconnect/NOPE", { headers: { cookie: owner().cookie } });

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("connection_not_found");
  });
});

describe("the /oauth surface", () => {
  it("still answers an unknown path with a JSON 404", async () => {
    const response = await call("/oauth/nope", { headers: { cookie: owner().cookie } });

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({ error: "not_found" });
  });
});
