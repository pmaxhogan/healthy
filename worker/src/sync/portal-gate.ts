/**
 * The single gate every portal sign-in passes through.
 *
 * There are two drivers -- the admin button's Durable Object alarm loop
 * (`portal-runner.ts`) and the hourly cron's inline `signInAndWait`
 * (`portal-sync.ts`) -- and only the first of them used to serialise anything.
 * `start()` deduplicated its own jobs, so pressing the button twice was a no-op,
 * but a cron pass was outside that: two overlapping sign-ins for one health system
 * could each read `attemptsLeft` before either incremented it, overshoot the
 * daily budget meant to keep the portal from locking the account, and -- worse --
 * the second `SendCode` would invalidate the code the first one was waiting for.
 *
 * So the lock lives in the Durable Object, which is the one place per health system
 * that is guaranteed single-threaded, and both drivers take it. The DO's own job
 * holds it for the life of the job; cron takes it around `signInAndWait` and
 * releases it in a `finally`.
 *
 * ### Why this is a separate module from `portal-runner.ts`
 *
 * `portal-runner.ts` imports `calendar-sync.ts`, which imports `portal-sync.ts`,
 * so `portal-sync.ts` importing `portal-runner.ts` would close an import cycle
 * (`import-x/no-cycle` is an error here, and a cycle through a module that
 * registers a Durable Object class is not something to be relaxed about). Nothing
 * needs importing anyway: `ctx.env.PORTAL_SIGNIN` is already typed as a namespace
 * of `PortalSignInRunner` by the generated `worker-configuration.d.ts`, so the
 * two RPC methods below typecheck with no import at all.
 */

import { errorFields } from "../lib/log.ts";

import type { Ctx } from "../db/client.ts";

/** What `portalErrors` carries when the gate was already held. */
export const SIGN_IN_BUSY_CODE = "portal_signin_busy";

/**
 * Take the sign-in gate for one health system.
 *
 * False means another driver holds it -- the owner pressed the button while the
 * hourly run was signing in, or the reverse. The correct answer for the loser is
 * to do nothing: the sign-in in flight will either establish the session (so the
 * next pass finds it alive) or fail and say so.
 *
 * A gate held by a driver that died is released by its own staleness timeout in
 * the Durable Object, so this can never wedge a health system permanently.
 */
export async function acquirePortalSignIn(
  ctx: Ctx,
  healthSystemId: string,
  holder: string,
): Promise<boolean> {
  return ctx.env.PORTAL_SIGNIN.getByName(healthSystemId).acquireSignIn(holder);
}

/**
 * Release it. Never throws.
 *
 * Called from a `finally`, where a throw would replace the outcome the caller is
 * about to report with a storage failure nobody can act on. The staleness timeout
 * is the backstop if this does not land.
 */
export async function releasePortalSignIn(ctx: Ctx, healthSystemId: string): Promise<void> {
  try {
    await ctx.env.PORTAL_SIGNIN.getByName(healthSystemId).releaseSignIn();
  } catch (error) {
    ctx.log.warn("portal.signin_gate_release_failed", { healthSystemId, ...errorFields(error) });
  }
}
