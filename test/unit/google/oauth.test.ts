import { describe, expect, it } from "vitest";

import {
  createGoogleOAuth,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_USERINFO_SCOPES,
} from "../../../worker/google/oauth.ts";
import { AppError } from "../../../worker/lib/errors.ts";

import { appErrorFrom, jsonResponse, recordingFetch } from "./helpers.ts";

import type { GoogleOAuth } from "../../../worker/google/oauth.ts";

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT_URI = "https://example.test/oauth/google/callback";
// A fixed clock so `expiresAt` is exact rather than approximate.
const NOW = 1_700_000_000_000;

function make(fetchImpl: typeof fetch, scopes?: readonly string[]): GoogleOAuth {
  return createGoogleOAuth({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    fetchImpl,
    now: () => NOW,
    ...(scopes !== undefined && { scopes }),
  });
}

const neverCalled = (() => {
  throw new Error("fetch must not be called");
}) as unknown as typeof fetch;

describe("buildAuthUrl", () => {
  it("requests offline access, forces consent, and keeps already-granted scopes", () => {
    const url = new URL(make(neverCalled).buildAuthUrl({ state: "nonce-123" }));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("nonce-123");
    // The three parameters that make a refresh token arrive on every consent.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  });

  it("defaults to the two calendar scopes and nothing else", () => {
    const url = new URL(make(neverCalled).buildAuthUrl({ state: "s" }));
    const scope = url.searchParams.get("scope");

    expect(scope).toBe(GOOGLE_CALENDAR_SCOPES.join(" "));
    // No identity scope by default: the app never needs the owner's address.
    expect(scope).not.toContain("openid");
  });

  it("lets the deployment request identity scopes explicitly", () => {
    const scopes = [...GOOGLE_CALENDAR_SCOPES, ...GOOGLE_USERINFO_SCOPES];
    const url = new URL(make(neverCalled, scopes).buildAuthUrl({ state: "s" }));

    expect(url.searchParams.get("scope")).toBe(scopes.join(" "));
  });

  it("accepts a per-call scope override", () => {
    const url = new URL(
      make(neverCalled).buildAuthUrl({ state: "s", scopes: GOOGLE_USERINFO_SCOPES }),
    );

    expect(url.searchParams.get("scope")).toBe("openid email");
  });

  it("refuses to build a URL without state", () => {
    expect(() => make(neverCalled).buildAuthUrl({ state: "" })).toThrow(AppError);
  });
});

describe("exchangeCode", () => {
  it("posts the authorization_code grant and returns an absolute expiry", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3599,
        scope: GOOGLE_CALENDAR_SCOPES.join(" "),
      }),
    );

    const tokens = await make(fetchImpl).exchangeCode("code-abc");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.href).toBe("https://oauth2.googleapis.com/token");
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call.body ?? "");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-abc");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(form.get("redirect_uri")).toBe(REDIRECT_URI);

    expect(tokens).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: NOW + 3599 * 1000,
      scope: GOOGLE_CALENDAR_SCOPES.join(" "),
    });
  });

  it("rejects a response with no refresh_token and names the fix", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(200, { access_token: "at-1", expires_in: 3600, scope: "x" }),
    );

    const error = await appErrorFrom(make(fetchImpl).exchangeCode("code-abc"));

    expect(error.code).toBe("bad_request");
    expect(error.message).toContain("access_type=offline");
    expect(error.message).toContain("prompt=consent");
  });

  it("maps a rejected code to upstream_error", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(400, { error: "invalid_request" }));

    const error = await appErrorFrom(make(fetchImpl).exchangeCode("code-abc"));

    expect(error.code).toBe("upstream_error");
  });

  it("maps an expired or reused code to bad_request, not needs_reauth", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(400, { error: "invalid_grant", error_description: "Bad Request" }),
    );

    const error = await appErrorFrom(make(fetchImpl).exchangeCode("code-stale"));

    // A first-time connect has no connection to mark and no reconnect card to
    // open; only a failed *refresh* means needs_reauth.
    expect(error.code).toBe("bad_request");
    expect(error.message).toContain("restart the connect flow");
  });
});

describe("refresh", () => {
  it("posts the refresh_token grant and returns no new refresh token", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, { access_token: "at-2", expires_in: 3600 }),
    );

    const refreshed = await make(fetchImpl).refresh("rt-1");

    const form = new URLSearchParams(calls[0]?.body ?? "");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt-1");
    expect(refreshed).toEqual({ accessToken: "at-2", expiresAt: NOW + 3_600_000, scope: "" });
    expect(refreshed).not.toHaveProperty("refreshToken");
  });

  it("maps 400 invalid_grant to needs_reauth", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      }),
    );

    const error = await appErrorFrom(make(fetchImpl).refresh("rt-dead"));

    expect(error.code).toBe("needs_reauth");
    expect(error.status).toBe(409);
  });

  it("maps 5xx to upstream_unavailable and carries Retry-After", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(503, { error: "unavailable" }, { "retry-after": "30" }),
    );

    const error = await appErrorFrom(make(fetchImpl).refresh("rt-1"));

    expect(error.code).toBe("upstream_unavailable");
    expect(error.retryAfterMs).toBe(30_000);
  });

  it("maps 429 to upstream_unavailable", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(429, { error: "rateLimitExceeded" }));

    const error = await appErrorFrom(make(fetchImpl).refresh("rt-1"));

    expect(error.code).toBe("upstream_unavailable");
  });

  it("maps any other 4xx to upstream_error", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(401, { error: "invalid_client" }));

    const error = await appErrorFrom(make(fetchImpl).refresh("rt-1"));

    expect(error.code).toBe("upstream_error");
  });
});

describe("revoke", () => {
  it("posts the token and reports success", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 200 }));

    await expect(make(fetchImpl).revoke("at-1")).resolves.toBe(true);
    expect(calls[0]?.url.href).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(calls[0]?.body ?? "").get("token")).toBe("at-1");
  });

  it("never throws when Google refuses", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(400, { error: "invalid_token" }));

    await expect(make(fetchImpl).revoke("at-1")).resolves.toBe(false);
  });

  it("never throws when the request itself fails", async () => {
    await expect(make(neverCalled).revoke("at-1")).resolves.toBe(false);
  });
});

describe("userinfo", () => {
  it("returns the email when the identity scopes are granted", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, { sub: "1", email: "owner@example.test", email_verified: true }),
    );

    await expect(make(fetchImpl).userinfo("at-1")).resolves.toEqual({
      email: "owner@example.test",
    });
    expect(calls[0]?.url.href).toBe("https://www.googleapis.com/oauth2/v3/userinfo");
    expect(calls[0]?.headers.authorization).toBe("Bearer at-1");
  });

  it("explains the missing scope on a 403", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(403, { error: { code: 403 } }));

    const error = await appErrorFrom(make(fetchImpl).userinfo("at-1"));

    expect(error.code).toBe("upstream_auth");
    expect(error.message).toContain("openid email");
  });
});

describe("primaryCalendarSummary", () => {
  it("names the connected account without an identity scope", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, { id: "owner@example.test", summary: "owner@example.test", primary: true }),
    );

    await expect(make(fetchImpl).primaryCalendarSummary("at-1")).resolves.toEqual({
      id: "owner@example.test",
      summary: "owner@example.test",
    });
    expect(calls[0]?.url.href).toBe(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary",
    );
  });

  it("is display-only, so a failure resolves to null", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(404, { error: { code: 404 } }));

    await expect(make(fetchImpl).primaryCalendarSummary("at-1")).resolves.toBeNull();
  });
});
