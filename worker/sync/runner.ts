/**
 * The Durable Object that actually finishes a manual full refresh.
 *
 * ### Why this exists
 *
 * `POST /api/providers/:id/full-refresh` answers 202 and used to hand the whole
 * refresh to `ctx.waitUntil`. Work in `waitUntil` is cancelled about thirty seconds
 * after the response is written -- mid-`await`, with the invocation still reported
 * as `ok` -- so a provider whose record takes longer than that got half a cache, no
 * `last_full_refresh_at`, and a `run_log` row left open forever. Nothing inside a
 * cancelled invocation can clean up after itself: there is no `catch`, no `finally`
 * and no alarm, because there is no isolate.
 *
 * An alarm is the way out. The route stores a job here and returns; the alarm runs
 * in its *own* invocation, does one budgeted chunk of the refresh, and re-arms
 * itself while there is more to do. Each chunk gets a fresh thirty seconds and we
 * only ever ask it for twenty, so no single invocation is ever near the edge.
 *
 * Two properties this leans on, and both are why it is a Durable Object rather than
 * a self-`fetch`: the job is durable, so a chunk that dies is retried rather than
 * lost, and reaching it needs no HTTP and therefore no second front door past
 * Cloudflare Access.
 *
 * ### One object per provider
 *
 * The object is addressed by provider id, so two providers refresh independently
 * and pressing the button twice for the *same* provider is a no-op rather than two
 * interleaved refreshes of one record. `start` says which happened.
 *
 * Nothing personal is stored: a job is provider ids, a run id, counts and Epic
 * codes. Same rule as the run log, for the same reason.
 */

import { DurableObject } from "cloudflare:workers";

import { makeCtx } from "../db/client.ts";
import { errorFields, makeLogger } from "../lib/log.ts";
import { nowSeconds } from "../lib/time.ts";

import { CHUNK_BUDGET_MS, runFullRefreshChunk } from "./full-refresh.ts";
import { abandon } from "./run.ts";

import type { RefreshJob } from "./full-refresh.ts";
import type { RunStateSnapshot } from "./run.ts";
import type { Ctx } from "../db/client.ts";
import type { Env } from "../env.ts";

/** The single storage key. One object holds at most one job; see the header. */
const JOB_KEY = "job";

/**
 * How many chunks one refresh may take before it is given up on.
 *
 * Thirty chunks of twenty seconds is ten minutes of refreshing for one provider,
 * which is far more than the largest record observed and still a bounded amount of
 * work -- an alarm that re-armed itself without a ceiling would be a loop, not a
 * retry. Reaching it closes the run row as `chunk_limit`, which is a visible,
 * different answer from the sweeper's `aborted`.
 */
const MAX_CHUNKS = 30;

/** A job plus how many chunks it has already had. */
interface StoredJob extends RefreshJob {
  chunks: number;
}

/** What `start` tells the caller. False means one was already in flight. */
export interface RefreshStarted {
  started: boolean;
}

export class FullRefreshRunner extends DurableObject<Env> {
  /**
   * Queue a refresh for this object's provider and return.
   *
   * Fast by construction -- a storage write and an alarm -- so the route can await
   * it and still answer 202 well inside any deadline.
   */
  async start(providerIds: readonly string[]): Promise<RefreshStarted> {
    const existing = await this.ctx.storage.get<StoredJob>(JOB_KEY);
    if (existing !== undefined) return { started: false };
    await this.ctx.storage.put<StoredJob>(JOB_KEY, {
      pending: [...providerIds],
      cycleStartedAt: nowSeconds(),
      runId: null,
      state: null,
      chunks: 0,
    });
    await this.ctx.storage.setAlarm(Date.now());
    return { started: true };
  }

  /**
   * One chunk, then either re-arm or finish.
   *
   * `runFullRefreshChunk` never throws and writes its own run row, so there is
   * nothing here to catch on its behalf. A throw from *storage* is left to
   * propagate on purpose: the platform retries a failed alarm, the job is still
   * there, and a retry is exactly the right answer.
   */
  override async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<StoredJob>(JOB_KEY);
    if (job === undefined) return;
    const log = makeLogger({ src: "refresh" });
    const ctx: Ctx = makeCtx(this.env.DB, this.env, { log });
    const chunks = job.chunks + 1;

    const result = await runFullRefreshChunk(ctx, {
      trigger: "full",
      budgetMs: CHUNK_BUDGET_MS,
      job: {
        pending: job.pending,
        cycleStartedAt: job.cycleStartedAt,
        runId: job.runId,
        state: job.state,
      },
    });

    if (result.job === null) {
      await this.ctx.storage.delete(JOB_KEY);
      log.info("refresh.chunks_done", { chunks, resources: result.summary.resourcesCached });
      return;
    }

    if (chunks >= MAX_CHUNKS) {
      await this.ctx.storage.delete(JOB_KEY);
      log.warn("refresh.chunk_limit", { chunks, pending: result.job.pending.length });
      if (result.job.runId !== null && result.job.state !== null) {
        await closeGivenUp(ctx, result.job.runId, result.job.state);
      }
      return;
    }

    await this.ctx.storage.put<StoredJob>(JOB_KEY, { ...result.job, chunks });
    await this.ctx.storage.setAlarm(Date.now());
    log.info("refresh.chunk", { chunks, pending: result.job.pending.length });
  }
}

/** Closing the row must not turn a bounded refresh into a retried alarm. */
async function closeGivenUp(ctx: Ctx, runId: string, state: RunStateSnapshot): Promise<void> {
  try {
    await abandon(ctx, runId, state, "chunk_limit");
  } catch (error) {
    ctx.log.warn("refresh.chunk_limit_close_failed", errorFields(error));
  }
}

/**
 * Hand one provider's full refresh to its runner.
 *
 * This is what the admin API calls. It is not `runFullRefresh`: it returns as soon
 * as the job is durable, and the refresh itself happens in alarm invocations that
 * outlive the request by minutes if it needs them.
 */
export async function startFullRefresh(
  ctx: Ctx,
  options: { providerId: string },
): Promise<RefreshStarted> {
  const stub = ctx.env.FULL_REFRESH.getByName(options.providerId);
  return stub.start([options.providerId]);
}
