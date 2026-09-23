// The portal session keepalive, against real D1 and a fake portal.
//
// What it exists for: a portal's chart session idles out in less than an hour,
// so a session touched only by the hourly run is dead at every run, and a portal
// that wants an emailed code to sign in again emails the owner every hour. The
// keepalive touches each live session between runs. What matters here is as much
// what it must *not* do:
//
//   - it touches every active account once, and saves the jar only when alive
//   - it never signs in, never asks for a code, never spends an attempt
//   - a dead session is left exactly as it was, for the hourly run to deal with
//   - one account's failure does not stop the next one being kept alive

import { beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../../worker/lib/errors.ts";
import { runPortalKeepalive } from "../../../worker/sync/portal-keepalive.ts";
import { CRON_PORTAL_KEEPALIVE, handleScheduled } from "../../../worker/sync/scheduled.ts";
import { PORTAL_MOUNT, PORTAL_ORIGIN, fakePortal, seedPortalAccount } from "../portal/helpers.ts";

import {
  recordingLog,
  resetSyncDb,
  seedConnectedHealthSystem,
  syncCtx,
  syncEnv,
  syncRepos,
} from "./helpers.ts";

import type { Ctx } from "../../../worker/db/client.ts";
import type { PortalAdapter } from "../../../worker/ehr/mychart/index.ts";
import type { FakePortal } from "../portal/helpers.ts";

beforeEach(resetSyncDb);

/** The cookie the fake portal "refreshes" on every request, as a real one might. */
const REFRESHED = "SyntheticRefreshed";

/**
 * The fake portal, but every client it opens has just been handed a refreshed
 * cookie -- which is what shows whether the keepalive saved the jar afterwards.
 */
function refreshingAdapter(portal: FakePortal): PortalAdapter {
  return {
    ...portal.adapter,
    client: (endpoint, jar, deps) => {
      jar.setCookie(`${PORTAL_ORIGIN}${PORTAL_MOUNT}`, `${REFRESHED}=1; Path=/; Secure`);
      return portal.adapter.client(endpoint, jar, deps);
    },
  };
}

async function seededAccount(
  ctx: Ctx,
  host: string,
  options: { active?: boolean } = {},
): Promise<string> {
  const healthSystem = await seedConnectedHealthSystem(ctx, { host });
  await seedPortalAccount(ctx, healthSystem.healthSystemId, options);
  return healthSystem.healthSystemId;
}

async function storedJar(ctx: Ctx, healthSystemId: string): Promise<string | null> {
  const secrets = await syncRepos(ctx).portalAccounts.getSecrets(healthSystemId);
  return secrets?.cookieJar ?? null;
}

describe("the portal keepalive", () => {
  it("touches a live session once and saves the jar it came back with", async () => {
    const ctx = syncCtx();
    const healthSystemId = await seededAccount(ctx, "fhir.a.example.test");
    const portal = fakePortal({ alive: true });

    const summary = await runPortalKeepalive(ctx, { portalAdapter: refreshingAdapter(portal) });

    expect(summary).toStrictEqual({ accounts: 1, alive: 1 });
    expect(portal.calls.sessionChecks).toBe(1);
    expect(await storedJar(ctx, healthSystemId)).toContain(REFRESHED);
  });

  it("never signs in, and leaves a dead session exactly as it was", async () => {
    const ctx = syncCtx();
    const healthSystemId = await seededAccount(ctx, "fhir.a.example.test");
    const before = await syncRepos(ctx).portalAccounts.get(healthSystemId);
    const portal = fakePortal({ alive: false, loginStatus: "awaiting_code" });

    const summary = await runPortalKeepalive(ctx, { portalAdapter: refreshingAdapter(portal) });

    expect(summary).toStrictEqual({ accounts: 1, alive: 0 });
    expect(portal.calls.logins).toBe(0);
    expect(portal.calls.sendCodes).toBe(0);
    // A dead jar is not saved over whatever a concurrent sign-in may be writing.
    expect(await storedJar(ctx, healthSystemId)).not.toContain(REFRESHED);
    const after = await syncRepos(ctx).portalAccounts.get(healthSystemId);
    expect(after?.session_state).toBe("active");
    expect(after?.login_attempts_today).toBe(0);
    expect(after?.cookie_jar_enc).toBe(before?.cookie_jar_enc);
  });

  it("skips an account that is not active", async () => {
    const ctx = syncCtx();
    await seededAccount(ctx, "fhir.a.example.test", { active: false });
    const portal = fakePortal({ alive: true });

    const summary = await runPortalKeepalive(ctx, { portalAdapter: portal.adapter });

    expect(summary).toStrictEqual({ accounts: 0, alive: 0 });
    expect(portal.calls.sessionChecks).toBe(0);
  });

  it("keeps the next account alive when one of them fails", async () => {
    const ctx = syncCtx();
    const first = await seededAccount(ctx, "fhir.a.example.test");
    const second = await seededAccount(ctx, "fhir.b.example.test");
    const portal = fakePortal({ alive: true });
    let opened = 0;
    const adapter: PortalAdapter = {
      ...portal.adapter,
      client: (endpoint, jar, deps) => {
        opened += 1;
        if (opened === 1) throw new AppError("portal_unreachable", "synthetic outage");
        return refreshingAdapter(portal).client(endpoint, jar, deps);
      },
    };

    const summary = await runPortalKeepalive(ctx, { portalAdapter: adapter });

    expect(summary).toStrictEqual({ accounts: 2, alive: 1 });
    const jars = [await storedJar(ctx, first), await storedJar(ctx, second)];
    expect(jars.filter((jar) => jar?.includes(REFRESHED) === true)).toHaveLength(1);
  });

  it("logs the health system and whether it was alive, and never a cookie or the portal", async () => {
    const { log, lines } = recordingLog();
    const ctx = syncCtx({ log });
    await seededAccount(ctx, "fhir.a.example.test");

    await runPortalKeepalive(ctx, { portalAdapter: refreshingAdapter(fakePortal()) });

    const all = lines.join("\n");
    expect(all).toContain('"event":"portal.keepalive"');
    expect(all).toContain('"alive":true');
    expect(all).not.toContain(REFRESHED);
    expect(all).not.toContain(PORTAL_ORIGIN);
  });

  it("is what the ten-minute cron runs", async () => {
    const ctx = syncCtx();
    await seededAccount(ctx, "fhir.a.example.test");
    const portal = fakePortal({ alive: true });
    const deferred: Promise<unknown>[] = [];
    const ectx = {
      waitUntil: (promise: Promise<unknown>) => {
        deferred.push(promise);
      },
      props: {},
    } as unknown as ExecutionContext;

    await handleScheduled(syncEnv(), CRON_PORTAL_KEEPALIVE, ectx, {
      portalAdapter: portal.adapter,
    });

    expect(portal.calls.sessionChecks).toBe(1);
    expect(portal.calls.logins).toBe(0);
    // Nothing is left running behind the handler's back.
    expect(deferred).toStrictEqual([]);
  });
});
