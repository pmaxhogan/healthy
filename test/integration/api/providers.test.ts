// `/api/providers`, end to end in real workerd against real D1.
//
// The assertion this file exists for is the last one: **the per-organisation client
// secret is write-only.** It is set through `POST /api/providers/:id/secret`, it is
// sealed by the repo, and no GET anywhere under /api may return it or its
// ciphertext. Everything else here is the CRUD around that.

import { afterEach, describe, expect, it } from "vitest";

import { allBrands } from "../../../worker/brands.ts";
import { AppError } from "../../../worker/lib/errors.ts";
import smartConfiguration from "../../fixtures/epic/smart-configuration.json";

import {
  CSRF,
  ORIGIN,
  TEST_FHIR_BASE,
  call,
  freshOwner,
  json,
  resetPorts,
  seedProvider,
  stubFetch,
  testRepos,
  usePorts,
} from "./helpers.ts";

import type { ApiError, ProviderDto } from "@shared/types.ts";

const SECRET = "the-per-org-client-secret";

const owner = freshOwner();

afterEach(() => {
  resetPorts();
});

/** A brand id out of the committed index. Derived, so no organisation is named here. */
function someBrandId(): string {
  return allBrands()[0]?.id ?? "";
}

describe("POST /api/providers", () => {
  it("creates a provider from a brand id, with no upstream call at all", async () => {
    // A brand's endpoint comes from Epic's own published directory, so there is
    // nothing to validate -- and a stub-less fetch proves none is attempted.
    const response = await owner().send("POST", "/api/providers", {
      displayName: "Example Health",
      brandId: someBrandId(),
      environment: "sandbox",
    });

    expect(response.status).toBe(201);
    const dto = await json<ProviderDto>(response);
    expect(dto.vendor).toBe("epic");
    expect(dto.brandKey).toBe(someBrandId());
    expect(dto.fhirBaseUrl).toBe(allBrands()[0]?.fhirBaseUrl);
    expect(dto.hasClientSecret).toBe(false);
    expect(dto.connection).toBeNull();
  });

  it("stores a client secret given at creation, and reports only that it exists", async () => {
    const response = await owner().send("POST", "/api/providers", {
      displayName: "Example Health",
      brandId: someBrandId(),
      environment: "sandbox",
      clientSecret: SECRET,
    });

    const dto = await json<ProviderDto>(response);
    expect(dto.hasClientSecret).toBe(true);
    // And it really is sealed, not merely hidden by the projection.
    const stored = await testRepos().providers.getClientSecret(dto.id);
    expect(stored).toBe(SECRET);
  });

  it("validates a manual FHIR base with a discovery request before inserting", async () => {
    const stub = stubFetch([
      { match: "/.well-known/smart-configuration", body: smartConfiguration },
    ]);
    usePorts({ fetch: stub.fetchImpl });

    const response = await owner().send("POST", "/api/providers", {
      displayName: "Example Health",
      fhirBaseUrl: TEST_FHIR_BASE,
      environment: "sandbox",
    });

    expect(response.status).toBe(201);
    expect(stub.requests[0]?.url).toBe(`${TEST_FHIR_BASE}/.well-known/smart-configuration`);
    const dto = await json<ProviderDto>(response);
    expect(dto.brandKey).toBeNull();
  });

  it("refuses to insert a manual base whose discovery fails", async () => {
    const stub = stubFetch([
      { match: "/.well-known/smart-configuration", status: 404, body: { error: "nope" } },
    ]);
    usePorts({ fetch: stub.fetchImpl });

    const response = await owner().send("POST", "/api/providers", {
      displayName: "Example Health",
      fhirBaseUrl: TEST_FHIR_BASE,
      environment: "sandbox",
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await json<ProviderDto[]>(await owner().get("/api/providers"))).toStrictEqual([]);
  });

  it("refuses a request that gives both a brand and a manual base", async () => {
    const response = await owner().send("POST", "/api/providers", {
      displayName: "Example Health",
      brandId: someBrandId(),
      fhirBaseUrl: TEST_FHIR_BASE,
      environment: "sandbox",
    });

    const body = await json<ApiError>(response);
    expect(response.status).toBe(400);
    expect(body.error).toBe("bad_request");
  });

  it("refuses a request that gives neither", async () => {
    const response = await owner().send("POST", "/api/providers", {
      displayName: "Example Health",
      environment: "sandbox",
    });

    expect(response.status).toBe(400);
  });

  it("refuses an unknown brand id", async () => {
    const response = await owner().send("POST", "/api/providers", {
      displayName: "Example Health",
      brandId: "not-a-brand",
      environment: "sandbox",
    });

    expect(response.status).toBe(400);
  });

  it("rejects a body that is not JSON as a 400, not a 500", async () => {
    const response = await call("/api/providers", {
      method: "POST",
      headers: {
        cookie: owner().cookie,
        origin: ORIGIN,
        ...CSRF,
        "content-type": "application/json",
      },
      body: "{not json",
    });

    const body = await json<ApiError>(response);
    expect(response.status).toBe(400);
    expect(body.error).toBe("bad_request");
  });

  it("reports the offending field without echoing its value", async () => {
    const response = await owner().send("POST", "/api/providers", {
      displayName: "",
      brandId: someBrandId(),
      environment: "sandbox",
    });

    const body = await json<ApiError>(response);
    expect(response.status).toBe(400);
    expect(JSON.stringify(body.details)).toContain("displayName");
  });
});

describe("the CSRF guard on /api", () => {
  it("rejects a POST with no x-healthy-csrf header", async () => {
    const response = await call("/api/providers", {
      method: "POST",
      headers: { cookie: owner().cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "X", brandId: someBrandId(), environment: "sandbox" }),
    });

    const body = await json<ApiError>(response);
    expect(response.status).toBe(403);
    expect(body.error).toBe("forbidden");
    // And nothing was written.
    expect(await json<ProviderDto[]>(await owner().get("/api/providers"))).toStrictEqual([]);
  });

  it("rejects a DELETE with no x-healthy-csrf header", async () => {
    const id = await seedProvider();

    const response = await call(`/api/providers/${id}`, {
      method: "DELETE",
      headers: { cookie: owner().cookie, origin: ORIGIN },
    });

    expect(response.status).toBe(403);
    const after = await json<ProviderDto[]>(await owner().get("/api/providers"));
    expect(after).toHaveLength(1);
  });
});

describe("POST /api/providers/:id/secret", () => {
  it("sets the secret and flips hasClientSecret", async () => {
    const id = await seedProvider();
    const before = await json<ProviderDto>(await owner().get(`/api/providers/${id}`));
    expect(before.hasClientSecret).toBe(false);

    const response = await owner().send("POST", `/api/providers/${id}/secret`, {
      clientSecret: SECRET,
    });

    const after = await json<ProviderDto>(response);
    expect(response.status).toBe(200);
    expect(after.hasClientSecret).toBe(true);
  });

  it("404s for a provider that does not exist", async () => {
    const response = await owner().send("POST", "/api/providers/NOPE/secret", {
      clientSecret: SECRET,
    });

    expect(response.status).toBe(404);
  });
});

describe("the client secret never appears in a GET body", () => {
  it("is absent from every read endpoint, in plaintext and as ciphertext", async () => {
    const id = await seedProvider({ clientSecret: SECRET });
    // The sealed column, read straight out of D1, so the ciphertext can be searched
    // for too -- omitting a field is not the same as omitting its value.
    const row = await testRepos().providers.get(id);
    const ciphertext = row?.client_secret_enc ?? "";
    expect(ciphertext).not.toBe("");

    for (const path of [
      "/api/providers",
      `/api/providers/${id}`,
      "/api/overview",
      "/api/settings",
    ]) {
      const response = await owner().get(path);
      const body = await response.text();

      expect(body, path).not.toContain(SECRET);
      expect(body, path).not.toContain(ciphertext);
      expect(body, path).not.toContain("client_secret");
      expect(body, path).not.toMatch(/[a-z]_enc/);
    }
  });
});

describe("GET and PATCH /api/providers/:id", () => {
  it("reads one provider", async () => {
    const id = await seedProvider();

    const dto = await json<ProviderDto>(await owner().get(`/api/providers/${id}`));

    expect(dto.id).toBe(id);
    expect(dto.environment).toBe("sandbox");
    expect(dto.config.enabled).toBe(true);
  });

  it("404s for an unknown id", async () => {
    const response = await owner().get("/api/providers/NOPE");
    expect(response.status).toBe(404);
  });

  it("patches the display name and the config", async () => {
    const id = await seedProvider();

    const response = await owner().send("PATCH", `/api/providers/${id}`, {
      displayName: "Renamed Health",
      config: { orgShort: "RH", arrivalOffsetMin: 20, enabled: false },
    });

    const dto = await json<ProviderDto>(response);
    expect(dto.displayName).toBe("Renamed Health");
    expect(dto.config.orgShort).toBe("RH");
    expect(dto.config.arrivalOffsetMin).toBe(20);
    expect(dto.config.enabled).toBe(false);
  });

  it("clears the portal URL with an explicit null", async () => {
    const id = await seedProvider();

    const dto = await json<ProviderDto>(
      await owner().send("PATCH", `/api/providers/${id}`, { portalUrl: null }),
    );

    expect(dto.portalUrl).toBeNull();
  });
});

describe("DELETE /api/providers/:id", () => {
  it("disconnects, soft deletes, and leaves the calendar events alone", async () => {
    const id = await seedProvider({ clientSecret: SECRET });
    const repos = testRepos();
    const connection = await repos.connections.upsertTokens(id, {
      accessToken: "a",
      refreshToken: "r",
      status: "connected",
    });
    await repos.calendarEvents.upsert({
      eventKey: `${id}:enc-1`,
      providerId: id,
      encounterId: "enc-1",
      calendarId: "primary",
      googleEventId: "gcal-1",
      fingerprint: "fp-1",
    });

    const response = await owner().send("DELETE", `/api/providers/${id}`);

    expect(response.status).toBe(200);
    // Gone from the API...
    expect(await json<ProviderDto[]>(await owner().get("/api/providers"))).toStrictEqual([]);
    const gone = await owner().get(`/api/providers/${id}`);
    expect(gone.status).toBe(404);
    // ...the tokens destroyed...
    const after = await repos.connections.get(connection.id);
    expect(after?.status).toBe("disconnected");
    expect(after?.refresh_token_enc).toBeNull();
    // ...and the appointment history untouched, which is the whole point of a soft
    // delete: those events are in the owner's calendar either way.
    expect(await repos.calendarEvents.getByKey(`${id}:enc-1`)).not.toBeNull();
  });

  it("404s the second time", async () => {
    const id = await seedProvider();
    await owner().send("DELETE", `/api/providers/${id}`);

    const second = await owner().send("DELETE", `/api/providers/${id}`);
    expect(second.status).toBe(404);
  });
});

describe("the provider actions", () => {
  it("answers 202 and runs the sync after the response", async () => {
    const id = await seedProvider();
    const seen: { providerIds?: string[]; trigger: string }[] = [];
    usePorts({
      sync: {
        runCalendarSync: (_ctx, options) => {
          seen.push(options);
          return Promise.resolve({});
        },
        runFullRefresh: () => Promise.resolve({}),
        refreshConnectionToken: () => Promise.resolve({}),
        getGoogleCalendarFor: () => Promise.reject(new Error("not used")),
        resolveReconnectAlert: () => Promise.resolve(),
      },
    });

    const response = await owner().send("POST", `/api/providers/${id}/sync`);

    expect(response.status).toBe(202);
    expect(await json<{ accepted: boolean }>(response)).toStrictEqual({ accepted: true });
    // `call` awaits the execution context, so the background work has finished.
    expect(seen).toStrictEqual([{ providerIds: [id], trigger: "manual" }]);
  });

  it("still answers 202 when the sync engine throws, because the work is detached", async () => {
    const id = await seedProvider();
    usePorts({
      sync: {
        runCalendarSync: () => Promise.reject(new Error("upstream down")),
        runFullRefresh: () => Promise.resolve({}),
        refreshConnectionToken: () => Promise.resolve({}),
        getGoogleCalendarFor: () => Promise.reject(new Error("not used")),
        resolveReconnectAlert: () => Promise.resolve(),
      },
    });

    const response = await owner().send("POST", `/api/providers/${id}/sync`);
    expect(response.status).toBe(202);
  });

  it("runs a full refresh for one provider", async () => {
    const id = await seedProvider();
    const seen: { providerIds?: string[] }[] = [];
    usePorts({
      sync: {
        runCalendarSync: () => Promise.resolve({}),
        runFullRefresh: (_ctx, options) => {
          seen.push(options);
          return Promise.resolve({});
        },
        refreshConnectionToken: () => Promise.resolve({}),
        getGoogleCalendarFor: () => Promise.reject(new Error("not used")),
        resolveReconnectAlert: () => Promise.resolve(),
      },
    });

    const response = await owner().send("POST", `/api/providers/${id}/full-refresh`);

    expect(response.status).toBe(202);
    expect(seen).toStrictEqual([{ providerIds: [id] }]);
  });

  it("forces a token refresh and answers with the connection's new state", async () => {
    const id = await seedProvider();
    const repos = testRepos();
    await repos.connections.upsertTokens(id, { accessToken: "a", status: "needs_reauth" });
    usePorts({
      sync: {
        runCalendarSync: () => Promise.resolve({}),
        runFullRefresh: () => Promise.resolve({}),
        refreshConnectionToken: async (_ctx, providerId) => {
          await repos.connections.upsertTokens(providerId, {
            accessToken: "fresh",
            refreshToken: "fresh-refresh",
            status: "connected",
          });
        },
        getGoogleCalendarFor: () => Promise.reject(new Error("not used")),
        resolveReconnectAlert: () => Promise.resolve(),
      },
    });

    const response = await owner().send("POST", `/api/providers/${id}/refresh-token`);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"status":"connected"');
    expect(body).toContain('"hasRefreshToken":true');
    expect(body).not.toContain("fresh-refresh");
  });

  it("syncs every provider through POST /api/sync/run, with no body", async () => {
    await seedProvider();
    const seen: unknown[] = [];
    usePorts({
      sync: {
        runCalendarSync: (_ctx, options) => {
          seen.push(options);
          return Promise.resolve({});
        },
        runFullRefresh: () => Promise.resolve({}),
        refreshConnectionToken: () => Promise.resolve({}),
        getGoogleCalendarFor: () => Promise.reject(new Error("not used")),
        resolveReconnectAlert: () => Promise.resolve(),
      },
    });

    const response = await call("/api/sync/run", {
      method: "POST",
      headers: { cookie: owner().cookie, origin: ORIGIN, ...CSRF },
    });

    expect(response.status).toBe(202);
    expect(seen).toStrictEqual([{ trigger: "manual" }]);
  });

  it("reports a sync-engine failure as its own code, with no message and no stack trace", async () => {
    const id = await seedProvider();
    usePorts({
      sync: {
        runCalendarSync: () => Promise.resolve({}),
        runFullRefresh: () => Promise.resolve({}),
        refreshConnectionToken: () =>
          Promise.reject(new AppError("upstream_unavailable", "epic said 503: <html>...")),
        getGoogleCalendarFor: () => Promise.reject(new Error("not used")),
        resolveReconnectAlert: () => Promise.resolve(),
      },
    });

    const response = await owner().send("POST", `/api/providers/${id}/refresh-token`);
    const body = await json<ApiError>(response);

    expect(response.status).toBe(503);
    expect(body.error).toBe("upstream_unavailable");
    // A 5xx message can quote an upstream response body, which is why it is dropped.
    expect(body.message).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("<html>");
    expect(JSON.stringify(body)).not.toContain("at ");
  });
});
