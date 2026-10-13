// When a failed portal sign-in raises a Trello card, against real D1.
//
// `failSignIn` is the one place both sign-in drivers (the cron's inline wait and
// the admin button's alarm job) record a failure, so it is what is driven here.
// Everything is synthetic: `*.example.test` hosts and invented names.

import { beforeEach, describe, expect, it } from "vitest";

import { failSignIn, portalDeps } from "../../../src/sync/portal-signin.ts";
import { seedPortalAccount } from "../portal/helpers.ts";

import {
  fhirServer,
  resetSyncDb,
  seedConnectedHealthSystem,
  stubUpstreams,
  syncCtx,
  syncRepos,
} from "./helpers.ts";

import type { Upstreams } from "./helpers.ts";
import type { Ctx } from "../../../src/db/client.ts";
import type { PortalDeps } from "../../../src/sync/portal-signin.ts";

beforeEach(resetSyncDb);

const HOST = "fhir.a.example.test";

interface Fixture {
  ctx: Ctx;
  healthSystemId: string;
  upstreams: Upstreams;
  deps: PortalDeps;
}

async function fixture(): Promise<Fixture> {
  const ctx = syncCtx({ trello: true });
  const healthSystem = await seedConnectedHealthSystem(ctx, {
    host: HOST,
    displayName: "A Example Health",
  });
  await seedPortalAccount(ctx, healthSystem.healthSystemId);
  const upstreams = stubUpstreams({ [HOST]: fhirServer({ patientId: healthSystem.patientId }) });
  return {
    ctx,
    healthSystemId: healthSystem.healthSystemId,
    upstreams,
    deps: portalDeps(upstreams.deps),
  };
}

async function miss(fix: Fixture, code = "portal_2fa_required"): Promise<void> {
  await failSignIn(fix.ctx, fix.healthSystemId, code, fix.deps);
}

describe("a verification code that never arrives", () => {
  it("opens no card the first time", async () => {
    const fix = await fixture();

    await miss(fix);

    expect(fix.upstreams.trelloCards).toStrictEqual([]);
    expect(await syncRepos(fix.ctx).alerts.getOpen(`portal:${fix.healthSystemId}`)).toBeNull();
  });

  it("opens one reconnect card on the second miss in a row, and no more after that", async () => {
    const fix = await fixture();

    await miss(fix);
    await miss(fix);

    expect(fix.upstreams.trelloCards).toHaveLength(1);
    // Not "Reconnect": the password is fine, and the card must not ask for it.
    expect(fix.upstreams.trelloCards[0]?.name).toBe(
      "Sign in to A Example Health patient portal again in Healthy",
    );
    expect(fix.upstreams.trelloCards[0]?.desc).toContain("portal_2fa_required");
    expect(fix.upstreams.trelloCards[0]?.desc).toContain("nothing needs re-entering");
    expect(await syncRepos(fix.ctx).alerts.getOpen(`portal:${fix.healthSystemId}`)).not.toBeNull();

    await miss(fix);
    expect(fix.upstreams.trelloCards).toHaveLength(1);
  });

  it("starts counting again after a successful sign-in", async () => {
    const fix = await fixture();

    await miss(fix);
    await syncRepos(fix.ctx).portalAccounts.markActive(fix.healthSystemId);
    await miss(fix);

    expect(fix.upstreams.trelloCards).toStrictEqual([]);
  });

  it("cards any other failure at once, and a miss after it adds nothing", async () => {
    const fix = await fixture();

    await miss(fix);
    await miss(fix, "portal_unreachable");
    await miss(fix);

    expect(fix.upstreams.trelloCards).toHaveLength(1);
    expect(fix.upstreams.trelloCards[0]?.desc).toContain("portal_unreachable");
  });
});

// A failed sign-in parks the account, and the scheduled sync never signs in to a
// parked one: whatever the code, nothing more happens until the owner acts, so
// every one of these has to reach them.
describe("every way a sign-in fails", () => {
  const RETRY = [
    "portal_unreachable",
    "portal_parse_failed",
    "portal_2fa_rejected",
    "portal_handoff_failed",
    "portal_attempts_exhausted",
    "portal_signin_needs_owner",
    "upstream_unavailable",
    "internal",
  ];
  const OWNER = [
    "portal_login_failed",
    "portal_locked",
    "portal_bot_blocked",
    "portal_captcha_required",
    "portal_code_challenge",
    "portal_origin_unconfirmed",
  ];

  it.each(RETRY)("%s opens a card that asks for a sign-in, not a password", async (code) => {
    const fix = await fixture();

    await miss(fix, code);
    await miss(fix, code);

    expect(fix.upstreams.trelloCards).toHaveLength(1);
    const card = fix.upstreams.trelloCards[0];
    expect(card?.name).toBe("Sign in to A Example Health patient portal again in Healthy");
    expect(card?.desc).toContain(code);
    expect(card?.desc).toContain('press "Sign in now"');
    const alert = await syncRepos(fix.ctx).alerts.getOpen(`portal:${fix.healthSystemId}`);
    expect(alert).toMatchObject({ kind: "reconnect", reason_code: code });
  });

  it.each(OWNER)(
    "%s opens the card that sends the owner to the portal's settings",
    async (code) => {
      const fix = await fixture();

      await miss(fix, code);
      await miss(fix, code);

      expect(fix.upstreams.trelloCards).toHaveLength(1);
      const card = fix.upstreams.trelloCards[0];
      expect(card?.name).toBe("Reconnect A Example Health patient portal to Healthy");
      expect(card?.desc).toContain(code);
    },
  );

  it("still parks the account when Trello refuses the card, and cards it on the next report", async () => {
    const fix = await fixture();
    fix.upstreams.failTrello(401);

    const outcome = await failSignIn(fix.ctx, fix.healthSystemId, "portal_unreachable", fix.deps);

    expect(outcome).toStrictEqual({ phase: "failed", code: "portal_unreachable" });
    const repos = syncRepos(fix.ctx);
    const account = await repos.portalAccounts.get(fix.healthSystemId);
    expect(account?.session_state).toBe("needs_reauth");
    const open = await repos.alerts.getOpen(`portal:${fix.healthSystemId}`);
    expect(open).toMatchObject({ kind: "reconnect", trello_card_id: null });

    fix.upstreams.failTrello(null);
    await miss(fix, "portal_unreachable");
    expect(fix.upstreams.trelloCards).toHaveLength(1);
    const carded = await repos.alerts.getOpen(`portal:${fix.healthSystemId}`);
    expect(carded).toMatchObject({ id: open?.id, trello_card_id: "card-1" });
  });
});
