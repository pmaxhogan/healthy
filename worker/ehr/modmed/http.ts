/**
 * The one place a ModMed request is made.
 *
 * Two kinds of request, with different rules:
 *
 *  - **Sign-in hops** go to the identity provider recorded at discovery and to
 *    nowhere else. Redirects are followed by hand so every `Set-Cookie` lands in
 *    the jar, and only while they stay on that origin: the one redirect that
 *    leaves it is Keycloak handing the authorization code back to the portal,
 *    which is read off the `Location` header and never followed (its fragment
 *    *is* the answer, and following it would only fetch the app's HTML).
 *  - **API calls** go to the practice's origin with the bearer token and no
 *    cookies at all; the deployment is stateless, so there is nothing a cookie
 *    could add except the load balancer's stickiness, which it does not need.
 *
 * Neither ever leaves https. Nothing here logs a URL, a host, a header or a
 * body: stable endpoint labels, statuses and hop counts only.
 */

import { AppError } from "../../lib/errors.ts";

import { BROWSER_HEADERS, MAX_REDIRECTS } from "./wire.ts";

import type { CookieJar } from "../mychart/cookie-jar.ts";

export interface ModMedHttpDeps {
  fetchImpl: typeof fetch;
  jar: CookieJar;
}

export interface SignInResponse {
  status: number;
  /** The URL of the hop that answered. */
  url: string;
  body: string;
  /**
   * Set when the chain was redirected off the identity provider's origin: the
   * absolute target, unfollowed. Keycloak's hand-back carries the code here.
   */
  leftTo: string | null;
}

function origin(url: string): string {
  return new URL(url).origin;
}

/** A 403/429 is a WAF, not a credential problem; a 5xx is the portal being down. */
function refuseBlocked(status: number, endpoint: string): void {
  if (status === 403 || status === 429) {
    throw new AppError("portal_bot_blocked", "the portal refused the request", {
      endpoint,
      status,
    });
  }
  if (status >= 500) {
    throw new AppError("portal_unreachable", "the portal answered with a server error", {
      endpoint,
      status,
    });
  }
}

async function send(
  deps: Pick<ModMedHttpDeps, "fetchImpl">,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    // Unbound on purpose: workerd's `fetch` rejects any `this` but its own.
    const fetchImpl = deps.fetchImpl;
    return await fetchImpl(url, init);
  } catch (error) {
    throw new AppError("portal_unreachable", "the portal did not answer", undefined, {
      cause: error,
    });
  }
}

/**
 * One sign-in request on the identity provider's origin, redirects followed by
 * hand while they stay there.
 *
 * `form` is urlencoded into the body of a POST; absent means a GET with no body.
 * A 302/303 continues as a GET without the body; a cross-origin hop of any kind
 * stops and is reported in `leftTo`.
 */
function requireHttps(url: URL, endpoint: string): void {
  if (url.protocol !== "https:") {
    throw new AppError("portal_insecure_redirect", "the sign-in left https", { endpoint });
  }
}

/** One hop: the jar's cookies out, its `Set-Cookie`s in. */
async function hop(
  deps: ModMedHttpDeps,
  url: string,
  form: Record<string, string> | undefined,
): Promise<Response> {
  const headers = new Headers(BROWSER_HEADERS);
  headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  const cookie = deps.jar.getCookieHeader(url);
  if (cookie !== null) headers.set("cookie", cookie);
  const init: RequestInit = { method: "GET", headers, redirect: "manual" };
  if (form !== undefined) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    init.method = "POST";
    init.body = new URLSearchParams(form).toString();
  }
  const response = await send(deps, url, init);
  deps.jar.setFromResponse(url, response);
  return response;
}

/** The redirect target of a 3xx, or null for a final answer. */
function redirectTarget(response: Response, url: string): URL | null {
  const location = response.headers.get("location");
  const isRedirect = response.status >= 300 && response.status < 400;
  return !isRedirect || location === null || location === "" ? null : new URL(location, url);
}

export async function signInRequest(
  deps: ModMedHttpDeps,
  request: { url: string; form?: Record<string, string>; endpoint: string },
): Promise<SignInResponse> {
  const home = origin(request.url);
  let url = request.url;
  let form = request.form;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
    requireHttps(new URL(url), request.endpoint);
    const response = await hop(deps, url, form);
    refuseBlocked(response.status, request.endpoint);
    const target = redirectTarget(response, url);
    if (target === null) {
      return { status: response.status, url, body: await response.text(), leftTo: null };
    }
    await response.body?.cancel();
    requireHttps(target, request.endpoint);
    if (target.origin !== home) {
      return { status: response.status, url, body: "", leftTo: target.href };
    }
    url = target.href;
    // A 307/308 would re-send a password; nothing in this flow uses them, so
    // every redirect continues as a GET rather than re-POSTing.
    form = undefined;
  }
  throw new AppError("portal_parse_failed", "the sign-in redirected too many times", {
    endpoint: request.endpoint,
  });
}

/**
 * POST a form to the token endpoint and return its JSON. `invalid_grant` is
 * `portal_session_expired`: the refresh token (or the code) is no good any more.
 */
export async function tokenRequest(
  deps: Pick<ModMedHttpDeps, "fetchImpl">,
  url: string,
  form: Record<string, string>,
  endpoint: string,
): Promise<Record<string, unknown>> {
  const response = await send(deps, url, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });
  refuseBlocked(response.status, endpoint);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  const record =
    typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  if (response.status === 400 || response.status === 401) {
    const error = record?.error;
    if (error === "invalid_grant") {
      throw new AppError("portal_session_expired", "the sign-in grant is no longer valid", {
        endpoint,
      });
    }
    throw new AppError("portal_login_failed", "the token endpoint refused the request", {
      endpoint,
      status: response.status,
      ...(typeof error === "string" && { error }),
    });
  }
  if (record === null || response.status !== 200) {
    throw new AppError("portal_parse_failed", "the token endpoint answered unexpectedly", {
      endpoint,
      status: response.status,
    });
  }
  return record;
}

export interface ApiResponse {
  json: unknown;
  headers: Headers;
}

/** GET one API path with the bearer token. 401 is `portal_session_expired`. */
export async function apiGet(
  deps: Pick<ModMedHttpDeps, "fetchImpl">,
  request: { url: string; accessToken: string; endpoint: string },
): Promise<ApiResponse> {
  if (new URL(request.url).protocol !== "https:") {
    throw new AppError("portal_insecure_redirect", "the portal API is not https", {
      endpoint: request.endpoint,
    });
  }
  const response = await send(deps, request.url, {
    method: "GET",
    headers: {
      ...BROWSER_HEADERS,
      accept: "application/json, text/plain, */*",
      authorization: `Bearer ${request.accessToken}`,
    },
    redirect: "manual",
  });
  if (response.status === 401) {
    await response.body?.cancel();
    throw new AppError("portal_session_expired", "the portal rejected the token", {
      endpoint: request.endpoint,
    });
  }
  refuseBlocked(response.status, request.endpoint);
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new AppError("portal_parse_failed", "the portal API answered unexpectedly", {
      endpoint: request.endpoint,
      status: response.status,
    });
  }
  const text = await response.text();
  try {
    return { json: JSON.parse(text) as unknown, headers: response.headers };
  } catch (error) {
    throw new AppError(
      "portal_parse_failed",
      "the portal API did not answer with JSON",
      { endpoint: request.endpoint },
      { cause: error },
    );
  }
}
