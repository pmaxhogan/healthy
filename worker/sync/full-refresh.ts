/**
 * The daily full-scope refresh that fills the MCP's read cache.
 *
 * Everything the owner's record contains, per provider, once a day, into
 * `fhir_cache` with an eight-day TTL -- a day longer than a week so a single
 * missed night never empties the cache the MCP serves from.
 *
 * Isolation is per (provider, resource type), one level finer than the calendar
 * sync. That is deliberate: an organisation that exposes Immunization but not
 * Coverage should produce a cache full of immunizations and one recorded failure,
 * not an empty cache. `fhir_sync_state` is where those failures live, and it
 * survives every later success, because the useful question is not "how did last
 * night go" but "which resource types has this organisation never returned
 * anything for" -- that is what tells the owner a scope is missing.
 *
 * Epic-specific behaviour encoded here:
 *
 *   - **The registry is intersected with the CapabilityStatement.**
 *     `filterSupported` drops resource types the organisation does not expose and
 *     prunes search parameters it does not advertise, rather than sending searches
 *     that come back 4122 or empty.
 *   - **`DocumentReference` is metadata only, and `Binary` is never searched.**
 *     Epic caps document queries per day (error 4135), and the attached document
 *     bodies are fetched lazily when the MCP is actually asked for one.
 *   - **4135 stops document work for that provider for the rest of the run.** The
 *     cap is daily, so continuing would spend the remaining quota on failures.
 *   - **Only `Patient` is read by id.** The other `mode: "read"` entries
 *     (Practitioner, Location, Organization, Medication, Binary) exist to be
 *     resolved on demand, and reading them speculatively would be unbounded.
 *
 * Log lines carry provider ids, resource type names, counts and Epic codes. Never
 * a search URL -- the parameters carry the patient id -- and never a resource.
 */

import { makeRepos } from "../db/index.ts";
import { getAllSettings, setSyncBackoff } from "../db/settings.ts";
import { EPIC_DOCUMENT_CAP } from "../fhir/operation-outcome.ts";
import { SEARCH_REGISTRY, filterSupported } from "../fhir/search-registry.ts";
import { isAppError } from "../lib/errors.ts";
import { errorFields } from "../lib/log.ts";

import { backoffUntilSeconds, rateLimitOf } from "./backoff.ts";
import { getCapabilityIndex } from "./discovery.ts";
import { emptySummary, record } from "./run.ts";
import { syncTargets } from "./targets.ts";
import { getFhirClientFor } from "./tokens.ts";

import type { SyncDeps } from "./deps.ts";
import type { RunState } from "./run.ts";
import type { SyncTarget } from "./targets.ts";
import type { Ctx } from "../db/client.ts";
import type { Repos } from "../db/index.ts";
import type { SyncWarning } from "../db/schemas.ts";
import type { RegistryEntry } from "../fhir/search-registry.ts";
import type { Resource, SearchWarning } from "../fhir/types.ts";
import type { FhirClient } from "../providers/epic/fhir-client.ts";
import type { RunKind, RunSummary } from "@shared/types.ts";

/** How long a cached resource stays usable. Eight days, in milliseconds. */
const FULL_REFRESH_TTL_MS = 8 * 24 * 60 * 60 * 1000;

/** Resource types whose retrieval is capped by Epic's daily document quota. */
const DOCUMENT_TYPES: ReadonlySet<string> = new Set(["DocumentReference", "Binary"]);

export interface FullRefreshOptions {
  providerIds?: string[];
  trigger?: RunKind;
  deps?: SyncDeps;
}

/**
 * Refresh every provider's cached record.
 *
 * Writes one `run_log` row of kind "full" and resolves with its summary. Never
 * throws.
 */
export async function runFullRefresh(
  ctx: Ctx,
  options: FullRefreshOptions = {},
): Promise<RunSummary> {
  const deps = options.deps ?? {};
  const repos = makeRepos(ctx);
  const settings = await getAllSettings(ctx);
  if (settings.sync_backoff_until !== null && settings.sync_backoff_until > ctx.now()) {
    ctx.log.info("sync.backoff.skip", {
      secondsRemaining: settings.sync_backoff_until - ctx.now(),
      kind: "full",
    });
    return { ...emptySummary(), backedOff: true };
  }

  return record(ctx, options.trigger ?? "full", async (state) => {
    const targets = await syncTargets(repos, options.providerIds);
    state.summary.providers = targets.length;
    for (const target of targets) {
      try {
        await refreshProvider(ctx, repos, target, state, deps);
        await repos.connections.recordSync(target.connection.id, "full");
      } catch (error) {
        state.summary.errors.push({ providerId: target.provider.id, code: codeOf(error) });
        ctx.log.error("refresh.provider_failed", {
          providerId: target.provider.id,
          ...errorFields(error),
        });
        const limit = rateLimitOf(error);
        if (limit === null) continue;
        await setBackoff(ctx, limit.retryAfterMs);
        state.summary.backedOff = true;
        return;
      }
    }
  });
}

async function refreshProvider(
  ctx: Ctx,
  repos: Repos,
  target: SyncTarget,
  state: RunState,
  deps: SyncDeps,
): Promise<void> {
  const providerId = target.provider.id;
  const session = await getFhirClientFor(ctx, providerId, deps);
  const capabilities = await getCapabilityIndex(
    ctx,
    repos,
    target.provider,
    session.adapter,
    await session.getAccessToken(),
  );
  // A missing CapabilityStatement means "try the whole registry": the alternative
  // is to fetch nothing, and an unsupported search costs one 4122 warning.
  const entries =
    capabilities === null ? [...SEARCH_REGISTRY] : filterSupported(SEARCH_REGISTRY, capabilities);

  // Set once a 4135 is seen, and honoured for the rest of this provider's pass.
  const documentCap = { reached: false };
  for (const entry of entries) {
    if (documentCap.reached && DOCUMENT_TYPES.has(entry.resourceType)) {
      ctx.log.info("refresh.documents.capped", { providerId, resourceType: entry.resourceType });
      await repos.fhirSyncState.record(providerId, entry.resourceType, {
        ok: false,
        errorCode: `epic_${EPIC_DOCUMENT_CAP}`,
      });
      continue;
    }
    await refreshResourceType(ctx, repos, session, target, entry, state, documentCap);
  }
}

/** One (provider, resource type) pass. Failures are recorded, never rethrown. */
async function refreshResourceType(
  ctx: Ctx,
  repos: Repos,
  session: { client: FhirClient; patientId: string },
  target: SyncTarget,
  entry: RegistryEntry,
  state: RunState,
  documentCap: { reached: boolean },
): Promise<void> {
  const providerId = target.provider.id;
  try {
    const { resources, warnings } = await fetchEntry(session, entry);
    if (warnings.some((warning) => warning.epicCode === EPIC_DOCUMENT_CAP)) {
      documentCap.reached = true;
    }
    state.summary.warnings += warnings.length;
    for (const warning of warnings) {
      if (warning.epicCode !== null) state.warningCodes.add(warning.epicCode);
    }
    if (resources.length > 0) {
      const report = await repos.fhirCache.upsertMany(
        providerId,
        resources.map((resource) => ({
          ...resource,
          resourceType: resource.resourceType,
          id: resource.id ?? "",
        })),
        FULL_REFRESH_TTL_MS,
      );
      state.summary.resourcesCached += report.written + report.unchanged;
    }
    await repos.fhirSyncState.record(providerId, entry.resourceType, {
      ok: true,
      errorCode: null,
      warnings: countCodes(warnings),
    });
    ctx.log.info("refresh.type", {
      providerId,
      resourceType: entry.resourceType,
      count: resources.length,
      warnings: warnings.length,
    });
  } catch (error) {
    if (epicCodesOf(error).includes(EPIC_DOCUMENT_CAP)) documentCap.reached = true;
    const code = codeOf(error);
    await repos.fhirSyncState.record(providerId, entry.resourceType, {
      ok: false,
      errorCode: code,
    });
    ctx.log.warn("refresh.type_failed", {
      providerId,
      resourceType: entry.resourceType,
      ...errorFields(error),
    });
    // A rate limit is the one failure that must escape this level: it concerns
    // every resource type and every provider, not just this pass.
    if (rateLimitOf(error) !== null) throw error;
  }
}

/** Run every parameter set an entry asks for, or read the Patient by id. */
async function fetchEntry(
  session: { client: FhirClient; patientId: string },
  entry: RegistryEntry,
): Promise<{ resources: Resource[]; warnings: SearchWarning[] }> {
  if (entry.mode === "read") {
    if (entry.resourceType !== "Patient") return { resources: [], warnings: [] };
    const patient = await session.client.read("Patient", session.patientId);
    return { resources: patient === null ? [] : [patient], warnings: [] };
  }
  const resources: Resource[] = [];
  const warnings: SearchWarning[] = [];
  const seen = new Set<string>();
  // `sinceIso` is deliberately omitted: the cache is the owner's whole record,
  // and paging is already capped by the client's `maxPages`.
  for (const params of entry.params(session.patientId)) {
    const result = await session.client.search(entry.resourceType, params);
    warnings.push(...result.warnings);
    for (const resource of result.resources) {
      const key = `${resource.resourceType}/${resource.id ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resources.push(resource);
    }
  }
  return { resources, warnings };
}

/** Epic numeric codes on an AppError's details, when it carried any. */
function epicCodesOf(error: unknown): string[] {
  if (!isAppError(error)) return [];
  const codes = error.details?.epicCodes;
  return Array.isArray(codes)
    ? codes.filter((code): code is string => typeof code === "string")
    : [];
}

/** Collapse search warnings into the `{code, count}` rows the state table holds. */
function countCodes(warnings: readonly SearchWarning[]): SyncWarning[] {
  const counts = new Map<string, number>();
  for (const warning of warnings) {
    const code = warning.epicCode ?? warning.code;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts].map(([code, count]) => ({ code, count }));
}

async function setBackoff(ctx: Ctx, retryAfterMs: number | undefined): Promise<void> {
  await setSyncBackoff(ctx, backoffUntilSeconds(ctx.now(), retryAfterMs));
  ctx.log.warn("sync.backoff.set", { kind: "full", retryAfterMs: retryAfterMs ?? null });
}

/**
 * A stable code for `fhir_sync_state.last_error_code`.
 *
 * Epic's numeric code is appended when there is one, because "upstream_error"
 * alone does not distinguish "you are not registered for this" from "the daily
 * document cap is reached".
 */
function codeOf(error: unknown): string {
  if (!isAppError(error)) return "internal";
  const epic = epicCodesOf(error)[0];
  return epic === undefined ? error.code : `${error.code}:${epic}`;
}
