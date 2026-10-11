/**
 * A per-isolate cache of SMART discovery documents.
 *
 * `.well-known/smart-configuration` is fetched twice in one authorisation -- once
 * to build the authorize URL, once to find the token endpoint on the way back --
 * and those two requests are minutes apart in different invocations. An
 * organisation can move its endpoints without changing its FHIR base, so the
 * document is not a constant; but it changes on the order of an Epic upgrade, not
 * of a request.
 *
 * In-memory rather than D1, deliberately. The cost of a miss is one small GET, the
 * value is bounded and non-personal (two URLs and three capability lists), and
 * keeping it out of the database means no new column to seal and no new row to
 * invalidate. A cold isolate simply fetches it again.
 */

import { adapterFor } from "../ehr/registry.ts";
import { AppError } from "../lib/errors.ts";
import { makeLogger } from "../lib/log.ts";

import type { SmartConfig } from "../fhir/types.ts";

/** Matches the build spec's 7-day discovery cache. */
export const DISCOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface Entry {
  config: SmartConfig;
  expiresAtMs: number;
}

const cache = new Map<string, Entry>();

/** Drop everything cached. Tests call this so one does not leak into the next. */
export function clearDiscoveryCache(): void {
  cache.clear();
}

export interface DiscoverOptions {
  fetchImpl: typeof fetch;
  /** Epoch milliseconds. Injected so a test can expire an entry without waiting. */
  nowMs?: () => number;
}

/**
 * The discovery document for one FHIR base, cached.
 *
 * `fhirBaseUrl` is the cache key verbatim, with no normalisation: Epic matches the
 * `aud` parameter as a string, so a base URL with and without a trailing slash are
 * genuinely different configurations and must not share an entry.
 */
export async function discoverCached(
  vendor: string,
  fhirBaseUrl: string,
  options: DiscoverOptions,
): Promise<SmartConfig> {
  const now = options.nowMs ?? Date.now;
  const key = `${vendor}\u{0}${fhirBaseUrl}`;
  const hit = cache.get(key);
  if (hit !== undefined && hit.expiresAtMs > now()) return hit.config;

  const adapter = adapterFor(vendor, {
    fetchImpl: options.fetchImpl,
    logger: makeLogger({ src: "oauth.discovery" }),
    now,
  });
  const config = await adapter.discover(fhirBaseUrl);
  if (config.authorizeUrl === "" || config.tokenUrl === "") {
    throw new AppError("upstream_error", "discovery returned no OAuth endpoints");
  }
  cache.set(key, { config, expiresAtMs: now() + DISCOVERY_TTL_MS });
  return config;
}
