/**
 * Applying queued Health Connect batches to the store, one bounded slice at a
 * time. `runHcSlice` is the whole of what the ingest runner's alarm does
 * (worker/src/hc/runner.ts); it is a plain function of a `Ctx` so the tests
 * drive it without a Durable Object.
 *
 * ### One slice
 *
 * Take the device's oldest queued batch -- strictly oldest, because a delete
 * that follows an upsert has to land after it -- and work through it in three
 * phases: its deletes, its upserts one destination chunk at a time, then the
 * bookkeeping that closes it. When the queue is empty, rebuild what the
 * batches marked (worker/src/hc/store/rebuild.ts). Stop when the budget is
 * spent and say whether anything is left.
 *
 * ### Why a slice that dies is simply run again
 *
 * A batch is far larger than one invocation's D1 budget, so it spans slices,
 * and any of them may be cut off. Nothing here needs that not to happen:
 *
 *   - Each chunk is written with its hour rollup, its heart-rate minutes, its
 *     index rows and its dirty marks in ONE `db.batch`, which D1 runs as a
 *     transaction. A chunk and the index never disagree. (The mark of a day
 *     this batch has already marked is not written again: see `BatchRun`.)
 *     Several chunks share one `db.batch` where they can (`Buffered`): a
 *     round trip to D1 costs far more than the statements in it, and a batch
 *     of sparse records is one chunk a record. The cursor moves past a chunk
 *     only when the transaction holding it has committed.
 *   - A write is by record id and keeps the copy with the greater
 *     `lastModified`, so applying the same records again changes nothing; and
 *     an unchanged chunk is recognised by its digest and not rewritten.
 *   - The batch is deleted from the queue last. Until then it is the truth
 *     about what still has to happen.
 *
 * The cursor (which batch, which phase, how far) only saves re-reading chunks
 * that are already right. It is kept by the caller between slices; a lost or
 * stale cursor means the batch is replayed from its start, to the same result.
 *
 * ### Failing, and not failing
 *
 * A batch that cannot be read -- not gzip, not JSON, not a batch, sealed with
 * another key, a part missing -- will not become readable by waiting, so it is
 * marked `failed` with a stable code and parked: one bad batch must not hold up
 * everything the phone sends after it. Anything else (D1 unavailable, a
 * timeout) is thrown to the caller, which retries -- and counts the attempt
 * before each slice (`beginAttempt`). A batch that keeps making slices throw is given up on
 * after `MAX_BATCH_FAILURES` of them and parked as failed too: the queue is
 * strictly ordered, so a failure this code wrongly takes for a passing one
 * would otherwise hold every later batch for ever.
 *
 * Logs carry this app's device id, batch ids, counts, durations and error
 * codes. Never a record id, a value or an origin app's package name.
 */

import { blindHcOrigin, blindHcRecordId, blinderFor } from "../db/blind.ts";
import { batch as runBatch, one, chunk as pages } from "../db/client.ts";
import { makeHcIngestQueueRepo } from "../db/repos/hc-ingest-queue.ts";
import { errorFields } from "../lib/log.ts";
import { openParkedAlert, resolveParkedAlert } from "../sync/alerts.ts";

import { unpackJson } from "./codec.ts";
import { hrHoursTouched } from "./rollup/hr-minute.ts";
import { DEFAULT_SLICE_BUDGET, Meter } from "./store/budget.ts";
import { chunkStatements, hrMinuteStatement, hrSpillIn, readChunks } from "./store/chunks.ts";
import { dirtyBacklog, markSessionsStatement, markStatements } from "./store/dirty.ts";
import {
  HOUR_MS,
  TYPE_EXERCISE_SESSION,
  TYPE_HEART_RATE,
  TYPE_SLEEP_SESSION,
  chunkExtent,
  dayMarkKey,
  groupUpserts,
  hrMarkKey,
  keyId,
  listOf,
  mergeIntoChunk,
  removeFromChunk,
  sameKey,
  samplesInInterval,
} from "./store/keys.ts";
import {
  EXERCISE_CONTEXT_TYPES,
  SLEEP_CONTEXT_MARGIN_MS,
  SLEEP_CONTEXT_TYPES,
  parkFirstMark,
  rebuildSlice,
} from "./store/rebuild.ts";
import {
  indexUpsertStatement,
  lookupIndex,
  tombstoneStatement,
  unknownTombstoneStatement,
} from "./store/record-index.ts";
import { permanentStoreCode } from "./store/sealed.ts";
import { recountStatement, reportStatement } from "./store/sync-state.ts";
import { parseBatch } from "./wire.ts";

import type { Blinder } from "../db/blind.ts";
import type { Ctx } from "../db/client.ts";
import type { SliceBudget } from "./store/budget.ts";
import type { StoredChunk } from "./store/chunks.ts";
import type { DirtyMark } from "./store/dirty.ts";
import type { ChunkKey, UpsertGroup } from "./store/keys.ts";
import type { IndexEntry } from "./store/record-index.ts";
import type { HcRecord, ParsedBatch } from "./wire.ts";
import type { QueuedBatch } from "../db/repos/hc-ingest-queue.ts";
import type { SyncDeps } from "../sync/deps.ts";

/** Where the apply of one batch has got to. Counts and positions only. */
interface ApplyCursor {
  batchId: string;
  phase: "deletes" | "upserts" | "finish";
  /** Deletes done (an index into the batch's ids), or upsert groups done. */
  offset: number;
  /** Upserts that are now the stored copy. */
  applied: number;
  /** Records taken out of the store by this batch's deletes. */
  removed: number;
  /** Record types that lost a record, so their counts are recomputed at the end. */
  shrunk: string[];
  /** Heart-rate samples timed outside their own record: stored, left out of the minute rows. */
  outOfInterval: number;
  /** Wall clock spent on the batch so far. */
  ms: number;
}

/** Everything the runner keeps between slices. Safe to lose: see the module comment. */
export interface HcRunnerState {
  cursor: ApplyCursor | null;
  /**
   * The digest of the zone every day rollup is known to be built for, or null
   * when that has to be checked against the table.
   */
  tzDigest: string | null;
}

export const EMPTY_RUNNER_STATE: HcRunnerState = { cursor: null, tzDigest: null };

export interface SliceResult {
  state: HcRunnerState;
  /** True when there is more to do and the caller should run another slice. */
  more: boolean;
  /** False when the slice finished nothing at all: the runner's stuck detector. */
  progressed: boolean;
}

/** Why a batch was given up on. Stable strings: they are stored and shown. */
type ApplyFailureCode =
  | "batch_unreadable"
  | "batch_invalid"
  | "batch_mismatch"
  | "queue_parts_missing"
  | "crypto"
  | "payload_too_large"
  | "payload_malformed"
  | "chunk_malformed"
  | "apply_gave_up";

/**
 * How many slices in a row may throw on the same head batch before it is
 * set aside as failed. With the runner's backoff (five seconds, doubling) the
 * eight attempts span about ten minutes, which outlasts a passing D1 error but
 * not a bug: a failure this code does not recognise as permanent must not
 * block a device's queue, which is strictly ordered, for ever. Giving up loses
 * nothing: the batch is parked, not deleted, and can be queued again.
 */
export const MAX_BATCH_FAILURES = 8;

/** How long an `applied` row of `hc_ingest_log` is kept, and rows deleted per statement. */
const LOG_RETENTION_SECONDS = 30 * 86_400;
const LOG_PRUNE_SLICE = 500;

/**
 * The longest stretch of one record that is used to find the sleep nights and
 * exercise sessions depending on it. A record claiming to run for months is
 * stored whole like any other, but it must not mark every stored night and
 * session for rebuilding each time it is touched; what lies beyond this much
 * of it keeps its summary until its own data changes.
 */
const DEPENDANT_SPAN_MAX_MS = 48 * HOUR_MS;

/** Deletes looked up per query, and upsert groups per index lookup. */
const DELETE_PAGE = 500;
const GROUP_PAGE = 20;
/** Chunks read ahead in one statement: a page of groups, or as many of a page of deletes. */
const READ_AHEAD = GROUP_PAGE;
/** Records whose index rows one lookup page fetches before a page is cut. */
const GROUP_PAGE_RECORDS = 3000;
/**
 * Statements one chunk rewrite may issue, as an upper estimate: the read, the
 * chunk and its rollup, the heart-rate spill read and row, the index rows, the
 * marks, and two statements marking the summaries that depend on it.
 */
const CHUNK_COST = 10;
/** Head of queue, zone, status, and the closing statements of a batch. */
const BATCH_OVERHEAD = 8;
/**
 * Statements one `db.batch` of chunk writes carries before it is sent. The
 * limit is checked between chunks, never inside one: a chunk's statements are
 * one transaction whatever their number, so a chunk with more than this many
 * (one that outgrew a row) is sent alone.
 */
const COMMIT_STATEMENTS = 50;

/**
 * Chunk writes built and not yet sent: the statements of one `db.batch`.
 *
 * In production every `db.batch` is a network round trip from the runner to
 * D1, and it costs about the same whether it carries one chunk or twenty. So
 * the units of a page (a group of upserts, a slot of deletes) are collected
 * here and committed together -- still one transaction, only a larger one.
 *
 * Three rules keep that equal to committing each unit by itself:
 *
 *   - Nothing is built from the database while a write it would read is still
 *     in here. `makeRoom` sends the buffer first when a unit touches a chunk a
 *     buffered unit also touches (a record moving between two groups of one
 *     page), or reads heart-rate spill while a heart-rate chunk is buffered
 *     (the minute row of an hour is built from the hour before it).
 *   - What a unit counts -- the cursor's offset, `applied`, `removed` -- is
 *     counted by `settle`, which runs only after the commit. A slice that
 *     stops, or dies, never carries a cursor past work that is not durable.
 *   - The buffer is sent before a slice yields, at the end of every page, and
 *     before a batch is closed or set aside. A buffer that is lost instead (a
 *     slice that threw) is work the cursor never counted: it is done again.
 *
 * The units keep their edges in here, because sharing a commit is only ever a
 * saving. A `db.batch` D1 will not take -- the chunks of a page can be large,
 * and a request has a size -- is sent again a unit at a time, which is exactly
 * what was done before any of this (`flush`).
 */
interface Buffered {
  /** The units, in the order they were built. */
  units: BufferedUnit[];
  /** Statements in all of them. */
  statements: number;
  /** Every chunk a buffered unit reads or writes, by `keyId`. */
  chunks: Set<string>;
  /** True when one of them is a heart-rate chunk. */
  heartRate: boolean;
  /** Day marks among the statements, whichever unit's. */
  days: Set<string>;
}

/** One unit in the buffer: what is committed, and what follows from that. */
interface BufferedUnit {
  statements: D1PreparedStatement[];
  /** Day marks among its statements: `BatchRun.marked` once they are committed. */
  days: string[];
  /** What the unit counts once it is durable. */
  settle: () => void;
}

function emptyBuffer(): Buffered {
  return { units: [], statements: 0, chunks: new Set(), heartRate: false, days: new Set() };
}

/** One batch being applied in one slice: what every step needs. */
interface BatchRun {
  ctx: Ctx;
  deviceId: string;
  blinder: Blinder;
  meter: Meter;
  cursor: ApplyCursor;
  /** The meter's reading when this slice took the batch up. */
  startedMs: number;
  /** The alert channel's seam: see `runHcSlice`. */
  deps: SyncDeps | undefined;
  /**
   * The `day` marks this batch is known to have written, by key: `Head.marked`.
   * A day is two dozen chunks, and each of them would write the same mark.
   *
   * Leaving one out is safe because nothing can have cleared it in between.
   * Marks are cleared only by the rebuild, and the rebuild runs only when no
   * batch is part way through: after a batch has been applied, or with the
   * queue empty (`workSlice`). The set lives no longer than the batch is the
   * head -- it hangs off the parsed head, which is dropped when the batch is
   * applied, set aside, or a slice throws -- and a slice that starts without
   * it simply writes the marks again.
   */
  marked: Set<string>;
  /** Day marks in the statements of the unit now being built: the buffer's once it is queued. */
  pending: string[];
  /** Units built and not yet committed: see `Buffered`. */
  buffer: Buffered;
}

/** The stable code for a failure that retrying cannot fix, or null. */
function permanentCode(error: unknown): ApplyFailureCode | null {
  const stored = permanentStoreCode(error);
  if (stored !== null) return stored as ApplyFailureCode;
  // The queue repo's own check: a batch whose parts are not all there.
  return error instanceof Error && error.message === "queued batch is missing parts"
    ? "queue_parts_missing"
    : null;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Rewriting one chunk, with everything derived from it.
// ---------------------------------------------------------------------------

/**
 * What a change to a chunk marks for rebuilding: the day rollups of its hour, the later heart-rate hours a series ran into, and the
 * summary of each touched sleep or exercise session.
 */
async function marksFor(
  job: BatchRun,
  key: ChunkKey,
  touched: readonly HcRecord[],
): Promise<DirtyMark[]> {
  // Every record of a chunk starts in the chunk's hour, so one mark covers
  // them. It names the UTC day of that hour, not a calendar day: which days
  // those are is the rebuild's to decide, in the zone configured when it runs.
  const marks: DirtyMark[] = [];
  const day = dayMarkKey(key.type, key.hourUtc);
  // Not again, if this batch has written it: see `BatchRun.marked`.
  const written = job.marked.has(day) || job.buffer.days.has(day) || job.pending.includes(day);
  if (!written && touched.length > 0) {
    marks.push(["day", day]);
    job.pending.push(day);
  }

  if (key.type === TYPE_HEART_RATE) {
    const timed = samplesInInterval(touched).records;
    const laterHours = hrHoursTouched(timed).filter((hour) => hour !== key.hourUtc);
    for (const hour of laterHours) marks.push(["hr", hrMarkKey(key.originHash, hour)]);
  }
  if (key.type === TYPE_SLEEP_SESSION || key.type === TYPE_EXERCISE_SESSION) {
    const kind = key.type === TYPE_SLEEP_SESSION ? "sleep" : "exercise";
    const ids = unique(touched.map((record) => record.id));
    for (const id of ids) marks.push([kind, await blindHcRecordId(job.blinder, job.deviceId, id)]);
  }
  return marks;
}

/**
 * Statements marking the stored nights and sessions whose summaries read the
 * touched records: heart rate that arrives after its night did, a second
 * exercise session that turns out to overlap the first.
 */
function dependantStatements(
  job: BatchRun,
  type: string,
  touched: readonly HcRecord[],
): D1PreparedStatement[] {
  if (touched.length === 0) return [];
  const { ctx, deviceId } = job;
  const extent = chunkExtent(touched);
  const { minStartMs } = extent;
  // Clamped: see `DEPENDANT_SPAN_MAX_MS`.
  const maxEndMs = Math.min(extent.maxEndMs, minStartMs + DEPENDANT_SPAN_MAX_MS);
  const statements: D1PreparedStatement[] = [];
  if (SLEEP_CONTEXT_TYPES.has(type)) {
    const from = minStartMs - SLEEP_CONTEXT_MARGIN_MS;
    const to = maxEndMs + SLEEP_CONTEXT_MARGIN_MS;
    statements.push(markSessionsStatement(ctx, deviceId, "sleep", from, to));
  }
  if (EXERCISE_CONTEXT_TYPES.has(type)) {
    statements.push(markSessionsStatement(ctx, deviceId, "exercise", minStartMs, maxEndMs));
  }
  return statements;
}

/**
 * The statements that take the chunk at `key` from `before` to `records`, and
 * keep what depends on it in step. `touched` is every record version that was
 * added, replaced or removed -- old copies and new -- which is what decides
 * which days, sessions and heart-rate hours have to be rebuilt.
 *
 * Empty when the chunk would not change.
 */
async function rewriteChunk(
  job: BatchRun,
  key: ChunkKey,
  origin: string,
  before: StoredChunk | undefined,
  records: readonly HcRecord[],
  touched: readonly HcRecord[],
): Promise<D1PreparedStatement[]> {
  const { ctx, deviceId, meter } = job;
  const statements = await chunkStatements(ctx, deviceId, key, origin, before, records);
  if (statements.length === 0) return [];

  if (key.type === TYPE_HEART_RATE) {
    // The minute row of the chunk's own hour is written now, from this chunk
    // and any earlier series running into it. A series that runs past the hour
    // changes later rows too; `marksFor` marks those.
    const spill = await hrSpillIn(ctx, deviceId, key.originHash, key.hourUtc, meter);
    const inHour = [...spill, ...records];
    statements.push(await hrMinuteStatement(ctx, deviceId, key.originHash, key.hourUtc, inHour));
  }
  const marks = await marksFor(job, key, touched);
  statements.push(
    ...markStatements(ctx, deviceId, marks),
    ...dependantStatements(job, key.type, touched),
  );
  return statements;
}

async function commit(job: BatchRun, statements: D1PreparedStatement[]): Promise<void> {
  if (statements.length === 0) return;
  job.meter.spend(statements.length);
  await runBatch(job.ctx.db, statements);
}

/** Count a unit that is now durable: its day marks are `marked`, and its `settle` moves the cursor. */
function settled(job: BatchRun, unit: BufferedUnit): void {
  for (const day of unit.days) job.marked.add(day);
  unit.settle();
}

/**
 * Commit everything buffered, in one transaction, and only then count it.
 *
 * If D1 will not take the units together, they are committed one at a time, in
 * order, each counted as it lands: what applying a batch did before units
 * shared a commit. A request can be refused for its size alone, and a refusal
 * that came back every time would otherwise fail the slice identically until
 * the batch was given up on. An error from a unit's own commit is thrown, as
 * it always was.
 *
 * Sending them again is safe whatever became of the first attempt. A `db.batch`
 * is one transaction, so either none of it was applied, or all of it was and
 * only the reply was lost -- and every statement here writes what a row is to
 * be, not a change to it, so writing it twice leaves what writing it once
 * does. The counts do not depend on which: a unit's `settle` adds what was
 * worked out when the unit was built, once, after the commit that covers it.
 */
async function flush(job: BatchRun): Promise<void> {
  const { units } = job.buffer;
  if (units.length === 0) return;
  // Emptied first: if a commit throws, what was buffered and not yet counted
  // is not known to be durable, and must not be counted by a later flush.
  job.buffer = emptyBuffer();
  const { ctx, deviceId, meter } = job;
  const statements = units.flatMap((unit) => unit.statements);
  try {
    // Counted when they were queued (`defer`), so the budget saw them coming.
    await runBatch(ctx.db, statements);
  } catch (error) {
    // One unit is already as small as a commit gets.
    if (units.length === 1) throw error;
    ctx.log.warn("hc.commit_split", {
      deviceId,
      units: units.length,
      statements: statements.length,
      ...errorFields(error),
    });
    for (const unit of units) {
      meter.spend(unit.statements.length);
      await runBatch(ctx.db, unit.statements);
      settled(job, unit);
    }
    return;
  }
  for (const unit of units) settled(job, unit);
}

/**
 * Send the buffer first if building a unit over `touching` would read
 * something a buffered write is about to change: see `Buffered`.
 */
async function makeRoom(job: BatchRun, touching: readonly ChunkKey[]): Promise<void> {
  const { buffer } = job;
  const heartRate = touching.some((key) => key.type === TYPE_HEART_RATE);
  const shared = touching.some((key) => buffer.chunks.has(keyId(key)));
  if (shared || (heartRate && buffer.heartRate)) await flush(job);
}

/** One unit of work, built: what `defer` queues. */
interface Unit {
  statements: D1PreparedStatement[];
  /** Every chunk it read or writes. */
  chunks: readonly ChunkKey[];
  /** What to count once the statements are durable. */
  settle: () => void;
}

/**
 * Queue a unit's statements to be committed with its neighbours'. The buffer
 * is sent first when the unit would take it past `COMMIT_STATEMENTS`, so a
 * `db.batch` is cut between units and never inside one.
 */
async function defer(job: BatchRun, unit: Unit): Promise<void> {
  const queued = job.buffer.statements;
  if (queued > 0 && queued + unit.statements.length > COMMIT_STATEMENTS) await flush(job);
  const { buffer } = job;
  job.meter.spend(unit.statements.length);
  buffer.units.push({ statements: unit.statements, days: job.pending, settle: unit.settle });
  buffer.statements += unit.statements.length;
  for (const key of unit.chunks) {
    buffer.chunks.add(keyId(key));
    if (key.type === TYPE_HEART_RATE) buffer.heartRate = true;
  }
  for (const day of job.pending) buffer.days.add(day);
  job.pending = [];
}

/**
 * Chunks read ahead of the groups that need them, a page in one statement, so
 * that applying a page is not a read per chunk.
 *
 * A chunk is only ever taken from here while it is `fresh`: read, and not
 * written since. One group's transaction can rewrite a chunk a later group of
 * the same page also needs -- a record that moved hours leaves the chunk it
 * was in -- so everything a transaction may have touched is forgotten, and is
 * read again by whoever asks next.
 */
class HeldChunks {
  private readonly chunks = new Map<string, StoredChunk>();
  private readonly fresh = new Set<string>();

  constructor(private readonly job: BatchRun) {}

  /** The chunks at `keys` that exist, by `keyId`: from memory where fresh, read where not. */
  async read(keys: readonly ChunkKey[]): Promise<Map<string, StoredChunk>> {
    const { ctx, deviceId, meter } = this.job;
    const missing = new Map<string, ChunkKey>();
    for (const key of keys) if (!this.fresh.has(keyId(key))) missing.set(keyId(key), key);
    if (missing.size > 0) {
      const read = await readChunks(ctx, deviceId, listOf(missing.values()), meter);
      for (const id of missing.keys()) {
        const stored = read.get(id);
        if (stored === undefined) this.chunks.delete(id);
        else this.chunks.set(id, stored);
        this.fresh.add(id);
      }
    }
    const found = new Map<string, StoredChunk>();
    for (const key of keys) {
      const stored = this.chunks.get(keyId(key));
      if (stored !== undefined) found.set(keyId(key), stored);
    }
    return found;
  }

  /** These chunks may just have been written: what is held of them is no longer the truth. */
  forget(keys: readonly ChunkKey[]): void {
    for (const key of keys) {
      this.fresh.delete(keyId(key));
      this.chunks.delete(keyId(key));
    }
  }
}

/** The `settle` of a unit that moves no count: a tombstone for an id that was never stored. */
function countNothing(): void {
  // Nothing was removed, and the page's offset is the caller's to move.
}

/** Note a type whose stored count may have gone down. A tombstone of an id never seen has none. */
function noteShrunk(cursor: ApplyCursor, type: string): void {
  if (type !== "" && !cursor.shrunk.includes(type)) cursor.shrunk.push(type);
}

/** Blind a list of record ids, keeping which blind is whose. */
async function blindIds(job: BatchRun, ids: readonly string[]): Promise<Map<string, string>> {
  const blinds = new Map<string, string>();
  for (const id of ids) blinds.set(id, await blindHcRecordId(job.blinder, job.deviceId, id));
  return blinds;
}

// ---------------------------------------------------------------------------
// Phase 1: deletes.
// ---------------------------------------------------------------------------

/** The ids of one chunk that a page of deletes removes. */
interface DeleteSlot {
  key: ChunkKey;
  ids: Set<string>;
  blinds: string[];
}

/**
 * A page's live ids by the chunk that holds them. An id already tombstoned (by
 * an earlier batch, or by this page on a slice that was cut off) is done, and
 * one the index has never seen has no chunk.
 */
function slotsOf(
  blinds: ReadonlyMap<string, string>,
  index: ReadonlyMap<string, IndexEntry>,
): DeleteSlot[] {
  const byChunk = new Map<string, DeleteSlot>();
  for (const [id, blind] of blinds) {
    const entry = index.get(blind);
    if (entry === undefined || entry.deleted) continue;
    const slot = byChunk.get(keyId(entry.key)) ?? { key: entry.key, ids: new Set(), blinds: [] };
    slot.ids.add(id);
    slot.blinds.push(blind);
    byChunk.set(keyId(entry.key), slot);
  }
  return listOf(byChunk.values());
}

/**
 * Take one chunk's deleted records out and tombstone their ids, in one
 * transaction (shared with its neighbours: see `Buffered`). `stored` is the
 * chunk as it is now, if there is one.
 */
async function deleteSlot(
  job: BatchRun,
  slot: DeleteSlot,
  stored: StoredChunk | undefined,
): Promise<void> {
  const { ctx, deviceId, cursor, meter } = job;
  // A slot rewrites its own chunk and no other, so `stored` is still the truth
  // after this; what it guards is the heart-rate spill read.
  await makeRoom(job, [slot.key]);
  const statements: D1PreparedStatement[] = [];
  if (stored !== undefined) {
    const { records, removed } = removeFromChunk(stored.records, slot.ids);
    const rewrite = await rewriteChunk(job, slot.key, stored.origin, stored, records, removed);
    statements.push(...rewrite);
  }
  statements.push(tombstoneStatement(ctx, deviceId, slot.blinds));
  // Noted at once, durable or not: a type noted too often is only recounted.
  noteShrunk(cursor, slot.key.type);
  const removed = slot.blinds.length;
  await defer(job, {
    statements,
    chunks: [slot.key],
    settle: () => {
      cursor.removed += removed;
    },
  });
  // Built, and from here either committed or thrown away with the slice: every
  // way out of a slice that does not throw sends the buffer first.
  meter.done();
}

/**
 * Apply one page of deletes. False when the budget ran out part way: the page
 * is looked up again on the next slice, and what is already tombstoned is
 * skipped.
 */
async function deletePage(job: BatchRun, page: readonly string[]): Promise<boolean> {
  const { ctx, deviceId, meter } = job;
  const blinds = await blindIds(job, page);
  const every = listOf(blinds.values());
  const index = await lookupIndex(ctx, deviceId, every, meter);
  // Every type the page names is recounted when the batch closes, tombstoned
  // already or not: a slice that died after the delete was committed left its
  // note of the type behind with it, and the replay only sees the tombstone.
  for (const entry of index.values()) noteShrunk(job.cursor, entry.key.type);

  const unknown = every.filter((blind) => !index.has(blind));
  if (unknown.length > 0) {
    const statements = [unknownTombstoneStatement(ctx, deviceId, unknown)];
    await defer(job, { statements, chunks: [], settle: countNothing });
  }

  // A slot's transaction rewrites its own chunk and no other, and a page names
  // each chunk once, so the chunks of several slots can be read together
  // before any of them is written.
  const paged = pages(slotsOf(blinds, index), READ_AHEAD);
  for (const slots of paged) {
    if (!meter.mayStart(CHUNK_COST)) return yieldPage(job);
    const keys = slots.map((slot) => slot.key);
    const chunks = await readChunks(ctx, deviceId, keys, meter);
    for (const slot of slots) {
      if (!meter.mayStart(CHUNK_COST)) return yieldPage(job);
      await deleteSlot(job, slot, chunks.get(keyId(slot.key)));
    }
  }
  // Before the caller counts the page as done, and before the next page looks
  // anything up.
  await flush(job);
  return true;
}

/** Stop part way through a page: what was built is committed, then the slice yields. */
async function yieldPage(job: BatchRun): Promise<false> {
  await flush(job);
  return false;
}

/** True when every delete of the batch has been applied. */
async function applyDeletes(job: BatchRun, ids: readonly string[]): Promise<boolean> {
  const { meter, cursor } = job;
  while (cursor.offset < ids.length) {
    if (!meter.mayStart(CHUNK_COST + 2)) return false;
    const page = ids.slice(cursor.offset, cursor.offset + DELETE_PAGE);
    if (!(await deletePage(job, page))) return false;
    cursor.offset += page.length;
    meter.done();
  }
  return true;
}

// ---------------------------------------------------------------------------
// Phase 2: upserts, one destination chunk at a time.
// ---------------------------------------------------------------------------

/** The next few groups: bounded in groups and, loosely, in records. */
function nextPage(groups: readonly UpsertGroup[], from: number): UpsertGroup[] {
  const page: UpsertGroup[] = [];
  let records = 0;
  const candidates = groups.slice(from, from + GROUP_PAGE);
  for (const group of candidates) {
    if (page.length > 0 && records + group.records.length > GROUP_PAGE_RECORDS) break;
    page.push(group);
    records += group.records.length;
  }
  return page;
}

/** One group, with what the index says about each of its records. */
interface GroupJob {
  group: UpsertGroup;
  key: ChunkKey;
  /** The index entry of a record of the group, if it has one. */
  entryOf: (record: HcRecord) => IndexEntry | undefined;
  blindOf: (record: HcRecord) => string;
}

/** The chunk a record is leaving: the one the index names, when it is not the destination. */
function movedFrom(work: GroupJob, record: HcRecord): ChunkKey | null {
  const entry = work.entryOf(record);
  return entry === undefined || entry.deleted || sameKey(entry.key, work.key) ? null : entry.key;
}

/** The copy of a record held in the chunk it is leaving, if there is one. */
function heldCopy(
  chunks: ReadonlyMap<string, StoredChunk>,
  from: ChunkKey | null,
  record: HcRecord,
): HcRecord | undefined {
  return from === null
    ? undefined
    : chunks.get(keyId(from))?.records.find((held) => held.id === record.id);
}

/**
 * Which of a group's records go into its chunk, and which stored copies in
 * other chunks they displace (an edit moved the record's start hour, or its
 * type or origin).
 */
function planGroup(
  work: GroupJob,
  chunks: ReadonlyMap<string, StoredChunk>,
): { incoming: HcRecord[]; leaving: Map<string, Set<string>> } {
  const incoming: HcRecord[] = [];
  const leaving = new Map<string, Set<string>>();
  for (const record of work.group.records) {
    // A tombstoned id is never written again: Health Connect does not reuse one.
    if (work.entryOf(record)?.deleted === true) continue;
    const from = movedFrom(work, record);
    const old = heldCopy(chunks, from, record);
    // The stored copy is newer: this upsert is the stale one, and stays out.
    if (old !== undefined && old.lastModified > record.lastModified) continue;
    if (from !== null && old !== undefined) {
      const ids = leaving.get(keyId(from)) ?? new Set<string>();
      ids.add(record.id);
      leaving.set(keyId(from), ids);
    }
    incoming.push(record);
  }
  return { incoming, leaving };
}

/**
 * The statements that take displaced copies out of the chunks they are
 * leaving. They are run in the same transaction as the destination's write and
 * the index rows that follow the record there: a record that moves is in one
 * chunk before and one chunk after, and never in neither or both -- whatever
 * fails, and whatever becomes of the batch afterwards.
 */
async function sourceStatements(
  job: BatchRun,
  chunks: ReadonlyMap<string, StoredChunk>,
  leaving: ReadonlyMap<string, Set<string>>,
): Promise<D1PreparedStatement[]> {
  const statements: D1PreparedStatement[] = [];
  for (const [id, ids] of leaving) {
    const source = chunks.get(id);
    if (source === undefined) continue;
    const { records, removed } = removeFromChunk(source.records, ids);
    const { key, origin } = source;
    statements.push(...(await rewriteChunk(job, key, origin, source, records, removed)));
  }
  return statements;
}

/** The chunks a group's records are leaving, by `keyId`: see `movedFrom`. */
function sourcesOf(work: GroupJob): Map<string, ChunkKey> {
  const sources = new Map<string, ChunkKey>();
  for (const record of work.group.records) {
    const from = movedFrom(work, record);
    if (from !== null) sources.set(keyId(from), from);
  }
  return sources;
}

/** Every chunk a group reads, and may write: its own, and the ones its records are leaving. */
function chunksOf(work: GroupJob): ChunkKey[] {
  return [work.key, ...sourcesOf(work).values()];
}

/**
 * Apply one group: its chunk, the chunks its records left, and the index, in
 * one transaction (shared with its neighbours: see `Buffered`).
 */
async function applyGroup(job: BatchRun, work: GroupJob, held: HeldChunks): Promise<void> {
  const { ctx, deviceId, cursor, meter } = job;
  const { group, key } = work;
  for (const record of group.records) {
    const entry = work.entryOf(record);
    // Anywhere else the index has seen this id -- live or tombstoned -- is a
    // type whose count this batch may have lowered, on this slice or on one
    // that died after doing it. See `deletePage`.
    if (entry !== undefined && !sameKey(entry.key, key)) noteShrunk(cursor, entry.key.type);
  }
  const touching = chunksOf(work);
  // Before anything is read: a buffered write to one of these chunks has to be
  // in the table first. (`held` forgot them when that write was built.)
  await makeRoom(job, touching);
  const chunks = await held.read(touching);
  const { incoming, leaving } = planGroup(work, chunks);
  const moved = await sourceStatements(job, chunks, leaving);

  const target = chunks.get(keyId(key));
  const merged = mergeIntoChunk(target?.records ?? [], incoming);
  const touched = [...merged.changed, ...merged.replaced];
  const statements = [
    ...moved,
    ...(await rewriteChunk(job, key, group.origin, target, merged.records, touched)),
  ];
  // Index rows for what is new here or has just arrived from another chunk.
  const unindexed = merged.accepted
    .filter((record) => {
      const entry = work.entryOf(record);
      return entry === undefined || !sameKey(entry.key, key);
    })
    .map((record) => work.blindOf(record));
  if (unindexed.length > 0) {
    statements.push(indexUpsertStatement(ctx, deviceId, key, unindexed));
  }
  // Forgotten before the write, not after: if it fails part way, what is held
  // must not be taken for what is stored.
  held.forget(touching);
  const accepted = merged.accepted.length;
  const outOfInterval =
    key.type === TYPE_HEART_RATE ? samplesInInterval(merged.accepted).outOfInterval : 0;
  await defer(job, {
    statements,
    chunks: touching,
    settle: () => {
      cursor.applied += accepted;
      cursor.outOfInterval += outOfInterval;
      cursor.offset += 1;
    },
  });
  // See `deleteSlot`: a unit that is built is as good as done for the budget.
  meter.done();
}

/** True when every upsert group of the batch has been applied. */
async function applyUpserts(job: BatchRun, groups: readonly UpsertGroup[]): Promise<boolean> {
  const { ctx, deviceId, meter, cursor } = job;
  const originHashes = new Map<string, string>();
  const originHashOf = async (origin: string): Promise<string> => {
    const known = originHashes.get(origin);
    if (known !== undefined) return known;
    const hash = await blindHcOrigin(job.blinder, deviceId, origin);
    originHashes.set(origin, hash);
    return hash;
  };

  // Where the building has got to. The cursor follows it a commit behind.
  let next = cursor.offset;
  while (next < groups.length) {
    if (!meter.mayStart(CHUNK_COST + 1)) return false;
    const page = nextPage(groups, next);
    const ids = page.flatMap((group) => group.records.map((record) => record.id));
    const blinds = await blindIds(job, ids);
    const blindOf = (record: HcRecord): string => blinds.get(record.id) ?? "";
    const index = await lookupIndex(ctx, deviceId, listOf(blinds.values()), meter);
    const entryOf = (record: HcRecord): IndexEntry | undefined => index.get(blindOf(record));

    const jobs: GroupJob[] = [];
    for (const group of page) {
      const originHash = await originHashOf(group.origin);
      const key: ChunkKey = { type: group.type, originHash, hourUtc: group.hourUtc };
      jobs.push({ group, key, entryOf, blindOf });
    }
    // Every chunk the page will read, in one statement (a second only when
    // records are moving between chunks): see `HeldChunks`.
    const held = new HeldChunks(job);
    await held.read(jobs.flatMap((work) => chunksOf(work)));
    for (const work of jobs) {
      if (!meter.mayStart(CHUNK_COST)) return yieldPage(job);
      await applyGroup(job, work, held);
      next += 1;
    }
    // A page is durable before the next one is looked up: its index rows and
    // chunks are what that lookup reads.
    await flush(job);
  }
  return true;
}

// ---------------------------------------------------------------------------
// One batch.
// ---------------------------------------------------------------------------

/** The head batch, read, opened and parsed. Opaque to callers. */
interface Head {
  queued: QueuedBatch;
  batch: ParsedBatch;
  /** The `day` marks the apply of this batch has written so far: see `BatchRun.marked`. */
  marked: Set<string>;
}

/**
 * Where a caller that lives across slices (the runner's Durable Object
 * instance) keeps the parsed head batch, so the next slice does not open,
 * decompress, validate and regroup the same megabytes again. Memory only, and
 * only a saving: a slice given no cache, or an empty one, reads the queue.
 */
export interface HeadCache {
  head: Head | null;
}

/** Which batch is at the head of a device's queue, without opening it. */
async function headBatchId(ctx: Ctx, deviceId: string): Promise<string | null> {
  const row = await one<{ batch_id: string }>(
    ctx.db
      .prepare(
        `SELECT batch_id FROM hc_ingest_queue
          WHERE device_id = ? AND parked_at IS NULL ORDER BY seq LIMIT 1`,
      )
      .bind(deviceId),
  );
  return row?.batch_id ?? null;
}

/**
 * Set aside a batch that cannot be applied: record why, and park it so the
 * batches behind it are not held up.
 *
 * Parked, never deleted. The phone was told the batch was accepted and has
 * moved on, so the queued body is the only copy of its records; it stays in
 * `hc_ingest_queue` until the cause is fixed and the batch is queued again
 * (`unpark`), or the device is wiped. Applying it late is safe: an upsert only
 * replaces an older `lastModified`, and a tombstoned id is never written.
 */
async function failBatch(
  ctx: Ctx,
  deviceId: string,
  batchId: string,
  errorCode: ApplyFailureCode,
  cursor: ApplyCursor | null,
  deps: SyncDeps | undefined,
): Promise<void> {
  const queue = makeHcIngestQueueRepo(ctx);
  await queue.recordOutcome(deviceId, batchId, {
    status: "failed",
    errorCode,
    ...(cursor !== null && {
      applied: cursor.applied,
      removed: cursor.removed,
      applyMs: cursor.ms,
    }),
  });
  await queue.park(deviceId, batchId);
  ctx.log.warn("hc.batch_failed", { deviceId, batchId, errorCode });
  // One alert per device, opened by the first batch set aside. It never
  // throws: an alert that cannot be raised must not fail the apply.
  await openParkedAlert(ctx, deviceId, errorCode, deps);
}

/**
 * The oldest queued batch, read and parsed. `null` when the queue is empty;
 * `"failed"` when the head could not be read and has been parked as failed.
 */
async function readHead(
  ctx: Ctx,
  deviceId: string,
  meter: Meter,
  cache: HeadCache | undefined,
  deps: SyncDeps | undefined,
): Promise<Head | "failed" | null> {
  if (cache !== undefined && cache.head !== null) {
    // A batch id is never queued twice for a device, so the id is enough to
    // know the cached batch is still the head.
    meter.spend();
    const current = await headBatchId(ctx, deviceId);
    if (current === cache.head.batch.batchId) return cache.head;
    cache.head = null;
  }
  const head = await openHead(ctx, deviceId, meter, deps);
  if (cache !== undefined && head !== null && head !== "failed") cache.head = head;
  return head;
}

async function openHead(
  ctx: Ctx,
  deviceId: string,
  meter: Meter,
  deps: SyncDeps | undefined,
): Promise<Head | "failed" | null> {
  const queue = makeHcIngestQueueRepo(ctx);
  let queued: QueuedBatch | null;
  meter.spend(2);
  try {
    queued = await queue.head(deviceId);
  } catch (error) {
    const errorCode = permanentCode(error);
    if (errorCode === null) throw error;
    // `head` threw before it could say which batch it was reading.
    meter.spend(3);
    const batchId = await headBatchId(ctx, deviceId);
    if (batchId === null) return null;
    await failBatch(ctx, deviceId, batchId, errorCode, null, deps);
    return "failed";
  }
  if (queued === null) return null;

  let json: unknown;
  try {
    json = await unpackJson(queued.body);
  } catch {
    meter.spend(2);
    await failBatch(ctx, deviceId, queued.batchId, "batch_unreadable", null, deps);
    return "failed";
  }
  const batch = parseBatch(json);
  // The route validated the same bytes before it queued them, so neither of
  // these should happen; a batch from an older wire version is how one could.
  if (batch === null) {
    meter.spend(2);
    await failBatch(ctx, deviceId, queued.batchId, "batch_invalid", null, deps);
    return "failed";
  }
  if (batch.deviceId !== deviceId || batch.batchId !== queued.batchId) {
    meter.spend(2);
    await failBatch(ctx, deviceId, queued.batchId, "batch_mismatch", null, deps);
    return "failed";
  }
  return { queued, batch, marked: new Set() };
}

/** Counts, arrival times and the phone's report; then the batch leaves the queue. */
async function finishBatch(job: BatchRun, head: Head): Promise<void> {
  const { ctx, deviceId, cursor } = job;
  const { queued, batch } = head;
  const applyMs = cursor.ms + (job.meter.elapsedMs - job.startedMs);
  const types = unique([...batch.upserts.map((record) => record.type), ...cursor.shrunk]);
  const statements: D1PreparedStatement[] = [];
  if (types.length > 0) statements.push(recountStatement(ctx, deviceId, types, queued.receivedAt));
  const report = reportStatement(ctx, deviceId, batch.syncState, queued.receivedAt);
  if (report !== null) statements.push(report);
  await commit(job, statements);

  const queue = makeHcIngestQueueRepo(ctx);
  job.meter.spend(2);
  await queue.recordOutcome(deviceId, batch.batchId, {
    status: "applied",
    applied: cursor.applied,
    // Upserts that did not become the stored copy: an older `lastModified`
    // than what is held, a duplicate within the batch, or a tombstoned id.
    superseded: batch.upserts.length - cursor.applied,
    removed: cursor.removed,
    applyMs,
  });
  await queue.remove(deviceId, batch.batchId);
  // If this was the last of what had been set aside, queued again and now
  // applied, the device's alert is over. One SELECT when no alert is open.
  job.meter.spend();
  await resolveParkedAlert(ctx, deviceId, job.deps);
  ctx.log.info("hc.batch_applied", {
    deviceId,
    batchId: batch.batchId,
    applied: cursor.applied,
    superseded: batch.upserts.length - cursor.applied,
    removed: cursor.removed,
    outOfInterval: cursor.outOfInterval,
    ms: applyMs,
  });
}

/**
 * Work on the head batch until it is done or the budget is. Returns the cursor
 * to carry to the next slice, or null when the batch has left the queue.
 */
async function applyHead(
  ctx: Ctx,
  deviceId: string,
  head: Head,
  carried: ApplyCursor | null,
  meter: Meter,
  deps: SyncDeps | undefined,
): Promise<ApplyCursor | null> {
  const { batch } = head;
  const startedMs = meter.elapsedMs;
  const fresh = carried?.batchId !== batch.batchId;
  const cursor: ApplyCursor =
    carried !== null && !fresh
      ? { ...carried, shrunk: [...carried.shrunk] }
      : {
          batchId: batch.batchId,
          phase: "deletes",
          offset: 0,
          applied: 0,
          removed: 0,
          shrunk: [],
          outOfInterval: 0,
          ms: 0,
        };
  const job: BatchRun = {
    ctx,
    deviceId,
    blinder: blinderFor(ctx.env),
    meter,
    cursor,
    startedMs,
    deps,
    marked: head.marked,
    pending: [],
    buffer: emptyBuffer(),
  };
  meter.spend();

  try {
    if (fresh) {
      meter.spend();
      await makeHcIngestQueueRepo(ctx).recordOutcome(deviceId, batch.batchId, {
        status: "applying",
      });
    }
    if (cursor.phase === "deletes") {
      if (!(await applyDeletes(job, unique(batch.deletes))))
        return yielded(cursor, meter, startedMs);
      cursor.phase = "upserts";
      cursor.offset = 0;
    }
    if (cursor.phase === "upserts") {
      if (!(await applyUpserts(job, groupUpserts(batch.upserts)))) {
        return yielded(cursor, meter, startedMs);
      }
      cursor.phase = "finish";
      cursor.offset = 0;
    }
    await finishBatch(job, head);
    meter.done();
    return null;
  } catch (error) {
    const errorCode = permanentCode(error);
    if (errorCode === null) throw error;
    // What was built before the unit that cannot be is whole, and is kept: the
    // batch is set aside with as much of it applied as could be.
    job.pending = [];
    await flush(job);
    await failBatch(ctx, deviceId, batch.batchId, errorCode, cursor, deps);
    meter.done();
    return null;
  }
}

function yielded(cursor: ApplyCursor, meter: Meter, startedMs: number): ApplyCursor {
  return { ...cursor, ms: cursor.ms + (meter.elapsedMs - startedMs) };
}

/**
 * Delete a slice of the device's old `applied` rows from `hc_ingest_log`. True
 * when there may be more.
 *
 * The log is bookkeeping, and its second job -- recognising a batch id the
 * phone sends again -- only has to cover the phone's own retries, which are
 * over in hours. `failed` rows are kept: they are the record of data that did
 * not make it into the store.
 */
async function pruneLog(ctx: Ctx, deviceId: string, meter: Meter): Promise<boolean> {
  meter.spend();
  const result = await ctx.db
    .prepare(
      `DELETE FROM hc_ingest_log WHERE device_id = ?1 AND batch_id IN
         (SELECT batch_id FROM hc_ingest_log
           WHERE device_id = ?1 AND status = 'applied' AND received_at < ?2 LIMIT ?3)`,
    )
    .bind(deviceId, ctx.now() - LOG_RETENTION_SECONDS, LOG_PRUNE_SLICE)
    .run();
  return result.meta.changes >= LOG_PRUNE_SLICE;
}

/**
 * One budgeted slice of a device's Health Connect work: queued batches first,
 * oldest first, then the rebuild of what they marked, then housekeeping.
 *
 * `deps` is the test seam of the alert raised when a batch is set aside (its
 * Trello transport and origin); production passes none.
 */
export async function runHcSlice(
  ctx: Ctx,
  deviceId: string,
  state: HcRunnerState = EMPTY_RUNNER_STATE,
  budget: SliceBudget = DEFAULT_SLICE_BUDGET,
  cache?: HeadCache,
  deps?: SyncDeps,
): Promise<SliceResult> {
  const meter = new Meter(budget);
  const { result, phase } = await workSlice(ctx, deviceId, state, meter, cache, deps);
  // One line per slice: how much it did and what stopped it. Counts and codes.
  meter.spend();
  const queued = await makeHcIngestQueueRepo(ctx).depth(deviceId);
  ctx.log.info("hc.slice", {
    deviceId,
    phase,
    statements: meter.statements,
    ms: meter.elapsedMs,
    units: meter.unitsDone,
    // What it stopped on: nothing left, or one of the two budgets. A slice
    // that yields with neither spent stopped just short of the statement one.
    ended: result.more ? (meter.spent ?? "statements") : "done",
    queuedBatches: queued.batches,
  });
  return result;
}

/**
 * The rebuild's share of a slice while batches are still arriving.
 *
 * The rebuild proper runs when the queue is empty, and during a backfill of
 * hours it never is: every rollup and summary would wait for the last batch.
 * So each applied batch is followed by a fraction of a slice on the dirty
 * list. The fraction follows the list: a fifth of a slice when there is next
 * to nothing waiting -- about 130 statements, a handful of nights and sessions
 * or a month of days -- rising in a straight line to half a slice once
 * `REBUILD_BACKLOG_FULL` marks or more are, so a backfill that marks faster
 * than a fifth can rebuild is answered with more, and the list stops growing
 * rather than waiting for the queue to empty.
 *
 * It is a bound in both directions. The queue cannot be starved, because the
 * share is never more than half and is only taken once per batch that was
 * applied; and the list cannot be ignored, because every applied batch takes
 * at least the fifth.
 *
 * Whatever is taken above the fifth comes out of what the slice has not yet
 * spent (`unspent`, a fraction of its budget): a batch that ends a slice
 * already at its budget is followed by the fifth and no more, as it always
 * was, so the larger share never moves a slice any closer to D1's own limit
 * on queries.
 */
const REBUILD_SHARE_MIN = 0.2;
const REBUILD_SHARE_MAX = 0.5;
/** Marks waiting at which the share is at its largest; the count stops there. */
const REBUILD_BACKLOG_FULL = 400;

/** The share of a slice the rebuild takes after a batch: see `REBUILD_SHARE_MIN`. */
export function rebuildShare(backlog: number, unspent: number): number {
  const fullness = Math.min(1, Math.max(0, backlog) / REBUILD_BACKLOG_FULL);
  const wanted = REBUILD_SHARE_MIN + (REBUILD_SHARE_MAX - REBUILD_SHARE_MIN) * fullness;
  return Math.max(REBUILD_SHARE_MIN, Math.min(wanted, unspent));
}

/** The work of one slice, and which phase it ended in. */
async function workSlice(
  ctx: Ctx,
  deviceId: string,
  state: HcRunnerState,
  meter: Meter,
  cache: HeadCache | undefined,
  deps: SyncDeps | undefined,
): Promise<{ result: SliceResult; phase: "apply" | "rebuild" }> {
  let cursor = state.cursor;
  let { tzDigest } = state;
  const paused = (next: ApplyCursor | null): { result: SliceResult; phase: "apply" } => ({
    result: { state: { cursor: next, tzDigest }, more: true, progressed: meter.progressed },
    phase: "apply",
  });
  for (;;) {
    const head = await readHead(ctx, deviceId, meter, cache, deps);
    if (head === null) break;
    if (head === "failed") {
      cursor = null;
      meter.done();
    } else {
      cursor = await applyHead(ctx, deviceId, head, cursor, meter, deps);
      if (cursor !== null) return paused(cursor);
      // Applied or set aside: either way it is no longer the head.
      if (cache !== undefined) cache.head = null;
      // See `REBUILD_SHARE_MIN`. Marks are settled exactly as in the rebuild
      // proper: a row written, then its mark cleared, in one transaction.
      meter.spend();
      const backlog = await dirtyBacklog(ctx, deviceId, REBUILD_BACKLOG_FULL);
      const part = meter.share(rebuildShare(backlog, meter.unspent));
      ({ tzDigest } = await rebuildSlice(ctx, deviceId, tzDigest, part));
      meter.absorb(part);
    }
    if (!meter.mayStart(BATCH_OVERHEAD + CHUNK_COST)) return paused(null);
  }

  const rebuilt = await rebuildSlice(ctx, deviceId, tzDigest, meter);
  const more = rebuilt.more || (await pruneLog(ctx, deviceId, meter));
  return {
    result: {
      state: { cursor: null, tzDigest: rebuilt.tzDigest },
      more,
      progressed: meter.progressed,
    },
    phase: "rebuild",
  };
}

/**
 * What the slices now being attempted are working on, and how many have been
 * started on it without one finishing. `batchId` is the head of the queue, or
 * null when nothing is queued and the work is the rebuild.
 */
export interface HeadFailures {
  batchId: string | null;
  failures: number;
}

export const NO_HEAD_FAILURES: HeadFailures = { batchId: null, failures: 0 };

/**
 * Count a slice that is about to start, and give up on what it is working on
 * when `MAX_BATCH_FAILURES` slices have already been started on it without one
 * finishing.
 *
 * The caller persists the returned count BEFORE it runs the slice and clears
 * it when the slice returns. So a slice that throws is counted, and so is one
 * that never comes back at all -- an invocation killed for CPU or memory, which
 * no `catch` sees. Either way the same batch at the head of a strictly ordered
 * queue would otherwise be tried for ever with every later batch behind it.
 *
 * `runHcSlice` already sets aside what it knows can never be applied; this is
 * for what it does not know. At the limit the head batch is parked as `failed`
 * with `apply_gave_up` -- kept, loudly, and out of the way. With nothing
 * queued, the work is the rebuild and it is the mark at the head of the dirty
 * list that is parked. The count starts from nothing after either, so a batch
 * that is queued again gets its full number of attempts.
 */
export async function beginAttempt(
  ctx: Ctx,
  deviceId: string,
  previous: HeadFailures,
  deps?: SyncDeps,
): Promise<{ head: HeadFailures; gaveUp: boolean }> {
  const batchId = await headBatchId(ctx, deviceId);
  const same = previous.failures > 0 && previous.batchId === batchId;
  const failures = same ? previous.failures + 1 : 1;
  if (failures <= MAX_BATCH_FAILURES) return { head: { batchId, failures }, gaveUp: false };
  if (batchId === null) await parkFirstMark(ctx, deviceId, "rebuild_gave_up");
  else await failBatch(ctx, deviceId, batchId, "apply_gave_up", null, deps);
  return { head: NO_HEAD_FAILURES, gaveUp: true };
}
