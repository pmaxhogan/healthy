// The only place in the SPA that calls fetch.
//
// Three jobs, all of them contract obligations documented in shared/types.ts and
// the README's auth section:
//
//  1. Every state-changing request carries `x-healthy-csrf: 1`. The Worker
//     rejects one that does not, so this cannot be left to call sites.
//  2. A 401/403 carrying `x-healthy-auth: required` means the session (or the
//     Cloudflare Access cookie behind it) is gone and the *server* must render
//     the login page. That needs a full page navigation, not a fetch -- the
//     response body is HTML, not JSON.
//  3. Everything else that is not 2xx is an `ApiError` payload, surfaced as a
//     typed exception the views turn into a toast.

import { AUTH_REQUIRED_HEADER, CSRF_HEADER } from "@shared/types.ts";

import type { ApiError } from "@shared/types.ts";

/** Thrown for any non-2xx response that is not an auth-required redirect. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, payload: ApiError) {
    super(payload.message ?? payload.error);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = payload.error;
    this.details = payload.details;
  }
}

/**
 * Thrown after a re-auth navigation has been started.
 *
 * Callers must let it pass without showing a toast: the page is already on its
 * way to the server-rendered login wall, and a red banner flashing over the
 * navigation is noise. `isAuthRequired` is the check.
 */
export class AuthRequiredError extends Error {
  constructor() {
    super("authentication required");
    this.name = "AuthRequiredError";
  }
}

export function isAuthRequired(error: unknown): boolean {
  return error instanceof AuthRequiredError;
}

/** How the client leaves the SPA. Swapped for a spy in tests. */
type Navigate = (url: string) => void;

interface ClientConfig {
  fetch: typeof globalThis.fetch;
  navigate: Navigate;
}

const config: ClientConfig = {
  fetch: (input, init) => fetch(input, init),
  // `location.href` and not a hard-coded path on purpose: the Worker renders the
  // login page for whatever URL it is asked for and redirects back afterwards,
  // so navigating to the current URL preserves where the owner was.
  navigate: (url) => {
    location.assign(url);
  },
};

/** Test seam. Production code never calls this. */
export function configureClient(overrides: Partial<ClientConfig>): void {
  Object.assign(config, overrides);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface RequestOptions {
  method?: string;
  /** Serialised as JSON; sets content-type. Omit for a bodyless mutation. */
  body?: unknown;
  signal?: AbortSignal;
}

async function readError(response: Response): Promise<ApiError> {
  try {
    const payload: unknown = await response.json();
    if (payload !== null && typeof payload === "object" && "error" in payload) {
      return payload as ApiError;
    }
  } catch {
    // A non-JSON error body (a proxy's HTML 502, say) is not a contract
    // violation worth reporting as one -- fall through to the status code.
  }
  return { error: `http_${String(response.status)}` };
}

/**
 * Issues one request against the Worker.
 *
 * `path` is absolute and same-origin (`/api/overview`, `/auth/logout`) -- the
 * Worker's CSRF guard checks the Origin header, so a cross-origin call would be
 * rejected anyway and there is no reason to allow one to be written.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers({ accept: "application/json" });

  if (!SAFE_METHODS.has(method)) headers.set(CSRF_HEADER, "1");
  if (options.body !== undefined) headers.set("content-type", "application/json");

  const response = await config.fetch(path, {
    method,
    headers,
    // Explicit rather than relying on the default: the session cookie is
    // SameSite=Strict and the whole API depends on it being sent.
    credentials: "same-origin",
    cache: "no-store",
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    ...(options.signal && { signal: options.signal }),
  });

  if (
    (response.status === 401 || response.status === 403) &&
    response.headers.get(AUTH_REQUIRED_HEADER) === "required"
  ) {
    config.navigate(location.href);
    throw new AuthRequiredError();
  }

  if (!response.ok) throw new ApiRequestError(response.status, await readError(response));

  // A mutation is allowed to answer with no content, and several do. Checking
  // the content type rather than only the status keeps a 200-with-empty-body
  // from failing here on a JSON parse the caller never asked for.
  if (response.status === 204) return undefined as T;
  return response.headers.get("content-type")?.includes("json")
    ? ((await response.json()) as T)
    : (undefined as T);
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> =>
    request<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, body === undefined ? { method: "POST" } : { method: "POST", body }),
  put: <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: "PUT", body }),
  patch: <T>(path: string, body: unknown): Promise<T> =>
    request<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string): Promise<T> => request<T>(path, { method: "DELETE" }),
};

/**
 * Turns anything thrown by the client into one line for a toast.
 *
 * Never includes a response body verbatim: an API error may name a field, and
 * "the UI printed whatever the server said" is how clinical detail ends up in a
 * screenshot.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.message === error.code ? error.code.replaceAll("_", " ") : error.message;
  }
  // Not `error instanceof Error`: an aborted fetch rejects with a DOMException,
  // which does not inherit from Error in a browser, so the instanceof check would
  // quietly report every cancellation as a failure.
  return isNamed(error, "AbortError") ? "cancelled" : "request failed";
}

function isNamed(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}
