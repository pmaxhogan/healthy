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

import type { RetryOpts } from "../lib/retry.ts";

export interface SyncDeps {
  /** Upstream FHIR and Google Calendar transport. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Trello transport, kept apart from `fetchImpl`. Defaults to global fetch. */
  trelloFetch?: typeof fetch;
  /** Forwarded to `retriedFetch`; a test injects a no-op sleep and 2 attempts. */
  retry?: RetryOpts;
  /** Sleep used while waiting on someone else's refresh lease. */
  sleep?: (ms: number) => Promise<void>;
  /** Absolute origin reconnect links are built from. See `alerts.ts`. */
  origin?: string;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Every dep resolved to a value, so call sites take one object. */
export interface ResolvedDeps {
  fetchImpl: typeof fetch;
  trelloFetch: typeof fetch;
  retry: RetryOpts;
  sleep: (ms: number) => Promise<void>;
  origin: string | undefined;
}

/** The origin every reconnect link is built from when nothing overrides it. */
export const DEFAULT_PUBLIC_ORIGIN = "https://healthy.maxhogan.dev";

export function resolveDeps(deps: SyncDeps = {}): ResolvedDeps {
  return {
    fetchImpl: deps.fetchImpl ?? fetch,
    trelloFetch: deps.trelloFetch ?? deps.fetchImpl ?? fetch,
    retry: deps.retry ?? {},
    sleep: deps.sleep ?? realSleep,
    origin: deps.origin,
  };
}
