// When a failed portal sign-in raises a Trello card, against real D1.
//
// `failSignIn` is the one place both sign-in drivers (the cron's inline wait and
// the admin button's alarm job) record a failure, so it is what is driven here.
// Everything is synthetic: `*.example.test` hosts and invented names.

import { beforeEach, describe, expect, it } from "vitest";

import { failSignIn, portalDeps } from "../../../worker/sync/portal-signin.ts";
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
import type { Ctx } from "../../../worker/db/client.ts";
import type { PortalDeps } from "../../../worker/sync/portal-signin.ts";

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
    expect(fix.upstreams.trelloCards[0]?.name).toBe(
      "Reconnect A Example Health MyChart to Healthy",
    );
    expect(fix.upstreams.trelloCards[0]?.desc).toContain("portal_2fa_required");
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

  it("does not count a different failure in between as a miss", async () => {
    const fix = await fixture();

    await miss(fix);
    await miss(fix, "portal_unreachable");
    await miss(fix);

    expect(fix.upstreams.trelloCards).toStrictEqual([]);
  });
});
