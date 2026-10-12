/**
 * Sync runs, read out of the upload log.
 *
 * The phone syncs in runs: one start (the periodic job, the watchdog alarm,
 * the owner pressing Sync now), then a batch per page of what Health Connect
 * has changed, then a closing batch that carries only its state report. Each
 * batch says which run it is part of -- when the run began, by the phone's
 * clock, and what started it -- and `hc_ingest_log` keeps that beside the
 * batch's counts. A run is the batches that name the same start.
 *
 * So the log answers what the store cannot: whether a sync ran at all when it
 * found nothing new (a run of one closing batch), what set it off, and whether
 * it got to the end. A run that is cut off never sends its closing batch and
 * cannot say so; the next run says it for it (`prevRunEnd`).
 *
 * Pure, with no D1 in it: the repo reads the rows
 * (worker/src/db/repos/hc-status.ts) and the unit tests' in-memory store
 * groups its own with the same function.
 */

/** What grouping needs of one `hc_ingest_log` row. */
export interface RunLogRow {
  /** When the batch arrived here, unix seconds. */
  receivedAt: number;
  upserts: number;
  deletes: number;
  rejected: number;
  runTrigger: string | null;
  /** The start of the batch's run, epoch ms by the phone's clock; null from an app that does not say. */
  runStartedMs: number | null;
  /** The run before the batch's own, by its start, and how the batch says it ended. */
  prevRunStartedMs: number | null;
  prevRunEnd: string | null;
}

/** One sync run, as its uploads show it. */
export interface UploadRun {
  /** When the run began, epoch ms by the phone's clock. Null for a batch that names no run. */
  startedMs: number | null;
  /** When its last batch arrived here, unix seconds. */
  receivedAt: number;
  /** What started it: a stable code, or null when no batch of it said. */
  trigger: string | null;
  batches: number;
  upserts: number;
  deletes: number;
  /**
   * True when one of its batches is the closing report (nothing upserted,
   * deleted or rejected): the run reached its end. False when none is: it
   * stopped before reporting. Null for a batch that names no run.
   */
  closed: boolean | null;
  /** How a later batch says the run ended (`ok`, `interrupted`, an error code), or null. */
  ended: string | null;
}

interface Found {
  /** The newest `limit` runs among the rows, newest first. */
  runs: UploadRun[];
  /**
   * True when the rows reach past the last of them: a row of a run older than
   * every one returned was read. Until then the oldest run returned may have
   * batches further back than the rows go.
   */
  whole: boolean;
}

/**
 * Group log rows into runs. `rows` are a device's newest, newest first; the
 * runs come back in the order their newest batch arrived, newest first.
 *
 * A row that names no run (an app from before runs were reported) is a run of
 * its own: there is nothing to say which other batches it came with.
 */
export function newestRuns(rows: readonly RunLogRow[], limit: number): Found {
  const keyed = new Map<number, UploadRun>();
  const runs: UploadRun[] = [];
  // How each run ended, by its start, as the newest batch to speak of it said.
  const endings = new Map<number, string>();
  for (const row of rows) {
    noteEnding(endings, row);
    const known = row.runStartedMs === null ? undefined : keyed.get(row.runStartedMs);
    if (known === undefined) {
      const run = runOf(row);
      if (run.startedMs !== null) keyed.set(run.startedMs, run);
      runs.push(run);
    } else {
      addBatch(known, row);
    }
  }
  const newest = runs.slice(0, limit);
  for (const run of newest) {
    if (run.startedMs !== null) run.ended = endings.get(run.startedMs) ?? null;
  }
  return { runs: newest, whole: runs.length > limit };
}

/** True for a closing report: a batch with nothing upserted, deleted or rejected. */
function isClosing(row: RunLogRow): boolean {
  return row.upserts === 0 && row.deletes === 0 && row.rejected === 0;
}

/** Keep what a row says of the run before its own, unless a newer row already has. */
function noteEnding(endings: Map<number, string>, row: RunLogRow): void {
  const { prevRunStartedMs: started, prevRunEnd: end } = row;
  if (started !== null && end !== null && !endings.has(started)) endings.set(started, end);
}

/** The run a row begins: the newest batch of it, so its arrival is the run's. */
function runOf(row: RunLogRow): UploadRun {
  return {
    startedMs: row.runStartedMs,
    receivedAt: row.receivedAt,
    trigger: row.runTrigger,
    batches: 1,
    upserts: row.upserts,
    deletes: row.deletes,
    closed: row.runStartedMs === null ? null : isClosing(row),
    ended: null,
  };
}

/** Count an older batch of a run already begun. */
function addBatch(run: UploadRun, row: RunLogRow): void {
  run.batches += 1;
  run.upserts += row.upserts;
  run.deletes += row.deletes;
  run.trigger ??= row.runTrigger;
  run.closed = run.closed === true || isClosing(row);
}
