// Polls a provider's portal sign-in state after "Sign in now" is pressed.
//
// Same shape as RunsView's own poll (3 s ticks, a capped total so a sign-in
// that never resolves does not poll forever) because it is the same problem: a
// 202 starts work that outlives the response, and the state that matters only
// shows up on a GET made later.

import { onUnmounted, ref } from "vue";

import { endpoints, isPortalSignInInProgress } from "../api/endpoints.ts";

import { useLoad } from "./use-load.ts";

import type { Loadable } from "./use-load.ts";
import type {
  PortalAccountDto,
  PortalAccountStatusDto,
  PortalSignInPhase,
  PortalSignInState,
} from "@shared/types.ts";
import type { Ref } from "vue";

/** How often to ask again while a sign-in is still going. */
const POLL_INTERVAL_MS = 3000;
/** Give up after this long. A sign-in stuck past it needs a human, not a poll. */
const POLL_MAX_MS = 5 * 60 * 1000;

/**
 * Whether the account row itself was written more recently than the sign-in
 * runner's own last phase change.
 *
 * The runner's `PHASE_KEY` (`PortalSignInState`) only moves when a job runs
 * through `worker/sync/portal-runner.ts`'s alarm loop -- a manual "Sign in now"
 * or "Sync upcoming now". The hourly cron's inline `signInAndWait` (see
 * `worker/sync/portal-sync.ts`) writes the account row directly and never
 * touches the runner's storage at all, so the two can describe two different
 * attempts: a stale manual failure sitting in the runner while a *newer* cron
 * pass has since succeeded or failed differently, or vice versa.
 *
 * Ties go to the runner: a job's last step writes the account row and then the
 * phase in the same alarm invocation (see `PortalSignInRunner.finish`), so the
 * two only ever land on the same second when nothing has run since.
 */
function accountIsNewer(account: PortalAccountDto, signIn: PortalSignInState): boolean {
  return (
    account.updatedAt !== null &&
    (signIn.updatedAt === null || Date.parse(account.updatedAt) > signIn.updatedAt * 1000)
  );
}

/**
 * The phase and code to show for the *freshest* known sign-in outcome,
 * whichever of the runner or the account row last recorded one.
 *
 * A live phase (`logging_in`/`awaiting_code`/`validating`) always wins over the
 * account row: it means a job is genuinely running right now, through whichever
 * driver, and the account row has no way to express "in progress" at all. Once
 * the runner's own phase is a terminal one (`idle`/`signed_in`/`failed`) and the
 * account row has since moved past it, the account's own state -- `needs_reauth`
 * with `lastErrorCode`, or anything else -- is what actually happened last, so
 * it is synthesized into the same shape rather than the runner's stale phase.
 * `active` reports no phase of its own here: that outcome already has its own
 * line ("Last ok …"), and a synthetic "signed in" would otherwise reappear
 * forever after every routine cookie-jar save, not just a real sign-in.
 */
export function effectiveSignIn(dto: PortalAccountStatusDto): {
  phase: PortalSignInPhase;
  code: string | null;
} {
  const { signIn } = dto;
  if (isPortalSignInInProgress(signIn.phase)) return { phase: signIn.phase, code: signIn.code };
  if (!accountIsNewer(dto, signIn)) return { phase: signIn.phase, code: signIn.code };
  return dto.state === "needs_reauth"
    ? { phase: "failed", code: dto.lastErrorCode }
    : { phase: "idle", code: null };
}

export interface PortalAccountHandle {
  account: Loadable<PortalAccountStatusDto>;
  /** True while the poll started by `pollSignIn` is still running. */
  polling: Ref<boolean>;
  /** Starts polling `GET .../portal` every few seconds while sign-in is in progress. */
  pollSignIn: () => void;
}

export function usePortalAccount(providerId: string): PortalAccountHandle {
  const account = useLoad((signal) => endpoints.portalAccount(providerId, signal));

  const polling = ref(false);

  // A plain mutable object rather than top-level `let`s, for the same reason
  // RunsView's own poll state is one: both fields are reassigned from inside
  // the functions below.
  const poll: { handle: ReturnType<typeof setInterval> | null; deadline: number } = {
    handle: null,
    deadline: 0,
  };

  function stop(): void {
    if (poll.handle === null) return;
    clearInterval(poll.handle);
    poll.handle = null;
    polling.value = false;
  }

  async function tick(): Promise<void> {
    if (Date.now() >= poll.deadline) {
      stop();
      return;
    }
    let latest: PortalAccountStatusDto;
    try {
      latest = await endpoints.portalAccount(providerId);
    } catch {
      // A transient failure just waits for the next tick -- a real problem is
      // still there next time, and the owner can always reload the page.
      return;
    }
    account.set(latest);
    if (!isPortalSignInInProgress(latest.signIn.phase)) stop();
  }

  function pollSignIn(): void {
    if (poll.handle !== null) return;
    polling.value = true;
    poll.deadline = Date.now() + POLL_MAX_MS;
    poll.handle = setInterval(() => void tick(), POLL_INTERVAL_MS);
  }

  onUnmounted(stop);

  return { account, polling, pollSignIn };
}
