// A slice that dies is run again, and the store ends up exactly where an
// uninterrupted run leaves it -- wherever it died.
//
// Chunk writes are committed several to a `db.batch` (worker/src/hc/apply.ts,
// `Buffered`), and the cursor moves only after the commit that holds them. So
// the interesting deaths are the ones around a commit: before it (nothing of
// the page is durable), after it but before the slice returned (all of it is,
// and the cursor never heard), and between two commits of one page. This suite
// kills a run on both sides of the commits that write chunks, and at a sample
// of every other round trip to D1, and compares all that is stored with a run
// that was left alone.
//
// Sealing uses a fresh nonce, so ciphertext is never equal twice. What is
// compared is everything under it: each chunk's keyed digest of its plaintext
// (`content_hash`), every derived row opened, and every plain column.
//
// Every record is synthetic: see helpers.ts.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { makeCtx } from "../../../src/db/client.ts";
import { makeRepos } from "../../../src/db/index.ts";
import { EMPTY_RUNNER_STATE, runHcSlice } from "../../../src/hc/apply.ts";
import { HOUR_MS } from "../../../src/hc/store/keys.ts";
import { openJson, payloadAad } from "../../../src/hc/store/sealed.ts";

import {
  enqueue,
  heartRate,
  instant,
  interval,
  MINUTE_MS,
  PHONE,
  resetHc,
  seedDevice,
  steps,
  T,
  testCtx,
} from "./helpers.ts";

import type { TestBatch } from "./helpers.ts";
import type { HeadCache } from "../../../src/hc/apply.ts";
import type { SliceBudget } from "../../../src/hc/store/budget.ts";
import type { HcRecord } from "../../../src/hc/wire.ts";

const ctx = testCtx();
const repos = makeRepos(ctx);

const KILLED = "synthetic kill";

/** Where a run is killed: at its `at`-th round trip, before or after D1 has run it. */
interface Fault {
  at: number;
  when: "before" | "after";
  /** Round trips seen so far. */
  seen: number;
  fired: boolean;
  /** Which of them were a `db.batch` of chunk writes: the commits of the apply. */
  commits: number[];
  /**
   * A `db.batch` of chunk writes with more statements than this is not taken: refused outright
   * (`"refuse"`, a request too large for D1), or run and then reported as
   * failed (`"lose"`, a reply that never arrived).
   */
  tooMany?: { over: number; how: "refuse" | "lose" };
  /** How many were turned away that way. */
  turnedAway: number;
}

/** What the first statement of a commit of chunk writes, or of tombstones, begins with. */
const APPLY_COMMIT = /^\s*(?:INSERT INTO|DELETE FROM|UPDATE) hc_(?:chunks|record_index)\b/u;

const never = (): Fault => ({
  at: 0,
  when: "before",
  seen: 0,
  fired: false,
  commits: [],
  turnedAway: 0,
});
const killAt = (at: number, when: Fault["when"]): Fault => ({ ...never(), at, when });

async function trip<T>(fault: Fault, exec: () => Promise<T>): Promise<T> {
  fault.seen += 1;
  const hit = !fault.fired && fault.seen === fault.at;
  if (hit && fault.when === "before") {
    fault.fired = true;
    throw new Error(KILLED);
  }
  const out = await exec();
  if (hit) {
    // D1 did the work; the caller never hears of it.
    fault.fired = true;
    throw new Error(KILLED);
  }
  return out;
}

/** A prepared statement whose every execution is a round trip that may be the fatal one. */
class FaultyStatement {
  constructor(
    readonly sql: string,
    readonly inner: D1PreparedStatement,
    private readonly fault: Fault,
  ) {}

  bind(...values: unknown[]): FaultyStatement {
    return new FaultyStatement(this.sql, this.inner.bind(...values), this.fault);
  }

  first(): Promise<unknown> {
    return trip(this.fault, () => this.inner.first());
  }

  run(): Promise<unknown> {
    return trip(this.fault, () => this.inner.run());
  }

  all(): Promise<unknown> {
    return trip(this.fault, () => this.inner.all());
  }
}

/** D1, with one round trip that kills the caller. Only what the store uses is here. */
function faultyDb(fault: Fault): D1Database {
  const db = {
    prepare: (sql: string) => new FaultyStatement(sql, env.DB.prepare(sql), fault),
    batch: async (statements: FaultyStatement[]) => {
      const inner = statements.map((statement) => statement.inner);
      const { tooMany } = fault;
      const chunks = APPLY_COMMIT.test(statements[0]?.sql ?? "");
      if (chunks && tooMany !== undefined && statements.length > tooMany.over) {
        fault.turnedAway += 1;
        if (tooMany.how === "lose") await env.DB.batch(inner);
        // Not `KILLED`: this is an answer from D1, and the slice goes on.
        throw new Error("synthetic refusal");
      }
      if (chunks) fault.commits.push(fault.seen + 1);
      return trip(fault, () => env.DB.batch(inner));
    },
  };
  // The two members the apply pipeline calls; the cast covers the rest of D1's surface.
  return db as unknown as D1Database;
}

/**
 * Apply everything queued the way the runner's alarm chain does: a slice that
 * throws loses its cursor and its cached batch, and the next one starts from
 * what the last good slice returned.
 */
async function run(deviceId: string, fault: Fault, budget?: SliceBudget): Promise<void> {
  const faulty = makeCtx(faultyDb(fault), ctx.env, { now: ctx.now, log: ctx.log });
  let state = EMPTY_RUNNER_STATE;
  const cache: HeadCache = { head: null };
  for (let slice = 0; slice < 2000; slice += 1) {
    try {
      const result = await runHcSlice(faulty, deviceId, state, budget, cache);
      ({ state } = result);
      if (!result.more) return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== KILLED) throw error;
      cache.head = null;
    }
  }
  throw new Error("the store never went idle");
}

async function rowsOf(sql: string, deviceId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare(sql).bind(deviceId).all();
  return results;
}

/** A table's rows with `payload_enc` opened: `aadOf` names the row the way its writer does. */
async function opened(
  deviceId: string,
  table: string,
  order: string,
  aadOf: (row: Record<string, unknown>) => (string | number)[],
): Promise<Record<string, unknown>[]> {
  const rows = await rowsOf(
    `SELECT * FROM ${table} WHERE device_id = ? ORDER BY ${order}`,
    deviceId,
  );
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const { payload_enc: sealed, ...plain } = row;
    const aad = payloadAad(table, deviceId, ...aadOf(row));
    out.push({ ...plain, payload: await openJson(ctx, String(sealed), aad) });
  }
  return out;
}

/** Everything a device has stored, in a form two runs can be compared by. */
async function snapshot(deviceId: string): Promise<Record<string, unknown>> {
  return {
    // `content_hash` is a keyed digest of the chunk's plaintext: equal hashes
    // are equal records, byte for byte.
    chunks: await rowsOf(
      `SELECT record_type, origin_hash, hour_utc, part, record_count, min_start_ms, max_end_ms,
              content_hash
         FROM hc_chunks WHERE device_id = ? ORDER BY record_type, origin_hash, hour_utc, part`,
      deviceId,
    ),
    index: await rowsOf(
      "SELECT * FROM hc_record_index WHERE device_id = ? ORDER BY record_id_blind",
      deviceId,
    ),
    hours: await opened(deviceId, "hc_rollup_hour", "record_type, origin_hash, hour_utc", (row) => [
      String(row.record_type),
      String(row.origin_hash),
      Number(row.hour_utc),
    ]),
    days: await opened(deviceId, "hc_rollup_day", "record_type, origin_hash, day", (row) => [
      String(row.record_type),
      String(row.origin_hash),
      String(row.day),
    ]),
    minutes: await opened(deviceId, "hc_hr_minute", "origin_hash, hour_utc", (row) => [
      String(row.origin_hash),
      Number(row.hour_utc),
    ]),
    nights: await opened(deviceId, "hc_sleep_night", "record_id_blind", (row) => [
      String(row.record_id_blind),
    ]),
    sessions: await opened(deviceId, "hc_exercise_session", "record_id_blind", (row) => [
      String(row.record_id_blind),
    ]),
    sync: await rowsOf(
      "SELECT * FROM hc_sync_state WHERE device_id = ? ORDER BY record_type",
      deviceId,
    ),
    // `removed` is left out on purpose: a slice that dies after tombstoning
    // loses its count of them, and the replay only sees the tombstones. That
    // was so before chunk writes shared a commit, and it is a log figure.
    log: await rowsOf(
      `SELECT batch_id, status, error_code, upserts, deletes, applied, superseded
         FROM hc_ingest_log WHERE device_id = ? ORDER BY batch_id`,
      deviceId,
    ),
    marks: await rowsOf("SELECT kind, key FROM hc_dirty WHERE device_id = ?", deviceId),
    queued: await rowsOf("SELECT batch_id FROM hc_ingest_queue WHERE device_id = ?", deviceId),
  };
}

// Child tables only: the device row stays, because every blind and digest is
// scoped to it and two runs are only comparable on the same device.
const STORE_TABLES = [
  "hc_ingest_queue",
  "hc_ingest_log",
  "hc_dirty",
  "hc_chunks",
  "hc_record_index",
  "hc_rollup_hour",
  "hc_rollup_day",
  "hc_hr_minute",
  "hc_sleep_night",
  "hc_exercise_session",
  "hc_sync_state",
];

async function clearStore(): Promise<void> {
  await env.DB.batch(STORE_TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

/** Queue the batches on an empty store, run them with `fault`, and say what is stored. */
async function outcome(
  deviceId: string,
  batches: readonly TestBatch[],
  fault: Fault,
  budget?: SliceBudget,
): Promise<Record<string, unknown>> {
  await clearStore();
  for (const batch of batches) await enqueue(repos, deviceId, batch);
  await run(deviceId, fault, budget);
  return snapshot(deviceId);
}

/**
 * Run the batches once for every death in `faults` and expect the store an
 * uninterrupted run leaves.
 */
async function expectSameStore(
  deviceId: string,
  batches: () => TestBatch[],
  reference: Record<string, unknown>,
  faults: readonly Fault[],
  budget?: SliceBudget,
): Promise<void> {
  for (const fault of faults) {
    const stored = await outcome(deviceId, batches(), fault, budget);
    const where = `killed ${fault.when} round trip ${String(fault.at)}`;
    expect(fault.fired, where).toBe(fault.at > 0);
    expect(stored, where).toStrictEqual(reference);
  }
}

/** Every `step`-th item, from the first. */
function sample<T>(items: readonly T[], step: number): T[] {
  return items.filter((_, index) => index % step === 0);
}

const NEXT = T + HOUR_MS;

/** Heart rate with a sample every ten minutes of `[startMs, startMs + spanMs]`. */
function series(id: string, startMs: number, spanMs: number, extra: Partial<HcRecord> = {}) {
  const samples: [number, number][] = [];
  for (let offset = 0; offset <= spanMs; offset += 10 * MINUTE_MS) {
    samples.push([offset, 60 + ((offset / MINUTE_MS) % 40)]);
  }
  return heartRate(id, startMs, samples, { end: startMs + spanMs, ...extra });
}

/**
 * Three batches that between them do everything the apply does: more groups
 * than one page, two origins, heart rate in consecutive hours (a series ending
 * exactly on the hour with a sample on it, one running past it, one running
 * across midnight), a night and a workout with what their summaries read,
 * records that move between hours in both directions inside one page, a
 * re-upload, stale copies, and deletes of stored, moved and never-seen ids.
 */
function scenario(): TestBatch[] {
  const sparse = Array.from({ length: 26 }, (_, index) =>
    steps(`sparse-${String(index)}`, T + (10 + index) * HOUR_MS + 5 * MINUTE_MS, 10 + index),
  );
  const first: TestBatch = {
    batchId: "batch-0001",
    upserts: [
      steps("a", T, 100, { lastModified: 2000 }),
      steps("b", NEXT, 200),
      steps("c", T + 2 * HOUR_MS, 300),
      steps("gone-1", T + 3 * HOUR_MS, 1),
      steps("gone-2", T + 3 * HOUR_MS + MINUTE_MS, 2),
      steps("gone-3", T + 6 * HOUR_MS, 3),
      steps("phone-1", T, 50, { origin: PHONE }),
      // Ends exactly on the hour, with a sample stamped on it.
      series("hr-boundary", T, HOUR_MS),
      series("hr-next", NEXT + MINUTE_MS, 40 * MINUTE_MS),
      series("hr-gone", T + 4 * HOUR_MS, 30 * MINUTE_MS),
      interval("night", "SleepSession", T - 2 * HOUR_MS, T + 5 * HOUR_MS, {}),
      instant("hrv-1", "HeartRateVariabilityRmssd", T + 30 * MINUTE_MS, { rmssd: 41 }),
    ],
  };
  const second: TestBatch = {
    batchId: "batch-0002",
    upserts: [
      ...sparse,
      // `a` moves forward an hour into the chunk `b` is in; `c` moves back
      // into the chunk `a` is leaving. Both source and target are in one page.
      steps("a", NEXT + 2 * MINUTE_MS, 150, { lastModified: 3000 }),
      steps("c", T + 3 * MINUTE_MS, 350, { lastModified: 3000 }),
      // A stale copy, and an unchanged one.
      steps("b", NEXT, 999, { lastModified: 1 }),
      steps("phone-1", T, 50, { origin: PHONE }),
      steps("phone-2", NEXT, 60, { origin: PHONE }),
      // Runs past its hour, and one across midnight (the day boundary is 12
      // hours after T).
      series("hr-spill", T + 2 * HOUR_MS + 30 * MINUTE_MS, 50 * MINUTE_MS),
      series("hr-midnight", T + 11 * HOUR_MS + 30 * MINUTE_MS, 90 * MINUTE_MS),
      series("hr-boundary", T, HOUR_MS),
      series("hr-next", NEXT + MINUTE_MS, 50 * MINUTE_MS, { lastModified: 2000 }),
      interval("workout", "ExerciseSession", T + 2 * HOUR_MS, T + 3 * HOUR_MS + MINUTE_MS, {}),
      interval(
        "night",
        "SleepSession",
        T - 2 * HOUR_MS,
        T + 6 * HOUR_MS,
        {},
        { lastModified: 2000 },
      ),
    ],
    deletes: ["gone-1", "gone-2", "gone-3", "hr-gone", "never-seen"],
  };
  const third: TestBatch = {
    batchId: "batch-0003",
    upserts: [
      // The moves again (now no-ops), one more move, and a late upsert of a
      // deleted id.
      steps("a", NEXT + 2 * MINUTE_MS, 150, { lastModified: 3000 }),
      steps("sparse-3", T + 40 * HOUR_MS, 77, { lastModified: 4000 }),
      steps("gone-1", T + 3 * HOUR_MS, 1, { lastModified: 9000 }),
      series("hr-spill", T + 2 * HOUR_MS + 30 * MINUTE_MS, 20 * MINUTE_MS, { lastModified: 2000 }),
      instant("hrv-2", "HeartRateVariabilityRmssd", T + 4 * HOUR_MS, { rmssd: 39 }),
    ],
    deletes: ["sparse-5", "hr-midnight", "workout"],
  };
  return [first, second, third];
}

/** Forty kilobytes of text that will not compress, the same for every run. */
const NOISE = Array.from({ length: 50 }, () => {
  const bytes = crypto.getRandomValues(new Uint8Array(30_000));
  return btoa(String.fromCodePoint(...bytes));
});

/** A chunk too large for one row, written, shrunk and emptied, beside ordinary ones. */
function heavy(): TestBatch[] {
  const big = (from: number, to: number, lastModified: number): HcRecord[] =>
    NOISE.slice(from, to).map((notes, index) =>
      steps(`heavy-${String(from + index)}`, T + (from + index) * MINUTE_MS, index, {
        lastModified,
        data: { count: index, notes },
      }),
    );
  return [
    { batchId: "batch-0001", upserts: [...big(0, 50, 1000), steps("small", NEXT, 5)] },
    {
      batchId: "batch-0002",
      upserts: [steps("small-2", NEXT + MINUTE_MS, 6), ...big(0, 3, 2000)],
      deletes: Array.from({ length: 40 }, (_, index) => `heavy-${String(10 + index)}`),
    },
  ];
}

/** A budget small enough that slices also end part way through a page. */
const TIGHT: SliceBudget = { maxQueries: 70, maxMs: 20_000 };

describe("a slice that dies", () => {
  let deviceId = "";

  beforeAll(async () => {
    await resetHc();
    deviceId = await seedDevice(repos);
  });

  it("applies the scenario at all: every kind of row is there to be compared", async () => {
    const stored = await outcome(deviceId, scenario(), never());
    const sizes = Object.fromEntries(
      Object.entries(stored).map(([name, rows]) => [name, (rows as unknown[]).length]),
    );
    expect(sizes).toMatchObject({ marks: 0, queued: 0, log: 3, nights: 1, sessions: 0 });
    expect(sizes.chunks).toBeGreaterThan(30);
    expect(sizes.minutes).toBeGreaterThan(2);
    expect(sizes.days).toBeGreaterThan(3);
    const tombstones = (stored.index as { deleted_at: number | null }[]).filter(
      (row) => row.deleted_at !== null,
    );
    // gone-1..3, hr-gone, never-seen, sparse-5, hr-midnight, workout.
    expect(tombstones).toHaveLength(8);
  });

  it("reaches the same store whatever the slices' budget", async () => {
    const reference = await outcome(deviceId, scenario(), never());
    const tight = await outcome(deviceId, scenario(), never(), TIGHT);
    expect(tight).toStrictEqual(reference);
  });

  it("reaches the same store when killed just after any commit of chunks", async () => {
    const counted = never();
    const reference = await outcome(deviceId, scenario(), counted);
    // Fewer than the chunks written, or nothing here is about a shared commit.
    expect(counted.commits.length).toBeGreaterThan(8);
    expect(counted.commits.length).toBeLessThan(30);
    const faults = counted.commits.map((at) => killAt(at, "after"));
    await expectSameStore(deviceId, scenario, reference, faults);
  }, 240_000);

  it("reaches the same store when killed just before a commit, or anywhere else", async () => {
    const counted = never();
    const reference = await outcome(deviceId, scenario(), counted);
    const others = Array.from({ length: counted.seen }, (_, index) => index + 1).filter(
      (at) => !counted.commits.includes(at),
    );
    const faults = [
      ...sample(counted.commits, 2).map((at) => killAt(at, "before")),
      ...sample(others, 17).map((at) => killAt(at, "after")),
    ];
    expect(faults.length).toBeGreaterThan(10);
    await expectSameStore(deviceId, scenario, reference, faults);
  }, 240_000);

  it("reaches the same store when slices that also stop part way through a page are killed", async () => {
    const reference = await outcome(deviceId, scenario(), never());
    const counted = never();
    await outcome(deviceId, scenario(), counted, TIGHT);
    const faults = sample(counted.commits, 4).map((at) => killAt(at, "after"));
    expect(faults.length).toBeGreaterThan(3);
    await expectSameStore(deviceId, scenario, reference, faults, TIGHT);
  }, 240_000);

  // A commit shared by several chunks is a larger request, and D1 may not take
  // it. Then each chunk is committed alone, as it was before they shared one:
  // nothing fails, nothing is set aside, and nothing is counted twice.
  it.each(["refuse", "lose"] as const)(
    "reaches the same store, with nothing set aside, when D1 will only %s a large commit",
    async (how) => {
      const reference = await outcome(deviceId, scenario(), never());
      // Any one chunk's statements fit; a page of them does not.
      const small = (): Fault => ({ ...never(), tooMany: { over: 12, how } });

      const alone = small();
      const stored = await outcome(deviceId, scenario(), alone);

      expect(alone.turnedAway).toBeGreaterThan(3);
      // The log is in the comparison: every batch `applied`, with the same
      // counts as when each commit was taken whole -- also when it had been
      // (`lose`), and every chunk of it was then written a second time.
      expect(stored).toStrictEqual(reference);
      // And dying between the chunks of a commit that was split changes nothing.
      const faults = sample(alone.commits, 12).map((at) => ({
        ...small(),
        at,
        when: "after" as const,
      }));
      expect(faults.length).toBeGreaterThan(2);
      await expectSameStore(deviceId, scenario, reference, faults);
    },
    240_000,
  );

  it("reaches the same store for a chunk of several rows, killed either side of any commit", async () => {
    const counted = never();
    const reference = await outcome(deviceId, heavy(), counted);
    // Written across rows by the first batch, shrunk to one by the second.
    const parts = (reference.chunks as { part: number }[]).map((row) => row.part);
    expect(parts.every((part) => part === 0)).toBe(true);
    const faults = counted.commits.flatMap((at) => [killAt(at, "before"), killAt(at, "after")]);
    await expectSameStore(deviceId, heavy, reference, faults);
  }, 240_000);
});
