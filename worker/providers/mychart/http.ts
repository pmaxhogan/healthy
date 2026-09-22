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
 * **Nothing here logs a URL, a host, a mount or a body.** A mount path and a
 * hostname both identify the organisation, and the body is the chart. Log lines
 * and `AppError.details` carry the stable endpoint label, the HTTP status and
 * the hop count, and nothing else.
 */

import { AppError } from "../../lib/errors.ts";

import { bodyMentions, bodyRedirectTarget } from "./html.ts";
import { ACCEPT_HTML, ACCEPT_JSON, BROWSER_HEADERS, MARKERS, MAX_REDIRECTS } from "./wire.ts";

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
  headers?: Record<string, string> | undefined;
  accept?: "html" | "json" | undefined;
  /** A stable label, e.g. "DoLogin". Goes in logs; never a URL. */
  endpoint: string;
  /** Also follow a `<meta refresh>` / `window.location` redirect in a 200 body. */
  followBodyRedirects?: boolean | undefined;
}

export interface PortalResponse {
  status: number;
  /** The URL of the hop that actually answered. */
  url: string;
  body: string;
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

interface Hop {
  url: string;
  method: "GET" | "POST";
  body: string | undefined;
}

function headersFor(request: PortalRequest, hop: Hop, jar: CookieJar | undefined): Headers {
  const headers = new Headers(BROWSER_HEADERS);
  headers.set("accept", request.accept === "json" ? ACCEPT_JSON : ACCEPT_HTML);
  const extra = Object.entries(request.headers ?? {});
  for (const [key, value] of extra) headers.set(key, value);
  // Only ever set for a request that actually has a body: see the module comment.
  if (hop.body !== undefined) headers.set("content-type", "application/x-www-form-urlencoded");
  const cookie = jar?.getCookieHeader(hop.url);
  if (cookie !== null && cookie !== undefined) headers.set("cookie", cookie);
  return headers;
}

/** The next hop a response asks for, or null when it is the final answer. */
function nextHop(response: Response, current: Hop): Hop | null {
  const location = response.headers.get("location");
  if (location === null || location === "") return null;
  if (!DOWNGRADE_TO_GET.has(response.status) && !KEEPS_METHOD.has(response.status)) return null;
  let target: URL;
  try {
    target = new URL(location, current.url);
  } catch {
    return null;
  }
  if (DOWNGRADE_TO_GET.has(response.status)) {
    return { url: target.href, method: "GET", body: undefined };
  }
  // 307/308 keeps the method -- and the body, unless the chain left the origin.
  const sameOrigin = new URL(current.url).origin === target.origin;
  return sameOrigin
    ? { url: target.href, method: current.method, body: current.body }
    : { url: target.href, method: "GET", body: undefined };
}

/** A `<meta refresh>` / `window.location` redirect in a 200 body, resolved. */
function bodyHop(body: string, current: Hop): Hop | null {
  const target = bodyRedirectTarget(body);
  if (target === null) return null;
  try {
    return { url: new URL(target, current.url).href, method: "GET", body: undefined };
  } catch {
    return null;
  }
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
 * WAF, and `portal_parse_failed` when the redirect chain does not terminate.
 * Every other status comes back in the result.
 */
export async function portalFetch(
  deps: PortalHttpDeps,
  request: PortalRequest,
): Promise<PortalResponse> {
  const limit = deps.maxRedirects ?? MAX_REDIRECTS;
  const form = request.form;
  let hop: Hop = {
    url: request.url,
    method: request.method ?? "GET",
    body: form === undefined ? undefined : encodeForm(form),
  };

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

    const headerHop = nextHop(response, hop);
    if (headerHop !== null) {
      // The redirect's own body is never the answer, and reading it would only
      // put chart markup somewhere it does not need to be.
      hop = headerHop;
      continue;
    }

    const body = await response.text();
    rejectIfBlocked(response, body, request.endpoint);
    const inBody = request.followBodyRedirects === true ? bodyHop(body, hop) : null;
    if (inBody !== null && response.status === 200) {
      hop = inBody;
      continue;
    }
    deps.logger.debug("portal.request", {
      endpoint: request.endpoint,
      status: response.status,
      hops,
    });
    return { status: response.status, url: hop.url, body, hops };
  }

  deps.logger.warn("portal.redirect_loop", { endpoint: request.endpoint, hops: limit });
  throw new AppError("portal_parse_failed", "the portal redirected in a loop", {
    endpoint: request.endpoint,
    hops: limit,
  });
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
