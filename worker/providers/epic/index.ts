/**
 * The Epic health system adapter: discovery, the standalone patient launch, and the
 * token endpoint.
 *
 * Epic-specific behaviour this encodes:
 *
 *  - `aud` is mandatory on the authorize request and must equal the registered
 *    FHIR base as a string. It is passed through untouched -- normalising a
 *    trailing slash here would produce a redirect that fails silently, with no
 *    error anywhere the owner can see it.
 *  - Scopes the app is not registered for are dropped silently, so the effective
 *    grant is the intersection of what was asked for and what was registered.
 *    `scopesFor` therefore asks for everything and the caller reads `scope` off
 *    the token response to learn what it really got.
 *  - Client authentication is HTTP Basic over `urlencode(id):urlencode(secret)`;
 *    `client_secret_post` is used only when discovery explicitly omits Basic.
 *  - The token endpoint is called with a single attempt, deliberately. An
 *    authorization code is single-use, so replaying it cannot help, and a failed
 *    refresh is re-driven by the next scheduled run. 429 and 5xx are reported as
 *    `upstream_unavailable` with the server's `Retry-After` attached.
 *  - `invalid_grant` on refresh is the one error that means "the owner must
 *    reconnect": the refresh token expired, the app was revoked in the portal, or
 *    a password reset invalidated it. It maps to `needs_reauth`.
 */

import { isRecord } from "../../fhir/bundle.ts";
import { AppError } from "../../lib/errors.ts";
import { parseRetryAfter, PermanentError, retriedFetch, TransientError } from "../../lib/retry.ts";
import { basicAuthHeader, chooseTokenAuthMethod, SMART_BASE_SCOPES } from "../adapter.ts";

import { fhirUrl } from "./fhir-client.ts";

import type {
  CapabilityIndex,
  CapabilityResource,
  SmartConfig,
  TokenSet,
  Vendor,
} from "../../fhir/types.ts";
import type {
  AdapterDeps,
  AuthorizeUrlInput,
  ExchangeCodeInput,
  ProviderAdapter,
  RefreshInput,
} from "../adapter.ts";

const VENDOR: Vendor = "epic";
const JSON_MEDIA_TYPE = "application/json";
const FHIR_JSON_MEDIA_TYPE = "application/fhir+json";
const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";
/** Ceiling on one token-endpoint POST. Long enough for a slow org, short enough to fail. */
const TOKEN_TIMEOUT_MS = 20_000;

/**
 * The one OAuth error code that means the grant itself is gone.
 *
 * Deliberately just this one. `invalid_client` and `unauthorized_client` are
 * misconfigured credentials; telling the owner to reconnect would send them
 * round a loop that cannot fix it.
 */
const REAUTH_OAUTH_ERRORS: ReadonlySet<string> = new Set(["invalid_grant"]);

function stringOf(source: Record<string, unknown>, key: string): string | null {
  // `source[key]`: the keys are literals in this module and every read is
  // type-checked below, so there is nothing an upstream body can inject.
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function stringArrayOf(source: Record<string, unknown>, key: string): string[] {
  // As `stringOf`: literal keys, and the value is filtered by type.
  const value = source[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function namesOf(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = stringOf(entry, key);
    if (name !== null && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * True when a discovered endpoint is an absolute `https:` URL.
 *
 * The token endpoint receives the client secret, the authorization code and the
 * PKCE verifier; the authorize endpoint receives the owner's browser. Both come
 * out of a document fetched from the organisation, so a tampered or simply
 * misconfigured one pointing at `http:` would put all of that on the wire in
 * clear. The API layer already requires `https:` on the FHIR base a health system is
 * created with; this is the same rule one layer in, where the values are not the
 * owner's to vouch for.
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Parse a SMART discovery document. Absent optional fields become empty lists. */
export function parseSmartConfiguration(body: unknown): SmartConfig {
  if (!isRecord(body)) {
    throw new AppError("upstream_error", "smart-configuration was not a JSON object");
  }
  const authorizeUrl = stringOf(body, "authorization_endpoint");
  const tokenUrl = stringOf(body, "token_endpoint");
  if (authorizeUrl === null || tokenUrl === null) {
    throw new AppError("upstream_error", "smart-configuration is missing its OAuth endpoints", {
      hasAuthorize: authorizeUrl !== null,
      hasToken: tokenUrl !== null,
    });
  }
  if (!isHttpsUrl(authorizeUrl) || !isHttpsUrl(tokenUrl)) {
    // Which one, never the URL itself: a base URL names the organisation.
    throw new AppError("upstream_error", "smart-configuration endpoint is not https", {
      authorizeIsHttps: isHttpsUrl(authorizeUrl),
      tokenIsHttps: isHttpsUrl(tokenUrl),
    });
  }
  return {
    authorizeUrl,
    tokenUrl,
    capabilities: stringArrayOf(body, "capabilities"),
    pkceMethods: stringArrayOf(body, "code_challenge_methods_supported"),
    tokenAuthMethods: stringArrayOf(body, "token_endpoint_auth_methods_supported"),
  };
}

/**
 * Flatten a CapabilityStatement into `resourceType -> {interactions, params}`.
 *
 * Only the two lists the sync engine consults are kept: a full Epic
 * CapabilityStatement is megabytes, and this one gets cached in D1.
 */
export function indexCapabilities(body: unknown): CapabilityIndex {
  if (!isRecord(body)) return { fhirVersion: null, resources: {} };
  const resources = new Map<string, CapabilityResource>();
  for (const server of arrayOf(body.rest)) {
    if (isRecord(server)) indexRestResources(server.resource, resources);
  }
  return { fhirVersion: stringOf(body, "fhirVersion"), resources: Object.fromEntries(resources) };
}

/** Fold one `rest.resource[]` into the index, merging with anything already there. */
function indexRestResources(list: unknown, into: Map<string, CapabilityResource>): void {
  for (const entry of arrayOf(list)) {
    if (!isRecord(entry)) continue;
    const type = stringOf(entry, "type");
    if (type === null) continue;
    const previous = into.get(type);
    into.set(type, {
      interactions: mergeUnique(previous?.interactions, namesOf(entry.interaction, "code")),
      searchParams: mergeUnique(previous?.searchParams, namesOf(entry.searchParam, "name")),
    });
  }
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mergeUnique(existing: readonly string[] | undefined, added: readonly string[]): string[] {
  return [...new Set([...(existing ?? []), ...added])];
}

function oauthErrorCode(body: unknown): string | null {
  return isRecord(body) ? stringOf(body, "error") : null;
}

/** Parse a JSON body, tolerating an empty one and a body that is not JSON at all. */
async function readJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Build a `TokenSet` from a token response, or fail loudly about what is missing. */
export function toTokenSet(body: unknown, nowMs: number): TokenSet {
  if (!isRecord(body)) {
    throw new AppError("upstream_error", "token response was not a JSON object");
  }
  const accessToken = stringOf(body, "access_token");
  if (accessToken === null) {
    throw new AppError("upstream_error", "token response is missing access_token", {
      missing: "access_token",
    });
  }
  // Epic's `patient` is the R4 Patient id at that organisation and there is no
  // other way to learn it. Storing a connection without one would produce a
  // connection that can never be searched, so this fails now rather than later.
  const patientId = stringOf(body, "patient");
  if (patientId === null) {
    throw new AppError("upstream_error", "token response is missing the patient id", {
      missing: "patient",
    });
  }
  const expiresIn = body.expires_in;
  const lifetimeMs = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn * 1000 : 3_600_000;
  return {
    accessToken,
    expiresAt: nowMs + lifetimeMs,
    refreshToken: stringOf(body, "refresh_token"),
    scope: stringOf(body, "scope") ?? "",
    patientId,
    idToken: stringOf(body, "id_token"),
  };
}

type TokenGrant = "authorization_code" | "refresh_token";

export function createEpicAdapter(deps: AdapterDeps): ProviderAdapter {
  const { fetchImpl, logger, now } = deps;

  /** A GET that only has to survive transient failures; bodies are small JSON. */
  async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
    let response: Response;
    try {
      const outcome = await retriedFetch(url, { headers }, { fetchImpl });
      response = outcome.value;
    } catch (error) {
      if (error instanceof TransientError) {
        throw new AppError(
          "upstream_unavailable",
          "discovery request failed after retries",
          { status: error.lastStatus ?? null },
          {
            cause: error,
            ...(error.retryAfterMs !== undefined && { retryAfterMs: error.retryAfterMs }),
          },
        );
      }
      const status = error instanceof PermanentError ? (error.status ?? null) : null;
      throw new AppError(
        "upstream_error",
        "discovery request failed",
        { status },
        { cause: error },
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError("upstream_auth", "discovery request was unauthorized", {
        status: response.status,
      });
    }
    return readJson(response);
  }

  async function postToken(
    input: {
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      tokenAuthMethods?: readonly string[] | undefined;
    },
    grant: TokenGrant,
    form: Record<string, string>,
  ): Promise<TokenSet> {
    const method = chooseTokenAuthMethod(input.tokenAuthMethods);
    const body = new URLSearchParams({ grant_type: grant, ...form });
    const headers: Record<string, string> = {
      accept: JSON_MEDIA_TYPE,
      "content-type": FORM_MEDIA_TYPE,
    };
    if (method === "client_secret_basic") {
      headers.authorization = basicAuthHeader(input.clientId, input.clientSecret);
    } else {
      body.set("client_id", input.clientId);
      body.set("client_secret", input.clientSecret);
    }

    let response: Response;
    try {
      response = await fetchImpl(input.tokenUrl, {
        method: "POST",
        headers,
        body: body.toString(),
        // Deliberately outside `retriedFetch` -- a token grant is single-use, so a
        // retry can burn a code -- but still bounded: a hung token endpoint would
        // otherwise pin this invocation until the platform kills it, and on the
        // callback path that is the owner watching a blank page.
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch (error) {
      // A network failure here is indistinguishable from a slow gateway, and the
      // next scheduled run re-drives it either way.
      throw new AppError("upstream_unavailable", "token endpoint unreachable", undefined, {
        cause: error,
      });
    }

    const parsed = await readJson(response);
    if (response.ok) return toTokenSet(parsed, now());
    throw tokenError(response, parsed, grant, logger);
  }

  return {
    vendor: VENDOR,

    async discover(fhirBaseUrl: string): Promise<SmartConfig> {
      const url = fhirUrl(fhirBaseUrl, ".well-known/smart-configuration");
      return parseSmartConfiguration(await getJson(url, { accept: JSON_MEDIA_TYPE }));
    },

    async getCapabilities(fhirBaseUrl: string, accessToken: string): Promise<CapabilityIndex> {
      const url = fhirUrl(fhirBaseUrl, "metadata");
      const body = await getJson(url, {
        accept: FHIR_JSON_MEDIA_TYPE,
        authorization: `Bearer ${accessToken}`,
      });
      const index = indexCapabilities(body);
      logger.debug("epic.capabilities", {
        resourceTypes: Object.keys(index.resources).length,
        fhirVersion: index.fhirVersion,
      });
      return index;
    },

    buildAuthorizeUrl(input: AuthorizeUrlInput): string {
      const url = new URL(input.authorizeUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", input.clientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("scope", input.scopes.join(" "));
      url.searchParams.set("state", input.state);
      // Exactly as registered: Epic compares this string, and a mismatch fails
      // with no error the owner can see.
      url.searchParams.set("aud", input.aud);
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.href;
    },

    async exchangeCode(input: ExchangeCodeInput): Promise<TokenSet> {
      return postToken(input, "authorization_code", {
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      });
    },

    async refresh(input: RefreshInput): Promise<TokenSet> {
      return postToken(input, "refresh_token", { refresh_token: input.refreshToken });
    },

    scopesFor(resourceTypes: readonly string[]): string[] {
      // SMART v2 `.rs` (read + search). Epic silently drops anything the app is
      // not registered for, so asking for a type the org lacks is harmless.
      const scopes = new Set<string>(SMART_BASE_SCOPES);
      for (const type of resourceTypes) {
        if (type !== "") scopes.add(`patient/${type}.rs`);
      }
      return [...scopes];
    },
  };
}

/**
 * Map a token-endpoint failure onto the error taxonomy.
 *
 * | status        | body `error`      | result                |
 * | ------------- | ----------------- | --------------------- |
 * | 429, 5xx      | any               | upstream_unavailable  |
 * | 400, 401      | invalid_grant     | needs_reauth          |
 * | 401, 403      | anything else     | upstream_auth         |
 * | other 4xx     | any               | upstream_error        |
 *
 * `invalid_client` deliberately does not map to `needs_reauth`: that is a
 * misconfigured client secret, and telling the owner to reconnect would send
 * them round a loop that cannot fix it.
 */
function tokenError(
  response: Response,
  body: unknown,
  grant: TokenGrant,
  logger: { warn: (event: string, fields?: Record<string, unknown>) => void },
): AppError {
  const status = response.status;
  const oauthError = oauthErrorCode(body);
  logger.warn("epic.token_failed", { grant, status, oauthError });

  if (status === 429 || status >= 500) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    return new AppError(
      "upstream_unavailable",
      "token endpoint is unavailable",
      { status },
      retryAfterMs === null ? undefined : { retryAfterMs },
    );
  }
  const rejectedGrant = status === 400 || status === 401;
  if (
    grant === "refresh_token" &&
    rejectedGrant &&
    oauthError !== null &&
    REAUTH_OAUTH_ERRORS.has(oauthError)
  ) {
    return new AppError("needs_reauth", "the refresh token was rejected", { status, oauthError });
  }
  if (status === 401 || status === 403) {
    return new AppError("upstream_auth", "the token endpoint rejected our credentials", {
      status,
      oauthError,
    });
  }
  return new AppError("upstream_error", "the token endpoint returned an error", {
    status,
    oauthError,
  });
}
