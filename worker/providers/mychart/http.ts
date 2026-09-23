/**
 * The one place a portal request is made.
 *
 * Both the mount discovery and the authenticated client go through `portalFetch`,
 * so every rule below holds for every request either of them makes.
 *
 * **Redirects are followed by hand** (`redirect: "manual"` plus a loop). Letting
 * the runtime follow them would lose the `Set-Cookie` headers on the
 * intermediate hops, and those hops are where the interesting cookies are: the
 * session cookie arrives on the 302 out of the credential POST, and the
 * trust-this-device cookie on the 302 out of the code POST. Following by hand
 * also means the caller learns *where it landed*, which is how "signed in",
 * "needs a code" and "bounced back to login" are told apart at all.
 *
 * **An empty POST body is really empty.** `body: ""` is not the same request as
 * no body: both undici and workerd add `Content-Type: text/plain` to a string
 * body, and the research found a WAF in front of these endpoints that rejects
 * exactly that. So a request with no form passes `body: undefined` and sets no
 * content type, and `test/unit/providers/mychart/client.test.ts` asserts on the
 * raw `init.body` being `undefined` rather than on a rendered string.
 *
 * **A cross-origin 307/308 never re-sends the form.** A redirect chain is under
 * the server's control, and a 307 is the one redirect that re-sends the body --
 * including a password. Crossing an origin drops the body and continues as a
 * GET, which lands on a page that is not signed in and therefore fails loudly
 * instead of leaking a credential to wherever the chain pointed.
 *
 * **A redirect may not leave the site, and may never leave https.** Where the
 * chain ends is what `portal_accounts.base_url` becomes, and that origin is
 * where the owner's portal password is POSTed on every later sign-in. A vanity
 * alias that is dropped and re-registered, or a CDN in the chain that is taken
 * over, would otherwise silently relocate the credential. So a hop to a
 * different registrable domain is `portal_redirected_offsite` (with the landed
 * origin in `details`, for the admin UI to show -- it never reaches a log line,
 * because `errorFields` does not carry `details`), and a hop to anything but
 * `https:` is `portal_insecure_redirect`. The recovery for a deployment that
 * genuinely federates across sites is for the owner to paste the origin the
 * error names, confirm it, and have that be the site the chain may move within.
 *
 * **A body-level redirect may not even leave the origin.** A `<meta refresh>` or
 * a `window.location` in a 200 body is content, not an HTTP redirect, and a
 * cross-origin one is simply not followed -- discovery then reports that it
 * found no login page, which is the fail-closed answer.
 *
 * **Caller headers are dropped once the origin changes.** `request.headers`
 * carries the antiforgery token on the visits calls, and would carry an
 * `Authorization` header the day one is added. A hop that has left the origin
 * gets the browser-shaped headers and the jar's cookies for that host, and
 * nothing the caller supplied.
 *
 * **Nothing here logs a URL, a host, a mount or a body.** A mount path and a
 * hostname both identify the organisation, and the body is the chart. Log lines
 * and `AppError.details` carry the stable endpoint label, the HTTP status and
 * the hop count, and nothing else.
 */

import { AppError } from "../../lib/errors.ts";

import { bodyMentions, bodyRedirectTarget } from "./html.ts";
import { sameRegistrableSite } from "./site.ts";
import {
  ACCEPT_HTML,
  ACCEPT_JSON,
  BROWSER_HEADERS,
  MARKERS,
  MAX_REDIRECTS,
  PATHS,
} from "./wire.ts";

import type { CookieJar } from "./cookie-jar.ts";
import type { Logger } from "../../lib/log.ts";

export interface PortalHttpDeps {
  fetchImpl: typeof fetch;
  logger: Logger;
  /**
   * Absent means no cookies are sent and none are kept. Discovery runs without
   * one on purpose: it probes unauthenticated, and a jar there could carry a
   * cookie planted by a wrong-mount probe into the real session.
   */
  jar?: CookieJar | undefined;
  maxRedirects?: number | undefined;
}

export interface PortalRequest {
  /** Absolute URL of the first hop. */
  url: string;
  method?: "GET" | "POST";
  /**
   * Form fields to urlencode into the body. **Absent means no body and no
   * `Content-Type` header at all** -- see the module comment.
   */
  form?: Record<string, string> | undefined;
  /**
   * A body to send as JSON instead. Mutually exclusive with `form`.
   *
   * The classic pages take forms; the `custom_oidc` shell's API takes JSON for
   * everything except its credential POST, which is form-urlencoded. Absent here
   * means the same thing absent `form` means: no body, and no `Content-Type`.
   */
  jsonBody?: unknown;
  headers?: Record<string, string> | undefined;
  accept?: "html" | "json" | undefined;
  /** A stable label, e.g. "DoLogin". Goes in logs; never a URL. */
  endpoint: string;
  /** Also follow a `<meta refresh>` / `window.location` redirect in a 200 body. */
  followBodyRedirects?: boolean | undefined;
  /**
   * Recognise the landed hop before deciding whether to follow a body redirect.
   *
   * Checked on every hop `followBodyRedirects` would otherwise act on, and it
   * takes priority: a hop this returns `true` for is the final answer even when
   * its body also carries a redirect. Discovery uses this to recognise the
   * OpenID handoff stub before any further body-level hop is considered -- the
   * stub can carry a redirect of its own (a no-JS fallback, or something
   * unrelated) and following it blind would walk straight past the one page
   * that answers the question discovery is asking.
   */
  recognizeLanding?: ((landed: { url: string; body: string }) => boolean) | undefined;
}

export interface PortalResponse {
  status: number;
  /** The URL of the hop that actually answered. */
  url: string;
  body: string;
  /**
   * The answering hop's `Content-Type`, lower-cased, or null when it sent none.
   *
   * Load-bearing rather than informational: the JSON endpoints answer a stale
   * antiforgery token with an HTTP **200 carrying an HTML page**, so "was this
   * JSON" cannot be decided from the status code and has to be decided from here
   * (plus a body sniff) instead. Without it a silent auth failure reads as a day
   * with no appointments on it.
   */
  contentType: string | null;
  /** Redirects followed to get here, header and body alike. */
  hops: number;
}

/** Redirects that turn the next hop into a GET and drop the body (RFC 9110 §15.4). */
const DOWNGRADE_TO_GET = new Set([301, 302, 303]);
const KEEPS_METHOD = new Set([307, 308]);

function encodeForm(form: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) params.set(key, value);
  return params.toString();
}

/**
 * The first hop's body and its content type, or neither.
 *
 * `form` wins over `jsonBody` when a caller passes both, which nothing does; what
 * matters is that with neither the result is two `undefined`s, because a request
 * with no body must send no `Content-Type` at all.
 */
function firstBody(request: PortalRequest): {
  body: string | undefined;
  bodyContentType: string | undefined;
} {
  if (request.form !== undefined) {
    return {
      body: encodeForm(request.form),
      bodyContentType: "application/x-www-form-urlencoded",
    };
  }
  return request.jsonBody === undefined
    ? { body: undefined, bodyContentType: undefined }
    : { body: JSON.stringify(request.jsonBody), bodyContentType: "application/json" };
}

interface Hop {
  url: string;
  method: "GET" | "POST";
  body: string | undefined;
  /** Only set when `body` is, and only then is a `Content-Type` header sent. */
  bodyContentType: string | undefined;
}

function headersFor(request: PortalRequest, hop: Hop, jar: CookieJar | undefined): Headers {
  const headers = new Headers(BROWSER_HEADERS);
  headers.set("accept", request.accept === "json" ? ACCEPT_JSON : ACCEPT_HTML);
  // Only while the hop is still on the origin the caller asked for: see the
  // module comment. The cookie header below is computed per host either way.
  const extra = sameOrigin(hop.url, request.url) ? Object.entries(request.headers ?? {}) : [];
  for (const [key, value] of extra) headers.set(key, value);
  // Only ever set for a request that actually has a body: see the module comment.
  if (hop.bodyContentType !== undefined) headers.set("content-type", hop.bodyContentType);
  const cookie = jar?.getCookieHeader(hop.url);
  if (cookie !== null && cookie !== undefined) headers.set("cookie", cookie);
  return headers;
}

/** Whether two absolute URLs share an origin. False if either is unparseable. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Refuse a redirect that would leave https, or leave the site.
 *
 * Both are the same failure in different clothes -- the chain deciding where a
 * credential goes -- and both are refused rather than reported, because there is
 * no safe way to carry on from either. See the module comment.
 */
function requireSameSiteHttps(target: URL, current: Hop, endpoint: string): void {
  if (target.protocol !== "https:") {
    throw new AppError("portal_insecure_redirect", "the portal redirected away from https", {
      endpoint,
      // A scheme, not a host: this one is safe to log.
      scheme: target.protocol,
    });
  }
  if (!sameRegistrableSite(current.url, target.href)) {
    throw new AppError("portal_redirected_offsite", "the portal redirected to another site", {
      endpoint,
      // The one place this module puts a host in an error: the admin UI has to
      // be able to tell the owner where they were sent. `errorFields` never
      // carries `details`, so it cannot reach a log line from here.
      landedOrigin: target.origin,
    });
  }
}

/** The next hop a response asks for, or null when it is the final answer. */
function nextHop(response: Response, current: Hop, endpoint: string): Hop | null {
  const location = response.headers.get("location");
  if (location === null || location === "") return null;
  if (!DOWNGRADE_TO_GET.has(response.status) && !KEEPS_METHOD.has(response.status)) return null;
  let target: URL;
  try {
    target = new URL(location, current.url);
  } catch {
    return null;
  }
  requireSameSiteHttps(target, current, endpoint);
  if (DOWNGRADE_TO_GET.has(response.status)) {
    return { url: target.href, method: "GET", body: undefined, bodyContentType: undefined };
  }
  // 307/308 keeps the method -- and the body, unless the chain left the origin.
  const sameOrigin = new URL(current.url).origin === target.origin;
  return sameOrigin
    ? {
        url: target.href,
        method: current.method,
        body: current.body,
        bodyContentType: current.bodyContentType,
      }
    : { url: target.href, method: "GET", body: undefined, bodyContentType: undefined };
}

/**
 * A `<meta refresh>` / `window.location` redirect in a 200 body, resolved.
 *
 * Null when it would leave the origin. A body redirect is content the page
 * chose, not an HTTP redirect, and it is the one this client will not follow
 * across an origin at all -- not even within the site -- because it is also the
 * cheapest thing for a compromised page to inject.
 */
function bodyHop(body: string, current: Hop): Hop | null {
  const target = bodyRedirectTarget(body);
  if (target === null) return null;
  let absolute: URL;
  try {
    absolute = new URL(target, current.url);
  } catch {
    return null;
  }
  if (!sameOrigin(absolute.href, current.url)) return null;
  return {
    url: absolute.href,
    method: "GET",
    body: undefined,
    bodyContentType: undefined,
  };
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  // An HTTP-date Retry-After yields NaN here, which is treated as "not given".
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * Turn a WAF answer into `portal_bot_blocked`, and an upstream fault into
 * `portal_unreachable`. Everything else -- including a 404 on a wrong mount --
 * is handed back for the caller to interpret.
 */
function rejectIfBlocked(response: Response, body: string, endpoint: string): void {
  const details = { endpoint, status: response.status };
  if (response.status === 403 || response.status === 429) {
    const retryAfter = retryAfterMs(response);
    throw new AppError("portal_bot_blocked", "the portal refused the request", details, {
      // Spread rather than assigned: under `exactOptionalPropertyTypes` an
      // explicit `undefined` is not the same as an absent field.
      ...(retryAfter !== undefined && { retryAfterMs: retryAfter }),
    });
  }
  if (response.status >= 500) {
    throw new AppError("portal_unreachable", "the portal returned a server error", details);
  }
  if (bodyMentions(body, MARKERS.challenge)) {
    throw new AppError("portal_bot_blocked", "the portal answered with a challenge page", details);
  }
}

/**
 * One portal request, redirects followed, cookies applied and recorded.
 *
 * Throws `portal_unreachable` for a transport failure, `portal_bot_blocked` for a
 * WAF, `portal_parse_failed` when the redirect chain does not terminate, and
 * `portal_redirected_offsite` / `portal_insecure_redirect` when it tries to
 * leave the site or leave https. Every other status comes back in the result.
 */
export async function portalFetch(
  deps: PortalHttpDeps,
  request: PortalRequest,
): Promise<PortalResponse> {
  const limit = deps.maxRedirects ?? MAX_REDIRECTS;
  requireHttps(request.url, request.endpoint);
  let hop: Hop = { url: request.url, method: request.method ?? "GET", ...firstBody(request) };

  for (let hops = 0; hops <= limit; hops++) {
    const init: RequestInit = {
      method: hop.method,
      headers: headersFor(request, hop, deps.jar),
      redirect: "manual",
      ...(hop.body !== undefined && { body: hop.body }),
    };
    let response: Response;
    try {
      response = await deps.fetchImpl(hop.url, init);
    } catch (error) {
      deps.logger.warn("portal.request_failed", { endpoint: request.endpoint, hops });
      throw new AppError(
        "portal_unreachable",
        "the portal could not be reached",
        { endpoint: request.endpoint, hops },
        { cause: error },
      );
    }
    deps.jar?.setFromResponse(hop.url, response);

    const headerHop = nextHop(response, hop, request.endpoint);
    if (headerHop !== null) {
      // The redirect's own body is never the answer, and reading it would only
      // put chart markup somewhere it does not need to be.
      hop = headerHop;
      continue;
    }

    const body = await response.text();
    rejectIfBlocked(response, body, request.endpoint);
    const recognized = request.recognizeLanding?.({ url: hop.url, body }) === true;
    const inBody = !recognized && request.followBodyRedirects === true ? bodyHop(body, hop) : null;
    if (inBody !== null && response.status === 200) {
      hop = inBody;
      continue;
    }
    deps.logger.debug("portal.request", {
      endpoint: request.endpoint,
      status: response.status,
      hops,
    });
    return {
      status: response.status,
      url: hop.url,
      body,
      contentType: response.headers.get("content-type")?.toLowerCase() ?? null,
      hops,
    };
  }

  deps.logger.warn("portal.redirect_loop", { endpoint: request.endpoint, hops: limit });
  throw new AppError("portal_parse_failed", "the portal redirected in a loop", {
    endpoint: request.endpoint,
    hops: limit,
  });
}

/**
 * Refuse a first hop that is not https, before anything is sent.
 *
 * The URL comes from a stored endpoint or from what the owner pasted, and both
 * are validated where they enter -- this is the backstop that means no code path
 * into this module can send a portal request in cleartext.
 */
export function requireHttps(url: string, endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError("portal_parse_failed", "the portal URL is not a URL", { endpoint });
  }
  if (parsed.protocol !== "https:") {
    throw new AppError("portal_insecure_redirect", "the portal URL is not https", {
      endpoint,
      scheme: parsed.protocol,
    });
  }
}

/** The lower-cased path of a URL, or "" when it is not one. Never logged. */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True when a response is an OpenID Connect handoff rather than a page.
 *
 * Either signal is enough. The URL is the strong one: on a `custom_oidc`
 * deployment the login path 302s to the handoff stub, so a chain that started at
 * a login page ends on a path containing it. The body marker covers the
 * deployment that serves the stub *at* the login path, where there is no redirect
 * to read -- the page is then one script tag and one hidden antiforgery input,
 * which every other check in this directory reads as "not a login form".
 *
 * Used in two places for two different conclusions: discovery reads it as "this
 * is the custom flavour", and the authenticated client reads it as "the session
 * is gone". It is the same observation either way.
 *
 * Takes only the two fields it reads, not a full `PortalResponse`, so discovery
 * can also pass it as a `PortalRequest.recognizeLanding` hook.
 */
export function isOpenIdHandoff(response: Pick<PortalResponse, "url" | "body">): boolean {
  return (
    pathOf(response.url).includes(`/${PATHS.openId.toLowerCase()}`) ||
    bodyMentions(response.body, MARKERS.openIdHandoff)
  );
}

/** Join a mount-relative path onto an origin and mount, e.g. `Home` -> `/x/Home`. */
export function mountedUrl(
  baseUrl: string,
  mountPath: string,
  path: string,
  query: Record<string, string> = {},
): string {
  const mount = normaliseMount(mountPath);
  const url = new URL(`${mount}${path}`, baseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}

/** A mount with exactly one leading and one trailing slash. `""` becomes `"/"`. */
export function normaliseMount(mountPath: string): string {
  // Split/filter/join rather than a trim regex: it also collapses a doubled
  // slash in the middle, and it cannot backtrack on a pathological input.
  const segments = mountPath.split("/").filter((segment) => segment !== "");
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

/** The origin of a URL, which is all `portal_accounts.base_url` ever holds. */
export function originOf(url: string): string {
  return new URL(url).origin;
}
