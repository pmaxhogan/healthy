/**
 * Heart-rate spill for a page of chunk writes, read once.
 *
 * The per-minute row of an hour H is built from the hour's own chunk plus the
 * records of earlier chunks of the same origin that reach into H
 * (worker/src/hc/rollup/hr-minute.ts, rule 1; `HR_SPILL_SQL` for exactly which
 * those are). Applying a batch used to ask D1 that question once per chunk
 * written -- a round trip each, and a heart-rate batch is nothing but
 * consecutive hours, so each answer was mostly the chunk written one step
 * before.
 *
 * This asks for every chunk of a page at once, before any of them is written,
 * and then keeps the answers true as the page is worked through:
 *
 *   snapshot   what the table held for each hour when the page began
 *   written    every heart-rate chunk the page has built since, as it will be
 *
 * The spill into H is the snapshot's chunks, less any the page has since
 * rewritten, plus the rewritten ones that reach into H as they now are. That
 * is, statement for statement, what `HR_SPILL_SQL` would return if every write
 * of the page so far had been committed -- which is what it was run against
 * when each chunk was committed by itself. `reaches` is that statement's WHERE
 * clause in this language, and a test holds the two to the same answer.
 *
 * The view is good for one page and for the writes it is told of. A chunk
 * written that it never hears about would make it wrong, so the one function
 * that writes chunks (`rewriteChunk`, worker/src/hc/apply.ts) reports to it
 * every time, changed or not; and a chunk it was not asked to read ahead is
 * simply not `covered`, and is read from the table the old way.
 */

import { hrSpillChunks } from "./chunks.ts";
import { HOUR_MS, TYPE_HEART_RATE, chunkExtent, keyId, listOf, sortedBy } from "./keys.ts";

import type { Meter } from "./budget.ts";
import type { StoredChunk } from "./chunks.ts";
import type { ChunkKey } from "./keys.ts";
import type { Ctx } from "../../db/client.ts";
import type { HcRecord } from "../wire.ts";

/** A chunk as the spill rule sees it: where it is filed, how far it runs, what it holds. */
interface Reaching {
  hourUtc: number;
  maxEndMs: number;
  records: readonly HcRecord[];
}

/**
 * Whether a chunk filed under `hourUtc`, whose last record ends at `maxEndMs`,
 * can hold a heart-rate sample timed in the hour `into`. `HR_SPILL_SQL`, as a
 * predicate:
 *
 *   - any earlier chunk that runs PAST the start of `into`; or
 *   - the chunk of the hour just before, ending exactly ON it (a sample is an
 *     instant, and one stamped on the boundary belongs to the later hour).
 */
export function reaches(hourUtc: number, maxEndMs: number, into: number): boolean {
  if (hourUtc >= into) return false;
  const boundary = into * HOUR_MS;
  return maxEndMs > boundary || (hourUtc === into - 1 && maxEndMs === boundary);
}

export class HrSpillView {
  /**
   * Read the spill into each of `keys` (heart-rate chunks; others are passed
   * over) in one round trip. Nothing the page will write may be waiting in a
   * buffer when this is called: the answers are the table's.
   */
  static async load(
    ctx: Ctx,
    deviceId: string,
    keys: readonly ChunkKey[],
    meter?: Meter,
  ): Promise<HrSpillView> {
    const view = new HrSpillView();
    const wanted = new Map<string, ChunkKey>();
    for (const key of keys) if (key.type === TYPE_HEART_RATE) wanted.set(keyId(key), key);
    if (wanted.size === 0) return view;
    const hours = listOf(wanted.values());
    const spills = await hrSpillChunks(ctx, deviceId, hours, meter);
    // One answer per hour asked for, in the order asked.
    const answers = spills.values();
    for (const key of hours) {
      const chunks: StoredChunk[] = answers.next().value ?? [];
      const reaching = new Map<string, Reaching>();
      for (const chunk of chunks) {
        reaching.set(keyId(chunk.key), {
          hourUtc: chunk.key.hourUtc,
          maxEndMs: chunkExtent(chunk.records).maxEndMs,
          records: chunk.records,
        });
      }
      view.snapshot.set(keyId(key), reaching);
    }
    return view;
  }

  /** Per hour read ahead (by `keyId`): the chunks that reached into it when the page began. */
  private readonly snapshot = new Map<string, Map<string, Reaching>>();
  /** Every heart-rate chunk the page has built, by `keyId`, as it will be stored. */
  private readonly written = new Map<string, { key: ChunkKey; records: readonly HcRecord[] }>();

  /** True when the spill into `key` was read ahead, and `into` can answer for it. */
  covers(key: ChunkKey): boolean {
    return this.snapshot.has(keyId(key));
  }

  /** The page has built the heart-rate chunk at `key` to hold `records` (none: it is deleted). */
  wrote(key: ChunkKey, records: readonly HcRecord[]): void {
    if (key.type === TYPE_HEART_RATE) this.written.set(keyId(key), { key, records });
  }

  /**
   * The records of earlier chunks that reach into the hour of `key`, as the
   * table will hold them once everything the page has built is committed.
   *
   * In a fixed order -- the chunk ending on the boundary, then the others by
   * how far they run -- so the same store always gives the same row.
   */
  into(key: ChunkKey): HcRecord[] {
    const reaching = new Map(this.snapshot.get(keyId(key)));
    for (const [id, chunk] of this.written) {
      if (chunk.key.originHash !== key.originHash) continue;
      // What the table held of it is no longer what it is.
      reaching.delete(id);
      if (chunk.records.length === 0) continue;
      const { maxEndMs } = chunkExtent(chunk.records);
      const { hourUtc } = chunk.key;
      if (reaches(hourUtc, maxEndMs, key.hourUtc)) {
        reaching.set(id, { hourUtc, maxEndMs, records: chunk.records });
      }
    }
    const ordered = sortedBy(
      reaching.values(),
      (left, right) => left.maxEndMs - right.maxEndMs || left.hourUtc - right.hourUtc,
    );
    return ordered.flatMap((chunk) => [...chunk.records]);
  }
}
