/**
 * The Durable Object that signs in to a patient portal while the owner watches.
 *
 * ### Why an alarm loop and not `waitUntil`
 *
 * A portal sign-in usually needs a code the portal emails, so it is not a request
 * that can be awaited: the code arrives seconds to minutes later, in
 * `mail_inbox`, via the inbound email handler. Work handed to a request's
 * `ctx.waitUntil` is cancelled about thirty seconds after the response is
 * written -- mid-`await`, with the invocation still reported as `ok` -- so a
 * sign-in started that way would silently stop in the middle, having already
 * spent an attempt and asked the portal for a code nobody will ever submit.
 *
 * So `POST /api/providers/:id/portal/sign-in` stores a job here and answers 202.
 * Each alarm invocation does **one** step -- log in, or look once for the code --
 * and re-arms ten seconds later while there is more to do. No invocation ever
 * sleeps, every one gets a fresh deadline, and the job is durable, so a step that
 * dies is a failed job rather than a lost one.
 *
 * ### One object per provider, and two storage keys
 *
 * The object is addressed by provider id, so two health systems sign in
 * independently and pressing the button twice for one of them is a no-op rather
 * than two interleaved sign-ins that would burn the daily attempt budget between
 * them.
 *
 *   - `job` is the work in flight, and is deleted the moment it ends.
 *   - `phase` is what the admin UI polls, and **outlives** the job: after a
 *     sign-in the owner is still looking at the card, and "it failed, with this
 *     code" has to survive long enough to be read.
 *
 * Only a real sign-in moves `phase`. A manual portal sync whose session is
 * already alive does not touch it -- its progress is a `run_log` row, which is
 * what the Runs page is for. A manual sync that *does* have to sign in first moves
 * the phase exactly as the button would, because that is what is happening.
 *
 * ### Nothing here ever rethrows
 *
 * `runner.ts` deliberately lets a storage throw propagate so the platform retries
 * the chunk; that is safe because a refresh chunk is idempotent. A login is not:
 * a retried alarm would spend a second attempt against the portal's lockout
 * counter for the same button press. So every step is wrapped, and any throw
 * becomes `phase: "failed"` with a stable code and a job that is over.
 *
 * Stored state is a provider id, a step name, counts and stable codes. Never the
 * emailed code, never a credential, never anything from the portal's HTML.
 */

import { DurableObject } from "cloudflare:workers";

import { makeCtx } from "../db/client.ts";
import { isAppError } from "../lib/errors.ts";
import { errorFields, makeLogger } from "../lib/log.ts";
import { nowSeconds } from "../lib/time.ts";

import { runCalendarSync } from "./calendar-sync.ts";
import {
  OTP_POLL_SECONDS,
  OTP_WAIT_SECONDS,
  attemptsLeft,
  claimCode,
  completeSignIn,
  failSignIn,
  markSessionActive,
  openPortalSession,
  persistQuietly,
  portalDeps,
  startSignIn,
} from "./portal-signin.ts";

import type { PortalDeps } from "./portal-signin.ts";
import type { Ctx } from "../db/client.ts";
import type { Env } from "../env.ts";
import type { PortalSignInPhase, PortalSignInState } from "@shared/types.ts";

/** The job in flight. Absent means nothing is running for this provider. */
const JOB_KEY = "job";
/** The last sign-in's progress, which outlives the job. See the header. */
const PHASE_KEY = "phase";

/** How many times the alarm looks for the emailed code before giving up. */
const MAX_POLLS = Math.ceil(OTP_WAIT_SECONDS / OTP_POLL_SECONDS);

/**
 * When a stored job is treated as abandoned rather than as one in flight.
 *
 * Generously longer than the longest real job (a four-minute code wait plus a
 * sync), and it exists only so that a job whose alarm somehow never fired cannot
 * make the button answer `started: false` for ever.
 */
const JOB_STALE_SECONDS = 15 * 60;

/** What the phase reads before anything has ever run. */
const IDLE: PortalSignInState = { phase: "idle", code: null, startedAt: null, updatedAt: null };

/** Which button queued this job. */
type PortalJobKind = "sign_in" | "sync";

/** Where in the flow the next alarm picks up. */
type PortalJobStep = "begin" | "poll" | "sync";

interface PortalJob {
  providerId: string;
  kind: PortalJobKind;
  step: PortalJobStep;
  /** Unix second `SendCode` was called: the floor for claiming a code. */
  sendCodeAt: number | null;
  polls: number;
  startedAt: number;
  /** Run the portal sync once a session exists. True for a queued sync. */
  thenSync: boolean;
}

/** What one step decided: the job to keep, and how long to wait for it. */
interface StepResult {
  job: PortalJob | null;
  delayMs: number;
}

/** What `start` tells the caller. False means one was already in flight. */
export interface PortalJobStarted {
  started: boolean;
}

export class PortalSignInRunner extends DurableObject<Env> {
  private async step(dbCtx: Ctx, job: PortalJob, deps: PortalDeps): Promise<StepResult> {
    switch (job.step) {
      case "begin": {
        return await this.begin(dbCtx, job, deps);
      }
      case "poll": {
        return await this.poll(dbCtx, job, deps);
      }
      default: {
        // The portal-only calendar run, with the code wait disabled: the session is
        // live by the time this step is reached, and this invocation must not be the
        // one that starts waiting for an email.
        await runCalendarSync(dbCtx, {
          providerIds: [job.providerId],
          trigger: "manual",
          portalOnly: true,
          // Zero, not the default: the session is live by the time this step runs,
          // and this invocation must not be the one that starts waiting for an
          // email if it turns out not to be.
          signInWaitSeconds: 0,
        });
        return { job: null, delayMs: 0 };
      }
    }
  }

  /** Log in, and ask for a code if the portal wants one. */
  private async begin(dbCtx: Ctx, job: PortalJob, deps: PortalDeps): Promise<StepResult> {
    if (job.kind === "sync") {
      const opened = await openPortalSession(dbCtx, job.providerId, deps);
      if (await opened.session.client.isSessionAlive()) {
        // Nothing to sign in to, so the phase is left exactly as it was.
        return { job: { ...job, step: "sync" }, delayMs: 0 };
      }
    }

    const left = await attemptsLeft(dbCtx, job.providerId);
    if (left <= 0) {
      return await this.finish(dbCtx, job, "portal_attempts_exhausted", deps);
    }

    await this.setPhase(job, "logging_in", null);
    const opened = await openPortalSession(dbCtx, job.providerId, deps);
    const { sendCodeAt } = await startSignIn(
      dbCtx,
      job.providerId,
      opened.session,
      opened.credentials,
    );
    // Whatever the login left in the jar, including the challenge page's cookies:
    // the next step is a different invocation with a different client, and it can
    // only see what was sealed here.
    await persistQuietly(dbCtx, job.providerId, opened.session);

    if (sendCodeAt === null) {
      await markSessionActive(dbCtx, job.providerId, opened.session);
      await this.setPhase(job, "signed_in", null);
      return { job: job.thenSync ? { ...job, step: "sync" } : null, delayMs: 0 };
    }
    await this.setPhase(job, "awaiting_code", null);
    return {
      job: { ...job, step: "poll", sendCodeAt },
      delayMs: OTP_POLL_SECONDS * 1000,
    };
  }

  /** Look once for the emailed code, and submit it if it has arrived. */
  private async poll(dbCtx: Ctx, job: PortalJob, deps: PortalDeps): Promise<StepResult> {
    const sendCodeAt = job.sendCodeAt ?? job.startedAt;
    const claimed = await claimCode(dbCtx, job.providerId, sendCodeAt);
    if (claimed === null) {
      const polls = job.polls + 1;
      if (polls >= MAX_POLLS) {
        dbCtx.log.warn("portal.signin.code_timeout", {
          providerId: job.providerId,
          waitSeconds: OTP_WAIT_SECONDS,
        });
        return await this.finish(dbCtx, job, "portal_2fa_required", deps);
      }
      return { job: { ...job, polls }, delayMs: OTP_POLL_SECONDS * 1000 };
    }

    await this.setPhase(job, "validating", null);
    // A fresh session, deliberately: this is a new invocation, and the jar the
    // login sealed is the only thing that carries the challenge page's cookies.
    const opened = await openPortalSession(dbCtx, job.providerId, deps);
    await completeSignIn(dbCtx, job.providerId, opened.session, claimed);
    await this.setPhase(job, "signed_in", null);
    return { job: job.thenSync ? { ...job, step: "sync" } : null, delayMs: 0 };
  }

  /** Record a failed job: the phase, the account's state, and maybe a Trello card. */
  private async finish(
    dbCtx: Ctx,
    job: PortalJob,
    code: string,
    deps: PortalDeps,
  ): Promise<StepResult> {
    await failSignIn(dbCtx, job.providerId, code, deps);
    await this.setPhase(job, "failed", code);
    return { job: null, delayMs: 0 };
  }

  private async setPhase(
    job: PortalJob,
    phase: PortalSignInPhase,
    code: string | null,
  ): Promise<void> {
    await this.ctx.storage.put<PortalSignInState>(PHASE_KEY, {
      phase,
      code,
      startedAt: job.startedAt,
      updatedAt: nowSeconds(),
    });
  }

  /**
   * Queue a job for this object's provider and return.
   *
   * A storage write and an alarm, so the route can await it and still answer 202
   * well inside any deadline. The daily attempt budget is checked by the route --
   * which has somewhere to report a 429 -- and again by the first step, because a
   * job can sit in storage while another run spends the last attempt.
   */
  async start(providerId: string, kind: PortalJobKind): Promise<PortalJobStarted> {
    const existing = await this.ctx.storage.get<PortalJob>(JOB_KEY);
    if (existing !== undefined && nowSeconds() - existing.startedAt < JOB_STALE_SECONDS) {
      return { started: false };
    }
    await this.ctx.storage.put<PortalJob>(JOB_KEY, {
      providerId,
      kind,
      step: "begin",
      sendCodeAt: null,
      polls: 0,
      startedAt: nowSeconds(),
      // A queued sync signs in only if it has to, and then carries on to the sync.
      thenSync: kind === "sync",
    });
    await this.ctx.storage.setAlarm(Date.now());
    return { started: true };
  }

  /** What the admin UI polls. The default is "nothing has ever run". */
  async state(): Promise<PortalSignInState> {
    return (await this.ctx.storage.get<PortalSignInState>(PHASE_KEY)) ?? IDLE;
  }

  /** One step, then either re-arm or stop. Never throws -- see the header. */
  override async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<PortalJob>(JOB_KEY);
    if (job === undefined) return;
    const log = makeLogger({ src: "portal" });
    const dbCtx: Ctx = makeCtx(this.env.DB, this.env, { log });
    const deps = portalDeps();

    try {
      const result = await this.step(dbCtx, job, deps);
      if (result.job === null) {
        await this.ctx.storage.delete(JOB_KEY);
        return;
      }
      await this.ctx.storage.put<PortalJob>(JOB_KEY, result.job);
      await this.ctx.storage.setAlarm(Date.now() + result.delayMs);
    } catch (error) {
      log.warn("portal.job_failed", { providerId: job.providerId, ...errorFields(error) });
      await this.finish(dbCtx, job, isAppError(error) ? error.code : "internal", deps);
      // The job is over either way: a retried alarm would spend a second login
      // attempt on one button press. See the header.
      await this.ctx.storage.delete(JOB_KEY);
    }
  }
}

/** The object for one provider. One per provider; see the header. */
function runnerFor(ctx: Ctx, providerId: string): DurableObjectStub<PortalSignInRunner> {
  return ctx.env.PORTAL_SIGNIN.getByName(providerId);
}

/** Queue a sign-in for one provider. Returns as soon as the job is durable. */
export async function startPortalSignIn(
  ctx: Ctx,
  options: { providerId: string },
): Promise<PortalJobStarted> {
  return runnerFor(ctx, options.providerId).start(options.providerId, "sign_in");
}

/**
 * Queue a portal sync for one provider.
 *
 * Not `afterResponse`: a portal sync may have to re-establish the session, which
 * is minutes of waiting for an emailed code, and a request's `waitUntil` is
 * cancelled long before that. The job signs in through the same alarm loop the
 * button uses and then runs a portal-only calendar run.
 */
export async function startPortalSync(
  ctx: Ctx,
  options: { providerId: string },
): Promise<PortalJobStarted> {
  return runnerFor(ctx, options.providerId).start(options.providerId, "sync");
}

/** The sign-in progress the admin UI polls for. */
export async function portalSignInState(
  ctx: Ctx,
  options: { providerId: string },
): Promise<PortalSignInState> {
  return runnerFor(ctx, options.providerId).state();
}
