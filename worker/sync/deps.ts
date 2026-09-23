/**
 * The seams the sync engine is tested through.
 *
 * Every export in `index.ts` takes an optional `deps`, and production never
 * passes one: the defaults are the real `fetch`, the real `retriedFetch`
 * behaviour and a real `setTimeout`. A test passes all three, which is what lets
 * the integration suite drive a whole sync run against in-memory upstreams with
 * no network and no real waiting.
 *
 * `trelloFetch` is separate from `fetchImpl` on purpose. A test that stubs the
 * FHIR and Google endpoints should not accidentally answer a Trello call with a
 * FHIR bundle -- and the alert path must never be able to reach the same stub the
 * sync uses, so a mistake there fails loudly rather than silently passing.
 */

import type { PortalAdapter } from "../ehr/mychart/index.ts";
import type { RetryOpts } from "../lib/retry.ts";

export interface SyncDeps {
  /** Upstream FHIR and Google Calendar transport. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * The patient portal, as an adapter.
   *
   * A whole adapter rather than a third `fetch`, because the portal pass is the
   * one part of the sync whose upstream is a scrape: stubbing it at the transport
   * would mean a test maintaining synthetic HTML for every page of a sign-in just
   * to assert something about ghosting. The live default is the MyChart adapter,
   * built where it is used -- see `portal-signin.ts`. Deliberately absent from
   * `ResolvedDeps`: nothing outside the portal pass has any use for it.
   */
  portalAdapter?: PortalAdapter;
  /** Trello transport, kept apart from `fetchImpl`. Defaults to global fetch. */
  trelloFetch?: typeof fetch;
  /** Forwarded to `retriedFetch`; a test injects a no-op sleep and 2 attempts. */
  retry?: RetryOpts;
  /** Sleep used while waiting on someone else's refresh lease. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Wall clock in milliseconds, for the chunk budget in `full-refresh.ts`.
   *
   * Separate from `Ctx.now()`, which is whole unix seconds by the schema's own
   * convention and therefore far too coarse to measure a twenty-second budget.
   * Defaults to `Date.now`; a test hands in a counter so "the budget ran out after
   * two resource types" is exact rather than a race against the machine.
   */
  nowMs?: () => number;
  /** Absolute origin reconnect links are built from. See `alerts.ts`. */
  origin?: string;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bound, not passed by reference: an unbound `fetch` loses its `this` in
 * workerd, which throws "Illegal invocation" the moment anything calls it as
 * `x.fetchImpl(...)` -- as `worker/ehr/mychart/http.ts` does. See
 * `worker/api/ports.ts`'s `defaults()`, which has the same fix already.
 */
const boundFetch: typeof fetch = (input, init) => fetch(input, init);

/** Every dep resolved to a value, so call sites take one object. */
export interface ResolvedDeps {
  fetchImpl: typeof fetch;
  trelloFetch: typeof fetch;
  retry: RetryOpts;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  origin: string | undefined;
}

/** The origin every reconnect link is built from when nothing overrides it. */
export const DEFAULT_PUBLIC_ORIGIN = "https://healthy.maxhogan.dev";

export function resolveDeps(deps: SyncDeps = {}): ResolvedDeps {
  return {
    fetchImpl: deps.fetchImpl ?? boundFetch,
    trelloFetch: deps.trelloFetch ?? deps.fetchImpl ?? boundFetch,
    retry: deps.retry ?? {},
    sleep: deps.sleep ?? realSleep,
    nowMs: deps.nowMs ?? ((): number => Date.now()),
    origin: deps.origin,
  };
}
