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
 * ### Why this is chunked, and what a chunk is
 *
 * A refresh of a large record is minutes of wall clock, nearly all of it waiting on
 * the organisation. That is fine under cron, which gets minutes. It is *not* fine
 * behind a request: work handed to `ctx.waitUntil` is cancelled about thirty
 * seconds after the response is written, mid-`await`, with the invocation still
 * reported as `ok`. That is exactly how a refresh came to leave half a record
 * cached, `connections.last_full_refresh_at` NULL and a `run_log` row open forever.
 *
 * So `runFullRefreshChunk` takes a wall-clock `budgetMs` and a `RefreshJob`. When
 * the budget is spent it stops between two resource types, hands back a job
 * describing what is left, and leaves the run row open; `runner.ts` stores that job
 * in a Durable Object and re-arms an alarm, so the next chunk is a fresh invocation
 * with a fresh budget. `runFullRefresh` is the same thing with no budget, which is
 * what cron still uses and what the tests drive.
 *
 * Resuming needs no new table. `fhir_sync_state.last_full_at` is already stamped
 * per (provider, resource type) on success *and* on failure, so a type whose stamp
 * is at or after the cycle's start instant is done for this cycle and is skipped --
 * which also means a type that failed is not retried within one cycle.
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
import type { RunState, RunStateSnapshot } from "./run.ts";
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

/**
 * How much wall clock one chunk of a chunked refresh may spend.
 *
 * Twenty seconds against a thirty second cancellation deadline. The check happens
 * *between* resource types, so a chunk overruns by however long its last type takes
 * -- a few seconds for everything observed -- and ten seconds of headroom is what
 * pays for that. Raising this trades margin for fewer alarms and is not worth it.
 */
export const CHUNK_BUDGET_MS = 20_000;

export interface FullRefreshOptions {
  providerIds?: string[];
  trigger?: RunKind;
  deps?: SyncDeps;
}

/**
 * What one chunk hands the next.
 *
 * `pending` is the providers still to walk, `cycleStartedAt` the instant the whole
 * refresh began (the resume marker against `fhir_sync_state.last_full_at`), and
 * `runId` plus `state` the one open run row and its counts so far. `runId` is null
 * only before the first chunk has opened the row.
 */
export interface RefreshJob {
  pending: string[];
  cycleStartedAt: number;
  runId: string | null;
  state: RunStateSnapshot | null;
}

export interface FullRefreshResult {
  summary: RunSummary;
  /** Null when the refresh is done; otherwise what the next chunk needs. */
  job: RefreshJob | null;
}

export interface ChunkOptions extends FullRefreshOptions {
  /** Resume this job rather than starting a refresh. */
  job?: RefreshJob;
  /** Stop between resource types once this much wall clock has gone. */
  budgetMs?: number;
}

/**
 * Refresh every provider's cached record, start to finish, in this invocation.
 *
 * Writes one `run_log` row of kind "full" and resolves with its summary. Never
 * throws. Safe only where the caller has minutes of wall clock -- cron does, a
 * request's `waitUntil` does not; that path goes through `runner.ts`.
 */
export async function runFullRefresh(
  ctx: Ctx,
  options: FullRefreshOptions = {},
): Promise<RunSummary> {
  const { summary } = await runFullRefreshChunk(ctx, options);
  return summary;
}

/**
 * One chunk of a refresh: as many (provider, resource type) passes as the budget
 * allows, then a job describing the rest.
 *
 * With no `budgetMs` this is `runFullRefresh` and `job` always comes back null.
 */
export async function runFullRefreshChunk(
  ctx: Ctx,
  options: ChunkOptions = {},
): Promise<FullRefreshResult> {
  const deps = options.deps ?? {};
  const repos = makeRepos(ctx);
  const resuming = options.job;
  const cycleStartedAt = resuming?.cycleStartedAt ?? ctx.now();
  // Null until some chunk has opened the run row, which is also the test for "this
  // is the first chunk": the first chunk of a chunked refresh already carries a job,
  // so asking whether `resuming` exists is the wrong question.
  const openRunId = resuming?.runId ?? null;

  const settings = await getAllSettings(ctx);
  if (settings.sync_backoff_until !== null && settings.sync_backoff_until > ctx.now()) {
    ctx.log.info("sync.backoff.skip", {
      secondsRemaining: settings.sync_backoff_until - ctx.now(),
      kind: "full",
    });
    // A backoff set between two chunks -- by the hourly sync meeting a 429, say --
    // ends this refresh, and the row an earlier chunk opened has to be closed here.
    // Left open it would be swept half an hour later as `aborted`, which is not
    // what happened: the counts so far are real and the reason is a rate limit.
    if (openRunId === null) return { summary: { ...emptySummary(), backedOff: true }, job: null };
    const stopped = await record(
      ctx,
      options.trigger ?? "full",
      (state) => {
        state.summary.backedOff = true;
        return Promise.resolve();
      },
      { runId: openRunId, state: resuming?.state ?? null },
    );
    return { summary: stopped.summary, job: null };
  }

  const nowMs = deps.nowMs ?? ((): number => Date.now());
  const budget: Budget = {
    startedMs: nowMs(),
    limitMs: options.budgetMs ?? null,
    nowMs,
    processed: 0,
  };
  // Filled in by the callback when the budget runs out mid-refresh, and read after
  // `record` has returned: the run's own state has nowhere to put it.
  const deferred: { pending: string[] | null } = { pending: null };

  const outcome = await record(
    ctx,
    options.trigger ?? "full",
    async (state) => {
      const targets = await syncTargets(repos, resuming?.pending ?? options.providerIds);
      // Only on the chunk that opens the row. A later chunk sees just what is left
      // of `targets`, so counting again there would report one provider for a
      // refresh of three.
      if (openRunId === null) state.summary.providers = targets.length;
      for (const [index, target] of targets.entries()) {
        try {
          const stopped = await refreshProvider(ctx, repos, target, state, deps, {
            cycleStartedAt,
            chunked: resuming !== undefined,
            budget,
          });
          if (stopped) {
            deferred.pending = targets.slice(index).map((remaining) => remaining.provider.id);
            ctx.log.info("refresh.deferred", {
              providerId: target.provider.id,
              pending: deferred.pending.length,
              types: budget.processed,
            });
            break;
          }
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
          // Not deferred: a backoff is a decision to stop, not to come back in
          // twenty seconds. The row is closed and the job is dropped.
          return;
        }
      }
      // Not a return value: see `RunState.unfinished`.
      state.unfinished = deferred.pending !== null;
    },
    { runId: openRunId, state: resuming?.state ?? null },
  );

  return {
    summary: outcome.summary,
    job:
      outcome.unfinished && deferred.pending !== null
        ? {
            pending: deferred.pending,
            cycleStartedAt,
            runId: outcome.runId,
            state: outcome.state,
          }
        : null,
  };
}

/**
 * How much wall clock this chunk may still spend.
 *
 * `processed` is what guarantees forward progress: at least one resource type is
 * always attempted, so a single slow type can never make a chunk defer everything
 * and re-arm forever.
 */
interface Budget {
  startedMs: number;
  limitMs: number | null;
  nowMs: () => number;
  processed: number;
}

function budgetSpent(budget: Budget): boolean {
  if (budget.limitMs === null || budget.processed === 0) return false;
  // Named rather than inlined: an early return and a bare comparison are what
  // `unicorn/prefer-ternary` collapses into the ternary the next rule rejects.
  const elapsedMs = budget.nowMs() - budget.startedMs;
  return elapsedMs >= budget.limitMs;
}

/** How this pass resumes and when it must stop. */
interface RefreshPass {
  cycleStartedAt: number;
  /** A chunked run consults `fhir_sync_state` to skip what is already done. */
  chunked: boolean;
  budget: Budget;
}

/**
 * The resource types this provider has already had refreshed in this cycle.
 *
 * One query rather than one per entry, and only for a chunked run: an unchunked
 * refresh has nothing to skip, and asking would make "run it twice in a row"
 * -- which the tests do, on a fixed clock -- mean "do nothing the second time".
 */
async function completedTypes(
  repos: Repos,
  providerId: string,
  cycleStartedAt: number,
): Promise<ReadonlySet<string>> {
  const states = await repos.fhirSyncState.listByProvider(providerId);
  return new Set(
    states
      .filter((state) => state.lastFullAt !== null && state.lastFullAt >= cycleStartedAt)
      .map((state) => state.resourceType),
  );
}

/** True when the budget ran out and this provider still has resource types left. */
async function refreshProvider(
  ctx: Ctx,
  repos: Repos,
  target: SyncTarget,
  state: RunState,
  deps: SyncDeps,
  pass: RefreshPass,
): Promise<boolean> {
  const providerId = target.provider.id;
  const done = pass.chunked
    ? await completedTypes(repos, providerId, pass.cycleStartedAt)
    : new Set<string>();
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
  // Deliberately *not* carried across a chunk boundary: the only entry that reads
  // it and is not itself a document type is `Binary`, which is mode "read" and
  // therefore never searched, so a fresh chunk starting with `reached: false`
  // cannot spend any of the daily document quota it would have saved.
  const documentCap = { reached: false };
  for (const entry of entries) {
    if (done.has(entry.resourceType)) continue;
    if (budgetSpent(pass.budget)) return true;
    pass.budget.processed += 1;
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
  return false;
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
