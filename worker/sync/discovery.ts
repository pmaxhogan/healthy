/**
 * Cached SMART discovery and CapabilityStatement, per health system.
 *
 * **Where they live, and why.** Both documents are per-health system, JSON, and want a
 * TTL -- which is exactly what `fhir_cache` already is, down to the sealed
 * payload and the `expires_at` sweep. Rather than add a table (and a migration
 * this agent does not own) they are stored there under two synthetic resource
 * types, `_smart` and `_capability`, at the fixed resource id `v1`. The leading
 * underscore is the marker: no FHIR resource type starts with one, so nothing can
 * collide with a real cached resource, and a consumer of `fhir_cache` can filter
 * them out with a single prefix test.
 *
 * The cost of that choice is that `fhirCache.countsByType()` will report `_smart`
 * and `_capability` alongside the clinical types, so the admin overview and any
 * MCP summary must skip resource types beginning with `_`. That is called out in
 * the hand-off notes.
 *
 * **Why they are cached at all.** An organisation can move its authorize and
 * token endpoints without changing its FHIR base, and Epic's CapabilityStatement
 * is megabytes of XML-ish JSON that changes at a quarterly upgrade cadence.
 * Re-fetching either on an hourly sync would be pure waste; never re-fetching
 * would break silently at the next upgrade. Seven days is the spec's answer.
 *
 * A capability fetch needs a bearer token and a discovery fetch does not, which
 * is why they are two functions rather than one: the token manager needs
 * `tokenUrl` before it has a token at all.
 */

import { AppError } from "../lib/errors.ts";
import { errorFields } from "../lib/log.ts";

import type { Ctx } from "../db/client.ts";
import type { Repos } from "../db/index.ts";
import type { HealthSystemRow } from "../db/rows.ts";
import type { CapabilityIndex, SmartConfig } from "../fhir/types.ts";
import type { ProviderAdapter } from "../providers/adapter.ts";

/** How long a cached discovery document is trusted. Seven days, in ms. */
const DISCOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Synthetic `fhir_cache.resource_type` for `.well-known/smart-configuration`. */
const SMART_CACHE_TYPE = "_smart";
/** Synthetic `fhir_cache.resource_type` for the indexed CapabilityStatement. */
const CAPABILITY_CACHE_TYPE = "_capability";
/** The single row id both use. Bumped only if the stored shape changes. */
const CACHE_ID = "v1";

/** True for the synthetic rows this module writes. For consumers to filter on. */
export function isDiscoveryCacheType(resourceType: string): boolean {
  return resourceType.startsWith("_");
}

/**
 * The envelope stored in `payload_enc`.
 *
 * `resourceType` and `id` are there because `fhirCache.upsertMany` keys the row
 * (and the AAD) off them; `document` is the payload this module cares about.
 */
interface CachedDocument {
  resourceType: string;
  id: string;
  document: unknown;
  /**
   * `CacheableResource` carries an index signature, and TypeScript does not infer
   * one for an interface, so it is declared. Nothing else is ever stored here.
   */
  [extra: string]: unknown;
}

/** Pull the document out of a cached envelope, or null if it is not the shape. */
function documentOf<T>(value: unknown, guard: (inner: unknown) => inner is T): T | null {
  if (typeof value !== "object" || value === null) return null;
  const { document } = value as { document?: unknown };
  return guard(document) ? document : null;
}

function isSmartConfig(value: unknown): value is SmartConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SmartConfig>;
  return typeof candidate.authorizeUrl === "string" && typeof candidate.tokenUrl === "string";
}

function isCapabilityIndex(value: unknown): value is CapabilityIndex {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CapabilityIndex>;
  return candidate.resources !== undefined && typeof candidate.resources === "object";
}

async function readCached<T>(
  repos: Repos,
  healthSystemId: string,
  resourceType: string,
  guard: (value: unknown) => value is T,
): Promise<T | null> {
  const row = await repos.fhirCache.get(healthSystemId, resourceType, CACHE_ID);
  if (row === null) return null;
  // A payload written by an older shape is treated as a miss rather than an
  // error: the document is re-fetched and the row overwritten.
  return documentOf(row.resource, guard);
}

async function writeCached(
  repos: Repos,
  healthSystemId: string,
  resourceType: string,
  document: unknown,
): Promise<void> {
  const envelope: CachedDocument = { resourceType, id: CACHE_ID, document };
  await repos.fhirCache.upsertMany(healthSystemId, [envelope], DISCOVERY_TTL_MS);
}

/**
 * The health system's SMART configuration, from the cache when it is still fresh.
 *
 * `force` is for the admin "test this health system" path: it re-fetches even when a
 * cached copy would do.
 */
export async function getSmartConfig(
  ctx: Ctx,
  repos: Repos,
  healthSystem: HealthSystemRow,
  adapter: ProviderAdapter,
  options: { force?: boolean } = {},
): Promise<SmartConfig> {
  if (options.force !== true) {
    const cached = await readCached(repos, healthSystem.id, SMART_CACHE_TYPE, isSmartConfig);
    if (cached !== null) return cached;
  }
  const config = await adapter.discover(healthSystem.fhir_base_url);
  await writeCached(repos, healthSystem.id, SMART_CACHE_TYPE, config);
  ctx.log.info("sync.discovery.refreshed", { healthSystemId: healthSystem.id });
  return config;
}

/**
 * The health system's capability index, from the cache when it is still fresh.
 *
 * Returns null rather than throwing when the fetch fails: every consumer
 * (`encounterStatusFilter`, `filterSupported`) already treats a null index as
 * "assume nothing is native and filter locally", which is the correct, if
 * slower, behaviour. A missing CapabilityStatement must not fail a sync.
 */
export async function getCapabilityIndex(
  ctx: Ctx,
  repos: Repos,
  healthSystem: HealthSystemRow,
  adapter: ProviderAdapter,
  accessToken: string,
): Promise<CapabilityIndex | null> {
  const cached = await readCached(repos, healthSystem.id, CAPABILITY_CACHE_TYPE, isCapabilityIndex);
  if (cached !== null) return cached;
  try {
    const index = await adapter.getCapabilities(healthSystem.fhir_base_url, accessToken);
    await writeCached(repos, healthSystem.id, CAPABILITY_CACHE_TYPE, index);
    ctx.log.info("sync.capabilities.refreshed", {
      healthSystemId: healthSystem.id,
      resourceTypes: Object.keys(index.resources).length,
    });
    return index;
  } catch (error) {
    ctx.log.warn("sync.capabilities.failed", {
      healthSystemId: healthSystem.id,
      ...errorFields(error),
    });
    return null;
  }
}

/** The Epic client id for a health system's environment. Throws when it is unset. */
export function clientIdFor(ctx: Ctx, healthSystem: HealthSystemRow): string {
  const clientId =
    healthSystem.environment === "prod"
      ? ctx.env.EPIC_CLIENT_ID_PROD
      : ctx.env.EPIC_CLIENT_ID_NONPROD;
  if (clientId === undefined || clientId === "") {
    throw new AppError("internal", "the Epic client id secret for this environment is not set", {
      environment: healthSystem.environment,
    });
  }
  return clientId;
}
