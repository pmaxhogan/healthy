/**
 * A minimal FHIR R4 client for Epic's patient-facing API.
 *
 * What it exists to get right (each of these is a documented Epic sharp edge):
 *
 *  - `Accept: application/fhir+json` on every request. Epic's server has
 *    historically answered with XML when the header is absent.
 *  - Paging by `Bundle.link[relation=next]`, followed immediately and only when
 *    the link's origin matches the FHIR base -- the bearer token rides on that
 *    request, so a bundle that points somewhere else is dropped, not followed.
 *  - `search.mode === "outcome"` entries are warnings, not results. They are
 *    skipped and their issues collected.
 *  - 4101 (no results) is an empty result. 4119 (patient view filtered) is a
 *    warning. 4113 (paging session expired) restarts the search exactly once.
 *    4118 (not authorized for this data) is `upstream_auth`.
 *  - A 401 means the access token died mid-run: the `onUnauthorized` hook is
 *    given one chance to produce a fresh one, then the request is retried once.
 *  - A 403 is a registration mismatch, not a bad token, and is never retried.
 *  - 429 and 5xx go through `retriedFetch`, whose `Retry-After` is carried out
 *    on the `AppError` so a whole sync run can back off rather than one call.
 *
 * Nothing here logs a URL, a search parameter or a resource body: the base URL
 * identifies the organisation and the parameters carry the patient id. Counts,
 * resource type names, HTTP statuses and Epic numeric codes only.
 */

import { isBundle, isRecord, nextLink, resourceKey, splitEntries } from "../../fhir/bundle.ts";
import {
  classifyOutcome,
  isOperationOutcome,
  parseIssues,
  toSearchWarnings,
} from "../../fhir/operation-outcome.ts";
import { AppError } from "../../lib/errors.ts";
import { classifyStatus, retriedFetch, TransientError } from "../../lib/retry.ts";

import type { OutcomeClass, ParsedIssue } from "../../fhir/operation-outcome.ts";
import type { Resource, SearchWarning } from "../../fhir/types.ts";
import type { Logger } from "../../lib/log.ts";
import type { RetryOpts } from "../../lib/retry.ts";

const FHIR_JSON = "application/fhir+json";

export interface FhirClientDeps {
  /** The organisation's R4 base, e.g. `https://host/instance/api/FHIR/R4`. */
  baseUrl: string;
  /** Resolves a valid access token. Called once per request, not per attempt. */
  getAccessToken: () => Promise<string>;
  /**
   * Called when a request comes back 401, and expected to force a token refresh
   * and return the new access token. The request is then retried exactly once.
   * Without this hook a 401 is `upstream_auth` immediately.
   */
  onUnauthorized?: (() => Promise<string>) | undefined;
  fetchImpl: typeof fetch;
  logger: Logger;
  /** Epoch milliseconds; used for request timing in the logs. */
  now: () => number;
  /** Forwarded to `retriedFetch`; tests inject a no-op sleep. */
  retry?: RetryOpts | undefined;
}

export interface SearchResult<T> {
  resources: T[];
  warnings: SearchWarning[];
  /** Pages actually fetched, including restarts after a 4113. */
  pages: number;
}

export interface FhirClient {
  /** A single resource by id, or null when the organisation has no such row. */
  read<T extends Resource = Resource>(resourceType: string, id: string): Promise<T | null>;
  /**
   * Follows `Bundle.link[relation=next]` to the very end -- there is no page
   * ceiling. The owner's record is whatever size it is; see `paginate` for the
   * one thing that does stop a search early: the same `next` link twice.
   */
  search<T extends Resource = Resource>(
    resourceType: string,
    params: Record<string, string>,
  ): Promise<SearchResult<T>>;
}

/** Resolve a path against a FHIR base, tolerating a missing trailing slash. */
export function fhirUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, base).href;
}

/** A search URL with parameters, always with an explicit JSON format request. */
export function searchUrl(
  baseUrl: string,
  resourceType: string,
  params: Record<string, string>,
): string {
  const url = new URL(fhirUrl(baseUrl, resourceType));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

/**
 * Whether a bundle's `next` link may be followed.
 *
 * A same-origin check rather than a prefix check: Epic's continuation URLs are
 * not always under the R4 base path, but they are always on the same host.
 */
export function sameOrigin(candidate: string, baseUrl: string): boolean {
  try {
    return new URL(candidate).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** Epic's paged search session expired (4113). Recovered by one restart. */
class PagingExpiredError extends Error {
  constructor() {
    super("epic paging session expired");
    this.name = "PagingExpiredError";
  }
}

/** What one HTTP attempt produced. Everything else has already thrown. */
type PageOutcome = ResolvedOutcome | { kind: "unauthorized" };

/** What `request` returns: a 401 has either been recovered from or thrown. */
type ResolvedOutcome = { kind: "ok"; body: unknown } | { kind: "not-found" };

/**
 * A `fetch` wrapper that hides non-auth 4xx responses from `retriedFetch`.
 *
 * `retriedFetch` throws `PermanentError` for those and discards the body, but
 * every semantic this client needs -- 4113, 4118, an OperationOutcome explaining
 * a 400 -- lives in exactly that body. The response is stashed and a bodyless
 * 204 returned in its place so the retry loop stops without retrying.
 */
function passthrough4xx(inner: typeof fetch): {
  fetchImpl: typeof fetch;
  taken: () => Response | null;
} {
  let held: Response | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await inner(input, init);
    if (classifyStatus(response.status) === "permanent") {
      held = response;
      return new Response(null, { status: 204 });
    }
    return response;
  };
  return { fetchImpl, taken: () => held };
}

async function parseJsonBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
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

/**
 * Turn the issues of an OperationOutcome into either a classification the caller
 * can act on, or the right `AppError`.
 *
 * Order matters: 4113 and 4118 both also set `fatal`, and both have a specific
 * recovery, so they are checked first.
 */
function assertIssuesUsable(resourceType: string, issues: readonly ParsedIssue[]): OutcomeClass {
  const outcome = classifyOutcome(issues);
  if (outcome.pagingExpired) throw new PagingExpiredError();
  if (outcome.notAuthorized) {
    throw new AppError("upstream_auth", "the organisation withheld this data", {
      resourceType,
      epicCodes: outcome.codes,
    });
  }
  if (outcome.fatal) {
    throw new AppError("upstream_error", "FHIR request reported a fatal issue", {
      resourceType,
      epicCodes: outcome.codes,
    });
  }
  return outcome;
}

export function createFhirClient(deps: FhirClientDeps): FhirClient {
  const { baseUrl, getAccessToken, onUnauthorized, fetchImpl, logger, now } = deps;

  async function fetchRaw(url: string, token: string): Promise<Response> {
    const pass = passthrough4xx(fetchImpl);
    try {
      const outcome = await retriedFetch(
        url,
        { headers: { accept: FHIR_JSON, authorization: `Bearer ${token}` } },
        { ...deps.retry, fetchImpl: pass.fetchImpl },
      );
      return pass.taken() ?? outcome.value;
    } catch (error) {
      const held = pass.taken();
      if (held !== null) return held;
      if (error instanceof TransientError) {
        throw new AppError(
          "upstream_unavailable",
          "FHIR request failed after retries",
          { status: error.lastStatus ?? null, attempts: error.attempts },
          {
            cause: error,
            ...(error.retryAfterMs !== undefined && { retryAfterMs: error.retryAfterMs }),
          },
        );
      }
      throw new AppError("upstream_error", "FHIR request failed", undefined, { cause: error });
    }
  }

  async function requestOnce(
    url: string,
    resourceType: string,
    token: string,
  ): Promise<PageOutcome> {
    const started = now();
    const response = await fetchRaw(url, token);
    const body = await parseJsonBody(response);
    const status = response.status;
    if (status >= 200 && status < 300) {
      logger.debug("fhir.request", { resourceType, status, ms: now() - started });
      return { kind: "ok", body };
    }
    if (status === 401) return { kind: "unauthorized" };

    const issues = parseIssues(body);
    const codes = issues.map((issue) => issue.epicCode).filter((code) => code !== null);
    logger.warn("fhir.request_failed", { resourceType, status, epicCodes: codes });
    if (status === 403) {
      // Not a bad token: at Epic a 403 means the app is not registered for this
      // resource or scope, so refreshing would loop forever.
      throw new AppError("upstream_auth", "the organisation refused this request", {
        resourceType,
        status,
        epicCodes: codes,
      });
    }
    // Throws for 4113/4118/fatal; falls through for a 4xx with benign issues.
    assertIssuesUsable(resourceType, issues);
    if (status === 404) return { kind: "not-found" };
    throw new AppError("upstream_error", "FHIR request failed", {
      resourceType,
      status,
      epicCodes: codes,
    });
  }

  /** One request, plus a single forced-refresh retry if it comes back 401. */
  async function request(url: string, resourceType: string): Promise<ResolvedOutcome> {
    const first = await requestOnce(url, resourceType, await getAccessToken());
    if (first.kind !== "unauthorized") return first;
    if (onUnauthorized === undefined) {
      throw new AppError("upstream_auth", "FHIR request was unauthorized", { resourceType });
    }
    logger.info("fhir.unauthorized_retry", { resourceType });
    const second = await requestOnce(url, resourceType, await onUnauthorized());
    if (second.kind === "unauthorized") {
      throw new AppError("upstream_auth", "FHIR request was unauthorized after refresh", {
        resourceType,
      });
    }
    return second;
  }

  /** One page: collect its warnings, its matches, and where to go next. */
  function readPage(
    resourceType: string,
    body: unknown,
    sink: { resources: Resource[]; seen: Set<string>; warnings: SearchWarning[] },
  ): string | null {
    if (isOperationOutcome(body)) {
      // Epic answers some empty searches with a bare OperationOutcome rather
      // than an empty Bundle; 4101 here means "no results", not a parse failure.
      const issues = parseIssues(body);
      sink.warnings.push(...toSearchWarnings(resourceType, issues));
      assertIssuesUsable(resourceType, issues);
      return null;
    }
    if (!isBundle(body)) {
      throw new AppError(
        "upstream_error",
        "FHIR response was neither Bundle nor OperationOutcome",
        {
          resourceType,
        },
      );
    }
    const { matches, outcomes } = splitEntries(body);
    const issues = outcomes.flatMap((outcome) => parseIssues(outcome));
    sink.warnings.push(...toSearchWarnings(resourceType, issues));
    assertIssuesUsable(resourceType, issues);
    for (const resource of matches) {
      const key = resourceKey(resource);
      if (sink.seen.has(key)) continue;
      sink.seen.add(key);
      sink.resources.push(resource);
    }
    const next = nextLink(body);
    if (next === null) return null;
    if (!sameOrigin(next, baseUrl)) {
      // A next link off-origin would send the bearer token to a third party.
      logger.warn("fhir.next_link_rejected", { resourceType });
      return null;
    }
    return next;
  }

  /**
   * Follow `next` to the end. There is no page ceiling: the owner's record is
   * whatever size it is, and a health system with an unusually long history is
   * exactly the case a cap would silently truncate.
   *
   * The one thing that does stop this early is `next` repeating a URL already
   * visited in this walk -- an upstream bug (or an off-by-one in a paging
   * cursor) serving the same page forever is a real failure mode, and looping
   * on it forever would be worse than any page cap. That is reported loudly,
   * as a thrown error, not folded into a warning: `refreshResourceType` catches
   * it, records the failure in `fhir_sync_state`, and does not cache a partial
   * result under a resource type that looked like it succeeded.
   */
  async function paginate(resourceType: string, firstUrl: string): Promise<SearchResult<Resource>> {
    const sink = {
      resources: [] as Resource[],
      seen: new Set<string>(),
      warnings: [] as SearchWarning[],
    };
    const visited = new Set<string>([firstUrl]);
    let url: string | null = firstUrl;
    let pages = 0;
    while (url !== null) {
      const outcome = await request(url, resourceType);
      pages += 1;
      if (outcome.kind === "not-found") {
        throw new AppError("upstream_error", "FHIR search endpoint not found", { resourceType });
      }
      const next = readPage(resourceType, outcome.body, sink);
      if (next !== null && visited.has(next)) {
        logger.warn("fhir.next_link_repeated", { resourceType, pages });
        throw new AppError("upstream_error", "FHIR pagination returned a repeated next link", {
          resourceType,
          pages,
        });
      }
      if (next !== null) visited.add(next);
      url = next;
    }
    logger.debug("fhir.search", {
      resourceType,
      pages,
      count: sink.resources.length,
      warnings: sink.warnings.length,
    });
    return { resources: sink.resources, warnings: sink.warnings, pages };
  }

  return {
    async read<T extends Resource = Resource>(resourceType: string, id: string): Promise<T | null> {
      let outcome: ResolvedOutcome;
      try {
        outcome = await request(
          fhirUrl(baseUrl, `${resourceType}/${encodeURIComponent(id)}`),
          resourceType,
        );
      } catch (error) {
        if (error instanceof PagingExpiredError) {
          throw new AppError("upstream_error", "FHIR read reported a paging error", {
            resourceType,
          });
        }
        throw error;
      }
      if (outcome.kind === "not-found") return null;
      const issues = parseIssues(outcome.body);
      if (issues.length > 0) assertIssuesUsable(resourceType, issues);
      // An OperationOutcome body with only benign issues is still not a resource;
      // returning it would let the caller cache a warning as a Practitioner.
      if (isOperationOutcome(outcome.body)) return null;
      if (!isRecord(outcome.body) || outcome.body.resourceType !== resourceType) {
        throw new AppError("upstream_error", "FHIR read returned the wrong resource type", {
          resourceType,
        });
      }
      return outcome.body as T;
    },

    async search<T extends Resource = Resource>(
      resourceType: string,
      params: Record<string, string>,
    ): Promise<SearchResult<T>> {
      const firstUrl = searchUrl(baseUrl, resourceType, params);
      try {
        return (await paginate(resourceType, firstUrl)) as SearchResult<T>;
      } catch (error) {
        if (!(error instanceof PagingExpiredError)) throw error;
        // The session expired mid-walk. Page boundaries shift between runs, so
        // the accumulated pages are discarded and the whole search restarts --
        // once. `resourceKey` de-duplication covers the overlap either way.
        logger.info("fhir.paging_restart", { resourceType });
        try {
          return (await paginate(resourceType, firstUrl)) as SearchResult<T>;
        } catch (retryError) {
          if (!(retryError instanceof PagingExpiredError)) throw retryError;
          throw new AppError("upstream_unavailable", "FHIR paging session expired twice", {
            resourceType,
          });
        }
      }
    },
  };
}
