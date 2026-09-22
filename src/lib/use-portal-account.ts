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
import type { PortalAccountStatusDto } from "@shared/types.ts";
import type { Ref } from "vue";

/** How often to ask again while a sign-in is still going. */
const POLL_INTERVAL_MS = 3000;
/** Give up after this long. A sign-in stuck past it needs a human, not a poll. */
const POLL_MAX_MS = 5 * 60 * 1000;

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
