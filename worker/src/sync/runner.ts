/**
The Durable Object that actually finishes a manual full refresh.

### Why this exists

`POST /api/health-systems/:id/full-refresh` answers 202 and used to hand the whole
refresh to `ctx.waitUntil`. Work in `waitUntil` is cancelled about thirty seconds
after the response is written -- mid-`await`, with the invocation still reported
as `ok` -- so a health system whose record takes longer than that got half a cache, no
`last_full_refresh_at`, and a `run_log` row left open forever. Nothing inside a
cancelled invocation can clean up after itself: there is no `catch`, no `finally`
and no alarm, because there is no isolate.

An alarm is the way out. The route stores a job here and returns; the alarm runs
in its *own* invocation, does one budgeted chunk of the refresh, and re-arms
itself while there is more to do. Each chunk gets a fresh thirty seconds and we
only ever ask it for twenty, so no single invocation is ever near the edge.

Two properties this leans on, and both are why it is a Durable Object rather than
a self-`fetch`: the job is durable, so a chunk that dies is retried rather than
lost, and reaching it needs no HTTP and therefore no second front door past
Cloudflare Access.

### One object per health system

The object is addressed by health system id, so two health systems refresh independently
and pressing the button twice for the *same* health system is a no-op rather than two
interleaved refreshes of one record. `start` says which happened.

Nothing personal is stored: a job is health system ids, a run id, counts and Epic
codes. Same rule as the run log, for the same reason.

### The second kind of job: a calendar sync asked for over MCP

The MCP tool `sync_health_systems` can ask for the ordinary sync (the hourly
run, narrowed to some health systems) or for the patient-portal pass alone.
Neither can run where the tool runs: a tool call is answered from a Durable
Object session or from an admin request, and the sync must outlive both. So
it is queued here as a `calendar` job on one object of its own, addressed by
`CALENDAR_SYNC_OBJECT` rather than by a health system id: **one** job for the
whole selection, because the calendar run decides which copy of a visit two
organisations both list gets the event, and it can only decide that inside
one run (see `runPortalPass`). One alarm runs `runCalendarSync` once.

It is always run with `signInWaitSeconds: 0`, so the portal pass uses a
session that is already live and **never signs in**: a dead session is
recorded as `portal_session_expired` and costs no attempt and no emailed
code. It never passes `force`, so a rate-limit backoff still holds.

`busy()` is what lets the tool report a job in flight without starting one.
*/

import { DurableObject } from "cloudflare:workers";

import { makeCtx } from "../db/client.ts";
import { errorFields, makeLogger } from "../lib/log.ts";
import { nowSeconds } from "../lib/time.ts";

import { runCalendarSync } from "./calendar-sync.ts";
import { CHUNK_BUDGET_MS, runFullRefreshChunk } from "./full-refresh.ts";
import { abandon } from "./run.ts";

import type { RefreshJob } from "./full-refresh.ts";
import type { RunStateSnapshot } from "./run.ts";
import type { Ctx } from "../db/client.ts";
import type { Env } from "../env.ts";

/** The single storage key. One object holds at most one job; see the header. */
const JOB_KEY = "job";

/**
A backstop against a *stuck* alarm, not a ceiling on how much a refresh may
fetch.

`runFullRefreshChunk` guarantees forward progress every chunk it is handed --
`fhirSyncState.record` stamps every (health system, resource type) pair it attempts
as done for the cycle, on failure exactly as on success, so a chunk that does
not finish the whole job still shrinks what is left of it. A record with an
unusually large history (or, now that FHIR search paging has no page cap
either, an unusually large single resource type) legitimately needs more
chunks, and that is not a reason to stop: it is exactly what re-arming the
alarm is for. This number exists only so that a *bug* which somehow broke that
guarantee -- a chunk that spins without ever calling `record` -- eventually
stops re-arming a Durable Object forever rather than running up Cloudflare
billing unnoticed. At twenty seconds a chunk, reaching it is many hours away.
*/
const MAX_CHUNKS = 2000;

/**
The name of the one object that runs calendar syncs asked for over MCP.

Not a health system id and never mistakable for one: an id this app mints
has no hyphen in it.
*/
const CALENDAR_SYNC_OBJECT = "mcp-calendar-sync";

/** A job plus how many chunks it has already had. */
interface StoredJob extends RefreshJob {
  chunks: number;
  /**
  Present on a calendar sync job; absent on a full refresh, which is every job
  stored before this field existed.
  */
  calendar?: { portalOnly: boolean };
}

/** What `start` tells the caller. False means one was already in flight. */
export interface RefreshStarted {
  started: boolean;
}

export class FullRefreshRunner extends DurableObject<Env> {
  /**
  The calendar job: one run, at most once.

  `runCalendarSync` never throws and writes its own run row. The job is kept
  while it runs, which is what makes `busy()` true for its length, and marked
  before the run starts: an alarm the platform delivers again, because the
  invocation that held the run died, finds the mark and drops the job instead
  of running the sync a second time. The run row that invocation left open is
  closed by the sweep at the head of the next run.
  */
  private async runCalendarJob(job: StoredJob, portalOnly: boolean): Promise<void> {
    const log = makeLogger({ src: "sync.requested" });
    if (job.chunks > 0) {
      await this.ctx.storage.delete(JOB_KEY);
      log.warn("sync.requested.abandoned", { healthSystems: job.pending.length });
      return;
    }
    await this.ctx.storage.put<StoredJob>(JOB_KEY, { ...job, chunks: 1 });
    const ctx: Ctx = makeCtx(this.env.DB, this.env, { log });
    try {
      const summary = await runCalendarSync(ctx, {
        healthSystemIds: [...job.pending],
        trigger: "manual",
        portalOnly,
        // Zero: use a live portal session or none. See the header.
        signInWaitSeconds: 0,
      });
      log.info("sync.requested.done", {
        healthSystems: job.pending.length,
        portalOnly,
        errors: summary.errors.length,
        portalErrors: summary.portalErrors.length,
        backedOff: summary.backedOff,
      });
    } finally {
      await this.ctx.storage.delete(JOB_KEY);
    }
  }

  /**
  Queue a refresh for this object's health system and return.

  Fast by construction -- a storage write and an alarm -- so the route can await
  it and still answer 202 well inside any deadline.
  */
  async start(healthSystemIds: readonly string[]): Promise<RefreshStarted> {
    const existing = await this.ctx.storage.get<StoredJob>(JOB_KEY);
    if (existing !== undefined) return { started: false };
    await this.ctx.storage.put<StoredJob>(JOB_KEY, {
      pending: [...healthSystemIds],
      cycleStartedAt: nowSeconds(),
      runId: null,
      state: null,
      chunks: 0,
    });
    await this.ctx.storage.setAlarm(Date.now());
    return { started: true };
  }

  /**
  Queue one calendar sync over `healthSystemIds` and return.

  `started: false` means a job is already stored on this object. See the
  header for why this is one job and not one per health system.
  */
  async startCalendar(
    healthSystemIds: readonly string[],
    options: { portalOnly: boolean },
  ): Promise<RefreshStarted> {
    const existing = await this.ctx.storage.get<StoredJob>(JOB_KEY);
    if (existing !== undefined) return { started: false };
    await this.ctx.storage.put<StoredJob>(JOB_KEY, {
      pending: [...healthSystemIds],
      cycleStartedAt: nowSeconds(),
      runId: null,
      state: null,
      chunks: 0,
      calendar: { portalOnly: options.portalOnly },
    });
    await this.ctx.storage.setAlarm(Date.now());
    return { started: true };
  }

  /** Whether a job is stored on this object: queued, running or waiting to re-arm. */
  async busy(): Promise<boolean> {
    return (await this.ctx.storage.get<StoredJob>(JOB_KEY)) !== undefined;
  }

  /**
  One chunk, then either re-arm or finish.

  `runFullRefreshChunk` never throws and writes its own run row, so there is
  nothing here to catch on its behalf. A throw from *storage* is left to
  propagate on purpose: the platform retries a failed alarm, the job is still
  there, and a retry is exactly the right answer.
  */
  override async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<StoredJob>(JOB_KEY);
    if (job === undefined) return;
    if (job.calendar !== undefined) {
      await this.runCalendarJob(job, job.calendar.portalOnly);
      return;
    }
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
Hand one health system's full refresh to its runner.

This is what the admin API calls. It is not `runFullRefresh`: it returns as soon
as the job is durable, and the refresh itself happens in alarm invocations that
outlive the request by minutes if it needs them.
*/
export async function startFullRefresh(
  ctx: Ctx,
  options: { healthSystemId: string },
): Promise<RefreshStarted> {
  const stub = ctx.env.FULL_REFRESH.getByName(options.healthSystemId);
  return stub.start([options.healthSystemId]);
}

/** Whether a full refresh is queued or running for one health system. */
export async function fullRefreshBusy(
  ctx: Ctx,
  options: { healthSystemId: string },
): Promise<boolean> {
  return ctx.env.FULL_REFRESH.getByName(options.healthSystemId).busy();
}

/**
Queue one calendar sync over some health systems, on the object that runs
them one at a time. See the header: it never signs in to a portal.

`portalOnly` skips every FHIR search and runs the patient-portal pass alone.
*/
export async function startCalendarSync(
  ctx: Ctx,
  options: { healthSystemIds: readonly string[]; portalOnly: boolean },
): Promise<RefreshStarted> {
  const stub = ctx.env.FULL_REFRESH.getByName(CALENDAR_SYNC_OBJECT);
  return stub.startCalendar([...options.healthSystemIds], { portalOnly: options.portalOnly });
}

/** Whether a calendar sync asked for over MCP is queued or running. */
export async function calendarSyncBusy(ctx: Ctx): Promise<boolean> {
  return ctx.env.FULL_REFRESH.getByName(CALENDAR_SYNC_OBJECT).busy();
}
