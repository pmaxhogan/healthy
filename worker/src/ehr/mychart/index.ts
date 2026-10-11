/**
 * The portal boundary, and the one door into this directory.
 *
 * `worker/src/ehr/adapter.ts` draws the same line for the FHIR side: the sync
 * engine is written against an interface and knows nothing about a vendor.
 * `PortalAdapter` is that idea for the scrape, and it exists for the same reason
 * -- another vendor's patient portal is a different set of paths and a different
 * login form, but it is the same three questions (where does it live, how do I
 * sign in, what is coming up), so a second implementation should be a second
 * file and one line in `PORTAL_ADAPTERS`.
 *
 * Adapters are pure, exactly as the FHIR ones are: they take a `fetchImpl`, a
 * `Logger` and a clock, and they never read `env`, touch D1, or persist
 * anything. The cookie jar is handed in by the caller and handed back for the
 * caller to seal, because the caller is the only layer with storage.
 */

import { AppError, isAppError } from "../../lib/errors.ts";
import { createModMedAdapter, isModMedEndpoint } from "../modmed/index.ts";

import { createMyChartClient } from "./client.ts";
import { createCustomOidcClient } from "./custom-oidc/client.ts";
import { discoverPortal } from "./discovery.ts";

import type { PortalClient } from "./client.ts";
import type { CookieJar } from "./cookie-jar.ts";
import type { PortalCustomSettings } from "./custom-oidc/client.ts";
import type { PortalEndpoint } from "./discovery.ts";
import type { Logger } from "../../lib/log.ts";
import type { ModMedEndpoint } from "../modmed/index.ts";

export type { PortalClient, PortalCredentials, SecondaryValidation } from "./client.ts";
export type { PortalCustomSettings } from "./custom-oidc/client.ts";
export type { PortalEndpoint } from "./discovery.ts";
export type { PortalVisit } from "./visits.ts";
export type {
  AttachmentHandle,
  MessageAuthorRole,
  MessageFolder,
  PortalMessage,
  PortalMessageAttachment,
  PortalThread,
} from "./messages.ts";
export type { PortalFlavor, PortalVisitStatus, UsernameField } from "./wire.ts";
export { CookieJar } from "./cookie-jar.ts";

/** Which patient portal. */
export type PortalVendor = "mychart" | "modmed";

/**
 * Any vendor's stored discovery result. A ModMed one says so with
 * `portal: "modmed"`; a MyChart one predates the field and carries none, so
 * absent means MyChart.
 */
export type AnyPortalEndpoint = PortalEndpoint | ModMedEndpoint;

/** Everything an adapter needs from the outside world. */
export interface PortalAdapterDeps {
  fetchImpl: typeof fetch;
  logger: Logger;
  /** Unix seconds, matching the rest of the Worker. */
  now: () => number;
  /** The cache-buster's randomness. Injected so a test can pin a URL. */
  random?: (() => number) | undefined;
  maxRedirects?: number | undefined;
  /**
   * The two values a `custom_oidc` deployment may need and discovery cannot
   * always learn. Ignored entirely by the classic flavour.
   *
   * This is the escape hatch, not the intended path: the API base normally comes
   * out of discovery and lands in the endpoint JSON, and the MFA contact normally
   * comes out of the login response. Both are here because neither can have a
   * default -- the real values name the organisation and the owner respectively.
   */
  custom?: PortalCustomSettings | undefined;
}

export interface PortalDiscoveryInput {
  /** Whatever the owner pasted: any URL on the portal's host. */
  baseUrl: string;
  /** A mount the owner already knows, probed first. */
  mountHint?: string | undefined;
}

export interface PortalAdapter {
  readonly portal: PortalVendor;
  /**
   * Probe, unauthenticated and without a cookie jar, for a login page.
   *
   * Throws `portal_parse_failed` when nothing recognisable answered, and
   * `portal_bot_blocked` / `portal_unreachable` when the host will not talk.
   */
  discover(input: PortalDiscoveryInput, deps: PortalAdapterDeps): Promise<AnyPortalEndpoint>;
  /**
   * A client pointed at one instance, sharing one jar.
   *
   * The jar is the caller's: load it from the sealed column before the call and
   * seal whatever it holds afterwards, whether the call succeeded or not -- a
   * failed sign-in still leaves cookies worth keeping.
   */
  client(endpoint: AnyPortalEndpoint, jar: CookieJar, deps: PortalAdapterDeps): PortalClient;
}

/** Not exported: the map below is the only thing that holds one. */
type PortalAdapterFactory = () => PortalAdapter;

export function createMyChartAdapter(): PortalAdapter {
  return {
    portal: "mychart",
    async discover(input, deps) {
      return discoverPortal(input.baseUrl, {
        fetchImpl: deps.fetchImpl,
        logger: deps.logger,
        mountHint: input.mountHint,
        maxRedirects: deps.maxRedirects,
      });
    },
    client(endpoint, jar, deps) {
      if (isModMedEndpoint(endpoint)) {
        throw new AppError("portal_discovery_failed", "not a MyChart portal endpoint");
      }
      const common = {
        endpoint,
        jar,
        fetchImpl: deps.fetchImpl,
        logger: deps.logger,
        now: deps.now,
        random: deps.random,
        maxRedirects: deps.maxRedirects,
      };
      // The one branch in this directory that picks a login strategy. Absent
      // means `classic`, so an endpoint stored before the field existed behaves
      // exactly as it always did.
      return endpoint.flavor === "custom_oidc"
        ? createCustomOidcClient({ ...common, custom: deps.custom })
        : createMyChartClient(common);
    },
  };
}

/**
 * portal vendor -> adapter. The only place in the Worker that names one.
 *
 * Module-private on purpose: callers go through `portalAdapterFor`, so the
 * narrowing in `isPortalVendor` cannot be skipped.
 */
const PORTAL_ADAPTERS: Record<PortalVendor, PortalAdapterFactory> = {
  mychart: createMyChartAdapter,
  modmed: createModMedAdapter,
};

/** Narrow a string read out of D1 or a request body to a known portal vendor. */
export function isPortalVendor(value: string): value is PortalVendor {
  return Object.hasOwn(PORTAL_ADAPTERS, value);
}

/** Build the adapter for a portal vendor. Cheap: adapters hold no state. */
export function portalAdapterFor(vendor: string): PortalAdapter {
  if (!isPortalVendor(vendor)) {
    throw new AppError("bad_request", "unknown portal vendor", { vendor });
  }
  // `isPortalVendor` above is the guard: `vendor` is a key of this const map.
  return PORTAL_ADAPTERS[vendor]();
}

/**
 * The adapter every caller uses unless a test injects one: it works out the
 * vendor itself.
 *
 * Discovery asks ModMed first because ModMed's probe is one specific JSON
 * document that nothing else serves; when it is not there, MyChart's own
 * discovery runs and its answer (found, or the reason not) is the result.
 * A client is built by the vendor the stored endpoint names.
 */
export function createPortalAdapter(): PortalAdapter {
  const modmed = createModMedAdapter();
  const mychart = createMyChartAdapter();
  return {
    // Reported only for logging; the real vendor is per endpoint.
    portal: "mychart",
    async discover(input, deps) {
      try {
        return await modmed.discover(input, deps);
      } catch (error) {
        // A bot wall is the answer for the host, whoever runs it: probing on
        // with MyChart's candidates would only knock on it more times.
        if (isAppError(error) && error.code === "portal_bot_blocked") throw error;
        // Any other failure of ModMed's probe is "not ModMed, as far as can be
        // told": a MyChart host answers an unknown path with a 404, an error
        // page or a dropped connection depending on its front door, and none
        // of those says anything about MyChart itself. Its own discovery decides.
        return mychart.discover(input, deps);
      }
    },
    client(endpoint, jar, deps) {
      return isModMedEndpoint(endpoint)
        ? modmed.client(endpoint, jar, deps)
        : mychart.client(endpoint, jar, deps);
    },
  };
}
