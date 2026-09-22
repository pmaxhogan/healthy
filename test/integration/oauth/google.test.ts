// Google Calendar authorisation, end to end against a stubbed Google.
//
// The interesting parts are the three query parameters that decide whether a refresh
// token is ever issued (`access_type=offline`, `prompt=consent`,
// `include_granted_scopes=true`), and the account label: the flow reads the primary
// calendar's id, seals it into `google_account.email_enc`, and the API masks it. A
// deployment that skipped the first three would work for an hour and then be
// unrecoverable.

import { afterEach, describe, expect, it } from "vitest";

import {
  call,
  freshOwner,
  json,
  resetPorts,
  stubFetch,
  testRepos,
  usePorts,
} from "../api/helpers.ts";

import type { FetchStub } from "../api/helpers.ts";
import type { GoogleAccountDto } from "@shared/types.ts";

const EMAIL = "person@example.test";
const ACCESS = "google-access-token";
const REFRESH = "google-refresh-token";

const owner = freshOwner();

afterEach(() => {
  resetPorts();
});

/** Google's token endpoint and the primary calendar lookup. */
function stubGoogle(overrides: { tokenBody?: unknown } = {}): FetchStub {
  return stubFetch([
    {
      match: "oauth2.googleapis.com/token",
      method: "POST",
      body: overrides.tokenBody ?? {
        access_token: ACCESS,
        refresh_token: REFRESH,
        expires_in: 3599,
        scope: "https://www.googleapis.com/auth/calendar.events.owned",
        token_type: "Bearer",
      },
    },
    {
      match: "calendar/v3/users/me/calendarList/primary",
      body: { id: EMAIL, summary: EMAIL, primary: true },
    },
  ]);
}

/** A sync port that records the reconnect-alert resolution and nothing else. */
function recordingSync(): { resolved: unknown[] } {
  const resolved: unknown[] = [];
  usePorts({
    sync: {
      runCalendarSync: () => Promise.resolve({}),
      runFullRefresh: () => Promise.resolve({}),
      refreshConnectionToken: () => Promise.resolve({}),
      getGoogleCalendarFor: () => Promise.reject(new Error("not used")),
      resolveReconnectAlert: (_ctx, subject) => {
        resolved.push(subject);
        return Promise.resolve();
      },
    },
  });
  return { resolved };
}

describe("GET /oauth/google/start", () => {
  it("redirects to Google with the three parameters a refresh token depends on", async () => {
    const response = await call("/oauth/google/start", { headers: { cookie: owner().cookie } });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.host).toBe("accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("test-google-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://healthy.example/oauth/google/callback",
    );
    // Without all three, only the very first consent returns a refresh token.
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(location.searchParams.get("include_granted_scopes")).toBe("true");
    expect(location.searchParams.get("scope")).toContain("calendar.events.owned");
    expect(location.searchParams.get("scope")).toContain("calendar.calendarlist.readonly");
    // Deliberately not the identity scopes: this app never needs the address for
    // its own sake.
    expect(location.searchParams.get("scope")).not.toContain("openid");
  });

  it("writes a google state row with no provider, which the table's CHECK requires", async () => {
    const response = await call("/oauth/google/start", { headers: { cookie: owner().cookie } });
    const state = new URL(response.headers.get("location") ?? "").searchParams.get("state") ?? "";

    const row = await testRepos()
      .ctx.db.prepare(
        "SELECT kind, provider_id, expires_at, created_at FROM oauth_states WHERE state = ?",
      )
      .bind(state)
      .first<{
        kind: string;
        provider_id: string | null;
        expires_at: number;
        created_at: number;
      }>();

    expect(row?.kind).toBe("google");
    expect(row?.provider_id).toBeNull();
    expect((row?.expires_at ?? 0) - (row?.created_at ?? 0)).toBe(600);
  });

  it("needs a session", async () => {
    const response = await call("/oauth/google/start");

    expect(response.status).toBe(401);
    await response.text();
  });
});

/** Drive a start and hand back the state it minted. */
async function startFlow(): Promise<string> {
  const response = await call("/oauth/google/start", { headers: { cookie: owner().cookie } });
  return new URL(response.headers.get("location") ?? "").searchParams.get("state") ?? "";
}

describe("GET /oauth/google/callback", () => {
  it("exchanges the code, seals the tokens and the label, and redirects", async () => {
    const stub = stubGoogle();
    usePorts({ fetch: stub.fetchImpl });
    const recorded = recordingSync();
    const state = await startFlow();

    const response = await call(`/oauth/google/callback?code=auth-code&state=${state}`, {
      headers: { cookie: owner().cookie },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?google=connected");

    const repos = testRepos();
    const row = await repos.google.get();
    expect(row.status).toBe("connected");
    expect(row.connected_at).not.toBeNull();
    // Milliseconds in, unix seconds out.
    expect(row.access_expires_at).toBeGreaterThan(1_700_000_000);
    expect(row.access_expires_at).toBeLessThan(2_000_000_000);

    const secrets = await repos.google.getSecrets();
    expect(secrets.accessToken).toBe(ACCESS);
    expect(secrets.refreshToken).toBe(REFRESH);
    expect(secrets.email).toBe(EMAIL);

    expect(recorded.resolved).toStrictEqual(["google"]);
  });

  it("masks the label the moment the API is asked about it", async () => {
    usePorts({ fetch: stubGoogle().fetchImpl });
    recordingSync();
    const state = await startFlow();
    await call(`/oauth/google/callback?code=auth-code&state=${state}`, {
      headers: { cookie: owner().cookie },
    });

    const response = await owner().get("/api/google");
    const body = await response.text();

    expect((JSON.parse(body) as GoogleAccountDto).accountLabel).toBe("p…n@example.test");
    expect(body).not.toContain(EMAIL);
  });

  it("connects even when the primary-calendar lookup fails, leaving the label unset", async () => {
    // Display only: a hiccup here must not fail a consent the owner just granted.
    const stub = stubFetch([
      {
        match: "oauth2.googleapis.com/token",
        method: "POST",
        body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, scope: "s" },
      },
      { match: "calendar/v3/users/me/calendarList/primary", status: 403, body: {} },
    ]);
    usePorts({ fetch: stub.fetchImpl });
    recordingSync();
    const state = await startFlow();

    const response = await call(`/oauth/google/callback?code=auth-code&state=${state}`, {
      headers: { cookie: owner().cookie },
    });

    const row = await testRepos().google.get();
    const dto = await json<GoogleAccountDto>(await owner().get("/api/google"));

    expect(response.status).toBe(302);
    expect(row.status).toBe("connected");
    expect(dto.accountLabel).toBeNull();
  });

  it("refuses a response with no refresh token, which would be unrecoverable in an hour", async () => {
    usePorts({
      fetch: stubGoogle({ tokenBody: { access_token: ACCESS, expires_in: 3599, scope: "s" } })
        .fetchImpl,
    });
    recordingSync();
    const state = await startFlow();

    const response = await call(`/oauth/google/callback?code=auth-code&state=${state}`, {
      headers: { cookie: owner().cookie },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("bad_request");
    const row = await testRepos().google.get();
    expect(row.status).toBe("disconnected");
  });

  it("consumes the state, so a replayed callback is refused", async () => {
    usePorts({ fetch: stubGoogle().fetchImpl });
    recordingSync();
    const state = await startFlow();

    const first = await call(`/oauth/google/callback?code=auth-code&state=${state}`, {
      headers: { cookie: owner().cookie },
    });
    const replay = await call(`/oauth/google/callback?code=auth-code&state=${state}`, {
      headers: { cookie: owner().cookie },
    });

    expect(first.status).toBe(302);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("invalid_state");
  });

  it("refuses an Epic state presented at the Google callback", async () => {
    const repos = testRepos();
    const provider = await repos.providers.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
    });
    const state = await repos.oauthStates.put({
      kind: "epic",
      providerId: provider.id,
      codeVerifier: "v",
      ttlMs: 60_000,
    });

    const response = await call(`/oauth/google/callback?code=x&state=${state}`, {
      headers: { cookie: owner().cookie },
    });

    expect(response.status).toBe(400);
    await response.text();
  });

  it("renders a friendly page when the owner declines consent", async () => {
    const response = await call("/oauth/google/callback?error=access_denied", {
      headers: { cookie: owner().cookie },
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("access_denied");
    expect(html).toContain("/oauth/google/start");
  });

  it("closes the open reconnect alert on a successful reconnection", async () => {
    // The card's "this completes itself" promise is what the sync port implements;
    // here the point is only that the callback asks for it.
    usePorts({ fetch: stubGoogle().fetchImpl });
    const recorded = recordingSync();
    const state = await startFlow();

    await call(`/oauth/google/callback?code=auth-code&state=${state}`, {
      headers: { cookie: owner().cookie },
    });

    expect(recorded.resolved).toStrictEqual(["google"]);
  });
});
