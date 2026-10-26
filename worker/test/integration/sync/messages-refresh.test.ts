// `refreshPortalMessages`: one health system's Message Center, read on demand.
//
// Real workerd, real D1 and the real sign-in gate (a Durable Object); only the
// portal is a fake adapter, scripted per test. What is under test is what the
// refresh touches and, as much, what it does not: no sign-in, no visits, no
// alert streak, and never while another driver holds the gate.
//
// Every thread here is invented.

import { beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../../src/lib/errors.ts";
import { acquirePortalSignIn, releasePortalSignIn } from "../../../src/sync/portal-gate.ts";
import { refreshPortalMessages } from "../../../src/sync/portal-messages-refresh.ts";
import { fakePortal, seedPortalAccount } from "../portal/helpers.ts";

import { resetSyncDb, seedConnectedHealthSystem, syncCtx, syncRepos } from "./helpers.ts";

import type { Ctx } from "../../../src/db/client.ts";
import type { PortalThread } from "../../../src/ehr/mychart/index.ts";
import type { FakePortal } from "../portal/helpers.ts";

beforeEach(resetSyncDb);

const THREAD: PortalThread = {
  subject: "Invented subject",
  folder: "conversations",
  external: false,
  practitioners: [{ name: "Nurse Example A" }],
  messages: [
    {
      sent: "2026-05-01T10:00:00.000Z",
      role: "patient",
      body: "An invented question.",
      attachments: [],
    },
  ],
};

const REPLY = {
  sent: "2026-05-01T12:00:00.000Z",
  role: "practitioner" as const,
  author: "Nurse Example A",
  body: "An invented answer.",
  attachments: [],
};

interface Fixture {
  ctx: Ctx;
  healthSystemId: string;
  portal: FakePortal;
}

async function fixture(
  options: { portal?: Partial<FakePortal>; active?: boolean } = {},
): Promise<Fixture> {
  const ctx = syncCtx();
  const { healthSystemId } = await seedConnectedHealthSystem(ctx, { host: "fhir.example.test" });
  await seedPortalAccount(ctx, healthSystemId, { active: options.active ?? true });
  return { ctx, healthSystemId, portal: fakePortal({ threads: [THREAD], ...options.portal }) };
}

function refresh(fix: Fixture) {
  return refreshPortalMessages(
    fix.ctx,
    { healthSystemId: fix.healthSystemId },
    { portalAdapter: fix.portal.adapter },
  );
}

async function failureRows(ctx: Ctx): Promise<number> {
  const row = await ctx.db
    .prepare("SELECT COUNT(*) AS n FROM sync_failures")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("refreshPortalMessages", () => {
  it("reads the Message Center alone and stores what it said", async () => {
    const fix = await fixture();

    const result = await refresh(fix);

    expect(result).toStrictEqual({
      outcome: "refreshed",
      threads: 1,
      messages: 1,
      written: 1,
      complete: true,
    });
    expect(fix.portal.calls.loadMessages).toBe(1);
    expect(fix.portal.calls.loadUpcoming).toBe(0);
    expect(fix.portal.calls.visitDetails).toStrictEqual([]);
    expect(fix.portal.calls.logins).toBe(0);
    const repos = syncRepos(fix.ctx);
    const stored = await repos.portalMessages.list(fix.healthSystemId);
    expect(stored.map((row) => row.message.body)).toStrictEqual(["An invented question."]);
    expect(await repos.portalMessages.listSync()).toStrictEqual([
      expect.objectContaining({ healthSystemId: fix.healthSystemId, lastErrorCode: null }),
    ]);
  });

  it("counts only what changed on a second read: the reply that just arrived", async () => {
    const fix = await fixture();
    await refresh(fix);

    fix.portal.threads = [{ ...THREAD, messages: [...THREAD.messages, REPLY] }];
    const second = await refresh(fix);
    const third = await refresh(fix);

    expect(second).toMatchObject({ outcome: "refreshed", messages: 2, written: 1 });
    expect(third).toMatchObject({ outcome: "refreshed", messages: 2, written: 0 });
  });

  it("never signs in: a dead session answers portal_session_expired and reads nothing", async () => {
    const fix = await fixture({ portal: { alive: false } });

    const result = await refresh(fix);

    expect(result).toStrictEqual({ outcome: "failed", code: "portal_session_expired" });
    expect(fix.portal.calls.logins).toBe(0);
    expect(fix.portal.calls.sendCodes).toBe(0);
    expect(fix.portal.calls.loadMessages).toBe(0);
    expect(await failureRows(fix.ctx)).toBe(0);
  });

  it("skips an account that is not signed in, without touching the portal", async () => {
    const fix = await fixture({ active: false });

    const result = await refresh(fix);

    expect(result).toStrictEqual({ outcome: "skipped", code: "portal_not_signed_in" });
    expect(fix.portal.calls.sessionChecks).toBe(0);
    expect(fix.portal.calls.loadMessages).toBe(0);
  });

  it("skips a health system with no portal account", async () => {
    const ctx = syncCtx();
    const { healthSystemId } = await seedConnectedHealthSystem(ctx, { host: "fhir.example.test" });
    const portal = fakePortal();

    const result = await refreshPortalMessages(
      ctx,
      { healthSystemId },
      { portalAdapter: portal.adapter },
    );

    expect(result).toStrictEqual({ outcome: "skipped", code: "portal_not_configured" });
    expect(portal.calls.sessionChecks).toBe(0);
  });

  it("stands back while a sign-in holds the gate, and releases the gate it took", async () => {
    const fix = await fixture();
    expect(await acquirePortalSignIn(fix.ctx, fix.healthSystemId, "test")).toBe(true);

    const blocked = await refresh(fix);
    expect(blocked).toStrictEqual({ outcome: "busy", code: "portal_signin_busy" });
    expect(fix.portal.calls.sessionChecks).toBe(0);

    await releasePortalSignIn(fix.ctx, fix.healthSystemId);
    expect(await refresh(fix)).toMatchObject({ outcome: "refreshed" });
    // The refresh let go of the gate when it finished.
    expect(await acquirePortalSignIn(fix.ctx, fix.healthSystemId, "test")).toBe(true);
    await releasePortalSignIn(fix.ctx, fix.healthSystemId);
  });

  it("records a failed read on the sync row but opens no alert streak", async () => {
    const fix = await fixture({
      portal: { messagesError: new AppError("portal_parse_failed", "an invented failure") },
    });

    const result = await refresh(fix);

    expect(result).toStrictEqual({ outcome: "failed", code: "portal_parse_failed" });
    const [sync] = await syncRepos(fix.ctx).portalMessages.listSync();
    expect(sync).toMatchObject({ lastErrorCode: "portal_parse_failed" });
    expect(await failureRows(fix.ctx)).toBe(0);
    // And the gate is free again.
    expect(await acquirePortalSignIn(fix.ctx, fix.healthSystemId, "test")).toBe(true);
    await releasePortalSignIn(fix.ctx, fix.healthSystemId);
  });
});
