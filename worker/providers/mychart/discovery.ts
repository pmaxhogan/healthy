/**
 * Find out where a portal actually lives, and which shape its login form is.
 *
 * Deployments of the same product are mounted under a vanity prefix, a generic
 * prefix, or nothing at all; some hostnames are aliases that redirect -- with a
 * `Location` header, or with a `<meta refresh>`, or with a one-line
 * `window.location` -- to a different host entirely. And the login form's
 * username field was renamed between releases, so the field name has to be read
 * rather than assumed.
 *
 * Two hard rules:
 *
 *  - **Credentials are never sent from this module.** Every probe is an
 *    unauthenticated GET of the login page. Whatever a wrong guess reaches, it
 *    reaches without a password.
 *  - **No cookie jar.** A probe against the wrong mount (or a redirect chain
 *    through an alias) must not be able to plant a cookie that a later
 *    authenticated session would carry.
 *
 * The mount is taken from where the probe *landed*, not from the candidate that
 * was tried: a root-mounted probe that gets redirected to a prefix has, in one
 * request, discovered the prefix. That is why the candidate list can be short.
 */

import { AppError } from "../../lib/errors.ts";

import { findAntiforgeryField, inputFields } from "./html.ts";
import { mountedUrl, normaliseMount, originOf, portalFetch } from "./http.ts";
import { ANTIFORGERY_FIELD_NAMES, CANDIDATE_MOUNTS, FIELDS, PATHS } from "./wire.ts";

import type { PortalHttpDeps } from "./http.ts";
import type { UsernameField } from "./wire.ts";
import type { Logger } from "../../lib/log.ts";

/** Everything the authenticated client needs in order to be pointed at an instance. */
export interface PortalEndpoint {
  /** Origin only, e.g. `https://host.example`. Never a path. */
  baseUrl: string;
  /** One leading and one trailing slash. `/` when the app is root-mounted. */
  mountPath: string;
  usernameField: UsernameField;
  /** The hidden field the login POST has to echo back. */
  antiforgeryFieldName: string;
}

export interface DiscoveryDeps {
  fetchImpl: typeof fetch;
  logger: Logger;
  /** A mount the owner already knows, tried first. */
  mountHint?: string | undefined;
  maxRedirects?: number | undefined;
}

/**
 * The mount candidates to try, in order: the owner's hint, then the generic
 * prefixes. Deduplicated after normalisation, so a hint of `MyChart` and a hint
 * of `/MyChart/` cost the same one probe.
 */
export function candidateMounts(mountHint?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (mount: string): void => {
    const normalised = normaliseMount(mount);
    if (seen.has(normalised)) return;
    seen.add(normalised);
    out.push(normalised);
  };
  if (mountHint !== undefined && mountHint.trim() !== "") add(mountHint);
  for (const candidate of CANDIDATE_MOUNTS) add(candidate);
  return out;
}

/**
 * The mount implied by the URL a login-page probe landed on.
 *
 * `https://host/x/Authentication/Login` means the app is mounted at `/x/`. A
 * landing URL that is not a login page at all falls back to the candidate that
 * was tried, because there is nothing better to infer from.
 */
export function mountFromLandedUrl(landedUrl: string, fallback: string): string {
  let path: string;
  try {
    path = new URL(landedUrl).pathname;
  } catch {
    return normaliseMount(fallback);
  }
  const marker = path.toLowerCase().indexOf(PATHS.login.toLowerCase());
  return normaliseMount(marker === -1 ? fallback : path.slice(0, marker));
}

/** The username field this page uses, or null when it is not a login form. */
function usernameFieldOf(fields: ReadonlyMap<string, string>): UsernameField | null {
  if (fields.has("LoginIdentifier")) return "LoginIdentifier";
  return fields.has("Username") ? "Username" : null;
}

interface Probe {
  endpoint: PortalEndpoint | null;
  /** Why this candidate was not it. Only read when every candidate failed. */
  reason: "not_a_login_page" | "no_antiforgery_field" | "http_error";
}

async function probe(mount: string, baseUrl: string, deps: DiscoveryDeps): Promise<Probe> {
  const http: PortalHttpDeps = {
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
    // No jar: see the module comment.
    jar: undefined,
    maxRedirects: deps.maxRedirects,
  };
  const response = await portalFetch(http, {
    url: mountedUrl(baseUrl, mount, PATHS.login),
    endpoint: "Login",
    accept: "html",
    followBodyRedirects: true,
  });
  if (response.status !== 200) return { endpoint: null, reason: "http_error" };

  const fields = inputFields(response.body);
  const usernameField = usernameFieldOf(fields);
  // A password field but no known username field is a login page this client
  // cannot drive, and is reported the same way as no login page at all.
  if (usernameField === null || !fields.has(FIELDS.password)) {
    return { endpoint: null, reason: "not_a_login_page" };
  }
  const antiforgery = findAntiforgeryField(response.body, ANTIFORGERY_FIELD_NAMES);
  if (antiforgery === null) return { endpoint: null, reason: "no_antiforgery_field" };

  return {
    endpoint: {
      baseUrl: originOf(response.url),
      mountPath: mountFromLandedUrl(response.url, mount),
      usernameField,
      antiforgeryFieldName: antiforgery.name,
    },
    reason: "http_error",
  };
}

/**
 * Probe `baseUrl` until a login page answers, and report how to drive it.
 *
 * Throws a stable code, never a message with the host in it:
 *   - `portal_bot_blocked`  a WAF or challenge page answered (from `portalFetch`)
 *   - `portal_unreachable`  nothing answered
 *   - `portal_parse_failed` something answered, but no candidate was a login page
 *
 * A `portal_bot_blocked` or `portal_unreachable` from any single candidate ends
 * the whole discovery rather than moving on: both mean the host is not going to
 * talk to us, and hammering the remaining mounts after a bot block is the one
 * thing most likely to make it permanent.
 */
export async function discoverPortal(
  baseUrl: string,
  deps: DiscoveryDeps,
): Promise<PortalEndpoint> {
  let origin: string;
  try {
    origin = originOf(baseUrl);
  } catch (error) {
    throw new AppError("bad_request", "the portal URL is not a URL", undefined, { cause: error });
  }

  const mounts = candidateMounts(deps.mountHint);
  const reasons: string[] = [];
  for (const mount of mounts) {
    const result = await probe(mount, origin, deps);
    if (result.endpoint !== null) {
      deps.logger.info("portal.discovered", {
        candidates: mounts.length,
        usernameField: result.endpoint.usernameField,
      });
      return result.endpoint;
    }
    reasons.push(result.reason);
  }

  deps.logger.warn("portal.discovery_failed", { candidates: mounts.length, reasons });
  throw new AppError("portal_parse_failed", "no login page was found under any known mount", {
    candidates: mounts.length,
    reasons,
  });
}
