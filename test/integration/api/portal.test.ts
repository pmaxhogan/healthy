// `/api/providers/:id/portal`, end to end in real workerd against real D1.
//
// Two things here are worth more than the CRUD around them.
//
// **The password is write-only.** It is sealed by the repo and no response on this
// surface may echo it, in any shape. The test reads it back out of D1 to prove it
// really was stored, which is the only place it is legible.
//
// **The sign-in is a job, and the DTO is how the SPA watches it.** The route
// answers 202 and the phase moves from `logging_in` to `signed_in` in a Durable
// Object the request does not wait for. The port is replaced with one that runs the
// *real* sign-in steps -- against a fake portal and a real seeded `mail_inbox` code
// -- so what is exercised here is the phase contract and the emailed-code handoff,
// not a mock returning what the test asked for.
//
// Hosts are `*.example.test` (reserved by RFC 6761) and every name is invented.

import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../../../worker/lib/errors.ts";
import { portalDeps, signInAndWait } from "../../../worker/sync/portal-signin.ts";
import {
  PORTAL_MOUNT,
  PORTAL_ORIGIN,
  PORTAL_PASSWORD,
  PORTAL_USERNAME,
  fakePortal,
  seedOtp,
  seedPortalAccount,
  spendAttempts,
} from "../portal/helpers.ts";

import {
  freshOwner,
  json,
  resetPorts,
  seedProvider,
  stubFetch,
  testCtx,
  testRepos,
  usePorts,
} from "./helpers.ts";

import type { Ctx } from "../../../worker/db/client.ts";
import type { FakePortal } from "../portal/helpers.ts";
import type { ApiError, PortalAccountStatusDto, PortalSignInState } from "@shared/types.ts";

const owner = freshOwner();

afterEach(() => {
  resetPorts();
});

/** A login page the real discovery probe recognises: a username, a password, a token. */
const LOGIN_PAGE = `<!doctype html><html><body>
  <form action="/MyChart/Authentication/Login/DoLogin" method="post">
    <input type="hidden" name="__RequestVerificationToken" value="synthetic-token" />
    <input type="text" name="LoginIdentifier" value="" />
    <input type="password" name="Password" value="" />
  </form>
</body></html>`;

/** A page that is a page, but not a login form. */
const NOT_A_LOGIN_PAGE = `<!doctype html><html><body><h1>Welcome</h1></body></html>`;

function htmlStub(body: string): ReturnType<typeof stubFetch> {
  return stubFetch([
    {
      match: "Authentication/Login",
      respond: () =>
        new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }),
    },
  ]);
}

/**
 * A `portal` port that runs the real sign-in when the test says to.
 *
 * `startSignIn` does what the Durable Object's first storage write does -- record
 * that a sign-in has begun -- and hands back a `run` the test calls to play the job
 * out. That split is the point: it is what lets one test observe both phases.
 */
function fakeRunner(portal: FakePortal): {
  ports: Parameters<typeof usePorts>[0];
  run: (ctx: Ctx, providerId: string) => Promise<void>;
  starts: number;
  syncs: number;
} {
  const state: { phase: PortalSignInState; starts: number; syncs: number } = {
    phase: { phase: "idle", code: null, startedAt: null, updatedAt: null },
    starts: 0,
    syncs: 0,
  };
  const runner = {
    ports: {
      portal: {
        startSignIn: (_ctx: Ctx, _options: { providerId: string }) => {
          state.starts += 1;
          state.phase = { phase: "logging_in", code: null, startedAt: 1, updatedAt: 1 };
          return Promise.resolve({ started: true });
        },
        startSync: () => {
          state.syncs += 1;
          return Promise.resolve({ started: true });
        },
        signInState: () => Promise.resolve(state.phase),
      },
    },
    run: async (ctx: Ctx, providerId: string): Promise<void> => {
      const outcome = await signInAndWait(
        ctx,
        providerId,
        portalDeps({ portalAdapter: portal.adapter, sleep: () => Promise.resolve() }),
      );
      state.phase = { phase: outcome.phase, code: outcome.code, startedAt: 1, updatedAt: 2 };
    },
    get starts() {
      return state.starts;
    },
    get syncs() {
      return state.syncs;
    },
  };
  return runner;
}

/** The portal port every test needs, even the ones that never start a job. */
function idlePorts(): Parameters<typeof usePorts>[0] {
  return {
    portal: {
      startSignIn: () => Promise.resolve({ started: true }),
      startSync: () => Promise.resolve({ started: true }),
      signInState: () =>
        Promise.resolve({ phase: "idle", code: null, startedAt: null, updatedAt: null }),
    },
  };
}

describe("GET /api/providers/:id/portal", () => {
  it("answers a default account for a provider that has never had one", async () => {
    usePorts(idlePorts());
    const providerId = await seedProvider();

    const response = await owner().get(`/api/providers/${providerId}/portal`);

    expect(response.status).toBe(200);
    const dto = await json<PortalAccountStatusDto>(response);
    expect(dto).toStrictEqual({
      providerId,
      baseUrl: null,
      mountPath: null,
      hasCredentials: false,
      hasSession: false,
      state: "none",
      lastLoginAt: null,
      lastOkAt: null,
      lastErrorCode: null,
      needsReauthSince: null,
      loginAttemptsToday: 0,
      updatedAt: null,
      signIn: { phase: "idle", code: null, startedAt: null, updatedAt: null },
      lastVisitCount: null,
    });
  });

  it("404s for a provider that does not exist", async () => {
    usePorts(idlePorts());
    const response = await owner().get("/api/providers/nope/portal");
    expect(response.status).toBe(404);
  });

  it("reports the visits it is tracking once the portal has answered", async () => {
    usePorts(idlePorts());
    const providerId = await seedProvider();
    const ctx = testCtx();
    await seedPortalAccount(ctx, providerId);
    await testRepos().calendarEvents.upsert({
      eventKey: `${providerId}:csn:csn-1`,
      providerId,
      encounterId: "csn:csn-1",
      calendarId: "primary",
      googleEventId: "gcal-1",
      fingerprint: "fp-1",
      startAt: ctx.now() + 3600,
      source: "portal",
      portalCsn: "csn-1",
    });

    const dto = await json<PortalAccountStatusDto>(
      await owner().get(`/api/providers/${providerId}/portal`),
    );
    expect(dto.state).toBe("active");
    expect(dto.hasCredentials).toBe(true);
    expect(dto.hasSession).toBe(true);
    expect(dto.lastVisitCount).toBe(1);
  });
});

describe("PUT /api/providers/:id/portal", () => {
  it("discovers the portal, seals the credentials and never echoes the password", async () => {
    usePorts({ ...idlePorts(), fetch: htmlStub(LOGIN_PAGE).fetchImpl });
    const providerId = await seedProvider();

    const response = await owner().send("PUT", `/api/providers/${providerId}/portal`, {
      baseUrl: `${PORTAL_ORIGIN}/somewhere/else`,
      mountHint: PORTAL_MOUNT,
      username: PORTAL_USERNAME,
      password: PORTAL_PASSWORD,
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(PORTAL_PASSWORD);
    const dto = JSON.parse(body) as PortalAccountStatusDto;
    expect(dto.baseUrl).toBe(PORTAL_ORIGIN);
    expect(dto.mountPath).toBe(PORTAL_MOUNT);
    expect(dto.hasCredentials).toBe(true);
    // A fresh set of credentials is a session nobody has established yet.
    expect(dto.state).toBe("none");
    expect(dto.hasSession).toBe(false);

    // Sealed, not merely hidden by the projection.
    const secrets = await testRepos().portalAccounts.getSecrets(providerId);
    expect(secrets?.username).toBe(PORTAL_USERNAME);
    expect(secrets?.password).toBe(PORTAL_PASSWORD);
  });

  it("stores the whole discovery result, not just the two columns", async () => {
    usePorts({ ...idlePorts(), fetch: htmlStub(LOGIN_PAGE).fetchImpl });
    const providerId = await seedProvider();

    await owner().send("PUT", `/api/providers/${providerId}/portal`, {
      baseUrl: PORTAL_ORIGIN,
      username: PORTAL_USERNAME,
      password: PORTAL_PASSWORD,
    });

    // Opaque to everything outside the adapter, which is why it is stored whole:
    // it says how to sign in to this deployment, not only where it lives.
    const endpoint = await testRepos().portalAccounts.getEndpoint(providerId);
    expect(endpoint?.baseUrl).toBe(PORTAL_ORIGIN);
    expect(endpoint?.mountPath).toBe(PORTAL_MOUNT);
  });

  it("skips discovery when the endpoint is already known and the origin is unchanged", async () => {
    const stub = htmlStub(LOGIN_PAGE);
    usePorts({ ...idlePorts(), fetch: stub.fetchImpl });
    const providerId = await seedProvider();
    await seedPortalAccount(testCtx(), providerId);

    const response = await owner().send("PUT", `/api/providers/${providerId}/portal`, {
      baseUrl: PORTAL_ORIGIN,
      username: PORTAL_USERNAME,
      password: "a-new-password",
    });

    expect(response.status).toBe(200);
    // Re-probing is several unauthenticated requests to a host with bot protection,
    // for an answer we already have.
    expect(stub.requests).toStrictEqual([]);
    const secrets = await testRepos().portalAccounts.getSecrets(providerId);
    expect(secrets?.password).toBe("a-new-password");
  });

  it("rejects a URL that hosts no login page with one stable code", async () => {
    usePorts({ ...idlePorts(), fetch: htmlStub(NOT_A_LOGIN_PAGE).fetchImpl });
    const providerId = await seedProvider();

    const response = await owner().send("PUT", `/api/providers/${providerId}/portal`, {
      baseUrl: PORTAL_ORIGIN,
      username: PORTAL_USERNAME,
      password: PORTAL_PASSWORD,
    });

    expect(response.status).toBe(400);
    const body = await json<ApiError>(response);
    expect(body.error).toBe("portal_discovery_failed");
    expect(body.details?.reason).toBe("portal_parse_failed");
    // Nothing was written: an account sealed against a URL that hosts no portal can
    // never sign in.
    expect(await testRepos().portalAccounts.get(providerId)).toBeNull();
  });

  it("refuses a first save with no URL to probe", async () => {
    usePorts(idlePorts());
    const providerId = await seedProvider();

    const response = await owner().send("PUT", `/api/providers/${providerId}/portal`, {
      username: PORTAL_USERNAME,
      password: PORTAL_PASSWORD,
    });

    expect(response.status).toBe(400);
    const body = await json<ApiError>(response);
    expect(body.error).toBe("bad_request");
  });
});

describe("POST /api/providers/:id/portal/sign-in", () => {
  it("answers 202 and walks the phase from logging_in to signed_in", async () => {
    const providerId = await seedProvider();
    const ctx = testCtx();
    await seedPortalAccount(ctx, providerId);
    const portal = fakePortal({ alive: false, loginStatus: "awaiting_code" });
    const runner = fakeRunner(portal);
    usePorts(runner.ports);
    await seedOtp(ctx, "998877");

    const started = await owner().send("POST", `/api/providers/${providerId}/portal/sign-in`);
    expect(started.status).toBe(202);
    expect(await json(started)).toStrictEqual({ accepted: true, started: true });

    const waiting = await json<PortalAccountStatusDto>(
      await owner().get(`/api/providers/${providerId}/portal`),
    );
    expect(waiting.signIn.phase).toBe("logging_in");

    // The job, as the Durable Object's alarms would have run it.
    await runner.run(ctx, providerId);

    const done = await json<PortalAccountStatusDto>(
      await owner().get(`/api/providers/${providerId}/portal`),
    );
    expect(done.signIn.phase).toBe("signed_in");
    expect(done.signIn.code).toBeNull();
    expect(done.state).toBe("active");
    expect(portal.submitted).toStrictEqual(["998877"]);
  });

  it("reports a failure as a phase and a stable code, never as the emailed code", async () => {
    const providerId = await seedProvider();
    const ctx = testCtx();
    await seedPortalAccount(ctx, providerId);
    const portal = fakePortal({
      alive: false,
      loginError: new AppError("portal_login_failed", "rejected"),
    });
    const runner = fakeRunner(portal);
    usePorts(runner.ports);

    await owner().send("POST", `/api/providers/${providerId}/portal/sign-in`);
    await runner.run(ctx, providerId);

    const dto = await json<PortalAccountStatusDto>(
      await owner().get(`/api/providers/${providerId}/portal`),
    );
    expect(dto.signIn).toMatchObject({ phase: "failed", code: "portal_login_failed" });
    expect(dto.state).toBe("needs_reauth");
    expect(dto.lastErrorCode).toBe("portal_login_failed");
  });

  it("refuses with 429 once the daily attempt budget is spent", async () => {
    const providerId = await seedProvider();
    const ctx = testCtx();
    await seedPortalAccount(ctx, providerId);
    await spendAttempts(ctx, providerId, 3);
    const runner = fakeRunner(fakePortal());
    usePorts(runner.ports);

    const response = await owner().send("POST", `/api/providers/${providerId}/portal/sign-in`);

    expect(response.status).toBe(429);
    const body = await json<ApiError>(response);
    expect(body.error).toBe("portal_attempts_exhausted");
    expect(body.details).toStrictEqual({ used: 3, limit: 3 });
    expect(runner.starts).toBe(0);
  });

  it("allows one more attempt once the limit setting is raised", async () => {
    const providerId = await seedProvider();
    const ctx = testCtx();
    await seedPortalAccount(ctx, providerId);
    await spendAttempts(ctx, providerId, 3);
    const runner = fakeRunner(fakePortal());
    usePorts(runner.ports);

    await owner().send("PUT", "/api/settings", { portalLoginAttemptLimit: 5 });
    const response = await owner().send("POST", `/api/providers/${providerId}/portal/sign-in`);

    expect(response.status).toBe(202);
    expect(runner.starts).toBe(1);
  });

  it("refuses to start when there are no credentials to try", async () => {
    usePorts(idlePorts());
    const providerId = await seedProvider();

    const response = await owner().send("POST", `/api/providers/${providerId}/portal/sign-in`);

    expect(response.status).toBe(409);
    const body = await json<ApiError>(response);
    expect(body.error).toBe("conflict");
  });
});

describe("POST /api/providers/:id/portal/sync", () => {
  it("answers 202 and queues the job on the runner, not on waitUntil", async () => {
    const providerId = await seedProvider();
    await seedPortalAccount(testCtx(), providerId);
    const runner = fakeRunner(fakePortal());
    usePorts(runner.ports);

    const response = await owner().send("POST", `/api/providers/${providerId}/portal/sync`);

    expect(response.status).toBe(202);
    expect(await json(response)).toStrictEqual({ accepted: true, started: true });
    expect(runner.syncs).toBe(1);
  });
});

describe("DELETE /api/providers/:id/portal", () => {
  it("forgets the session but keeps the credentials", async () => {
    usePorts(idlePorts());
    const providerId = await seedProvider();
    await seedPortalAccount(testCtx(), providerId);

    const response = await owner().send("DELETE", `/api/providers/${providerId}/portal/session`);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    const dto = await json<PortalAccountStatusDto>(
      await owner().get(`/api/providers/${providerId}/portal`),
    );
    expect(dto.hasSession).toBe(false);
    expect(dto.hasCredentials).toBe(true);
    expect(dto.state).toBe("none");
  });

  it("404s a forget with no account to forget", async () => {
    usePorts(idlePorts());
    const providerId = await seedProvider();
    const response = await owner().send("DELETE", `/api/providers/${providerId}/portal/session`);
    expect(response.status).toBe(404);
  });

  it("removes the account entirely, and leaves the calendar alone", async () => {
    usePorts(idlePorts());
    const providerId = await seedProvider();
    const ctx = testCtx();
    await seedPortalAccount(ctx, providerId);
    await testRepos().calendarEvents.upsert({
      eventKey: `${providerId}:csn:csn-1`,
      providerId,
      encounterId: "csn:csn-1",
      calendarId: "primary",
      googleEventId: "gcal-1",
      fingerprint: "fp-1",
      startAt: ctx.now() + 3600,
      source: "portal",
      portalCsn: "csn-1",
    });

    const response = await owner().send("DELETE", `/api/providers/${providerId}/portal`);

    expect(response.status).toBe(204);
    expect(await testRepos().portalAccounts.get(providerId)).toBeNull();
    // The owner's appointments are theirs; removing an account is not a reason to
    // rewrite their week.
    const kept = await testRepos().calendarEvents.getByKey(`${providerId}:csn:csn-1`);
    expect(kept).not.toBeNull();

    const dto = await json<PortalAccountStatusDto>(
      await owner().get(`/api/providers/${providerId}/portal`),
    );
    expect(dto.hasCredentials).toBe(false);
    expect(dto.state).toBe("none");
  });
});
