/**
 * Which Worker secret holds the client id a health system's vendor issued.
 *
 * A client id is per app registration, not per organisation, so it is a Worker
 * secret rather than a column: Epic issues one for its sandbox and another for
 * production, ModMed issues one. The per-organisation half of the credential,
 * the client secret, lives on the health system row.
 */

import { AppError } from "../lib/errors.ts";

import type { HealthSystemRow } from "../db/rows.ts";
import type { Env } from "../env.ts";

type ClientIdSecret = "EPIC_CLIENT_ID_PROD" | "EPIC_CLIENT_ID_NONPROD" | "MODMED_CLIENT_ID";

/** The name of the Worker secret this health system's client id is read from. */
export function clientIdSecretFor(
  healthSystem: Pick<HealthSystemRow, "vendor" | "environment">,
): ClientIdSecret {
  // ModMed has no sandbox, so there is one registration whatever the row says.
  if (healthSystem.vendor === "modmed") return "MODMED_CLIENT_ID";
  return healthSystem.environment === "sandbox" ? "EPIC_CLIENT_ID_NONPROD" : "EPIC_CLIENT_ID_PROD";
}

/**
 * The client id for one health system. Throws when the secret is unset.
 *
 * Missing is a deployment fault, not a user error: there is nothing the owner
 * can do in the UI about an unset Worker secret.
 */
export function clientIdFor(
  env: Env,
  healthSystem: Pick<HealthSystemRow, "vendor" | "environment">,
): string {
  const secret = clientIdSecretFor(healthSystem);
  // `env[secret]`: `secret` is one of the three literals above, never input.
  const clientId = env[secret];
  if (clientId === undefined || clientId === "") {
    throw new AppError("internal", "the client id secret for this health system is not set", {
      secret,
    });
  }
  return clientId;
}
