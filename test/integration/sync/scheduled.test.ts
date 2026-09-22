// Cron dispatch, the token keepalive, and `refreshConnectionToken`.
//
// `handleScheduled` builds its own `Ctx` from the `Env` it is handed, so these
// tests seed against the real clock -- the same one the handler will read -- and
// place their appointments relative to it.

import { beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../../worker/lib/errors.ts";
import { refreshConnectionToken, runTokenKeepalive } from "../../../worker/sync/keepalive.ts";
import { CRON_DAILY, CRON_HOURLY, handleScheduled } from "../../../worker/sync/scheduled.ts";

import {
  clock,
  encounter,
  fhirServer,
  referencePool,
  resetSyncDb,
  searchBundle,
  seedConnectedProvider,
  seedGoogle,
  seedSettings,
  stubUpstreams,
  syncCtx,
  syncEnv,
  syncRepos,
} from "./helpers.ts";

import type { FhirServer, Upstreams } from "./helpers.ts";
import type { Ctx } from "../../../worker/db/client.ts";

beforeEach(resetSyncDb);

const HOST = "fhir.a.example.test";

/**
 * A stand-in ExecutionContext that records what was deferred.
 *
 * The scheduled handler only uses `waitUntil`, and only for the daily retention
 * pruning, so collecting the promises is both the whole implementation and the
 * assertion that the pruning was scheduled at all.
 */
function executionContext(): { ectx: ExecutionContext; deferred: Promise<unknown>[] } {
  const deferred: Promise<unknown>[] = [];
  const ectx = {
    waitUntil: (promise: Promise<unknown>) => {
      deferred.push(promise);
    },
    passThroughOnException: (): void => {
      throw new Error("the scheduled handler does not use passThroughOnException");
    },
    props: {},
  } as unknown as ExecutionContext;
  return { ectx, deferred };
}

interface Harness {
  ctx: Ctx;
  server: FhirServer;
  upstreams: Upstreams;
  providerId: string;
  connectionId: string;
  nowSeconds: number;
}

/** Seeded against the real clock, because `handleScheduled` reads that one. */
async function setup(options: { accessTtlSeconds?: number } = {}): Promise<Harness> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ctx = syncCtx({ now: () => nowSeconds });
  const seeded = await seedConnectedProvider(ctx, {
    host: HOST,
    ...(options.accessTtlSeconds !== undefined && { accessTtlSeconds: options.accessTtlSeconds }),
  });
  await seedGoogle(ctx);
  await seedSettings(ctx);

  const server = fhirServer({ resources: referencePool() });
  server.encounters = searchBundle([
    encounter({ id: "enc-1", start: new Date((nowSeconds + 7 * 86_400) * 1000).toISOString() }),
  ]);
  const upstreams = stubUpstreams({ [HOST]: server });
  return { ctx, server, upstreams, nowSeconds, ...seeded };
}

describe("handleScheduled", () => {
  it("runs the keepalive and then the calendar sync on the hourly cron", async () => {
    const h = await setup();

    await handleScheduled(syncEnv(), CRON_HOURLY, executionContext().ectx, h.upstreams.deps);

    const runs = await syncRepos(h.ctx).runLog.listRecent();
    // Newest first: the calendar sync follows the keepalive.
    expect(runs.map((run) => run.kind)).toStrictEqual(["calendar", "refresh"]);
    expect(runs.every((run) => run.ok === true)).toBe(true);
    expect(h.upstreams.calendar.events()).toHaveLength(1);
  });

  it("runs the full refresh and then a calendar sync on the daily cron", async () => {
    const h = await setup();
    const context = executionContext();

    await handleScheduled(syncEnv(), CRON_DAILY, context.ectx, h.upstreams.deps);

    const runs = await syncRepos(h.ctx).runLog.listRecent();
    expect(runs.map((run) => run.kind)).toStrictEqual(["calendar", "full"]);
    expect(h.upstreams.calendar.events()).toHaveLength(1);
    // Retention pruning is deferred, and only on the daily cron.
    expect(context.deferred).toHaveLength(1);
    await expect(Promise.all(context.deferred)).resolves.toHaveLength(1);
  });

  it("defers nothing on the hourly cron", async () => {
    const h = await setup();
    const context = executionContext();

    await handleScheduled(syncEnv(), CRON_HOURLY, context.ectx, h.upstreams.deps);

    expect(context.deferred).toStrictEqual([]);
  });

  it("logs and ignores a cron nobody wired up", async () => {
    // A schedule added to wrangler.jsonc with no branch here must be a visible
    // no-op, never a guess at which job was meant.
    const h = await setup();

    await handleScheduled(syncEnv(), "*/5 * * * *", executionContext().ectx, h.upstreams.deps);

    await expect(syncRepos(h.ctx).runLog.listRecent()).resolves.toStrictEqual([]);
    expect(h.server.searchCalls).toBe(0);
  });

  it("never throws, whatever the upstreams do", async () => {
    const h = await setup();
    h.server.encounterStatus = 500;

    await expect(
      handleScheduled(syncEnv(), CRON_HOURLY, executionContext().ectx, h.upstreams.deps),
    ).resolves.toBeUndefined();

    const runs = await syncRepos(h.ctx).runLog.listRecent({ kind: "calendar" });
    expect(runs[0]?.ok).toBe(false);
  });
});

describe("runTokenKeepalive", () => {
  it("costs nothing when the tokens are comfortably valid", async () => {
    const h = await setup();

    const summary = await runTokenKeepalive(h.ctx, h.upstreams.deps);

    expect(summary.providers).toBe(1);
    expect(summary.errors).toStrictEqual([]);
    expect(h.server.tokenCalls).toBe(0);
    expect(h.upstreams.googleRefreshes).toBe(0);
  });

  it("refreshes a token that is inside the skew", async () => {
    // Five minutes is the skew, so a token with a minute left is already dead as
    // far as a sync run that is about to page through a search is concerned.
    const h = await setup({ accessTtlSeconds: 60 });

    await runTokenKeepalive(h.ctx, h.upstreams.deps);

    expect(h.server.tokenCalls).toBe(1);
    const secrets = await syncRepos(h.ctx).connections.getSecrets(h.connectionId);
    expect(secrets?.accessToken).toBe("refreshed-access-token");
  });

  it("keeps the Google grant alive too", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ctx = syncCtx({ now: () => nowSeconds });
    await seedConnectedProvider(ctx, { host: HOST });
    await seedGoogle(ctx, 60);
    await seedSettings(ctx);
    const upstreams = stubUpstreams({ [HOST]: fhirServer() });

    const summary = await runTokenKeepalive(ctx, upstreams.deps);

    expect(upstreams.googleRefreshes).toBe(1);
    expect(summary.errors).toStrictEqual([]);
  });

  it("reports a broken connection without failing the others", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ctx = syncCtx({ now: () => nowSeconds });
    const a = await seedConnectedProvider(ctx, {
      host: HOST,
      displayName: "A Example Health",
      accessTtlSeconds: 60,
    });
    const b = await seedConnectedProvider(ctx, {
      host: "fhir.b.example.test",
      displayName: "B Example Health",
    });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    const serverA = fhirServer({ tokenInvalidGrant: true });
    const upstreams = stubUpstreams({
      [HOST]: serverA,
      "fhir.b.example.test": fhirServer(),
    });

    const summary = await runTokenKeepalive(ctx, upstreams.deps);

    expect(summary.errors).toStrictEqual([{ providerId: a.providerId, code: "needs_reauth" }]);
    await expect(syncRepos(ctx).connections.get(b.connectionId)).resolves.toMatchObject({
      status: "connected",
    });
    await expect(syncRepos(ctx).alerts.listOpen()).resolves.toMatchObject([
      { subject: `provider:${a.providerId}` },
    ]);
  });

  it("reports a disconnected Google account as an error, not a throw", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ctx = syncCtx({ now: () => nowSeconds });
    await seedConnectedProvider(ctx, { host: HOST });
    await seedSettings(ctx);
    const upstreams = stubUpstreams({ [HOST]: fhirServer() });

    const summary = await runTokenKeepalive(ctx, upstreams.deps);

    expect(summary.errors).toStrictEqual([{ providerId: "google", code: "not_connected" }]);
  });
});

describe("refreshConnectionToken", () => {
  it("reports the status and expiry without refreshing a valid token", async () => {
    const h = await setup();
    const time = clock(h.nowSeconds);

    const result = await refreshConnectionToken(h.ctx, h.providerId, { deps: h.upstreams.deps });

    expect(result.status).toBe("connected");
    expect(result.accessExpiresAt).toBe(new Date((time.now() + 3600) * 1000).toISOString());
    expect(h.server.tokenCalls).toBe(0);
  });

  it("refreshes when asked to, whatever the stored expiry says", async () => {
    // The admin button has to be able to prove a refresh works, not just that a
    // cached token has not expired yet.
    const h = await setup();

    await refreshConnectionToken(h.ctx, h.providerId, { force: true, deps: h.upstreams.deps });

    expect(h.server.tokenCalls).toBe(1);
    const secrets = await syncRepos(h.ctx).connections.getSecrets(h.connectionId);
    expect(secrets?.refreshToken).toBe("refreshed-refresh-token");
  });

  it("writes a run_log row of kind refresh either way", async () => {
    const h = await setup();

    await refreshConnectionToken(h.ctx, h.providerId, { deps: h.upstreams.deps });

    await expect(syncRepos(h.ctx).runLog.listRecent()).resolves.toMatchObject([
      { kind: "refresh", ok: true },
    ]);
  });

  it("throws on failure, and still records the run", async () => {
    // Unlike the two sync entry points: this one is driven by a button that has
    // to show the owner what went wrong.
    const h = await setup({ accessTtlSeconds: 60 });
    h.server.tokenInvalidGrant = true;

    await expect(
      refreshConnectionToken(h.ctx, h.providerId, { deps: h.upstreams.deps }),
    ).rejects.toBeInstanceOf(AppError);

    const runs = await syncRepos(h.ctx).runLog.listRecent();
    expect(runs[0]).toMatchObject({ kind: "refresh", ok: false });
    expect(runs[0]?.summary.errors).toStrictEqual(["needs_reauth"]);
    await expect(syncRepos(h.ctx).connections.get(h.connectionId)).resolves.toMatchObject({
      status: "needs_reauth",
    });
  });

  it("refuses a provider that does not exist", async () => {
    const h = await setup();

    await expect(
      refreshConnectionToken(h.ctx, "no-such-provider", { deps: h.upstreams.deps }),
    ).rejects.toThrow();
  });
});
