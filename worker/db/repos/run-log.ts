/**
 * History of scheduled and manual runs.
 *
 * A row is opened by `start` before any work happens and closed by `finish`, so a
 * run that was cut off mid-flight -- a Worker that hit its CPU limit, a deploy in
 * the middle of a sync -- leaves a row with `finished_at IS NULL`. That is the
 * only way to see those at all, which is why the two halves are separate calls.
 *
 * Nothing *inside* such a run can close its own row: the invocation stopped
 * existing, so neither a `catch` nor a `finally` ever ran. `sweepStale` is the net,
 * and `worker/sync/run.ts` calls it at the head of every later run.
 *
 * `summary_json` is counts and stable codes. See `runSummarySchema`.
 */

import { newId } from "../../lib/ids.ts";
import { all, one, run } from "../client.ts";
import { parseJsonColumn, runSummarySchema } from "../schemas.ts";

import type { Ctx } from "../client.ts";
import type { RunKind, RunLogRow } from "../rows.ts";
import type { RunSummary, RunSummaryInput } from "../schemas.ts";

export interface RunEntry {
  id: string;
  kind: RunKind;
  startedAt: number;
  finishedAt: number | null;
  /** null while the run is still going. */
  ok: boolean | null;
  summary: RunSummary;
}

/**
 * The error code a swept run carries.
 *
 * Stable, and deliberately not `internal`: "the invocation died" is a different
 * fact from "the work threw", and the Runs page has to be able to say which.
 */
export const RUN_ABORTED_CODE = "aborted";

export interface RunStats {
  kind: RunKind;
  runs: number;
  failures: number;
  /** Runs opened but never closed: the sign of a Worker that died mid-run. */
  unfinished: number;
  lastStartedAt: number | null;
  lastOk: boolean | null;
}

function decode(row: RunLogRow): RunEntry {
  return {
    id: row.id,
    kind: row.kind,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ok: row.ok === null ? null : row.ok === 1,
    summary: parseJsonColumn(runSummarySchema, row.summary_json, `run_log.summary_json.${row.id}`),
  };
}

export function makeRunLogRepo(ctx: Ctx) {
  return {
    /** Open a run row. Returns its id, which `finish` needs. */
    async start(kind: RunKind): Promise<string> {
      const id = newId();
      await run(
        ctx.db
          .prepare("INSERT INTO run_log (id, kind, started_at) VALUES (?, ?, ?)")
          .bind(id, kind, ctx.now()),
      );
      return id;
    },

    /** Close a run row with its outcome and counts. */
    async finish(id: string, outcome: { ok: boolean; summary?: RunSummaryInput }): Promise<void> {
      const summary = runSummarySchema.parse(outcome.summary ?? {});
      await run(
        ctx.db
          .prepare("UPDATE run_log SET finished_at = ?, ok = ?, summary_json = ? WHERE id = ?")
          .bind(ctx.now(), outcome.ok ? 1 : 0, JSON.stringify(summary), id),
      );
      ctx.log.info("run.finished", { runId: id, ok: outcome.ok, ...summary });
    },

    /**
     * Close every row still open from before `startedBefore`, as `aborted`.
     *
     * The only way a row stays open is an invocation that stopped existing --- a
     * `waitUntil` past its deadline, a CPU limit, a deploy mid-run --- and none of
     * those run cleanup code, so this has to be done by a *later* invocation.
     *
     * `ok = 0` with a single `aborted` error code, which `GET /api/runs` then
     * shows. No partial counts are recovered because none were written:
     * `summary_json` is only ever set by `finish`.
     */
    async sweepStale(startedBefore: number): Promise<number> {
      const summary = runSummarySchema.parse({ errors: [RUN_ABORTED_CODE] });
      const { changes } = await run(
        ctx.db
          .prepare(
            `UPDATE run_log SET finished_at = ?, ok = 0, summary_json = ?
              WHERE finished_at IS NULL AND started_at < ?`,
          )
          .bind(ctx.now(), JSON.stringify(summary), startedBefore),
      );
      if (changes > 0) ctx.log.warn("run.swept", { runs: changes, code: RUN_ABORTED_CODE });
      return changes;
    },

    async get(id: string): Promise<RunEntry | null> {
      const row = await one<RunLogRow>(
        ctx.db.prepare("SELECT * FROM run_log WHERE id = ?").bind(id),
      );
      return row === null ? null : decode(row);
    },

    async listRecent(options: { kind?: RunKind; limit?: number } = {}): Promise<RunEntry[]> {
      const where = options.kind === undefined ? "" : " WHERE kind = ?";
      const values: unknown[] = options.kind === undefined ? [] : [options.kind];
      const rows = await all<RunLogRow>(
        ctx.db
          .prepare(`SELECT * FROM run_log${where} ORDER BY started_at DESC, id DESC LIMIT ?`)
          .bind(...values, options.limit ?? 50),
      );
      return rows.map((row) => decode(row));
    },

    /** Per-kind health, for the overview panel. */
    async stats(sinceSeconds?: number): Promise<RunStats[]> {
      const rows = await all<{
        kind: RunKind;
        runs: number;
        failures: number;
        unfinished: number;
        last_started_at: number;
      }>(
        ctx.db
          .prepare(
            `SELECT kind,
                    COUNT(*) AS runs,
                    SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures,
                    SUM(CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END) AS unfinished,
                    MAX(started_at) AS last_started_at
               FROM run_log WHERE started_at >= ?
              GROUP BY kind ORDER BY kind`,
          )
          .bind(sinceSeconds ?? 0),
      );

      return Promise.all(
        rows.map(async (row) => {
          const last = await one<Pick<RunLogRow, "ok">>(
            ctx.db
              .prepare(
                "SELECT ok FROM run_log WHERE kind = ? ORDER BY started_at DESC, id DESC LIMIT 1",
              )
              .bind(row.kind),
          );
          // Two nulls collapse to one here: no last row, and a last row that is
          // still running. Both mean "no outcome yet".
          const lastOk = last?.ok ?? null;
          return {
            kind: row.kind,
            runs: row.runs,
            failures: row.failures,
            unfinished: row.unfinished,
            lastStartedAt: row.last_started_at,
            lastOk: lastOk === null ? null : lastOk === 1,
          };
        }),
      );
    },
  };
}
