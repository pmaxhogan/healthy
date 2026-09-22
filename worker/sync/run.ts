/**
 * `run_log` bookkeeping, and the two summary shapes that have to be kept apart.
 *
 * There are genuinely two. `RunSummary` in `shared/types.ts` is the DTO the admin
 * UI renders: camelCase, with `filteredView` and `backedOff` flags and errors as
 * `{providerId, code}` pairs. `runSummarySchema` in `worker/db/schemas.ts` is what
 * `run_log.summary_json` stores: shorter names, warnings as both a count and the
 * distinct codes, errors as plain strings, and a `unchanged` count the DTO has no
 * field for. `toStoredSummary` is the one place that translates, and every field
 * the DTO has now survives the round trip -- a run that reports no changes is
 * explained by `filteredView` or `backedOff` or by nothing, and reading the row
 * back has to be able to say which. `providerId` is dropped on the way in --
 * the run log is the table an operator reads casually, and a provider id there is
 * one join away from naming a health system.
 *
 * A run row is opened before any work and closed after it, so a run cut off
 * mid-flight (CPU limit, a deploy) leaves `finished_at IS NULL`. That is the only
 * way to see those at all, which is why `record` opens the row itself rather than
 * writing one row at the end.
 *
 * `record` never throws. A sync is driven by cron and by a fire-and-forget
 * `waitUntil`, and there is nobody to catch: an unexpected failure becomes an
 * error on the summary, `ok = 0` on the row, and a returned summary the caller can
 * render.
 */

import { makeRepos } from "../db/index.ts";
import { errorFields } from "../lib/log.ts";

import type { Ctx } from "../db/client.ts";
import type { RunSummaryInput } from "../db/schemas.ts";
import type { RunKind, RunSummary } from "@shared/types.ts";

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
}

function newRunState(): RunState {
  return { summary: emptySummary(), unchanged: 0, warningCodes: new Set() };
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
  };
}

/**
 * Open a run row, do the work, close the row, return the summary.
 *
 * The callback is handed the mutable state and counts into it. A throw is caught,
 * recorded as an `internal` error on the summary, and the row closed with
 * `ok = 0`; the summary is still returned.
 */
export async function record(
  ctx: Ctx,
  kind: RunKind,
  work: (state: RunState) => Promise<void>,
): Promise<RunSummary> {
  const repos = makeRepos(ctx);
  const state = newRunState();
  const runId = await repos.runLog.start(kind);
  try {
    await work(state);
  } catch (error) {
    ctx.log.error("sync.run_failed", { runId, kind, ...errorFields(error) });
    state.summary.errors.push({ providerId: "", code: codeOf(error) });
  }
  await repos.runLog.finish(runId, {
    ok: state.summary.errors.length === 0,
    summary: toStoredSummary(state),
  });
  return state.summary;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "internal";
}
