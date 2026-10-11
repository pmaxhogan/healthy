/**
 * The vendor boundary.
 *
 * Everything above this interface (OAuth routes, the sync engine, the MCP
 * server) is written against `EhrAdapter` and knows nothing about a vendor.
 * Adding one means adding one implementation and one line in `registry.ts`.
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
   * How much of an access token's life must be left for it to be used rather
   * than refreshed, in milliseconds. Per vendor because lifetimes are: a margin
   * sized for an hour-long token is the whole life of a five-minute one, and
   * would turn every request into a refresh.
   */
  readonly refreshSkewMs: number;
  /**
   * Whether a patient search has to be narrowed by `category` to be answered.
   *
   * Epic's patient-facing searches are category-scoped, so the registry runs one
   * search per category it knows. A server that answers a plain `patient=` search
   * returns every category at once, including the ones the registry has no name
   * for -- and there, searching by category is how resources get left behind.
   */
  readonly categoryScopedSearches: boolean;
  /**
   * Whether this vendor's Encounters are what goes on the calendar.
   *
   * Epic's are: a scheduled visit is an Encounter whose `period.start` is the
   * appointment time. Where an Encounter is instead the record of a visit that
   * happened -- started when the patient was roomed, sometimes never closed --
   * its start is minutes off the booked time, so it would sit beside the patient
   * portal's copy of the same visit rather than merge with it. There the calendar
   * is left to the portal and Encounters are only cached as part of the record.
   */
  readonly encountersAreAppointments: boolean;
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

/** The refresh margin for a vendor whose access tokens last tens of minutes. Five minutes. */
export const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

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
