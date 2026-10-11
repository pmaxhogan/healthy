/**
 * The Durable Object that applies what the ingest route queued.
 *
 * ### Why this exists
 *
 * `POST /ingest/health-connect` only authenticates, validates and queues: a
 * batch of backfill touches hundreds of stored rows, which is more than one
 * request may ask of D1, and work handed to `waitUntil` is cancelled about
 * thirty seconds after the response with nothing left to clean up. The same
 * reasoning as the full-refresh runner (worker/src/sync/runner.ts), and the
 * same answer: an alarm. Each alarm is its own invocation, does one budgeted
 * slice (worker/src/hc/apply.ts) and re-arms itself while work remains.
 *
 * ### One object per device
 *
 * Addressed by device id, so two phones apply independently and one phone's
 * batches are applied strictly one after another: an object runs one alarm at
 * a time, which is the whole of the concurrency control the store needs.
 *
 * ### What is stored, and what it is worth
 *
 * The device id, where the apply of the head batch has got to, the digest of
 * the zone the day rollups are built for, and how often the head batch has
 * failed. All of it is a saving, none of it is the truth: the queue and the
 * `hc_dirty` list in D1 are. An object that lost its storage would replay the
 * head batch from its start, to the same result. Nothing personal is kept: ids
 * of this app's own rows, positions and counts.
 *
 * The parsed head batch is also held, in the instance's memory only, so that
 * consecutive slices do not each open and validate it again. It is gone when
 * the instance is evicted, and the next slice reads the queue.
 *
 * ### Failure
 *
 * A slice that throws is not rethrown to the platform, which gives up on an
 * alarm after a few retries. It is logged and the alarm re-armed after a
 * growing delay. A batch that can never be applied is closed as failed inside
 * the slice. One that keeps making slices throw for a reason the slice does
 * not recognise is retried `MAX_BATCH_FAILURES` times -- enough for D1 to
 * recover, not enough to hold the device's ordered queue for ever -- and then
 * closed as failed with `apply_gave_up`, so the batches behind it are applied.
 */

import { DurableObject } from "cloudflare:workers";

import { makeCtx } from "../db/client.ts";
import { errorFields, makeLogger } from "../lib/log.ts";

import { EMPTY_RUNNER_STATE, NO_HEAD_FAILURES, beginAttempt, runHcSlice } from "./apply.ts";

import type { HeadCache, HeadFailures, HcRunnerState } from "./apply.ts";
import type { Ctx } from "../db/client.ts";
import type { Env } from "../env.ts";

/** The single storage key. */
const JOB_KEY = "job";

/** The first delay after a failed slice, and the longest one. */
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 10 * 60 * 1000;

/**
 * A backstop against a stuck alarm, not a ceiling on work. A slice always
 * finishes at least one unit, so "there is more, and this slice finished
 * nothing" should not happen even once; this many in a row means a bug, and
 * the object stops re-arming itself rather than spin. The scheduled poke
 * (worker/src/hc/store/poke.ts) wakes it again within minutes, so even then
 * nothing is abandoned.
 */
const MAX_IDLE_SLICES = 20;

interface StoredJob {
  deviceId: string;
  state: HcRunnerState;
  /** Consecutive slices that threw, whatever they were working on: sets the delay. */
  failures: number;
  /**
   * Slices started on what is at the head of the queue without one finishing,
   * written before each slice and cleared after it: see `beginAttempt`.
   */
  head: HeadFailures;
  /** Consecutive slices that reported more work and finished none. */
  idle: number;
}

export class HcIngestRunner extends DurableObject<Env> {
  /** The parsed head batch. Memory only: see the module comment. */
  private readonly cache: HeadCache = { head: null };

  /**
   * Log a slice that threw and come back later, after a growing delay. The
   * attempt was already counted, before it began (`beginAttempt`).
   */
  private async retryLater(ctx: Ctx, job: StoredJob, error: unknown): Promise<void> {
    const { deviceId } = job;
    // Whatever the slice had half read is not worth trusting after a throw.
    this.cache.head = null;
    // A wipe that finished while the slice ran has reset this object; the
    // throw may well be that wipe. Nothing is written back for a device that
    // is gone.
    if ((await this.ctx.storage.get<StoredJob>(JOB_KEY)) === undefined) return;
    const failures = job.failures + 1;
    const delayMs = Math.min(RETRY_BASE_MS * 2 ** Math.min(failures - 1, 16), RETRY_MAX_MS);
    await this.ctx.storage.put<StoredJob>(JOB_KEY, { ...job, failures });
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
    ctx.log.warn("hc.slice_failed", { deviceId, failures, delayMs, ...errorFields(error) });
  }

  /**
   * Make sure this device's work is being done, and return.
   *
   * Fast by construction -- at most a storage write and an alarm -- so the
   * ingest route can call it on its way out. Calling it while a slice is
   * running is fine: the alarm set here fires when that slice has returned.
   */
  async wake(deviceId: string): Promise<void> {
    const job = await this.ctx.storage.get<StoredJob>(JOB_KEY);
    if (job === undefined) {
      await this.ctx.storage.put<StoredJob>(JOB_KEY, {
        deviceId,
        state: EMPTY_RUNNER_STATE,
        failures: 0,
        head: NO_HEAD_FAILURES,
        idle: 0,
      });
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  /**
   * Forget everything: the stored job, the alarm, the cached batch. What a
   * device wipe calls last (worker/src/hc/store/wipe.ts), so that no alarm is
   * left to fire for a device that no longer exists.
   */
  async reset(): Promise<void> {
    this.cache.head = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** One slice, then either re-arm or rest. See the module comment on failure. */
  override async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<StoredJob>(JOB_KEY);
    if (job === undefined) return;
    const { deviceId } = job;
    const log = makeLogger({ src: "hc" });
    const ctx = makeCtx(this.env.DB, this.env, { log });

    // Count the attempt, and write the count down, BEFORE the slice runs: an
    // invocation that is killed outright never reaches a `catch`, and the only
    // trace it can leave is one written beforehand.
    let attempt: Awaited<ReturnType<typeof beginAttempt>>;
    try {
      attempt = await beginAttempt(ctx, deviceId, job.head);
    } catch (error) {
      await this.retryLater(ctx, job, error);
      return;
    }
    const started: StoredJob = {
      ...job,
      // Given up on: the cursor into it means nothing for what comes next.
      state: attempt.gaveUp ? { ...job.state, cursor: null } : job.state,
      head: attempt.head,
    };
    if (attempt.gaveUp) {
      this.cache.head = null;
      log.error("hc.gave_up", { deviceId, attempts: job.head.failures });
    }
    await this.ctx.storage.put<StoredJob>(JOB_KEY, started);

    let result: Awaited<ReturnType<typeof runHcSlice>>;
    try {
      result = await runHcSlice(ctx, deviceId, started.state, undefined, this.cache);
    } catch (error) {
      await this.retryLater(ctx, started, error);
      return;
    }

    // A wipe that finished while the slice ran has reset this object. Writing
    // the job back would leave an object working for a device that is gone.
    if ((await this.ctx.storage.get<StoredJob>(JOB_KEY)) === undefined) return;

    const idle = result.more && !result.progressed ? job.idle + 1 : 0;
    await this.ctx.storage.put<StoredJob>(JOB_KEY, {
      deviceId,
      state: result.state,
      failures: 0,
      head: NO_HEAD_FAILURES,
      idle,
    });
    if (!result.more) return;
    if (idle >= MAX_IDLE_SLICES) {
      log.error("hc.runner_stuck", { deviceId, idle });
      return;
    }
    // `wake` may have armed one already while this slice ran; one is enough.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }
}
