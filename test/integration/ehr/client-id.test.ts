// Lives with the integration tests, not under test/unit: `clientIdFor` takes the
// worker `Env`, whose Cloudflare types are absent from the plain-Node unit tsconfig.

import { describe, expect, it } from "vitest";

import { clientIdFor, clientIdSecretFor } from "../../../worker/ehr/client-id.ts";
import { AppError } from "../../../worker/lib/errors.ts";

import type { Env } from "../../../worker/env.ts";

/** Only the three client id secrets matter here; the rest of `Env` is never read. */
function envWith(
  secrets: Partial<
    Pick<Env, "EPIC_CLIENT_ID_NONPROD" | "EPIC_CLIENT_ID_PROD" | "MODMED_CLIENT_ID">
  >,
): Env {
  return secrets as Env;
}

const FULL = envWith({
  EPIC_CLIENT_ID_NONPROD: "epic-nonprod-id",
  EPIC_CLIENT_ID_PROD: "epic-prod-id",
  MODMED_CLIENT_ID: "modmed-id",
});

describe("clientIdSecretFor", () => {
  it("names the sandbox secret for a sandbox Epic health system", () => {
    expect(clientIdSecretFor({ vendor: "epic", environment: "sandbox" })).toBe(
      "EPIC_CLIENT_ID_NONPROD",
    );
  });

  it("names the production secret for a production Epic health system", () => {
    expect(clientIdSecretFor({ vendor: "epic", environment: "prod" })).toBe("EPIC_CLIENT_ID_PROD");
  });

  it("names the one ModMed secret whatever the environment says", () => {
    expect(clientIdSecretFor({ vendor: "modmed", environment: "prod" })).toBe("MODMED_CLIENT_ID");
    expect(clientIdSecretFor({ vendor: "modmed", environment: "sandbox" })).toBe(
      "MODMED_CLIENT_ID",
    );
  });
});

describe("clientIdFor", () => {
  it("reads the value of the secret that matches the health system", () => {
    expect(clientIdFor(FULL, { vendor: "epic", environment: "sandbox" })).toBe("epic-nonprod-id");
    expect(clientIdFor(FULL, { vendor: "epic", environment: "prod" })).toBe("epic-prod-id");
    expect(clientIdFor(FULL, { vendor: "modmed", environment: "prod" })).toBe("modmed-id");
    expect(clientIdFor(FULL, { vendor: "modmed", environment: "sandbox" })).toBe("modmed-id");
  });

  it("throws an internal error naming the secret when it is unset", () => {
    let captured: unknown;
    try {
      clientIdFor(envWith({ EPIC_CLIENT_ID_PROD: "epic-prod-id" }), {
        vendor: "modmed",
        environment: "prod",
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(AppError);
    expect((captured as AppError).code).toBe("internal");
    expect((captured as AppError).details).toStrictEqual({ secret: "MODMED_CLIENT_ID" });
  });

  it("treats an empty secret as unset", () => {
    expect(() =>
      clientIdFor(envWith({ EPIC_CLIENT_ID_NONPROD: "" }), {
        vendor: "epic",
        environment: "sandbox",
      }),
    ).toThrow(AppError);
  });

  it("does not fall back to another vendor's or environment's id", () => {
    const onlyProd = envWith({ EPIC_CLIENT_ID_PROD: "epic-prod-id" });

    expect(() => clientIdFor(onlyProd, { vendor: "epic", environment: "sandbox" })).toThrow(
      AppError,
    );
  });
});
