/**
 * Derived per-organisation client secrets.
 *
 * Epic wants a different client secret for every organisation and for each of
 * its two environments, and keeps only a hash of each. Storing one secret per
 * organisation the app is merely *enabled* at -- hundreds, almost none of which
 * will ever be connected -- is the wrong shape for that, so the secret is
 * computed instead: HMAC-SHA256 under one key only this deployment has, over the
 * environment and the organisation's id in Epic's developer portal. The same
 * function runs in two places: `worker/scripts/epic-org-secret.ts` prints the value to
 * register with Epic, and the health systems repo recomputes it whenever a
 * health system that names its organisation has no stored secret.
 *
 * **A dedicated key, not `DATA_KEY`.** Epic holds hashes of these values and
 * cannot be re-sealed. A key that is ever rotated for another reason would
 * silently invalidate the app at every organisation at once.
 * `EPIC_ORG_SECRET_KEY` exists for this and nothing else; treat it as permanent.
 *
 * **Output.** 64 lowercase hex characters: the full 256-bit MAC, in the one
 * alphabet no form field or Basic-auth encoder disagrees about.
 *
 * Plain WebCrypto and no Worker types, so the script and the plain-Node unit
 * tests can call it without a runtime.
 */

import { AppError } from "../lib/errors.ts";

import type { HealthSystemEnvironment } from "./rows.ts";

/** Hashed in front of every input. Change it and every registered secret moves. */
const DOMAIN = "healthy/epic-org-secret/v1";
const KEY_BYTES = 32;

/**
 * What an organisation id may look like. Epic's are short decimal numbers; the
 * wider alphabet only keeps a future format from needing a code change. The
 * value is MAC input, so it is never normalised -- `0123` and `123` differ.
 */
export const ORG_ID_PATTERN = /^[\w.-]{1,64}$/u;

const encoder = new TextEncoder();

function orgSecretError(message: string, cause?: unknown): AppError {
  return new AppError("crypto", message, undefined, cause === undefined ? {} : { cause });
}

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(key.replaceAll("-", "+").replaceAll("_", "/"));
  } catch (error) {
    throw orgSecretError("EPIC_ORG_SECRET_KEY is not valid base64", error);
  }
  const bytes = new Uint8Array(binary.length);
  bytes.set(Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0));
  if (bytes.length !== KEY_BYTES) {
    throw orgSecretError(`EPIC_ORG_SECRET_KEY must decode to ${String(KEY_BYTES)} bytes`);
  }
  return bytes;
}

/**
 * Epic's name for the environment. The app's `sandbox` covers Epic's own sandbox
 * and every organisation's non-production system, which is one secret slot.
 */
function environmentLabel(environment: HealthSystemEnvironment): string {
  return environment === "prod" ? "prod" : "nonprod";
}

/** The client secret for one organisation in one environment, under `key`. */
export async function deriveOrgClientSecret(
  key: string,
  environment: HealthSystemEnvironment,
  orgId: string,
): Promise<string> {
  if (!ORG_ID_PATTERN.test(orgId)) {
    throw orgSecretError("the organisation id is not in the expected format");
  }
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    keyBytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // NUL-separated: no part contains one, so no two inputs share an encoding.
  const message = `${DOMAIN}\u{0}${environmentLabel(environment)}\u{0}${orgId}`;
  const signature = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
