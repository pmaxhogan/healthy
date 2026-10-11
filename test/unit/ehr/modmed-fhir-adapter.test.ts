import { describe, expect, it } from "vitest";

import { DEFAULT_REFRESH_SKEW_MS, SMART_BASE_SCOPES } from "../../../worker/ehr/adapter.ts";
import { createModMedFhirAdapter } from "../../../worker/ehr/modmed-fhir/index.ts";
import { AppError } from "../../../worker/lib/errors.ts";
import { noopLogger } from "../../../worker/lib/log.ts";

import { jsonResponse, loadFixture, stubFetch, TEST_FHIR_BASE } from "./fixtures.ts";

const NOW = 1_700_000_000_000;
const CLIENT_ID = "synthetic-modmed-client";
const CLIENT_SECRET = "s3cr&t/=:+ x";
const REDIRECT_URI = "https://healthy.example.test/oauth/callback";

const epicTokenResponse = loadFixture<Record<string, unknown>>("token-response.json");

/** A token response as a short-lived, rotating server would send it. All values invented. */
function tokenBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "synthetic-access-token",
    token_type: "Bearer",
    expires_in: 300,
    refresh_token: "synthetic-rotated-refresh",
    scope: "openid fhirUser offline_access launch/patient patient/Condition.rs",
    patient: "synthetic-patient-9",
    ...overrides,
  };
}

function adapter(fetchImpl: typeof fetch): ReturnType<typeof createModMedFhirAdapter> {
  return createModMedFhirAdapter({ fetchImpl, logger: noopLogger, now: () => NOW });
}

function scopes(types: readonly string[]): string[] {
  return adapter(stubFetch(() => new Response()).fetchImpl).scopesFor(types);
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

describe("adapter shape", () => {
  const built = adapter(stubFetch(() => new Response()).fetchImpl);

  it("identifies itself as modmed", () => {
    expect(built.vendor).toBe("modmed");
  });

  it("refreshes one minute early, tighter than the default", () => {
    expect(built.refreshSkewMs).toBe(60_000);
    expect(built.refreshSkewMs).toBeLessThan(DEFAULT_REFRESH_SKEW_MS);
  });

  it("does not scope patient searches by category", () => {
    expect(built.categoryScopedSearches).toBe(false);
  });

  it("leaves the calendar to the patient portal", () => {
    expect(built.encountersAreAppointments).toBe(false);
  });
});

describe("scopesFor", () => {
  it("starts with the base scopes plus launch/patient", () => {
    expect(scopes([])).toStrictEqual([...SMART_BASE_SCOPES, "launch/patient"]);
  });

  it("keeps resource types the vendor registers, as SMART v2 read+search", () => {
    expect(scopes(["Patient", "Condition", "DocumentReference"])).toStrictEqual([
      ...SMART_BASE_SCOPES,
      "launch/patient",
      "patient/Patient.rs",
      "patient/Condition.rs",
      "patient/DocumentReference.rs",
    ]);
  });

  it("drops types the vendor has no registration for, so the request is not refused", () => {
    const requested = scopes(["Appointment", "Binary", "Observation"]);

    expect(requested).toContain("patient/Observation.rs");
    expect(requested).not.toContain("patient/Appointment.rs");
    expect(requested).not.toContain("patient/Binary.rs");
  });

  it("never repeats a scope", () => {
    const requested = scopes(["Encounter", "Encounter", "Patient", "Encounter"]);

    expect(new Set(requested).size).toBe(requested.length);
  });
});

describe("exchangeCode", () => {
  it("authenticates in the form body, with no Authorization header, when only post is offered", async () => {
    const stub = stubFetch(() => jsonResponse(tokenBody()));

    const tokens = await adapter(stub.fetchImpl).exchangeCode({
      tokenUrl: `${TEST_FHIR_BASE}/oauth2/token`,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code: "code-1",
      redirectUri: REDIRECT_URI,
      codeVerifier: "verifier-1",
      tokenAuthMethods: ["client_secret_post"],
    });

    const call = stub.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBeUndefined();

    const form = new URLSearchParams(call?.body ?? "");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(form.get("code")).toBe("code-1");
    expect(form.get("code_verifier")).toBe("verifier-1");

    expect(tokens.patientId).toBe("synthetic-patient-9");
    // A five-minute token: expiry follows the server's expires_in.
    expect(tokens.expiresAt).toBe(NOW + 300_000);
  });

  it("can also read an Epic-shaped token response", async () => {
    const stub = stubFetch(() => jsonResponse(epicTokenResponse));

    const tokens = await adapter(stub.fetchImpl).exchangeCode({
      tokenUrl: `${TEST_FHIR_BASE}/oauth2/token`,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code: "code-1",
      redirectUri: REDIRECT_URI,
      codeVerifier: "verifier-1",
      tokenAuthMethods: ["client_secret_post"],
    });

    expect(tokens.patientId).toBe("synthetic-patient-1");
  });
});

describe("refresh", () => {
  it("returns the rotated refresh token and the patient id", async () => {
    const stub = stubFetch(() => jsonResponse(tokenBody()));

    const tokens = await adapter(stub.fetchImpl).refresh({
      tokenUrl: `${TEST_FHIR_BASE}/oauth2/token`,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: "renewal-1",
      tokenAuthMethods: ["client_secret_post"],
    });

    const form = new URLSearchParams(stub.calls[0]?.body ?? "");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("renewal-1");
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(stub.calls[0]?.headers.authorization).toBeUndefined();

    expect(tokens.refreshToken).toBe("synthetic-rotated-refresh");
    expect(tokens.refreshToken).not.toBe("renewal-1");
    expect(tokens.patientId).toBe("synthetic-patient-9");
  });

  it("rejects a token response without a patient id", async () => {
    const withoutPatient = tokenBody();
    delete withoutPatient.patient;
    const stub = stubFetch(() => jsonResponse(withoutPatient));

    const error = await expectAppError(
      adapter(stub.fetchImpl).refresh({
        tokenUrl: `${TEST_FHIR_BASE}/oauth2/token`,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: "renewal-1",
        tokenAuthMethods: ["client_secret_post"],
      }),
    );

    expect(error.code).toBe("upstream_error");
    expect(error.details).toStrictEqual({ missing: "patient" });
  });

  it("maps invalid_grant to needs_reauth", async () => {
    const stub = stubFetch(() => jsonResponse({ error: "invalid_grant" }, { status: 400 }));

    const error = await expectAppError(
      adapter(stub.fetchImpl).refresh({
        tokenUrl: `${TEST_FHIR_BASE}/oauth2/token`,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: "renewal-1",
      }),
    );

    expect(error.code).toBe("needs_reauth");
  });
});
