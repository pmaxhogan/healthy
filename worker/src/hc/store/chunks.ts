/**
 * The chunk store: `hc_chunks`, and the two pre-aggregates that are rewritten
 * with a chunk -- `hc_rollup_hour` and `hc_hr_minute`
 * (worker/migrations/0016_health_connect.sql).
 *
 * One chunk is every record of one type from one origin app that starts in one
 * UTC hour, as sealed gzip JSON: `{ "origin": "<package>", "records": [...] }`.
 * A change is a read-modify-write of that one chunk. This module reads chunks
 * and builds the statements of a write; the caller (worker/src/hc/apply.ts)
 * runs them in one `db.batch` beside the record-index rows, so a chunk and the
 * index that points into it never disagree.
 *
 * `content_hash` is a keyed digest of the plaintext, bound to the chunk's key.
 * A write whose digest equals the stored one produces no statements at all,
 * which is what makes replaying a batch cost one read per chunk and no writes.
 *
 * An emptied chunk is deleted, with its rollup, never stored as an empty list.
 *
 * ### A chunk larger than one row
 *
 * D1 refuses a value over two million bytes, and nothing is ever stored cut
 * short, so a chunk whose compressed payload is larger than one row may hold
 * is split into parts -- by bytes, after compression, so even a single
 * enormous record splits. The `part` column is the last of the primary key:
 * part 0 is the ordinary row, and parts above it are continuation rows.
 *
 * Every part carries the chunk's own `min_start_ms`, `max_end_ms` and
 * `content_hash`, so whatever range predicate finds part 0 finds the rest, and
 * `assembleChunks` puts them back together in `part` order. A continuation's
 * `record_count` is zero, so sums over the column stay right. Each part is
 * sealed under an AAD naming its own row, part included, so parts cannot be
 * reordered or moved between chunks.
 *
 * Anything that lists chunk rows therefore either assembles what it gets
 * (`readChunks`, `hrSpillIn`, the range reads in `read.ts`) or asks only for
 * `part = 0`. Nothing else in the schema knows: the index, the rollups and
 * the summaries have no parts.
 */

import { blinderFor } from "../../db/blind.ts";
import { all, chunk as pages } from "../../db/client.ts";
import { openBytes, sealBytes } from "../../db/crypto.ts";
import { gunzipText, gzipText } from "../codec.ts";
import { rollupBucket } from "../rollup/hour.ts";
import { hrMinutesOfHour } from "../rollup/hr-minute.ts";

import {
  HOUR_MS,
  TYPE_HEART_RATE,
  chunkExtent,
  keyId,
  samplesInInterval,
  sortRecords,
} from "./keys.ts";
import { HcStoreError, payloadAad, sealJson } from "./sealed.ts";

import type { Meter } from "./budget.ts";
import type { ChunkKey } from "./keys.ts";
import type { Ctx } from "../../db/client.ts";
import type { HcRecord } from "../wire.ts";

/** One row of `hc_chunks` as a read fetches it: a chunk, or one part of one. */
export interface ChunkRow {
  record_type: string;
  origin_hash: string;
  hour_utc: number;
  part: number;
  payload_enc: string;
  content_hash: string;
}

export const CHUNK_COLUMNS = "record_type, origin_hash, hour_utc, part, payload_enc, content_hash";

/** A chunk, opened. */
export interface StoredChunk {
  key: ChunkKey;
  /** The origin app's package name. Only ever inside the sealed payload. */
  origin: string;
  records: HcRecord[];
  contentHash: string;
  /** Rows the chunk occupies. One, unless it outgrew a row. */
  parts: number;
}

/** Chunk keys fetched per query. Each row is a payload, so the page is small. */
const READ_PAGE = 20;

/**
 * Compressed bytes per row. D1 caps a value at two million bytes and the
 * envelope is base64 (four characters per three bytes), so this leaves
 * comfortable room -- the same figure the ingest queue splits a body at.
 */
const PART_BYTES = 1_200_000;

/**
 * The AAD of one part of one chunk: `<device>:<type>:<originHash>:<hour>:<part>`.
 * Read from the right it is unambiguous whatever the type contains: two plain
 * integers, then a blind of fixed length with no `:` in it.
 */
const partAad = (deviceId: string, key: ChunkKey, part: number): string =>
  payloadAad("hc_chunks", deviceId, keyId(key), part);
const hourRollupAad = (deviceId: string, key: ChunkKey): string =>
  payloadAad("hc_rollup_hour", deviceId, keyId(key));

export const hrMinuteAad = (deviceId: string, originHash: string, hourUtc: number): string =>
  payloadAad("hc_hr_minute", deviceId, originHash, hourUtc);

function isChunkPayload(value: unknown): value is { origin: string; records: HcRecord[] } {
  if (typeof value !== "object" || value === null) return false;
  const { origin, records } = value as { origin?: unknown; records?: unknown };
  return typeof origin === "string" && Array.isArray(records);
}

/** Open one chunk from all of its rows. */
async function openChunk(
  ctx: Ctx,
  deviceId: string,
  key: ChunkKey,
  rows: ReadonlyMap<number, ChunkRow>,
): Promise<StoredChunk> {
  const pieces: Uint8Array<ArrayBuffer>[] = [];
  for (let part = 0; part < rows.size; part += 1) {
    const row = rows.get(part);
    // Only this module writes the rows, so a gap is corruption, and retrying
    // will not repair it.
    if (row === undefined) throw new HcStoreError("chunk_malformed");
    pieces.push(await openBytes(ctx.env, row.payload_enc, partAad(deviceId, key, part)));
  }
  const whole = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    whole.set(piece, offset);
    offset += piece.length;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await gunzipText(whole));
  } catch {
    throw new HcStoreError("chunk_malformed");
  }
  if (!isChunkPayload(payload)) throw new HcStoreError("chunk_malformed");
  return {
    key,
    origin: payload.origin,
    records: payload.records,
    contentHash: rows.get(0)?.content_hash ?? "",
    parts: rows.size,
  };
}

/**
 * Chunk rows, in any order and with continuations among them, as whole chunks
 * in (hour, origin) order. Every row of each chunk must be present: see the
 * module comment for why any predicate that finds one part finds them all.
 */
export async function assembleChunks(
  ctx: Ctx,
  deviceId: string,
  rows: readonly ChunkRow[],
): Promise<StoredChunk[]> {
  const grouped = new Map<string, { key: ChunkKey; rows: Map<number, ChunkRow> }>();
  for (const row of rows) {
    const key: ChunkKey = {
      type: row.record_type,
      originHash: row.origin_hash,
      hourUtc: row.hour_utc,
    };
    const slot = grouped.get(keyId(key)) ?? { key, rows: new Map<number, ChunkRow>() };
    slot.rows.set(row.part, row);
    grouped.set(keyId(key), slot);
  }
  const chunks: StoredChunk[] = [];
  for (const slot of grouped.values()) {
    chunks.push(await openChunk(ctx, deviceId, slot.key, slot.rows));
  }
  return chunks;
}

/**
 * The statement `readChunks` runs. Bound: the keys as a JSON array of
 * `[type, originHash, hour]`, then the device.
 *
 * CROSS JOIN, not JOIN: SQLite treats it as an instruction to keep the join
 * order as written. Left to itself the planner walks every chunk row of the
 * device and probes the key list for each -- quadratic over a backfill -- when
 * what is wanted is one primary-key lookup per key.
 */
export const READ_CHUNKS_SQL = `SELECT c.record_type, c.origin_hash, c.hour_utc, c.part, c.payload_enc, c.content_hash
   FROM json_each(?) AS k
  CROSS JOIN hc_chunks AS c
     ON c.device_id = ?
    AND c.record_type = json_extract(k.value, '$[0]')
    AND c.origin_hash = json_extract(k.value, '$[1]')
    AND c.hour_utc = json_extract(k.value, '$[2]')`;

/**
 * The statement `hrSpillIn` runs. Bound: device, type, origin blind, the hour,
 * and the hour's first instant.
 *
 * The last comparison repeats what the one before it implies, on purpose: it
 * is the predicate of the partial index `hc_chunks_spill`, which holds only the
 * few chunks that run past their own hour. `INDEXED BY` makes that index the
 * plan rather than a hope; without it the primary key is walked through every
 * earlier chunk of the origin.
 */
export const HR_SPILL_SQL = `SELECT ${CHUNK_COLUMNS} FROM hc_chunks INDEXED BY hc_chunks_spill
  WHERE device_id = ? AND record_type = ? AND origin_hash = ?
    AND hour_utc < ? AND max_end_ms >= ?
    AND max_end_ms >= (hour_utc + 1) * ${String(HOUR_MS)}`;

/** The chunks at the given keys that exist, by `keyId`. */
export async function readChunks(
  ctx: Ctx,
  deviceId: string,
  keys: readonly ChunkKey[],
  meter?: Meter,
): Promise<Map<string, StoredChunk>> {
  const found = new Map<string, StoredChunk>();
  for (const page of pages(keys, READ_PAGE)) {
    meter?.spend();
    const wanted = JSON.stringify(page.map((key) => [key.type, key.originHash, key.hourUtc]));
    const rows = await all<ChunkRow>(ctx.db.prepare(READ_CHUNKS_SQL).bind(wanted, deviceId));
    const assembled = await assembleChunks(ctx, deviceId, rows);
    for (const opened of assembled) {
      found.set(keyId(opened.key), opened);
    }
  }
  return found;
}

const UPSERT_PART = `INSERT INTO hc_chunks
     (device_id, record_type, origin_hash, hour_utc, part, payload_enc, record_count,
      min_start_ms, max_end_ms, content_hash, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (device_id, record_type, origin_hash, hour_utc, part) DO UPDATE SET
     payload_enc = excluded.payload_enc,
     record_count = excluded.record_count,
     min_start_ms = excluded.min_start_ms,
     max_end_ms = excluded.max_end_ms,
     content_hash = excluded.content_hash,
     updated_at = excluded.updated_at`;

/**
 * The statements that make the chunk at `key` hold exactly `records`, and its
 * hour rollup agree: none when nothing would change, deletes when the chunk is
 * now empty, otherwise one upsert per part, the rollup, and a delete of any
 * continuation rows the chunk no longer needs.
 */
export async function chunkStatements(
  ctx: Ctx,
  deviceId: string,
  key: ChunkKey,
  origin: string,
  before: StoredChunk | undefined,
  records: readonly HcRecord[],
): Promise<D1PreparedStatement[]> {
  const where = "WHERE device_id = ? AND record_type = ? AND origin_hash = ? AND hour_utc = ?";
  const bind = [deviceId, key.type, key.originHash, key.hourUtc] as const;
  if (records.length === 0) {
    if (before === undefined) return [];
    // Every part of the chunk: the statement names no `part`.
    return [
      ctx.db.prepare(`DELETE FROM hc_chunks ${where}`).bind(...bind),
      ctx.db.prepare(`DELETE FROM hc_rollup_hour ${where}`).bind(...bind),
    ];
  }

  const sorted = sortRecords(records);
  const json = JSON.stringify({ origin, records: sorted });
  const contentHash = await blinderFor(ctx.env).digest(
    "hc_chunks.content_hash",
    `${deviceId}\u{0}${keyId(key)}\u{0}${json}`,
  );
  // A content digest for change detection, not a secret being compared.
  if (before?.contentHash === contentHash) return [];

  const { minStartMs, maxEndMs } = chunkExtent(sorted);
  const at = ctx.now();
  const bytes = await gzipText(json);
  const parts = Math.max(1, Math.ceil(bytes.length / PART_BYTES));
  const statements: D1PreparedStatement[] = [];
  for (let part = 0; part < parts; part += 1) {
    const piece = bytes.slice(part * PART_BYTES, (part + 1) * PART_BYTES);
    const sealed = await sealBytes(ctx.env, piece, partAad(deviceId, key, part));
    statements.push(
      ctx.db.prepare(UPSERT_PART).bind(
        ...bind,
        part,
        sealed,
        // The records are counted once, on part 0.
        part === 0 ? sorted.length : 0,
        minStartMs,
        maxEndMs,
        contentHash,
        at,
      ),
    );
  }
  if (before !== undefined && before.parts > parts) {
    // The chunk shrank: the rows past its new last part must not be left to be
    // read back as part of it.
    statements.push(
      ctx.db.prepare(`DELETE FROM hc_chunks ${where} AND part >= ?`).bind(...bind, parts),
    );
  }
  statements.push(await hourRollupStatement(ctx, deviceId, key, sorted));
  return statements;
}

/**
 * The statement that writes the hour rollup of the chunk at `key` from its
 * records. Part of every chunk write; on its own, what repairs a rollup row
 * that will not open (a rollup is derived, so it is rebuilt, not mourned).
 */
export async function hourRollupStatement(
  ctx: Ctx,
  deviceId: string,
  key: ChunkKey,
  records: readonly HcRecord[],
): Promise<D1PreparedStatement> {
  const rollup = await sealJson(ctx, rollupBucket(key.type, records), hourRollupAad(deviceId, key));
  return ctx.db
    .prepare(
      `INSERT INTO hc_rollup_hour (device_id, record_type, origin_hash, hour_utc, payload_enc, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, record_type, origin_hash, hour_utc) DO UPDATE SET
         payload_enc = excluded.payload_enc,
         updated_at = excluded.updated_at`,
    )
    .bind(deviceId, key.type, key.originHash, key.hourUtc, rollup, ctx.now());
}

/** Every chunk of one type whose UTC hour is in `[startHour, endHour)`, whole. */
export async function readChunksInHours(
  ctx: Ctx,
  deviceId: string,
  type: string,
  startHour: number,
  endHour: number,
  meter?: Meter,
): Promise<StoredChunk[]> {
  meter?.spend();
  const rows = await all<ChunkRow>(
    ctx.db
      .prepare(
        `SELECT ${CHUNK_COLUMNS} FROM hc_chunks
          WHERE device_id = ? AND record_type = ? AND hour_utc >= ? AND hour_utc < ?`,
      )
      .bind(deviceId, type, startHour, endHour),
  );
  return assembleChunks(ctx, deviceId, rows);
}

/**
 * HeartRate records of earlier chunks of the same origin that run into the
 * hour `hourUtc`, however long ago they started.
 *
 * A heart-rate series is filed under its start hour however long it runs, but
 * each sample belongs to the minute row of its own hour, so the row for an
 * hour is built from that hour's chunk plus these (worker/src/hc/rollup/hr-minute.ts,
 * rule 1). See `HR_SPILL_SQL` for how they are found without walking history.
 */
export async function hrSpillIn(
  ctx: Ctx,
  deviceId: string,
  originHash: string,
  hourUtc: number,
  meter?: Meter,
): Promise<HcRecord[]> {
  meter?.spend();
  const rows = await all<ChunkRow>(
    ctx.db
      .prepare(HR_SPILL_SQL)
      .bind(deviceId, TYPE_HEART_RATE, originHash, hourUtc, hourUtc * HOUR_MS),
  );
  const chunks = await assembleChunks(ctx, deviceId, rows);
  return chunks.flatMap((stored) => stored.records);
}

/**
 * The statement that makes the per-minute heart-rate row of one (origin, UTC
 * hour) agree with the HeartRate records given: an upsert, or a delete when no
 * sample falls in the hour.
 */
export async function hrMinuteStatement(
  ctx: Ctx,
  deviceId: string,
  originHash: string,
  hourUtc: number,
  records: readonly HcRecord[],
): Promise<D1PreparedStatement> {
  // Only samples inside their own record's interval: see `samplesInInterval`.
  const hour = hrMinutesOfHour(samplesInInterval(records).records, hourUtc);
  if (hour.minutes.length === 0) {
    return ctx.db
      .prepare("DELETE FROM hc_hr_minute WHERE device_id = ? AND origin_hash = ? AND hour_utc = ?")
      .bind(deviceId, originHash, hourUtc);
  }
  return ctx.db
    .prepare(
      `INSERT INTO hc_hr_minute (device_id, origin_hash, hour_utc, payload_enc, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (device_id, origin_hash, hour_utc) DO UPDATE SET
         payload_enc = excluded.payload_enc,
         updated_at = excluded.updated_at`,
    )
    .bind(
      deviceId,
      originHash,
      hourUtc,
      await sealJson(ctx, hour, hrMinuteAad(deviceId, originHash, hourUtc)),
      ctx.now(),
    );
}
