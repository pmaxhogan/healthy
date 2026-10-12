// Sync runs, end to end: batches POSTed to the real `/ingest/health-connect`
// route, each saying which run it is part of, and `hc_sync_status` reading the
// runs back out of the upload log -- before anything has been applied, which
// is the point of keeping them on the log row.
//
// Then the reader by itself, over a log long enough that one page of it cuts
// a run in two.
//
// Everything is synthetic, and the zone is a test parameter, never the owner's.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../../../src/app.ts";
import { makeCtx } from "../../../src/db/client.ts";
import { makeRepos } from "../../../src/db/index.ts";
import { RUN_LOG_FIRST_SQL, RUN_LOG_NEXT_SQL } from "../../../src/db/repos/hc-status.ts";
import { setSetting } from "../../../src/db/settings.ts";
import { INGEST_PATH } from "../../../src/ingest/route.ts";
import { makeToolDeps } from "../../../src/mcp/deps-d1.ts";
import { registerTools } from "../../../src/mcp/tools/index.ts";
import { resetDb } from "../db/helpers.ts";

import type { Env } from "../../../src/env.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** The zone the answers are written in, for this file. Five hours west of UTC. */
const ZONE = "Etc/GMT+5";
const ZONE_OFFSET_MS = 5 * 3_600_000;

const ORIGIN = "https://healthy.example";
// No runner: the batches stay queued, as they are the moment the route has
// acknowledged them. The route treats a wake that fails as harmless.
const RUNTIME_ENV = { ...env, HC_INGEST: undefined } as unknown as Env;
const ctx = makeCtx(env.DB, RUNTIME_ENV);
const repos = makeRepos(ctx);

const WEARABLE = "com.example.wearable";
const MINUTE_MS = 60_000;
/** When the first run began, by the phone's clock: an arbitrary fixed instant. */
const RUN_A = Date.UTC(2026, 0, 10, 12);
const RUN_B = RUN_A + 15 * MINUTE_MS;
const RUN_C = RUN_A + 30 * MINUTE_MS;

/** An instant as the tools write it in {@link ZONE}. */
const zoned = (ms: number): string =>
  new Date(ms - ZONE_OFFSET_MS).toISOString().replace(".000Z", "-05:00");

beforeEach(async () => {
  await resetDb();
  await setSetting(ctx, "timezone", ZONE);
});

function steps(id: string): Record<string, unknown> {
  return {
    id,
    type: "Steps",
    origin: WEARABLE,
    lastModified: RUN_A,
    start: RUN_A,
    end: RUN_A + MINUTE_MS,
    data: { count: 10 },
  };
}

interface Posted {
  upserts?: Record<string, unknown>[];
  deletes?: string[];
  /** What the batch says of its run, added to its sync report; none for an app that says nothing. */
  run?: Record<string, unknown>;
}

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** POST one batch to the real ingest route, as the companion app would. */
async function upload(deviceId: string, token: string, batch: Posted): Promise<number> {
  const execution = createExecutionContext();
  const body = await gzip(
    JSON.stringify({
      v: 1,
      deviceId,
      appVersion: "0.2.0",
      batchId: crypto.randomUUID(),
      phoneTime: RUN_A,
      upserts: batch.upserts ?? [],
      deletes: batch.deletes ?? [],
      syncState: { types: [], ...batch.run },
    }),
  );
  const request = new Request(ORIGIN + INGEST_PATH, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body,
  });
  const response = await app.fetch(request, RUNTIME_ENV, execution);
  await waitOnExecutionContext(execution);
  return response.status;
}

/** The phone's row of `hc_sync_status`. */
async function deviceRow(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const server = new McpServer({ name: "Healthy", version: "test" });
  registerTools(
    server,
    makeToolDeps({ env: RUNTIME_ENV, caller: { clientId: "client-int", grantId: "grant-int" } }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "test" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = (await client.callTool({
    name: "hc_sync_status",
    arguments: args,
  })) as CallToolResult;
  const first = result.content[0];
  const body = JSON.parse(first?.type === "text" ? first.text : "{}") as {
    items?: Record<string, unknown>[];
  };
  const row = (body.items ?? []).find((item) => item.kind === "device");
  if (row === undefined) throw new Error("hc_sync_status listed no phone");
  return row;
}

describe("hc_sync_status recentUploads", () => {
  it("lists the phone's sync runs from what each batch said, before any is applied", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const post = (batch: Posted): Promise<number> => upload(device.id, token, batch);

    // An upload from a build of the app that says nothing of runs.
    expect(await post({ upserts: [steps("old-1")] })).toBe(200);
    // Run A: two batches of records, and then it is cut off. No closing report.
    const runA = { runTrigger: "periodic", runStartedAt: RUN_A };
    expect(
      await post({ upserts: [steps("a-1"), steps("a-2")], deletes: ["gone"], run: runA }),
    ).toBe(200);
    expect(await post({ upserts: [steps("a-3")], run: runA })).toBe(200);
    // Run B: nothing new, so only its closing report -- which says how A ended.
    expect(
      await post({
        run: {
          runTrigger: "alarm",
          runStartedAt: RUN_B,
          previousRun: { startedAt: RUN_A, end: "interrupted" },
        },
      }),
    ).toBe(200);
    // Run C: a batch of records, then its closing report.
    const runC = {
      runTrigger: "manual",
      runStartedAt: RUN_C,
      previousRun: { startedAt: RUN_B, end: "ok" },
    };
    expect(await post({ upserts: [steps("c-1")], run: runC })).toBe(200);
    expect(await post({ run: runC })).toBe(200);

    const row = await deviceRow();

    // Nothing has been applied: this is the log as the route wrote it.
    expect(row.queuedBatches).toBe(6);
    expect(row.recentUploads).toStrictEqual([
      {
        startedAt: zoned(RUN_C),
        receivedAt: expect.stringMatching(/-05:00$/u),
        trigger: "manual",
        batches: 2,
        upserts: 1,
        deletes: 0,
        closed: true,
        ended: null,
      },
      {
        startedAt: zoned(RUN_B),
        receivedAt: expect.stringMatching(/-05:00$/u),
        trigger: "alarm",
        batches: 1,
        upserts: 0,
        deletes: 0,
        closed: true,
        ended: "ok",
      },
      {
        startedAt: zoned(RUN_A),
        receivedAt: expect.stringMatching(/-05:00$/u),
        trigger: "periodic",
        batches: 2,
        upserts: 3,
        deletes: 1,
        closed: false,
        ended: "interrupted",
      },
      {
        startedAt: null,
        receivedAt: expect.stringMatching(/-05:00$/u),
        trigger: null,
        batches: 1,
        upserts: 1,
        deletes: 0,
        closed: null,
        ended: null,
      },
    ]);

    const newest = await deviceRow({ recent_uploads: 2 });
    expect(newest.recentUploads).toMatchObject([{ trigger: "manual" }, { trigger: "alarm" }]);
  }, 60_000);

  it("refuses a batch whose run fields are malformed, and logs no run for it", async () => {
    const { device, token } = await repos.devices.mint("Test phone");

    expect(await upload(device.id, token, { run: { runTrigger: "Periodic" } })).toBe(400);
    expect(await upload(device.id, token, { run: { runStartedAt: -1 } })).toBe(400);
    expect(
      await upload(device.id, token, { run: { previousRun: { startedAt: RUN_A, end: "" } } }),
    ).toBe(400);

    const row = await deviceRow();
    expect(row.recentUploads).toStrictEqual([]);
  }, 60_000);
});

// --- the reader, over a long log ------------------------------------------------

const AT = RUN_A / 1000;

/** Log rows of one run, written straight to the table: `batches` of them, a second apart. */
async function seedRun(
  deviceId: string,
  run: { name: string; startedMs: number | null; from: number; batches: number },
): Promise<void> {
  const statements = Array.from({ length: run.batches }, (_unused, index) =>
    env.DB.prepare(
      `INSERT INTO hc_ingest_log
         (device_id, batch_id, body_digest, received_at, status, upserts, deletes, rejected,
          body_bytes, raw_bytes, run_trigger, run_started_ms)
       VALUES (?, ?, 'x', ?, 'applied', ?, 0, 0, 1, 1, ?, ?)`,
    ).bind(
      deviceId,
      `${run.name}-${String(index)}`,
      run.from + index,
      // Every batch but the run's last carries a record.
      index === run.batches - 1 ? 0 : 1,
      run.startedMs === null ? null : "backfill",
      run.startedMs,
    ),
  );
  for (let from = 0; from < statements.length; from += 50) {
    await env.DB.batch(statements.slice(from, from + 50));
  }
}

describe("reading the newest runs out of a long log", () => {
  it("reads on past a page that cuts a run in two, and counts all of it", async () => {
    const { device } = await repos.devices.mint("Test phone");
    await seedRun(device.id, { name: "oldest", startedMs: RUN_A, from: AT, batches: 3 });
    // Far more batches than the first page holds.
    await seedRun(device.id, { name: "long", startedMs: RUN_B, from: AT + 1000, batches: 350 });
    await seedRun(device.id, { name: "newest", startedMs: RUN_C, from: AT + 5000, batches: 1 });

    const two = await repos.hcStatus.recentRuns(device.id, 2);
    const three = await repos.hcStatus.recentRuns(device.id, 3);
    const many = await repos.hcStatus.recentRuns(device.id, 50);

    expect(two).toMatchObject([
      { startedMs: RUN_C, batches: 1, upserts: 0, closed: true },
      { startedMs: RUN_B, batches: 350, upserts: 349, receivedAt: AT + 1349, closed: true },
    ]);
    // The oldest run ends where the log does: whole, with nothing behind it.
    expect(three.map((run) => run.batches)).toStrictEqual([1, 350, 3]);
    expect(many).toStrictEqual(three);
  }, 60_000);

  it("keeps batches that arrived in the same second in one run", async () => {
    const { device } = await repos.devices.mint("Test phone");
    await env.DB.batch(
      Array.from({ length: 150 }, (_unused, index) =>
        env.DB.prepare(
          `INSERT INTO hc_ingest_log
             (device_id, batch_id, body_digest, received_at, status, upserts, deletes, rejected,
              body_bytes, raw_bytes, run_trigger, run_started_ms)
           VALUES (?, ?, 'x', ?, 'applied', 1, 0, 0, 1, 1, 'backfill', ?)`,
        ).bind(device.id, `same-${String(index)}`, AT, index < 120 ? RUN_A : RUN_B),
      ),
    );

    // One second, 150 rows, and a first page of 100: the page ends inside it.
    const runs = await repos.hcStatus.recentRuns(device.id, 1);
    const both = await repos.hcStatus.recentRuns(device.id, 2);

    expect(runs).toMatchObject([{ startedMs: RUN_B, batches: 30 }]);
    expect(both).toMatchObject([
      { startedMs: RUN_B, batches: 30 },
      { startedMs: RUN_A, batches: 120, closed: false },
    ]);
  }, 60_000);

  it("walks the log by its arrival index, a page's rows and no more", async () => {
    const { device } = await repos.devices.mint("Test phone");
    const other = await repos.devices.mint("Drawer phone");
    await seedRun(device.id, { name: "mine", startedMs: RUN_A, from: AT, batches: 300 });
    await seedRun(other.device.id, { name: "theirs", startedMs: RUN_A, from: AT, batches: 100 });

    const plan = async (sql: string, ...values: unknown[]): Promise<string> => {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...values)
        .all<{ detail: string }>();
      return results.map((row) => row.detail).join("\n");
    };
    const first = await plan(RUN_LOG_FIRST_SQL, device.id, 10);
    const next = await plan(RUN_LOG_NEXT_SQL, device.id, AT + 100, 1, 10);

    for (const detail of [first, next]) {
      expect(detail).toContain("hc_ingest_log_received");
      // Read in the index's order: nothing is gathered and sorted.
      expect(detail).not.toContain("TEMP B-TREE");
    }
    const { meta } = await env.DB.prepare(RUN_LOG_NEXT_SQL)
      .bind(device.id, AT + 100, 1, 10)
      .all();
    expect(meta.rows_read).toBeLessThan(40);
  }, 60_000);
});
