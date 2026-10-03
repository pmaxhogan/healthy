/**
 * Find a ModMed patient portal at an origin, without signing in.
 *
 * One GET: the practice's own `auth/data/patient` document, which the portal's
 * app reads before it does anything else. A ModMed practice answers it with a
 * JSON object naming its Keycloak server, realm and client; anything else
 * (MyChart, a 404 page, a different product) does not, and discovery says so
 * with `portal_parse_failed` so the caller can try the next vendor.
 *
 * What is stored is the *identity provider* as well as the origin. The owner
 * confirms both before a password is ever sealed against them: the admin card
 * shows the provider's origin on the confirm line and the save echoes it back
 * (`worker/api/routes/portal.ts`), because that is where the password is
 * actually POSTed. The client re-reads the document on every sign-in and
 * refuses to send the password anywhere other than the identity provider
 * recorded here (`portal_origin_unconfirmed`), so a practice that moves its
 * sign-in elsewhere needs the owner to look again rather than silently
 * relocating the credential.
 *
 * Nothing here logs a host, a realm or a body. The document also carries the
 * practice's name and logo in its login hint; none of that is kept.
 */

import { isHttpsUrl } from "@shared/url.ts";

import { AppError } from "../../lib/errors.ts";

import { AUTH_DATA_PATH, BROWSER_HEADERS, PORTAL_APP_PATH } from "./wire.ts";

import type { Logger } from "../../lib/log.ts";

/** The stored discovery result for a ModMed practice. */
export interface ModMedEndpoint {
  portal: "modmed";
  /** The practice's origin, e.g. `https://practice.example`. */
  baseUrl: string;
  /** Where the patient app is mounted: always `/patient-portal/`. */
  mountPath: string;
  /** Present so the stored row reads the same way a MyChart one does. */
  flavor: "modmed";
  /** Keycloak's base, e.g. `https://sso.example/auth`. https, no trailing slash. */
  authServerUrl: string;
  realm: string;
  clientId: string;
}

/** The fields of `auth/data/patient` this client relies on, validated. */
export interface AuthData {
  authServerUrl: string;
  realm: string;
  clientId: string;
  /** Opaque; passed straight back to Keycloak, never parsed or logged. */
  loginHint: string | null;
  /** The API wants a bearer token on every call. The only mode implemented. */
  stateless: boolean;
}

export interface ModMedDiscoveryDeps {
  fetchImpl: typeof fetch;
  logger: Logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function withoutTrailingSlashes(url: string): string {
  let out = url;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * Validate the document. Null when it is not a ModMed patient sign-in document
 * at all, or one this client cannot drive (no SSO, a non-https identity
 * provider, or a stateful deployment).
 */
function parseAuthData(body: unknown): AuthData | null {
  if (!isRecord(body) || body.ssoEnabled !== true) return null;
  const config = body.keycloakConfig;
  if (!isRecord(config)) return null;
  const authServerUrl = stringField(config, "authServerUrl");
  const realm = stringField(config, "realm");
  const clientId = stringField(config, "clientId");
  if (authServerUrl === null || realm === null || clientId === null || !isHttpsUrl(authServerUrl))
    return null;
  return {
    authServerUrl: withoutTrailingSlashes(authServerUrl),
    realm,
    clientId,
    loginHint: stringField(config, "loginHint"),
    stateless: body.stateless === true,
  };
}

/** GET and validate `auth/data/patient` at `baseUrl`. Throws a `portal_*` code. */
export async function fetchAuthData(baseUrl: string, deps: ModMedDiscoveryDeps): Promise<AuthData> {
  let response: Response;
  try {
    response = await deps.fetchImpl(new URL(AUTH_DATA_PATH, baseUrl).href, {
      redirect: "manual",
      headers: { ...BROWSER_HEADERS, accept: "application/json" },
    });
  } catch (error) {
    throw new AppError("portal_unreachable", "the portal did not answer", undefined, {
      cause: error,
    });
  }
  if (response.status === 403 || response.status === 429) {
    throw new AppError("portal_bot_blocked", "the portal refused the request", {
      endpoint: "auth-data",
      status: response.status,
    });
  }
  if (response.status >= 500) {
    throw new AppError("portal_unreachable", "the portal answered with a server error", {
      endpoint: "auth-data",
      status: response.status,
    });
  }
  let parsed: AuthData | null = null;
  if (response.status === 200) {
    try {
      parsed = parseAuthData(await response.json());
    } catch {
      parsed = null;
    }
  } else {
    await response.body?.cancel();
  }
  if (parsed === null) {
    throw new AppError("portal_parse_failed", "no ModMed patient sign-in configuration here", {
      endpoint: "auth-data",
      status: response.status,
    });
  }
  if (!parsed.stateless) {
    // Every deployment seen so far is stateless. A stateful one keeps a server
    // session this client does not know how to establish; fail loudly rather
    // than report an empty day.
    throw new AppError("portal_parse_failed", "this ModMed deployment is not token-based", {
      endpoint: "auth-data",
    });
  }
  return parsed;
}

/**
 * Probe `baseUrl` (an origin) for a ModMed patient portal.
 *
 * Throws `portal_parse_failed` when it is not one, which is the caller's cue to
 * try another vendor.
 */
export async function discoverModMed(
  baseUrl: string,
  deps: ModMedDiscoveryDeps,
): Promise<ModMedEndpoint> {
  if (!isHttpsUrl(baseUrl)) {
    throw new AppError("portal_insecure_redirect", "the portal URL is not https", {
      scheme: new URL(baseUrl).protocol,
    });
  }
  const origin = new URL(baseUrl).origin;
  const data = await fetchAuthData(origin, deps);
  deps.logger.info("portal.discovery.modmed", { found: true });
  return {
    portal: "modmed",
    baseUrl: origin,
    mountPath: PORTAL_APP_PATH,
    flavor: "modmed",
    authServerUrl: data.authServerUrl,
    realm: data.realm,
    clientId: data.clientId,
  };
}
