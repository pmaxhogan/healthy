// `effectiveSignIn` picks whichever of two sources -- the sign-in runner's own
// Durable Object phase, or the account row itself -- most recently recorded a
// sign-in outcome. They can diverge: the hourly cron's inline `signInAndWait`
// (worker/sync/portal-sync.ts) writes the account row directly and never
// touches the runner's storage, which only a manual "Sign in now" /
// "Sync upcoming now" job moves (worker/sync/portal-runner.ts). See
// `test/integration/api/portal.test.ts`'s "can report a sign-in port that lags
// behind..." test for the same divergence on the wire.

import { describe, expect, it } from "vitest";

import { effectiveSignIn } from "../../src/lib/use-portal-account.ts";

import { portalAccount } from "./helpers.ts";

/** The account fixture's own `updatedAt`, as unix seconds. */
const ACCOUNT_UPDATED_AT_SECONDS = Math.floor(Date.parse("2026-09-21T11:07:00.000Z") / 1000);

describe("effectiveSignIn", () => {
  it("prefers a live phase over the account row, however stale the row's own state is", () => {
    const dto = portalAccount({
      state: "needs_reauth",
      lastErrorCode: "portal_login_failed",
      signIn: { phase: "awaiting_code", code: null, startedAt: 1, updatedAt: 1 },
    });

    expect(effectiveSignIn(dto)).toStrictEqual({ phase: "awaiting_code", code: null });
  });

  it("prefers the account row's failure once it is newer than the runner's own phase", () => {
    const dto = portalAccount({
      state: "needs_reauth",
      lastErrorCode: "portal_handoff_failed",
      // Never run, or run and long since superseded: the account is the only
      // source with anything newer to say.
      signIn: { phase: "idle", code: null, startedAt: null, updatedAt: null },
    });

    expect(effectiveSignIn(dto)).toStrictEqual({ phase: "failed", code: "portal_handoff_failed" });
  });

  it("reports nothing for an account row that is newer but not failed", () => {
    // A routine cookie-jar save (or any other write) bumps `updatedAt` without
    // meaning "we just signed in" -- only `needs_reauth` is a synthesized
    // "failed"; `active` shows no phase line of its own (it has "Last ok …").
    const dto = portalAccount({
      state: "active",
      lastErrorCode: null,
      signIn: { phase: "idle", code: null, startedAt: null, updatedAt: null },
    });

    expect(effectiveSignIn(dto)).toStrictEqual({ phase: "idle", code: null });
  });

  it("keeps the runner's own failure when it ran more recently than the account row", () => {
    const dto = portalAccount({
      updatedAt: "2026-09-21T11:07:00.000Z",
      state: "needs_reauth",
      lastErrorCode: "portal_login_failed",
      signIn: {
        phase: "failed",
        code: "portal_2fa_rejected",
        startedAt: 1,
        updatedAt: ACCOUNT_UPDATED_AT_SECONDS + 3600,
      },
    });

    expect(effectiveSignIn(dto)).toStrictEqual({ phase: "failed", code: "portal_2fa_rejected" });
  });

  it("breaks a tie in the runner's favour", () => {
    // `PortalSignInRunner.finish` writes the account row and then the phase in
    // the same alarm invocation, so the honest case is a tie, not the account
    // ever landing exactly on the runner's own second by coincidence.
    const dto = portalAccount({
      updatedAt: "2026-09-21T11:07:00.000Z",
      state: "needs_reauth",
      lastErrorCode: "portal_login_failed",
      signIn: {
        phase: "failed",
        code: "portal_2fa_rejected",
        startedAt: 1,
        updatedAt: ACCOUNT_UPDATED_AT_SECONDS,
      },
    });

    expect(effectiveSignIn(dto)).toStrictEqual({ phase: "failed", code: "portal_2fa_rejected" });
  });

  it("falls back to the runner's phase when the account row has never been written", () => {
    const dto = portalAccount({
      updatedAt: null,
      state: "none",
      signIn: { phase: "idle", code: null, startedAt: null, updatedAt: null },
    });

    expect(effectiveSignIn(dto)).toStrictEqual({ phase: "idle", code: null });
  });
});
