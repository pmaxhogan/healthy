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
 * Three hard rules:
 *
 *  - **Credentials are never sent from this module.** Every probe is an
 *    unauthenticated GET of the login page. Whatever a wrong guess reaches, it
 *    reaches without a password.
 *  - **No cookie jar.** A probe against the wrong mount (or a redirect chain
 *    through an alias) must not be able to plant a cookie that a later
 *    authenticated session would carry.
 *  - **The origin this reports is https, and on the site the owner pasted.**
 *    What comes out of here becomes `portal_accounts.base_url`, which is where
 *    the owner's portal password is POSTed from then on -- so the chain is not
 *    allowed to relocate it (`portalFetch` refuses an off-site or non-https hop)
 *    and the landed origin is re-checked here before it is reported. The owner
 *    then confirms that origin before any credential is sealed against it; see
 *    `worker/api/routes/portal.ts`.
 *
 * The mount is taken from where the probe *landed*, not from the candidate that
 * was tried: a root-mounted probe that gets redirected to a prefix has, in one
 * request, discovered the prefix. That is why the candidate list can be short.
 */

import { AppError } from "../../lib/errors.ts";

import { apiBasePathHint, findAntiforgeryField, inputFields } from "./html.ts";
import {
  isOpenIdHandoff,
  mountedUrl,
  normaliseMount,
  originOf,
  portalFetch,
  requireHttps,
} from "./http.ts";
import { ANTIFORGERY_FIELD_NAMES, CANDIDATE_MOUNTS, FIELDS, PATHS } from "./wire.ts";

import type { PortalHttpDeps } from "./http.ts";
import type { PortalFlavor, UsernameField } from "./wire.ts";
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
  /**
   * Which login application drives this deployment. **Absent means `classic`.**
   *
   * Optional rather than required so that a caller which stored only the origin
   * and the mount -- everything written before this field existed -- still
   * type-checks and still signs in the way it always did. Discovery always sets
   * it, so an account rediscovered after this landed carries the real answer.
   */
  flavor?: PortalFlavor | undefined;
  /**
   * `custom_oidc` only: the origin serving the login shell and its JSON API.
   *
   * Discovered, as the origin the login probe's redirect chain landed on. Usually
   * the same origin as `baseUrl`; a deployment that federates across hosts is why
   * it is recorded separately.
   */
  authBaseUrl?: string | undefined;
  /**
   * `custom_oidc` only: the path prefix the login shell's JSON API is mounted at.
   *
   * **Not reliably discoverable, and never defaulted.** The real value names the
   * organisation, so it can have no fallback in source: discovery makes one
   * bounded attempt to read it off the handoff stub, and where that finds nothing
   * the caller supplies it (`PortalAdapterDeps.custom.apiBasePath`).
   */
  apiBasePath?: string | undefined;
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
  return mountBefore(landedUrl, [PATHS.login, PATHS.openId], fallback);
}

/**
 * The mount implied by a landing URL, given the mount-relative paths it could be.
 *
 * `markers` is tried in order and the first one found in the path wins, so
 * `.../x/Authentication/Login` and `.../x/OpenId?op=...` both yield `/x/`. The
 * second case is the whole reason this is a list: a `custom_oidc` deployment
 * redirects the login page to the handoff stub, and the mount then has to be read
 * out of *that* URL because the login path is no longer in it.
 */
function mountBefore(landedUrl: string, markers: readonly string[], fallback: string): string {
  let path: string;
  try {
    path = new URL(landedUrl).pathname;
  } catch {
    return normaliseMount(fallback);
  }
  const lower = path.toLowerCase();
  for (const marker of markers) {
    const at = lower.indexOf(marker.toLowerCase());
    if (at !== -1) return normaliseMount(path.slice(0, at));
  }
  return normaliseMount(fallback);
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
  // Belt and braces over `portalFetch`'s own per-hop rule: the value below is
  // about to become the origin a password is sent to.
  requireHttps(response.url, "Login");

  // Before the form checks, because a `custom_oidc` deployment fails all of them:
  // its login page renders no form at all, so without this it would be reported as
  // "no login page under any known mount" -- a dead end for something that is
  // simply a different, and supported, way of signing in.
  if (isOpenIdHandoff(response)) {
    const origin = originOf(response.url);
    const hint = apiBasePathHint(response.body);
    return {
      endpoint: {
        baseUrl: origin,
        mountPath: mountBefore(response.url, [PATHS.openId, PATHS.login], mount),
        // Seeds only, and unused by this flavour: the shell posts lower-case
        // `username`/`password` as JSON-app form fields and carries no
        // antiforgery token. Kept so the shape is one type, not two.
        usernameField: "Username",
        antiforgeryFieldName: ANTIFORGERY_FIELD_NAMES[0] ?? "__RequestVerificationToken",
        flavor: "custom_oidc",
        authBaseUrl: origin,
        ...(hint !== null && { apiBasePath: hint }),
      },
      reason: "http_error",
    };
  }

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
      flavor: "classic",
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
        flavor: result.endpoint.flavor,
        // Whether the hint found anything, never what it found: the value names
        // the organisation.
        apiBaseKnown: result.endpoint.apiBasePath !== undefined,
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
