// The alert a parked batch raises: one open row per device and one Trello card,
// closed again when the device has nothing set aside -- and never able to break
// the apply that raised it.
//
// Trello is a stub handed in through the alert seam; nothing here reaches a
// network. Every record is synthetic: see helpers.ts.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { makeCtx } from "../../../src/db/client.ts";
import { makeRepos } from "../../../src/db/index.ts";
import { deviceSubject } from "../../../src/db/repos/alerts.ts";
import {
  MAX_BATCH_FAILURES,
  NO_HEAD_FAILURES,
  beginAttempt,
  runHcSlice,
} from "../../../src/hc/apply.ts";
import { wipeDevice } from "../../../src/hc/store/wipe.ts";
import { recordingLog, testCtx } from "../db/helpers.ts";

import { T, drain, enqueue, logRow, resetHc, seedDevice, steps, withoutTrello } from "./helpers.ts";

import type { Ctx } from "../../../src/db/client.ts";
import type { Repos } from "../../../src/db/index.ts";
import type { SyncDeps } from "../../../src/sync/deps.ts";

beforeEach(async () => {
  await resetHc();
  await env.DB.prepare("DELETE FROM alerts").run();
});

const DEVICE_NAME = "Example phone";

/** A context whose Trello secrets are present, so the alert path builds a client. */
function trelloCtx(): Ctx {
  const ctx = testCtx();
  return makeCtx(ctx.db, {
    ...ctx.env,
    TRELLO_KEY: "trello-test-key",
    TRELLO_TOKEN: "trello-test-token",
    TRELLO_MUST_LIST_ID: "must-list",
    TRELLO_DONE_LIST_ID: "done-list",
  });
}

interface TrelloStub {
  deps: SyncDeps;
  calls: { method: string; path: string }[];
  cards: { name: string; desc: string }[];
}

/** An in-memory Trello: lists no cards, creates what it is asked to, completes anything. */
function trelloStub(options: { failing?: boolean } = {}): TrelloStub {
  const calls: { method: string; path: string }[] = [];
  const cards: { name: string; desc: string }[] = [];
  const trelloFetch: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : new Request(input).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/1/u, "");
    calls.push({ method, path });
    if (options.failing === true) return Promise.resolve(new Response("nope", { status: 400 }));
    if (method === "POST") {
      cards.push({
        name: url.searchParams.get("name") ?? "",
        desc: url.searchParams.get("desc") ?? "",
      });
      return Promise.resolve(Response.json({ id: `card-${String(cards.length)}` }));
    }
    return Promise.resolve(Response.json(method === "GET" ? [] : {}));
  };
  return { deps: { trelloFetch, origin: "https://healthy.example.test" }, calls, cards };
}

/** A batch that will never open: parked the moment the runner reaches it. */
async function enqueueUnreadable(repos: Repos, deviceId: string, batchId: string): Promise<void> {
  await repos.hcIngestQueue.enqueue({
    deviceId,
    batchId,
    body: new TextEncoder().encode("this is not gzip") as Uint8Array<ArrayBuffer>,
    rawBytes: 16,
    upserts: 1,
    deletes: 0,
    rejected: 0,
    phoneTime: T,
  });
}

interface AlertRow {
  kind: string;
  subject: string;
  trello_card_id: string | null;
  resolved_at: number | null;
}

async function alertRows(): Promise<AlertRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT kind, subject, trello_card_id, resolved_at FROM alerts ORDER BY opened_at, id",
  ).all<AlertRow>();
  return results;
}

/** Run slices to the end, with the alert seam. */
async function drainWith(ctx: Ctx, deviceId: string, deps: SyncDeps): Promise<void> {
  let state;
  for (let slice = 0; slice < 500; slice += 1) {
    const result = await runHcSlice(ctx, deviceId, state, undefined, undefined, deps);
    ({ state } = result);
    if (!result.more) return;
  }
  throw new Error("the store never went idle");
}

describe("the alert for uploads set aside", () => {
  it("opens once per device, however many batches are parked", async () => {
    const ctx = trelloCtx();
    const repos = makeRepos(ctx);
    const deviceId = await seedDevice(repos, DEVICE_NAME);
    const trello = trelloStub();
    await enqueueUnreadable(repos, deviceId, "batch-junk-1");
    await enqueueUnreadable(repos, deviceId, "batch-junk-2");
    await enqueue(repos, deviceId, { batchId: "batch-0003", upserts: [steps("a", T, 100)] });

    await drainWith(ctx, deviceId, trello.deps);

    expect(await repos.hcIngestQueue.parked(deviceId)).toMatchObject({ batches: 2 });
    expect(await alertRows()).toStrictEqual([
      {
        kind: "hc_parked",
        subject: deviceSubject(deviceId),
        trello_card_id: "card-1",
        resolved_at: null,
      },
    ]);
    // One card, named for the phone, with the code and the Phone page -- and
    // nothing that identifies a row or says what was in the upload.
    expect(trello.cards).toHaveLength(1);
    const [card] = trello.cards;
    expect(card?.name).toBe(`Uploads from ${DEVICE_NAME} are waiting in Healthy`);
    expect(card?.desc).toContain("batch_unreadable");
    expect(card?.desc).toContain("https://healthy.example.test/phone");
    expect(card?.desc).not.toContain(deviceId);
    expect(card?.desc).not.toContain("Steps");
    // Still open: the applied batch behind them does not close it.
    expect(await logRow(deviceId, "batch-0003")).toMatchObject({ status: "applied" });
  });

  it("is resolved, and its card completed, when what was parked is queued again and applied", async () => {
    const ctx = trelloCtx();
    const repos = makeRepos(ctx);
    const deviceId = await seedDevice(repos, DEVICE_NAME);
    const trello = trelloStub();
    await enqueue(repos, deviceId, { batchId: "batch-0001", upserts: [steps("a", T, 100)] });
    await env.DB.prepare(
      `CREATE TRIGGER synthetic_failure BEFORE INSERT ON hc_chunks
         BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`,
    ).run();
    try {
      let head = NO_HEAD_FAILURES;
      for (let attempt = 1; attempt <= MAX_BATCH_FAILURES; attempt += 1) {
        ({ head } = await beginAttempt(ctx, deviceId, head, trello.deps));
        await expect(runHcSlice(ctx, deviceId)).rejects.toThrow();
      }
      const last = await beginAttempt(ctx, deviceId, head, trello.deps);
      expect(last.gaveUp).toBe(true);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS synthetic_failure").run();
    }
    expect(await alertRows()).toMatchObject([{ kind: "hc_parked", resolved_at: null }]);
    expect(trello.cards[0]?.desc).toContain("apply_gave_up");

    expect(await repos.hcIngestQueue.unpark(deviceId)).toBe(1);
    await drainWith(ctx, deviceId, trello.deps);

    expect(await logRow(deviceId, "batch-0001")).toMatchObject({ status: "applied", applied: 1 });
    const [alert] = await alertRows();
    expect(alert?.resolved_at).not.toBeNull();
    expect(trello.calls).toContainEqual({ method: "PUT", path: "/cards/card-1" });
  });

  it("is resolved when the device is wiped", async () => {
    const ctx = trelloCtx();
    const repos = makeRepos(ctx);
    const deviceId = await seedDevice(repos, DEVICE_NAME);
    const trello = trelloStub();
    await enqueueUnreadable(repos, deviceId, "batch-junk-1");
    await drainWith(ctx, deviceId, trello.deps);
    expect(await alertRows()).toMatchObject([{ resolved_at: null }]);

    for (let pass = 0; pass < 50; pass += 1) {
      const { done } = await wipeDevice(ctx, deviceId, { deps: trello.deps });
      if (done) break;
    }

    const [alert] = await alertRows();
    expect(alert?.resolved_at).not.toBeNull();
    expect(trello.calls).toContainEqual({ method: "PUT", path: "/cards/card-1" });
  });

  it("cannot break the apply: with Trello failing, the batch is parked and the next one applied", async () => {
    const logged = recordingLog();
    const base = trelloCtx();
    const ctx = makeCtx(base.db, base.env, { log: logged.log });
    const repos = makeRepos(ctx);
    const deviceId = await seedDevice(repos, DEVICE_NAME);
    const trello = trelloStub({ failing: true });
    await enqueueUnreadable(repos, deviceId, "batch-junk-1");
    await enqueue(repos, deviceId, { batchId: "batch-0002", upserts: [steps("a", T, 100)] });

    await drainWith(ctx, deviceId, trello.deps);

    expect(await repos.hcIngestQueue.parked(deviceId)).toMatchObject({ batches: 1 });
    expect(await logRow(deviceId, "batch-0002")).toMatchObject({ status: "applied", applied: 1 });
    // The row is the truth and it landed; only the card is missing.
    expect(await alertRows()).toStrictEqual([
      {
        kind: "hc_parked",
        subject: deviceSubject(deviceId),
        trello_card_id: null,
        resolved_at: null,
      },
    ]);
    const failure = logged.lines.find((line) => line.includes("alert.open_failed"));
    expect(failure).toContain('"errorCode":"upstream_error"');
  });

  it("writes the row with no card when Trello is not configured", async () => {
    const ctx = testCtx();
    const bare = makeCtx(ctx.db, withoutTrello(ctx.env));
    const repos = makeRepos(bare);
    const deviceId = await seedDevice(repos, DEVICE_NAME);
    await enqueueUnreadable(repos, deviceId, "batch-junk-1");

    await drain(bare, deviceId);

    expect(await alertRows()).toMatchObject([{ kind: "hc_parked", trello_card_id: null }]);
  });
});
