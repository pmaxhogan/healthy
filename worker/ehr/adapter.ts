/**
 * The vendor boundary.
 *
 * Everything above this interface (OAuth routes, the sync engine, the MCP
 * server) is written against `EhrAdapter` and knows nothing about Epic.
 * Adding Oracle Health later means adding one implementation and one line in
 * `registry.ts`.
 *
 * Adapters are pure: they take a `fetchImpl`, a `Logger` and a clock, and they
 * never read `env`, touch D1, or cache anything. Discovery documents,
 * CapabilityStatements and tokens are all cached by the caller, which is the
 * only layer that has storage.
 */

import type { CapabilityIndex, SmartConfig, TokenSet, Vendor } from "../fhir/types.ts";
import type { Logger } from "../lib/log.ts";

/** Everything an adapter needs from the outside world. */
export interface AdapterDeps {
  fetchImpl: typeof fetch;
  logger: Logger;
  /** Epoch milliseconds. Injected so token expiry is testable. */
  now: () => number;
}

/**
 * Inputs to the browser redirect that starts a standalone patient launch.
 *
 * `authorizeUrl` comes from `discover()`; it is passed in rather than re-fetched
 * so a single cached `SmartConfig` drives the whole flow.
 */
export interface AuthorizeUrlInput {
  authorizeUrl: string;
  clientId: string;
  /** Must byte-for-byte equal a redirect URI registered with the vendor. */
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  /**
   * The FHIR base URL, exactly as registered.
   *
   * Epic requires `aud` and matches it as a string: a missing or trailing-slash-
   * mismatched `aud` fails silently with no usable error, so this value is never
   * normalised on the way through.
   */
  aud: string;
}

/** Client authentication at the token endpoint. */
export type TokenAuthMethod = "client_secret_basic" | "client_secret_post";

export interface ExchangeCodeInput {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  /** The same value sent on the authorize request, or the exchange is rejected. */
  redirectUri: string;
  codeVerifier: string;
  /**
   * `token_endpoint_auth_methods_supported` from discovery. HTTP Basic is used
   * whenever it is offered or the list is unknown; `client_secret_post` is the
   * fallback only when discovery explicitly omits Basic.
   */
  tokenAuthMethods?: readonly string[] | undefined;
}

export interface RefreshInput {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenAuthMethods?: readonly string[] | undefined;
}

export interface EhrAdapter {
  readonly vendor: Vendor;
  /**
   * Parse `{base}/.well-known/smart-configuration`.
   *
   * Cached by the caller (7 days per health system); an organisation can move its
   * authorize/token endpoints without changing its FHIR base.
   */
  discover(fhirBaseUrl: string): Promise<SmartConfig>;
  /**
   * Parse `{base}/metadata` into a compact per-resource index of interactions
   * and search parameter names.
   *
   * Epic's quarterly upgrades change which parameters an organisation supports,
   * so the sync engine consults this instead of assuming.
   */
  getCapabilities(fhirBaseUrl: string, accessToken: string): Promise<CapabilityIndex>;
  buildAuthorizeUrl(input: AuthorizeUrlInput): string;
  exchangeCode(input: ExchangeCodeInput): Promise<TokenSet>;
  /**
   * Swap a refresh token for a new access token.
   *
   * `invalid_grant` means the grant is gone (expired, revoked in the portal, or
   * invalidated by a password reset) and is reported as `needs_reauth` -- the one
   * error the caller answers by asking the owner to reconnect.
   */
  refresh(input: RefreshInput): Promise<TokenSet>;
  /** The scope strings to request for a set of resource types. */
  scopesFor(resourceTypes: readonly string[]): string[];
}

export type EhrAdapterFactory = (deps: AdapterDeps) => EhrAdapter;

/** The SMART scopes every connection needs regardless of resource types. */
export const SMART_BASE_SCOPES: readonly string[] = ["openid", "fhirUser", "offline_access"];

/**
 * `Authorization: Basic base64(urlencode(id):urlencode(secret))`.
 *
 * The percent-encoding is required by RFC 6749 §2.3.1 and it matters in
 * practice: Epic client secrets are generated from a large alphabet and a secret
 * containing `:`, `&`, `+` or `/` authenticates only if both halves are
 * form-urlencoded before they are joined and base64'd.
 */
export function basicAuthHeader(clientId: string, clientSecret: string): string {
  const credential = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${base64Utf8(credential)}`;
}

/** Whether to send the secret in a Basic header or in the form body. */
export function chooseTokenAuthMethod(supported: readonly string[] | undefined): TokenAuthMethod {
  // Unknown list -> Basic. Epic requires Basic for the refresh grant, and a
  // discovery document that omits the field is far likelier to be terse than to
  // mean "post only".
  if (supported === undefined || supported.length === 0) return "client_secret_basic";
  if (supported.includes("client_secret_basic")) return "client_secret_basic";
  return supported.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic";
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 (padded) of a UTF-8 string, without `btoa` or `Buffer`. */
export function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes.at(index) ?? 0;
    const b1 = bytes.at(index + 1) ?? 0;
    const b2 = bytes.at(index + 2) ?? 0;
    const remaining = bytes.length - index;
    out += BASE64_ALPHABET.charAt(b0 >> 2);
    out += BASE64_ALPHABET.charAt(((b0 & 0b11) << 4) | (b1 >> 4));
    out += remaining > 1 ? BASE64_ALPHABET.charAt(((b1 & 0b1111) << 2) | (b2 >> 6)) : "=";
    out += remaining > 2 ? BASE64_ALPHABET.charAt(b2 & 0b11_1111) : "=";
  }
  return out;
}
