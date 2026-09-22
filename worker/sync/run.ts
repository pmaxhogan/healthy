/**
 * `run_log` bookkeeping, and the two summary shapes that have to be kept apart.
 *
 * There are genuinely two here. `RunSummary` in `shared/types.ts` is the sync
 * engine's own working shape, built up while a run is in flight: camelCase, with
 * `filteredView` and `backedOff` flags and errors as `{providerId, code}` pairs --
 * the provider id is what lets a caller (and a test) say *which* connection
 * failed. `runSummarySchema` in `worker/db/schemas.ts` is what `run_log.summary_json`
 * stores: shorter names, warnings as both a count and the distinct codes, errors
 * as plain strings, and an `unchanged` count the working shape has no field for.
 * `toStoredSummary` is the one place that translates, and every field the working
 * shape has now survives the round trip -- a run that reports no changes is
 * explained by `filteredView` or `backedOff` or by nothing, and reading the row
 * back has to be able to say which. `providerId` is dropped on the way in --
 * the run log is the table an operator reads casually, and a provider id there is
 * one join away from naming a health system.
 *
 * A third shape, `RunSummaryDto` (also `shared/types.ts`), is what actually
 * reaches the admin UI: built by `worker/api/dto.ts` from the *stored* row, so its
 * `errors` and `warningCodes` are the bare codes above, never a provider id --
 * there was never one to reconstruct.
 *
 * A run row is opened before any work and closed after it, so a run cut off
 * mid-flight (CPU limit, a deploy) leaves `finished_at IS NULL`. That is the only
 * way to see those at all, which is why `record` opens the row itself rather than
 * writing one row at the end.
 *
 * ### Two things close a row, and only one of them is `finally`
 *
 * `finish` runs in a `finally`, so a throw the `catch` somehow does not see still
 * closes the row. That is not the whole answer and cannot be: when the platform
 * *cancels* an invocation -- a `waitUntil` past its 30 second post-response
 * deadline, a CPU limit, an eviction -- the isolate is torn down mid-`await` and
 * no `catch`, no `finally` and no alarm inside that invocation ever runs. The row
 * stays open forever. So `record` also **sweeps** at the head of every run: any
 * row still open after `STALE_RUN_SECONDS` belongs to an invocation that no longer
 * exists and is closed as `aborted`. The sweep happens before this run's own row
 * is opened, so it can never sweep itself.
 *
 * ### Resuming
 *
 * A chunked run (`worker/sync/full-refresh.ts`, driven by the Durable Object in
 * `runner.ts`) spans several invocations but must be *one* row: the Runs page
 * showing five rows for one button press would be a worse bug than the one this
 * fixes. So `record` takes an existing `runId` and a `RunStateSnapshot` of the
 * counts so far, and the work callback sets `state.unfinished` to say "leave the row
 * open, I am coming back". Only the chunk that finishes the work calls `finish`.
 *
 * `record` never throws. A sync is driven by cron and by a fire-and-forget
 * `waitUntil`, and there is nobody to catch: an unexpected failure becomes an
 * error on the summary, `ok = 0` on the row, and a returned summary the caller can
 * render.
 */

import { makeRepos } from "../db/index.ts";
import { errorFields } from "../lib/log.ts";

import type { Ctx } from "../db/client.ts";
import type { Repos } from "../db/index.ts";
import type { RunSummaryInput } from "../db/schemas.ts";
import type { RunKind, RunSummary } from "@shared/types.ts";

/**
 * How long an open row may sit before it is presumed dead.
 *
 * Generously longer than any real run: the daily refresh is minutes, and a chunked
 * one is capped well below this, so the threshold only ever catches a run whose
 * invocation is gone.
 */
const STALE_RUN_SECONDS = 30 * 60;

/** A zeroed DTO summary. Every run starts from one and counts upward. */
export function emptySummary(): RunSummary {
  return {
    providers: 0,
    encountersSeen: 0,
    eventsInserted: 0,
    eventsPatched: 0,
    eventsGhosted: 0,
    eventsRestored: 0,
    resourcesCached: 0,
    warnings: 0,
    filteredView: false,
    backedOff: false,
    errors: [],
    portalVisits: 0,
    portalSkipped: 0,
    portalErrors: [],
  };
}

/**
 * The run's mutable state.
 *
 * `unchanged` and `warningCodes` exist because the stored row wants them and the
 * DTO does not: the DTO reports how *many* warnings, the row reports that *and*
 * which codes, which is what makes "this org has been returning 4119 all week"
 * visible.
 */
export interface RunState {
  summary: RunSummary;
  unchanged: number;
  warningCodes: Set<string>;
  /**
   * The work will be back, so leave the row open.
   *
   * On the state rather than returned from the callback because the two callbacks
   * that never defer are `async` functions returning nothing, and a return type of
   * `Promise<Progress | void>` is both a lint error and a worse thing to read than
   * one assignment. Deliberately *not* part of `RunStateSnapshot`: it describes this
   * invocation, not the run, and a chunk that inherited it would never close its row.
   */
  unfinished: boolean;
}

function newRunState(): RunState {
  return { summary: emptySummary(), unchanged: 0, warningCodes: new Set(), unfinished: false };
}

/**
 * `RunState` in a shape that survives Durable Object storage and JSON.
 *
 * `warningCodes` is the reason this exists: a `Set` is not something to rely on
 * round-tripping through a serializer. Everything a chunk must carry forward is
 * listed explicitly rather than derived, so a count added to `RunState` and
 * forgotten here shows up as a type error instead of as a total silently reset to
 * zero by the next chunk. `unfinished` is the one field left out, on purpose.
 */
export interface RunStateSnapshot {
  summary: RunSummary;
  unchanged: number;
  warningCodes: string[];
}

function snapshotRunState(state: RunState): RunStateSnapshot {
  return {
    summary: {
      ...state.summary,
      errors: [...state.summary.errors],
      portalErrors: [...state.summary.portalErrors],
    },
    unchanged: state.unchanged,
    warningCodes: [...state.warningCodes],
  };
}

function restoreRunState(snapshot: RunStateSnapshot | null | undefined): RunState {
  if (snapshot === null || snapshot === undefined) return newRunState();
  return {
    summary: {
      ...snapshot.summary,
      errors: [...snapshot.summary.errors],
      portalErrors: [...snapshot.summary.portalErrors],
    },
    unchanged: snapshot.unchanged,
    warningCodes: new Set(snapshot.warningCodes),
    unfinished: false,
  };
}

/** Translate the DTO summary into the shape `run_log.summary_json` holds. */
function toStoredSummary(state: RunState): RunSummaryInput {
  const { summary } = state;
  return {
    providers: summary.providers,
    inserted: summary.eventsInserted,
    patched: summary.eventsPatched,
    ghosted: summary.eventsGhosted,
    restored: summary.eventsRestored,
    unchanged: state.unchanged,
    resources: summary.resourcesCached,
    // Codes only: a provider id here would identify an organisation.
    errors: summary.errors.map((error) => error.code),
    // eslint-disable-next-line unicorn/no-array-sort -- `toSorted` is ES2023 and the Worker compiles against the ES2022 lib; the array is a fresh one from the spread, so sorting in place mutates nothing shared.
    warnings: [...state.warningCodes].sort((a, b) => a.localeCompare(b)),
    // The count as well as the codes: see `runSummarySchema`.
    warningCount: summary.warnings,
    filteredView: summary.filteredView,
    backedOff: summary.backedOff,
    portalVisits: summary.portalVisits,
    portalSkipped: summary.portalSkipped,
    // Already bare codes: the portal pass never puts a provider id in here.
    portalErrors: [...summary.portalErrors],
  };
}

/** How to continue a run an earlier invocation left open. */
export interface RecordOptions {
  /** The row to keep writing to. A new one is opened when this is absent. */
  runId?: string | null;
  /** Counts carried over from an earlier chunk of the same run. */
  state?: RunStateSnapshot | null;
}

/** Everything a continuation needs to pick this run up again. */
export interface RunOutcome {
  summary: RunSummary;
  /** The row this run wrote, so the next chunk can be handed the same one. */
  runId: string;
  /** The work asked to be resumed: the row is deliberately still open. */
  unfinished: boolean;
  /** The counts so far, for that next chunk to carry. */
  state: RunStateSnapshot;
}

/**
 * Open (or resume) a run row, do the work, close the row, report the outcome.
 *
 * The callback is handed the mutable state and counts into it. A throw is caught,
 * recorded as an `internal` error on the summary, and the row closed with
 * `ok = 0`; the outcome is still returned. Setting `state.unfinished` leaves the row
 * open for the next chunk -- see the module comment.
 */
export async function record(
  ctx: Ctx,
  kind: RunKind,
  work: (state: RunState) => Promise<void>,
  options: RecordOptions = {},
): Promise<RunOutcome> {
  const repos = makeRepos(ctx);
  const state = restoreRunState(options.state);
  // Before this run's row exists, so it can never sweep its own.
  await sweepStaleRuns(ctx, repos);
  const runId = options.runId ?? (await repos.runLog.start(kind));
  try {
    await work(state);
  } catch (error) {
    ctx.log.error("sync.run_failed", { runId, kind, ...errorFields(error) });
    state.summary.errors.push({ providerId: "", code: codeOf(error) });
    // A run that threw is a finished run, whatever it had asked for before.
    state.unfinished = false;
  } finally {
    if (!state.unfinished) {
      await repos.runLog.finish(runId, {
        ok: state.summary.errors.length === 0,
        summary: toStoredSummary(state),
      });
    }
  }
  return {
    summary: state.summary,
    runId,
    unfinished: state.unfinished,
    state: snapshotRunState(state),
  };
}

/**
 * Close a resumable run that will not in fact be resumed.
 *
 * The chunk driver calls this when it gives up -- a refresh that has used its whole
 * chunk allowance and is still not done. Without it the row would sit open until
 * the sweeper got to it half an hour later, reported as `aborted` when the truthful
 * answer is the code passed here.
 */
export async function abandon(
  ctx: Ctx,
  runId: string,
  snapshot: RunStateSnapshot,
  code: string,
): Promise<void> {
  const repos = makeRepos(ctx);
  const state = restoreRunState(snapshot);
  state.summary.errors.push({ providerId: "", code });
  await repos.runLog.finish(runId, { ok: false, summary: toStoredSummary(state) });
}

/** Housekeeping, and never the reason a run does not happen: failures are logged. */
async function sweepStaleRuns(ctx: Ctx, repos: Repos): Promise<void> {
  try {
    await repos.runLog.sweepStale(ctx.now() - STALE_RUN_SECONDS);
  } catch (error) {
    ctx.log.warn("run.sweep_failed", errorFields(error));
  }
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "internal";
}
